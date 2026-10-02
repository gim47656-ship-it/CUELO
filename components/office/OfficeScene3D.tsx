"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  OFFICE_ENTRANCE,
  OFFICE_SOFA,
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
  poseCharacter,
  type CharacterKit,
  type CharacterPose,
  type CharacterRig,
} from "./OfficeCharacter";

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

const CAMERA_TARGET = new THREE.Vector3(-0.15, 0.35, 0.2);
const CAMERA_OFFSET = new THREE.Vector3(1.2, 4.9, 8.2);

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
  /** 말풍선을 붙일 머리와, 옆자리와 엇갈리게 더 올릴 칸 수. */
  heads: Map<string, { head: THREE.Object3D; lift: number }>;
  /** 같은 캐릭터가 참여자↔휴게 구역으로 바뀔 때 그 자리에서 이어 걷게 한다. */
  departed: Map<number, { point: FloorPoint; heading: number }>;
  reducedMotion: { current: boolean };
}

/** 창 비율이 좁아지면(대화 칸이 열리거나 작은 화면) 방 전체가 들어오도록 카메라를 뒤로 뺀다. */
function CameraRig() {
  const camera = useThree((state) => state.camera);
  const aspect = useThree((state) => state.size.width / Math.max(state.size.height, 1));
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    const distance = aspect < 0.75 ? 1.75 : aspect < 1 ? 1.45 : aspect < 1.35 ? 1.18 : 1;
    camera.position.copy(CAMERA_OFFSET).multiplyScalar(distance).add(CAMERA_TARGET);
    camera.lookAt(CAMERA_TARGET);
    invalidate();
  }, [aspect, camera, invalidate]);
  return null;
}

/** 머리 위 말풍선 자리를 매 프레임 화면 좌표로 옮긴다. 첫 프레임을 그린 뒤 준비됐다고 알린다. */
function BubbleProjector({ shared, bubbles, onReady }: { shared: SceneShared; bubbles: OfficeBubbleRegistry; onReady: () => void }) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const scratch = useMemo(() => ({ point: new THREE.Vector3(), written: new Map<string, string>(), ready: false }), []);
  useFrame(() => {
    for (const [key, anchor] of shared.heads) {
      const element = bubbles.get(key);
      if (!element) continue;
      anchor.head.getWorldPosition(scratch.point);
      scratch.point.y += CHARACTER_BUBBLE_Y - CHARACTER_HEIGHT + 0.22 + anchor.lift * BUBBLE_LIFT;
      scratch.point.project(camera);
      const x = Math.round(((scratch.point.x + 1) / 2) * size.width);
      const y = Math.round(((1 - scratch.point.y) / 2) * size.height);
      const transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      if (scratch.written.get(key) === transform) continue;
      scratch.written.set(key, transform);
      element.style.transform = transform;
      // 카메라에 가까운 캐릭터의 말풍선이 위로 온다.
      element.style.zIndex = String(Math.round((1 - scratch.point.z) * 10000));
      element.dataset.placed = "true";
    }
    if (!scratch.ready) {
      scratch.ready = true;
      onReady();
    }
  });
  useEffect(() => () => scratch.written.clear(), [scratch]);
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

/** 바닥·벽·문·러그·책상·휴게 구역. 책상 수와 길이는 배치(`OfficeLayout`)를 그대로 따른다. */
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
      {/* 휴게 구역: 바닥 깔개·소파·화분. 참여하지 않은 캐릭터가 여기서 쉰다. */}
      <mesh rotation-x={-Math.PI / 2} position={[-2.95, 0.004, 2]}>
        <planeGeometry args={[2.3, 2.1]} />
        <meshStandardMaterial color="#e8d9c2" roughness={1} />
      </mesh>
      <group position={[OFFICE_SOFA.center.x, 0, OFFICE_SOFA.center.z]}>
        <mesh position={[0, SEATED_HIP - 0.07, 0.12]}>
          <boxGeometry args={[OFFICE_SOFA.width, 0.14, 0.42]} />
          <meshStandardMaterial color="#8c9a8a" roughness={0.9} />
        </mesh>
        <mesh position={[0, SEATED_HIP + 0.12, -0.12]}>
          <boxGeometry args={[OFFICE_SOFA.width, 0.42, 0.12]} />
          <meshStandardMaterial color="#7d8b7b" roughness={0.9} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * (OFFICE_SOFA.width / 2 + 0.05), SEATED_HIP, 0.06]}>
            <boxGeometry args={[0.1, 0.3, 0.5]} />
            <meshStandardMaterial color="#7d8b7b" roughness={0.9} />
          </mesh>
        ))}
      </group>
      <group position={[-1.95, 0, 1.15]}>
        <mesh position={[0, 0.15, 0]}>
          <cylinderGeometry args={[0.13, 0.1, 0.3, 14]} />
          <meshStandardMaterial color="#b0704a" />
        </mesh>
        <mesh position={[0, 0.48, 0]}>
          <sphereGeometry args={[0.24, 14, 10]} />
          <meshStandardMaterial color="#6f9a62" roughness={0.9} />
        </mesh>
      </group>
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
    shared.heads.set(actorKey, { head: rig.head, lift: bubbleLift });
    return () => {
      shared.heads.delete(actorKey);
      if (seat !== null) shared.departed.set(seat, { point: { ...state.point }, heading: state.heading });
    };
  }, [actorKey, bubbleLift, rig, seat, shared]);

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

function SceneContents({ layout, participants, bubbles, onSelect, onHover, onReady, onMotionChange }: Omit<OfficeScene3DProps, "onContextLost">) {
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
      <Room layout={layout} lit={lit} />
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
      <BubbleProjector shared={shared} bubbles={bubbles} onReady={onReady} />
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
