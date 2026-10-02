import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { convertClaudeMessage, createClaudeRuntime } from "./claude-adapter";
import type { ExternalMakerEvent, ExternalMakerSessionOptions, GatewayRouter } from "./types";

// Claude Code 대신 stream-json을 말하는 가짜 CLI. 모드는 FAKE_CLAUDE_MODE.
const FAKE_CLAUDE = String.raw`
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const sessionId = args[args.indexOf("--session-id") + 1];
writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const mode = process.env.FAKE_CLAUDE_MODE;
let keepAlive;
createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  // 실제 Claude Code처럼 interrupt를 받으면 Bash가 띄운 손자를 남긴 채 먼저 나간다(Windows 고아 재현).
  if (msg.type === "control_request" && msg.request?.subtype === "interrupt") process.exit(0);
  if (msg.type !== "user") return;
  out({ type: "system", subtype: "init", session_id: sessionId });
  if (mode === "ok") {
    const base = process.env.ANTHROPIC_BASE_URL;
    const system = [{ type: "text", text: "x-anthropic-billing-header: cc_version=test;" }, { type: "text", text: "You are Claude Code" }, { type: "text", text: "CUELO 주입 절" }];
    const authed = await fetch(base + "/v1/messages", { method: "POST", headers: { authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ model: "m", system, messages: [] }) });
    const anon = await fetch(base + "/v1/messages", { method: "POST", body: "{}" });
    out({ type: "stream_event", event: { delta: { type: "text_delta", text: "report " } } });
    out({ type: "result", subtype: "success", result: "report gateway=" + authed.status + "/" + anon.status, usage: { input_tokens: 3, output_tokens: 2 } });
  } else if (mode === "hang") {
    let grandchild;
    if (process.platform === "win32") {
      // Git Bash(MSYS)처럼: 중간 프로세스가 손자를 띄우고 먼저 끝나 손자의 Windows 부모 pid가 사라진다.
      // 부모 pid를 따라가는 taskkill /T 로는 닿지 않는 모양이다.
      const stub = spawnSync(process.execPath, ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);"], { encoding: "utf8" });
      grandchild = Number(stub.stdout.trim());
    } else {
      grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid;
    }
    writeFileSync(process.env.FAKE_PID_FILE, JSON.stringify([process.pid, grandchild]));
    keepAlive = setInterval(() => {}, 1000);
    out({ type: "stream_event", event: { delta: { type: "text_delta", text: "spawned" } } });
  } else if (mode === "unguarded") {
    out({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_X", name: "Bash", input: { command: "echo hi" } }] } });
    out({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_X", content: "hi" }] } });
    keepAlive = setInterval(() => {}, 1000);
  }
});
process.stdin.on("end", () => { if (mode === "ok" || mode === "hang") process.exit(0); });
`;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function setup(mode: string, assignment = "OWNED_PATHS: notes/\n\nwrite notes/a.txt") {
  const dir = mkdtempSync(path.join(tmpdir(), "cuelo-claude-adapter-"));
  const fake = path.join(dir, "fake-claude.ts");
  writeFileSync(fake, FAKE_CLAUDE);
  const files = { args: path.join(dir, "args.json"), pids: path.join(dir, "pids.json") };
  let routerClosed = false;
  const routed: unknown[] = [];
  const router: GatewayRouter = {
    route: async req => {
      routed.push(await req.json());
      return Response.json({ ok: true });
    },
    close: () => {
      routerClosed = true;
    },
  };
  const options: ExternalMakerSessionOptions = {
    cwd: path.join(dir, "work"),
    model: "deepseek-v4.1-flash",
    thinking: "high",
    systemPrompt: "maker sop",
    assignment,
    agentDir: path.join(dir, "agent"),
    env: { ...(process.env as Record<string, string>), CUELO_CLAUDE_BIN: fake, FAKE_CLAUDE_MODE: mode, FAKE_ARGS_FILE: files.args, FAKE_PID_FILE: files.pids },
    createGatewayRouter: () => router,
  };
  return { options, files, routed, routerClosed: () => routerClosed };
}

describe("convertClaudeMessage", () => {
  test("maps init, top-level tools, results, and streaming deltas; ignores subagent tool blocks", () => {
    expect(convertClaudeMessage({ type: "system", subtype: "init", session_id: "s1" })).toEqual([{ type: "session_started", sessionId: "s1", engine: "claude" }]);
    expect(
      convertClaudeMessage({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "a" } }] } }),
    ).toEqual([{ type: "tool_started", id: "t1", name: "Write", input: { file_path: "a" } }]);
    expect(convertClaudeMessage({ type: "assistant", parent_tool_use_id: "agent-1", message: { content: [{ type: "tool_use", id: "t2", name: "Write", input: {} }] } })).toEqual([]);
    expect(convertClaudeMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "no" }], is_error: true }] } })).toEqual([
      { type: "tool_completed", id: "t1", output: '[{"type":"text","text":"no"}]', isError: true },
    ]);
    expect(convertClaudeMessage({ type: "stream_event", event: { delta: { type: "thinking_delta", thinking: "hm" } } })).toEqual([{ type: "reasoning_delta", text: "hm" }]);
    expect(convertClaudeMessage({ type: "result", subtype: "error_max_turns", result: "" }).at(-1)).toEqual({ type: "turn_completed", stopReason: "error", text: "" });
  });
});

describe("Claude maker session", () => {
  test("runs one turn through the per-run gateway and reports the Claude session", async () => {
    const { options, files, routed, routerClosed } = setup("ok");
    const session = await createClaudeRuntime().createSession(options);
    const events: ExternalMakerEvent[] = [];
    session.onEvent(event => events.push(event));
    await session.prompt(options.assignment);
    await session.dispose();

    const args = JSON.parse(readFileSync(files.args, "utf8")) as string[];
    expect(args).not.toContain("bypassPermissions");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("deepseek-v4.1-flash");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args[args.indexOf("--session-id") + 1]).toBe(session.id);

    const done = events.find(event => event.type === "turn_completed");
    expect(done).toMatchObject({ type: "turn_completed", stopReason: "stop" });
    const text = done?.type === "turn_completed" ? done.text : "";
    // 토큰이 있는 요청만 router 에 닿고, 토큰 없는 요청은 401
    expect(text).toContain("report gateway=200/401");
    expect(text).toContain(`session_id: ${session.id}`);
    expect(text).toContain("transcript:");
    expect(text).toContain(`claude --resume ${session.id}`);
    expect(text).not.toContain("OWNED_PATHS 없음");
    expect(routerClosed()).toBe(true);
    // Claude Code 청구 헤더 블록만 빠지고 나머지 system 블록은 순서대로 router 에 간다
    expect(routed).toEqual([{ model: "m", system: [{ type: "text", text: "You are Claude Code" }, { type: "text", text: "CUELO 주입 절" }], messages: [] }]);
  });

  test("a brief without OWNED_PATHS carries the blocker in the result", async () => {
    const { options } = setup("ok", "no owned paths here");
    const session = await createClaudeRuntime().createSession(options);
    const events: ExternalMakerEvent[] = [];
    session.onEvent(event => events.push(event));
    await session.prompt(options.assignment);
    await session.dispose();
    const done = events.find(event => event.type === "turn_completed");
    expect(done?.type === "turn_completed" ? done.text : "").toContain("blocker: OWNED_PATHS 없음");
  });

  test("cancel ends the turn and dispose returns only after the process tree has exited", async () => {
    const { options, files } = setup("hang");
    const session = await createClaudeRuntime().createSession(options);
    const spawned = Promise.withResolvers<void>();
    session.onEvent(event => {
      if (event.type === "text_delta" && event.text === "spawned") spawned.resolve();
    });
    const turn = session.prompt(options.assignment);
    await spawned.promise;
    const pids = JSON.parse(readFileSync(files.pids, "utf8")) as number[];
    expect(pids.every(isAlive)).toBe(true);
    await session.abort();
    await session.dispose();
    await turn;
    expect(pids.filter(isAlive)).toEqual([]);
  }, 20_000);

  test("dispose during an unfinished turn (deploy drain) also ends the whole tree", async () => {
    const { options, files } = setup("hang");
    const session = await createClaudeRuntime().createSession(options);
    const spawned = Promise.withResolvers<void>();
    session.onEvent(event => {
      if (event.type === "text_delta" && event.text === "spawned") spawned.resolve();
    });
    const turn = session.prompt(options.assignment);
    await spawned.promise;
    const pids = JSON.parse(readFileSync(files.pids, "utf8")) as number[];
    await session.dispose();
    await turn;
    expect(pids.filter(isAlive)).toEqual([]);
  }, 20_000);

  test("a guarded tool that finished without a guard decision ends the session", async () => {
    const { options } = setup("unguarded");
    const session = await createClaudeRuntime().createSession(options);
    const errors: string[] = [];
    session.onEvent(event => {
      if (event.type === "error") errors.push(event.message);
    });
    await expect(session.prompt(options.assignment)).rejects.toThrow("PreToolUse guard");
    await session.dispose();
    expect(errors.some(message => message.includes("toolu_X"))).toBe(true);
  }, 20_000);
});
