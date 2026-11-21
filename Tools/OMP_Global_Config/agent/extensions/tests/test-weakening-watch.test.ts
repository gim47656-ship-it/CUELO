import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTestWeakening } from "../../cuelo-plugins/test-weakening-watch/detector";
import { createTestWeakeningWatch } from "../../cuelo-plugins/test-weakening-watch/index";

function patch(path: string, before: string[], after: string[], oldPath = `a/${path}`, newPath = `b/${path}`): string {
  return [
    `diff --git a/${path} b/${path}`, `--- ${oldPath}`, `+++ ${newPath}`,
    `@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@`,
    ...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`), "",
  ].join("\n");
}

const SAMPLE = "tests/a.test.ts";

test("flags a removed expect line and uses net counts for replacements", () => {
  const findings = detectTestWeakening(patch(SAMPLE, ["expect(left).toBe(2)", "expect(right).toBe(1)"], ["expect(other).toBe(7)"]));
  expect(findings).toMatchObject([{ path: SAMPLE, counts: { assertionsRemoved: 1, expectedValuesChanged: 0 } }]);
});

test("points at the lost assertion rather than a replacement in a different hunk", () => {
  const replaced = patch(SAMPLE, ["expect(a).toBe(1)"], ["expect(c).toBe(1)"]);
  expect(detectTestWeakening(`${replaced}@@ -5 +4,0 @@\n-expect(b).toBe(2)\n`)).toMatchObject([
    { counts: { assertionsRemoved: 1 }, excerpts: ["old L5: assertion removed"] },
  ]);
});

test("flags skip, only, todo and conditional skip markers, not existing markers or quoted text", () => {
  const findings = detectTestWeakening(patch(SAMPLE,
    ['test.skip("old title", fn)', 'test("ordinary", fn)'],
    ['test.skip("old title", fn)', 'test.only("ordinary", fn)', 'it.todo("later")', 'it.skipIf(false)("condition", fn)', 'const sample = "test.skip(hi)"', '// describe.only("disabled comment", fn)'],
  ));
  expect(findings).toMatchObject([{ counts: { skipMarkersAdded: 3, testsRemoved: 0 } }]);
});

test("flags same-call literal changes, but not new actual expressions or quote style", () => {
  const findings = detectTestWeakening(patch(SAMPLE,
    ['expect(result).toEqual("expected")', 'expect(actual).toBe(10)', "expect(decimal).toBe('one')"],
    ['expect(result).toEqual("different")', 'expect(other).toBe(9)', 'expect(decimal).toBe("one")'],
  ));
  expect(findings).toMatchObject([{ counts: { expectedValuesChanged: 1, assertionsRemoved: 0 }, excerpts: ['L1: expected literal changed'] }]);
  expect(JSON.stringify(findings)).not.toContain('"different"');
});

test("compares repeated assertion calls as a multiset, including static template literals", () => {
  const before = ["expect(x).toBe(1)", "expect(x).toBe(2)", "expect(x).toBe(`left`)", "expect(d).toBe(`${a}`)"];
  const after = ["expect(x).toBe(3)", "expect(x).toBe(4)", "expect(x).toBe(`right`)", "expect(d).toBe(`${b}`)"];
  expect(detectTestWeakening(patch(SAMPLE, before, after))).toMatchObject([{ counts: { expectedValuesChanged: 3 } }]);
  expect(detectTestWeakening(patch(SAMPLE, before, [...before].reverse()))).toEqual([]);
});

test("flags transferring skip to a different test, plus common focus and skip aliases", () => {
  const before = ['test.skip("a", fn)', 'test("b", fn)', 'it("c", fn)', 'describe("d", fn)', 'test("e", fn)'];
  const after = ['test.skip("b", fn)', 'test("a", fn)', 'fit("c", fn)', 'fdescribe("d", fn)', 'xtest("e", fn)'];
  expect(detectTestWeakening(patch("test/example.js", before, after))).toMatchObject([
    { counts: { skipMarkersAdded: 4, testsRemoved: 0 } },
  ]);
  for (const disabled of ["test.skip", "xtest", "test.skipIf(true)"]) {
    const first = patch(SAMPLE, [`  ${disabled}("a", fn)`], [`  ${disabled}(\`b\`, fn)`]);
    expect(detectTestWeakening(`${first}@@ -20 +20 @@\n-  test('b', fn)\n+  test('a', fn)\n`)).toMatchObject([
      { counts: { skipMarkersAdded: 1 } },
    ]);
  }
  const alias = patch(SAMPLE, ['it.skip("a", fn)'], ['it.skip("b", fn)']);
  const escaped = patch(SAMPLE, ['test.skip("a", fn)'], [`test.skip('it\\'s', fn)`]);
  expect(detectTestWeakening(`${alias}@@ -20 +20 @@\n-test('b', fn)\n+test('a', fn)\n`)).toMatchObject([{ counts: { skipMarkersAdded: 1 } }]);
  expect(detectTestWeakening(`${escaped}@@ -20 +20 @@\n-test("it's", fn)\n+test("a", fn)\n`)).toMatchObject([{ counts: { skipMarkersAdded: 1 } }]);

  const py = patch("test_a.py", ["@pytest.mark.xfail", "def test_a():"], ["def test_a():"])
    + patch("test_b.py", ["def test_b():"], ["@pytest.mark.xfail", "def test_b():"]);
  expect(detectTestWeakening(py)).toMatchObject([{ path: "test_b.py", counts: { skipMarkersAdded: 1 } }]);
  const nearby = [
    "diff --git a/test_nearby.py b/test_nearby.py", "--- a/test_nearby.py", "+++ b/test_nearby.py",
    // Diff markers are concatenated before the decorator so the public mirror's e-mail scan does not see an address.
    "@@ -1,4 +1,4 @@", "-" + "@pytest.mark.xfail", " def test_a():", "     assert first", "+" + "@pytest.mark.xfail", " def test_b():",
  ].join("\n");
  expect(detectTestWeakening(nearby)).toMatchObject([{ path: "test_nearby.py", counts: { skipMarkersAdded: 1 } }]);
});

test("ignores a disabled declaration's title change and an exact cross-file move", () => {
  const skipped = '  test.skip("a", fn)';
  expect(detectTestWeakening(patch(SAMPLE, [skipped], ['test.skip("a renamed", fn)']))).toEqual([]);
  expect(detectTestWeakening(patch(SAMPLE, [skipped], []) + patch("tests/b.test.ts", [], [skipped]))).toEqual([]);
});

test("cancels an identical assertion moved to another hunk or test file", () => {
  const assertion = "expect(result).toEqual(7)";
  const moved = patch(SAMPLE, [assertion], []);
  expect(detectTestWeakening(`${moved}@@ -8,0 +9,1 @@\n+  ${assertion}\n`)).toEqual([]);
  expect(detectTestWeakening(moved + patch("tests/b.test.ts", [], [assertion], "/dev/null"))).toEqual([]);
});

test("ignores non-test file changes and staged new test files", () => {
  expect(detectTestWeakening(patch("src/check.ts", ["expect(x).toBe(2)"], ["test.skip('ignored', fn)"]))).toEqual([]);
  expect(detectTestWeakening(patch("new.spec.ts", [], ["test.skip('new', fn)"], "/dev/null"))).toEqual([]);
  for (const extension of ["json", "txt", "yaml"]) {
    const path = `tests/fixtures/sample.${extension}`;
    expect(detectTestWeakening(patch(path, ["sample"], [], `a/${path}`, "/dev/null"))).toEqual([]);
  }
});

test("never reads a diff hunk line as file metadata", () => {
  const sql = "diff --git a/m.sql b/m.sql\ndeleted file mode 100644\n--- a/m.sql\n+++ /dev/null\n@@ -1 +0,0 @@\n--- tests/embedded text\n";
  expect(detectTestWeakening(sql)).toEqual([]);
});

test("flags Go and Python assertion, test, and skip forms", () => {
  const go = patch("widget_test.go", ["func TestWidget(t *testing.T) {", 't.Fatal("error")'], ['t.Skip("skip")']);
  const py = patch("test_widget.py", ["def test_value():", "assert result == 8", "with pytest.raises(Error):", "self.assertEqual(name, 'old')"], ["@pytest.mark.xfail", "assert result == 7", "self.assertEqual(name, 'new')"]);
  expect(detectTestWeakening(go + py)).toMatchObject([
    { path: "widget_test.go", counts: { assertionsRemoved: 1, testsRemoved: 1, skipMarkersAdded: 1, expectedValuesChanged: 0 } },
    { path: "test_widget.py", counts: { assertionsRemoved: 1, testsRemoved: 1, skipMarkersAdded: 1, expectedValuesChanged: 2 } },
  ]);
  const disabled = patch("test_more.py", [], ["@unittest.skip('reason')", "@unittest.expectedFailure", "self.skipTest('x')", "pytest.skip('x')"]);
  expect(detectTestWeakening(disabled)).toMatchObject([{ counts: { skipMarkersAdded: 4 } }]);
});

test("flags full file deletion, including empty test-file deletion", () => {
  const deleted = patch(SAMPLE, ["it('removed', () => {", "expect(x).toBe(5)", "})"], [], `a/${SAMPLE}`, "/dev/null");
  const empty = "diff --git a/tests/empty file.test.ts b/tests/empty file.test.ts\ndeleted file mode 100644\nindex e69de29..0000000\n";
  expect(detectTestWeakening(deleted + empty)).toMatchObject([
    { path: SAMPLE, deleted: true, counts: { assertionsRemoved: 1, testsRemoved: 1 } },
    { path: "tests/empty file.test.ts", deleted: true },
  ]);
});

function harness(eventsPath: string) {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler[]>();
  const messages: { content: string; display: boolean; options: unknown }[] = [];
  const pi = {
    on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    sendMessage: (message: { content: string; display: boolean }, options: unknown) => messages.push({ ...message, options }),
  };
  createTestWeakeningWatch({ eventsPath })(pi as never);
  return {
    messages,
    async emit(name: string, event: unknown, ctx: unknown) {
      let additionalContext: string | undefined;
      for (const handler of handlers.get(name) ?? []) {
        const result = await handler(event, ctx) as { additionalContext?: string } | undefined;
        additionalContext ??= result?.additionalContext;
      }
      return additionalContext;
    },
  };
}

test("smoke: shared worktree task results and pre-finalize snapshot, with safe telemetry", async () => {
  const root = mkdtempSync(join(tmpdir(), "test-weakening-watch-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const eventsPath = join(root, "events.jsonl");
    const initial = 'test("a", () => {\n  expect(result).toBe("fake-fixture-secret-value")\n})\n';
    const extra = Array.from({ length: 9 }, (_, index) => `tests/${"long-path-".repeat(9)}${index}.test.ts`);
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, SAMPLE), initial);
    for (const path of extra) writeFileSync(join(root, path), initial);
    writeFileSync(join(root, "unrelated.txt"), "old\n");
    writeFileSync(join(root, "tests", "fixture.yaml"), "value: old\n");
    git("init", "--quiet");
    git("add", SAMPLE, ...extra, "unrelated.txt", "tests/fixture.yaml");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "seed temporary smoke fixture");
    writeFileSync(join(root, SAMPLE), initial.replace("test(", "test.skip("));
    git("add", SAMPLE);
    writeFileSync(join(root, SAMPLE), 'test.skip("a", () => {\n})\n');
    writeFileSync(join(root, "new.test.ts"), 'test.only("untracked", fn)\n');
    // Large unrelated changes, even fixture data under tests/, do not consume the Git output cap.
    writeFileSync(join(root, "unrelated.txt"), `${"z".repeat(5 * 1024 * 1024)}\n`);
    writeFileSync(join(root, "tests", "fixture.yaml"), `value: ${"z".repeat(5 * 1024 * 1024)}\n`);

    const { emit, messages } = harness(eventsPath);
    const ctx = { cwd: join(root, "tests"), sessionManager: { getSessionId: () => "smoke-main" }, isIdle: () => true };
    const inline = { toolName: "task", details: { results: [{ id: "Maker#1", exitCode: 0 }] } };
    const receipt = { toolName: "task", details: { results: [], async: { jobId: "job-1" } } };
    await emit("session_start", {}, ctx);
    expect(await emit("tool_result", receipt, ctx)).toBeUndefined();
    expect(await emit("tool_result", inline, { ...ctx, agent: { kind: "sub" } })).toBeUndefined();
    expect(existsSync(eventsPath)).toBe(false);

    const task = await emit("tool_result", inline, ctx);
    expect(task).toContain("[test-weakening-watch] task: 1 test file(s) with possible weakening. tests/a.test.ts: 1 assertion(s) removed, 1 skip/only/todo added");
    expect(task).toContain("old L2: assertion removed");
    expect(task).toContain("ask the Maker to justify it or restore the test");
    expect(await emit("tool_result", inline, ctx)).toBeUndefined();

    const call = { toolName: "git_finalize", toolCallId: "finalize-1" };
    expect(await emit("tool_call", call, ctx)).toBeUndefined();
    // The worktree no longer has the detected weakening when the result hook runs, as after committing it.
    writeFileSync(join(root, SAMPLE), initial);
    git("add", SAMPLE);
    const finalize = await emit("tool_result", call, ctx);
    expect(finalize).toContain("[test-weakening-watch] git_finalize: 1 test file(s) with possible weakening. tests/a.test.ts: 1 assertion(s) removed, 1 skip/only/todo added");
    expect(finalize).not.toContain("old L2");
    const clean = { toolName: "git_finalize", toolCallId: "finalize-2" };
    await emit("tool_call", clean, ctx);
    expect(await emit("tool_result", clean, ctx)).toBeUndefined();

    writeFileSync(join(root, SAMPLE), initial.replace("test(", "test.only("));
    const asyncDone = { message: { role: "custom", customType: "async-result", details: { jobs: [{ type: "task", status: "completed" }] } } };
    const otherJob = { message: { ...asyncDone.message, details: { jobs: [{ type: "bash", status: "completed" }] } } };
    await emit("message_start", otherJob, ctx);
    expect(messages).toHaveLength(0);
    await emit("message_start", asyncDone, ctx);
    expect(messages).toHaveLength(1);
    const asyncAdvice = messages[0]!.content;
    expect(asyncAdvice).toContain("[test-weakening-watch] task: 1 test file(s) with possible weakening. tests/a.test.ts: 1 skip/only/todo added (L1: +only)");
    expect(messages[0]!.display).toBe(false);
    expect(messages[0]!.options).toBeUndefined();

    writeFileSync(join(root, SAMPLE), initial.replace("test(", "test.todo("));
    const settled = { toolName: "wait", details: { jobs: [{ type: "task", status: "completed" }] } };
    expect(await emit("tool_result", { ...settled, details: { jobs: [{ type: "task", status: "running" }] } }, ctx)).toBeUndefined();
    const waitAdvice = await emit("tool_result", settled, ctx);
    expect(waitAdvice).toContain("skip/only/todo added (L1: +todo)");

    const log = readFileSync(eventsPath, "utf8");
    expect(log).not.toContain("fake-fixture-secret-value");
    expect(log).not.toContain("new.test.ts");
    const rows = log.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map(({ kind, main, sessionId }) => [kind, main, sessionId])).toEqual([
      ["task", true, "smoke-main"], ["git_finalize", true, "smoke-main"], ["task", true, "smoke-main"], ["task", true, "smoke-main"],
    ]);
    for (const text of [task, finalize, asyncAdvice, waitAdvice]) {
      expect(text!.length).toBeLessThanOrEqual(600);
      console.log(text);
    }

    for (const path of extra) writeFileSync(join(root, path), 'test("a", () => {})\n');
    const firstPage = await emit("tool_result", inline, ctx);
    expect(firstPage).toMatch(/\+\d+ more/);
    expect(firstPage).not.toContain("8.test.ts");
    let remaining = "";
    for (let index = 0; index < extra.length; index++) {
      const page = await emit("tool_result", inline, ctx);
      if (!page) break;
      expect(page.length).toBeLessThanOrEqual(600);
      remaining += page;
    }
    expect(remaining).toContain("8.test.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  expect(existsSync(root)).toBe(false);
});
