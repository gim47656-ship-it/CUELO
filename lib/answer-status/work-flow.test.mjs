import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { deriveWorkFlow, readCheckRun, readCiSuccessHeads } = await jiti.import("./work-flow.ts");

const call = (toolCallId, toolName, input) => ({ type: "toolCall", toolCallId, toolName, input });
const result = (toolCallId, toolName, details, isError = false, text = "ok") => ({
  role: "toolResult", toolCallId, toolName, isError, details, content: [{ type: "text", text }],
});
const bash = (toolCallId, command) => call(toolCallId, "bash", { command });
const exited = (toolCallId, exitCode) => result(toolCallId, "bash", { exitCode }, exitCode !== 0, `Command exited with code ${exitCode}`);
const DEPLOY = "systemd-run --user --unit=cuelo-update-$(date +%s) --collect --setenv=WSL_DISTRO_NAME=\"$WSL_DISTRO_NAME\" bash ~/cuelo-run/Tools/CUELO_Setup/wsl/update.sh abc1234";

/** 블록과 결과 목록으로 흐름을 만든다. 결과 자리의 null은 결과가 아직 없다는 뜻이다. */
function flowOf(entries, live = false) {
  const blocks = entries.map(([block]) => block);
  const results = new Map(entries.filter(([, value]) => value).map(([block, value]) => [block.toolCallId, value]));
  return deriveWorkFlow(blocks, results, live);
}

const stageStatuses = (flow) => Object.fromEntries(flow.stages.map((view) => [view.stage, view.status]));

/** 진행 중인 턴의 흐름. `next`는 진행 중인 턴에만 있으므로, 같은 기록이 끝난 턴이면 다음 차례가 없다는 것도 함께 확인한다. */
function liveFlowOf(entries) {
  assert.equal(flowOf(entries).next, null, "a finished turn has no next stage");
  return flowOf(entries, true);
}

test("a check passes only when its own exit status reaches the shell's exit status", () => {
  const cases = [
    ["bun run typecheck", 0, "passed"],
    ["cd /repo && bun run lint && bun run test", 0, "passed"],
    ["bun test -t \"a | b; c || d\"", 0, "passed"],
    ["bash -lc 'cd /repo && bun test'", 0, "passed"],
    ["set -o pipefail; bun run typecheck 2>&1 | tail -5", 0, "passed"],
    ["bun test; exit $?", 0, "passed"],
    ["bun run typecheck 2>&1 | tail -5", 0, "unverified"],
    ["bun test; echo done", 0, "unverified"],
    ["bun run lint || true", 0, "unverified"],
    ["! bun test", 0, "unverified"],
    ["bun run build > /tmp/build.log 2>&1 &", 0, "unverified"],
    ["bash -lc 'bun test | tail -3'", 0, "unverified"],
    ["if bun test; then echo ok; fi", 0, "unverified"],
    ["bun run typecheck | tail -5", 1, "failed"],
    ["bun run typecheck", 2, "failed"],
  ];
  for (const [command, exitCode, state] of cases) {
    const check = readCheckRun(bash("c", command), exited("c", exitCode));
    assert.equal(check?.state, state, command);
    assert.equal(check.exitCode, exitCode, command);
  }
});

test("a check without a recorded exit code is unobserved, or failed when the call errored", () => {
  assert.equal(readCheckRun(bash("c", "bun run build"), result("c", "bash", { async: true }, false, "Backgrounded as job bg_3")).state, "unobserved");
  assert.equal(readCheckRun(bash("c", "bun run build"), undefined).state, "unobserved");
  assert.equal(readCheckRun(bash("c", "bun run lint"), result("c", "bash", undefined, true, "spawn failed")).state, "failed");
});

test("check labels come from the command words, not from paths", () => {
  const labels = (command) => readCheckRun(bash("c", command), exited("c", 0)).labels;
  assert.deepEqual(labels("bun run typecheck && bunx eslint components && bun test lib/check-state.test.mjs"), ["typecheck", "lint", "test"]);
  assert.deepEqual(labels("npm run build:prod"), ["build"]);
  assert.deepEqual(labels("node --test lib/a.test.mjs"), ["test"]);
  assert.deepEqual(labels("bash -c 'npx tsc --noEmit'"), ["typecheck"]);
  // `test -s` is the shell's condition command, not a test run.
  assert.deepEqual(labels("test -s out.log && bun run lint"), ["lint"]);
  assert.equal(readCheckRun(bash("c", "test -s out.log"), exited("c", 0)), null);
});

test("CI and deploy commands are their own stages and never count as checks", () => {
  const watch = "gh run watch 39264328918 -R owner/repo --exit-status >/dev/null 2>&1; ec=$?; gh run view 39264328918 -R owner/repo --json status,conclusion -q '.status+\" \"+.conclusion'; exit $ec";
  for (const command of [watch, "gh run list --workflow \"Verify build\" --limit 3", DEPLOY]) {
    assert.equal(readCheckRun(bash("c", command), exited("c", 0)), null, command);
  }
  const flow = flowOf([
    [bash("ci", watch), exited("ci", 0)],
    [bash("list", "gh run list --workflow ci --limit 1"), exited("list", 0)],
    [bash("deploy", DEPLOY), exited("deploy", 0)],
    [bash("read", "grep -n READY ~/cuelo-run/Tools/CUELO_Setup/wsl/update.sh"), exited("read", 0)],
  ]);
  assert.deepEqual(flow.steps.map((step) => [step.toolCallId, step.stage, step.outcome]), [
    ["ci", "ci", "unverified"], // Named exit captures are outside the conservative proof subset.
    ["list", "ci", "unverified"],
    // systemd-run hands the deploy to a unit and returns at once: its exit code says nothing about the deploy.
    ["deploy", "deploy", "unverified"],
  ]);
  const waited = flowOf([[bash("deploy", "systemd-run --user --wait bash ~/cuelo-run/Tools/CUELO_Setup/wsl/update.sh abc"), exited("deploy", 0)]]);
  assert.equal(waited.steps[0].outcome, "passed");
  const dynamic = flowOf([[bash("deploy", DEPLOY.replace("--collect", "--collect --wait")), exited("deploy", 0)]]);
  assert.equal(dynamic.steps[0].outcome, "unverified", "substitution stays outside the proof subset, even with --wait");
});

test("a full turn walks every stage once and leaves no next stage", () => {
  const flow = flowOf([
    [call("r", "read", { path: "a.ts" }), result("r", "read")],
    [call("w", "edit", { path: "a.ts" }), result("w", "edit")],
    [bash("t", "bun run typecheck"), exited("t", 0)],
    [call("cr", "cross_review", { action: "resolve" }), result("cr", "cross_review", { pass: true, open: [] })],
    [call("g", "git_finalize", { files: ["a.ts"] }), result("g", "git_finalize", { ok: true, commitSha: "0123456789abcdef" })],
    [bash("ci", "gh run watch 1 --exit-status"), exited("ci", 0)],
    [bash("d", DEPLOY), exited("d", 0)],
  ]);
  assert.deepEqual(stageStatuses(flow), {
    investigate: "done", edit: "done", check: "passed", review: "passed", commit: "done", ci: "passed", deploy: "unverified",
  });
  assert.equal(flow.steps.find((step) => step.stage === "commit").commit, "0123456789abcdef");
  assert.equal(flow.attempt, 1);
  assert.deepEqual(flow.loops, []);
  assert.equal(flow.current, "deploy");
  assert.equal(flow.reached, "deploy");
  assert.equal(flow.next, null);
});

test("editing again after an unresolved failure starts the next attempt and records where it came back from", () => {
  const entries = [
    [call("r", "grep", { pattern: "x" }), result("r", "grep")],
    [call("w1", "write", { path: "a.ts" }), result("w1", "write")],
    [bash("t1", "bun test"), exited("t1", 1)],
    [call("r2", "read", { path: "a.ts" }), result("r2", "read")],
    [call("w2", "edit", { path: "a.ts" }), result("w2", "edit")],
    [call("w3", "edit", { path: "b.ts" }), result("w3", "edit")],
    [bash("t2", "bun test"), exited("t2", 0)],
    [call("cr", "cross_review", { action: "review" }), result("cr", "cross_review", { findings: [{ id: "F1" }, { id: "F2" }] })],
    [call("w4", "edit", { path: "c.ts" }), result("w4", "edit")],
  ];
  const flow = flowOf(entries, true);
  assert.equal(flow.attempt, 3);
  assert.deepEqual(flow.loops, [{ from: "check", attempt: 1 }, { from: "review", attempt: 2 }]);
  const check = flow.stages.find((view) => view.stage === "check");
  assert.deepEqual(check.steps.map((step) => step.toolCallId), []);
  assert.deepEqual(check.earlier.map((step) => [step.toolCallId, step.attempt, step.outcome]), [["t1", 1, "failed"], ["t2", 2, "passed"]]);
  const review = flow.stages.find((view) => view.stage === "review");
  assert.deepEqual(review.earlier.map((step) => [step.findings, step.outcome]), [[2, "failed"]]);
  // 조사는 회차를 나누지 않는다.
  assert.deepEqual(flow.stages[0].steps.map((step) => step.toolCallId), ["r", "r2"]);
  assert.deepEqual(stageStatuses(flow), {
    investigate: "done", edit: "done", check: "waiting", review: "waiting", commit: "waiting", ci: "waiting", deploy: "waiting",
  });
  assert.deepEqual(flow.next, { stage: "check", returning: false });
  // The same record once the turn ended: the same attempts and loops, nothing waiting and nothing next.
  const finished = flowOf(entries);
  assert.equal(finished.attempt, 3);
  assert.deepEqual(finished.loops, flow.loops);
  assert.deepEqual(stageStatuses(finished), {
    investigate: "done", edit: "done", check: "skipped", review: "skipped", commit: "skipped", ci: "notNeeded", deploy: "notNeeded",
  });
  assert.equal(finished.next, null);
});

test("the next stage points back to edit while a failure stands, and moves on once it is resolved", () => {
  const failedCheck = liveFlowOf([
    [call("w", "edit", { path: "a.ts" }), result("w", "edit")],
    [bash("t", "bun run lint"), exited("t", 1)],
  ]);
  assert.deepEqual(failedCheck.next, { stage: "edit", returning: true });
  assert.deepEqual(failedCheck.loops, []);
  assert.equal(failedCheck.reached, "edit");

  const rerunPassed = liveFlowOf([
    [call("w", "edit", { path: "a.ts" }), result("w", "edit")],
    [bash("t1", "bun run lint"), exited("t1", 1)],
    [bash("t2", "bun run lint"), exited("t2", 0)],
    [call("w2", "edit", { path: "b.ts" }), result("w2", "edit")],
  ]);
  assert.equal(rerunPassed.attempt, 1, "a failure fixed by a rerun is not a loop");
  // The passing rerun came before the later edit, so it no longer covers the code: check again next.
  assert.equal(rerunPassed.stages.find((view) => view.stage === "check").status, "stale");
  assert.deepEqual(rerunPassed.next, { stage: "check", returning: false });

  const unresolved = liveFlowOf([
    [call("w", "edit", { path: "a.ts" }), result("w", "edit")],
    [bash("t", "bun test"), exited("t", 0)],
    [call("cr", "cross_review", { action: "resolve" }), result("cr", "cross_review", { pass: false, open: [{ id: "F1" }] })],
  ]);
  assert.deepEqual(unresolved.next, { stage: "edit", returning: true });
  assert.equal(unresolved.stages.find((view) => view.stage === "review").steps[0].findings, 1);

  const failedCommit = liveFlowOf([
    [call("w", "edit", { path: "a.ts" }), result("w", "edit")],
    [bash("t", "bun test"), exited("t", 0)],
    [call("cr", "cross_review", { action: "resolve" }), result("cr", "cross_review", { pass: true, open: [] })],
    [call("g", "git_finalize", { files: [] }), result("g", "git_finalize", undefined, true, "git_finalize failed at fetch")],
  ]);
  assert.deepEqual(failedCommit.next, { stage: "commit", returning: false });
  const onlyFailedCommit = liveFlowOf([[call("g", "git_finalize", { files: [] }), result("g", "git_finalize", undefined, true)]]);
  assert.deepEqual(onlyFailedCommit.next, { stage: "commit", returning: false });

  const onlyInvestigated = liveFlowOf([[call("r", "read", { path: "a.ts" }), result("r", "read")]]);
  assert.deepEqual(onlyInvestigated.next, { stage: "edit", returning: false });

  for (const live of [true, false]) {
    const empty = flowOf([[call("todo", "todo", {}), result("todo", "todo")]], live);
    assert.equal(empty.next, null);
    assert.equal(empty.current, null);
    assert.ok(empty.stages.every((view) => view.status === "waiting"));
  }
});

test("calls without a result are running in a live turn and unobserved in a finished one", () => {
  const entries = [
    [call("w", "edit", { path: "a.ts" }), result("w", "edit")],
    [bash("t", "bun test"), null],
  ];
  const live = flowOf(entries, true);
  assert.equal(live.current, "check");
  assert.equal(live.stages.find((view) => view.stage === "check").status, "running");
  assert.equal(flowOf(entries).stages.find((view) => view.stage === "check").status, "unobserved");
});

test("only calls that change files count as edits", () => {
  const flow = flowOf([
    [call("msg", "write", { path: "agent://Main", content: "hi" }), result("msg", "write")],
    [call("bad", "edit", { path: "a.ts" }), result("bad", "edit", undefined, true)],
    [call("rename", "lsp", { action: "rename", file: "a.ts" }), result("rename", "lsp")],
    [call("look", "lsp", { action: "references", file: "a.ts" }), result("look", "lsp")],
  ]);
  assert.deepEqual(flow.steps.map((step) => [step.toolCallId, step.stage]), [["rename", "edit"], ["look", "investigate"]]);
});

test("R1-OAI-1: disabled or scoped pipefail cannot prove a pipeline passed", () => {
  for (const command of [
    "set +o pipefail; bun test | cat",
    "set -o pipefail; set +o pipefail; bun test | cat",
    "set -o pipefail; true && set +o pipefail; bun test | cat",
    "set -o pipefail; set +o pipefail && bun test | cat",
    "set -o pipefail; set +o pipefail >/dev/null; bun test | cat",
    "(set -o pipefail); bun test | cat",
    "{ set -o pipefail; }; bun test | cat",
  ]) assert.equal(readCheckRun(bash("c", command), exited("c", 0)).state, "unverified", command);
  for (const setting of ["set -o pipefail", "set -euo pipefail"]) {
    const command = `${setting}; bun test | cat`;
    assert.equal(readCheckRun(bash("c", command), exited("c", 0)).state, "passed", command);
  }
});

test("R1-OAI-2: named exit captures are not evidence that the check status survived", () => {
  for (const command of [
    "bun test; ec=$?; ec=0; exit $ec",
    "bun test; ec=$?; echo done; exit $ec",
    "bun test; ec=$?; exit 0; exit $ec",
  ]) assert.equal(readCheckRun(bash("c", command), exited("c", 0)).state, "unverified", command);
});

test("R1-OAI-3: substitutions inside another program cannot prove checks passed", () => {
  for (const command of [
    "printf '%s' \"$(bun test)\"",
    "echo `bun test`",
    "echo \"$(bun test)\" && echo done",
  ]) assert.notEqual(readCheckRun(bash("c", command), exited("c", 0))?.state, "passed", command);
});

test("R1-OAI-4: group negation is never flattened into a passing check", () => {
  for (const command of [
    "! (echo before; bun test)",
    "! { echo before; bun test; }",
    "( ! bun test )",
    "! bash -c 'echo before; bun test'",
  ]) assert.equal(readCheckRun(bash("c", command), exited("c", 0)).state, "unverified", command);
});

test("R1-OAI-5: CI and deploy classification requires an executed program", () => {
  const flow = flowOf([
    [bash("quoted-ci", "printf '%s' 'gh run watch 1 --exit-status'"), exited("quoted-ci", 0)],
    [bash("quoted-shell", "printf '%s' bash -c '~/cuelo-run/Tools/CUELO_Setup/wsl/update.sh abc'"), exited("quoted-shell", 0)],
    [bash("check-name", "bun test -t 'gh run watch'"), exited("check-name", 0)],
    [bash("real-ci", "bash -c 'gh run watch 1 --exit-status'"), exited("real-ci", 0)],
    [bash("real-deploy", "bash ~/cuelo-run/Tools/CUELO_Setup/wsl/update.sh abc"), exited("real-deploy", 0)],
  ]);
  assert.deepEqual(flow.steps.map(({ toolCallId, stage }) => [toolCallId, stage]), [
    ["check-name", "check"], ["real-ci", "ci"], ["real-deploy", "deploy"],
  ]);
});

test("R1-OAI-6: only a completed successful edit starts another attempt", () => {
  for (const live of [true, false]) {
    const entries = [
      [bash("failed", "bun test"), exited("failed", 1)],
      [call("pending", "edit", { path: "a.ts" }), null],
    ];
    const pending = flowOf(entries, live);
    assert.equal(pending.attempt, 1);
    assert.deepEqual(pending.loops, []);
    assert.deepEqual(pending.next, live ? { stage: "edit", returning: true } : null);
    const completed = flowOf([...entries, [call("done", "edit", { path: "a.ts" }), result("done", "edit")]], live);
    assert.equal(completed.attempt, 2);
    assert.deepEqual(completed.loops, [{ from: "check", attempt: 1 }]);
  }
});

test("R1-OAI-7: a rerun without a verdict does not erase a recorded failure", () => {
  for (const live of [true, false]) {
    const entries = [
      [bash("failed", "bun test"), exited("failed", 1)],
      [bash("pending", "bun test"), null],
    ];
    assert.deepEqual(flowOf(entries, live).next, live ? { stage: "edit", returning: true } : null);
    assert.equal(flowOf(entries, live).stages.find(({ stage }) => stage === "check").status, "failed");
    const edited = flowOf([...entries, [call("w", "edit", { path: "a.ts" }), result("w", "edit")]], live);
    assert.equal(edited.attempt, 2);
    const passed = flowOf([...entries, [bash("passed", "bun test"), exited("passed", 0)]], live);
    assert.deepEqual(passed.next, live ? { stage: "review", returning: false } : null);
  }
});

test("R1-OAI-8: malformed tool inputs are omitted without losing valid history", () => {
  const blocks = [null, { type: "toolCall" }];
  for (const name of ["cross_review", "lsp", "edit", "bash"]) {
    for (const input of [null, undefined, [], "bad"]) blocks.push(call(`${name}-${blocks.length}`, name, input));
  }
  blocks.push(bash("valid", "bun test"));
  const flow = deriveWorkFlow(blocks, new Map([["valid", exited("valid", 0)]]));
  assert.deepEqual(flow.steps.map(({ toolCallId, outcome }) => [toolCallId, outcome]), [["valid", "passed"]]);
});

test("R2-OAI-1: a wrapped pipefail disable also drops the earlier enable", () => {
  for (const command of [
    "set -o pipefail; command set +o pipefail; bun test | cat",
    "set -o pipefail; builtin set +o pipefail; bun test | cat",
    "set -o pipefail; eval 'set +o pipefail'; bun test | cat",
  ]) assert.equal(readCheckRun(bash("c", command), exited("c", 0)).state, "unverified", command);
});

test("R2-OAI-2: only an executed check program makes a check, never quoted text or search arguments", () => {
  for (const command of ["printf '%s' 'bun test'", "git log --grep=test", "echo bun run lint", "grep -rn typecheck package.json"]) {
    assert.equal(readCheckRun(bash("c", command), exited("c", 0)), null, command);
  }
  for (const command of ["bun test ./x", "bunx tsc --noEmit", "python3 -m pytest -q", "npm run lint"]) {
    assert.equal(readCheckRun(bash("c", command), exited("c", 0))?.state, "passed", command);
  }
});

test("R2-OAI-3: shell options that take a value do not hide the -c script", () => {
  const flow = flowOf([
    [bash("ci", "bash -o errexit -c 'gh run watch 1 --exit-status'"), exited("ci", 0)],
    [bash("check", "bash +O extglob -lc 'bun run typecheck'"), exited("check", 0)],
  ]);
  assert.deepEqual(flow.steps.map(({ toolCallId, stage, outcome }) => [toolCallId, stage, outcome]), [
    ["ci", "ci", "passed"], ["check", "check", "passed"],
  ]);
});

test("R2-OAI-4: null helper arguments and unconvertible inputs never throw", () => {
  assert.equal(readCheckRun(null, undefined), null);
  assert.equal(readCheckRun(undefined, undefined), null);
  for (const blocks of [null, undefined, {}, 42]) assert.deepEqual(deriveWorkFlow(blocks, new Map()).steps, [], String(blocks));
  const flow = deriveWorkFlow([call("weird", "lsp", { action: { toString: null } }), bash("valid", "bun test")], null);
  assert.deepEqual(flow.steps.map(({ toolCallId, stage, outcome }) => [toolCallId, stage, outcome]), [
    ["weird", "investigate", "done"], ["valid", "check", "unobserved"],
  ]);
});

test("xr2 R1-ANT-1, R1-OAI-1/2/3/4/5: only an allow-listed shape beside a check can be 통과", () => {
  for (const command of [
    "trap 'exit 0' EXIT; bun test",
    "trap 'exit 0' ERR; bun test",
    "exit 0 && bun test",
    "printf data | bun test",
    "bun test && echo ok",
  ]) assert.equal(readCheckRun(bash("c", command), exited("c", 0))?.state, "unverified", command);
  for (const command of ["command -v pytest", "bash -n -c 'bun test'", "python3 -c \"'bun test'\"", "node -e 'test()'"]) {
    assert.equal(readCheckRun(bash("c", command), exited("c", 0)), null, command);
  }
  assert.equal(readCheckRun(bash("c", "sudo -b pytest"), exited("c", 0))?.state, "unverified");
  for (const command of ["cd /repo && bun run lint && bun run test", "set -euo pipefail; bun test 2>&1 | tail -5", "bun test; exit $?"]) {
    assert.equal(readCheckRun(bash("c", command), exited("c", 0))?.state, "passed", command);
  }
});

test("xr2 R1-ANT-2, R1-OAI-6, R1-ANT-6: syntax checks, literal text and the test builtin make no stage", () => {
  const flow = flowOf([
    [bash("syntax", "bash -n ~/cuelo-run/Tools/CUELO_Setup/wsl/update.sh"), exited("syntax", 0)],
    [bash("literal", "printf '%s' '$(bun test)'"), exited("literal", 0)],
    [bash("builtin", "test -s out.log"), exited("builtin", 0)],
  ]);
  assert.deepEqual(flow.steps, []);
});

test("xr2 R1-ANT-3: gh run view --exit-status is not a CI verdict", () => {
  const flow = flowOf([[bash("view", "gh run view 1 --exit-status"), exited("view", 0)]]);
  assert.deepEqual(flow.steps.map(({ stage, outcome }) => [stage, outcome]), [["ci", "unverified"]]);
});

test("xr2 R1-ANT-4, R1-OAI-7: a CI failure stands until a settled CI result", () => {
  for (const live of [true, false]) {
    const failed = [bash("watch", "gh run watch 1 --exit-status"), exited("watch", 1)];
    for (const later of [[bash("again", "gh run watch 1 --exit-status"), null], [bash("list", "gh run list --limit 3"), exited("list", 0)]]) {
      const flow = flowOf([failed, later], live);
      assert.equal(flow.stages.find(({ stage }) => stage === "ci").status, "failed", later[0].input.command);
      assert.deepEqual(flow.next, live ? { stage: "edit", returning: true } : null, later[0].input.command);
    }
    const passed = flowOf([failed, [bash("ok", "gh run watch 1 --exit-status"), exited("ok", 0)]], live);
    assert.equal(passed.stages.find(({ stage }) => stage === "ci").status, "passed");
  }
});

test("xr2 R1-OAI-9: a task dispatch result does not start another attempt", () => {
  for (const live of [true, false]) {
    const flow = flowOf([
      [bash("t", "bun test"), exited("t", 1)],
      [call("d", "task", { tasks: [] }), result("d", "task")],
    ], live);
    assert.equal(flow.attempt, 1);
    assert.deepEqual(flow.loops, []);
    assert.deepEqual(flow.next, live ? { stage: "edit", returning: true } : null);
  }
});

test("xr2 R2-ANT-1/2/3/5, R2-OAI-1/2/3/4/5: no-exec modes, queries, inline code and plain pipes are never 통과", () => {
  for (const command of [
    "set -n; bun test",
    "set -en; bun test",
    "bash -c 'set -n; bun test'",
    "bash -o pipefail -n -c 'bun test'",
    "bash -O extglob -n -c 'bun test'",
    "node -pe \"require('./package.json').scripts.test\"",
    "python3 -Ic \"import pytest\"",
    "python3 -cpass pytest",
    "command -p -v pytest",
    "sudo -l pytest",
    "cd . | bun test",
  ]) assert.notEqual(readCheckRun(bash("c", command), exited("c", 0))?.state, "passed", command);
});

test("xr2 R2-ANT-4, R2-OAI-6: a different running check never hides a recorded check failure", () => {
  const flow = flowOf([[bash("t", "bun test"), exited("t", 1)], [bash("l", "bun run lint"), null]], true);
  assert.equal(flow.stages.find(({ stage }) => stage === "check").status, "failed");
});

test("xr2 R2-ANT-6: a deploy failure stands until a settled deploy result", () => {
  const waited = "systemd-run --user --wait bash ~/cuelo-run/Tools/CUELO_Setup/wsl/update.sh abc";
  const failed = [bash("d", waited), exited("d", 1)];
  const alone = flowOf([failed], true);
  for (const later of [[bash("d2", waited), null], [bash("d3", `${waited}; echo x`), exited("d3", 0)]]) {
    const flow = flowOf([failed, later], true);
    assert.equal(flow.stages.find(({ stage }) => stage === "deploy").status, "failed", later[0].input.command);
    assert.deepEqual(flow.next, alone.next, later[0].input.command);
  }
});

test("#40: help output, optional scripts and node --test are judged by what actually ran", () => {
  const state = (command, exitCode) => readCheckRun(bash("c", command), exited("c", exitCode))?.state ?? null;
  // Help and version output run no check at all.
  assert.equal(state("npm test --help", 0), null);
  assert.equal(state("bunx vitest --version", 0), null);
  // `--if-present` exits 0 without running anything when the script is missing.
  assert.equal(state("npm run --if-present lint", 0), "unverified");
  assert.equal(state("npm run --if-present lint", 1), "failed");
  // `node --test` runs tests whatever the file is called, and with no file it discovers them.
  assert.equal(state("node --test", 1), "failed");
  assert.equal(state("node --test", 0), "passed");
  assert.equal(state("node --test failing.spec.mjs", 1), "failed");
  assert.equal(state("node --import tsx --test lib/a.ts", 0), "passed");
  assert.deepEqual(readCheckRun(bash("c", "node --test failing.spec.mjs"), exited("c", 1)).labels, ["test"]);
  // A `--test` after the script is the script's own argument.
  assert.equal(state("node scripts/run.mjs --test", 0), null);
  // Any value-taking node option before `--test` is skipped; `--` ends node's options, so a later `--test` is the script.
  assert.equal(state("node --title worker --test", 1), "failed");
  assert.equal(state("node --report-dir reports --test", 1), "failed");
  assert.equal(state("node -- --test", 0), null);
  // Controls keep their verdicts.
  assert.equal(state("npm test", 1), "failed");
  assert.equal(state("npm test", 0), "passed");
});

test("#41: an unusable review is never done and never clears an earlier review failure", () => {
  const edit = [call("w", "edit", { path: "a.ts" }), result("w", "edit")];
  const review = (id, details) => [call(id, "cross_review", { action: "review", files: ["a.ts"] }), result(id, "cross_review", details)];
  const unusable = {
    error: { passable: false, reviewers: [{ status: "error" }], findings: [] },
    unparsable: { passable: false, reviewers: [{ status: "unparsable" }], findings: [] },
    mixed: { passable: false, reviewers: [{ status: "ok" }, { status: "error" }], findings: [] },
  };
  for (const [kind, details] of Object.entries(unusable)) {
    const aloneEntries = [edit, review("r", details)];
    const alone = flowOf(aloneEntries);
    const step = alone.steps.find(({ stage }) => stage === "review");
    assert.equal(step.outcome, "unverified", kind);
    assert.equal(step.unusable, true, kind);
    assert.equal(alone.stages.find(({ stage }) => stage === "review").status, "unverified", kind);
    assert.deepEqual(flowOf(aloneEntries, true).next, { stage: "review", returning: false }, kind);
    assert.equal(alone.next, null, kind);

    const resolvedEntries = [
      edit,
      review("r1", details),
      [call("res", "cross_review", { action: "resolve", reviewId: "x" }), result("res", "cross_review", { pass: false, open: [], unusable: "never pass" })],
      review("r2", details),
    ];
    const afterFailedResolve = flowOf(resolvedEntries);
    assert.equal(afterFailedResolve.stages.find(({ stage }) => stage === "review").status, "failed", kind);
    assert.deepEqual(flowOf(resolvedEntries, true).next, { stage: "edit", returning: true }, kind);
    assert.equal(afterFailedResolve.next, null, kind);
  }
  const validEntries = [edit, review("r", { passable: true, reviewers: [{ status: "ok" }], findings: [] })];
  const valid = flowOf(validEntries);
  assert.equal(valid.stages.find(({ stage }) => stage === "review").status, "done");
  assert.deepEqual(flowOf(validEntries, true).next, { stage: "commit", returning: false });
  assert.equal(valid.next, null);
  // Records written before reviewers/passable existed keep reading as a clean review.
  assert.equal(flowOf([edit, review("r", { findings: [] })]).stages.find(({ stage }) => stage === "review").status, "done");
  const withFindings = flowOf([edit, review("r", { passable: false, reviewers: [{ status: "ok" }, { status: "error" }], findings: [{ id: "F1" }] })]);
  assert.equal(withFindings.stages.find(({ stage }) => stage === "review").status, "failed");
});

test("stages a later stage passed over are skipped, and a docs-only commit needs no deploy", () => {
  const commit = (files) => [call("g", "git_finalize", { files }), result("g", "git_finalize", { ok: true, commitSha: "1c056bf1af54" })];
  const read = [call("r", "read", { path: "HANDOFF.md" }), result("r", "read")];
  const edit = [call("w", "edit", { path: "HANDOFF.md" }), result("w", "edit")];
  const ci = [bash("ci", "gh run list --workflow CI -L 1"), exited("ci", 0)];

  const docs = flowOf([read, edit, commit(["Tools/CUELO_Setup/HANDOFF.md", "doc/history/2026/10/19-x/main.md"]), ci]);
  assert.deepEqual(stageStatuses(docs), {
    investigate: "done", edit: "done", check: "skipped", review: "skipped", commit: "done", ci: "unverified", deploy: "notNeeded",
  });
  assert.equal(docs.next, null);

  // While the turn runs, CI after a docs-only commit is still next; once it ended, a CI it never entered is not needed.
  const docsBeforeCi = [read, edit, commit(["README.md"])];
  const runningDocs = flowOf(docsBeforeCi, true);
  assert.equal(stageOf(runningDocs, "ci").status, "waiting");
  assert.equal(stageOf(runningDocs, "deploy").status, "notNeeded");
  assert.deepEqual(runningDocs.next, { stage: "ci", returning: false });
  assert.deepEqual([stageOf(flowOf(docsBeforeCi), "ci").status, stageOf(flowOf(docsBeforeCi), "deploy").status], ["notNeeded", "notNeeded"]);
  assert.equal(flowOf(docsBeforeCi).next, null);

  const code = [read, edit, commit(["HANDOFF.md", "lib/a.ts"]), ci];
  assert.equal(stageOf(flowOf(code, true), "deploy").status, "waiting");
  assert.deepEqual(flowOf(code, true).next, { stage: "deploy", returning: false });
  // A code commit that was never deployed skipped the deploy; it is not "not needed".
  assert.equal(stageOf(flowOf(code), "deploy").status, "skipped");
  assert.equal(flowOf(code).next, null);

  // A failed docs-only commit leaves the deploy waiting while the turn runs; a finished turn without any commit has nothing to deploy.
  const failed = [edit, [call("g", "git_finalize", { files: ["README.md"] }), result("g", "git_finalize", undefined, true)]];
  assert.equal(stageOf(flowOf(failed, true), "deploy").status, "waiting");
  assert.equal(stageOf(flowOf(failed), "deploy").status, "notNeeded");
});

const stageOf = (flow, name) => flow.stages.find(({ stage }) => stage === name);
const edited = (id, path = "a.ts") => [call(id, "edit", { path }), result(id, "edit")];

test("an edit after a passing check, review or commit leaves those results as before-edit, not current", () => {
  // write → bun test exit 0 → write: the pass is a fact about the earlier code only.
  const baseline = liveFlowOf([[call("w1", "write", { path: "a.ts" }), result("w1", "write")], [bash("t", "bun test"), exited("t", 0)], [call("w2", "write", { path: "a.ts" }), result("w2", "write")]]);
  assert.equal(stageOf(baseline, "check").status, "stale");
  assert.equal(baseline.steps.find((step) => step.toolCallId === "t").outcome, "passed", "the observed result itself is kept");
  assert.deepEqual(baseline.next, { stage: "check", returning: false });
  assert.equal(baseline.reached, "edit");

  // A documentation edit is a modification too.
  const docs = flowOf([edited("w1"), [bash("t", "bun test"), exited("t", 0)], edited("w2", "HANDOFF.md")]);
  assert.equal(stageOf(docs, "check").status, "stale");

  // A commit before the last edit does not carry the flow forward to CI.
  const committed = liveFlowOf([
    edited("w1"), [bash("t", "bun test"), exited("t", 0)],
    [call("cr", "cross_review", { action: "resolve" }), result("cr", "cross_review", { pass: true, open: [] })],
    [call("g", "git_finalize", { files: ["a.ts"] }), result("g", "git_finalize", { ok: true, commitSha: "0123456789abcdef0123456789abcdef01234567" })],
    edited("w2"),
  ]);
  assert.deepEqual(["check", "review", "commit"].map((stage) => stageOf(committed, stage).status), ["stale", "stale", "stale"]);
  assert.deepEqual(committed.next, { stage: "check", returning: false });

  // Re-running after the edit makes the check current again; only the rerun counts.
  const rerun = liveFlowOf([edited("w1"), [bash("t1", "bun test"), exited("t1", 0)], edited("w2"), [bash("t2", "bun test"), exited("t2", 0)]]);
  assert.equal(stageOf(rerun, "check").status, "passed");
  assert.deepEqual(rerun.next, { stage: "review", returning: false });
  // A delegated task is not a direct edit and invalidates nothing by itself.
  const dispatched = flowOf([edited("w1"), [bash("t", "bun test"), exited("t", 0)], [call("k", "task", { tasks: [] }), result("k", "task")]]);
  assert.equal(stageOf(dispatched, "check").status, "passed");
});

test("a command spanning check and CI or deploy never turns its exit code into a per-stage verdict", () => {
  const both = (exitCode) => liveFlowOf([edited("w"), [bash("c", "bun test && gh run watch 1 --exit-status"), exited("c", exitCode)]]);
  const failed = both(1);
  const steps = failed.steps.filter((step) => step.toolCallId === "c");
  assert.deepEqual(steps.map(({ stage, outcome }) => [stage, outcome]), [["check", "unverified"], ["ci", "unverified"]]);
  assert.ok(steps.every((step) => step.compound?.failed === true && step.exitCode === 1));
  // The failure is not blamed on either stage: no return to edit, and neither stage counts as passed.
  assert.deepEqual(failed.loops, []);
  assert.deepEqual(failed.next, { stage: "check", returning: false });
  assert.equal(failed.reached, "edit");
  const run = readCheckRun(bash("c", "bun test && gh run watch 1 --exit-status"), exited("c", 1));
  assert.equal(run.state, "unverified");
  assert.deepEqual(run.compound, { stages: ["check", "ci"], failed: true });
  // Exit 0 keeps the existing proof subset: the other stage's command masks each verdict.
  assert.deepEqual(both(0).steps.filter((step) => step.toolCallId === "c").map(({ outcome }) => outcome), ["unverified", "unverified"]);
  // A single-stage command still fails its own stage.
  assert.equal(readCheckRun(bash("c", "bun run typecheck && bun test"), exited("c", 1)).state, "failed");
  assert.equal(readCheckRun(bash("c", "bun run typecheck && bun test"), exited("c", 1)).compound, undefined);
});

const SHA_C = "d60687c4f2701afa8bf4ca2fc165633c816acf3f";
const SHA_PUBLIC = "1d801956d79d8f3cf1efaf8f20cae912418440c9";
const out = (toolCallId, text) => result(toolCallId, "bash", { exitCode: 0 }, false, `${text}\n\n\nWall time: 1.51 seconds\n\nCommand exited with code 0`);
/**
 * 사무실 기록(d60687c)의 호출 모양을 따른다: 커밋, 게시 실행 찾기·대기, 공개 main 조회. 앞선 공개 CI 조회는 워크플로와 브랜치가
 * 밝혀진 모양(`--workflow CI --branch main`)이다. 그 기록의 실제 조회(`gh run view <id> --json status,conclusion,headSha,url`)는
 * 워크플로·브랜치가 없어 CI 성공의 증거가 아니다(아래 officeShape). 커밋 파일에는 실행 파일을 하나 넣는다 — 문서만 바꾼 커밋이면
 * 끝난 턴의 CI가 게시 증거 없이도 필요 없음이 되어, 게시 증거만의 판정을 볼 수 없다.
 */
const priorCi = (sha = SHA_PUBLIC) => [
  bash("prior", "gh run list -R owner/CUELO --workflow CI --branch main --limit 1 --json databaseId,status,conclusion,headSha,url"),
  out("prior", `[{"conclusion":"success","databaseId":39331357582,"headSha":"${sha}","status":"completed","url":"https://github.com/owner/CUELO/actions/runs/39331357582"}]`),
];
const commitC = [call("g", "git_finalize", { files: ["Tools/CUELO_Setup/HANDOFF.md", "Tools/CUELO_Setup/wsl/update.sh"] }), result("g", "git_finalize", { ok: true, commitSha: SHA_C })];
const listPublish = (workflow = "Publish public mirror", sha = SHA_C) => [
  bash("list", `gh run list -R owner/CUELO-private --workflow '${workflow}' --commit ${sha} --limit 1 --json databaseId,status,conclusion,headSha,url`),
  out("list", `[{"conclusion":"","databaseId":39347594788,"headSha":"${sha}","status":"in_progress","url":"https://github.com/owner/CUELO-private/actions/runs/39347594788"}]`),
];
const watchPublish = (id = "39347594788") => [bash("watch", `gh run watch ${id} -R owner/CUELO-private --exit-status`), out("watch", "✓ main Publish public mirror · 39347594788")];
const publicHead = (sha = SHA_PUBLIC, repo = "owner/CUELO", id = "head", ref = "main") => [bash(id, `gh api repos/${repo}/commits/${ref} --jq .sha`), out(id, sha)];

test("CI is not needed only when the commit's own publish run succeeded and the public head stayed at a CI-passed commit", () => {
  const prior = readCiSuccessHeads(...priorCi());
  assert.deepEqual(prior, [{ repo: "owner/cuelo", sha: SHA_PUBLIC, branch: "main", workflow: "ci" }]);
  const withHeads = (entries, priorHeads = prior, live = false) => deriveWorkFlow(entries.map(([block]) => block), new Map(entries.map(([block, value]) => [block.toolCallId, value])), live, priorHeads);
  const chain = [commitC, listPublish(), watchPublish(), publicHead()];
  const published = withHeads(chain);
  assert.deepEqual(published.publication, { kind: "publicHeadUnchanged", repo: "owner/cuelo", ref: "main", sha: SHA_PUBLIC, runId: "39347594788" });
  assert.equal(stageOf(published, "ci").status, "notNeeded");
  assert.deepEqual(withHeads(chain, prior, true).next, { stage: "deploy", returning: false }, "a non-doc private file still leaves deploy open");
  assert.equal(stageOf(published, "deploy").status, "skipped", "a finished turn skipped that deploy; it was not unneeded");
  // The same CI observation earlier in the same turn counts too.
  assert.equal(flowOf([priorCi(), ...chain]).publication?.sha, SHA_PUBLIC);
  // A HANDOFF-only commit (0ee16b7 shape) has nothing next once CI is not needed.
  const handoffOnly = [[call("g", "git_finalize", { files: ["HANDOFF.md"] }), result("g", "git_finalize", { ok: true, commitSha: SHA_C })], listPublish(), watchPublish(), publicHead()];
  assert.equal(withHeads(handoffOnly, prior, true).next, null);
  assert.equal(stageOf(withHeads(handoffOnly), "deploy").status, "notNeeded");
  for (const indent of [undefined, 2]) {
    const jsonHead = [bash("json", "gh api repos/owner/CUELO/commits/main"), out("json", JSON.stringify({ sha: SHA_PUBLIC }, null, indent))];
    assert.equal(withHeads([commitC, listPublish(), watchPublish(), jsonHead]).publication?.sha, SHA_PUBLIC);
  }

  // Unknown workflow or branch is not evidence of a successful CI: the office record's own query shape.
  const officeShape = readCiSuccessHeads(
    bash("o", "git -C /repo/run rev-parse HEAD && gh run view 39331357582 -R owner/CUELO --json status,conclusion,displayTitle,headSha,url"),
    out("o", `6ac4120df38aaff9bda75b2c58ffc0f33430d6b1\n{"conclusion":"success","displayTitle":"fix","headSha":"${SHA_PUBLIC}","status":"completed","url":"https://github.com/owner/CUELO/actions/runs/39331357582"}`),
  );
  assert.deepEqual(officeShape, []);
  const otherBranch = readCiSuccessHeads(...[
    bash("b", "gh run list -R owner/CUELO --workflow CI --branch dev --json headSha,status,conclusion,url"),
    out("b", `[{"headSha":"${SHA_PUBLIC}","status":"completed","conclusion":"success","url":"https://github.com/owner/CUELO/actions/runs/1"}]`),
  ]);
  const cases = {
    "no prior successful CI for that head": withHeads(chain, []),
    "prior CI with unknown workflow and branch": withHeads(chain, officeShape),
    "prior CI on another branch": withHeads(chain, otherBranch),
    "watch of a run not tied to the commit": withHeads([commitC, listPublish(), watchPublish("123"), publicHead()]),
    "another workflow's run": withHeads([commitC, listPublish("CI"), watchPublish(), publicHead()]),
    "the run published another commit": withHeads([commitC, listPublish(undefined, "aaaaaaa4f2701afa8bf4ca2fc165633c816acf3f"), watchPublish(), publicHead()]),
    "public head moved": withHeads([commitC, listPublish(), watchPublish(), publicHead("bbbbbbb6d79d8f3cf1efaf8f20cae912418440c9")], prior, true),
    "public head matched, then a later read moved": withHeads([commitC, listPublish(), watchPublish(), publicHead(), publicHead("bbbbbbb6d79d8f3cf1efaf8f20cae912418440c9", "owner/CUELO", "head2")]),
    "public head matched, then JSON response moved": withHeads([commitC, listPublish(), watchPublish(), publicHead(), [bash("head-json", "gh api repos/owner/CUELO/commits/main"), out("head-json", JSON.stringify({ sha: "bbbbbbb6d79d8f3cf1efaf8f20cae912418440c9" }))]]),
    "latest head cannot be decoded": withHeads([commitC, listPublish(), watchPublish(), publicHead(), [bash("head-unknown", "gh api repos/owner/CUELO/commits/main --jq '.sha[:7]'"), out("head-unknown", SHA_PUBLIC.slice(0, 7))]]),
    "latest head query failed": withHeads([commitC, listPublish(), watchPublish(), publicHead(), [bash("head-failed", "gh api repos/owner/CUELO/commits/main --jq .sha"), exited("head-failed", 1)]]),
    "latest head uses a pipeline": withHeads([commitC, listPublish(), watchPublish(), publicHead(), [bash("head-pipe", "gh api repos/owner/CUELO/commits/main | jq -r .sha"), out("head-pipe", "b".repeat(40))]]),
    "head read before the publish finished": withHeads([commitC, listPublish(), publicHead(), watchPublish()]),
    "head of a different repository": withHeads([commitC, listPublish(), watchPublish(), publicHead(SHA_PUBLIC, "owner/other")]),
    "head of another ref": withHeads([commitC, listPublish(), watchPublish(), publicHead(SHA_PUBLIC, "owner/CUELO", "head", "dev")]),
    "publish watched before the commit": withHeads([listPublish(), watchPublish(), commitC, publicHead()]),
    "no publication observed at all": withHeads([commitC]),
  };
  for (const [name, caseFlow] of Object.entries(cases)) {
    assert.equal(caseFlow.publication, null, name);
    assert.notEqual(stageOf(caseFlow, "ci").status, "notNeeded", name);
  }
  assert.deepEqual(withHeads([commitC], prior, true).next, { stage: "ci", returning: false });
  assert.equal(stageOf(cases["no publication observed at all"], "ci").status, "skipped", "a finished turn skipped that CI; it was not unneeded");
  // A failed publish watch proves nothing.
  const failedWatch = withHeads([commitC, listPublish(), [bash("watch", "gh run watch 39347594788 --exit-status"), exited("watch", 1)], publicHead()]);
  assert.equal(failedWatch.publication, null);
  assert.equal(stageOf(cases["public head moved"], "ci").status, "waiting", "a known publish workflow is not a CI pass");
  for (const [id, value] of [["ci-failed", exited("ci-failed", 1)], ["ci-running", undefined]]) {
    const pending = withHeads([...chain, [bash(id, "gh run watch 50000000000 --exit-status"), value]]);
    assert.notEqual(stageOf(pending, "ci").status, "notNeeded", "publication must not hide an actual CI outcome");
    assert.equal(pending.publication, null, "CI failure or missing result must not expose a not-needed detail note");
  }
  assert.equal(withHeads([...chain, edited("w")]).publication, null);
  // A known non-CI workflow does not prove the head's CI.
  const release = readCiSuccessHeads(bash("r", "gh run list -R owner/CUELO --branch main --json headSha,status,conclusion,workflowName,url"), out("r", `[{"headSha":"${SHA_PUBLIC}","status":"completed","conclusion":"success","workflowName":"Release","url":"https://github.com/owner/CUELO/actions/runs/1"}]`));
  assert.deepEqual(release, []);
});

test("a publish watch followed by a CI watch keeps the combined failure on CI", () => {
  const command = "gh run watch 39347594788 -R owner/CUELO-private --exit-status && gh run watch 50000000000 -R owner/CUELO --exit-status";
  const entries = [commitC, listPublish(), [bash("two-watches", command), exited("two-watches", 1)]];
  assert.equal(stageOf(flowOf(entries), "ci").status, "failed");
  assert.equal(stageOf(flowOf(entries, true), "ci").status, "failed");
  assert.deepEqual(liveFlowOf(entries).next, { stage: "edit", returning: true });
});

test("a documentation edit after the old public CI does not require a new CI for an unchanged publication", () => {
  const flow = flowOf([
    priorCi(),
    [bash("old-watch", "gh run watch 39331357582 -R owner/CUELO --exit-status"), exited("old-watch", 0)],
    [call("doc-edit", "write", { path: "HANDOFF.md", content: "updated" }), result("doc-edit", "write", {})],
    commitC, listPublish(), watchPublish(), publicHead(),
  ]);
  assert.equal(stageOf(flow, "ci").status, "notNeeded");
  assert.equal(flow.publication?.sha, SHA_PUBLIC);
});

test("a finished turn closes every stage it never entered and names nothing next; a live one keeps going", () => {
  // The office HTML turn: read and edit only, no git.
  const htmlOnly = [
    [call("r", "read", { path: "schedule.html" }), result("r", "read")],
    [call("w", "edit", { path: "schedule.html" }), result("w", "edit")],
  ];
  const finished = flowOf(htmlOnly);
  assert.deepEqual(stageStatuses(finished), {
    investigate: "done", edit: "done", check: "skipped", review: "skipped", commit: "skipped", ci: "notNeeded", deploy: "notNeeded",
  });
  assert.equal(finished.next, null);
  const live = flowOf(htmlOnly, true);
  assert.deepEqual(stageStatuses(live), {
    investigate: "done", edit: "done", check: "waiting", review: "waiting", commit: "waiting", ci: "waiting", deploy: "waiting",
  });
  assert.deepEqual(live.next, { stage: "check", returning: false });

  // A code commit that never reached CI or deploy skipped them; nothing says they are not needed.
  const code = flowOf([...htmlOnly, [call("g", "git_finalize", { files: ["lib/a.ts"] }), result("g", "git_finalize", { ok: true, commitSha: SHA_C })]]);
  assert.deepEqual([stageOf(code, "ci").status, stageOf(code, "deploy").status], ["skipped", "skipped"]);
  assert.equal(code.next, null);
  // A failed commit is no commit: there is nothing to run CI on or deploy.
  const failedCommit = flowOf([...htmlOnly, [call("g", "git_finalize", { files: ["lib/a.ts"] }), result("g", "git_finalize", undefined, true)]]);
  assert.deepEqual([stageOf(failedCommit, "commit").status, stageOf(failedCommit, "ci").status, stageOf(failedCommit, "deploy").status], ["failed", "notNeeded", "notNeeded"]);
  assert.equal(failedCommit.next, null);

  // An unresolved failure stays a failure, with its loop, but the finished turn names no next stage.
  const unresolved = flowOf([
    [call("w1", "edit", { path: "a.ts" }), result("w1", "edit")],
    [bash("t1", "bun test"), exited("t1", 1)],
    [call("w2", "edit", { path: "a.ts" }), result("w2", "edit")],
    [bash("t2", "bun test"), exited("t2", 1)],
  ]);
  assert.deepEqual(stageStatuses(unresolved), {
    investigate: "skipped", edit: "done", check: "failed", review: "skipped", commit: "skipped", ci: "notNeeded", deploy: "notNeeded",
  });
  assert.deepEqual(unresolved.loops, [{ from: "check", attempt: 1 }]);
  assert.equal(unresolved.next, null);
});

test("a commit is documentation-only when every file has a doc extension or sits under a doc or docs directory", () => {
  const committed = (files) => flowOf([
    [call("w", "edit", { path: "a" }), result("w", "edit")],
    [call("g", "git_finalize", { files }), result("g", "git_finalize", { ok: true, commitSha: SHA_C })],
  ], true);
  for (const files of [
    ["HANDOFF.md", "Tools/CUELO_Setup/HANDOFF.md", "doc/history/2026/10/20-x/main.md", "doc/history/2026/10/20-x/evidence/main/release.json"],
    ["docs/api/schema.json"],
    ["packages/web/docs/diagram.svg"],
  ]) {
    assert.equal(committed(files).steps.find((step) => step.stage === "commit").docsOnly, true, files.join(","));
    assert.equal(stageOf(committed(files), "deploy").status, "notNeeded", files.join(","));
  }
  for (const files of [["lib/doc.ts"], ["documentation/a.json"], ["HANDOFF.md", "lib/a.ts"]]) {
    assert.equal(committed(files).steps.find((step) => step.stage === "commit").docsOnly, false, files.join(","));
    assert.equal(stageOf(committed(files), "deploy").status, "waiting", files.join(","));
  }
});

const NOTHING_TO_PUBLISH = "Public tree already matches; nothing to publish";
/** The 4c570d7 record's shapes: (a) a combined run listing, (b) the mirror run found by commit, watched, and its log grepped. */
const listRuns = [
  bash("runs", `bun sync-checkout.ts --revision ${SHA_C}; git status --short; sleep 10; gh run list --commit ${SHA_C} --json workflowName,status,conclusion --jq '.[] | "\\(.workflowName) \\(.status) \\(.conclusion)"'`),
  out("runs", "Publish CUELO web release completed skipped\nPublish public mirror in_progress \nCI completed skipped"),
];
const mirrorLog = (id = "mirror", { sha = SHA_C, workflow = "Publish public mirror", viewed = "\"$id\"", filter = `grep -o "${NOTHING_TO_PUBLISH}" | head -n 1`, before = "", text = `mirror 39386271706 exit 0\n${NOTHING_TO_PUBLISH}` } = {}) => [
  bash(id, `${before}id=$(gh run list --commit ${sha} --workflow "${workflow}" --json databaseId --jq '.[0].databaseId'); [ -n "$id" ] || exit 9; gh run watch "$id" --exit-status --interval 10 >/dev/null; echo "mirror $id exit $?"; gh run view ${viewed} --log 2>/dev/null | ${filter}`),
  out(id, text),
];

test("a mirror run whose log says the public tree already matches makes CI not needed for that commit", () => {
  const recorded = flowOf([commitC, listRuns, mirrorLog()]);
  assert.deepEqual(recorded.publication, { kind: "nothingToPublish", commit: SHA_C });
  assert.equal(stageOf(recorded, "ci").status, "notNeeded");
  // A-CI-DETAIL-UNVERIFIED: the run listing for the commit and the mirror-log read only looked at the publish run. They are
  // investigation, not CI rows that read 판정 미확인 under a 필요 없음 station.
  assert.deepEqual(stageOf(recorded, "ci").steps, []);
  assert.deepEqual(recorded.steps.filter(({ toolCallId }) => toolCallId === "runs" || toolCallId === "mirror").map(({ stage, outcome }) => [stage, outcome]), [
    ["investigate", "done"], ["investigate", "done"],
  ]);
  assert.equal(flowOf([commitC, listRuns, mirrorLog()], true).publication?.kind, "nothingToPublish");

  const cases = {
    "no mirror evidence, only the run listing": [commitC, listRuns],
    "the phrase comes from echo, not from the run log": [commitC, mirrorLog("m", { filter: "cat; echo \"Public tree already matches; nothing to publish\"" })],
    "the log of another run": [commitC, mirrorLog("m", { viewed: "\"$other\"" })],
    "the id variable is reassigned": [commitC, mirrorLog("m", { before: "id=1; " })],
    "a run of another commit": [commitC, mirrorLog("m", { sha: "a".repeat(40) })],
    "a run of another workflow": [commitC, mirrorLog("m", { workflow: "CI" })],
    "grep without -o can print the whole line": [commitC, mirrorLog("m", { filter: `grep "${NOTHING_TO_PUBLISH}"` })],
    "the log does not say it": [commitC, mirrorLog("m", { text: "mirror 39386271706 exit 0" })],
    "the command failed": [commitC, [mirrorLog("m")[0], result("m", "bash", { exitCode: 1 }, true, `${NOTHING_TO_PUBLISH}\nCommand exited with code 1`)]],
    "observed before the commit": [mirrorLog("m"), commitC],
    "the commit was edited afterwards": [commitC, mirrorLog("m"), edited("w")],
  };
  for (const [name, entries] of Object.entries(cases)) {
    const flow = flowOf(entries);
    assert.equal(flow.publication, null, name);
    assert.notEqual(stageOf(flow, "ci").status, "notNeeded", name);
  }
  // A real CI outcome after the commit is never hidden by the mirror evidence.
  const ciFailed = flowOf([commitC, mirrorLog(), [bash("ci", "gh run watch 50000000000 --exit-status"), exited("ci", 1)]]);
  assert.equal(stageOf(ciFailed, "ci").status, "failed");
  assert.equal(ciFailed.publication, null);
});

test("a CI observation after the commit that is not about the commit's runs stays 판정 미확인 next to mirror evidence", () => {
  const flow = flowOf([commitC, listRuns, mirrorLog(), [bash("ci-view", "gh run view 50000000000 -R owner/CUELO"), out("ci-view", "✓ main CI · 50000000000")]]);
  assert.equal(stageOf(flow, "ci").status, "unverified");
  assert.deepEqual(stageOf(flow, "ci").steps.map(({ toolCallId, outcome }) => [toolCallId, outcome]), [["ci-view", "unverified"]]);
  assert.equal(flow.publication, null);
});

/** 세션 cwd를 준 흐름. */
function flowIn(cwd, entries, live = false) {
  const results = new Map(entries.filter(([, value]) => value).map(([block, value]) => [block.toolCallId, value]));
  return deriveWorkFlow(entries.map(([block]) => block), results, live, [], cwd);
}
const stepStages = (flow) => flow.steps.map(({ toolCallId, stage, outcome }) => [toolCallId, stage, outcome]);

test("writes that touch only scratch paths are investigation and never open 수정 or a fix loop", () => {
  const entries = [
    [bash("t1", "bun test"), exited("t1", 1)],
    [call("s1", "write", { path: ".omp/x.sh" }), result("s1", "write")],
    [call("s2", "edit", { input: "[/tmp/x.ts#1A2B]\nPUT >1:\n+x" }), result("s2", "edit", { path: "/tmp/x.ts", op: "update" })],
    [call("s3", "write", { path: "/mnt/c/Users/user/AppData/Local/Temp/x" }), result("s3", "write")],
    [bash("t2", "bun test"), exited("t2", 0)],
  ];
  for (const cwd of ["/repo", undefined]) {
    const flow = flowIn(cwd, entries);
    assert.deepEqual(stepStages(flow).slice(1, 4), [["s1", "investigate", "done"], ["s2", "investigate", "done"], ["s3", "investigate", "done"]], String(cwd));
    assert.equal(flow.attempt, 1, String(cwd));
    assert.deepEqual(flow.loops, [], String(cwd));
    assert.equal(stageStatuses(flow).edit, "skipped", String(cwd));
    assert.equal(stageStatuses(flow).check, "passed", String(cwd));
  }
  // While the turn runs, a scratch write without a result is an investigation in progress.
  assert.deepEqual(stepStages(flowIn("/repo", [[call("p", "write", { path: ".omp/x.sh" }), null]], true)), [["p", "investigate", "running"]]);
});

test("omp configuration, a folder merely named Temp, and a write mixing scratch with a real file stay edits", () => {
  const failed = [bash("t1", "bun test"), exited("t1", 1)];
  const cases = {
    "project rule": [call("w", "write", { path: ".omp/rules/r.md" }), result("w", "write")],
    "user skill": [call("w", "write", { path: "/home/user/.omp/agent/skills/s/SKILL.md" }), result("w", "write")],
    "folder named Temp": [call("w", "write", { path: "D:\\work\\Temp\\proj\\a.cs" }), result("w", "write")],
    mixed: [
      call("w", "edit", { input: "[.omp/a.sh#1111]\nPUT >1:\n+x\n[src/a.ts#2222]\nPUT >1:\n+y" }),
      result("w", "edit", { perFileResults: [{ path: "/repo/.omp/a.sh", op: "update" }, { path: "/repo/src/a.ts", op: "update" }] }),
    ],
  };
  for (const [name, entry] of Object.entries(cases)) {
    const flow = flowIn("/repo", [failed, entry]);
    assert.deepEqual(stepStages(flow)[1], ["w", "edit", "done"], name);
    assert.deepEqual(flow.loops, [{ from: "check", attempt: 1 }], name);
  }
  // A hashline edit still in flight names no file yet, so it stays a pending edit.
  assert.deepEqual(stepStages(flowIn("/repo", [[call("p", "edit", { input: "[.omp/x.sh#1A2B]\nPUT >1:\n+x" }), null]], true)), [["p", "edit", "running"]]);
});
