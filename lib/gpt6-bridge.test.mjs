import assert from "node:assert/strict";
import test from "node:test";

// 브리지는 파일·세션·시각·난수를 전부 deps로 받으므로 여기서는 그 네 가지만 가짜로
// 세운다. 검증 대상은 계약 동작(발급/폐기/보존/저장소 충돌/토큰/게시)이고, 배관은 검증하지
// 않는다 — 스키마 기본값 복사나 "함수가 함수를 부른다" 같은 확인은 넣지 않는다.
async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./gpt6-bridge.ts");
  } catch {
    return import("./gpt6-bridge.ts");
  }
}

const {
  createGpt6Bridge,
  GPT6_HANDLE_RETENTION_MS,
  GPT6_REPLY_CUSTOM_TYPE,
  GPT6_REPLY_SOURCE,
} = await loadSubject();

const CWD = "E:/Projects/Tools";
const SESSION_ID = "0f3d2c1b-session";
const CLOCK_START = Date.parse("2026-09-17T00:00:00.000Z");

function makeHarness(options = {}) {
  const state = {
    // 런타임 레지스트리 등록 여부와 생존. WEB에서 탭을 닫으면 둘 다 꺼지고 기록만 남는다.
    registered: true,
    alive: true,
    running: false,
    // 세션 기록(JSONL)의 존재. 발급만 하고 한 번도 쓰지 않은 세션은 기록도 없다.
    recordExists: options.recordExists ?? true,
    resumes: [],
    entries: [],
  };
  let storeText = null;
  let clockMs = CLOCK_START;
  let digits = 1000;
  let keySeq = 0;
  let tokenSeq = 0;
  let token = null;
  const pendingDigits = [...(options.pendingDigits ?? [])];
  const readHooks = [];

  const session = {
    get cwd() {
      return CWD;
    },
    isAlive: () => state.alive,
    isRunning: () => state.running,
    appendCustomMessage: (customType, content, display, details) => {
      const id = `c${state.entries.length}`;
      state.entries.push({ type: "custom_message", id, customType, content, display, details });
      return id;
    },
  };

  const bridge = createGpt6Bridge({
    readStore: () => {
      if (storeText !== null) {
        // "다른 프로세스가 두 읽기 사이에 썼다": 조건이 맞은 다음 읽기에서 파일 내용을
        // 바꾸고 revision을 올린다. 조건이 맞은 그 읽기는 아직 옛 내용을 본다.
        const fired = readHooks.find((hook) => hook.armed);
        if (fired) {
          readHooks.splice(readHooks.indexOf(fired), 1);
          const snapshot = JSON.parse(storeText);
          fired.apply(snapshot);
          snapshot.revision += 1;
          storeText = JSON.stringify(snapshot);
        } else {
          const snapshot = JSON.parse(storeText);
          for (const hook of readHooks) {
            if (!hook.armed && hook.when(snapshot)) hook.armed = true;
          }
        }
      }
      return storeText;
    },
    writeStore: (contents) => {
      storeText = contents;
    },
    now: () => new Date(clockMs),
    // 전역 토큰과 핸들 키는 발급마다 달라져야 회전을 구분할 수 있다.
    randomToken: () => `token-${++tokenSeq}`,
    randomHandleKey: () => `handle-key-${++keySeq}`,
    randomHandleDigits: () => pendingDigits.shift() ?? String(digits++).padStart(4, "0"),
    getSession: (sessionId) => (sessionId === SESSION_ID && state.registered ? session : undefined),
    // 되살리기는 세션 기록에서 온다: 기록이 있으면 같은 세션이 다시 등록되고 살아난다,
    // 없으면 undefined다. 브리지가 이 dep을 부르는 시점은 세션이 살아 있지 않을 때뿐이다.
    resumeSession: async (sessionId) => {
      state.resumes.push(sessionId);
      if (sessionId !== SESSION_ID || !state.recordExists) return undefined;
      state.registered = true;
      state.alive = true;
      return session;
    },
  });

  return {
    bridge,
    state,
    issue: (overrides = {}) => {
      const issued = bridge.issueHandle({ cwd: CWD, sessionId: SESSION_ID, ...overrides });
      if (issued.token !== null) token = issued.token;
      return issued;
    },
    rotate: (currentToken = token) => {
      const rotated = bridge.rotateToken(currentToken ?? "");
      token = rotated.token;
      return rotated;
    },
    store: () => (storeText === null ? null : JSON.parse(storeText)),
    token: () => token,
    advance: (ms) => {
      clockMs += ms;
    },
    armConcurrentWrite: (when, apply) => readHooks.push({ when, apply, armed: false }),
  };
}

test("핸들 없는 게시도 같은 배선으로 답변 entry 하나를 남기고 모델을 실행하지 않는다", async () => {
  const harness = makeHarness();
  // 턴이 돌고 있어도 기록은 실행과 경합하지 않는다.
  harness.state.running = true;

  const published = await harness.bridge.publishReply({
    sessionId: SESSION_ID,
    text: "핸들 없이 올린 상담 답변입니다.",
  });

  assert.equal(published.published, true);
  assert.equal(published.busy, true, "실행 중이라는 사실은 숨기지 않는다");

  const entries = harness.state.entries.filter((item) => item.type === "custom_message");
  assert.equal(entries.length, 1, "한 번의 호출은 entry 하나를 남긴다");
  const [entry] = entries;
  assert.equal(entry.id, published.entryId);
  assert.equal(entry.customType, GPT6_REPLY_CUSTOM_TYPE);
  assert.equal(entry.content, "핸들 없이 올린 상담 답변입니다.");
  assert.equal(entry.display, true, "화면에 보이지 않으면 기록의 목적이 사라진다");
  assert.deepEqual(entry.details, { source: GPT6_REPLY_SOURCE, model: GPT6_REPLY_SOURCE });
});

test("핸들 없는 게시는 모델 라벨을 details에 남기고, 없으면 6PRO 출처로 채운다", async () => {
  const harness = makeHarness();

  await harness.bridge.publishReply({ sessionId: SESSION_ID, text: "답변", model: "gpt-6-pro" });
  assert.equal(harness.state.entries.at(-1).details.model, "gpt-6-pro");

  await harness.bridge.publishReply({ sessionId: SESSION_ID, text: "답변", model: "   " });
  assert.equal(harness.state.entries.at(-1).details.model, GPT6_REPLY_SOURCE, "빈 라벨은 없는 것으로 본다");
});

test("핸들 없는 게시는 세션이 이 프로세스에 없어도 기록에서 되살려 남긴다", async () => {
  const harness = makeHarness();
  harness.state.registered = false;
  harness.state.alive = false;

  const published = await harness.bridge.publishReply({ sessionId: SESSION_ID, text: "되살려 남긴 답변" });

  assert.deepEqual(harness.state.resumes, [SESSION_ID], "살아 있지 않으면 기록에서 되살린다");
  assert.equal(published.entryId, harness.state.entries.at(-1).id);
});

test("핸들 없는 게시는 모르는 세션을 session_not_found로 끊고, 잘못된 인자는 거부한다", async () => {
  const missing = makeHarness();
  missing.state.registered = false;
  missing.state.alive = false;
  missing.state.recordExists = false;
  await assert.rejects(
    missing.bridge.publishReply({ sessionId: SESSION_ID, text: "답변" }),
    (error) => error.code === "session_not_found",
    "기록이 없으면 404로 끊을 수 있는 코드여야 한다",
  );

  const harness = makeHarness();
  await assert.rejects(
    harness.bridge.publishReply({ text: "답변" }),
    (error) => error.code === "invalid_argument",
    "sessionId 없는 호출은 400이다",
  );
  await assert.rejects(
    harness.bridge.publishReply({ sessionId: SESSION_ID, text: "   " }),
    (error) => error.code === "invalid_argument",
    "빈 본문은 400이다",
  );
  assert.equal(harness.state.entries.length, 0, "잘못된 인자는 세션을 건드리지 않는다");
  assert.deepEqual(harness.state.resumes, [], "인자 검증이 세션 해소보다 먼저다");
});

test("저장소 revision이 어긋나면 다시 읽어 병합하고, 동시 기록이 유실되지 않는다", () => {
  const harness = makeHarness();
  const first = harness.issue();

  // 두 번째 발급이 저장소를 읽은 뒤 쓰기 직전에 다른 프로세스가 자기 연결번호를 추가했다.
  // 두 번째 발급의 쓰기가 그것을 지워서는 안 된다.
  harness.armConcurrentWrite(
    (store) => store.handles[first.handle] !== undefined && store.handles["H-7777"] === undefined,
    (store) => {
      store.handles["H-7777"] = {
        handle: "H-7777",
        cwd: CWD,
        sessionId: SESSION_ID,
        instruction: "다른 호출",
        createdAt: new Date(CLOCK_START).toISOString(),
        expiresAt: new Date(CLOCK_START + 60_000).toISOString(),
        revokedAt: null,
        handleKeyHash: "b".repeat(64),
      };
    },
  );

  const second = harness.issue();

  const store = harness.store();
  assert.equal(store.handles["H-7777"]?.instruction, "다른 호출", "동시에 기록된 연결번호가 남아 있어야 한다");
  assert.notEqual(store.handles[first.handle], undefined);
  assert.notEqual(store.handles[second.handle], undefined, "재시도한 발급도 기록돼야 한다");
  assert.equal(store.revision, 3, "첫 발급 1 + 동시 쓰기 1 + 재시도 쓰기 1");
});

test("같은 4자리 번호가 다시 나와도 기존 연결번호를 덮어쓰지 않는다", async () => {
  const harness = makeHarness({ pendingDigits: ["1234", "1234", "5678"] });
  const first = harness.issue();
  const second = harness.issue();

  assert.equal(first.handle, "H-1234");
  assert.equal(second.handle, "H-5678");
  const handles = harness.bridge.listHandles().handles;
  assert.equal(handles.length, 2, "두 연결번호가 서로 다른 기록으로 남아야 한다");
  assert.equal(harness.store().handles["H-1234"].instruction, "");
});

test("토큰 평문은 최초 발급과 회전에서만 나가고, 회전하면 이전 토큰은 즉시 거부된다", () => {
  const harness = makeHarness();
  const issued = harness.issue({ web6RequestId: "web6-1234" });
  const previous = harness.token();
  assert.notEqual(previous, null, "저장소에 토큰이 없으면 첫 발급이 만든다");
  assert.equal(harness.bridge.acceptsToken(previous), true);
  assert.equal(harness.bridge.acceptsToken("wrong-token"), false);
  assert.equal(harness.bridge.acceptsToken(""), false, "빈 토큰은 어떤 저장소에도 통하지 않는다");
  const stored = JSON.stringify(harness.store());
  assert.equal(stored.includes(previous), false, "토큰은 저장소에 평문으로 남지 않는다");
  assert.equal(stored.includes(issued.handleKey), false, "핸들 키도 저장소에 평문으로 남지 않는다");
  assert.equal(harness.store().handles[issued.handle].web6RequestId, "web6-1234");

  const rotated = harness.rotate(previous);
  assert.notEqual(rotated.token, previous);
  assert.equal(harness.bridge.acceptsToken(previous), false, "이전 토큰은 즉시 거부된다");
  assert.equal(harness.bridge.acceptsToken(rotated.token), true);
  assert.equal(JSON.stringify(harness.store()).includes(rotated.token), false);
  assert.equal(harness.bridge.listHandles().handles[0].status, "active", "연결번호는 회전으로 죽지 않는다");

  // 다음 발급은 토큰을 다시 실어 보내지 않는다.
  const second = harness.issue();
  assert.equal(second.token, null);
  assert.match(harness.store().tokenHash, /^[0-9a-f]{64}$/);

  // 현재 토큰을 제시하지 못하면 회전 자체가 거부된다 — 아무나 새 토큰을 받아 갈 수 없다.
  assert.throws(() => harness.bridge.rotateToken("guessed-token"), { code: "invalid_token" });
  assert.equal(harness.bridge.acceptsToken(rotated.token), true, "실패한 회전은 기존 토큰을 건드리지 않는다");
});

test("수명이 끝난 연결번호는 보존 기간이 지나면 목록과 저장소에서 함께 사라진다", () => {
  const harness = makeHarness();
  const revoked = harness.issue();
  harness.bridge.revokeHandle(revoked.handle);
  const survivor = harness.issue();
  assert.equal(harness.bridge.listHandles().handles.length, 2);

  // 보존 기간 안에는 폐기된 연결번호도 남는다 — 왜 배지가 꺼졌는지 목록에서 읽을 수 있어야 한다.
  harness.advance(GPT6_HANDLE_RETENTION_MS - 60_000);
  assert.equal(harness.bridge.listHandles().handles.length, 2);

  harness.advance(120_000);
  assert.deepEqual(
    harness.bridge.listHandles().handles.map((entry) => entry.handle),
    [survivor.handle],
    "보존 기간이 지난 기록은 목록에 나오지 않는다",
  );

  // 저장소 정리는 다음 쓰기에서 일어난다.
  const fresh = harness.issue();
  const stored = Object.keys(harness.store().handles).sort();
  assert.deepEqual(stored, [fresh.handle, survivor.handle].sort());
  assert.throws(
    () => harness.bridge.revokeHandle(revoked.handle),
    { code: "unknown_handle" },
    "기록이 사라진 연결번호는 다시 다룰 수 없다",
  );
});
