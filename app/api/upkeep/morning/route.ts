import { getAgentDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { getCueloUpdateStatus } from "@/lib/omp-updates";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { allowFileRoot } from "@/lib/file-access";
import { type AgentSessionWrapper, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { maintainRecordedSessionWorktrees, startSessionWithWorktree } from "@/lib/session-worktree/runtime";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { getUpdateMutationBlock } from "@/lib/update-maintenance";
import { inspectDeploy } from "@/lib/upkeep/deploy";
import { collectCloudChanges, findMorningRepo, importNightlyOutcomes, type MorningPlan, morningStateAfterRun, parseSkillNames, planMorningRun, type ReleaseInfo, readMorningState, writeMorningState } from "@/lib/upkeep/morning";
import { type NightlyResult, parseNightlyResult } from "@/lib/upkeep/nightly-result";
import { refreshUpkeepAfterMarkChange } from "@/lib/upkeep/collect";

export const dynamic = "force-dynamic";

const log = (message: string) => console.log(`[upkeep/morning] ${message}`);

declare global {
  // 실제 실행(계획~상태 기록)이 진행 중인지. 2시간마다 부르지만 수동 호출과 겹쳐도 세션은 하나만 연다.
  var __cueloMorningInFlight: boolean | undefined;
  // 이 서버가 마지막으로 프롬프트를 넘긴 보고 세션. 상태 파일 기록이 실패해도 그 세션이 도는 동안 다시 열지 않는다.
  var __cueloMorningSessionId: string | undefined;
}

/**
 * 클라우드 변경 보고 세션의 진입점(lib/upkeep/morning.ts). 각 PC의 `cuelo-cloud-sync.sh`가 동기화 뒤 본문
 * `{ "skills": ["받아 온 스킬", …] }`로 부른다. `?dryRun=1`은 계획과 프롬프트만 돌려주고 세션도 상태도 만들지 않는다.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    log("rejected: untrusted request");
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  let skills: string[] = [];
  let nightlyResult: NightlyResult | null = null;
  let nightlyInvalid = false;
  if (hasJsonContentType(req)) {
    try {
      const body = (await req.json()) as { skills?: unknown; nightlyResult?: unknown } | null;
      skills = parseSkillNames(body?.skills);
      nightlyResult = parseNightlyResult(body?.nightlyResult);
      nightlyInvalid = nightlyResult === null && body?.nightlyResult !== undefined && body.nightlyResult !== null;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  if (dryRun) return planAndRun(true, skills, nightlyResult, nightlyInvalid);
  if (globalThis.__cueloMorningInFlight) {
    log("skipped: in-progress");
    return NextResponse.json({ action: "skipped", reason: "in-progress" });
  }
  globalThis.__cueloMorningInFlight = true;
  try {
    return await planAndRun(false, skills, nightlyResult, nightlyInvalid);
  } finally {
    await maintainRecordedSessionWorktrees("morning");
    globalThis.__cueloMorningInFlight = false;
  }
}

async function readRelease(warnings: string[]): Promise<ReleaseInfo | null> {
  try {
    // 동기화는 2시간마다 부르고 캐시는 1시간이라, 캐시를 거치면 늘 지난 주기의 릴리스를 보고 새 릴리스 설치를 한 주기씩 미룬다.
    const status = await getCueloUpdateStatus({ fresh: true });
    return { current: status.currentAppVersion, latest: status.latestRelease?.version ?? null, available: status.updateAvailable };
  } catch (error) {
    warnings.push(`공개 릴리스를 확인하지 못했습니다(${error instanceof Error ? error.message : String(error)}).`);
    return null;
  }
}

function describe(plan: Extract<MorningPlan, { action: "run" }>): string {
  const { cloudCommits, skills, release, nightly } = plan.triggers;
  return `${cloudCommits} cloud commit(s), ${skills} skill(s), release ${release ?? "none"}, nightly ${nightly ?? "none"}`;
}

async function planAndRun(dryRun: boolean, skills: string[], nightlyResult: NightlyResult | null, nightlyInvalid: boolean) {
  const agentDir = getAgentDir();
  let plan: MorningPlan;
  let state;
  try {
    state = readMorningState(agentDir);
    const now = new Date();
    const repoCwd = findMorningRepo();
    const warnings: string[] = [];
    // 지난 보고 기준이 없거나 이 저장소에 없으면 이 PC에 마지막으로 배포한 리비전을 기준으로 삼는다. 이미 설치한 변경을 다시 알리지 않게.
    const deployed = repoCwd ? (await inspectDeploy(agentDir, repoCwd)).deployed : null;
    const changes = repoCwd ? await collectCloudChanges(repoCwd, { reported: state?.reportedSha ?? null, deployed }, now) : null;
    if (changes) warnings.push(...changes.warnings);
    const release = await readRelease(warnings);
    try {
      const imported = importNightlyOutcomes({ agentDir, state, result: nightlyResult, now, dryRun, release });
      state = imported.state;
      if (imported.changed) await refreshUpkeepAfterMarkChange();
    } catch (error) {
      warnings.push(`야간 점검 표시를 반영하지 못했습니다(${error instanceof Error ? error.message : String(error)}). 다음 동기화에서 다시 시도합니다.`);
    }
    // 모양이 맞지 않는 결과는 빼고 나머지 보고는 그대로 한다.
    if (nightlyInvalid) warnings.push("클라우드 야간 실행 결과 파일을 해석하지 못해 이번 보고에서 뺐습니다.");
    plan = planMorningRun({
      repoCwd,
      originHead: changes?.originHead ?? null,
      base: changes?.base ?? null,
      cloudCommits: changes?.commits ?? [],
      skills,
      nightlyResult,
      release,
      state,
      runningSessionIds: getRunningRpcSessionIds(),
      acceptedSessionId: globalThis.__cueloMorningSessionId ?? null,
      now,
      warnings,
    });
  } catch (error) {
    log(`failed to plan: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json({ error: "Morning plan failed" }, { status: 500 });
  }
  if (plan.action === "skip") {
    log(`${dryRun ? "dry run " : ""}skipped: ${plan.reason}`);
    return NextResponse.json({ action: "skipped", reason: plan.reason, ...(dryRun ? { dryRun } : {}) });
  }
  if (dryRun) {
    log(`dry run: would start a report session in ${plan.repoCwd} for ${describe(plan)}`);
    return NextResponse.json({ action: "planned", dryRun, plan });
  }
  // 변경을 모으는 사이 갱신이 시작됐을 수 있어 세션을 만들기 직전에 본다.
  if (getUpdateMutationBlock()) {
    log("skipped: update-draining");
    return NextResponse.json({ action: "skipped", reason: "update-draining" });
  }

  let session: AgentSessionWrapper | undefined;
  let accepted = false;
  let sessionId: string | undefined;
  try {
    // 다른 새 세션과 같은 규칙: 메인 체크아웃을 다른 세션이 쓰고 있으면 자동 워크트리에서 연다.
    const started = await startSessionWithWorktree(undefined, plan.repoCwd, {}, {});
    allowFileRoot(started.cwd);
    session = started.session;
    sessionId = started.realSessionId;
    await session.send({ type: "set_session_name", name: plan.sessionName });
    invalidateSessionListCache();
    await session.send({ type: "prompt", message: plan.prompt });
    accepted = true;
    globalThis.__cueloMorningSessionId = sessionId;
    writeMorningState(agentDir, morningStateAfterRun(plan, state, sessionId, new Date().toISOString()));
    log(`started ${sessionId} in ${started.cwd} for ${describe(plan)}`);
    return NextResponse.json({ action: "started", sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 프롬프트를 받기 전에 실패한 세션은 일을 맡지 않았으므로 닫는다. 받은 뒤(기록 실패)에는 일하는 세션을 끊지 않는다.
    if (session && !accepted) await session.shutdown().catch(() => {});
    log(`failed ${accepted ? "to record an accepted run" : "to start"}: ${message}`);
    return NextResponse.json({ error: message, ...(accepted ? { accepted, sessionId } : {}) }, { status: 500 });
  }
}
