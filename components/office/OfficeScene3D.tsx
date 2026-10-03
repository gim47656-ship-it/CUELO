"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  OFFICE_ENTRANCE,
  OFFICE_LOUNGE,
  officeRestKey,
  stepToward,
  type FloorPoint,
  type OfficeLayout,
  type OfficePlace,
  type OfficeRestPlace,
  type OfficeStagePlan,
  type OfficeStation,
} from "@/lib/office/office-stage";
import {
  CHARACTER_BUBBLE_Y,
  CHARACTER_HEIGHT,
  OFFICE_APPEARANCES,
  SEATED_HIP,
  UNKNOWN_APPEARANCE,
  buildCharacter,
  createCharacterKit,
  disposeCharacter,
  poseCharacter,
  type CharacterKit,
  type CharacterPose,
  type CharacterRig,
} from "./OfficeCharacter";
import { OFFICE_KIT_URL, buildAssetRoom } from "./OfficeRoomAssets";

/** 참여자 캐릭터의 지금 움직임. 말풍선 문구와 보조 기술 안내가 이 값을 그대로 읽는다. */
export type OfficeMotion = "toDesk" | "toLounge" | "work" | "atDesk" | "slump" | "idle" | "wave";

/** 장면에 세우는 참여자 하나. `seat` 는 겉모습을 고르는 캐릭터 자리 번호(모르면 null)다. */
export interface OfficeSceneParticipant {
  key: string;
  seat: number | null;
  plan: OfficeStagePlan;
  /** 대화 칸이 이 참여자를 보여 주는 중인지. 발밑 고리로 강조한다. */
  selected: boolean;
}

/** 말풍선 DOM. 장면이 매 프레임 그 캐릭터 머리 위 화면 좌표로 옮긴다(React 렌더 없이). */
export type OfficeBubbleRegistry = Map<string, HTMLElement>;

const WALK_SPEED = 1.15;
const TURN_RATE = 7;
const FACING_TOLERANCE = 0.12;
const SIT_SECONDS = 0.45;
const PACE_PAUSE = 2.6;
const BLEND_RATE = 8;
const DESK_HEIGHT = 0.42;
const DESK_DEPTH = 0.5;
/** 옆자리와 말풍선을 엇갈릴 때 한 칸 높이(m). */
const BUBBLE_LIFT = 0.42;
/** 말풍선·이름표가 무대 가장자리와 서로에게서 띄우는 간격(px). */
const BUBBLE_MARGIN = 4;
/** 참여자 말풍선 꼬리(`.bubble::after`)가 아래로 내려오는 길이(px). */
const BUBBLE_TAIL = 6;

const CAMERA_TARGET = new THREE.Vector3(-0.15, 0.35, 0.2);
const CAMERA_OFFSET = new THREE.Vector3(1.2, 4.9, 8.2);
/**
 * 화면에 늘 들어와야 하는 상자의 꼭짓점: 휴게 구역 왼쪽 끝부터 오른쪽 책상까지, 뒷줄 의자부터 앞쪽
 * 러그까지, 바닥부터 머리 높이까지. 대화 칸을 열어 무대가 좁아져도 휴게 구역이 잘리지 않는다.
 */
const CAMERA_FRAME: readonly THREE.Vector3[] = [-3.95, 3.4].flatMap((x) => [0, 1.15].flatMap((y) => [-2, 3].map((z) => new THREE.Vector3(x, y, z))));
/** 꼭짓점이 화면 끝에서 띄울 몫(NDC). */
const CAMERA_FRAME_EDGE = 0.94;
const CAMERA_DISTANCE_MAX = 2.6;

function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

type Phase = "walk" | "turn" | "pose" | "sitDown" | "seated" | "standUp";

function motionOf(phase: Phase, plan: OfficeStagePlan): OfficeMotion {
  if (phase === "walk") return plan.spot === "desk" ? "toDesk" : "toLounge";
  if (phase === "sitDown" || phase === "seated") return "work";
  if (phase === "standUp") return plan.spot === "desk" ? "atDesk" : "toLounge";
  if (plan.spot === "desk") return plan.pose === "slump" ? "slump" : "atDesk";
  return plan.pose === "wave" ? "wave" : "idle";
}

/** 장면 하나가 함께 쓰는 것: 도형·재질, 머리 위치(말풍선용), 퇴장한 캐릭터의 마지막 자리. */
interface SceneShared {
  kit: CharacterKit;
  /** 말풍선을 붙일 머리, 옆자리와 엇갈리게 더 올릴 칸 수, 휴게 구역 이름표인지. */
  heads: Map<string, { head: THREE.Object3D; lift: number; rest: boolean }>;
  /** 같은 캐릭터가 참여자↔휴게 구역으로 바뀔 때 그 자리에서 이어 걷게 한다. */
  departed: Map<number, { point: FloorPoint; heading: number }>;
  reducedMotion: { current: boolean };
}

/**
 * 무대 비율이 바뀌면(대화 칸이 열리거나 작은 화면) `CAMERA_FRAME` 이 다 들어오는 가장 가까운 거리로
 * 카메라를 옮긴다. 넓은 화면의 기본 거리(1)보다 가까이 가지는 않는다.
 */
function CameraRig() {
  const camera = useThree((state) => state.camera);
  const aspect = useThree((state) => state.size.width / Math.max(state.size.height, 1));
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
    const point = new THREE.Vector3();
    const place = (distance: number) => {
      camera.position.copy(CAMERA_OFFSET).multiplyScalar(distance).add(CAMERA_TARGET);
      camera.lookAt(CAMERA_TARGET);
      camera.updateMatrixWorld();
      return CAMERA_FRAME.every((corner) => {
        point.copy(corner).project(camera);
        return Math.abs(point.x) <= CAMERA_FRAME_EDGE && Math.abs(point.y) <= CAMERA_FRAME_EDGE;
      });
    };
    let near = 1;
    let far = CAMERA_DISTANCE_MAX;
    if (!place(near)) {
      for (let step = 0; step < 14; step += 1) {
        const middle = (near + far) / 2;
        if (place(middle)) far = middle;
        else near = middle;
      }
      place(far);
    }
    invalidate();
  }, [aspect, camera, invalidate]);
  return null;
}

/** 가운데로 당기되, 칸이 말풍선보다 좁으면 가운데에 둔다. */
function clamp(value: number, min: number, max: number): number {
  return max < min ? (min + max) / 2 : Math.min(max, Math.max(min, value));
}

interface PlacedRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 이름표 바닥을 `start` 에서 시작해 겹치는 칸을 하나씩 넘어 위(`up`) 또는 아래로 옮긴다. 겹치지 않는
 * 바닥 높이를, 무대 위·아래 끝을 넘으면 null 을 돌려준다. `rect` 는 그 자리로 고쳐 둔다.
 */
function settleTag(rect: PlacedRect, placed: readonly PlacedRect[], start: number, up: boolean, height: number, highest: number, lowest: number): number | null {
  let at = start;
  for (let guard = 0; guard <= placed.length; guard += 1) {
    rect.top = at - height;
    rect.bottom = at;
    const hit = placed.find((other) => rect.left < other.right && other.left < rect.right && rect.top < other.bottom && other.top < rect.bottom);
    if (!hit) return at;
    at = up ? hit.top - BUBBLE_MARGIN : hit.bottom + BUBBLE_MARGIN + height;
    if (at < highest || at > lowest) return null;
  }
  return null;
}

/** 휴게 이름표가 머리 위 세로줄 말고 좌우로 이름표 폭만큼씩 비켜 볼 칸 수(한쪽). */
const TAG_SIDE_STEPS = 3;

/**
 * 휴게 구역 이름표 자리. 머리 위 세로줄과 좌우 줄마다 위로(막히면 아래로) 비켜 선 빈자리를 찾고,
 * 그중 머리에서 가장 가까운 자리의 중심 x·바닥 y 를 돌려준다. 같은 거리면 머리 위 줄이 이긴다 —
 * 넓은 참여자 말풍선이 머리 위를 막으면 말풍선 꼭대기로 멀리 밀려나기보다 머리 높이 옆 칸에 선다.
 * 무대 어디에도 자리가 없을 때만 머리 위(겹침)로 돌아간다.
 */
function placeTag(
  placed: readonly PlacedRect[],
  blocked: readonly PlacedRect[],
  anchor: { x: number; y: number },
  box: { width: number; height: number },
  stage: { width: number; height: number },
): { x: number; y: number } {
  const half = box.width / 2;
  const lowest = stage.height - BUBBLE_MARGIN;
  const rect: PlacedRect = { left: 0, right: 0, top: 0, bottom: 0 };
  let best: { x: number; y: number; cost: number } | null = null;
  const home = clamp(anchor.x, half + BUBBLE_MARGIN, stage.width - half - BUBBLE_MARGIN);
  for (let step = 0; step <= TAG_SIDE_STEPS * 2; step += 1) {
    // 0, -1, +1, -2, +2 … 순서로 옆 줄을 본다.
    const offset = step === 0 ? 0 : (step % 2 === 1 ? -1 : 1) * Math.ceil(step / 2) * (box.width + BUBBLE_MARGIN);
    const x = clamp(home + offset, half + BUBBLE_MARGIN, stage.width - half - BUBBLE_MARGIN);
    if (step > 0 && Math.abs(x - home) < 1) continue;
    let highest = box.height + BUBBLE_MARGIN;
    for (const area of blocked) {
      if (x - half < area.right && area.left < x + half) highest = Math.max(highest, area.bottom + BUBBLE_MARGIN + box.height);
    }
    const start = clamp(anchor.y, highest, lowest);
    rect.left = x - half;
    rect.right = x + half;
    // 같은 줄에서는 위(머리 위)를 먼저 쓰고, 위가 막힌 때만 아래로 간다.
    const y = settleTag(rect, placed, start, true, box.height, highest, lowest) ?? settleTag(rect, placed, start, false, box.height, highest, lowest);
    if (y !== null) {
      const cost = Math.abs(x - anchor.x) + Math.abs(y - anchor.y);
      if (!best || cost < best.cost) best = { x, y, cost };
    }
  }
  return best ?? { x: home, y: clamp(anchor.y, box.height + BUBBLE_MARGIN, lowest) };
}

/**
 * 머리 위 말풍선 자리를 매 프레임 화면 좌표로 옮긴다. 첫 프레임을 그린 뒤 준비됐다고 알린다.
 * 말풍선은 무대 안으로 당겨 가장자리에서 잘리거나 아래 참여자 줄에 걸치지 않고, 머리글·닫기 버튼
 * (`reserved`) 밑으로 들어가 가려지지 않는다. 휴게 구역 이름표는 서로·참여자 말풍선과 겹치면
 * 겹치지 않는 높이까지 위로(막히면 아래로) 비켜 선다.
 */
function BubbleProjector({ shared, bubbles, reserved, onReady }: {
  shared: SceneShared;
  bubbles: OfficeBubbleRegistry;
  reserved: OfficeBubbleRegistry;
  onReady: () => void;
}) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);
  const scratch = useMemo(() => ({
    point: new THREE.Vector3(),
    written: new Map<string, string>(),
    /** 말풍선 크기. 매 프레임 레이아웃을 읽지 않게 ResizeObserver 가 바뀔 때만 채운다. */
    sizes: new Map<Element, { width: number; height: number }>(),
    observer: null as ResizeObserver | null,
    items: [] as { key: string; element: HTMLElement; x: number; y: number; depth: number; width: number; height: number; rest: boolean }[],
    placed: [] as PlacedRect[],
    blocked: [] as PlacedRect[],
    ready: false,
  }), []);
  useEffect(() => {
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize?.[0];
        const element = entry.target as HTMLElement;
        scratch.sizes.set(element, box ? { width: box.inlineSize, height: box.blockSize } : { width: element.offsetWidth, height: element.offsetHeight });
      }
      invalidate();
    });
    scratch.observer = observer;
    return () => {
      observer?.disconnect();
      scratch.observer = null;
      scratch.sizes.clear();
      scratch.written.clear();
    };
  }, [invalidate, scratch]);
  useFrame(() => {
    // 머리글·닫기 버튼 자리. 이 프레임의 말풍선 쓰기 전에 읽어 강제 레이아웃이 생기지 않는다.
    const blocked = scratch.blocked;
    blocked.length = 0;
    for (const element of reserved.values()) {
      const left = element.offsetLeft;
      const top = element.offsetTop;
      blocked.push({ left, top, right: left + element.offsetWidth, bottom: top + element.offsetHeight });
    }
    const items = scratch.items;
    items.length = 0;
    for (const [key, anchor] of shared.heads) {
      const element = bubbles.get(key);
      if (!element) continue;
      let box = scratch.sizes.get(element);
      if (!box) {
        box = { width: element.offsetWidth, height: element.offsetHeight };
        scratch.sizes.set(element, box);
        scratch.observer?.observe(element);
      }
      anchor.head.getWorldPosition(scratch.point);
      scratch.point.y += CHARACTER_BUBBLE_Y - CHARACTER_HEIGHT + 0.22 + anchor.lift * BUBBLE_LIFT;
      scratch.point.project(camera);
      items.push({
        key,
        element,
        x: ((scratch.point.x + 1) / 2) * size.width,
        y: ((1 - scratch.point.y) / 2) * size.height,
        depth: scratch.point.z,
        width: box.width,
        height: box.height,
        rest: anchor.rest,
      });
    }
    // 참여자 말풍선을 먼저 두고, 이름표는 앞(화면 아래)에 선 캐릭터부터 비켜 세운다.
    items.sort((a, b) => (a.rest === b.rest ? (a.rest ? b.y - a.y : 0) : a.rest ? 1 : -1));
    const placed = scratch.placed;
    placed.length = 0;
    for (const item of items) {
      const tail = item.rest ? 0 : BUBBLE_TAIL;
      const half = item.width / 2;
      let x = clamp(item.x, half + BUBBLE_MARGIN, size.width - half - BUBBLE_MARGIN);
      let y: number;
      if (item.rest) {
        ({ x, y } = placeTag(placed, blocked, item, item, size));
      } else {
        // 같은 세로줄에 머리글·닫기 버튼이 있으면 그 아래까지만 올라간다.
        let highest = item.height + BUBBLE_MARGIN;
        for (const area of blocked) {
          if (x - half < area.right && area.left < x + half) highest = Math.max(highest, area.bottom + BUBBLE_MARGIN + item.height);
        }
        y = clamp(item.y, highest, size.height - BUBBLE_MARGIN - tail);
      }
      placed.push({ left: x - half, right: x + half, top: y - item.height, bottom: y + tail });
      const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      if (scratch.written.get(item.key) === transform) continue;
      scratch.written.set(item.key, transform);
      item.element.style.transform = transform;
      // 카메라에 가까운 캐릭터의 말풍선이 위로 온다.
      item.element.style.zIndex = String(Math.round((1 - item.depth) * 10000));
      item.element.dataset.placed = "true";
    }
    if (!scratch.ready) {
      scratch.ready = true;
      onReady();
    }
  });
  return null;
}

function Desk({ x, z, width, cushion, chairs, lit }: {
  x: number;
  z: number;
  width: number;
  cushion: string;
  /** 앉는 자리들(책상 뒤). 비어 있으면 의자 하나를 책상 밑에 넣어 둔다. */
  chairs: readonly { x: number; z: number; key: string }[];
  lit: ReadonlyMap<string, boolean>;
}) {
  const legX = width / 2 - 0.05;
  const legZ = DESK_DEPTH / 2 - 0.05;
  const seats = chairs.length > 0 ? chairs : [{ x, z: z - 0.3, key: "" }];
  return (
    <group>
      <mesh position={[x, DESK_HEIGHT, z]}>
        <boxGeometry args={[width, 0.04, DESK_DEPTH]} />
        <meshStandardMaterial color="#b48a62" roughness={0.7} />
      </mesh>
      {[[-legX, -legZ], [legX, -legZ], [-legX, legZ], [legX, legZ]].map(([dx, dz]) => (
        <mesh key={`${dx}:${dz}`} position={[x + dx, DESK_HEIGHT / 2, z + dz]}>
          <boxGeometry args={[0.04, DESK_HEIGHT, 0.04]} />
          <meshStandardMaterial color="#5b4a3b" />
        </mesh>
      ))}
      {seats.map((seat) => {
        const on = seat.key ? lit.get(seat.key) === true : false;
        const open = seat.key !== "";
        return (
          <group key={seat.key || "tucked"}>
            {/* 노트북: 앉는 사람 쪽으로 화면이 열린다. 일하는 동안만 화면과 뚜껑 표시등이 켜진다. */}
            <group position={[seat.x, DESK_HEIGHT + 0.025, seat.z + 0.3]}>
              <mesh>
                <boxGeometry args={[0.3, 0.012, 0.2]} />
                <meshStandardMaterial color="#3a3e45" />
              </mesh>
              {open ? (
                <group position={[0, 0.005, 0.1]} rotation-x={-0.25}>
                  <mesh position={[0, 0.1, 0]}>
                    <boxGeometry args={[0.3, 0.2, 0.012]} />
                    <meshStandardMaterial color="#3a3e45" />
                  </mesh>
                  <mesh position={[0, 0.1, -0.007]} rotation-y={Math.PI}>
                    <planeGeometry args={[0.27, 0.17]} />
                    <meshStandardMaterial color={on ? "#a8d8ff" : "#1f2329"} emissive={on ? "#5fb2ff" : "#000000"} emissiveIntensity={on ? 0.9 : 0} />
                  </mesh>
                  <mesh position={[0, 0.11, 0.007]}>
                    <circleGeometry args={[0.025, 16]} />
                    <meshStandardMaterial color={on ? "#cfe9ff" : "#565b63"} emissive={on ? "#7cc4ff" : "#000000"} emissiveIntensity={on ? 1.2 : 0} />
                  </mesh>
                </group>
              ) : (
                <mesh position={[0, 0.012, 0]}>
                  <boxGeometry args={[0.3, 0.012, 0.2]} />
                  <meshStandardMaterial color="#4a4f57" />
                </mesh>
              )}
            </group>
            {/* 의자: 좌판은 앉은 엉덩이 바로 밑, 등받이는 뒤쪽. 쿠션은 책상 주인의 머리색이다. */}
            <group position={[seat.x, 0, seat.z - (open ? 0.06 : 0)]}>
              <mesh position={[0, SEATED_HIP - 0.05, 0]}>
                <boxGeometry args={[0.36, 0.05, 0.34]} />
                <meshStandardMaterial color={cushion} roughness={0.85} />
              </mesh>
              <mesh position={[0, SEATED_HIP + 0.17, -0.18]}>
                <boxGeometry args={[0.36, 0.38, 0.04]} />
                <meshStandardMaterial color={cushion} roughness={0.85} />
              </mesh>
              <mesh position={[0, (SEATED_HIP - 0.05) / 2, 0]}>
                <cylinderGeometry args={[0.025, 0.025, SEATED_HIP - 0.05, 8]} />
                <meshStandardMaterial color="#2f3236" />
              </mesh>
            </group>
          </group>
        );
      })}
    </group>
  );
}

/**
 * 코드 도형으로 그린 바닥·벽·문·러그·책상·휴게 구역. 에셋 키트 방(`OfficeRoom`)이 키트를 받기 전이나 받지
 * 못했을 때 그 자리에 그린다. 책상 수와 길이는 배치(`OfficeLayout`)를 그대로 따른다.
 */
function Room({ layout, lit }: { layout: OfficeLayout; lit: ReadonlyMap<string, boolean> }) {
  // 책상마다 앉는 자리들.
  const stationsByDesk = useMemo(() => layout.desks.map((_, index) => layout.stations
    .filter((station) => station.deskIndex === index)
    .map((station) => ({ x: station.desk.point.x, z: station.desk.point.z, key: station.key }))), [layout]);
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, 0.15]}>
        <planeGeometry args={[8.4, 5.9]} />
        <meshStandardMaterial color="#ddd6ca" roughness={0.95} />
      </mesh>
      <mesh position={[0, 1.2, -2.85]}>
        <boxGeometry args={[8.4, 2.4, 0.1]} />
        <meshStandardMaterial color="#ece7dd" roughness={1} />
      </mesh>
      <mesh position={[-4.25, 1.2, 0.15]}>
        <boxGeometry args={[0.1, 2.4, 6]} />
        <meshStandardMaterial color="#e3ddd1" roughness={1} />
      </mesh>
      {/* 문 */}
      <mesh position={[-4.195, 0.95, OFFICE_ENTRANCE.z]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[0.9, 1.9]} />
        <meshStandardMaterial color="#8a7a66" roughness={0.8} />
      </mesh>
      {/* 참여자가 쉬는 러그 */}
      <mesh rotation-x={-Math.PI / 2} position={[0.3, 0.004, 1.85]}>
        <circleGeometry args={[1.25, 48]} />
        <meshStandardMaterial color="#c3ccbd" roughness={1} />
      </mesh>
      {/* 휴게 구역: 바닥 깔개·소파·암체어·탕비 탁자와 스툴·카운터. 참여하지 않은 캐릭터가 여기서 쉰다. */}
      <mesh rotation-x={-Math.PI / 2} position={[-2.95, 0.004, 1.9]}>
        <planeGeometry args={[2.4, 2.3]} />
        <meshStandardMaterial color="#e8d9c2" roughness={1} />
      </mesh>
      {[
        { x: OFFICE_LOUNGE.couch.x, z: OFFICE_LOUNGE.couch.z, width: OFFICE_LOUNGE.couchWidth },
        { x: OFFICE_LOUNGE.armchair.x, z: OFFICE_LOUNGE.armchair.z, width: 0.75 },
      ].map((seat) => (
        <group key={seat.x} position={[seat.x, 0, seat.z]}>
          <mesh position={[0, SEATED_HIP - 0.07, 0.12]}>
            <boxGeometry args={[seat.width - 0.2, 0.14, 0.42]} />
            <meshStandardMaterial color="#8c9a8a" roughness={0.9} />
          </mesh>
          <mesh position={[0, SEATED_HIP + 0.12, -0.12]}>
            <boxGeometry args={[seat.width - 0.2, 0.42, 0.12]} />
            <meshStandardMaterial color="#7d8b7b" roughness={0.9} />
          </mesh>
          {[-1, 1].map((side) => (
            <mesh key={side} position={[side * (seat.width / 2 - 0.05), SEATED_HIP, 0.06]}>
              <boxGeometry args={[0.1, 0.3, 0.5]} />
              <meshStandardMaterial color="#7d8b7b" roughness={0.9} />
            </mesh>
          ))}
        </group>
      ))}
      <group position={[OFFICE_LOUNGE.table.x, 0, OFFICE_LOUNGE.table.z]}>
        <mesh position={[0, 0.36, 0]}>
          <cylinderGeometry args={[0.28, 0.28, 0.04, 20]} />
          <meshStandardMaterial color="#b48a62" roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.17, 0]}>
          <cylinderGeometry args={[0.04, 0.06, 0.34, 10]} />
          <meshStandardMaterial color="#5b4a3b" />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * OFFICE_LOUNGE.stool, (SEATED_HIP - 0.05) / 2, 0]}>
            <cylinderGeometry args={[0.13, 0.11, SEATED_HIP - 0.05, 14]} />
            <meshStandardMaterial color="#8c9a8a" roughness={0.9} />
          </mesh>
        ))}
      </group>
      <mesh position={[-3.86, 0.23, OFFICE_LOUNGE.counter.z]}>
        <boxGeometry args={[0.7, 0.46, 1.5]} />
        <meshStandardMaterial color="#d9cfc0" roughness={0.8} />
      </mesh>
      {layout.desks.map((desk, index) => (
        <Desk
          key={`${desk.seat ?? "guest"}:${index}`}
          x={desk.center.x}
          z={desk.center.z}
          width={desk.width}
          cushion={desk.seat === null ? "#9aa0a8" : OFFICE_APPEARANCES[desk.seat % OFFICE_APPEARANCES.length].hair}
          chairs={stationsByDesk[index]}
          lit={lit}
        />
      ))}
    </group>
  );
}

/** 받은 키트(GLB 장면)의 도형·재질·텍스처를 반납한다. 키트에서 복제한 방은 이것들을 함께 쓴다. */
function disposeKit(kit: THREE.Object3D): void {
  kit.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (material instanceof THREE.MeshStandardMaterial) material.map?.dispose();
      material.dispose();
    }
  });
}

/**
 * 사무실 방. 장면이 뜰 때 에셋 키트(`public/office3d/office-kit.glb`)를 받아 그 모델로 방을 짓는다.
 * 받는 동안과 받지 못했을 때는 코드 도형 방을 그린다 — 키트 실패는 장면 실패가 아니다. 키트는 이
 * 장면이 내려갈 때 함께 반납하고, 오피스를 열기 전에는 받지 않는다.
 */
function OfficeRoom({ layout, lit }: { layout: OfficeLayout; lit: ReadonlyMap<string, boolean> }) {
  const invalidate = useThree((state) => state.invalidate);
  const [kit, setKit] = useState<THREE.Object3D | null>(null);
  useEffect(() => {
    let alive = true;
    let loaded: THREE.Object3D | null = null;
    new GLTFLoader().loadAsync(OFFICE_KIT_URL).then(
      (gltf) => {
        loaded = gltf.scene;
        if (!alive) {
          disposeKit(gltf.scene);
          return;
        }
        setKit(gltf.scene);
        invalidate();
      },
      (error: unknown) => console.warn("[office] office kit failed; keeping the drawn room", error),
    );
    return () => {
      alive = false;
      if (loaded) disposeKit(loaded);
    };
  }, [invalidate]);
  const room = useMemo(
    () => (kit ? buildAssetRoom(kit, layout, (seat) => OFFICE_APPEARANCES[seat % OFFICE_APPEARANCES.length].hair) : null),
    [kit, layout],
  );
  useEffect(() => () => room?.dispose(), [room]);
  useEffect(() => {
    room?.setLit(lit);
    invalidate();
  }, [invalidate, lit, room]);
  return room ? <primitive object={room.group} /> : <Room layout={layout} lit={lit} />;
}

interface ActorProps {
  actorKey: string;
  seat: number | null;
  shared: SceneShared;
  /** 참여자는 배치 자리와 계획, 휴게 구역 캐릭터는 휴게 자리. */
  target: { kind: "participant"; station: OfficeStation; plan: OfficeStagePlan } | { kind: "rest"; place: OfficeRestPlace };
  selected: boolean;
  onSelect?: () => void;
  onHover: (key: string | null) => void;
  onMotionChange?: (motion: OfficeMotion) => void;
}

/**
 * 캐릭터 한 명. 걷기·돌기·앉기·서기를 코드로 섞는다. 참여자만 누를 수 있고, 휴게 구역 캐릭터를
 * 눌러도 아무것도 열리지 않는다.
 */
function Actor({ actorKey, seat, shared, target, selected, onSelect, onHover, onMotionChange }: ActorProps) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const rig = useMemo<CharacterRig>(() => {
    const look = seat === null ? UNKNOWN_APPEARANCE : OFFICE_APPEARANCES[seat % OFFICE_APPEARANCES.length];
    return buildCharacter(shared.kit, look, seat === null);
  }, [seat, shared.kit]);
  const body = useRef<THREE.Group>(null);
  const targetRef = useRef(target);
  const start = target.kind === "rest" ? target.place.point : OFFICE_ENTRANCE;
  const sim = useRef({
    point: { ...start } as FloorPoint,
    heading: 0,
    phase: (target.kind === "rest" ? "pose" : "walk") as Phase,
    sit: 0,
    walkPhase: 0,
    blend: { walk: 0, type: 0, wave: 0, slump: 0 },
    paceLeg: 0,
    paceWait: PACE_PAUSE * ((seat ?? 0) % 3) / 3,
    motion: null as OfficeMotion | null,
    time: (seat ?? 7) * 1.37,
  });

  useEffect(() => {
    targetRef.current = target;
    invalidate();
  }, [target, invalidate]);

  const bubbleLift = target.kind === "participant" ? target.station.bubbleLift : 0;
  const rest = target.kind === "rest";
  // 같은 캐릭터가 방금 다른 역할로 이 방을 떠났으면 그 자리에서 이어 걷는다. 지울 때는 반대로
  // 마지막 자리를 남긴다. 레이아웃 효과라 같은 커밋의 퇴장 정리가 먼저 돈다.
  useLayoutEffect(() => {
    const state = sim.current;
    if (seat !== null) {
      const from = shared.departed.get(seat);
      if (from) {
        shared.departed.delete(seat);
        state.point = { ...from.point };
        state.heading = from.heading;
        state.phase = "walk";
      }
    }
    shared.heads.set(actorKey, { head: rig.head, lift: bubbleLift, rest });
    return () => {
      shared.heads.delete(actorKey);
      if (seat !== null) shared.departed.set(seat, { point: { ...state.point }, heading: state.heading });
    };
  }, [actorKey, bubbleLift, rest, rig, seat, shared]);

  // 이 캐릭터만 쓰는 합친 도형은 캐릭터가 바뀌거나 내려갈 때 반납한다.
  useEffect(() => () => disposeCharacter(rig), [rig]);
  useEffect(() => () => { gl.domElement.style.cursor = ""; }, [gl]);

  useFrame((frame, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const reduced = shared.reducedMotion.current;
    const state = sim.current;
    state.time += delta;
    const current = targetRef.current;
    let place: OfficePlace;
    let pose: OfficeStagePlan["pose"];
    if (current.kind === "participant") {
      place = current.plan.spot === "desk" ? current.station.desk : current.station.lounge;
      pose = current.plan.pose;
    } else {
      const rest = current.place;
      pose = rest.pose;
      const away = rest.to && state.paceLeg === 1 && !reduced;
      place = { point: away ? rest.to! : rest.point, facing: rest.facing };
    }
    const seatWanted = pose === "work" || pose === "sofa";
    const sitStep = reduced ? 1 : delta / SIT_SECONDS;
    let settled = false;

    if (state.phase === "sitDown" || state.phase === "seated") {
      if (!seatWanted) {
        state.phase = "standUp";
      } else if (state.phase === "sitDown") {
        state.sit = Math.min(1, state.sit + sitStep);
        if (state.sit >= 1) state.phase = "seated";
      } else {
        settled = true;
      }
    } else if (state.phase === "standUp") {
      state.sit = Math.max(0, state.sit - sitStep);
      if (state.sit <= 0) state.phase = "walk";
    } else {
      const step = stepToward(state.point, place.point, reduced ? Infinity : WALK_SPEED * delta);
      if (!step.arrived) {
        const want = Math.atan2(step.point.x - state.point.x, step.point.z - state.point.z);
        state.heading += angleDelta(state.heading, want) * Math.min(1, TURN_RATE * delta);
        state.point = step.point;
        state.phase = "walk";
        state.walkPhase += delta * 9;
      } else {
        state.point = step.point;
        const turn = angleDelta(state.heading, place.facing);
        if (Math.abs(turn) > FACING_TOLERANCE && !reduced) {
          state.heading += turn * Math.min(1, TURN_RATE * delta);
          state.phase = "turn";
        } else {
          state.heading = place.facing;
          if (seatWanted) {
            state.phase = "sitDown";
          } else {
            state.phase = "pose";
            if (pose === "pace" && !reduced) {
              state.paceWait -= delta;
              if (state.paceWait <= 0) {
                state.paceWait = PACE_PAUSE;
                state.paceLeg = state.paceLeg === 1 ? 0 : 1;
              }
            } else {
              settled = true;
            }
          }
        }
      }
    }

    const k = reduced ? 1 : Math.min(1, delta * BLEND_RATE);
    const blend = state.blend;
    blend.walk += ((state.phase === "walk" ? 1 : 0) - blend.walk) * k;
    blend.type += ((state.phase === "seated" && pose === "work" ? 1 : 0) - blend.type) * k;
    blend.wave += ((state.phase === "pose" && pose === "wave" ? 1 : 0) - blend.wave) * k;
    blend.slump += ((state.phase === "pose" && pose === "slump" ? 1 : 0) - blend.slump) * k;
    const characterPose: CharacterPose = {
      walkPhase: state.walkPhase,
      walk: blend.walk,
      sit: state.sit,
      type: blend.type,
      wave: blend.wave,
      slump: blend.slump,
      breathe: reduced ? 0 : 1,
    };
    poseCharacter(rig, characterPose, state.time);
    if (body.current) {
      body.current.position.set(state.point.x, 0, state.point.z);
      body.current.rotation.y = state.heading;
    }
    if (current.kind === "participant" && onMotionChange) {
      const motion = motionOf(state.phase, current.plan);
      if (motion !== state.motion) {
        state.motion = motion;
        onMotionChange(motion);
      }
    }
    // reduced motion 이면 장면이 요청할 때만 그린다. 아직 자리를 잡는 중이면 다음 프레임을 부른다.
    if (reduced && !settled) frame.invalidate();
  });

  return (
    <group ref={body}>
      <primitive object={rig.root} />
      {/* 발밑 그림자와 선택 고리. 실제 그림자 대신 가벼운 원판 하나다. */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.01, 0]}>
        <circleGeometry args={[0.26, 28]} />
        <meshBasicMaterial color="#000000" transparent opacity={target.kind === "rest" ? 0.1 : 0.16} depthWrite={false} />
      </mesh>
      {selected && (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.015, 0]}>
          <ringGeometry args={[0.3, 0.37, 48]} />
          <meshBasicMaterial color="#ff6f0f" depthWrite={false} />
        </mesh>
      )}
      {/* 클릭 판정 상자. 움직이는 팔다리보다 안정적으로 맞고, 보이지 않는다. */}
      <mesh
        position={[0, CHARACTER_HEIGHT / 2, 0]}
        onClick={(event) => {
          event.stopPropagation();
          onSelect?.();
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          gl.domElement.style.cursor = onSelect ? "pointer" : "help";
          onHover(actorKey);
        }}
        onPointerOut={() => {
          gl.domElement.style.cursor = "";
          onHover(null);
        }}
      >
        <boxGeometry args={[0.5, CHARACTER_HEIGHT, 0.45]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

export interface OfficeScene3DProps {
  layout: OfficeLayout;
  participants: readonly OfficeSceneParticipant[];
  bubbles: OfficeBubbleRegistry;
  /** 말풍선이 밑으로 들어가면 안 되는 무대 위 DOM(머리글·닫기 버튼). 같은 무대 기준 좌표다. */
  reserved: OfficeBubbleRegistry;
  onSelect: (key: string) => void;
  onHover: (key: string | null) => void;
  onReady: () => void;
  onMotionChange: (key: string, motion: OfficeMotion) => void;
  onContextLost: () => void;
}

/**
 * 장면이 떠 있는 동안 잃은 WebGL 문맥만 실패로 알린다. 장면이 내려갈 때 R3F 가 일부러 문맥을
 * 반납(`forceContextLoss`)하는데, 그보다 먼저 이 정리가 돌아 귀를 뗀다 — 다시 그리기(Fast
 * Refresh·다시 시도)를 실패로 착각하지 않는다.
 */
function ContextLossWatch({ onContextLost }: { onContextLost: () => void }) {
  const canvas = useThree((state) => state.gl.domElement);
  useEffect(() => {
    canvas.addEventListener("webglcontextlost", onContextLost);
    return () => canvas.removeEventListener("webglcontextlost", onContextLost);
  }, [canvas, onContextLost]);
  return null;
}

function SceneContents({ layout, participants, bubbles, reserved, onSelect, onHover, onReady, onMotionChange }: Omit<OfficeScene3DProps, "onContextLost">) {
  const shared = useMemo<SceneShared>(() => ({
    kit: createCharacterKit(),
    heads: new Map(),
    departed: new Map(),
    reducedMotion: { current: typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches },
  }), []);
  useEffect(() => () => shared.kit.dispose(), [shared]);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (event: MediaQueryListEvent) => {
      shared.reducedMotion.current = event.matches;
      invalidate();
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [invalidate, shared]);

  const stations = useMemo(() => new Map(layout.stations.map((station) => [station.key, station])), [layout]);
  const lit = useMemo(
    () => new Map(participants.map((participant) => [participant.key, participant.plan.spot === "desk" && participant.plan.pose === "work"])),
    [participants],
  );
  // 콜백은 키마다 한 번 만든다. 매 렌더 새 함수면 Actor 의 대상 효과가 쓸데없이 다시 돈다.
  const handlers = useRef(new Map<string, { select: () => void; motion: (motion: OfficeMotion) => void }>());
  const latest = useRef({ onSelect, onMotionChange });
  latest.current = { onSelect, onMotionChange };
  const handlersFor = (key: string) => {
    let entry = handlers.current.get(key);
    if (!entry) {
      entry = {
        select: () => latest.current.onSelect(key),
        motion: (motion) => latest.current.onMotionChange(key, motion),
      };
      handlers.current.set(key, entry);
    }
    return entry;
  };

  return (
    <>
      <CameraRig />
      <hemisphereLight args={["#ffffff", "#b5a993", 1.7]} />
      <directionalLight position={[3, 6, 5]} intensity={1.5} />
      <OfficeRoom layout={layout} lit={lit} />
      {participants.map((participant) => {
        const station = stations.get(participant.key);
        if (!station) return null;
        const entry = handlersFor(participant.key);
        return (
          <ParticipantActor
            key={participant.key}
            participant={participant}
            station={station}
            shared={shared}
            onSelect={entry.select}
            onHover={onHover}
            onMotionChange={entry.motion}
          />
        );
      })}
      {layout.rest.map((place) => (
        <RestActor key={officeRestKey(place.seat)} place={place} shared={shared} onHover={onHover} />
      ))}
      <BubbleProjector shared={shared} bubbles={bubbles} reserved={reserved} onReady={onReady} />
    </>
  );
}

function ParticipantActor({ participant, station, shared, onSelect, onHover, onMotionChange }: {
  participant: OfficeSceneParticipant;
  station: OfficeStation;
  shared: SceneShared;
  onSelect: () => void;
  onHover: (key: string | null) => void;
  onMotionChange: (motion: OfficeMotion) => void;
}) {
  const { plan } = participant;
  const target = useMemo(
    () => ({ kind: "participant" as const, station, plan }),
    // 계획은 값으로 비교한다. 부모가 매 렌더 새 객체를 만들어도 같은 자리·동작이면 그대로다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [station, plan.spot, plan.pose],
  );
  return (
    <Actor
      actorKey={participant.key}
      seat={participant.seat}
      shared={shared}
      target={target}
      selected={participant.selected}
      onSelect={onSelect}
      onHover={onHover}
      onMotionChange={onMotionChange}
    />
  );
}

function RestActor({ place, shared, onHover }: { place: OfficeRestPlace; shared: SceneShared; onHover: (key: string | null) => void }) {
  const target = useMemo(() => ({ kind: "rest" as const, place }), [place]);
  return <Actor actorKey={officeRestKey(place.seat)} seat={place.seat} shared={shared} target={target} selected={false} onHover={onHover} />;
}

/**
 * 오피스 보기의 3D 사무실. 이 컴포넌트가 내려가면 Canvas 와 렌더 루프, 캐릭터 도형·재질도 함께
 * 반납한다 — 오피스를 닫거나 좁은 화면에서 대화 칸으로 넘어가면 AppShell 이 이 장면을 그리지 않는다.
 */
export default function OfficeScene3D({ onContextLost, ...contents }: OfficeScene3DProps) {
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <Canvas
      dpr={[1, 1.75]}
      frameloop={reduced ? "demand" : "always"}
      camera={{ fov: 36, near: 0.1, far: 60, position: CAMERA_OFFSET.clone().add(CAMERA_TARGET).toArray() }}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
    >
      <ContextLossWatch onContextLost={onContextLost} />
      <SceneContents {...contents} />
    </Canvas>
  );
}
