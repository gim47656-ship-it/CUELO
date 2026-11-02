import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { type AgentSessionWrapper, getRunningRpcSessionIds, startNewRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { getUpdateMutationBlock } from "@/lib/update-maintenance";
import { collectUpkeep } from "@/lib/upkeep/collect";
import { type NightlyJobs, nightlyStateAfterRun, planNightlyRun, readNightlyState, skillScanSince, writeNightlyState } from "@/lib/upkeep/nightly";
import { collectSkillCandidates } from "@/lib/upkeep/skill-candidates";
import { addWorktree } from "@/lib/worktree";

export const dynamic = "force-dynamic";

const log = (message: string) => console.log(`[upkeep/nightly] ${message}`);

declare global {
  // 실제 실행(계획~상태 기록)이 진행 중인지. Next가 route 모듈을 여러 번 불러도 한 프로세스에 하나만 둔다.
  var __cueloNightlyInFlight: boolean | undefined;
}

/**
 * 야간 자율 개선 루프의 진입점(AGENTS.md 「Nightly self-improvement loop」). 사용자 타이머
 * `cuelo-nightly-improve.timer`가 매일 04:00(KST)에 부른다. `?dryRun=1`은 계획과 프롬프트만 돌려주고 아무것도 만들지 않는다.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    log("rejected: untrusted request");
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  if (dryRun) return planAndRun(true);
  if (globalThis.__cueloNightlyInFlight) {
    log("skipped: in-progress");
    return NextResponse.json({ action: "skipped", reason: "in-progress" });
  }
  globalThis.__cueloNightlyInFlight = true;
  try {
    return await planAndRun(false);
  } finally {
    globalThis.__cueloNightlyInFlight = false;
  }
}

/** 로그 한 줄에 실을 오늘 할 일 */
function describeJobs(jobs: NightlyJobs): string {
  return [
    jobs.problems.length ? `problems ${jobs.problems.join(", ")}` : null,
    jobs.skillCandidates ? `${jobs.skillCandidates} procedure candidate(s)` : null,
    jobs.weeklyReview ? "weekly performance review" : null,
  ].filter(Boolean).join("; ");
}

async function planAndRun(dryRun: boolean) {
  const agentDir = getAgentDir();
  let plan;
  let state;
  try {
    state = readNightlyState(agentDir);
    const now = new Date();
    const candidates = await collectSkillCandidates(getSessionsDir(agentDir), skillScanSince(state, now), now.getTime());
    plan = planNightlyRun(await collectUpkeep(true), state, now, getRunningRpcSessionIds(), candidates);
  } catch (error) {
    log(`failed to plan: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json({ error: "Nightly plan failed" }, { status: 500 });
  }
  if (plan.action === "skip") {
    log(`${dryRun ? "dry run " : ""}skipped: ${plan.reason}`);
    return NextResponse.json({ action: "skipped", reason: plan.reason, ...(dryRun ? { dryRun } : {}) });
  }
  if (dryRun) {
    log(`dry run: would start ${plan.branch} for ${describeJobs(plan.jobs)}`);
    return NextResponse.json({ action: "planned", dryRun, plan });
  }
  // 보고서를 모으는 사이 갱신이 시작됐을 수 있어 무엇이든 만들기 직전에 본다.
  if (getUpdateMutationBlock()) {
    log("skipped: update-draining");
    return NextResponse.json({ action: "skipped", reason: "update-draining" });
  }

  let worktree: string | undefined;
  let session: AgentSessionWrapper | undefined;
  let accepted = false;
  try {
    // addWorktree가 새 경로를 allowFileRoot로 열어 두므로 /api/files가 곧바로 읽을 수 있다. 같은 날 이름이 같아 다시
    // 부르면 「Directory already exists」로 실패하므로 한 날에 두 번 열리지 않는다.
    worktree = (await addWorktree(plan.repoCwd, plan.branch)).path;
    const started = await startNewRpcSession(undefined, worktree);
    session = started.session;
    invalidateSessionListCache();
    await session.send({ type: "prompt", message: plan.prompt });
    accepted = true;
    writeNightlyState(agentDir, nightlyStateAfterRun(plan, state, started.realSessionId, worktree, new Date().toISOString()));
    log(`started ${started.realSessionId} in ${worktree} for ${describeJobs(plan.jobs)}`);
    return NextResponse.json({ action: "started", sessionId: started.realSessionId, worktree });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 프롬프트를 받기 전에 실패한 세션은 일을 맡지 않았으므로 닫는다. 받은 뒤(기록 실패)에는 일하는 세션을 끊지 않는다.
    // worktree는 지우지 않는다(삭제는 사용자 승인). 경로를 로그와 응답에 남긴다.
    if (session && !accepted) await session.shutdown().catch(() => {});
    log(`failed ${accepted ? "to record an accepted run" : "to start"}${worktree ? ` in ${worktree}` : ""}: ${message}`);
    return NextResponse.json({ error: message, ...(worktree ? { worktree } : {}), ...(accepted ? { accepted } : {}) }, { status: 500 });
  }
}
