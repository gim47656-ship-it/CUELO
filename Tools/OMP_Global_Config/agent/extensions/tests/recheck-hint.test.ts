import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createRecheckHint, isCheckCommand, MAX_NOTICE } from "../../cuelo-plugins/recheck-hint";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

function harness(kind?: "sub") {
  const handlers: Record<string, Handler[]> = {};
  const events = new EventEmitter();
  const logs: Record<string, unknown>[] = [];
  const state = { signature: "S0" as string | undefined };
  const ctx = { cwd: "/repo", agent: kind ? { kind } : undefined, sessionManager: { getSessionId: () => "s1" } };
  const pi = { events, on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); } };
  createRecheckHint({ log: (record) => logs.push(record), signature: async () => state.signature })(pi as never);
  const emit = async (name: string, event: Record<string, unknown>) => {
    let last: unknown;
    for (const handler of handlers[name] ?? []) last = (await handler(event, ctx)) ?? last;
    return last as { content?: { type: string; text: string }[] } | undefined;
  };
  const input = (text = "요청") => emit("input", { source: "rpc", text });
  const bash = (command: string, exitCode: number | undefined = 0, extra: Record<string, unknown> = {}) =>
    emit("tool_result", { toolName: "bash", isError: exitCode !== 0 && exitCode !== undefined, input: { command, ...extra }, content: [], details: exitCode === undefined ? {} : { exitCode } });
  const edit = (path: string, isError = false) => emit("tool_result", { toolName: "edit", isError, input: { path }, content: [] });
  const task = () => emit("tool_result", { toolName: "task", isError: false, input: {}, content: [] });
  const wait = () => emit("tool_result", { toolName: "wait", isError: false, input: {}, content: [] });
  const asyncResult = () => emit("message_start", { message: { role: "custom", customType: "async-result", content: "done" } });
  const endTurn = () => emit("turn_end", {});
  let call = 0;
  // git_finalize reads the signature in tool_call (before HEAD moves) and delivers on tool_result.
  const finalize = async () => {
    const toolCallId = `g${++call}`;
    await emit("tool_call", { toolName: "git_finalize", toolCallId, input: {} });
    return emit("tool_result", { toolName: "git_finalize", toolCallId, isError: false, input: {}, content: [{ type: "text", text: "committed abc123" }] });
  };
  const turnEnd = () => {
    const notices: string[] = [];
    events.emit("cuelo:turn-end-notices", { ctx, notices });
    return notices;
  };
  return { emit, input, bash, edit, task, wait, asyncResult, endTurn, finalize, turnEnd, logs, state };
}

const remind = (result: { content?: { text: string }[] } | undefined) => result?.content?.map((part) => part.text).join("\n") ?? "";

describe("check command recognition", () => {
  test("runner checks and tools count; dev servers, help calls and plain commands do not", () => {
    for (const command of ["bun test", "bun run typecheck", "npm run lint", "tsc --noEmit", "cd x && node --test a.test.ts", "bunx vitest run"]) {
      expect(isCheckCommand(command)).toBe(true);
    }
    for (const command of ["ls -la", "bun run dev", "git status", "bun test --help", "echo bun test", "npm install"]) {
      expect(isCheckCommand(command)).toBe(false);
    }
  });
});

describe("recheck-hint", () => {
  test("pass -> edit -> git_finalize appends one reminder naming the stale check and the changed path", async () => {
    const h = harness();
    await h.input();
    await h.bash("bun test a.test.ts");
    await h.edit("/repo/src/a.ts");
    const result = await h.finalize();
    const text = remind(result);
    expect(text).toContain("committed abc123");
    expect(text).toContain("[recheck-hint]");
    expect(text).toContain("`bun test a.test.ts`");
    expect(text).toContain("src/a.ts");
    expect(h.logs.map((entry) => entry.kind)).toEqual(["remind-finalize"]);
    // The same set is not announced again.
    expect(await h.finalize()).toBeUndefined();
  });

  test("a passing rerun after the edit keeps git_finalize and turn end silent", async () => {
    const h = harness();
    await h.input();
    await h.bash("bun test a.test.ts");
    await h.edit("/repo/src/a.ts");
    await h.bash("bun test a.test.ts");
    expect(await h.finalize()).toBeUndefined();
    expect(h.turnEnd()).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  test("a check that did not change after the last edit is silent: pass after edit is current", async () => {
    const h = harness();
    await h.input();
    await h.edit("/repo/src/a.ts");
    await h.bash("bun test");
    expect(await h.finalize()).toBeUndefined();
  });

  test("failing checks are never listed and a failing rerun drops the earlier pass", async () => {
    const h = harness();
    await h.input();
    await h.bash("bun run typecheck", 1);
    await h.bash("bun test a.test.ts");
    await h.edit("/repo/src/a.ts");
    await h.bash("bun test a.test.ts", 1);
    expect(await h.finalize()).toBeUndefined();
    await h.bash("bun run lint", undefined); // no reported exit code: neither pass nor fail
    expect(await h.finalize()).toBeUndefined();
  });

  test("non-check bash commands and output-masked checks are ignored", async () => {
    const h = harness();
    await h.input();
    await h.bash("ls -la");
    await h.bash("bun run dev");
    await h.bash("bun test | tail -5");
    await h.edit("/repo/src/a.ts");
    expect(await h.finalize()).toBeUndefined();
  });

  test("an edit that errored is not a change", async () => {
    const h = harness();
    await h.input();
    await h.bash("bun test");
    await h.edit("/repo/src/a.ts", true);
    expect(await h.finalize()).toBeUndefined();
  });

  test("earlier-request checks are listed first and the list is capped with a count", async () => {
    const h = harness();
    await h.input("첫 요청");
    await h.bash("bun test first.test.ts");
    await h.input("둘째 요청");
    for (let i = 0; i < 6; i += 1) await h.bash(`bun test later-${i}.test.ts`);
    await h.input("셋째 요청");
    await h.edit("/repo/src/a.ts");
    const text = remind(await h.finalize());
    expect(text.indexOf("first.test.ts")).toBeGreaterThan(-1);
    expect(text.indexOf("first.test.ts")).toBeLessThan(text.indexOf("later-0"));
    expect(text).toContain("(요청 1)");
    expect(text).toContain("외 2개");
    expect(text).not.toContain("later-5");
    expect(text.length).toBeLessThanOrEqual(MAX_NOTICE);
  });

  test("a very long command keeps the reminder under the cap", async () => {
    const h = harness();
    await h.input();
    for (let i = 0; i < 5; i += 1) await h.bash(`bun test ${"x".repeat(200)}${i}.test.ts`);
    await h.edit("/repo/src/a.ts");
    expect(remind(await h.finalize()).replace("committed abc123\n\n", "").length).toBeLessThanOrEqual(MAX_NOTICE);
  });

  test("a task receipt alone is not a change; a signature that moved before git_finalize is", async () => {
    const h = harness();
    await h.input();
    await h.bash("bun test");
    await h.task();
    expect(await h.finalize()).toBeUndefined();
    await h.task();
    h.state.signature = "S1";
    const text = remind(await h.finalize());
    expect(text).toContain("`bun test`");
    expect(text).toContain("git 작업 트리 변경");
  });

  test("async Maker completion after a passing check: changed signature reminds at git_finalize and turn end, unchanged stays silent", async () => {
    for (const changed of [true, false]) {
      const h = harness();
      await h.input();
      await h.bash("bun test");
      await h.task(); // "Spawned N background agents" receipt, nothing changed yet
      if (changed) h.state.signature = "S1"; // the Maker's files land later
      await h.asyncResult();
      await h.endTurn();
      expect(h.turnEnd().length).toBe(changed ? 1 : 0);
      if (changed) {
        expect(h.turnEnd()).toEqual([]); // same set announced once
        expect(remind(await h.finalize())).toBe("");
      } else {
        expect(await h.finalize()).toBeUndefined();
      }
    }
  });

  test("wait result and bash/eval side effects are caught by the signature at git_finalize", async () => {
    for (const route of ["wait", "bash", "eval"]) {
      const h = harness();
      await h.input();
      await h.bash("bun test");
      h.state.signature = "S1";
      if (route === "wait") await h.wait();
      else if (route === "bash") await h.bash("sed -i s/a/b/ src/a.ts");
      else await h.emit("tool_result", { toolName: "eval", isError: false, input: {}, content: [] });
      expect(remind(await h.finalize())).toContain("`bun test`");
    }
  });

  test("a rerun after the signature moved clears the item", async () => {
    const h = harness();
    await h.input();
    await h.bash("bun test");
    h.state.signature = "S1";
    await h.wait();
    await h.bash("bun test");
    expect(await h.finalize()).toBeUndefined();
  });

  test("publishing moves HEAD but is not a content change: later turn end stays silent", async () => {
    const h = harness();
    await h.input();
    await h.bash("bun test");
    await h.emit("tool_call", { toolName: "git_finalize", toolCallId: "gx", input: {} });
    h.state.signature = "S2"; // the commit moved HEAD after tool_call; tree content is unchanged
    expect(await h.emit("tool_result", { toolName: "git_finalize", toolCallId: "gx", isError: false, input: {}, content: [] })).toBeUndefined();
    await h.wait();
    await h.endTurn();
    expect(h.turnEnd()).toEqual([]);
    h.state.signature = "S3"; // a real later change
    await h.wait();
    await h.endTurn();
    expect(h.turnEnd()).toHaveLength(1);
  });

  test("an unknown signature (no git) never produces a signature-based reminder", async () => {
    const h = harness();
    h.state.signature = undefined;
    await h.input();
    await h.bash("bun test");
    await h.wait();
    await h.endTurn();
    expect(await h.finalize()).toBeUndefined();
    expect(h.turnEnd()).toEqual([]);
  });

  test("turn end reminds only when files changed in this request, once per distinct set", async () => {
    const h = harness();
    await h.input("첫 요청");
    await h.bash("bun test a.test.ts");
    await h.edit("/repo/src/a.ts");
    await h.input("둘째 요청");
    expect(h.turnEnd()).toEqual([]);
    await h.edit("/repo/src/b.ts");
    const notices = h.turnEnd();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("`bun test a.test.ts`(요청 1)");
    expect(h.turnEnd()).toEqual([]);
    await h.bash("bun test a.test.ts");
    expect(h.logs.map((entry) => entry.kind)).toEqual(["remind-turn-end", "rerun-after-reminder"]);
    await h.edit("/repo/src/c.ts");
    expect(h.turnEnd()).toHaveLength(1);
  });

  test("Maker sessions are not tracked", async () => {
    const h = harness("sub");
    await h.input();
    await h.bash("bun test");
    await h.edit("/repo/src/a.ts");
    expect(await h.finalize()).toBeUndefined();
    expect(h.turnEnd()).toEqual([]);
  });

  test("session switch to another session forgets earlier checks", async () => {
    const h = harness();
    await h.input();
    await h.bash("bun test");
    await h.emit("session_start", {});
    await h.edit("/repo/src/a.ts");
    expect(await h.finalize()).toBeUndefined();
  });
});

test("SDK load: real runner and turn-end guard deliver the reminder and write the injected events file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recheck-hint-"));
  const eventsPath = join(dir, "events.jsonl");
  process.env.CUELO_RECHECK_HINT_EVENTS_PATH = eventsPath;
  try {
    const paths = [new URL("../turn-end-guard.ts", import.meta.url).pathname, new URL("../../cuelo-plugins/recheck-hint/index.ts", import.meta.url).pathname];
    const loaded = await loadExtensions(paths, dir);
    expect(loaded.errors).toEqual([]);
    const sent: { customType?: string; content: string }[] = [];
    const session = SessionManager.inMemory(dir);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, dir, session, {} as never);
    runner.onError((error) => { throw new Error(error.error); });
    loaded.runtime.sendMessage = (message) => { sent.push(message as { customType?: string; content: string }); };
    await runner.emit({ type: "session_start" });
    await runner.emitInput("검사 돌리고 고쳐 줘", undefined, "rpc");
    await runner.emitToolResult({ type: "tool_result", toolName: "bash", toolCallId: "b1", input: { command: "bun test x.test.ts" }, isError: false, details: { exitCode: 0 }, content: [{ type: "text", text: "pass" }] });
    await runner.emitToolResult({ type: "tool_result", toolName: "edit", toolCallId: "e1", input: { path: "src/x.ts" }, isError: false, details: undefined, content: [{ type: "text", text: "ok" }] });
    await runner.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "고쳤습니다." }] }] } as never);
    const turnEnd = sent.filter((message) => message.customType === "turn-end-guard");
    expect(turnEnd).toHaveLength(1);
    expect(turnEnd[0]!.content).toContain("[recheck-hint]");
    console.log(`SMOKE turn-end: ${turnEnd[0]!.content}`);
    const result = await runner.emitToolResult({ type: "tool_result", toolName: "git_finalize", toolCallId: "g1", input: {}, isError: false, details: undefined, content: [{ type: "text", text: "finalized" }] });
    // The set was already announced at turn end, so finalize stays silent.
    expect(JSON.stringify(result ?? {})).not.toContain("recheck-hint");
    const lines = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "remind-turn-end", role: "main", count: 1 });
    await runner.emit({ type: "session_shutdown" });
  } finally {
    delete process.env.CUELO_RECHECK_HINT_EVENTS_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});
