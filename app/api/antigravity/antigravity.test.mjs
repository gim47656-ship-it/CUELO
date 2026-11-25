import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allowFileRoot } from "../../../lib/file-access";
import { drainAntigravity } from "../../../lib/antigravity/sessions";
import { AntigravityError } from "../../../lib/antigravity/acp";
import { antigravityErrorResponse } from "../../../lib/antigravity/http";
import { GET as list, POST as open } from "./route";
import { POST as send } from "./send/route";
import { POST as control } from "./control/route";
import { GET as events } from "./events/route";
import { version } from "../../../package.json";

const origin = "http://localhost:31999";
let cwd;
const originalEnv = new Map();
const fixture = fileURLToPath(new URL("../../../lib/antigravity/fixture-agy.mjs", import.meta.url));
const forbiddenEnv = ["SSH_TTY", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "OMP_CONFIG_DIR", "AGY_GEMINI_DIR"];

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "cuelo-acp-"));
  allowFileRoot(cwd);
  originalEnv.set("CUELO_EXTERNAL_UPDATE_ROOT", process.env.CUELO_EXTERNAL_UPDATE_ROOT);
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = join(cwd, "isolated-update-state");
  for (const key of [...forbiddenEnv, "CUELO_AGY_BIN"]) {
    originalEnv.set(key, process.env[key]);
    process.env[key] = key === "CUELO_AGY_BIN" ? fixture : "fixture-must-not-observe";
  }
});
afterAll(async () => {
  await drainAntigravity();
  for (const [key, previous] of originalEnv) {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  rmSync(cwd, { recursive: true, force: true });
});

function req(path, body, sessionId, browser = true, extra = {}) {
  const query = new URLSearchParams({ cwd, ...extra, ...(sessionId ? { sessionId } : {}) });
  return new Request(`${origin}/api/antigravity${path}?${query}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { host: "localhost:31999", ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(browser ? { origin, "sec-fetch-site": "same-origin" } : {}) },
  });
}
const wire = () => readFileSync(join(cwd, "fixture-wire.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const method = (name) => wire().filter(({ frame }) => frame?.method === name);
const submit = (message, more = {}) => ({ submissionId: randomUUID(), message, ...more });

async function observe(sessionId) {
  const response = await events(req("/events", undefined, sessionId));
  expect(response.status).toBe(200);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const seen = [];
  let buffered = "";
  return {
    seen,
    close: () => reader.cancel(),
    async until(predicate) {
      let stop;
      const timed = new Promise((_, reject) => { stop = setTimeout(() => reject(new Error(`SSE event timeout: ${JSON.stringify(seen)}`)), 2_000); });
      try {
        for (;;) {
          const end = buffered.indexOf("\n\n");
          if (end >= 0) {
            const line = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            if (!line.startsWith("data: ")) continue;
            const event = JSON.parse(line.slice(6));
            seen.push(event);
            if (predicate(event)) return event;
            continue;
          }
          const next = await Promise.race([reader.read(), timed]);
          if (next.done) throw new Error("SSE closed before target event");
          buffered += next.value;
        }
      } finally { clearTimeout(stop); }
    },
  };
}

test("browser composer route alone submits safe ACP prompts, observes tool updates, and scopes decisions and cancellation", async () => {
  const created = await open(req("", { cwd, message: "must not send", systemPrompt: "never", _meta: { systemPrompt: "never" } }));
  expect(created.status).toBe(200);
  const { session: { sessionId } } = await created.json();
  const second = await open(req("", { cwd }));
  const { session: { sessionId: otherId } } = await second.json();
  expect(otherId).not.toBe(sessionId);
  const stream = await observe(sessionId);
  const otherStream = await observe(otherId);
  try {
    const { snapshot } = await stream.until((e) => e.snapshot);
    const model = snapshot.options.find((option) => option.kind === "model");
    expect(model.current).toBe("");
    expect(model.choices.map(({ value }) => value)).toEqual(["gemini-3-pro", "gemini-3-flash"]);
    await otherStream.until((e) => e.snapshot);
    const blocked = await send(req("/send", submit("blocked default"), sessionId));
    expect({ status: blocked.status, ...await blocked.json() }).toEqual({ status: 409, code: "model_required", error: "Select a Gemini model before sending." });
    expect((await send(req("/send", submit("not a browser"), sessionId, false))).status).toBe(403);
    expect((await control(req("/control", { action: "prompt", message: "not the composer" }, sessionId))).status).toBe(400);
    expect((await control(req("/control", { action: "option", id: "model", value: "claude-sonnet" }, sessionId))).status).toBe(400);
    expect(method("session/prompt")).toHaveLength(0);
    for (const id of [sessionId, otherId]) {
      expect((await control(req("/control", { action: "option", id: "model", value: "gemini-3-flash" }, id))).status).toBe(200);
    }
    expect((await control(req("/control", { action: "option", id: "thinking", value: "high" }, sessionId))).status).toBe(200);
    await stream.until((e) => e.state?.options?.find((option) => option.kind === "thinking")?.current === "high");
    expect((await send(req("/send", submit("  Typed text\n", {
      systemPrompt: "never", _meta: { systemPrompt: "never" }, images: [{ data: "YWJj", mimeType: "image/png", uri: "https://never.invalid" }],
      documents: [{ name: "note.txt", mimeType: "text/plain", text: "attached text", systemPrompt: "never" }],
    }), sessionId))).status).toBe(202);
    const { state: { permissions: [permission] } } = await stream.until((e) => e.state?.permissions?.length);
    const first = method("session/prompt")[0];
    expect(first.frame.params).toEqual({ sessionId, prompt: [
      { type: "text", text: "  Typed text\n" }, { type: "image", mimeType: "image/png", data: "YWJj" },
      { type: "resource", resource: { uri: "attachment://cuelo/note.txt", mimeType: "text/plain", text: "attached text" } },
    ] });
    expect(stream.seen.filter((e) => e.entry?.type === "assistant").map((e) => e.entry.content[0].text)).toEqual(["I found a small change. ", "Here is the **diff**."]);
    expect(stream.seen.some((e) => e.entry?.tool?.diffs?.[0]?.newText === "export const enabled = true;")).toBe(true);
    expect(stream.seen.some((e) => e.state?.plan?.[0]?.status === "completed")).toBe(true);
    expect(stream.seen.some((e) => e.state?.session?.title === "Fixture Antigravity chat")).toBe(true);
    expect(wire().filter(({ frame }) => frame?.result?.outcome?.outcome === "selected")).toHaveLength(0);
    expect((await send(req("/send", submit("second chat"), otherId))).status).toBe(202);
    const { state: { permissions: [other] } } = await otherStream.until((e) => e.state?.permissions?.length);
    expect((await control(req("/control", { action: "permission", id: permission.id, allow: true }, otherId))).status).toBe(400);
    expect((await control(req("/control", { action: "permission", id: permission.id, allow: true }, sessionId, false))).status).toBe(403);
    expect((await send(req("/send", submit("manual steer"), sessionId))).status).toBe(202);
    await stream.until((e) => e.entry?.content?.[0]?.text === "Steering received.");
    expect((await control(req("/control", { action: "permission", id: permission.id, allow: false }, sessionId))).status).toBe(200);
    await stream.until((e) => e.entry?.content?.[0]?.text === "Permission denied.");
    expect((await control(req("/control", { action: "permission", id: other.id, allow: true }, otherId))).status).toBe(200);
    await otherStream.until((e) => e.entry?.content?.[0]?.text === "Permission allowed.");
    expect(wire().filter(({ frame }) => frame?.result?.outcome?.outcome === "selected").map(({ frame }) => frame.result.outcome.optionId)).toEqual(["deny-once", "allow-once"]);
    await stream.until((e) => e.state?.streaming === false);
    expect((await send(req("/send", submit("cancel this"), sessionId))).status).toBe(202);
    await stream.until((e) => e.state?.permissions?.length);
    expect((await control(req("/control", { action: "cancel" }, sessionId))).status).toBe(200);
    await stream.until((e) => e.state?.streaming === false);
    expect(method("session/cancel").at(-1).frame.params).toEqual({ sessionId });
    expect(wire().some(({ frame }) => frame?.id === 504 && frame?.result?.outcome?.outcome === "cancelled")).toBe(true);
    expect(method("session/prompt").map(({ frame }) => frame.params.prompt[0].text)).toEqual(["  Typed text\n", "second chat", "manual steer", "cancel this"]);
    expect(method("initialize").every(({ frame }) => frame.params.clientInfo.name === "CUELO" && frame.params.clientInfo.version === version)).toBe(true);
    expect(method("session/new").every(({ frame }) => JSON.stringify(frame.params) === JSON.stringify({ cwd, mcpServers: [] }))).toBe(true);
    expect(wire().filter((row) => row.argv).every((row) => JSON.stringify(row.argv) === '["acp"]' && !forbiddenEnv.some((key) => row.env.includes(key)))).toBe(true);
  } finally { await Promise.all([stream.close(), otherStream.close()]); }
});

test("a crashed ACP child closes SSE and a fresh worker replays the same conversation", async () => {
  const response = await open(req("", { cwd, sessionId: "past-1" }));
  expect(response.status).toBe(200);
  const stream = await observe("past-1");
  try {
    await stream.until((e) => e.snapshot);
    expect((await send(req("/send", submit("crash fixture"), "past-1"))).status).toBe(202);
    const closed = await stream.until((e) => e.state?.closed);
    expect(closed.state.problem.code).toBe("disconnected");
    expect((await events(req("/events", undefined, "past-1"))).status).toBe(409);
  } finally { await stream.close(); }
  const reopened = await open(req("", { cwd, sessionId: "past-1" }));
  expect(reopened.status).toBe(200);
  expect(method("session/load").filter(({ frame }) => frame.params.sessionId === "past-1")).toHaveLength(2);
});

test.each(["config", "prompt"])("Retry reconnects after active-session auth required during %s", async (operation) => {
  const response = await open(req("", { cwd }));
  expect(response.status).toBe(200);
  const { session: { sessionId } } = await response.json();
  const pid = wire().findLast(({ savedSession }) => savedSession === sessionId).pid;
  const updateModel = () => control(req("/control", { action: "option", id: "model", value: "gemini-3-flash" }, sessionId));
  const marker = join(cwd, "fixture-auth-required");
  const stream = await observe(sessionId);
  try {
    if (operation === "prompt") expect((await updateModel()).status).toBe(200);
    writeFileSync(marker, "");
    if (operation === "config") {
      const denied = await updateModel();
      expect(denied.status).toBe(401);
      expect((await denied.json()).code).toBe("auth_required");
    } else {
      expect((await send(req("/send", submit("Requires sign-in."), sessionId))).status).toBe(202);
    }
    const { state } = await stream.until((event) => event.state?.problem?.code === "auth_required");
    expect(state.closed).toBe(true);
    expect(state.problem).toEqual({ code: "auth_required", error: "Authentication required", command: `${fixture} acp --login` });
    rmSync(marker);
    const before = method("session/prompt").length;
    const reopened = await open(req("", { cwd, sessionId }));
    expect(reopened.status).toBe(200);
    expect((await reopened.json()).session.sessionId).toBe(sessionId);
    const reload = method("session/load").findLast(({ frame }) => frame.params.sessionId === sessionId);
    expect(reload?.pid).toBeDefined();
    expect(reload.pid).not.toBe(pid);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(method("session/prompt")).toHaveLength(before);
    expect(method("authenticate")).toHaveLength(0);
    const resumed = await observe(sessionId);
    try {
      const { snapshot } = await resumed.until((event) => event.snapshot);
      expect(snapshot.problem).toBeNull();
      expect(snapshot.streaming).toBe(false);
      expect((await updateModel()).status).toBe(200);
    } finally { await resumed.close(); }
  } finally {
    rmSync(marker, { force: true });
    await stream.close();
  }
});

test("list is project-scoped, load replays history, and auth does not call authenticate", async () => {
  const first = await list(req(""));
  expect(first.status).toBe(200);
  const body = await first.json();
  expect(body.sessions.some(({ sessionId }) => sessionId === "past-1")).toBe(true);
  expect(body.sessions.some(({ sessionId }) => sessionId === "cross-project")).toBe(false);
  expect(body.nextCursor).toBe("second-page");
  const loaded = await open(req("", { cwd, sessionId: "past-2" }));
  expect(loaded.status).toBe(200);
  const stream = await observe("past-2");
  try {
    const { snapshot } = await stream.until((e) => e.snapshot);
    expect(snapshot.entries.map(({ type, content }) => [type, content[0].text])).toEqual([["user", "Earlier prompt"], ["assistant", "Replayed answer"]]);
  } finally { await stream.close(); }
  expect((await open(req("", { cwd, sessionId: "cross-project" }))).status).toBe(400);
  const saved = await open(req("", { cwd, sessionId: "past-1" }));
  expect(saved.status).toBe(200);
  expect((await saved.json()).session.cwd).toBe(cwd);
  writeFileSync(join(cwd, "fixture-auth-required"), "");
  const auth = await open(req("", { cwd }));
  expect(auth.status).toBe(401);
  expect(await auth.json()).toEqual({ code: "auth_required", error: "Authentication required", command: `${fixture} acp --login` });
  process.env.CUELO_AGY_BIN = join(cwd, "not-a-binary");
  try {
    const missing = antigravityErrorResponse(new AntigravityError("auth_required", "Authentication required"));
    expect(missing.status).toBe(401);
    expect((await missing.json()).command).toBe("agy acp --login");
  } finally {
    process.env.CUELO_AGY_BIN = fixture;
  }
  expect(method("authenticate")).toHaveLength(0);
  await drainAntigravity();
  expect((await events(req("/events", undefined, "past-2"))).status).toBe(409);
});
