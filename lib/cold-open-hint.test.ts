// Regression: opening a finished session (SSE route cold open) must not launch skill-description
// hint compression model calls; compression starts on the first real turn, once per session.
//
// The scenario runs in a child `bun` process (this same file with COLD_OPEN_HINT_CHILD=1) because
// HOME / PI_CODING_AGENT_DIR / the provider base URL must be set before the SDK loads. The provider
// is a loopback server that refuses every request, so no inference ever leaves the machine.
// Real delays below are negative-evidence windows (no model call may appear), which no event can signal.
// Dynamic imports in the child are required: HOME / PI_CODING_AGENT_DIR / base URL must be set before the SDK loads.
import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MODEL = "claude-opus-5-5";
const SELECTOR = `anthropic/${MODEL}`;

type Counts = { hint: number; conversation: number };
type Result = {
  passive: Counts;
  firstTurn: Counts & { ledger: boolean };
  reconnect: Counts & { sameSession: boolean };
  secondTurn: Counts;
};

async function child(): Promise<void> {
  const repo = resolve(import.meta.dir, "..");
  const env = process.env;
  const dir = env.PI_CODING_AGENT_DIR as string;
  const cwd = env.COLD_OPEN_HINT_CWD as string;
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method === "GET") return Response.json({ data: [], has_more: false });
      if (new URL(req.url).pathname === "/v1/messages") {
        const b = (await req.json()) as { messages?: { content?: unknown }[]; system?: unknown; tools?: unknown };
        const first = JSON.stringify(b.messages?.[0]?.content ?? "");
        requests.push(first.includes("Compress into one routing hint") ? "hint" : b.system && b.tools ? "conversation" : "other");
      }
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "loopback capture, no inference" } },
        { status: 400 },
      );
    },
  });
  const count = (kind: string) => requests.filter((k) => k === kind).length;
  const counts = (): Counts => ({ hint: count("hint"), conversation: count("conversation") });
  const waitUntil = async (f: () => boolean, timeout = 8000) => {
    const until = performance.now() + timeout;
    while (!f() && performance.now() < until) await Bun.sleep(20);
    return f();
  };
  try {
    const base = `http://127.0.0.1:${server.port}`;
    env.ANTHROPIC_BASE_URL = base;
    env.ANTHROPIC_API_KEY = "test-key-not-valid";
    mkdirSync(join(dir, "skills", "cold-open-hint"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "cold-open-hint", "SKILL.md"),
      "---\nname: cold-open-hint\ndescription: Use when constructing a completely synthetic dry-run for a waveform tool that needs an unusually long routing description so the real skill catalog schedules background compression rather than retaining a short original description.\n---\n\nRead the sample only.\n",
    );
    writeFileSync(
      join(dir, "config.yml"),
      JSON.stringify({
        modelRoles: { default: SELECTOR, smol: SELECTOR, tiny: SELECTOR },
        providers: { cacheWarming: "off" },
        models: { enabled: [SELECTOR] },
        mcp: { enabled: false },
        memory: { backend: "off" },
      }),
    );
    writeFileSync(join(dir, "models.yml"), JSON.stringify({ providers: { anthropic: { baseUrl: base, apiKey: "test-key-not-valid" } } }));

    const sdk = await import(join(repo, "node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts"));
    const { getRpcSession } = await import(join(repo, "lib/rpc-manager.ts"));
    const manager = sdk.SessionManager.create(cwd);
    const id = manager.getSessionId();
    manager.appendMessage({ role: "user", content: "fixture old request", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "fixture old answer" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: MODEL,
      timestamp: 2,
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    manager.appendCustomEntry("session_exit", { reason: "idle" });
    await manager.flush();
    assert.ok(!getRpcSession(id), "fixture session starts unloaded");
    const file = manager.getSessionFile();
    assert.ok(file && existsSync(file));

    const { GET } = await import(join(repo, "app/api/agent/[id]/events/route.ts"));
    const open = async (abort: AbortController) => {
      const res = await GET(
        new Request(`http://localhost/api/agent/${id}/events?entries=1`, { headers: { host: "localhost" }, signal: abort.signal }),
        { params: Promise.resolve({ id }) },
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    };
    const abort1 = new AbortController();
    await open(abort1);
    const session = getRpcSession(id);
    assert.ok(session, "the SSE route cold-opened the completed session");
    const abort2 = new AbortController();
    try {
      await session.waitUntilReady();
      assert.equal(session.isRunning(), false);
      await Bun.sleep(2500);
      const passive = counts();

      await session.send({ type: "prompt", message: "fixture new request" });
      await waitUntil(() => count("hint") >= 1 && count("conversation") >= 1);
      await waitUntil(() => !session.isRunning());
      await session.inner.sessionManager.flush();
      const ledger = await waitUntil(() => readFileSync(file, "utf8").split("\n").some((l) => l.includes('"purpose":"skill-description"')), 4000);
      await Bun.sleep(1000);
      const firstTurn = { ...counts(), ledger };

      abort1.abort();
      await open(abort2);
      const sameSession = getRpcSession(id) === session;
      await Bun.sleep(1500);
      const reconnect = { ...counts(), sameSession };

      await session.send({ type: "prompt", message: "fixture second request" });
      await waitUntil(() => count("conversation") >= 2);
      await waitUntil(() => !session.isRunning());
      await Bun.sleep(1500);
      const secondTurn = counts();
      const result: Result = { passive, firstTurn, reconnect, secondTurn };
      console.log(`RESULT ${JSON.stringify(result)}`);
    } finally {
      abort1.abort();
      abort2.abort();
      await session.shutdown();
    }
  } finally {
    server.stop(true);
  }
}

if (process.env.COLD_OPEN_HINT_CHILD === "1") {
  await child();
  process.exit(0);
}



describe("cold open of a finished session", () => {
  test("hint compression starts with the first turn, once per session", async () => {
    const root = mkdtempSync(join(tmpdir(), "cold-open-hint."));
    try {
      const home = join(root, "home");
      const agentDir = join(home, ".omp", "agent");
      const project = join(root, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(project, { recursive: true });
      const proc = Bun.spawn([process.execPath, import.meta.path], {
        cwd: project,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local/share"),
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_STATE_HOME: join(home, ".local/state"),
          PI_CODING_AGENT_DIR: agentDir,
          LANG: "C.UTF-8",
          TERM: "dumb",
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          COLD_OPEN_HINT_CHILD: "1",
          COLD_OPEN_HINT_CWD: project,
        },
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      expect(line, `child exit ${code}\n${out}\n${err.slice(-2000)}`).toBeDefined();
      const r = JSON.parse((line as string).slice(7)) as Result;
      // Passive open: no hint call, no conversation turn.
      expect(r.passive).toEqual({ hint: 0, conversation: 0 });
      // First admitted turn: one hint compression, one conversation turn, journaled.
      expect(r.firstTurn).toEqual({ hint: 1, conversation: 1, ledger: true });
      // SSE reconnect of the live session changes nothing.
      expect(r.reconnect).toEqual({ hint: 1, conversation: 1, sameSession: true });
      // Second turn: still one hint compression for the session, a second conversation turn.
      expect(r.secondTurn).toEqual({ hint: 1, conversation: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
