"use client";

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import type { OfficeMainState } from "@/lib/office/office-roster";
import { officeMainPlan, stepToward, type FloorPoint, type OfficeStagePlan, type OfficeStageSpot } from "@/lib/office/office-stage";

/** 지금 화면의 Main 움직임. 문구와 보조 기술 안내가 이 값을 그대로 읽는다. */
export type OfficeMotion = "toDesk" | "toLounge" | "work" | "atDesk" | "idle" | "wave";

const CHARACTER_URL = "/office3d/RobotExpressive.glb";
const REQUIRED_CLIPS = ["Idle", "Walking", "Sitting", "Standing", "Wave"] as const;

const CHARACTER_HEIGHT = 1.45;
const WALK_SPEED = 1.25;
const TURN_RATE = 7;
const FACING_TOLERANCE = 0.12;

/** 사무실에 들어서는 문 앞. 장면을 열 때마다 여기서 지금 상태의 자리로 걸어간다. */
const ENTRANCE: FloorPoint = { x: -3.2, z: 1.7 };
const SPOTS: Record<OfficeStageSpot, { point: FloorPoint; facing: number }> = {
  // 쉬는 자리에서는 카메라 쪽을 본다.
  lounge: { point: { x: -1.25, z: 0.65 }, facing: 0.65 },
  // 책상 앞에서는 모니터(-z)를 본다.
  desk: { point: { x: 1.45, z: -1.0 }, facing: Math.PI },
};
const DESK = { x: 1.45, z: -1.78 };
const DESK_HEIGHT = 0.62;
// 앉은 자세(Sitting 끝)에서 엉덩이 뼈는 높이 0.27m, 몸 뒤쪽 0.22m 에 온다. 좌판을 그 아래에 둔다.
const CHAIR_SEAT_HEIGHT = 0.2;
const CHAIR_BACK_OFFSET = 0.2;

const CAMERA_TARGET = new THREE.Vector3(0.1, 0.55, -0.35);
const CAMERA_OFFSET = new THREE.Vector3(3.5, 3.9, 6.1);

function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function motionOf(phase: Phase, plan: OfficeStagePlan): OfficeMotion {
  if (phase === "walk") return plan.spot === "desk" ? "toDesk" : "toLounge";
  if (phase === "sitDown" || phase === "seated") return "work";
  if (phase === "standUp") return plan.spot === "desk" ? "atDesk" : "toLounge";
  if (plan.spot === "desk") return "atDesk";
  return plan.pose === "wave" ? "wave" : "idle";
}

type Phase = "walk" | "turn" | "pose" | "sitDown" | "seated" | "standUp";

/** 창 비율이 좁아지면(대화 칸이 열리면) 방 전체가 들어오도록 카메라를 뒤로 뺀다. */
function CameraRig() {
  const camera = useThree((state) => state.camera);
  const aspect = useThree((state) => state.size.width / Math.max(state.size.height, 1));
  useEffect(() => {
    const distance = aspect < 0.9 ? 1.55 : aspect < 1.3 ? 1.25 : 1;
    camera.position.copy(CAMERA_OFFSET).multiplyScalar(distance).add(CAMERA_TARGET);
    camera.lookAt(CAMERA_TARGET);
  }, [aspect, camera]);
  return null;
}

/** 바닥·벽 두 면·문·러그·책상·의자·모니터. 모니터 화면은 Main 이 실제로 일하는 동안만 켜진다. */
function Room({ working }: { working: boolean }) {
  const legs: Array<[number, number]> = [[-0.62, -0.28], [0.62, -0.28], [-0.62, 0.28], [0.62, 0.28]];
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[8, 6]} />
        <meshStandardMaterial color="#d9d3c7" roughness={0.95} />
      </mesh>
      <mesh position={[0, 1.3, -3.05]}>
        <boxGeometry args={[8, 2.6, 0.1]} />
        <meshStandardMaterial color="#ece7dd" roughness={1} />
      </mesh>
      <mesh position={[-4.05, 1.3, 0]}>
        <boxGeometry args={[0.1, 2.6, 6.2]} />
        <meshStandardMaterial color="#e3ddd1" roughness={1} />
      </mesh>
      {/* 문 */}
      <mesh position={[-3.995, 1.0, ENTRANCE.z]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[0.95, 2.0]} />
        <meshStandardMaterial color="#8a7a66" roughness={0.8} />
      </mesh>
      {/* 쉬는 자리 러그 */}
      <mesh rotation-x={-Math.PI / 2} position={[SPOTS.lounge.point.x, 0.005, SPOTS.lounge.point.z]}>
        <circleGeometry args={[0.85, 40]} />
        <meshStandardMaterial color="#b9c4b4" roughness={1} />
      </mesh>
      {/* 책상 */}
      <group position={[DESK.x, 0, DESK.z]}>
        <mesh position={[0, DESK_HEIGHT, 0]}>
          <boxGeometry args={[1.4, 0.05, 0.66]} />
          <meshStandardMaterial color="#a77b55" roughness={0.7} />
        </mesh>
        {legs.map(([x, z]) => (
          <mesh key={`${x}:${z}`} position={[x, DESK_HEIGHT / 2, z]}>
            <boxGeometry args={[0.05, DESK_HEIGHT, 0.05]} />
            <meshStandardMaterial color="#5b4a3b" />
          </mesh>
        ))}
        {/* 모니터 */}
        <mesh position={[0, DESK_HEIGHT + 0.1, -0.12]}>
          <boxGeometry args={[0.08, 0.16, 0.06]} />
          <meshStandardMaterial color="#2f3236" />
        </mesh>
        <mesh position={[0, DESK_HEIGHT + 0.34, -0.14]}>
          <boxGeometry args={[0.66, 0.4, 0.04]} />
          <meshStandardMaterial color="#2f3236" />
        </mesh>
        <mesh position={[0, DESK_HEIGHT + 0.34, -0.115]}>
          <planeGeometry args={[0.6, 0.34]} />
          <meshStandardMaterial
            color={working ? "#9fd3ff" : "#3a4048"}
            emissive={working ? "#5fb2ff" : "#000000"}
            emissiveIntensity={working ? 0.9 : 0}
          />
        </mesh>
      </group>
      {/* 의자: 앉는 자리 바로 뒤 */}
      <group position={[SPOTS.desk.point.x, 0, SPOTS.desk.point.z + CHAIR_BACK_OFFSET]}>
        <mesh position={[0, CHAIR_SEAT_HEIGHT, 0]}>
          <boxGeometry args={[0.46, 0.06, 0.44]} />
          <meshStandardMaterial color="#4a5563" roughness={0.8} />
        </mesh>
        <mesh position={[0, CHAIR_SEAT_HEIGHT + 0.32, 0.24]}>
          <boxGeometry args={[0.46, 0.55, 0.05]} />
          <meshStandardMaterial color="#4a5563" roughness={0.8} />
        </mesh>
        <mesh position={[0, CHAIR_SEAT_HEIGHT / 2, 0]}>
          <cylinderGeometry args={[0.03, 0.03, CHAIR_SEAT_HEIGHT, 8]} />
          <meshStandardMaterial color="#2f3236" />
        </mesh>
      </group>
    </group>
  );
}

interface MainCharacterProps {
  mainState: OfficeMainState;
  selected: boolean;
  onSelectMain: () => void;
  onReady: () => void;
  onMotionChange: (motion: OfficeMotion) => void;
}

function MainCharacter({ mainState, selected, onSelectMain, onReady, onMotionChange }: MainCharacterProps) {
  const gltf = useLoader(GLTFLoader, CHARACTER_URL);
  const gl = useThree((state) => state.gl);
  const rig = useMemo(() => {
    const clips = new Map(gltf.animations.map((clip) => [clip.name, clip]));
    const missing = REQUIRED_CLIPS.filter((name) => !clips.has(name));
    if (missing.length > 0) throw new Error(`office character is missing clips: ${missing.join(", ")}`);
    // 불러온 원본은 로더 캐시가 다시 쓰므로 복제본에 믹서를 붙인다.
    const model = cloneSkinned(gltf.scene);
    // 리깅된 메시는 뼈대 행렬을 계산하기 전이면 원본 단위(약 100배)로 잡힌다. 뼈대를 먼저 풀고
    // 정점 단위(precise)로 잰다.
    model.updateMatrixWorld(true);
    model.traverse((node) => {
      if (node instanceof THREE.SkinnedMesh) node.skeleton.update();
    });
    const bounds = new THREE.Box3().setFromObject(model, true);
    model.scale.setScalar(CHARACTER_HEIGHT / Math.max(bounds.max.y - bounds.min.y, 1e-3));
    const mixer = new THREE.AnimationMixer(model);
    const actions = Object.fromEntries(
      REQUIRED_CLIPS.map((name) => [name, mixer.clipAction(clips.get(name)!)]),
    ) as Record<(typeof REQUIRED_CLIPS)[number], THREE.AnimationAction>;
    return { model, mixer, actions };
  }, [gltf]);
  const body = useRef<THREE.Group>(null);
  const plan = useRef(officeMainPlan(mainState));
  const sim = useRef({
    point: { ...ENTRANCE },
    heading: Math.atan2(SPOTS.lounge.point.x - ENTRANCE.x, SPOTS.lounge.point.z - ENTRANCE.z),
    phase: "walk" as Phase,
    current: null as THREE.AnimationAction | null,
    finished: null as THREE.AnimationAction | null,
    motion: null as OfficeMotion | null,
  });
  const reducedMotion = useRef(false);

  useEffect(() => {
    plan.current = officeMainPlan(mainState);
  }, [mainState]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.current = query.matches;
    const update = (event: MediaQueryListEvent) => { reducedMotion.current = event.matches; };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const { mixer, model } = rig;
    const state = sim.current;
    const onFinished = (event: { action: THREE.AnimationAction }) => { state.finished = event.action; };
    mixer.addEventListener("finished", onFinished);
    onReady();
    return () => {
      mixer.removeEventListener("finished", onFinished);
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      state.current = null;
    };
  }, [rig, onReady]);

  useEffect(() => () => { gl.domElement.style.cursor = ""; }, [gl]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const state = sim.current;
    const want = plan.current;
    const seatWanted = want.spot === "desk" && want.pose === "work";
    const play = (name: (typeof REQUIRED_CLIPS)[number], once = false) => {
      const next = rig.actions[name];
      if (state.current === next) return;
      next.reset();
      next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = once;
      if (once) state.finished = null;
      if (state.current) next.crossFadeFrom(state.current, 0.25, false);
      next.play();
      state.current = next;
    };

    if (state.phase === "sitDown" || state.phase === "seated") {
      if (!seatWanted) {
        state.phase = "standUp";
        play("Standing", true);
      } else if (state.phase === "sitDown" && state.finished === rig.actions.Sitting) {
        state.phase = "seated";
      }
    } else if (state.phase === "standUp") {
      if (state.finished === rig.actions.Standing) state.phase = "walk";
    } else {
      const spot = SPOTS[want.spot];
      const step = stepToward(state.point, spot.point, reducedMotion.current ? Infinity : WALK_SPEED * delta);
      if (!step.arrived) {
        state.heading += angleDelta(state.heading, Math.atan2(step.point.x - state.point.x, step.point.z - state.point.z)) * Math.min(1, TURN_RATE * delta);
        state.point = step.point;
        state.phase = "walk";
        play("Walking");
      } else {
        state.point = step.point;
        const turn = angleDelta(state.heading, spot.facing);
        if (Math.abs(turn) > FACING_TOLERANCE && !reducedMotion.current) {
          state.heading += turn * Math.min(1, TURN_RATE * delta);
          state.phase = "turn";
          play("Idle");
        } else {
          state.heading = spot.facing;
          if (seatWanted) {
            state.phase = "sitDown";
            play("Sitting", true);
          } else {
            state.phase = "pose";
            play(want.pose === "wave" ? "Wave" : "Idle");
          }
        }
      }
    }

    rig.mixer.update(delta);
    if (body.current) {
      body.current.position.set(state.point.x, 0, state.point.z);
      body.current.rotation.y = state.heading;
    }
    const motion = motionOf(state.phase, want);
    if (motion !== state.motion) {
      state.motion = motion;
      onMotionChange(motion);
    }
  });

  return (
    <group ref={body}>
      <primitive object={rig.model} />
      {/* 발밑 그림자와 선택 고리. 실제 그림자 대신 가벼운 원판 하나다. */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.01, 0]}>
        <circleGeometry args={[0.38, 32]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.16} depthWrite={false} />
      </mesh>
      {selected && (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.015, 0]}>
          <ringGeometry args={[0.44, 0.52, 48]} />
          <meshBasicMaterial color="#ff6f0f" depthWrite={false} />
        </mesh>
      )}
      {/* 클릭 판정 상자. 뼈대가 움직이는 메시보다 안정적으로 맞고, 보이지 않는다. */}
      <mesh
        position={[0, CHARACTER_HEIGHT / 2, 0]}
        onClick={(event) => {
          event.stopPropagation();
          onSelectMain();
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          gl.domElement.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          gl.domElement.style.cursor = "";
        }}
      >
        <boxGeometry args={[0.8, CHARACTER_HEIGHT, 0.7]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

export interface OfficeScene3DProps extends MainCharacterProps {
  onContextLost: () => void;
}

/**
 * 오피스 보기의 3D 사무실. 이 컴포넌트가 내려가면 Canvas 와 렌더 루프도 함께 멈춘다 — 오피스를
 * 닫거나 좁은 화면에서 대화 칸으로 넘어가면 AppShell 이 이 장면을 그리지 않는다.
 */
export default function OfficeScene3D({ onContextLost, ...character }: OfficeScene3DProps) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ fov: 38, near: 0.1, far: 60, position: CAMERA_OFFSET.clone().add(CAMERA_TARGET).toArray() }}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", onContextLost, { once: true });
      }}
    >
      <CameraRig />
      <hemisphereLight args={["#ffffff", "#b5a993", 1.6]} />
      <directionalLight position={[3, 6, 4]} intensity={1.6} />
      <Room working={character.mainState === "working"} />
      <MainCharacter {...character} />
    </Canvas>
  );
}
