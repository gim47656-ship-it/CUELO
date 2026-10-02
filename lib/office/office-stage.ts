import type { OfficeMainState } from "./office-roster";

/**
 * 3D 사무실에서 Main 캐릭터가 어디서 무엇을 하는지.
 *
 * 자리와 동작은 대화창이 알려 준 Main 상태(`OfficeMainState`)에서만 나온다. 책상에 앉아 일하는
 * 모습은 실제로 응답을 만드는 동안(`working`)뿐이고, 그 밖의 상태를 작업처럼 꾸미지 않는다.
 */

/** Main 이 머무는 곳. `lounge` 는 쉬는 자리, `desk` 는 책상 앞이다. */
export type OfficeStageSpot = "lounge" | "desk";

/** 자리에 도착한 뒤의 동작. `work` 는 책상에 앉은 자세, `wave` 는 사용자를 부르는 손짓이다. */
export type OfficeStagePose = "idle" | "work" | "wave";

export interface OfficeStagePlan {
  spot: OfficeStageSpot;
  pose: OfficeStagePose;
}

export function officeMainPlan(state: OfficeMainState): OfficeStagePlan {
  switch (state) {
    case "working":
      return { spot: "desk", pose: "work" };
    case "waiting":
      // 실행 중이지만 다른 것을 기다리는 동안: 책상 곁에 서 있되 일하는 자세는 아니다.
      return { spot: "desk", pose: "idle" };
    case "attention":
      return { spot: "lounge", pose: "wave" };
    default:
      return { spot: "lounge", pose: "idle" };
  }
}

/** 바닥 위 좌표(m). y 는 늘 바닥이라 두지 않는다. */
export interface FloorPoint {
  x: number;
  z: number;
}

/**
 * 한 프레임 걸음. `maxStep` 만큼만 다가가고 목표를 지나치지 않는다 — 넘어서면 다음 프레임에
 * 되돌아오느라 제자리에서 떠는 모습이 된다.
 */
export function stepToward(from: FloorPoint, to: FloorPoint, maxStep: number): { point: FloorPoint; arrived: boolean } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= maxStep) return { point: { x: to.x, z: to.z }, arrived: true };
  const ratio = maxStep / distance;
  return { point: { x: from.x + dx * ratio, z: from.z + dz * ratio }, arrived: false };
}
