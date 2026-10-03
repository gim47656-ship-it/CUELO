import type { SubagentStatus } from "@/lib/types";
import type { OfficeMainState } from "./office-roster";

/**
 * 3D 사무실에서 누가 어디서 무엇을 하는지.
 *
 * 참여자의 자리와 동작은 관측한 상태에서만 나온다. Main 은 대화창이 알려 준 실행 상태
 * (`OfficeMainState`), Maker 는 런타임 status 그대로다. 책상에 앉아 일하는 모습은 실제로 실행
 * 중인 동안뿐이고, 실행 완료를 일하는 모습이나 수용으로 꾸미지 않는다. 이 세션에 참여하지 않은
 * 캐릭터는 책상이 아닌 휴게 구역에서 쉬기만 한다.
 */

/**
 * 머무는 곳. `desk` 는 그 실행의 책상 앞, `lounge` 는 참여자가 쉬는 러그, `rest` 는 참여하지
 * 않은 캐릭터의 휴게 구역이다.
 */
export type OfficeStageSpot = "desk" | "lounge" | "rest";

/**
 * 자리에 도착한 뒤의 동작. `work` 는 책상에 앉아 일하는 자세, `wave` 는 사용자를 부르는 손짓,
 * `slump` 은 실패 뒤 고개를 떨군 자세, `sofa`·`pace` 는 휴게 구역에서 앉아 쉬기·서성이기다.
 */
export type OfficeStagePose = "idle" | "work" | "wave" | "slump" | "sofa" | "pace";

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

/**
 * Maker 의 자리와 동작. 일하는 자세는 `running` 이면서 재시도 대기가 아닐 때뿐이다. 시작 전
 * (`pending`)·재시도 대기는 책상 곁에 서 있고, 실행 완료·중단은 쉬는 자리로 돌아간다 — 완료는
 * Main 의 수용이 아니므로 축하 동작 같은 것을 두지 않는다.
 */
export function officeMakerPlan(status: SubagentStatus, retrying: boolean): OfficeStagePlan {
  switch (status) {
    case "running":
      return retrying ? { spot: "desk", pose: "idle" } : { spot: "desk", pose: "work" };
    case "pending":
      return { spot: "desk", pose: "idle" };
    case "failed":
      return { spot: "desk", pose: "slump" };
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

// ---------- 배치 ----------

/** 자리 하나. `facing` 은 y 축 회전(rad)이며 0 이 카메라 쪽(+z)이다. */
export interface OfficePlace {
  point: FloorPoint;
  facing: number;
}

/** 책상 하나. 같은 캐릭터로 여러 실행이 참여하면 그 수만큼 옆으로 길어진다. */
export interface OfficeDesk {
  /** 캐릭터 자리 번호. 계정을 특정하지 못한 참여자의 공용 책상은 null. */
  seat: number | null;
  center: FloorPoint;
  width: number;
  /** 이 책상을 쓰는 참여자 수. 0 이면 주인이 참여하지 않은 빈 책상이다. */
  occupants: number;
}

/** 참여자 하나의 자리: 일하는 책상 앞, 쉬는 러그 위. */
export interface OfficeStation {
  key: string;
  seat: number | null;
  desk: OfficePlace;
  /** 앉는 책상의 `OfficeLayout.desks` 번호. */
  deskIndex: number;
  lounge: OfficePlace;
  /** 바로 옆 좌석과 말풍선이 겹치지 않게 머리 위로 더 올리는 칸 수(0 또는 1). */
  bubbleLift: number;
}

/** 참여하지 않은 캐릭터의 휴게 구역 자리. `pace` 면 `point` 와 `to` 사이를 오간다. */
export interface OfficeRestPlace {
  seat: number;
  pose: "sofa" | "pace";
  point: FloorPoint;
  facing: number;
  to: FloorPoint | null;
}

export interface OfficeLayout {
  desks: OfficeDesk[];
  stations: OfficeStation[];
  rest: OfficeRestPlace[];
}

/** 휴게 구역의 비참여 캐릭터 키. 참여자 키와 겹치지 않고, 이 키로는 아무것도 열리지 않는다. */
export function officeRestKey(seat: number): string {
  return `rest:${seat}`;
}

/** 문 앞. 새로 들어오는 참여자는 여기서 제 자리로 걸어간다. */
export const OFFICE_ENTRANCE: FloorPoint = { x: -3.6, z: -0.75 };

/** 자리 번호(얼굴 목록 순서)별 책상 위치. 뒷줄 넷, 앞줄 셋. */
const DESK_CENTERS: readonly FloorPoint[] = [
  { x: -2.85, z: -1.55 },
  { x: -0.95, z: -1.55 },
  { x: 0.95, z: -1.55 },
  { x: 2.85, z: -1.55 },
  { x: -1.9, z: 0.15 },
  { x: 0, z: 0.15 },
  { x: 1.9, z: 0.15 },
];
/** 캐릭터를 특정하지 못한 참여자의 공용 책상. */
const GUEST_DESK: FloorPoint = { x: 2.85, z: 1.75 };
/** 한 줄에 앉는 최대 인원. 넘치면 그 뒤에 줄을 하나 더 놓는다. */
const DESK_ROW = 3;
const SLOT_SPACING = 0.54;
const BASE_DESK_WIDTH = 1;
/** 책상 중심에서 앉는 자리까지(책상 뒤, 카메라 반대쪽). */
const DESK_TO_SEAT = 0.4;
const EXTRA_ROW_DEPTH = 0.62;

/** 참여자의 쉬는 러그. 이 칸들을 참여자 순서대로 채운다. */
const LOUNGE_ORIGIN: FloorPoint = { x: -0.55, z: 1.55 };
const LOUNGE_COLUMNS = 4;
const LOUNGE_SPACING = 0.55;
const LOUNGE_FACING = 0.35;

/**
 * 휴게 구역 가구 자리. 방 그림(에셋·도형 대체 모두)과 아래 휴게 자리가 이 값 하나를 함께 쓴다.
 * 소파(둘이 앉음)·암체어는 뒤쪽, 탕비 탁자와 스툴 둘은 앞쪽, 카운터는 왼벽에 붙는다.
 */
export const OFFICE_LOUNGE = {
  couch: { x: -3.2, z: 0.92 },
  couchWidth: 1.42,
  armchair: { x: -2.05, z: 0.92 },
  table: { x: -2.2, z: 2.55 },
  /** 탁자 중심에서 스툴까지(x). */
  stool: 0.5,
  /** 왼벽 카운터의 앞뒤 가운데(z). */
  counter: { z: 2.45 },
} as const;

/**
 * 휴게 구역. 소파 둘·암체어·스툴 둘에 앉고, 둘은 카운터 앞과 화분 옆을 짧게 오간다. 자리끼리
 * 앞뒤·좌우로 0.6m 넘게 떨어져 있고 서성이는 길이 서로 가로지르지 않는다 — 촘촘히 모이면 머리 위
 * 이름표가 화면에서 겹친다(이전 배치는 서성이는 넷이 0.3m 간격 줄에서 같은 구간을 오갔다).
 */
const REST_PLACES: readonly Omit<OfficeRestPlace, "seat">[] = [
  { pose: "sofa", point: { x: OFFICE_LOUNGE.couch.x - 0.33, z: OFFICE_LOUNGE.couch.z + 0.16 }, facing: 0, to: null },
  { pose: "sofa", point: { x: OFFICE_LOUNGE.couch.x + 0.33, z: OFFICE_LOUNGE.couch.z + 0.16 }, facing: 0, to: null },
  { pose: "sofa", point: { x: OFFICE_LOUNGE.armchair.x, z: OFFICE_LOUNGE.armchair.z + 0.16 }, facing: -0.3, to: null },
  { pose: "sofa", point: { x: OFFICE_LOUNGE.table.x - OFFICE_LOUNGE.stool, z: OFFICE_LOUNGE.table.z }, facing: Math.PI / 2, to: null },
  { pose: "sofa", point: { x: OFFICE_LOUNGE.table.x + OFFICE_LOUNGE.stool, z: OFFICE_LOUNGE.table.z }, facing: -Math.PI / 2, to: null },
  { pose: "pace", point: { x: -3.15, z: 2.05 }, facing: -Math.PI / 2, to: { x: -3.15, z: 2.95 } },
  { pose: "pace", point: { x: -1.2, z: 1.7 }, facing: 0.4, to: { x: -1.2, z: 2.4 } },
];

/** 한 책상에 k 번째로 앉는 실행의 자리. 가운데부터 좌우로 번갈아 붙는다. */
function slotOffset(index: number, count: number): { x: number; row: number } {
  const row = Math.floor(index / DESK_ROW);
  const inRow = Math.min(DESK_ROW, count - row * DESK_ROW);
  const column = index % DESK_ROW;
  return { x: (column - (inRow - 1) / 2) * SLOT_SPACING, row };
}

/**
 * 참여자와 캐릭터의 배치. 같은 캐릭터로 여러 실행(Main 과 같은 계정의 Maker, 같은 계정의 Maker
 * 여럿)이 참여하면 각각 제 좌석을 받는다. 캐릭터를 특정하지 못한 참여자는 어느 캐릭터 책상에도
 * 끼우지 않고 공용 책상에 앉힌다. 참여자가 하나도 없는 캐릭터만 휴게 구역에 자리를 받는다.
 */
export function officeLayout(
  participants: readonly { key: string; seat: number | null }[],
  seatCount: number = DESK_CENTERS.length,
): OfficeLayout {
  const bySeat = new Map<number | null, string[]>();
  for (const participant of participants) {
    const seat = participant.seat !== null && participant.seat >= 0 && participant.seat < seatCount ? participant.seat : null;
    const list = bySeat.get(seat) ?? [];
    list.push(participant.key);
    bySeat.set(seat, list);
  }

  const desks: OfficeDesk[] = [];
  const deskPlaces = new Map<string, { seat: number | null; place: OfficePlace; deskIndex: number; lift: number }>();
  const placeDesk = (seat: number | null, center: FloorPoint, keys: readonly string[]) => {
    const firstDesk = desks.length;
    const rows = Math.max(1, Math.ceil(keys.length / DESK_ROW));
    for (let row = 0; row < rows; row += 1) {
      const inRow = Math.min(DESK_ROW, keys.length - row * DESK_ROW);
      desks.push({
        seat,
        center: { x: center.x, z: center.z - row * EXTRA_ROW_DEPTH },
        width: Math.max(BASE_DESK_WIDTH, inRow * SLOT_SPACING + 0.2),
        occupants: Math.max(0, inRow),
      });
    }
    keys.forEach((key, index) => {
      const slot = slotOffset(index, keys.length);
      deskPlaces.set(key, {
        seat,
        place: { point: { x: center.x + slot.x, z: center.z - slot.row * EXTRA_ROW_DEPTH - DESK_TO_SEAT }, facing: 0 },
        deskIndex: firstDesk + slot.row,
        lift: index % 2,
      });
    });
  };

  for (let seat = 0; seat < seatCount; seat += 1) {
    placeDesk(seat, DESK_CENTERS[seat % DESK_CENTERS.length], bySeat.get(seat) ?? []);
  }
  const guests = bySeat.get(null) ?? [];
  if (guests.length > 0) placeDesk(null, GUEST_DESK, guests);

  const stations: OfficeStation[] = participants.map((participant, index) => {
    const desk = deskPlaces.get(participant.key)!;
    return {
      key: participant.key,
      seat: desk.seat,
      desk: desk.place,
      deskIndex: desk.deskIndex,
      bubbleLift: desk.lift,
      lounge: {
        point: {
          x: LOUNGE_ORIGIN.x + (index % LOUNGE_COLUMNS) * LOUNGE_SPACING,
          z: LOUNGE_ORIGIN.z + Math.floor(index / LOUNGE_COLUMNS) * LOUNGE_SPACING,
        },
        facing: LOUNGE_FACING,
      },
    };
  });

  const rest: OfficeRestPlace[] = [];
  for (let seat = 0; seat < seatCount; seat += 1) {
    if ((bySeat.get(seat) ?? []).length > 0) continue;
    rest.push({ seat, ...REST_PLACES[seat % REST_PLACES.length] });
  }
  return { desks, stations, rest };
}
