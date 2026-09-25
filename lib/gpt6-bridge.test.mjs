import assert from "node:assert/strict";
import test from "node:test";

// 브리지는 파일·세션·시각·난수를 전부 deps로 받으므로 여기서는 그 네 가지만 가짜로
// 세운다. 검증 대상은 계약 동작(만료/폐기/스냅샷/중복 전송/상한)이고, 배관은 검증하지
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
  GPT6_AUTH_FAILURE_WINDOW_MS,
  GPT6_DISPATCH_LABEL,
  GPT6_HANDLE_RETENTION_MS,
  GPT6_INJECTION_LABEL,
  GPT6_PROTOCOL_VERSION,
  GPT6_REPLY_CUSTOM_TYPE,
  GPT6_REPLY_SOURCE,
  GPT6_RPC_ERROR,
  GPT6_SERVER_NAME,
} = await loadSubject();

const CWD = "E:/Projects/Tools";
const SESSION_ID = "0f3d2c1b-session";
const CLOCK_START = Date.parse("2026-09-17T00:00:00.000Z");

function messageEntry(id, role, text) {
  return { type: "message", id, message: { role, content: [{ type: "text", text }] } };
}

/**
 * 사용량 한도·429로 끝난 턴. content는 비어 있고 사유는 이 필드들에만 남는다 —
 * 실제 세션 기록(`stopReason:"error"` + `errorMessage`)과 같은 모양이다.
 */
function failedEntry(id, { provider, model, message, status }) {
  return {
    type: "message",
    id,
    message: {
      role: "assistant",
      content: [],
      provider,
      model,
      stopReason: "error",
      errorMessage: message,
      ...(status === undefined ? {} : { errorStatus: status }),
    },
  };
}

function timelineEntries(count) {
  return Array.from({ length: count }, (_, index) => (
    messageEntry(`e${index}`, index % 2 === 0 ? "user" : "assistant", `text ${index}`)
  ));
}

function makeHarness(options = {}) {
  const state = {
    sessionCwd: options.sessionCwd ?? CWD,
    // 런타임 레지스트리 등록 여부와 생존. WEB에서 탭을 닫으면 둘 다 꺼지고 기록만 남는다.
    registered: true,
    alive: true,
    running: false,
    // 세션 기록(JSONL)의 존재. 발급만 하고 한 번도 쓰지 않은 세션은 기록도 없다.
    recordExists: options.recordExists ?? true,
    resumes: [],
    sends: [],
    entries: [...(options.entries ?? [])],
    getState: options.getState ?? {
      isStreaming: false,
      isPromptRunning: false,
      model: { id: "claude-sonnet-5", provider: "anthropic" },
      subagents: [],
    },
  };
  let storeText = null;
  let clockMs = CLOCK_START;
  let digits = 1000;
  let keySeq = 0;
  let tokenSeq = 0;
  let token = null;
  const handleKeys = new Map();
  const pendingDigits = [...(options.pendingDigits ?? [])];
  const readHooks = [];

  const session = {
    get cwd() {
      return state.sessionCwd;
    },
    isAlive: () => state.alive,
    isRunning: () => state.running,
    async send(command) {
      state.sends.push(command);
      if (command.type === "get_state") return state.getState;
      if (command.type === "prompt") {
        state.entries.push(
          messageEntry(`u${state.entries.length}`, "user", command.message),
        );
      }
      return null;
    },
    entries: () => state.entries,
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
    // 전역 토큰과 핸들 키는 발급마다 달라져야 회전·교차 사용을 구분할 수 있다.
    randomToken: () => `token-${++tokenSeq}`,
    randomHandleKey: () => `handle-key-${++keySeq}`,
    randomHandleDigits: () => pendingDigits.shift() ?? String(digits++).padStart(4, "0"),
    getSession: (sessionId) => (sessionId === SESSION_ID && state.registered ? session : undefined),
    // 되살리기는 세션 기록에서 온다: 기록이 있으면 같은 세션이 다시 등록되고 살아난다(그 cwd도
    // 그대로), 없으면 undefined다. 브리지가 이 dep을 부르는 시점은 세션이 살아 있지 않을 때뿐이다.
    resumeSession: async (sessionId) => {
      state.resumes.push(sessionId);
      if (sessionId !== SESSION_ID || !state.recordExists) return undefined;
      state.registered = true;
      state.alive = true;
      return session;
    },
    wait: async () => {},
  });

  const remember = (issued) => {
    if (issued.token !== null) token = issued.token;
    handleKeys.set(issued.handle, issued.handleKey);
    return issued;
  };

  return {
    bridge,
    state,
    issue: (overrides = {}) => remember(bridge.issueHandle({ cwd: CWD, sessionId: SESSION_ID, ...overrides })),
    rotate: (currentToken = token) => {
      const rotated = bridge.rotateToken(currentToken ?? "");
      token = rotated.token;
      return rotated;
    },
    store: () => (storeText === null ? null : JSON.parse(storeText)),
    token: () => token,
    /** 그 연결번호를 발급할 때 받은 평문 핸들 키. 모르는 연결번호면 빈 문자열. */
    keyOf: (handle) => handleKeys.get(handle) ?? "",
    prompts: () => state.sends.filter((command) => command.type === "prompt"),
    advance: (ms) => {
      clockMs += ms;
    },
    armConcurrentWrite: (when, apply) => readHooks.push({ when, apply, armed: false }),
    setCwd: (value) => {
      state.sessionCwd = value;
    },
  };
}

/**
 * 도구 호출 한 건. handleKey는 그 연결번호를 발급할 때 받은 값을 그대로 쓰고, token은 지금
 * 유효한 값을 쓴다 — 시험마다 `{handleKey}`/`{token}`으로 덮어써서 틀린 값·남의 값·이전
 * 토큰을 흉내 낸다.
 */
async function callTool(harness, name, args, overrides = {}) {
  const withCredentials = { ...args };
  if (args.handle !== undefined || overrides.handleKey !== undefined) {
    withCredentials.handleKey = overrides.handleKey ?? harness.keyOf(args.handle);
  }
  const response = await harness.bridge.dispatch(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: withCredentials,
      },
    },
    { token: overrides.token ?? harness.token() ?? "" },
  );
  const text = response?.result?.content?.[0]?.text;
  return {
    response,
    payload: text === undefined ? undefined : JSON.parse(text),
    isError: response?.result?.isError === true,
  };
}

/** 핸들 해소 실패는 JSON-RPC error + data.code로만 나와야 한다. */
async function rejectionCode(harness, handle) {
  const { response } = await callTool(harness, "omp_resume_handle", { handle });
  assert.equal(response.error?.code, GPT6_RPC_ERROR.handleRejected, "핸들 거부는 JSON-RPC error여야 한다");
  assert.equal(response.result, undefined, "거부는 도구 결과로 새어 나가면 안 된다");
  return response.error.data?.code;
}

test("연결번호는 발급 스냅샷으로 해소되고, 거부 사유마다 고유 코드가 나온다", async () => {
  const issuedHarness = makeHarness();
  const issued = issuedHarness.issue({ instruction: "빌드 고쳐줘" });
  assert.match(issued.handle, /^H-\d{4}$/);
  assert.equal(issued.startSentence.includes(issued.handle), true);

  const resumed = await callTool(issuedHarness, "omp_resume_handle", { handle: issued.handle });
  assert.equal(resumed.isError, false);
  assert.deepEqual(resumed.payload, {
    handle: issued.handle,
    cwd: CWD,
    projectName: "Tools",
    sessionId: SESSION_ID,
    instruction: "빌드 고쳐줘",
    status: "active",
  });

  const expired = makeHarness();
  const expiredHandle = expired.issue().handle;
  expired.advance(721 * 60_000);

  const revoked = makeHarness();
  const revokedHandle = revoked.issue().handle;
  revoked.bridge.revokeHandle(revokedHandle);

  const unknown = makeHarness();
  unknown.issue();

  const missingSession = makeHarness();
  const missingHandle = missingSession.issue().handle;
  // 세션도 런타임에서 사라지고 기록도 없다 — 되살릴 근거가 없는 경우만 session_missing이다.
  missingSession.state.registered = false;
  missingSession.state.alive = false;
  missingSession.state.recordExists = false;

  const moved = makeHarness();
  const movedHandle = moved.issue().handle;
  moved.setCwd("E:/Projects/Other");

  const codes = [
    await rejectionCode(expired, expiredHandle),
    await rejectionCode(revoked, revokedHandle),
    await rejectionCode(unknown, "H-9999"),
    await rejectionCode(missingSession, missingHandle),
    await rejectionCode(moved, movedHandle),
  ];

  assert.deepEqual(codes, [
    "handle_expired",
    "handle_revoked",
    "unknown_handle",
    "session_missing",
    "cwd_mismatch",
  ]);
  assert.equal(new Set(codes).size, codes.length, "거부 사유는 서로 다른 코드여야 한다");

  // 만료·폐기 판정은 호출을 받은 핸들에서만 일어난다: 다른 핸들은 그대로 살아 있다.
  assert.equal((await callTool(unknown, "omp_resume_handle", { handle: "H-9999" })).response.error.code, GPT6_RPC_ERROR.handleRejected);
  assert.equal((await callTool(revoked, "omp_get_status", { handle: revokedHandle })).response.error.data.code, "handle_revoked");
});

test("핸들의 cwd는 발급 시점 스냅샷이고, 세션이 옮겨가면 cwd_mismatch로 실패한다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();
  const before = harness.bridge.listHandles().handles[0];
  assert.equal(before.cwd, CWD);

  harness.setCwd("E:/Projects/Tools/CUELO_Setup");

  const after = harness.bridge.listHandles().handles[0];
  assert.equal(after.cwd, CWD, "핸들의 cwd는 세션의 현재 cwd를 따라가면 안 된다");
  assert.equal(await rejectionCode(harness, issued.handle), "cwd_mismatch");
  assert.equal(harness.prompts().length, 0, "거부된 핸들은 세션에 아무것도 넣지 않는다");
});

test("토큰이 다르면 디스패치가 어떤 도구도 실행하지 않는다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();
  assert.equal(harness.bridge.acceptsToken("wrong-token"), false);
  assert.equal(harness.bridge.acceptsToken(harness.token()), true);

  const response = await harness.bridge.dispatch(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "omp_send_instruction", arguments: { handle: issued.handle, message: "지시" } },
    },
    { token: "wrong-token" },
  );

  assert.equal(response.result, undefined);
  assert.equal(response.error.code, GPT6_RPC_ERROR.unauthorized);
  assert.equal(response.error.data?.code, "unauthorized");
  assert.equal(harness.prompts().length, 0);
  assert.equal(harness.store().handles[issued.handle].callCount, 0);
});

test("모르는 도구 이름은 언제나 -32602로 거부된다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();

  const unknown = await callTool(harness, "omp_shutdown_everything", { handle: issued.handle });
  assert.equal(unknown.response.result, undefined);
  assert.equal(unknown.response.error.code, GPT6_RPC_ERROR.invalidParams);

  const missingName = await callTool(harness, "", { handle: issued.handle });
  assert.equal(missingName.response.error.code, GPT6_RPC_ERROR.invalidParams);
  assert.equal(unknown.response.error.code, missingName.response.error.code, "같은 분류는 같은 코드를 쓴다");
  assert.equal(harness.prompts().length, 0);
});

test("omp_get_result는 sinceEntryId 뒤만 주고, 상한을 넘으면 잘랐다고 알린다", async () => {
  const harness = makeHarness({ entries: timelineEntries(80) });
  const issued = harness.issue();

  // 커서 없음: 최근 것만 준다.
  const recent = await callTool(harness, "omp_get_result", { handle: issued.handle });
  assert.equal(recent.payload.entries.length, 20);
  assert.equal(recent.payload.entries[0].id, "e60");
  assert.equal(recent.payload.entries[19].id, "e79");
  assert.equal(recent.payload.truncated, true);
  assert.equal(recent.payload.busy, false);
  assert.equal(recent.payload.entries[0].role, "user");
  assert.equal(recent.payload.entries[1].text, "text 61");

  // 커서 뒤가 상한(50)을 넘으면 앞에서 자르고 잘렸다고 알린다.
  const capped = await callTool(harness, "omp_get_result", { handle: issued.handle, sinceEntryId: "e10" });
  assert.equal(capped.payload.entries.length, 50);
  assert.equal(capped.payload.entries[0].id, "e11");
  assert.equal(capped.payload.entries[49].id, "e60");
  assert.equal(capped.payload.truncated, true);

  // 남은 게 상한 이하이면 자르지 않는다.
  const tail = await callTool(harness, "omp_get_result", { handle: issued.handle, sinceEntryId: "e70" });
  assert.deepEqual(tail.payload.entries.map((entry) => entry.id), ["e71", "e72", "e73", "e74", "e75", "e76", "e77", "e78", "e79"]);
  assert.equal(tail.payload.truncated, false);

  // 사라진 커서(압축 등)는 0건으로 조용히 넘기지 않는다.
  const gone = await callTool(harness, "omp_get_result", { handle: issued.handle, sinceEntryId: "e-deleted" });
  assert.equal(gone.payload.cursorMissing, true);
  assert.equal(gone.payload.entries.length, 20);

  // 긴 엔트리는 본문을 자르고 그 사실을 payload에 남긴다.
  const huge = makeHarness({ entries: [messageEntry("huge", "assistant", "x".repeat(5_000))] });
  const hugeHandle = huge.issue().handle;
  const clipped = await callTool(huge, "omp_get_result", { handle: hugeHandle });
  assert.equal(clipped.payload.truncated, true);
  assert.equal(clipped.payload.entries[0].text.endsWith("…(이하 생략)"), true);
  assert.equal(clipped.payload.entries[0].text.length < 5_000, true);
});

test("같은 idempotencyKey 재호출은 재전송하지 않고 기존 entryId를 돌려준다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();

  const first = await callTool(harness, "omp_send_instruction", {
    handle: issued.handle,
    message: "테스트 고쳐줘",
    idempotencyKey: "call-1",
  });
  assert.equal(first.payload.accepted, true);
  assert.equal(first.payload.deduped, false);
  assert.equal(harness.prompts().length, 1);

  const retry = await callTool(harness, "omp_send_instruction", {
    handle: issued.handle,
    message: "테스트 고쳐줘",
    idempotencyKey: "call-1",
  });
  assert.equal(retry.payload.deduped, true);
  assert.equal(retry.payload.entryId, first.payload.entryId);
  assert.equal(harness.prompts().length, 1, "같은 키는 두 번 전송되지 않는다");
  assert.equal(harness.store().handles[issued.handle].callCount, 2, "재전송으로 끝난 호출도 호출로 센다");

  const otherKey = await callTool(harness, "omp_send_instruction", {
    handle: issued.handle,
    message: "테스트 고쳐줘",
    idempotencyKey: "call-2",
  });
  assert.equal(otherKey.payload.deduped, false);
  assert.equal(harness.prompts().length, 2, "다른 논리 호출은 새로 전송된다");

  // 키 없는 재전송은 60초 창 안에서만 같은 지시로 본다.
  await callTool(harness, "omp_send_instruction", { handle: issued.handle, message: "이어서 해줘" });
  harness.advance(59_000);
  const insideWindow = await callTool(harness, "omp_send_instruction", { handle: issued.handle, message: "이어서 해줘" });
  assert.equal(insideWindow.payload.deduped, true);
  assert.equal(harness.prompts().length, 3);

  harness.advance(61_000);
  const outsideWindow = await callTool(harness, "omp_send_instruction", { handle: issued.handle, message: "이어서 해줘" });
  assert.equal(outsideWindow.payload.deduped, false);
  assert.equal(harness.prompts().length, 4, "60초 밖의 같은 문장은 의도된 재전송일 수 있다");
  assert.equal(harness.store().handles[issued.handle].callCount, 6);
});

test("주입된 지시는 6PRO 출처 라벨과 함께 세션에 들어가고, 중복 판정은 원문으로 한다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();

  await callTool(harness, "omp_send_instruction", { handle: issued.handle, message: "빌드 다시 돌려줘" });
  const [first] = harness.prompts();
  assert.equal(
    first.message,
    `${GPT6_INJECTION_LABEL}\n빌드 다시 돌려줘`,
    "대화를 읽는 쪽이 사용자 입력과 6PRO 주입을 구분할 수 있어야 한다",
  );

  // 라벨은 세션 표기일 뿐이므로 중복 판정에 끼어들지 않는다.
  const retry = await callTool(harness, "omp_send_instruction", { handle: issued.handle, message: "빌드 다시 돌려줘" });
  assert.equal(retry.payload.deduped, true);
  assert.equal(harness.prompts().length, 1, "라벨이 붙어도 같은 원문은 재전송되지 않는다");

  // 6PRO가 라벨을 직접 붙여 보내도 두 번 붙지 않는다.
  await callTool(harness, "omp_send_instruction", {
    handle: issued.handle,
    message: `${GPT6_INJECTION_LABEL}\n이미 라벨이 있다`,
  });
  const labelled = harness.prompts().at(-1);
  assert.equal(labelled.message, `${GPT6_INJECTION_LABEL}\n이미 라벨이 있다`);
});

test("omp_publish_reply는 모델을 실행하지 않고 답변 entry만 남긴다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();
  // 턴이 돌고 있어도 기록은 실행과 경합하지 않는다.
  harness.state.running = true;

  const published = await callTool(harness, "omp_publish_reply", {
    handle: issued.handle,
    text: "원인은 투영 손실입니다.",
    requestId: "q-17",
  });
  assert.equal(published.isError, false);
  assert.equal(published.payload.published, true);
  assert.equal(published.payload.busy, true, "실행 중이라는 사실은 숨기지 않는다");
  assert.equal(harness.prompts().length, 0, "답변 기록은 어떤 모델도 실행시키지 않는다");

  const entry = harness.state.entries.at(-1);
  assert.equal(entry.type, "custom_message");
  assert.equal(entry.customType, GPT6_REPLY_CUSTOM_TYPE);
  assert.equal(entry.content, "원인은 투영 손실입니다.");
  assert.equal(entry.display, true, "화면에 보이지 않으면 기록의 목적이 사라진다");
  assert.equal(entry.details.requestId, "q-17", "질문과 답변은 같은 번호로 묶인다");

  // 재기록은 같은 entry를 가리키고 두 번 남지 않는다.
  const retry = await callTool(harness, "omp_publish_reply", {
    handle: issued.handle,
    text: "원인은 투영 손실입니다.",
  });
  assert.equal(retry.payload.deduped, true);
  assert.equal(retry.payload.entryId, published.payload.entryId);
  assert.equal(harness.state.entries.filter((item) => item.type === "custom_message").length, 1);

  // 올린 답변은 6PRO가 다시 읽을 수 있어야 한다(커서가 여기서 끊기면 안 된다).
  const result = await callTool(harness, "omp_get_result", { handle: issued.handle });
  const view = result.payload.entries.at(-1);
  assert.deepEqual(view, { id: published.payload.entryId, role: "gpt6", text: "원인은 투영 손실입니다." });
});

test("자동 WEB6 핸들은 session entry를 정본으로 남기고 모델을 실행하지 않는다", async () => {
  const harness = makeHarness();
  const issued = harness.issue({ web6RequestId: "web6-1234" });

  const published = await callTool(harness, "omp_publish_reply", {
    handle: issued.handle,
    text: "MCP로 돌아온 최종 답변",
    requestId: "web6-1234",
    idempotencyKey: "web6-1234",
  });

  assert.equal(published.isError, false);
  assert.equal(published.payload.published, true);
  assert.equal(harness.state.entries.filter((entry) => entry.type === "custom_message").length, 1);
  assert.equal(harness.prompts().length, 0, "자동 상담 응답 전달은 모델 턴을 만들지 않는다");
});

test("자동 WEB6 답변은 발급 requestId를 requestId와 idempotencyKey에 동일하게 요구한다", async () => {
  const harness = makeHarness();
  const issued = harness.issue({ web6RequestId: "web6-1234" });

  for (const args of [
    { handle: issued.handle, text: "요청 번호 없음" },
    { handle: issued.handle, text: "다른 요청", requestId: "other", idempotencyKey: "other" },
    { handle: issued.handle, text: "키 불일치", requestId: "web6-1234", idempotencyKey: "other" },
  ]) {
    const rejected = await callTool(harness, "omp_publish_reply", args);
    assert.equal(rejected.response.error?.code, GPT6_RPC_ERROR.invalidParams);
  }
  const empty = await callTool(harness, "omp_publish_reply", {
    handle: issued.handle,
    text: "   ",
    requestId: "web6-1234",
    idempotencyKey: "web6-1234",
  });
  assert.equal(empty.response.error?.code, GPT6_RPC_ERROR.invalidParams);
  assert.equal(harness.state.entries.length, 0);
});

test("WEB6 핸들의 같은 idempotencyKey 재전송은 entry를 늘리지 않는다", async () => {
  const harness = makeHarness();
  const issued = harness.issue({ web6RequestId: "web6-wrong" });
  const args = {
    handle: issued.handle,
    text: "오귀속되면 안 되는 답",
    requestId: "web6-wrong",
    idempotencyKey: "web6-wrong",
  };

  const first = await callTool(harness, "omp_publish_reply", args);
  assert.equal(first.isError, false);
  assert.equal(first.payload.deduped, false);
  const retry = await callTool(harness, "omp_publish_reply", args);
  assert.equal(retry.isError, false);
  assert.equal(retry.payload.deduped, true);
  assert.equal(retry.payload.entryId, first.payload.entryId);
  assert.equal(harness.state.entries.filter((entry) => entry.type === "custom_message").length, 1);
  assert.equal(harness.prompts().length, 0);
});
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
  assert.equal(harness.prompts().length, 0, "답변 기록은 어떤 모델도 실행시키지 않는다");

  const entries = harness.state.entries.filter((item) => item.type === "custom_message");
  assert.equal(entries.length, 1, "한 번의 호출은 entry 하나를 남긴다");
  const [entry] = entries;
  assert.equal(entry.id, published.entryId);
  assert.equal(entry.customType, GPT6_REPLY_CUSTOM_TYPE);
  assert.equal(entry.content, "핸들 없이 올린 상담 답변입니다.");
  assert.equal(entry.display, true, "화면에 보이지 않으면 기록의 목적이 사라진다");
  // 핸들 경로와 같은 출처 라벨이 남아야 두 경로의 entry가 저장소에서도 같은 모양이다.
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
  assert.equal(harness.prompts().length, 0);
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

test("omp_dispatch는 브리프를 실행 계약으로 보내고, 같은 본문의 지시와 섞이지 않는다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();

  const dispatched = await callTool(harness, "omp_dispatch", {
    handle: issued.handle,
    brief: "# Target\nlib/gpt6-bridge.ts",
  });
  assert.equal(dispatched.payload.accepted, true);
  const sent = harness.prompts().at(-1).message;
  assert.equal(sent.startsWith(`${GPT6_DISPATCH_LABEL}\n`), true, "발주는 답변·일반 지시와 구분돼야 한다");
  assert.equal(sent.endsWith("# Target\nlib/gpt6-bridge.ts"), true, "브리프 본문은 그대로 실린다");

  // 같은 본문을 일반 지시로 보내는 것은 다른 호출이다 — 발주 예약에 걸려선 안 된다.
  const instructed = await callTool(harness, "omp_send_instruction", {
    handle: issued.handle,
    message: "# Target\nlib/gpt6-bridge.ts",
  });
  assert.equal(instructed.payload.deduped, false);
  assert.equal(harness.prompts().length, 2);

  const again = await callTool(harness, "omp_dispatch", {
    handle: issued.handle,
    brief: "# Target\nlib/gpt6-bridge.ts",
  });
  assert.equal(again.payload.deduped, true, "같은 브리프 재전송은 한 건으로 묶인다");
  assert.equal(harness.prompts().length, 2);
});

test("실패로 끝난 턴은 빈 답변이 아니라 사유와 함께 조회된다", async () => {
  const harness = makeHarness({
    entries: [
      messageEntry("u0", "user", "진단해줘"),
      failedEntry("a1", {
        provider: "openai-codex",
        model: "gpt-daybreak-blue-latest",
        message: "Codex error event: The usage limit has been reached (code=usage_limit_reached)",
      }),
      failedEntry("a2", {
        provider: "anthropic",
        model: "claude-opus-5",
        message: "429 rate_limit_error",
        status: 429,
      }),
    ],
  });
  const issued = harness.issue();

  const result = await callTool(harness, "omp_get_result", { handle: issued.handle });
  const [, quota, rateLimited] = result.payload.entries;

  assert.equal(quota.text, "", "실패한 턴에는 본문이 없다");
  assert.deepEqual(quota.failure, {
    stopReason: "error",
    message: "Codex error event: The usage limit has been reached (code=usage_limit_reached)",
    model: "openai-codex/gpt-daybreak-blue-latest",
  });
  assert.equal(rateLimited.failure.status, 429, "HTTP 상태를 버리면 원인을 구분할 수 없다");
  assert.equal(rateLimited.failure.model, "anthropic/claude-opus-5");

  // 정상 entry에는 failure가 붙지 않는다.
  assert.equal(Object.hasOwn(result.payload.entries[0], "failure"), false);
});

test("이미 턴을 돌고 있는 세션은 session_busy로 거부하고, 큐에 조용히 넣지 않는다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();
  harness.state.running = true;

  const busy = await callTool(harness, "omp_send_instruction", {
    handle: issued.handle,
    message: "새 지시",
    idempotencyKey: "busy-call",
  });
  assert.equal(busy.response.error, undefined, "busy는 도구 결과(isError)로 돌려준다");
  assert.equal(busy.isError, true);
  assert.equal(busy.payload.code, "session_busy");
  assert.equal(busy.payload.busy, true);
  assert.equal(busy.payload.hint.includes("omp_get_status"), true);
  assert.equal(harness.prompts().length, 0, "busy 세션에는 아무것도 넣지 않는다");
  assert.equal(
    harness.store().handles[issued.handle].callCount,
    1,
    "busy로 거부된 호출도 연결번호에 닿았으니 흔적을 남긴다",
  );
  assert.equal(harness.store().handles[issued.handle].recentSends.length, 0, "거부는 전송 기록을 남기지 않는다");

  const status = await callTool(harness, "omp_get_status", { handle: issued.handle });
  assert.deepEqual(status.payload, {
    busy: true,
    model: "anthropic/claude-sonnet-5",
    runningAgents: 0,
    lastEntryId: null,
  });

  harness.state.running = false;
  const afterTurn = await callTool(harness, "omp_send_instruction", {
    handle: issued.handle,
    message: "새 지시",
    idempotencyKey: "busy-call",
  });
  assert.equal(afterTurn.payload.accepted, true);
  assert.equal(afterTurn.payload.deduped, false);
  assert.equal(harness.prompts().length, 1, "턴이 끝나면 같은 키로 진행된다");
});

test("저장소 revision이 어긋나면 다시 읽어 병합하고, 동시 기록이 유실되지 않는다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();
  const key = `id:parallel-call`;

  // 예약(entryId 없음)이 파일에 남은 시점의 읽기 = 전송을 마치고 기록을 확정하려는 순간.
  // 그 순간 다른 호출이 자기 핸들을 추가했다면, 확정 쓰기가 그것을 지워서는 안 된다.
  harness.armConcurrentWrite(
    (store) => store.handles[issued.handle].recentSends.some((send) => send.key === key && send.entryId === ""),
    (store) => {
      store.handles["H-7777"] = {
        handle: "H-7777",
        cwd: CWD,
        sessionId: SESSION_ID,
        instruction: "다른 호출",
        createdAt: new Date(CLOCK_START).toISOString(),
        expiresAt: new Date(CLOCK_START + 60_000).toISOString(),
        revokedAt: null,
        lastCallAt: null,
        callCount: 3,
        recentSends: [{ key: "id:other", entryId: "e9", sentAt: new Date(CLOCK_START).toISOString(), messageHash: "h" }],
        handleKeyHash: "b".repeat(64),
      };
    },
  );

  const sent = await callTool(harness, "omp_send_instruction", {
    handle: issued.handle,
    message: "동시 호출 검증",
    idempotencyKey: "parallel-call",
  });
  assert.equal(sent.payload.accepted, true);

  const store = harness.store();
  assert.equal(store.handles["H-7777"].callCount, 3, "동시에 기록된 핸들이 남아 있어야 한다");
  const record = store.handles[issued.handle];
  assert.equal(record.callCount, 1);
  assert.equal(record.lastCallAt, new Date(CLOCK_START).toISOString());
  assert.equal(record.recentSends.length, 1);
  assert.equal(record.recentSends[0].entryId, sent.payload.entryId, "예약은 확정된 entryId로 채워져야 한다");
  assert.equal(record.recentSends[0].entryId === "", false);
  assert.equal(store.revision > 1, true);
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

test("전역 토큰만으로는 어느 도구도 실행되지 않는다 — 연결번호마다 핸들 키가 필요하다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();
  assert.equal(issued.handleKey.length > 0, true);
  assert.equal(issued.startSentence.includes(issued.handle), true);
  assert.equal(issued.startSentence.includes(issued.handleKey), true, "시작 문장에 핸들 키가 들어 있어야 6 Pro가 전달한다");
  assert.equal(JSON.stringify(harness.store()).includes(issued.handleKey), false, "핸들 키는 저장소에 평문으로 남지 않는다");

  const calls = [
    ["omp_resume_handle", { handle: issued.handle }],
    ["omp_get_status", { handle: issued.handle }],
    ["omp_get_result", { handle: issued.handle }],
    ["omp_send_instruction", { handle: issued.handle, message: "지시" }],
  ];
  for (const [name, args] of calls) {
    const call = await callTool(harness, name, args, { handleKey: "not-the-key" });
    assert.equal(call.response.error?.code, GPT6_RPC_ERROR.handleRejected, `${name}: 핸들 거부로 끊는다`);
    assert.equal(call.response.error?.data?.code, "handle_unauthorized");
    assert.equal(call.response.result, undefined, `${name}: 거부는 도구 결과로 새어 나가면 안 된다`);
  }

  const absent = await callTool(harness, "omp_resume_handle", { handle: issued.handle }, { handleKey: "" });
  assert.equal(absent.response.error?.data?.code, "handle_unauthorized", "키 부재도 같은 사유로 거부한다");

  assert.equal(harness.prompts().length, 0, "키가 틀리면 세션에 아무것도 들어가지 않는다");
  assert.equal(harness.store().handles[issued.handle].callCount, 0);
  assert.equal(harness.store().failedAuthCount, 5, "해소 실패는 저장소에 집계된다");

  // 올바른 키를 함께 보내면 그대로 통과한다.
  const legit = await callTool(harness, "omp_resume_handle", { handle: issued.handle });
  assert.equal(legit.isError, false);
  assert.equal(legit.payload.sessionId, SESSION_ID);
});

test("다른 연결번호의 핸들 키로는 그 연결번호에 접근할 수 없다", async () => {
  const harness = makeHarness();
  const first = harness.issue({ instruction: "프로젝트 A" });
  const second = harness.issue({ instruction: "프로젝트 B" });
  assert.notEqual(first.handleKey, second.handleKey, "핸들 키는 연결번호마다 다르다");

  // 자기 키로는 통과한다.
  const own = await callTool(harness, "omp_resume_handle", { handle: second.handle });
  assert.equal(own.isError, false);
  assert.equal(own.payload.instruction, "프로젝트 B");

  // 남의 연결번호에 자기 키를 붙이면(교차 사용) 거부되고 본문도 실행되지 않는다.
  const crossed = await callTool(harness, "omp_resume_handle", { handle: second.handle }, { handleKey: first.handleKey });
  assert.equal(crossed.response.error?.code, GPT6_RPC_ERROR.handleRejected);
  assert.equal(crossed.response.error?.data?.code, "handle_unauthorized");
  assert.equal(crossed.response.result, undefined);

  const crossedSend = await callTool(
    harness,
    "omp_send_instruction",
    { handle: second.handle, message: "프로젝트 B에 주입" },
    { handleKey: first.handleKey },
  );
  assert.equal(crossedSend.response.error?.data?.code, "handle_unauthorized");
  assert.equal(harness.prompts().length, 0, "교차 사용은 어느 세션에도 닿지 않는다");
  assert.equal(harness.store().handles[second.handle].callCount, 1, "통과한 호출만 흔적을 남긴다");
});

test("토큰을 회전하면 이전 토큰은 그 전에 통하던 연결번호에도 즉시 거부된다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();
  const previous = harness.token();
  assert.equal(harness.bridge.acceptsToken(previous), true);
  assert.equal((await callTool(harness, "omp_resume_handle", { handle: issued.handle })).isError, false);

  const rotated = harness.rotate(previous);
  assert.notEqual(rotated.token, previous);
  assert.equal(harness.bridge.acceptsToken(previous), false, "이전 토큰은 즉시 거부된다");
  assert.equal(harness.bridge.acceptsToken(rotated.token), true);
  assert.equal(JSON.stringify(harness.store()).includes(rotated.token), false, "토큰도 저장소에 평문으로 남지 않는다");

  const stale = await callTool(
    harness,
    "omp_send_instruction",
    { handle: issued.handle, message: "이전 토큰으로 주입" },
    { token: previous },
  );
  assert.equal(stale.response.error?.code, GPT6_RPC_ERROR.unauthorized);
  assert.equal(harness.prompts().length, 0);

  // 새 토큰 + 그 연결번호의 키로는 그대로 진행한다. 연결번호는 회전으로 죽지 않는다.
  const fresh = await callTool(harness, "omp_send_instruction", { handle: issued.handle, message: "지시" });
  assert.equal(fresh.payload.accepted, true);
  assert.equal(harness.prompts().length, 1);

  // 평문 토큰은 최초 생성·회전 응답에서만 나간다: 다음 발급은 토큰을 다시 실어 보내지 않는다.
  const second = harness.issue();
  assert.equal(second.token, null);
  assert.match(harness.store().tokenHash, /^[0-9a-f]{64}$/);

  // 현재 토큰을 제시하지 못하면 회전 자체가 거부된다 — 아무나 새 토큰을 받아 갈 수 없다.
  assert.throws(() => harness.bridge.rotateToken("guessed-token"), { code: "invalid_token" });
  assert.equal(harness.bridge.acceptsToken(rotated.token), true, "실패한 회전은 기존 토큰을 건드리지 않는다");
});

test("핸들 해소 실패가 60초 창에서 상한을 넘으면 잠기고, 열람 호출도 흔적을 남긴다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();

  // 열람 도구도 callCount를 올린다 — 순회가 6PRO 탭에 보여야 한다.
  await callTool(harness, "omp_resume_handle", { handle: issued.handle });
  await callTool(harness, "omp_get_status", { handle: issued.handle });
  await callTool(harness, "omp_get_result", { handle: issued.handle });
  assert.equal(harness.store().handles[issued.handle].callCount, 3);
  assert.equal(harness.store().handles[issued.handle].lastCallAt, new Date(CLOCK_START).toISOString());
  assert.equal(harness.bridge.listHandles().failedAuthCount, 0);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const wrong = await callTool(harness, "omp_resume_handle", { handle: issued.handle }, { handleKey: `wrong-${attempt}` });
    assert.equal(wrong.response.error?.data?.code, "handle_unauthorized", `${attempt}번째 실패는 사유가 그대로 보인다`);
  }
  assert.equal(harness.store().failedAuthCount, 10);
  const listed = harness.bridge.listHandles();
  assert.equal(listed.failedAuthCount, 10, "실패 집계는 화면에 그대로 보인다");
  assert.equal(listed.lastFailedAt, new Date(CLOCK_START).toISOString());

  const locked = await callTool(harness, "omp_resume_handle", { handle: issued.handle }, { handleKey: "wrong-11" });
  assert.equal(locked.response.error?.code, GPT6_RPC_ERROR.handleRejected);
  assert.equal(locked.response.error?.data?.code, "too_many_failures");

  // 잠금은 실패하는 해소에만 걸린다: 정답 키를 가진 호출은 잠금 중에도 그대로 진행한다.
  const legit = await callTool(harness, "omp_get_status", { handle: issued.handle });
  assert.equal(legit.isError, false);

  // 조용한 시간이 창을 넘기면 사유가 다시 보이고 세는 것도 새로 시작한다.
  harness.advance(GPT6_AUTH_FAILURE_WINDOW_MS + 1);
  const afterWindow = await callTool(harness, "omp_resume_handle", { handle: issued.handle }, { handleKey: "wrong-12" });
  assert.equal(afterWindow.response.error?.data?.code, "handle_unauthorized");
  assert.equal(harness.store().failedAuthCount, 1);
  assert.equal(harness.bridge.listHandles().failedAuthCount, 1);
});

test("수명이 끝난 연결번호는 보존 기간이 지나면 목록과 저장소에서 함께 사라진다", async () => {
  const harness = makeHarness();
  const revoked = harness.issue();
  harness.bridge.revokeHandle(revoked.handle);
  const survivor = harness.issue();
  assert.equal(harness.bridge.listHandles().handles.length, 2);

  // 보존 기간 안에는 폐기된 연결번호도 남는다 — 왜 막히는지 화면에서 읽을 수 있어야 한다.
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
  assert.equal(harness.store().handles[revoked.handle], undefined);
  assert.equal(await rejectionCode(harness, revoked.handle), "unknown_handle", "기록이 사라진 연결번호는 다시 통하지 않는다");
});

test("initialize는 서버가 구현한 프로토콜 버전만 확정하고, batch 본문은 그 사실을 밝혀 거부한다", async () => {
  const harness = makeHarness();
  harness.issue();

  for (const requested of ["2030-01-01", "2024-11-05", undefined]) {
    const response = await harness.bridge.dispatch(
      { jsonrpc: "2.0", id: 2, method: "initialize", params: requested === undefined ? {} : { protocolVersion: requested } },
      { token: harness.token() },
    );
    assert.equal(response.result.protocolVersion, GPT6_PROTOCOL_VERSION, `클라이언트가 보낸 ${requested ?? "(없음)"}을 되돌려주지 않는다`);
    assert.equal(response.result.serverInfo.name, GPT6_SERVER_NAME);
  }

  const batch = await harness.bridge.dispatch(
    [{ jsonrpc: "2.0", id: 3, method: "tools/list" }],
    { token: harness.token() },
  );
  assert.equal(batch.error?.code, GPT6_RPC_ERROR.invalidRequest);
  assert.equal(batch.error?.message.includes("batch"), true, "원인이 요청 형식이 아니라 batch 미지원임을 밝힌다");
});

test("tools/list는 도구별 annotation을 실제 동작대로 광고한다", async () => {
  const harness = makeHarness();
  harness.issue();

  const response = await harness.bridge.dispatch(
    { jsonrpc: "2.0", id: 4, method: "tools/list" },
    { token: harness.token() },
  );
  const tools = response.result.tools;
  assert.equal(tools.length, 6);

  // 조회만 하는 도구가 readOnlyHint 없이 나가면 클라이언트는 전부 write로 보고 확인·차단
  // 게이트를 건다. 광고가 실제 동작과 어긋나면 호출 자체가 그 게이트에서 막힌다.
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const readOnly of ["omp_resume_handle", "omp_get_status", "omp_get_result"]) {
    const annotations = byName[readOnly].annotations;
    assert.equal(annotations.readOnlyHint, true, `${readOnly}는 읽기 전용이다`);
    assert.equal(annotations.destructiveHint, false, readOnly);
    assert.equal(annotations.idempotentHint, true, readOnly);
  }
  for (const writer of ["omp_send_instruction", "omp_publish_reply", "omp_dispatch"]) {
    const annotations = byName[writer].annotations;
    assert.equal(annotations.readOnlyHint, false, `${writer}는 세션을 바꾼다`);
    assert.equal(annotations.destructiveHint, false, `${writer}는 삭제가 아니라 entry 추가다`);
    assert.equal(annotations.idempotentHint, false, `${writer}의 재호출은 언제나 무효과가 아니다`);
  }
  const publishSchema = byName.omp_publish_reply.inputSchema;
  assert.deepEqual(publishSchema.required, ["handle", "handleKey", "text"]);
  assert.equal("consultationId" in publishSchema.properties, false);
  for (const tool of tools) {
    // 이 브리지는 이 PC에 살아 있는 세션만 다룬다.
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
    assert.equal(typeof tool.annotations.title, "string");
    assert.notEqual(tool.annotations.title.trim(), "", tool.name);
  }
});

test("WEB에서 세션을 닫아도 연결번호는 세션 기록에서 세션을 되살려 계속 동작한다", async () => {
  const harness = makeHarness({ entries: timelineEntries(3) });
  const issued = harness.issue({ instruction: "빌드 고쳐줘" });

  // 사용자가 WEB에서 그 세션을 닫았다: 런타임에서 사라지고 기록만 남는다.
  harness.state.registered = false;
  harness.state.alive = false;

  const status = await callTool(harness, "omp_get_status", { handle: issued.handle });
  assert.equal(status.isError, false, "되살릴 수 있는 세션은 session_missing으로 끊기지 않는다");
  assert.equal(status.payload.busy, false);

  const resumed = await callTool(harness, "omp_resume_handle", { handle: issued.handle });
  assert.equal(resumed.isError, false);
  assert.equal(resumed.payload.sessionId, SESSION_ID);
  assert.equal(resumed.payload.cwd, CWD, "스냅샷은 발급 시점 값 그대로다");

  const result = await callTool(harness, "omp_get_result", { handle: issued.handle });
  assert.equal(result.isError, false);
  assert.equal(result.payload.entries.length, 3, "되살아난 세션의 기록이 그대로 보인다");

  const sent = await callTool(harness, "omp_send_instruction", { handle: issued.handle, message: "다시 시작" });
  assert.equal(sent.isError, false);
  assert.equal(sent.payload.accepted, true);
  assert.equal(harness.prompts().length, 1, "되살아난 세션에 지시가 들어간다");
  assert.deepEqual(harness.state.resumes, [SESSION_ID], "되살리기는 저장된 sessionId로 한 번만 일어난다");

  // 되살아난 세션의 cwd도 스냅샷과 비교된다 — 조용히 다른 폴더의 세션으로 대체하지 않는다.
  const moved = makeHarness();
  const movedHandle = moved.issue().handle;
  moved.state.registered = false;
  moved.state.alive = false;
  moved.setCwd("E:/Projects/Other");
  assert.equal(await rejectionCode(moved, movedHandle), "cwd_mismatch");
});

test("세션 기록이 아예 없으면 되살리지 않고 session_missing으로 끊는다", async () => {
  const harness = makeHarness();
  const issued = harness.issue();
  harness.state.registered = false;
  harness.state.alive = false;
  harness.state.recordExists = false;

  const status = await callTool(harness, "omp_get_status", { handle: issued.handle });
  assert.equal(status.response.error?.code, GPT6_RPC_ERROR.handleRejected);
  assert.equal(status.response.error?.data?.code, "session_missing");
  assert.equal(status.response.result, undefined, "거부는 도구 결과로 새어 나가면 안 된다");
  // 낡은 "WEB에서 열어 두세요" 안내 대신 실제 상황(기록을 찾지 못함)이 사유에 드러난다.
  assert.match(status.response.error.message, /기록을 찾을 수 없습니다/);

  const sent = await callTool(harness, "omp_send_instruction", { handle: issued.handle, message: "지시" });
  assert.equal(sent.response.error?.data?.code, "session_missing");
  assert.equal(sent.isError, false, "해소 실패는 isError 결과가 아니라 JSON-RPC error로 나간다");
  assert.equal(harness.prompts().length, 0, "되살리지 못한 세션에는 아무것도 들어가지 않는다");
});
