import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { locateLabPlugin } from "../../../../../lib/plugin-lab";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const id = "scratch-dependency-hint";

async function load(enabled: boolean) {
  const plugin = await locateLabPlugin(id, root, root);
  expect(plugin?.source).toBe("repository");
  expect(plugin?.extensionPath).toBeDefined();
  const loaded = await loadExtensions(enabled ? [plugin!.extensionPath!] : [], root);
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions.flatMap((ext) => [...ext.tools.keys()])).toEqual([]);
  const session = { getCwd: () => root, getBranch: () => [], getSessionId: () => id, getSessionFile: () => undefined };
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, session as never, {} as never);
  runner.onError(({ error }) => { throw new Error(error); });
  return runner;
}

const cases = [
  {
    // 2026-09-30, doc/history/2026/09/30-model-eval-1844/main.md:47. The module name was not recorded.
    command: "bun /tmp/perf.ts",
    diagnostic: "error: Cannot find module './src/perf' from '/tmp/perf.ts'",
    exitCode: 1,
    guidance: "임시 스크립트 위치에서 프로젝트에 설치된 Bun과 의존성이 해석되는지",
  },
  {
    // 2026-10-22, doc/history/2026/10/22-artifact-search/main.md:80. The script name and line are illustrative.
    command: "bash /tmp/ci-watch.sh",
    diagnostic: "/tmp/ci-watch.sh: line 8: jq: command not found",
    exitCode: 127,
    guidance: "`command -v jq`",
  },
];

function result(entry: typeof cases[number], isError = true, toolName = "bash", diagnostic = entry.diagnostic) {
  return {
    type: "tool_result" as const,
    toolName,
    toolCallId: "scratch-check",
    input: { command: entry.command },
    isError,
    content: [{ type: "text" as const, text: diagnostic }],
    details: { exitCode: isError ? entry.exitCode : 0 },
  };
}

for (const entry of cases) {
  test(`R12 incident replay: ${entry.command} gets advice only with the plugin loaded`, async () => {
    const disabled = await load(false);
    const enabled = await load(true);
    const event = result(entry);
    expect(await disabled.emitToolResult(event)).toBeUndefined();
    expect(await enabled.emitToolCall({ type: "tool_call", toolName: event.toolName, toolCallId: event.toolCallId, input: event.input })).toBeUndefined();
    const out = await enabled.emitToolResult(event);
    expect(out).toEqual({ additionalContext: expect.stringContaining(entry.guidance) });
    expect(out?.additionalContext).toContain("오류 문구로 추정");
    expect(event).toEqual(result(entry));
    expect(await enabled.emitToolResult(result(entry, false, "bash", "completed"))).toBeUndefined();
  });
}

test("R12 ignores generic dependency errors, non-Bash output, and unrelated scratch failures", async () => {
  const runner = await load(true);
  const [bunCase, shellCase] = cases;
  expect(await runner.emitToolResult(result(bunCase!, true, "eval"))).toBeUndefined();
  expect(await runner.emitToolResult(result(bunCase!, true, "bash", "error: Cannot find module 'lib' from '/repo/src/index.ts'"))).toBeUndefined();
  expect(await runner.emitToolResult(result(bunCase!, true, "bash", "error: Cannot find module 'lib' from '/tmp/repo/src/index.ts'"))).toBeUndefined();
  expect(await runner.emitToolResult(result(bunCase!, true, "bash", "error: Cannot find module 'lib' from '/tmp/../repo/src/index.ts'"))).toBeUndefined();
  expect(await runner.emitToolResult(result(shellCase!, true, "bash", "bash: jq: command not found"))).toBeUndefined();
  expect(await runner.emitToolResult(result(shellCase!, true, "bash", "/tmp/ci-watch.sh: line 8: jq: Permission denied"))).toBeUndefined();
  expect(await runner.emitToolResult(result(shellCase!, true, "bash", "/tmp/repo/bin/watch.sh: line 8: jq: command not found"))).toBeUndefined();
});

test("Bun color codes do not hide the scratch import diagnostic or change the result", async () => {
  const runner = await load(true);
  const entry = cases[0]!;
  const colored = entry.diagnostic.replace(/^error: (.+)$/, "\u001b[31merror\u001b[0m\u001b[2m: \u001b[0m\u001b[1m$1\u001b[0m");
  const event = result(entry, true, "bash", colored);
  expect(await runner.emitToolResult(event)).toEqual({ additionalContext: expect.stringContaining(entry.guidance) });
  expect(event.content[0]?.text).toBe(colored);
});

test("a directly launched scratch watcher still gets advice when its shell masks jq's exit code", async () => {
  const runner = await load(true);
  const entry = cases[1]!;
  const event = result(entry, false, "bash", `${entry.diagnostic}\ncompleted`);
  expect(await runner.emitToolResult(event)).toEqual({ additionalContext: expect.stringContaining(entry.guidance) });
  expect(event).toEqual(result(entry, false, "bash", `${entry.diagnostic}\ncompleted`));
  expect(await runner.emitToolResult({ ...event, input: { command: "cat /tmp/watcher.log" } })).toBeUndefined();
  expect(await runner.emitToolResult({
    ...event,
    input: { command: "bash \t/tmp/ci-watch.sh\n" },
    content: [{ type: "text", text: `/tmp/other.sh: line 1: jq: command not found\n${entry.diagnostic}\ncompleted` }],
  })).toEqual({ additionalContext: expect.stringContaining(entry.guidance) });
  expect(await runner.emitToolResult({
    ...event,
    input: { command: "bash /tmp/a;#" },
    content: [{ type: "text", text: "/tmp/a;#: line 1: jq: command not found" }],
  })).toBeUndefined();
});
