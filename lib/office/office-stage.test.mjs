import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { officeMainPlan, stepToward } = await jiti.import("./office-stage.ts");

test("Main 은 실제로 응답을 만드는 동안에만 책상에 앉아 일한다", () => {
  assert.deepEqual(officeMainPlan("working"), { spot: "desk", pose: "work" });
  for (const state of ["waiting", "attention", "idle"]) {
    assert.notEqual(officeMainPlan(state).pose, "work", state);
  }
});

test("입력이 필요하면 쉬는 자리에서 사용자를 부르고, 기다리는 동안은 책상 곁에 서 있는다", () => {
  assert.deepEqual(officeMainPlan("attention"), { spot: "lounge", pose: "wave" });
  assert.deepEqual(officeMainPlan("waiting"), { spot: "desk", pose: "idle" });
  assert.deepEqual(officeMainPlan("idle"), { spot: "lounge", pose: "idle" });
});

test("걸음은 목표를 지나치지 않고 남은 거리가 한 걸음 이하이면 정확히 도착한다", () => {
  const far = stepToward({ x: 0, z: 0 }, { x: 3, z: 4 }, 1);
  assert.equal(far.arrived, false);
  assert.ok(Math.abs(Math.hypot(far.point.x, far.point.z) - 1) < 1e-9);
  assert.ok(Math.abs(far.point.x / far.point.z - 3 / 4) < 1e-9);

  const near = stepToward({ x: 2.5, z: 3.5 }, { x: 3, z: 4 }, 1);
  assert.deepEqual(near, { point: { x: 3, z: 4 }, arrived: true });

  const there = stepToward({ x: 3, z: 4 }, { x: 3, z: 4 }, 0.1);
  assert.equal(there.arrived, true);
});
