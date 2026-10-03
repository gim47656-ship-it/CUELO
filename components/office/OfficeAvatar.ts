import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import { OFFICE_AVATARS_API, type OfficeAvatarId, type OfficeAvatarManifest } from "@/lib/office/office-avatars";
import { CHARACTER_HEAD_Y, SEATED_HIP, mix, type CharacterPose } from "./OfficeCharacter";

/**
 * 개인 VRM 모델로 그리는 오피스 캐릭터. 모델이 설치된 캐릭터만 이 길로 오고, 나머지는 기본 도형
 * 캐릭터(`OfficeCharacter`)다. 자세 값(`CharacterPose`)의 뜻은 도형 캐릭터와 같고, 그 값을 VRM
 * normalized humanoid 뼈 회전으로 옮긴다. normalized 뼈는 쉬는 자세(T 자세, +z 정면)에서 회전이
 * 0 이고 축이 장면 축과 같아, 도형 관절의 회전을 거의 그대로 쓸 수 있다. 도형 몸에는 없는 무릎·팔꿈치만
 * 여기서 더 굽힌다.
 *
 * 모델은 실제 키 비율(6~7등신)이라, 도형 캐릭터 키와 같은 높이가 되게 줄여 책상·의자·말풍선을
 * 그대로 쓴다.
 */

/** 줄인 뒤 머리 뼈(목 위)의 높이(m). 머리끝이 도형 캐릭터 키(1.08m)쯤에 온다. */
const HEAD_BONE_Y = 0.91;
/** 앉았을 때 다리 뿌리(upperLeg) 높이. 의자 좌판(`SEATED_HIP` 바로 밑) 위에 허벅지 두께만큼 띄운다. */
const SEATED_LEG_ROOT_Y = SEATED_HIP + 0.03;
/** 차렷 자세에서 팔을 몸에서 벌리는 각(rad). 치마·엉덩이를 뚫지 않을 만큼. */
const ARM_SPREAD = 0.12;
/** 쉴 때 팔꿈치를 살짝 굽힌다. */
const ELBOW_REST = 0.15;
/** 타자 칠 때 위팔을 앞으로 드는 각과 팔꿈치를 굽히는 각. 손이 책상 위 노트북에 닿는다. */
const TYPE_ARM = -0.6;
const TYPE_ELBOW = 1.15;
/** 걸을 때 앞으로 나오는 다리의 무릎을 굽히는 최대 각. */
const WALK_KNEE = 0.7;
/** 눈 깜빡임 주기와 감는 시간(초). */
const BLINK_PERIOD = 4.2;
const BLINK_SECONDS = 0.16;

const POSED_BONES = [
  "spine",
  "chest",
  "head",
  "leftUpperLeg",
  "rightUpperLeg",
  "leftLowerLeg",
  "rightLowerLeg",
  "leftUpperArm",
  "rightUpperArm",
  "leftLowerArm",
  "rightLowerArm",
] as const satisfies readonly VRMHumanBoneName[];

type PosedBone = (typeof POSED_BONES)[number];

/** 모델 하나의 인스턴스. 한 번에 한 캐릭터만 쓰고, 장면 밖으로 나가면 `OfficeAvatarLibrary` 로 돌아간다. */
export interface OfficeAvatarRig {
  id: OfficeAvatarId;
  /** 장면에 붙이는 뿌리. 그 아래 `body` 가 줄인 모델을 들고 앉을 때 내려간다. */
  root: THREE.Group;
  body: THREE.Group;
  /** 말풍선이 붙는 점. 머리 뼈를 따라 움직이고, 서 있을 때 도형 캐릭터 머리 관절 높이에 있다. */
  head: THREE.Object3D;
  vrm: VRM;
  bones: Record<PosedBone, THREE.Object3D>;
  /** 앉을 때 몸을 내리는 거리와 그때 정강이가 바닥에 닿게 무릎을 굽히는 각. */
  sitDrop: number;
  sitKnee: number;
  /** 다음 프레임에 머리카락·옷 흔들림(spring bone)을 지금 자세에서 새로 시작한다. */
  springReset: boolean;
  /** 마지막 프레임의 reduced motion. 바뀌면 흔들림을 쉬는 자세로 되돌린다. */
  reduced: boolean;
}

async function parseAvatar(id: OfficeAvatarId, bytes: ArrayBuffer): Promise<OfficeAvatarRig> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(bytes, "");
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error(`office avatar ${id}.vrm has no VRM extension`);
  // three-vrm 예제의 권장 처리: 안 쓰는 정점·뼈대·morph 를 합쳐 프레임마다 드는 계산과 VRAM 을 줄인다.
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.combineMorphs(vrm);
  // 스키닝된 메시는 쉬는 자세 경계로 잘려 사라질 수 있다. 캐릭터는 늘 화면 안이라 자르지 않는다.
  vrm.scene.traverse((object) => {
    object.frustumCulled = false;
  });

  const bones = {} as Record<PosedBone, THREE.Object3D>;
  for (const name of POSED_BONES) {
    const node = vrm.humanoid.getNormalizedBoneNode(name);
    if (!node) throw new Error(`office avatar ${id}.vrm has no ${name} bone`);
    bones[name] = node;
  }
  vrm.scene.updateMatrixWorld(true);
  const point = new THREE.Vector3();
  const boneY = (node: THREE.Object3D) => node.getWorldPosition(point).y;
  const scale = HEAD_BONE_Y / boneY(bones.head);
  const sitDrop = boneY(bones.leftUpperLeg) * scale - SEATED_LEG_ROOT_Y;
  // 허벅지를 수평으로 두면 무릎은 SEATED_LEG_ROOT_Y 높이다. 정강이(무릎→발바닥, 발바닥은 y 0)가 그보다
  // 길면 발이 바닥을 뚫지 않게 정강이를 앞으로 비스듬히 내린다.
  const shin = boneY(bones.leftLowerLeg) * scale;
  const sitKnee = Math.PI / 2 - Math.acos(Math.min(1, SEATED_LEG_ROOT_Y / shin));

  const body = new THREE.Group();
  body.scale.setScalar(scale);
  body.add(vrm.scene);
  const root = new THREE.Group();
  root.add(body);
  const head = new THREE.Object3D();
  head.position.y = (CHARACTER_HEAD_Y - HEAD_BONE_Y) / scale;
  bones.head.add(head);
  return { id, root, body, head, vrm, bones, sitDrop, sitKnee, springReset: true, reduced: false };
}

/** 자세 값을 normalized 뼈에 옮긴다. 시간 `time`(초)은 숨쉬기·타자·손짓·깜빡임 주기에만 쓴다. */
export function poseOfficeAvatar(rig: OfficeAvatarRig, pose: CharacterPose, time: number): void {
  const { bones } = rig;
  const swing = Math.sin(pose.walkPhase) * 0.6 * pose.walk;
  const sitLeg = -Math.PI / 2 * pose.sit;
  bones.leftUpperLeg.rotation.x = sitLeg + swing;
  bones.rightUpperLeg.rotation.x = sitLeg - swing;
  // 무릎: 앉으면 정강이를 바닥으로 내리고, 걸을 때는 뒤에서 앞으로 나오는 다리를 굽힌다.
  const stride = Math.cos(pose.walkPhase) * WALK_KNEE * pose.walk;
  bones.leftLowerLeg.rotation.x = rig.sitKnee * pose.sit + Math.max(0, -stride);
  bones.rightLowerLeg.rotation.x = rig.sitKnee * pose.sit + Math.max(0, stride);

  const breath = Math.sin(time * 2.1) * pose.breathe;
  const bob = Math.abs(Math.sin(pose.walkPhase)) * 0.025 * pose.walk;
  rig.body.position.y = -rig.sitDrop * pose.sit + bob + breath * 0.004;

  // 팔: 걸을 때 다리와 반대로 흔들고, 일할 때는 앞으로 들어 팔꿈치를 굽혀 번갈아 두드린다. 위팔의 z 는
  // T 자세의 팔을 아래로 내리는 ∓π/2 에 도형 캐릭터의 벌림을 더한 값이다.
  const typeTap = (side: number) => Math.sin(time * 9 + side * 1.7) * 0.07 * pose.breathe;
  const droop = 0.12 * pose.slump;
  const spread = mix(0.1, 0.02, pose.slump) + ARM_SPREAD;
  const elbow = mix(ELBOW_REST, TYPE_ELBOW, pose.type);
  bones.leftUpperArm.rotation.set(mix(-swing * 0.8, TYPE_ARM + typeTap(1), pose.type) + droop, 0, spread - Math.PI / 2);
  bones.rightUpperArm.rotation.set(mix(swing * 0.8, TYPE_ARM + typeTap(-1), pose.type) + droop, 0, Math.PI / 2 - spread);
  bones.leftLowerArm.rotation.y = -elbow;
  bones.rightLowerArm.rotation.y = elbow;
  if (pose.wave > 0) {
    // 오른팔(-x)을 옆으로 들어 흔든다. 도형 캐릭터의 -2.55 를 T 자세 기준(+π/2)으로 옮긴 각이다.
    const arm = bones.rightUpperArm.rotation;
    arm.z = mix(arm.z, Math.PI / 2 - 2.55 + Math.sin(time * 7) * 0.35 * pose.breathe, pose.wave);
    arm.x = mix(arm.x, 0, pose.wave);
    bones.rightLowerArm.rotation.y = mix(elbow, 0.35, pose.wave);
  }

  bones.head.rotation.x = 0.05 * pose.type + 0.3 * pose.slump + breath * 0.02;
  bones.head.rotation.y = Math.sin(time * 0.6) * 0.06 * pose.breathe * (1 - pose.type);
  bones.spine.rotation.x = 0.1 * pose.slump;
  bones.chest.rotation.x = breath * 0.015;

  // 가끔 눈을 깜빡인다. reduced motion(breathe 0)이면 뜬 채로 둔다.
  const blink = time % BLINK_PERIOD;
  rig.vrm.expressionManager?.setValue("blink", blink < BLINK_SECONDS ? Math.sin((blink / BLINK_SECONDS) * Math.PI) * pose.breathe : 0);
}

/**
 * 몸을 제자리에 옮긴 뒤 부른다: normalized 뼈를 실제 뼈로 옮기고, 표정·머리카락 흔들림을 진행한다.
 * reduced motion 이면 흔들림을 멈추고 쉬는 자세로 둔다.
 */
export function updateOfficeAvatar(rig: OfficeAvatarRig, delta: number, reduced: boolean): void {
  if (reduced !== rig.reduced) {
    rig.reduced = reduced;
    rig.springReset = true;
  }
  if (rig.springReset) {
    rig.springReset = false;
    // 흔들림의 시작점은 지금 자리의 뼈 위치다. 다른 자리에서 오면 그 거리만큼 튀지 않는다.
    rig.vrm.humanoid.update();
    rig.root.updateWorldMatrix(true, true);
    rig.vrm.springBoneManager?.reset();
  }
  rig.vrm.update(reduced ? 0 : delta);
}

/**
 * 장면 하나가 쓰는 모델 모음. 파일은 모델마다 한 번 받아 두고, 캐릭터마다 따로 해석한 인스턴스를
 * 준다 — 같은 캐릭터가 둘 서도 뼈·표정·흔들림이 섞이지 않는다. 장면을 떠난 인스턴스는 반납받아 같은
 * 캐릭터가 다시 들어올 때 쓴다. 인스턴스는 한 번에 한 주인만 갖는다: 빌려준 것은 반납 전까지 버리지
 * 않고, 반납된 것만 `dispose` 가 버린다. `dispose` 뒤에 돌아오는 것은 받는 즉시 버린다.
 */
export interface OfficeAvatarLibrary {
  available: ReadonlySet<OfficeAvatarId>;
  acquire(id: OfficeAvatarId): Promise<OfficeAvatarRig>;
  release(rig: OfficeAvatarRig): void;
  dispose(): void;
}

/** 설치된 모델 목록을 받아 장면의 모델 모음을 만든다. 목록을 못 받으면 던진다. */
export async function loadOfficeAvatarLibrary(signal: AbortSignal): Promise<OfficeAvatarLibrary> {
  const response = await fetch(OFFICE_AVATARS_API, { signal });
  if (!response.ok) throw new Error(`office avatar list failed: HTTP ${response.status}`);
  const manifest = (await response.json()) as OfficeAvatarManifest;
  const files = new Map<OfficeAvatarId, Promise<ArrayBuffer>>();
  const spare = new Map<OfficeAvatarId, OfficeAvatarRig[]>();
  let disposed = false;
  return {
    available: new Set(manifest.available),
    async acquire(id) {
      const reused = spare.get(id)?.pop();
      if (reused) {
        reused.springReset = true;
        return reused;
      }
      let file = files.get(id);
      if (!file) {
        file = fetch(`${OFFICE_AVATARS_API}/${id}`, { signal }).then((model) => {
          if (!model.ok) throw new Error(`office avatar ${id}.vrm failed: HTTP ${model.status}`);
          return model.arrayBuffer();
        });
        files.set(id, file);
      }
      return parseAvatar(id, await file);
    },
    release(rig) {
      if (disposed) {
        VRMUtils.deepDispose(rig.vrm.scene);
        return;
      }
      rig.root.removeFromParent();
      const list = spare.get(rig.id) ?? [];
      list.push(rig);
      spare.set(rig.id, list);
    },
    dispose() {
      disposed = true;
      for (const list of spare.values()) for (const rig of list) VRMUtils.deepDispose(rig.vrm.scene);
      spare.clear();
      files.clear();
    },
  };
}
