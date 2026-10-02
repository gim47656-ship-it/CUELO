import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { officeLayout, officeMainPlan, officeMakerPlan, stepToward } = await jiti.import("./office-stage.ts");

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

test("Maker 는 running 이면서 재시도 대기가 아닐 때만 일하고, 실행 완료는 일하는 모습으로 남지 않는다", () => {
  assert.deepEqual(officeMakerPlan("running", false), { spot: "desk", pose: "work" });
  assert.deepEqual(officeMakerPlan("running", true), { spot: "desk", pose: "idle" });
  assert.deepEqual(officeMakerPlan("pending", false), { spot: "desk", pose: "idle" });
  assert.deepEqual(officeMakerPlan("failed", false), { spot: "desk", pose: "slump" });
  for (const status of ["completed", "aborted", "unknown"]) {
    assert.deepEqual(officeMakerPlan(status, false), { spot: "lounge", pose: "idle" }, status);
  }
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

function distinctPoints(points) {
  const keys = points.map((point) => `${point.x.toFixed(3)}:${point.z.toFixed(3)}`);
  return new Set(keys).size === keys.length;
}

test("같은 캐릭터로 참여한 실행마다 제 좌석을 받고, 참여자가 있는 캐릭터는 휴게 구역에 남지 않는다", () => {
  // Main 과 같은 계정 Maker 둘이 모두 RIN(0) 자리, Maker 하나는 YUKI(3).
  const layout = officeLayout([
    { key: "main", seat: 0 },
    { key: "maker:A", seat: 0 },
    { key: "maker:B", seat: 0 },
    { key: "maker:C", seat: 3 },
  ]);
  const seats = layout.stations.map((station) => station.seat);
  assert.deepEqual(seats, [0, 0, 0, 3]);
  assert.ok(distinctPoints(layout.stations.map((station) => station.desk.point)), "desk seats do not overlap");
  assert.ok(distinctPoints(layout.stations.map((station) => station.lounge.point)), "lounge spots do not overlap");
  const rin = layout.desks.filter((desk) => desk.seat === 0);
  assert.equal(rin.reduce((sum, desk) => sum + desk.occupants, 0), 3, "every RIN run has its own chair");
  assert.equal(rin.length, 1, "three runs share one row");
  assert.ok(rin[0].width >= 3 * 0.5, "the shared desk widens for three runs");
  // 같은 책상 옆자리끼리는 말풍선 높이를 엇갈린다.
  assert.deepEqual(layout.stations.slice(0, 2).map((station) => station.bubbleLift), [0, 1]);
  assert.deepEqual(layout.rest.map((place) => place.seat), [1, 2, 4, 5, 6]);
});

test("캐릭터를 특정하지 못한 참여자는 캐릭터 책상이 아닌 공용 책상에 앉고, 일곱 캐릭터는 모두 방에 있다", () => {
  const layout = officeLayout([{ key: "main", seat: null }, { key: "maker:X", seat: null }]);
  assert.deepEqual(layout.stations.map((station) => station.seat), [null, null]);
  const guest = layout.desks.filter((desk) => desk.seat === null);
  assert.equal(guest.length, 1);
  assert.equal(guest[0].occupants, 2);
  // 아무도 특정되지 않았으니 일곱 캐릭터 모두 휴게 구역에 있고, 캐릭터 책상은 모두 비어 있다.
  assert.deepEqual(layout.rest.map((place) => place.seat), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(layout.desks.filter((desk) => desk.seat !== null).every((desk) => desk.occupants === 0));
  assert.ok(distinctPoints(layout.rest.map((place) => place.point)), "rest places do not overlap");
});

test("한 줄을 넘는 실행은 뒤에 줄을 더 놓아 좌석이 겹치지 않는다", () => {
  const participants = Array.from({ length: 5 }, (_, index) => ({ key: `maker:${index}`, seat: 2 }));
  const layout = officeLayout(participants);
  assert.ok(distinctPoints(layout.stations.map((station) => station.desk.point)));
  assert.deepEqual(layout.desks.filter((desk) => desk.seat === 2).map((desk) => desk.occupants), [3, 2]);
});
