// btw-server.js 사이드카(SIDE CHAT)의 장문 답변 계약 테스트(이슈 #16 재발 방지).
// 실제 omp SDK로 사이드카를 띄우고, 임시 models.yml에 등록한 로컬 OpenAI 호환 서버가
// 4 KiB를 넘는 답을 스트리밍한다. 응답은 SideChatPanel과 같은 클라이언트·기록 저장소로
// 받아 done 이벤트와 저장 기록까지 확인한다. 홈·agent dir·포트는 모두 임시로 분리한다.
// 실행: bun test Tools/CUELO_Setup/files/btw-server.test.mjs (저장소 루트, bun install 후)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const { createHanseSideChatClient, createSideChatHistoryStore } = await import("../../../lib/hanse-sidechat-client.ts");

const SERVER = join(import.meta.dirname, "btw-server.js");
const CUELO_DIR = resolve(import.meta.dirname, "..", "..", "..");
const SESSION_ID = "0199a000-1111-4222-8333-444444444444";
const PROVIDER = "fixture";
const MODEL_ID = "long-answer";

// 줄마다 번호가 달라 반복 줄 정리(dedupe)에 걸리지 않는 약 12 KiB 답.
const LONG_ANSWER = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")} 사이드챗 장문 답변 줄입니다.`).join("\n");

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

// OpenAI chat completions 스트림을 흉내낸다. 답을 여러 조각으로 나눠 보낸다.
async function startFakeModel(t) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunk = (delta, finish = null) => JSON.stringify({
        id: "chatcmpl-fixture",
        object: "chat.completion.chunk",
        created: 0,
        model: MODEL_ID,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      res.write(`data: ${chunk({ role: "assistant", content: "" })}\n\n`);
      for (let i = 0; i < LONG_ANSWER.length; i += 1000) {
        res.write(`data: ${chunk({ content: LONG_ANSWER.slice(i, i + 1000) })}\n\n`);
      }
      res.write(`data: ${chunk({}, "stop")}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  return server.address().port;
}

function makeHome(modelPort) {
  const home = mkdtempSync(join(tmpdir(), "omp-btw-test-"));
  const agentDir = join(home, ".omp", "agent");
  const sessionDir = join(agentDir, "sessions", "fixture");
  const cwd = join(home, "work");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "models.yml"), [
    "providers:",
    `  ${PROVIDER}:`,
    `    baseUrl: http://127.0.0.1:${modelPort}/v1`,
    "    api: openai-completions",
    "    apiKey: fixture-key",
    "    models:",
    `      - id: ${MODEL_ID}`,
    "        name: Long Answer",
    "        reasoning: false",
    "        input: [text]",
    "        contextWindow: 128000",
    "        maxTokens: 32000",
    "",
  ].join("\n"));
  writeFileSync(join(agentDir, "config.yml"), `modelRoles:\n  default: ${PROVIDER}/${MODEL_ID}\n`);
  const sessionPath = join(sessionDir, `2026-10-05T00-00-00-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(sessionPath, [
    { type: "session", version: 3, id: SESSION_ID, timestamp: "2026-10-05T00:00:00.000Z", cwd },
    { type: "model_change", id: "a0000001", parentId: null, model: `${PROVIDER}/${MODEL_ID}`, role: "default", timestamp: "2026-10-05T00:00:00.100Z" },
    { type: "message", id: "a0000002", parentId: "a0000001", timestamp: "2026-10-05T00:00:01.000Z", message: { role: "user", content: "안녕", timestamp: 1 } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { home, agentDir, sessionPath };
}

async function startSidecar(t, { home, agentDir }) {
  const port = await freePort();
  // 메인 서버 조회(syncModelFromMain)는 아무도 듣지 않는 포트로 보내 바로 실패시킨다.
  const deadMainPort = await freePort();
  const server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir,
      CUELO_DIR,
      OMP_BTW_PORT: String(port),
      PORT: String(deadMainPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (data) => { stderr += data; });
  let exited = false;
  const exitPromise = new Promise((resolveExit) => server.once("exit", () => { exited = true; resolveExit(); }));
  // 사이드카가 임시 홈의 agent.db를 잡고 있으므로 종료를 기다린 뒤 지운다(Windows EBUSY).
  t.after(async () => {
    if (!exited) server.kill();
    await exitPromise;
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  for (let i = 0; i < 300; i += 1) {
    if (exited) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return port;
    } catch { /* 아직 안 떴다 */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`btw sidecar did not start on port ${port}\n${stderr}`);
}

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

test("4 KiB를 넘는 사이드챗 답이 스트림·done·저장 기록에서 잘리지 않는다", { timeout: 120_000 }, async (t) => {
  const modelPort = await startFakeModel(t);
  const fixture = makeHome(modelPort);
  const port = await startSidecar(t, fixture);
  assert.ok(Buffer.byteLength(LONG_ANSWER) > 4096 * 2);

  const events = [];
  const client = createHanseSideChatClient(undefined, `http://127.0.0.1:${port}/ask`);
  const result = await client.ask({
    sessionPath: fixture.sessionPath,
    question: "길게 답해줘",
    history: [],
    onEvent: (event) => events.push(event),
  });

  const streamed = events.filter((event) => event.t === "d").map((event) => event.v).join("");
  const done = events.filter((event) => event.t === "done");
  assert.equal(streamed, LONG_ANSWER);
  assert.equal(done.length, 1);
  assert.equal(done[0].v, LONG_ANSWER);
  assert.equal(result.text, LONG_ANSWER);

  // 패널은 완료 결과를 이 저장소에 남기고, 다시 열 때 같은 storage에서 읽는다.
  const storage = memoryStorage();
  createSideChatHistoryStore(storage).append(SESSION_ID, { q: "길게 답해줘", a: result.text, at: Date.now() });
  const reopened = createSideChatHistoryStore(storage).read(SESSION_ID);
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].a, LONG_ANSWER);
});
