import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { deriveWorkFlow, readCheckRun } = await jiti.import("./work-flow.ts");

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
  assert.equal(rerunPassed.stages.find((view) => view.stage === "check").status, "passed");
  assert.deepEqual(rerunPassed.next, { stage: "review", returning: false });

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
