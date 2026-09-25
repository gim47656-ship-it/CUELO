import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail, DELETE: deleteSession } = await jiti.import("./[id]/route.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");
const { POST: sendAgentCommand } = await jiti.import("../agent/[id]/route.ts");
const { cacheSessionPath } = await jiti.import("../../../lib/session-reader.ts");
const {
  AgentSessionWrapper,
  beginGuardedSessionDeletion,
  startRpcSession,
} = await jiti.import("../../../lib/rpc-manager.ts");

// 실제 래퍼로 예약·거부 경로를 그대로 태운다. 흉내 낸 래퍼로는 라우트가
// 무엇을 물어보는지만 보이고, 삭제와 새 명령의 실제 순서는 보이지 않는다.
function createTestWrapper({ dir, id, filePath, prompts, onShutdownEmit }) {
  const inner = {
    sessionId: id,
    sessionFile: filePath,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    sessionManager: { getCwd: () => dir, getEntries: () => [] },
    agent: { state: {} },
    prompt: async (message) => {
      prompts.push(message);
    },
    ...(onShutdownEmit ? { extensionRunner: { emit: onShutdownEmit } } : {}),
  };
  return { inner, wrapper: new AgentSessionWrapper(inner, { on: () => () => {} }) };
}

function promptRequest(id) {
  return new Request(`http://localhost/api/agent/${id}`, {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ type: "prompt", message: "during delete" }),
  });
}

test("session listing merges live registry snapshots and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(listRoute, /listAllSessions\(\{ force \}\)/);
  assert.match(listRoute, /attachSessionProjectInfo\(getRpcSessionInfos\(\)\)/);
  assert.match(listRoute, /mergeSessionLists\(persistedSessions, runtimeSessions\)/);
  assert.match(listRoute, /"Cache-Control": "no-store"/);
});

test("session reads use the live SessionManager before requiring a JSONL path", () => {
  for (const source of [detailRoute, contextRoute]) {
    const liveLookup = source.indexOf("getRpcSession(id)");
    const pathLookup = source.indexOf("resolveSessionPath(id)");
    assert.ok(liveLookup >= 0);
    assert.ok(pathLookup > liveLookup);
    assert.match(source, /liveRpc\?\.inner\.sessionManager \?\? (?:await )?SessionManager\.open/);
  }
});

test("live agent state is available before the session file is persisted", () => {
  const liveLookup = stateRoute.indexOf("getRpcSession(id)");
  const pathLookup = stateRoute.indexOf("resolveSessionPath(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(stateRoute, /if \(rpc\?\.isAlive\(\)\)/);
});

test("live detail and state routes work without a persisted JSONL file", async (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const id = "live-route-test";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello live" },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry],
    getLeafId: () => entry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`,
  };
  globalThis.__ompSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
    send: async () => ({ isStreaming: true }),
  }]]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const detailResponse = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`, { headers: { host: "localhost" } }),
    routeContext,
  );
  const stateResponse = await getSessionState(
    new Request(`http://localhost/api/sessions/${id}/state`, { headers: { host: "localhost" } }),
    routeContext,
  );
  const detail = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.info.transient, true);
  assert.deepEqual(detail.context.messages.map((message) => message.content), ["hello live"]);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    running: true,
    state: { isStreaming: true },
  });
});

test("bulk clear cannot delete a session that starts running after the client check", async (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const id = "bulk-clear-running";
  const dir = await mkdtemp(join(tmpdir(), "omp-bulk-clear-"));
  const filePath = join(dir, `${id}.jsonl`);
  await writeFile(
    filePath,
    `${JSON.stringify({ type: "session", id, cwd: dir, timestamp: "2026-09-12T00:00:00.000Z" })}\n`,
    "utf8",
  );
  cacheSessionPath(id, filePath);
  const prompts = [];
  const { inner, wrapper } = createTestWrapper({ dir, id, filePath, prompts });
  inner.isStreaming = true;
  globalThis.__ompSessions = new Map([[id, wrapper]]);
  t.after(async () => {
    globalThis.__ompSessions = previousRegistry;
    await rm(dir, { recursive: true, force: true });
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const guarded = await deleteSession(
    new Request(`http://localhost/api/sessions/${id}?skipRunning=1`, { method: "DELETE", headers: { host: "localhost" } }),
    routeContext,
  );
  assert.equal(guarded.status, 409);
  assert.equal(existsSync(filePath), true);

  // 예약이 서지 않았으므로 실행 중이던 세션은 계속 명령을 받는다.
  const promptSettled = new Promise((resolve) => {
    const off = wrapper.onEvent((event) => {
      if (event.type !== "prompt_done") return;
      off();
      resolve();
    });
  });
  const stillUsable = await sendAgentCommand(promptRequest(id), { params: Promise.resolve({ id }) });
  assert.equal(stillUsable.status, 200);
  await promptSettled;
  assert.deepEqual(prompts, ["during delete"]);

  inner.isStreaming = false;
  const cleared = await deleteSession(
    new Request(`http://localhost/api/sessions/${id}?skipRunning=1`, { method: "DELETE", headers: { host: "localhost" } }),
    routeContext,
  );
  assert.equal(cleared.status, 200);
  assert.equal(existsSync(filePath), false);
});

test("a prompt that arrives while the delete is shutting the session down is rejected", async (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const id = "delete-race-prompt";
  const dir = await mkdtemp(join(tmpdir(), "omp-delete-race-"));
  const filePath = join(dir, `${id}.jsonl`);
  await writeFile(
    filePath,
    `${JSON.stringify({ type: "session", id, cwd: dir, timestamp: "2026-09-12T00:00:00.000Z" })}\n`,
    "utf8",
  );
  cacheSessionPath(id, filePath);

  const prompts = [];
  // 종료를 이 지점에서 멈춰 세워, 삭제가 끝나기 전에 새 명령이 도착하는
  // 실제 창(window)을 그대로 만든다.
  let releaseShutdown = () => {};
  let signalShutdownReached = () => {};
  const shutdownReached = new Promise((resolve) => {
    signalShutdownReached = resolve;
  });
  const { wrapper } = createTestWrapper({
    dir,
    id,
    filePath,
    prompts,
    onShutdownEmit: () => new Promise((release) => {
      releaseShutdown = release;
      signalShutdownReached();
    }),
  });
  globalThis.__ompSessions = new Map([[id, wrapper]]);
  t.after(async () => {
    globalThis.__ompSessions = previousRegistry;
    await rm(dir, { recursive: true, force: true });
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const deletion = deleteSession(
    new Request(`http://localhost/api/sessions/${id}?skipRunning=1`, { method: "DELETE", headers: { host: "localhost" } }),
    routeContext,
  );
  await shutdownReached;

  const rejected = await sendAgentCommand(promptRequest(id), { params: Promise.resolve({ id }) });
  const rejectedBody = await rejected.json();
  assert.equal(rejected.status, 500);
  assert.equal(rejectedBody.code, "prompt_rejected");
  assert.equal(rejectedBody.accepted, false);
  assert.match(rejectedBody.error, /closing/i);
  assert.deepEqual(prompts, []);

  releaseShutdown();
  const deleted = await deletion;
  assert.equal(deleted.status, 200);
  assert.equal(existsSync(filePath), false);
  assert.deepEqual(prompts, []);
});

test("a session under guarded deletion cannot be restarted from the agent path", async (t) => {
  const previousClosing = globalThis.__ompClosingSessionIds;
  const id = "guarded-restart";
  const deletion = beginGuardedSessionDeletion(id);
  t.after(() => {
    deletion.release();
    globalThis.__ompClosingSessionIds = previousClosing;
  });

  assert.equal(deletion.reserved, true);
  // 삭제 중인 id로 세션을 다시 띄우면 곧 지워질 파일 위에서 작업하게 된다.
  await assert.rejects(
    () => startRpcSession(id, "", "/tmp"),
    /Session is closing/,
  );

  deletion.release();
  assert.equal(globalThis.__ompClosingSessionIds.has(id), false);
});

test("a failure before shutdown releases the reservation and keeps the session usable", async (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const id = "delete-pre-shutdown-failure";
  const dir = await mkdtemp(join(tmpdir(), "omp-delete-fail-"));
  // 헤더 읽기(openSync/readSync)가 반드시 실패하도록 파일 자리에 디렉터리를 둔다.
  const filePath = join(dir, `${id}.jsonl`);
  await mkdir(filePath);
  cacheSessionPath(id, filePath);

  const prompts = [];
  const { wrapper } = createTestWrapper({ dir, id, filePath, prompts });
  globalThis.__ompSessions = new Map([[id, wrapper]]);
  t.after(async () => {
    globalThis.__ompSessions = previousRegistry;
    await rm(dir, { recursive: true, force: true });
  });

  const failed = await deleteSession(
    new Request(`http://localhost/api/sessions/${id}?skipRunning=1`, { method: "DELETE", headers: { host: "localhost" } }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(failed.status, 500);
  assert.equal(existsSync(filePath), true);
  assert.equal(globalThis.__ompClosingSessionIds?.has(id) ?? false, false);

  // 실패한 삭제가 세션을 잠가 두면 안 된다: 다음 명령은 그대로 받아들여진다.
  const promptSettled = new Promise((resolve) => {
    const off = wrapper.onEvent((event) => {
      if (event.type !== "prompt_done") return;
      off();
      resolve();
    });
  });
  const admitted = await sendAgentCommand(promptRequest(id), { params: Promise.resolve({ id }) });
  assert.equal(admitted.status, 200);
  await promptSettled;
  assert.deepEqual(prompts, ["during delete"]);
});

test("a second delete of the same session is refused while the first still holds it", async (t) => {
  const previousRegistry = globalThis.__ompSessions;
  const id = "delete-double";
  const dir = await mkdtemp(join(tmpdir(), "omp-delete-double-"));
  const filePath = join(dir, `${id}.jsonl`);
  await writeFile(
    filePath,
    `${JSON.stringify({ type: "session", id, cwd: dir, timestamp: "2026-09-12T00:00:00.000Z" })}\n`,
    "utf8",
  );
  cacheSessionPath(id, filePath);

  const prompts = [];
  let releaseShutdown = () => {};
  let signalShutdownReached = () => {};
  const shutdownReached = new Promise((resolve) => {
    signalShutdownReached = resolve;
  });
  const { wrapper } = createTestWrapper({
    dir,
    id,
    filePath,
    prompts,
    onShutdownEmit: () => new Promise((release) => {
      releaseShutdown = release;
      signalShutdownReached();
    }),
  });
  globalThis.__ompSessions = new Map([[id, wrapper]]);
  t.after(async () => {
    globalThis.__ompSessions = previousRegistry;
    await rm(dir, { recursive: true, force: true });
  });

  const deleteRequest = () => new Request(
    `http://localhost/api/sessions/${id}?skipRunning=1`,
    { method: "DELETE", headers: { host: "localhost" } },
  );
  const first = deleteSession(deleteRequest(), { params: Promise.resolve({ id }) });
  await shutdownReached;

  // 두 번째 삭제가 예약을 함께 잡으면, 먼저 끝난 쪽의 release가 아직 지우는
  // 중인 쪽의 보호를 걷어낸다. 그래서 두 번째는 아예 시작하지 못해야 한다.
  const second = await deleteSession(deleteRequest(), { params: Promise.resolve({ id }) });
  assert.equal(second.status, 409);
  assert.equal(existsSync(filePath), true);

  // 거부된 삭제는 첫 번째의 보호를 건드리지 않는다.
  const stillRejected = await sendAgentCommand(promptRequest(id), { params: Promise.resolve({ id }) });
  assert.equal(stillRejected.status, 500);
  assert.deepEqual(prompts, []);
  await assert.rejects(() => startRpcSession(id, "", dir), /Session is closing/);

  releaseShutdown();
  const deleted = await first;
  assert.equal(deleted.status, 200);
  assert.equal(existsSync(filePath), false);
  assert.equal(globalThis.__ompClosingSessionIds?.has(id) ?? false, false);
});
