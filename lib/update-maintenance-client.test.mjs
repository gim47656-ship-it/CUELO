import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  describeUpdateCleanup,
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
