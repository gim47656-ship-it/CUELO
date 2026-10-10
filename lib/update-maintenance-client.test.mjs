import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  describeUpdateCleanup,
  recordServerRestartReturn,
  readUpdateResumeIntent,
  settleUpdateReturn,
  takeServerRestartReturn,
  UPDATE_WAKE_EVENT,
  updateCleanupAutoHideMs,
} = await jiti.import("./update-maintenance-client.ts");

function cleanup(overrides) {
  return {
    status: "succeeded",
    currentTarget: null,
    completedCount: 3,
    totalCount: 3,
    removedCount: 2,
    keptCount: 1,
    elapsedSeconds: 114,
    failureCount: 0,
    ...overrides,
  };
}

test("정리가 끝난 상태 줄은 실패를 포함해 닫을 수 있고 스스로 사라진다", () => {
  for (const status of ["succeeded", "skipped", "failed", "pending-approval"]) {
    const banner = describeUpdateCleanup(cleanup({ status, failureCount: status === "failed" ? 1 : 0 }));
    assert.equal(banner.dismissible, true, `${status}는 닫을 수 있어야 한다`);
    assert.ok(
      typeof banner.autoHideMs === "number" && banner.autoHideMs > 0,
      `${status}는 스스로 사라져야 한다`,
    );
  }
});

test("정리 실패는 성공보다 오래 남지만 업데이트 실패로 표시하지 않는다", () => {
  const failed = describeUpdateCleanup(cleanup({ status: "failed", failureCount: 1 }));
  const succeeded = describeUpdateCleanup(cleanup({ status: "succeeded" }));
  assert.ok(failed.autoHideMs > succeeded.autoHideMs);
  assert.equal(failed.tone, "warning");
  assert.match(failed.detail, /업데이트 자체는 성공/);
  assert.match(failed.detail, /실패 1건/);
});

test("정리 진행 중은 사라지지 않고, 정리 receipt가 없는 완료 줄은 정해진 시간 뒤 스스로 사라진다", () => {
  const running = describeUpdateCleanup(cleanup({ status: "running", currentTarget: "stage" }));
  assert.equal(running.dismissible, false);
  assert.equal(running.autoHideMs, null);
  assert.equal(updateCleanupAutoHideMs("running"), null);
  // 정리 단계가 없는 옛 갱신이나 receipt 기록 실패로 끝내 receipt가 오지 않아도 줄은 남지 않는다.
  const missing = describeUpdateCleanup(null);
  assert.equal(missing.dismissible, true);
  assert.ok(typeof updateCleanupAutoHideMs(null) === "number" && updateCleanupAutoHideMs(null) > 0);
  assert.equal(missing.autoHideMs, updateCleanupAutoHideMs(null));
});

test("정리 승인 대기는 완료로 표시하지 않고 삭제가 남았음을 알린다", () => {
  const pending = describeUpdateCleanup(cleanup({ status: "pending-approval", completedCount: 0, removedCount: 0 }));
  assert.equal(pending.tone, "neutral");
  assert.match(pending.title, /승인 대기/);
  assert.doesNotMatch(pending.title, /정리 완료/);
  assert.match(pending.detail, /승인 후 실행/);
});

function withSessionStorage(run) {
  const original = globalThis.sessionStorage;
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  try {
    run(store);
  } finally {
    globalThis.sessionStorage = original;
  }
}

test("재시작 복귀 알림은 복원된 같은 세션 화면에서 한 번만 뜬다", () => {
  withSessionStorage((store) => {
    recordServerRestartReturn("session-a");
    assert.ok(store.has("ompweb-drafts-for-reload-v1"), "새로고침 전에 draft를 남긴다");
    assert.equal(takeServerRestartReturn(null), false, "세션 복원 전 첫 화면은 기록을 가져가지 않는다");
    assert.equal(takeServerRestartReturn("session-b"), false, "다른 세션 화면에는 뜨지 않는다");
    assert.equal(takeServerRestartReturn("session-a"), true);
    assert.equal(takeServerRestartReturn("session-a"), false, "같은 복귀를 다시 알리지 않는다");
  });
});

test("오래된 재시작 복귀 기록은 이번 화면의 복귀로 보지 않고 버린다", () => {
  withSessionStorage((store) => {
    recordServerRestartReturn("session-a");
    assert.equal(takeServerRestartReturn("session-a", Date.now() + 61_000), false);
    assert.equal(store.has("cuelo-restart-return-v1"), false);
  });
});

const REQUEST_ID = "a".repeat(32);
const STAGE_HASH = "b".repeat(64);
const CLIENT_ID = "client_failed_return_123456";

function resumeIntent(overrides = {}) {
  return {
    schemaVersion: 2,
    requestId: REQUEST_ID,
    stageHash: STAGE_HASH,
    clientId: CLIENT_ID,
    sessionId: "session-a",
    resumeUrl: "/?session=session-a",
    ...overrides,
  };
}

/** 실패 복귀 판단이 쓰는 브라우저 전역만 흉내 낸다. fetch는 호출 자체를 기록한다. */
async function withReturnBrowser(run) {
  const keys = ["sessionStorage", "window", "fetch", "CustomEvent"];
  const original = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const store = new Map();
  const events = [];
  const fetches = [];
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  globalThis.window = { dispatchEvent: (event) => { events.push(event); return true; } };
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).startsWith("/api/sessions/")) return { ok: true, json: async () => ({ sessionId: "session-a" }) };
    return { ok: true, json: async () => ({ schemaVersion: 2, resumed: true, wake: { wake: true } }) };
  };
  try {
    await run({ store, events, fetches });
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete globalThis[key];
      else globalThis[key] = original[key];
    }
  }
}

function failureRecord(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    requestId: REQUEST_ID,
    stageHash: STAGE_HASH,
    clientId: CLIENT_ID,
    sessionId: "session-a",
    wake: true,
    ...overrides,
  });
}

test("업데이트 실패 뒤 복귀한 화면은 resume 명령을 다시 보내지 않고 이미 시작된 실패 통지 run에 붙는다", async () => {
  await withReturnBrowser(async ({ store, events, fetches }) => {
    store.set("ompweb-update-resume-intent-v2", JSON.stringify(resumeIntent()));
    store.set("ompweb-update-failure-return-v1", failureRecord());

    assert.equal(await settleUpdateReturn(resumeIntent()), "failed");
    assert.deepEqual(fetches, [], "resume-confirm·failure-notify·새 prompt를 보내지 않는다");
    assert.equal(store.has("ompweb-update-resume-intent-v2"), false, "끝난 실패 request의 resume 의도는 지운다");
    assert.equal(store.has("ompweb-update-failure-return-v1"), false, "실패 복귀는 한 번만 처리한다");
    assert.equal(store.has("ompweb-update-return-v1"), false, "실패를 업데이트 완료 기록으로 남기지 않는다");
    assert.deepEqual(events.map((event) => [event.type, event.detail]), [[UPDATE_WAKE_EVENT, { sessionId: "session-a" }]]);
    // 세션 전환 등으로 복귀 effect가 다시 돌아도 남은 의도가 없으므로 아무것도 다시 보내지 않는다.
    assert.equal(readUpdateResumeIntent(), null);
    assert.deepEqual(fetches, []);
  });
});

test("서버 실패 통지가 run을 세우지 않았으면 실패 복귀는 깨우지 않는다", async () => {
  await withReturnBrowser(async ({ store, events, fetches }) => {
    store.set("ompweb-update-failure-return-v1", failureRecord({ wake: false }));
    assert.equal(await settleUpdateReturn(resumeIntent()), "failed");
    assert.deepEqual(fetches, []);
    assert.deepEqual(events, []);
  });
});

test("request·stage·탭 중 하나라도 다른 실패 기록은 이번 복귀를 실패로 바꾸지 않고 기존 성공 복귀 확인을 그대로 탄다", async () => {
  for (const mismatch of [{ requestId: "c".repeat(32) }, { stageHash: "d".repeat(64) }, { clientId: "client_other_tab_1234567" }]) {
    await withReturnBrowser(async ({ store, events, fetches }) => {
      store.set("ompweb-update-failure-return-v1", failureRecord(mismatch));
      store.set("ompweb-update-resume-intent-v2", JSON.stringify(resumeIntent()));

      assert.equal(await settleUpdateReturn(resumeIntent()), "resumed", JSON.stringify(mismatch));
      assert.deepEqual(fetches.map((call) => call.body?.action ?? call.url.split("?")[0]), ["/api/sessions/session-a", "resume-confirm"]);
      assert.equal(store.has("ompweb-update-resume-intent-v2"), false);
      assert.equal(store.has("ompweb-update-failure-return-v1"), false, "쓸 수 없는 남은 실패 기록은 버린다");
      assert.deepEqual(events.map((event) => event.detail), [{ sessionId: "session-a" }]);
    });
  }
});
