import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { type AgentSessionWrapper, getRunningRpcSessionIds, reserveWorktreeRemoval, startNewRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { getUpdateMutationBlock } from "@/lib/update-maintenance";
import { collectUpkeep } from "@/lib/upkeep/collect";
import { type NightlyJobs, type NightlySourcePlan, nightlyBranch, nightlyStateAfterRun, planNightlyRun, readNightlyState, skillScanSince, writeNightlyState } from "@/lib/upkeep/nightly";
import { createNightlyBranch, planInboxRun, pruneMergedNightlyBranches, pruneNightlyWorktrees, readCloudHandoffs, readNightlyInbox } from "@/lib/upkeep/nightly-inbox";
import { collectNightlyCoreUpdate, type CoreUpdateLookup } from "@/lib/upkeep/nightly-core";
import { collectOpenIssues } from "@/lib/upkeep/nightly-issues";
import { collectSkillCandidates } from "@/lib/upkeep/skill-candidates";
import { kstDate } from "@/lib/upkeep/prompt";
import { addWorktree } from "@/lib/worktree";

export const dynamic = "force-dynamic";

const log = (message: string) => console.log(`[upkeep/nightly] ${message}`);

declare global {
  // 실제 실행(계획~상태 기록)이 진행 중인지. Next가 route 모듈을 여러 번 불러도 한 프로세스에 하나만 둔다.
  var __cueloNightlyInFlight: boolean | undefined;
}

/**
 * 야간 자율 개선 루프의 진입점(AGENTS.md 「Nightly self-improvement loop」). 클라우드의 시스템 타이머
 * `cuelo-nightly-improve.timer`(Tools/CUELO_Setup/cloud)가 매일 04:00(KST)에 부른다. `CUELO_NIGHTLY_INBOX_DIR`가 있으면
 * 받은편지함의 출처별 묶음, 저장소 origin/main HANDOFF의 「클라우드 점검」 항목, 공개 저장소 열린 이슈로 매일 계획하고(기존 기능
 * 점검을 매일 맡긴다), 없으면 이 기계의 기록으로 계획한다. `?dryRun=1`은 계획과 프롬프트만 돌려주고 브랜치·worktree·세션은
 * 만들지 않는다(받은편지함 모드의 `git fetch origin`과 이슈 읽기는 한다).
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
    jobs.handoff?.length ? `handoff ${jobs.handoff.join(", ")}` : null,
    jobs.skillHealth?.length ? `skill health ${jobs.skillHealth.join(", ")}` : null,
    jobs.issueLookup ? `issues ${jobs.issueLookup}${jobs.issues?.length ? ` #${jobs.issues.join(", #")}` : ""}` : null,
    jobs.improvementReview ? "existing-feature review" : null,
    jobs.coreUpgrade ? `OMP core ${jobs.coreUpgrade.from} -> ${jobs.coreUpgrade.to}` : null,
  ].filter(Boolean).join("; ");
}

function describeSources(sources: readonly NightlySourcePlan[]): string {
  return sources.map((s) => `${s.source}: ${describeJobs(s.jobs) || "nothing"}`).join(" | ");
}

async function planAndRun(dryRun: boolean) {
  const agentDir = getAgentDir();
  let plan;
  let state;
  let coreUpdate: CoreUpdateLookup | undefined;
  try {
    state = readNightlyState(agentDir);
    const now = new Date();
    const repoOverride = process.env.CUELO_NIGHTLY_REPO || null;
    const inboxDir = process.env.CUELO_NIGHTLY_INBOX_DIR;
    if (inboxDir) {
      // 받은편지함 모드(클라우드): 이 기계 자신의 세션 기록과 보수 보고서는 쓰지 않는다.
      const inbox = readNightlyInbox(inboxDir, now);
      for (const { file, reason } of inbox.skipped) log(`inbox skipped ${file}: ${reason}`);
      // 저장소 HANDOFF의 「클라우드 점검」 항목은 세션이 고칠 origin/main에서 읽는다. 받아 오지 못하면 HEAD로 돌아간다.
      const handoffs = repoOverride ? await readCloudHandoffs(repoOverride, now) : null;
      for (const warning of handoffs?.warnings ?? []) log(`handoff: ${warning}`);
      if (handoffs) log(`handoff base: ${handoffs.base ? `${handoffs.base.ref} ${handoffs.base.sha}` : "working tree (no commit found)"}`);
      // 지난 야간 브랜치 정리(2026-11-04 사용자 결정): origin/main에 들어간 원격 wt/nightly-* 가운데 보존 기간이 지난 것을 지운다.
      // 아직 도는 세션의 브랜치는 남긴다. 할 일이 없는 날에도 정리한다.
      if (!dryRun && repoOverride && handoffs?.base?.ref === "origin/main") {
        const keep = new Set<string>();
        if (state && getRunningRpcSessionIds().includes(state.sessionId)) keep.add(nightlyBranch(state.date));
        const pruned = await pruneMergedNightlyBranches(repoOverride, handoffs.base.sha, keep, now);
        for (const warning of pruned.warnings) log(`branch prune: ${warning}`);
        if (pruned.deleted.length) log(`deleted merged ${pruned.deleted.join(", ")}`);
        // 지난 야간 로컬 worktree 정리(2026-11-07 사용자 결정): 디스크가 작아 하룻밤 사본(약 0.7 GiB)도 남기지 않는다.
        // 그 경로를 쓰는 세션이 있으면 수동 삭제와 같은 예약이 막는다(공개 이슈 #69).
        const cleaned = await pruneNightlyWorktrees(repoOverride, handoffs.base.sha, keep, now, reserveWorktreeRemoval);
        for (const warning of cleaned.warnings) log(`worktree prune: ${warning}`);
        if (cleaned.removed.length) log(`removed worktrees ${cleaned.removed.join(", ")}`);
      }
      // 공개 저장소 열린 이슈(읽기 전용, 인증 없음). 읽지 못하면 unavailable로 프롬프트에 그대로 싣는다.
      const issues = await collectOpenIssues();
      log(`issues: ${issues.status === "ok" ? `${issues.issues.length} open${issues.partial ? " (partial)" : ""}` : `unavailable (${issues.reason})`}`);
      coreUpdate = await collectNightlyCoreUpdate(repoOverride, handoffs?.base ? [handoffs.base.sha] : [`refs/heads/${nightlyBranch(kstDate(now.toISOString()))}`, "HEAD"]);
      plan = planInboxRun(inbox.bundles, state, now, getRunningRpcSessionIds(), repoOverride, process.env.CUELO_NIGHTLY_OUTBOX_DIR || null, issues, handoffs, coreUpdate);
    } else {
      const candidates = await collectSkillCandidates(getSessionsDir(agentDir), skillScanSince(state, now), now.getTime());
      const report = await collectUpkeep(true);
      const repoCwd = repoOverride ?? report.repoCwd;
      coreUpdate = await collectNightlyCoreUpdate(repoCwd, [`refs/heads/${nightlyBranch(kstDate(now.toISOString()))}`, "HEAD"]);
      plan = planNightlyRun({ ...report, repoCwd }, state, now, getRunningRpcSessionIds(), candidates, coreUpdate);
    }
    log(`core discovery: ${JSON.stringify(coreUpdate)}`);
  } catch (error) {
    log(`failed to plan: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json({ error: "Nightly plan failed" }, { status: 500 });
  }
  if (plan.action === "skip") {
    log(`${dryRun ? "dry run " : ""}skipped: ${plan.reason}`);
    return NextResponse.json({ action: "skipped", reason: plan.reason, coreUpdate, ...(dryRun ? { dryRun } : {}) });
  }
  if (dryRun) {
    log(`dry run: would start ${plan.branch} for ${describeJobs(plan.jobs)}${plan.sources ? ` | ${describeSources(plan.sources)}` : ""}`);
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
  let sessionId: string | undefined;
  try {
    // addWorktree가 새 경로를 allowFileRoot로 열어 두므로 /api/files가 곧바로 읽을 수 있다. 같은 날 이름이 같아 다시
    // 부르면 「Directory already exists」로 실패하므로 한 날에 두 번 열리지 않는다.
    // 받은편지함 모드는 HANDOFF를 읽은 커밋(보통 origin/main)에 브랜치를 둔다. 아무도 당겨 오지 않는 저장소 HEAD는 낡을 수 있다.
    if (plan.base) log(`${await createNightlyBranch(plan.repoCwd, plan.branch, plan.base.sha)} ${plan.branch} at ${plan.base.ref} ${plan.base.sha}`);
    worktree = (await addWorktree(plan.repoCwd, plan.branch)).path;
    const started = await startNewRpcSession(undefined, worktree);
    session = started.session;
    sessionId = started.realSessionId;
    invalidateSessionListCache();
    await session.send({ type: "prompt", message: plan.prompt });
    accepted = true;
    writeNightlyState(agentDir, nightlyStateAfterRun(plan, state, started.realSessionId, worktree, new Date().toISOString()));
    log(`started ${started.realSessionId} in ${worktree} for ${describeJobs(plan.jobs)}${plan.sources ? ` | ${describeSources(plan.sources)}` : ""}`);
    return NextResponse.json({ action: "started", sessionId: started.realSessionId, worktree });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 프롬프트를 받기 전에 실패한 세션은 일을 맡지 않았으므로 닫는다. 받은 뒤(기록 실패)에는 일하는 세션을 끊지 않는다.
    // worktree는 지우지 않는다(삭제는 사용자 승인). 경로를 로그와 응답에 남긴다.
    if (session && !accepted) await session.shutdown().catch(() => {});
    log(`failed ${accepted ? "to record an accepted run" : "to start"}${worktree ? ` in ${worktree}` : ""}: ${message}`);
    // 받은 세션은 계속 돌므로 id를 함께 돌려준다. 클라우드 실행 스크립트가 그 세션을 위해 활동 lease를 잡는다.
    return NextResponse.json({ error: message, ...(worktree ? { worktree } : {}), ...(accepted ? { accepted, sessionId } : {}) }, { status: 500 });
  }
}
