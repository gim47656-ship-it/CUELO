import * as THREE from "three";

/**
 * 오피스 캐릭터의 겉모습과 코드 애니메이션. 겉모습은 이 파일 한 곳에서만 만든다 — 나중에
 * 모델을 바꿀 때는 `buildCharacter`·`poseCharacter` 와 아래 표만 바꾸면 장면·배치·상태 연결은
 * 그대로다.
 *
 * 일곱 캐릭터는 같은 2~3등신 몸에 계정 아바타(`public/avatars/`)의 머리색·머리 모양·옷 색을
 * 입힌 three.js 기본 도형이다. 외부 모델·텍스처 파일이 없다. 캐릭터는 +z(카메라 쪽)를 본다.
 */

export type HairLength = "short" | "bob" | "long";

export type CharacterAccessory =
  | { kind: "bow"; color: string; x: number; y: number; z: number; size: number }
  | { kind: "goggles"; frame: string; lens: string }
  | { kind: "clip"; color: string; x: number }
  | { kind: "glasses"; color: string }
  | { kind: "pendant"; color: string };

export interface CharacterAppearance {
  hair: string;
  /** 앞머리 한 가닥의 다른 색(브리지). */
  streak?: string;
  length: HairLength;
  /** 옆으로 묶은 머리. `x` 는 -1(캐릭터 오른쪽) 또는 1(왼쪽), `high` 면 정수리 가까이 묶는다. */
  ponytail?: { x: -1 | 1; high: boolean };
  /** 어깨 앞으로 늘어뜨린 땋은 머리. */
  braid?: { x: -1 | 1 };
  eyes: string;
  skin: string;
  outfit: string;
  inner: string;
  accent: string;
  /** 소매 중간 줄무늬. */
  stripe?: string;
  legs: string;
  accessories: readonly CharacterAccessory[];
}

/**
 * 자리 번호(`ACCOUNT_FACES` 순서: RIN·MIO·NOVA·YUKI·ISANA·SHION·HIKARI)별 겉모습. 색은
 * 아바타 그림의 조명 없는 부분에서 읽었다.
 */
export const OFFICE_APPEARANCES: readonly CharacterAppearance[] = [
  // RIN: 등까지 오는 검은 머리, 오른쪽 뒤의 큰 붉은 리본, 금장식 검은 블라우스.
  {
    hair: "#1d1719", length: "long", eyes: "#d08a35", skin: "#f6d5c3",
    outfit: "#221d23", inner: "#3a3036", accent: "#d4af37", legs: "#1a171b",
    accessories: [
      { kind: "bow", color: "#a82e37", x: -0.15, y: 0.1, z: -0.12, size: 1.25 },
      { kind: "pendant", color: "#d6a84c" },
    ],
  },
  // MIO: 어깨 길이의 밤색 단발, 짙은 후드 집업과 흰 티, 금색 동전 목걸이.
  {
    hair: "#b08265", length: "bob", eyes: "#3c934e", skin: "#ffe8d6",
    outfit: "#352b2e", inner: "#e6e1dc", accent: "#c0b8b2", legs: "#3b3a40",
    accessories: [{ kind: "pendant", color: "#cba052" }],
  },
  // NOVA: 은빛 하늘색 짧은 머리, 이마 위 황동 고글, 주황 줄무늬 남색 작업복.
  {
    hair: "#c8d7e8", length: "short", eyes: "#2b82c9", skin: "#fce6d6",
    outfit: "#2a3545", inner: "#1e1c1f", accent: "#35a7c2", stripe: "#d9732b", legs: "#262b34",
    accessories: [{ kind: "goggles", frame: "#8c6533", lens: "#d98a32" }, { kind: "pendant", color: "#b88b46" }],
  },
  // YUKI: 분홍 머리 왼쪽 높은 사이드 포니테일과 검은 리본, 보라 빛 장식의 검은 재킷.
  {
    hair: "#f48fb1", length: "bob", ponytail: { x: 1, high: true }, eyes: "#9c4edb", skin: "#fde8e1",
    outfit: "#211d27", inner: "#2e2a36", accent: "#8e75fe", legs: "#1b1820",
    accessories: [{ kind: "bow", color: "#18151d", x: 0.17, y: 0.15, z: -0.06, size: 0.9 }, { kind: "pendant", color: "#9d8ec0" }],
  },
  // ISANA: 짙은 남색 긴 머리와 파란 브리지, 오른쪽 높은 포니테일, 고래 머리핀, 하늘색 장식 후드.
  {
    hair: "#162650", streak: "#3a6fbf", length: "long", ponytail: { x: -1, high: true }, eyes: "#54c6eb", skin: "#fde8de",
    outfit: "#171b28", inner: "#1f2433", accent: "#68b2f8", legs: "#14161f",
    accessories: [{ kind: "clip", color: "#90d5ff", x: -1 }, { kind: "pendant", color: "#4a90e2" }],
  },
  // SHION: 청록 브리지의 검은 중단발, 십자 머리핀, 은테 안경, 청록 장식의 짙은 재킷.
  {
    hair: "#17191c", streak: "#00d2c4", length: "bob", eyes: "#1ed6b8", skin: "#fcece5",
    outfit: "#262a30", inner: "#141416", accent: "#00bfa8", legs: "#18191c",
    accessories: [{ kind: "clip", color: "#00e5d4", x: -1 }, { kind: "glasses", color: "#d8dfe5" }],
  },
  // HIKARI: 적갈색 머리를 왼쪽 어깨로 땋아 내림, 카메라 머리핀, 베이지 가디건과 흰 블라우스.
  {
    hair: "#a85630", length: "bob", braid: { x: 1 }, eyes: "#d49a2e", skin: "#f6d3b6",
    outfit: "#d0ae84", inner: "#efeae0", accent: "#2a2725", legs: "#4a4038",
    accessories: [{ kind: "clip", color: "#9e9b96", x: 1 }, { kind: "pendant", color: "#232323" }],
  },
];

/** 캐릭터를 특정하지 못한 참여자. 머리카락 없는 회색 인형이라 어느 캐릭터와도 닮지 않는다. */
export const UNKNOWN_APPEARANCE: CharacterAppearance = {
  hair: "#9aa0a8", length: "short", eyes: "#4b5058", skin: "#c9ccd2",
  outfit: "#7d838d", inner: "#9aa0a8", accent: "#b6bbc3", legs: "#5d626b",
  accessories: [],
};

// ---------- 몸 치수(m). 머리 0.4m, 키 약 1.08m 의 2.7등신. ----------
const HIP = 0.36;
const LEG_LENGTH = 0.3;
const SHOULDER_Y = 0.27;
const SHOULDER_X = 0.15;
const ARM_LENGTH = 0.25;
const NECK_Y = 0.31;
const HEAD_RADIUS = 0.2;
const HEAD_CENTER = 0.19;
/** 앉았을 때 엉덩이 높이. 의자·소파 좌판이 이 아래에 온다. */
export const SEATED_HIP = 0.25;
export const CHARACTER_HEIGHT = HIP + NECK_Y + HEAD_CENTER + HEAD_RADIUS + 0.02;
/** 상태 말풍선을 붙일 머리 위 높이. */
export const CHARACTER_BUBBLE_Y = CHARACTER_HEIGHT + 0.12;

/** 한 장면의 캐릭터가 함께 쓰는 도형·재질. 장면이 내려갈 때 `dispose` 로 한 번에 반납한다. */
export interface CharacterKit {
  geometry: {
    sphere: THREE.SphereGeometry;
    dome: THREE.SphereGeometry;
    cylinder: THREE.CylinderGeometry;
    torso: THREE.CylinderGeometry;
    box: THREE.BoxGeometry;
    ring: THREE.TorusGeometry;
  };
  material: (color: string) => THREE.MeshStandardMaterial;
  dispose: () => void;
}

export function createCharacterKit(): CharacterKit {
  const geometry = {
    sphere: new THREE.SphereGeometry(1, 20, 14),
    // 정수리부터 적도 조금 아래까지. 뒤로 기울여 얼굴은 비우고 이마와 뒤통수를 덮는다.
    dome: new THREE.SphereGeometry(1, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.56),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 12),
    torso: new THREE.CylinderGeometry(0.76, 1, 1, 16),
    box: new THREE.BoxGeometry(1, 1, 1),
    ring: new THREE.TorusGeometry(1, 0.16, 8, 24),
  };
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  return {
    geometry,
    material: (color) => {
      let material = materials.get(color);
      if (!material) {
        material = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0 });
        materials.set(color, material);
      }
      return material;
    },
    dispose: () => {
      for (const value of Object.values(geometry)) value.dispose();
      for (const material of materials.values()) material.dispose();
      materials.clear();
    },
  };
}

/** 애니메이션이 움직이는 관절. */
export interface CharacterRig {
  root: THREE.Group;
  body: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armLeft: THREE.Group;
  armRight: THREE.Group;
  legLeft: THREE.Group;
  legRight: THREE.Group;
}

type Vec3 = readonly [number, number, number];

function addMesh(
  kit: CharacterKit,
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  color: string,
  position: Vec3,
  scale: Vec3,
  rotation: Vec3 = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, kit.material(color));
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.rotation.set(...rotation);
  parent.add(mesh);
  return mesh;
}

function joint(parent: THREE.Object3D, position: Vec3): THREE.Group {
  const group = new THREE.Group();
  group.position.set(...position);
  parent.add(group);
  return group;
}

function buildHair(kit: CharacterKit, head: THREE.Group, look: CharacterAppearance): void {
  const { sphere, dome, box } = kit.geometry;
  const c = HEAD_CENTER;
  const r = HEAD_RADIUS;
  // 정수리 덮개: 뒤로 기울여 앞쪽 끝이 눈썹 위에서 멈춘다.
  addMesh(kit, head, dome, look.hair, [0, c + 0.012, -0.008], [r * 1.1, r * 1.1, r * 1.12], [-0.36, 0, 0]);
  // 앞머리.
  addMesh(kit, head, sphere, look.hair, [0, c + 0.11, 0.14], [0.185, 0.055, 0.08], [0.32, 0, 0]);
  if (look.streak) addMesh(kit, head, sphere, look.streak, [0.07, c + 0.105, 0.185], [0.032, 0.048, 0.022], [0.32, 0, -0.25]);
  // 뒷머리: 짧은 머리는 뒤통수만, 단발은 턱선까지, 긴 머리는 등까지.
  if (look.length === "short") {
    addMesh(kit, head, sphere, look.hair, [0, c + 0.01, -0.065], [0.208, 0.2, 0.17]);
  } else {
    addMesh(kit, head, sphere, look.hair, [0, c - 0.035, -0.085], [0.226, 0.235, 0.18]);
    // 얼굴 옆으로 내려오는 옆머리. 볼 바깥쪽에만 걸친다.
    for (const side of [-1, 1]) {
      addMesh(kit, head, sphere, look.hair, [side * 0.185, c - 0.08, 0.05], [0.035, 0.12, 0.045], [0, 0, side * -0.12]);
    }
  }
  if (look.length === "long") {
    addMesh(kit, head, sphere, look.hair, [0, c - 0.27, -0.12], [0.2, 0.3, 0.085], [-0.18, 0, 0]);
  }
  if (look.ponytail) {
    const x = look.ponytail.x;
    const y = look.ponytail.high ? c + 0.13 : c + 0.02;
    addMesh(kit, head, sphere, look.hair, [x * 0.17, y, -0.07], [0.06, 0.06, 0.06]);
    addMesh(kit, head, sphere, look.hair, [x * 0.25, y - 0.17, -0.1], [0.06, 0.19, 0.062], [0, 0, x * 0.28]);
  }
  if (look.braid) {
    const x = look.braid.x;
    for (let index = 0; index < 4; index += 1) {
      addMesh(kit, head, sphere, look.hair, [x * (0.15 - index * 0.012), c - 0.13 - index * 0.075, 0.07 + index * 0.025], [0.046, 0.046, 0.046]);
    }
    addMesh(kit, head, box, "#2b2b2b", [x * 0.11, c - 0.4, 0.15], [0.05, 0.02, 0.05]);
  }
}

function buildAccessories(kit: CharacterKit, head: THREE.Group, torso: THREE.Group, look: CharacterAppearance): void {
  const { sphere, box, ring } = kit.geometry;
  const c = HEAD_CENTER;
  for (const accessory of look.accessories) {
    switch (accessory.kind) {
      case "bow": {
        const s = accessory.size;
        const at: Vec3 = [accessory.x, c + accessory.y, accessory.z];
        for (const side of [-1, 1]) {
          addMesh(kit, head, sphere, accessory.color, [at[0] + side * 0.055 * s, at[1], at[2]], [0.06 * s, 0.04 * s, 0.025 * s], [0, 0, side * 0.35]);
        }
        addMesh(kit, head, sphere, accessory.color, at, [0.025 * s, 0.025 * s, 0.025 * s]);
        break;
      }
      case "goggles":
        for (const side of [-1, 1]) {
          addMesh(kit, head, ring, accessory.frame, [side * 0.065, c + 0.165, 0.12], [0.045, 0.045, 0.045], [-0.95, 0, 0]);
          addMesh(kit, head, sphere, accessory.lens, [side * 0.065, c + 0.168, 0.122], [0.038, 0.012, 0.038], [-0.95 + Math.PI / 2, 0, 0]);
        }
        break;
      case "clip":
        addMesh(kit, head, box, accessory.color, [accessory.x * 0.14, c + 0.11, 0.13], [0.055, 0.022, 0.02], [0, 0, accessory.x * -0.5]);
        break;
      case "glasses":
        for (const side of [-1, 1]) {
          addMesh(kit, head, ring, accessory.color, [side * 0.075, c - 0.015, 0.2], [0.045, 0.045, 0.03]);
        }
        addMesh(kit, head, box, accessory.color, [0, c - 0.01, 0.205], [0.06, 0.008, 0.008]);
        break;
      case "pendant":
        addMesh(kit, torso, sphere, accessory.color, [0, 0.235, 0.105], [0.022, 0.022, 0.012]);
        break;
    }
  }
}

/** 겉모습 하나로 캐릭터 한 명을 만든다. 도형·재질은 `kit` 것을 함께 쓴다. */
export function buildCharacter(kit: CharacterKit, look: CharacterAppearance, faceless = false): CharacterRig {
  const { sphere, cylinder, torso: torsoShape, box } = kit.geometry;
  const root = new THREE.Group();
  const body = joint(root, [0, 0, 0]);

  const legLeft = joint(body, [0.068, HIP, 0]);
  const legRight = joint(body, [-0.068, HIP, 0]);
  for (const leg of [legLeft, legRight]) {
    addMesh(kit, leg, cylinder, look.legs, [0, -LEG_LENGTH / 2, 0], [0.055, LEG_LENGTH, 0.055]);
    addMesh(kit, leg, box, "#2b2a2e", [0, -LEG_LENGTH - 0.025, 0.025], [0.09, 0.05, 0.14]);
  }

  const torso = joint(body, [0, HIP, 0]);
  addMesh(kit, torso, torsoShape, look.outfit, [0, 0.15, 0], [0.16, 0.31, 0.13]);
  // 겉옷 앞섶 사이로 보이는 안옷.
  addMesh(kit, torso, box, look.inner, [0, 0.17, 0.112], [0.085, 0.2, 0.02], [-0.13, 0, 0]);
  // 목깃.
  addMesh(kit, torso, kit.geometry.ring, look.accent, [0, 0.3, 0], [0.085, 0.085, 0.07], [Math.PI / 2, 0, 0]);
  addMesh(kit, torso, cylinder, look.skin, [0, NECK_Y, 0], [0.045, 0.06, 0.045]);

  const armLeft = joint(torso, [SHOULDER_X, SHOULDER_Y, 0]);
  const armRight = joint(torso, [-SHOULDER_X, SHOULDER_Y, 0]);
  for (const arm of [armLeft, armRight]) {
    addMesh(kit, arm, cylinder, look.outfit, [0, -ARM_LENGTH / 2, 0], [0.047, ARM_LENGTH, 0.047]);
    if (look.stripe) addMesh(kit, arm, cylinder, look.stripe, [0, -ARM_LENGTH * 0.45, 0], [0.05, 0.03, 0.05]);
    addMesh(kit, arm, cylinder, look.accent, [0, -ARM_LENGTH + 0.015, 0], [0.051, 0.03, 0.051]);
    addMesh(kit, arm, sphere, look.skin, [0, -ARM_LENGTH - 0.03, 0], [0.048, 0.048, 0.048]);
  }

  const head = joint(torso, [0, NECK_Y + 0.02, 0]);
  addMesh(kit, head, sphere, look.skin, [0, HEAD_CENTER, 0], [HEAD_RADIUS, HEAD_RADIUS * 0.97, HEAD_RADIUS * 0.95]);
  for (const side of [-1, 1]) {
    addMesh(kit, head, sphere, look.eyes, [side * 0.072, HEAD_CENTER - 0.02, 0.178], [0.034, 0.046, 0.02]);
    if (!faceless) {
      addMesh(kit, head, sphere, "#ffffff", [side * 0.072 + 0.012, HEAD_CENTER - 0.002, 0.192], [0.011, 0.011, 0.006]);
      addMesh(kit, head, sphere, "#f3a9a4", [side * 0.115, HEAD_CENTER - 0.07, 0.15], [0.03, 0.014, 0.01]);
    }
  }
  addMesh(kit, head, box, "#8a4a4a", [0, HEAD_CENTER - 0.1, 0.172], [0.035, 0.008, 0.01]);
  if (!faceless) buildHair(kit, head, look);
  buildAccessories(kit, head, torso, look);

  return { root, body, torso, head, armLeft, armRight, legLeft, legRight };
}

/** 한 프레임의 자세. 값은 0..1 의 섞는 정도이고 `walkPhase` 만 걸음 주기(rad)다. */
export interface CharacterPose {
  walkPhase: number;
  walk: number;
  sit: number;
  type: number;
  wave: number;
  slump: number;
  /** 숨쉬기·고개 흔들림 같은 가만히 있을 때의 작은 움직임. reduced motion 이면 0. */
  breathe: number;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 자세 값을 관절에 옮긴다. 시간 `time`(초)은 숨쉬기·타자·손짓 주기에만 쓴다. */
export function poseCharacter(rig: CharacterRig, pose: CharacterPose, time: number): void {
  const swing = Math.sin(pose.walkPhase) * 0.6 * pose.walk;
  const sitLeg = -Math.PI / 2 * pose.sit;
  rig.legLeft.rotation.x = sitLeg + swing;
  rig.legRight.rotation.x = sitLeg - swing;

  const breath = Math.sin(time * 2.1) * pose.breathe;
  const bob = Math.abs(Math.sin(pose.walkPhase)) * 0.025 * pose.walk;
  rig.body.position.y = -(HIP - SEATED_HIP) * pose.sit + bob + breath * 0.004;
  rig.torso.scale.y = 1 + breath * 0.012;

  // 팔: 걸을 때 다리와 반대로 흔들고, 일할 때는 앞으로 뻗어 번갈아 두드린다.
  const typeTap = (side: number) => Math.sin(time * 9 + side * 1.7) * 0.07 * pose.breathe;
  const armBaseLeft = mix(-swing * 0.8, -1.15 + typeTap(1), pose.type);
  const armBaseRight = mix(swing * 0.8, -1.15 + typeTap(-1), pose.type);
  const droop = 0.12 * pose.slump;
  rig.armLeft.rotation.set(armBaseLeft + droop, 0, mix(0.1, 0.02, pose.slump));
  rig.armRight.rotation.set(armBaseRight + droop, 0, mix(-0.1, -0.02, pose.slump));
  if (pose.wave > 0) {
    // 오른팔(-x)을 옆으로 들어 흔든다.
    rig.armRight.rotation.z = mix(-0.1, -2.55 + Math.sin(time * 7) * 0.35 * pose.breathe, pose.wave);
    rig.armRight.rotation.x = mix(rig.armRight.rotation.x, 0, pose.wave);
  }

  rig.head.rotation.x = 0.05 * pose.type + 0.3 * pose.slump + breath * 0.02;
  rig.head.rotation.y = Math.sin(time * 0.6) * 0.06 * pose.breathe * (1 - pose.type);
  rig.torso.rotation.x = 0.1 * pose.slump;
}
