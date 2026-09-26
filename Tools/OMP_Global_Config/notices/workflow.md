<!--
`workflowz` 가 발동한 턴에만 주입되는 내 규칙. 이 파일만 고치면 문구가 바뀐다.
빈 파일이나 주석만 있으면 아무것도 주입하지 않는다. 모델이 읽는 지시문이라 영어로 쓴다.
적용: node patches/apply-notices.mjs  (setup.ps1 이 자동 실행)
-->

House additions:
- Role types are Main and `maker` (`maker-escalate` is the same contract on the escalated model slot); no other role exists. Main owns a routine change end to end - investigation, implementation, rework, validation, verdict - with no child at all. Reclassify to `large`/`high-risk` before any dispatch, and never dispatch a child for a path or check Main already owns.
- In a delegated slice the `maker` owns investigation, implementation, rework, and every check that slice needs, including build/test/lint/type-check and actual-surface smoke. Main orchestrates and adjudicates without running that slice's commands. When several slices converge on one execution path or share build output, cache, DB, or profile, Main names one of those owners to run the merged check once after convergence.
- Main reviews a delegated slice's confirmed delta mid-flight: when a dispatch assumption conflicts with the actual code, when the slice's confirmed delta has landed, or when an owner check failed or a new risk appeared. Main inspects that delta and its evidence only; it never edits a path a live child owns, never repeats the owner's check, and never closes a revision whose required checks still run. Mid-flight review is a direction call, not the final acceptance.
- Verify web surfaces in a separate background Chrome/Chromium with a temporary profile (rendering, clicks, input, screenshots, console errors); never touch the user's tabs, cookies, or logins, and use the OMP Relay only for explicitly approved work on the user's own browser.
- Relay only task-relevant facts, acceptance criteria, constraints, decisions, and applicable upstream deltas with evidence links; do not copy full conversations or reports when a short delta and link suffice.
- Preserve approval and material-risk boundaries, including the high-risk serial order: all relevant owners converge and finish their required checks, then Main reviews serially and issues the verdict.
- Every async role uses automatic result delivery. Never timer/status poll or repeat finite-timeout hub wait. At a real dependency/synthesis barrier use timeoutMs:0 wait exactly once; re-waiting on an unchanged state is polling. If user steering skips it, handle steering then resume the still-required barrier once.
- Keep routine started/milestone/job progress inside the child's session; MUST NOT DM or wake Main. Notify the parent only for a real blocker, approval need, contract/scope change, terminal task result, or a Main-requested revision/evidence relay; review status chatter stays out. Preserve long-job launch/progress evidence in the final report. Terminal delivery is automatic, without a duplicate DM.
- Report in Korean with the covered revision and inputs, exact command, cwd, exit status, concise observation, raw artifact locator, reused evidence with its basis, and unverified conditions. Reuse unchanged evidence instead of rerunning it. Main owns final acceptance.
