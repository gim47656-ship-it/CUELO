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
  const flow = flowOf([
    [call("r", "grep", { pattern: "x" }), result("r", "grep")],
    [call("w1", "write", { path: "a.ts" }), result("w1", "write")],
    [bash("t1", "bun test"), exited("t1", 1)],
    [call("r2", "read", { path: "a.ts" }), result("r2", "read")],
    [call("w2", "edit", { path: "a.ts" }), result("w2", "edit")],
    [call("w3", "edit", { path: "b.ts" }), result("w3", "edit")],
    [bash("t2", "bun test"), exited("t2", 0)],
    [call("cr", "cross_review", { action: "review" }), result("cr", "cross_review", { findings: [{ id: "F1" }, { id: "F2" }] })],
    [call("w4", "edit", { path: "c.ts" }), result("w4", "edit")],
  ]);
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
});

test("the next stage points back to edit while a failure stands, and moves on once it is resolved", () => {
  const failedCheck = flowOf([
    [call("w", "edit", { path: "a.ts" }), result("w", "edit")],
    [bash("t", "bun run lint"), exited("t", 1)],
  ]);
  assert.deepEqual(failedCheck.next, { stage: "edit", returning: true });
  assert.deepEqual(failedCheck.loops, []);
  assert.equal(failedCheck.reached, "edit");

  const rerunPassed = flowOf([
    [call("w", "edit", { path: "a.ts" }), result("w", "edit")],
    [bash("t1", "bun run lint"), exited("t1", 1)],
    [bash("t2", "bun run lint"), exited("t2", 0)],
    [call("w2", "edit", { path: "b.ts" }), result("w2", "edit")],
  ]);
  assert.equal(rerunPassed.attempt, 1, "a failure fixed by a rerun is not a loop");
  // The passing rerun came before the later edit, so it no longer covers the code: check again next.
  assert.equal(rerunPassed.stages.find((view) => view.stage === "check").status, "stale");
  assert.deepEqual(rerunPassed.next, { stage: "check", returning: false });

  const unresolved = flowOf([
    [call("w", "edit", { path: "a.ts" }), result("w", "edit")],
    [bash("t", "bun test"), exited("t", 0)],
    [call("cr", "cross_review", { action: "resolve" }), result("cr", "cross_review", { pass: false, open: [{ id: "F1" }] })],
  ]);
  assert.deepEqual(unresolved.next, { stage: "edit", returning: true });
  assert.equal(unresolved.stages.find((view) => view.stage === "review").steps[0].findings, 1);

  const failedCommit = flowOf([
    [call("w", "edit", { path: "a.ts" }), result("w", "edit")],
    [bash("t", "bun test"), exited("t", 0)],
    [call("cr", "cross_review", { action: "resolve" }), result("cr", "cross_review", { pass: true, open: [] })],
    [call("g", "git_finalize", { files: [] }), result("g", "git_finalize", undefined, true, "git_finalize failed at fetch")],
  ]);
  assert.deepEqual(failedCommit.next, { stage: "commit", returning: false });
  const onlyFailedCommit = flowOf([[call("g", "git_finalize", { files: [] }), result("g", "git_finalize", undefined, true)]]);
  assert.deepEqual(onlyFailedCommit.next, { stage: "commit", returning: false });

  const onlyInvestigated = flowOf([[call("r", "read", { path: "a.ts" }), result("r", "read")]]);
  assert.deepEqual(onlyInvestigated.next, { stage: "edit", returning: false });

  const empty = flowOf([[call("todo", "todo", {}), result("todo", "todo")]]);
  assert.equal(empty.next, null);
  assert.equal(empty.current, null);
  assert.ok(empty.stages.every((view) => view.status === "waiting"));
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
    assert.deepEqual(pending.next, { stage: "edit", returning: true });
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
    assert.deepEqual(flowOf(entries, live).next, { stage: "edit", returning: true });
    assert.equal(flowOf(entries, live).stages.find(({ stage }) => stage === "check").status, "failed");
    const edited = flowOf([...entries, [call("w", "edit", { path: "a.ts" }), result("w", "edit")]], live);
    assert.equal(edited.attempt, 2);
    const passed = flowOf([...entries, [bash("passed", "bun test"), exited("passed", 0)]], live);
    assert.deepEqual(passed.next, { stage: "review", returning: false });
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
      assert.deepEqual(flow.next, { stage: "edit", returning: true }, later[0].input.command);
    }
    const passed = flowOf([failed, [bash("ok", "gh run watch 1 --exit-status"), exited("ok", 0)]], live);
    assert.equal(passed.stages.find(({ stage }) => stage === "ci").status, "passed");
  }
});

test("xr2 R1-OAI-9: a task dispatch result does not start another attempt", () => {
  const flow = flowOf([
    [bash("t", "bun test"), exited("t", 1)],
    [call("d", "task", { tasks: [] }), result("d", "task")],
  ]);
  assert.equal(flow.attempt, 1);
  assert.deepEqual(flow.loops, []);
  assert.deepEqual(flow.next, { stage: "edit", returning: true });
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
    const alone = flowOf([edit, review("r", details)]);
    const step = alone.steps.find(({ stage }) => stage === "review");
    assert.equal(step.outcome, "unverified", kind);
    assert.equal(step.unusable, true, kind);
    assert.equal(alone.stages.find(({ stage }) => stage === "review").status, "unverified", kind);
    assert.deepEqual(alone.next, { stage: "review", returning: false }, kind);

    const afterFailedResolve = flowOf([
      edit,
      review("r1", details),
      [call("res", "cross_review", { action: "resolve", reviewId: "x" }), result("res", "cross_review", { pass: false, open: [], unusable: "never pass" })],
      review("r2", details),
    ]);
    assert.equal(afterFailedResolve.stages.find(({ stage }) => stage === "review").status, "failed", kind);
    assert.deepEqual(afterFailedResolve.next, { stage: "edit", returning: true }, kind);
  }
  const valid = flowOf([edit, review("r", { passable: true, reviewers: [{ status: "ok" }], findings: [] })]);
  assert.equal(valid.stages.find(({ stage }) => stage === "review").status, "done");
  assert.deepEqual(valid.next, { stage: "commit", returning: false });
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
    investigate: "done", edit: "done", check: "skipped", review: "skipped", commit: "done", ci: "unverified", deploy: "skipped",
  });
  assert.equal(docs.next, null);

  const docsBeforeCi = flowOf([read, edit, commit(["README.md"])]);
  assert.equal(docsBeforeCi.stages.find(({ stage }) => stage === "ci").status, "waiting");
  assert.equal(docsBeforeCi.stages.find(({ stage }) => stage === "deploy").status, "skipped");
  assert.deepEqual(docsBeforeCi.next, { stage: "ci", returning: false });

  const code = flowOf([read, edit, commit(["HANDOFF.md", "lib/a.ts"]), ci]);
  assert.equal(code.stages.find(({ stage }) => stage === "deploy").status, "waiting");
  assert.deepEqual(code.next, { stage: "deploy", returning: false });

  // A failed docs-only commit leaves the deploy waiting.
  const failed = flowOf([edit, [call("g", "git_finalize", { files: ["README.md"] }), result("g", "git_finalize", undefined, true)]]);
  assert.equal(failed.stages.find(({ stage }) => stage === "deploy").status, "waiting");
});

const stageOf = (flow, name) => flow.stages.find(({ stage }) => stage === name);
const edited = (id, path = "a.ts") => [call(id, "edit", { path }), result(id, "edit")];

test("an edit after a passing check, review or commit leaves those results as before-edit, not current", () => {
  // write → bun test exit 0 → write: the pass is a fact about the earlier code only.
  const baseline = flowOf([[call("w1", "write", { path: "a.ts" }), result("w1", "write")], [bash("t", "bun test"), exited("t", 0)], [call("w2", "write", { path: "a.ts" }), result("w2", "write")]]);
  assert.equal(stageOf(baseline, "check").status, "stale");
  assert.equal(baseline.steps.find((step) => step.toolCallId === "t").outcome, "passed", "the observed result itself is kept");
  assert.deepEqual(baseline.next, { stage: "check", returning: false });
  assert.equal(baseline.reached, "edit");

  // A documentation edit is a modification too.
  const docs = flowOf([edited("w1"), [bash("t", "bun test"), exited("t", 0)], edited("w2", "HANDOFF.md")]);
  assert.equal(stageOf(docs, "check").status, "stale");

  // A commit before the last edit does not carry the flow forward to CI.
  const committed = flowOf([
    edited("w1"), [bash("t", "bun test"), exited("t", 0)],
    [call("cr", "cross_review", { action: "resolve" }), result("cr", "cross_review", { pass: true, open: [] })],
    [call("g", "git_finalize", { files: ["a.ts"] }), result("g", "git_finalize", { ok: true, commitSha: "0123456789abcdef0123456789abcdef01234567" })],
    edited("w2"),
  ]);
  assert.deepEqual(["check", "review", "commit"].map((stage) => stageOf(committed, stage).status), ["stale", "stale", "stale"]);
  assert.deepEqual(committed.next, { stage: "check", returning: false });

  // Re-running after the edit makes the check current again; only the rerun counts.
  const rerun = flowOf([edited("w1"), [bash("t1", "bun test"), exited("t1", 0)], edited("w2"), [bash("t2", "bun test"), exited("t2", 0)]]);
  assert.equal(stageOf(rerun, "check").status, "passed");
  assert.deepEqual(rerun.next, { stage: "review", returning: false });
  // A delegated task is not a direct edit and invalidates nothing by itself.
  const dispatched = flowOf([edited("w1"), [bash("t", "bun test"), exited("t", 0)], [call("k", "task", { tasks: [] }), result("k", "task")]]);
  assert.equal(stageOf(dispatched, "check").status, "passed");
});

test("a command spanning check and CI or deploy never turns its exit code into a per-stage verdict", () => {
  const both = (exitCode) => flowOf([edited("w"), [bash("c", "bun test && gh run watch 1 --exit-status"), exited("c", exitCode)]]);
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
 * 워크플로·브랜치가 없어 CI 성공의 증거가 아니다(아래 officeShape).
 */
const priorCi = (sha = SHA_PUBLIC) => [
  bash("prior", "gh run list -R owner/CUELO --workflow CI --branch main --limit 1 --json databaseId,status,conclusion,headSha,url"),
  out("prior", `[{"conclusion":"success","databaseId":39331357582,"headSha":"${sha}","status":"completed","url":"https://github.com/owner/CUELO/actions/runs/39331357582"}]`),
];
const commitC = [call("g", "git_finalize", { files: ["Tools/CUELO_Setup/HANDOFF.md", "doc/history/x/evidence/a.json"] }), result("g", "git_finalize", { ok: true, commitSha: SHA_C })];
const listPublish = (workflow = "Publish public mirror", sha = SHA_C) => [
  bash("list", `gh run list -R owner/CUELO-private --workflow '${workflow}' --commit ${sha} --limit 1 --json databaseId,status,conclusion,headSha,url`),
  out("list", `[{"conclusion":"","databaseId":39347594788,"headSha":"${sha}","status":"in_progress","url":"https://github.com/owner/CUELO-private/actions/runs/39347594788"}]`),
];
const watchPublish = (id = "39347594788") => [bash("watch", `gh run watch ${id} -R owner/CUELO-private --exit-status`), out("watch", "✓ main Publish public mirror · 39347594788")];
const publicHead = (sha = SHA_PUBLIC, repo = "owner/CUELO", id = "head", ref = "main") => [bash(id, `gh api repos/${repo}/commits/${ref} --jq .sha`), out(id, sha)];

test("CI is not needed only when the commit's own publish run succeeded and the public head stayed at a CI-passed commit", () => {
  const prior = readCiSuccessHeads(...priorCi());
  assert.deepEqual(prior, [{ repo: "owner/cuelo", sha: SHA_PUBLIC, branch: "main", workflow: "ci" }]);
  const withHeads = (entries, priorHeads = prior) => deriveWorkFlow(entries.map(([block]) => block), new Map(entries.map(([block, value]) => [block.toolCallId, value])), false, priorHeads);
  const chain = [commitC, listPublish(), watchPublish(), publicHead()];
  const published = withHeads(chain);
  assert.deepEqual(published.publication, { repo: "owner/cuelo", ref: "main", sha: SHA_PUBLIC, runId: "39347594788" });
  assert.equal(stageOf(published, "ci").status, "skipped");
  assert.deepEqual(published.next, { stage: "deploy", returning: false }, "a non-doc private file still leaves deploy open");
  // The same CI observation earlier in the same turn counts too.
  assert.equal(flowOf([priorCi(), ...chain]).publication?.sha, SHA_PUBLIC);
  // A HANDOFF-only commit (0ee16b7 shape) has nothing next once CI is not needed.
  const handoffOnly = [[call("g", "git_finalize", { files: ["HANDOFF.md"] }), result("g", "git_finalize", { ok: true, commitSha: SHA_C })], listPublish(), watchPublish(), publicHead()];
  assert.equal(withHeads(handoffOnly).next, null);
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
    "public head moved": withHeads([commitC, listPublish(), watchPublish(), publicHead("bbbbbbb6d79d8f3cf1efaf8f20cae912418440c9")]),
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
    assert.notEqual(stageOf(caseFlow, "ci").status, "skipped", name);
  }
  assert.deepEqual(cases["no publication observed at all"].next, { stage: "ci", returning: false });
  // A failed publish watch proves nothing.
  const failedWatch = withHeads([commitC, listPublish(), [bash("watch", "gh run watch 39347594788 --exit-status"), exited("watch", 1)], publicHead()]);
  assert.equal(failedWatch.publication, null);
  // A later edit makes the commit stale, so its publication no longer decides CI.
  assert.equal(stageOf(cases["public head moved"], "ci").status, "waiting", "a known publish workflow is not a CI pass");
  for (const [id, value] of [["ci-failed", exited("ci-failed", 1)], ["ci-running", undefined]]) {
    const pending = withHeads([...chain, [bash(id, "gh run watch 50000000000 --exit-status"), value]]);
    assert.notEqual(stageOf(pending, "ci").status, "skipped", "publication must not hide an actual CI outcome");
    assert.equal(pending.publication, null, "CI failure or missing result must not expose a not-needed detail note");
  }
  assert.equal(withHeads([...chain, edited("w")]).publication, null);
  // A known non-CI workflow does not prove the head's CI.
  const release = readCiSuccessHeads(bash("r", "gh run list -R owner/CUELO --branch main --json headSha,status,conclusion,workflowName,url"), out("r", `[{"headSha":"${SHA_PUBLIC}","status":"completed","conclusion":"success","workflowName":"Release","url":"https://github.com/owner/CUELO/actions/runs/1"}]`));
  assert.deepEqual(release, []);
});

test("a publish watch followed by a CI watch keeps the combined failure on CI", () => {
  const command = "gh run watch 39347594788 -R owner/CUELO-private --exit-status && gh run watch 50000000000 -R owner/CUELO --exit-status";
  const flow = flowOf([commitC, listPublish(), [bash("two-watches", command), exited("two-watches", 1)]]);
  assert.equal(stageOf(flow, "ci").status, "failed");
  assert.deepEqual(flow.next, { stage: "edit", returning: true });
});

test("a documentation edit after the old public CI does not require a new CI for an unchanged publication", () => {
  const flow = flowOf([
    priorCi(),
    [bash("old-watch", "gh run watch 39331357582 -R owner/CUELO --exit-status"), exited("old-watch", 0)],
    [call("doc-edit", "write", { path: "HANDOFF.md", content: "updated" }), result("doc-edit", "write", {})],
    commitC, listPublish(), watchPublish(), publicHead(),
  ]);
  assert.equal(stageOf(flow, "ci").status, "skipped");
  assert.equal(flow.publication?.sha, SHA_PUBLIC);
});
