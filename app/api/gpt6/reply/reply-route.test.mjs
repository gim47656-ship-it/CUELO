import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// 이 라우트는 `/api/gpt6/mcp`와 같은 배선(runtime → rpc-manager → SDK)을 쓴다. 그 SDK는
// `Bun`을 요구하므로 이 파일은 저장소의 다른 SDK 의존 테스트와 같은 러너로 돈다 —
// `node --test`에서는 형제 `handles-route.test.mjs`와 같이 import 단계에서 죽는다.
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const AGENT_DIR = mkdtempSync(join(tmpdir(), "omp-gpt6-reply-"));
process.on("exit", () => rmSync(AGENT_DIR, { recursive: true, force: true }));

const { POST } = await jiti.import("./route.ts");
const { buildSessionContext, getAgentDir } = await jiti.import("../../../../lib/session-reader.ts");
const { AgentSessionWrapper } = await jiti.import("../../../../lib/rpc-manager.ts");
const { setAgentDir } = await jiti.import("@oh-my-pi/pi-utils");
const { createGpt6Bridge, GPT6_REPLY_CUSTOM_TYPE, GPT6_REPLY_SOURCE } =
  await jiti.import("../../../../lib/gpt6-bridge.ts");

const CWD = "E:/Projects/Tools";
const SESSION_ID = "6f2a1c0e-reply-route";
const TEXT = "핸들 없이 올린 상담 답변입니다.";

/**
 * 핸들 저장소는 agent 디렉터리 아래 하나뿐이라, 이 테스트들은 임시 디렉터리에서만 돈다 —
 * 실제 `~/.omp/agent/gpt6-handles.json`을 읽지도 쓰지도 않는다. 끝나면 원래 디렉터리로
 * 되돌려 같은 프로세스에서 이어 도는 다른 테스트 파일을 건드리지 않는다. `setAgentDir`는
 * 그 디렉터리를 바꾸는 SDK의 공개 통로다(환경변수만으로는, 먼저 돈 다른 테스트가 이미
 * 디렉터리를 고정했을 때 닿지 못한다).
 */
async function withTempAgentDir(run) {
  const previous = getAgentDir();
  setAgentDir(AGENT_DIR);
  try {
    assert.equal(
      resolve(getAgentDir()),
      resolve(AGENT_DIR),
      "임시 agent 디렉터리로 격리되지 않았다 — 실제 핸들 저장소를 건드릴 수 있으므로 여기서 멈춘다",
    );
    return await run();
  } finally {
    // 이 파일이 넣은 가짜 세션을 남기지 않는다 — 같은 프로세스에서 이어 도는 테스트가
    // 레지스트리를 통해 그 세션을 보게 두면 안 된다.
    globalThis.__ompSessions = new Map();
    setAgentDir(previous);
  }
}

// 라우트는 `getGpt6Bridge()`로 자기 저장소를 읽는다. 발급을 실제 브리지로 한 번 돌려
// 평문 토큰을 받아 두면, 라우트가 보는 토큰 해시가 같은 파일에 남는다.
const STORE_PATH = join(AGENT_DIR, "gpt6-handles.json");
const setupBridge = createGpt6Bridge({
  readStore: () => (existsSync(STORE_PATH) ? readFileSync(STORE_PATH, "utf8") : null),
  writeStore: (contents) => writeFileSync(STORE_PATH, contents),
  now: () => new Date(),
  randomToken: () => "reply-route-token",
  randomHandleKey: () => "reply-route-handle-key",
  randomHandleDigits: () => "1042",
  getSession: () => undefined,
  resumeSession: async () => undefined,
  wait: async () => {},
});
const TOKEN = setupBridge.issueHandle({ cwd: CWD, sessionId: SESSION_ID }).token;
assert.equal(typeof TOKEN, "string", "최초 발급은 평문 토큰을 돌려줘야 한다");

/**
 * 살아 있는 세션 하나를 흉내 낸다. 라우트는 `getRpcSession`(레지스트리) → 브리지의
 * `wrap` 순으로 읽으므로, `wrap`과 레지스트리 조회가 읽는 표면만 채우면 된다.
 * `appendCustomMessageEntry`는 SDK `SessionManager`처럼 id·parentId·시각을 붙여 entry를
 * 쌓는다 — 그 기록이 곧 `session-reader` 투영의 입력이다.
 */
function registerLiveSession(sessionId) {
  const entries = [];
  const inner = {
    sessionId,
    sessionFile: undefined,
    sessionManager: {
      getCwd: () => CWD,
      getHeader: () => undefined,
      getSessionFile: () => undefined,
      getSessionName: () => "",
      getEntries: () => entries,
      getLeafId: () => entries.at(-1)?.id ?? null,
      appendCustomMessageEntry: (customType, content, display, details) => {
        const id = `c${entries.length + 1}`;
        entries.push({
          type: "custom_message",
          id,
          parentId: entries.at(-1)?.id ?? null,
          timestamp: "2026-09-19T00:00:00.000Z",
          customType,
          content,
          display,
          details,
        });
        return id;
      },
    },
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    dispose: async () => {},
  };
  const events = [];
  const wrapper = new AgentSessionWrapper(inner, { on: () => () => {}, off() {}, emit() {} });
  wrapper.onEvent((event) => events.push(event));
  globalThis.__ompSessions = new Map([[sessionId, wrapper]]);
  return { entries, events };
}

/** `token`을 생략하면 유효 토큰, `null`이면 Authorization 헤더 없음. */
function replyRequest(body, token = TOKEN) {
  const headers = { host: "localhost", "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("http://localhost/api/gpt6/reply", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("POST /api/gpt6/reply는 entry 하나만 남기고 모델을 돌리지 않는다", async () => {
  await withTempAgentDir(async () => {
    const { entries, events } = registerLiveSession(SESSION_ID);

    const response = await POST(replyRequest({ sessionId: SESSION_ID, text: TEXT }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.published, true);
    assert.equal(payload.busy, false);
    assert.equal(payload.entryId, entries.at(-1).id, "응답의 entryId는 실제로 남은 entry를 가리킨다");

    assert.equal(entries.length, 1, "한 번의 호출은 entry 하나만 남긴다");
    const [entry] = entries;
    assert.equal(entry.customType, GPT6_REPLY_CUSTOM_TYPE);
    assert.equal(entry.content, TEXT);
    assert.equal(entry.display, true);
    assert.deepEqual(entry.details, { source: GPT6_REPLY_SOURCE, model: GPT6_REPLY_SOURCE });
    assert.equal(entries.some((item) => item.type === "message"), false, "모델 턴은 돌지 않는다");

    // 대화창 투영: 이 경로로 남긴 entry도 omp_publish_reply와 같은 얼굴(assistant + web6)로
    // 올라가야 한다 — SHION은 web6 예약 얼굴이다.
    assert.deepEqual(buildSessionContext(entries).messages.at(-1), {
      role: "assistant",
      content: [{ type: "text", text: TEXT }],
      model: GPT6_REPLY_SOURCE,
      provider: "web6",
      stopReason: "stop",
      timestamp: Date.parse("2026-09-19T00:00:00.000Z"),
    });

    assert.equal(events.length, 1, "저장 성공은 같은 세션 snapshot 이벤트 하나를 발행한다");
    assert.equal(events[0].type, "session_snapshot");
    assert.equal(events[0].sessionId, SESSION_ID);
    assert.equal(events[0].entryId, entry.id);
    assert.deepEqual(events[0].context.entryIds, [entry.id]);
    assert.deepEqual(events[0].context.messages, buildSessionContext(entries).messages);
  });
});

test("POST /api/gpt6/reply는 model 라벨을 entry details까지 그대로 넘긴다", async () => {
  await withTempAgentDir(async () => {
    const { entries } = registerLiveSession(SESSION_ID);

    const response = await POST(replyRequest({ sessionId: SESSION_ID, text: TEXT, model: "gpt-6-pro" }));

    assert.equal(response.status, 200);
    assert.equal(entries.at(-1).details.model, "gpt-6-pro", "라우트가 model을 삼키면 안 된다");
  });
});

test("POST /api/gpt6/reply는 토큰이 없거나 틀리면 401이다", async () => {
  await withTempAgentDir(async () => {
    const missing = await POST(replyRequest({ sessionId: SESSION_ID, text: TEXT }, null));
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: "Unauthorized", code: "invalid_token" });

    const wrong = await POST(replyRequest({ sessionId: SESSION_ID, text: TEXT }, "not-the-token"));
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: "Unauthorized", code: "invalid_token" });
  });
});

test("POST /api/gpt6/reply는 인자가 비면 400이다", async () => {
  await withTempAgentDir(async () => {
    const missingSession = await POST(replyRequest({ text: TEXT }));
    assert.equal(missingSession.status, 400);
    assert.equal((await missingSession.json()).code, "invalid_argument");

    const blankText = await POST(replyRequest({ sessionId: SESSION_ID, text: "   " }));
    assert.equal(blankText.status, 400);
    assert.equal((await blankText.json()).code, "invalid_argument");

    const brokenJson = await POST(new Request("http://localhost/api/gpt6/reply", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "{",
    }));
    assert.equal(brokenJson.status, 400);
    assert.equal((await brokenJson.json()).code, "invalid_argument");
  });
});

test("POST /api/gpt6/reply는 세션 기록이 없으면 404이다", async () => {
  await withTempAgentDir(async () => {
    const response = await POST(replyRequest({ sessionId: "no-such-session", text: TEXT }));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "session_not_found");
  });
});
