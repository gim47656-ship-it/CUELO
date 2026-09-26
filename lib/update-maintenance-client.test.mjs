import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  describeUpdateCleanup,
  recordServerRestartReturn,
  takeServerRestartReturn,
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

test("정리 진행 중과 receipt 미확인 상태는 사라지지 않는다", () => {
  const running = describeUpdateCleanup(cleanup({ status: "running", currentTarget: "stage" }));
  assert.equal(running.dismissible, false);
  assert.equal(running.autoHideMs, null);
  assert.equal(describeUpdateCleanup(null).autoHideMs, null);
  assert.equal(updateCleanupAutoHideMs(null), null);
  assert.equal(updateCleanupAutoHideMs("running"), null);
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
