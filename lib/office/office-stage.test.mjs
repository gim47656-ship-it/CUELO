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

/** 평면 위 두 선분(서성이는 길, 앉은 자리는 길이 0) 사이 가장 가까운 거리. */
function segmentGap(a, b) {
  const toSegment = (p, s) => {
    const dx = s.to.x - s.from.x;
    const dz = s.to.z - s.from.z;
    const length = dx * dx + dz * dz;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.from.x) * dx + (p.z - s.from.z) * dz) / length));
    return Math.hypot(p.x - (s.from.x + t * dx), p.z - (s.from.z + t * dz));
  };
  const cross = (o, p, q) => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  const crosses = cross(a.from, a.to, b.from) * cross(a.from, a.to, b.to) < 0 && cross(b.from, b.to, a.from) * cross(b.from, b.to, a.to) < 0;
  if (crosses) return 0;
  return Math.min(toSegment(a.from, b), toSegment(a.to, b), toSegment(b.from, a), toSegment(b.to, a));
}

test("몸이 있는 캐릭터는 제 책상에 앉고 휴게 구역에 남지 않으며, 미확인 몸들은 공용 책상에 나란히 앉는다", () => {
  // RIN(0)·YUKI(3) 몸 하나씩과 캐릭터를 모르는 몸 둘.
  const layout = officeLayout([
    { key: "body:0", seat: 0 },
    { key: "maker:A", seat: null },
    { key: "maker:B", seat: null },
    { key: "body:3", seat: 3 },
  ]);
  assert.deepEqual(layout.stations.map((station) => station.seat), [0, null, null, 3]);
  assert.ok(distinctPoints(layout.stations.map((station) => station.desk.point)), "desk seats do not overlap");
  assert.ok(distinctPoints(layout.stations.map((station) => station.lounge.point)), "lounge spots do not overlap");
  assert.deepEqual(layout.desks.filter((desk) => desk.seat === 0).map((desk) => desk.occupants), [1]);
  const guest = layout.desks.filter((desk) => desk.seat === null);
  assert.equal(guest.length, 1);
  assert.equal(guest[0].occupants, 2);
  assert.ok(guest[0].width >= 2 * 0.5, "the guest desk widens for two");
  // 같은 책상 옆자리끼리는 말풍선 높이를 엇갈린다.
  assert.deepEqual(layout.stations.slice(1, 3).map((station) => station.bubbleLift), [0, 1]);
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
  // 쉬는 일곱이 서로 몸을 겹치지 않는다: 앉은 자리·서성이는 길끼리 가장 넓은 머리 지름(0.4m) 넘게 떨어져 있다.
  const paths = layout.rest.map((place) => ({ seat: place.seat, from: place.point, to: place.to ?? place.point }));
  for (const [index, a] of paths.entries()) {
    for (const b of paths.slice(index + 1)) {
      assert.ok(segmentGap(a, b) >= 0.4, `rest ${a.seat} and ${b.seat} come within ${segmentGap(a, b).toFixed(2)}m`);
    }
  }
});

test("한 줄을 넘는 미확인 몸은 뒤에 줄을 더 놓아 좌석이 겹치지 않는다", () => {
  const participants = Array.from({ length: 5 }, (_, index) => ({ key: `maker:${index}`, seat: null }));
  const layout = officeLayout(participants);
  assert.ok(distinctPoints(layout.stations.map((station) => station.desk.point)));
  assert.deepEqual(layout.desks.filter((desk) => desk.seat === null).map((desk) => desk.occupants), [3, 2]);
});
