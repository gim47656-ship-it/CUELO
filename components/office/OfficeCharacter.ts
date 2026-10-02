import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * 오피스 캐릭터의 겉모습과 코드 애니메이션. 겉모습은 이 파일 한 곳에서만 만든다 — 나중에
 * 모델을 바꿀 때는 `buildCharacter`·`poseCharacter` 와 아래 표만 바꾸면 장면·배치·상태 연결은
 * 그대로다.
 *
 * 일곱 캐릭터는 같은 2~3등신 몸에 계정 아바타(`public/avatars/`)의 머리색·머리 모양·눈·옷을
 * 입힌 three.js 기본 도형이다. 외부 모델·텍스처 파일이 없다. 캐릭터는 +z(카메라 쪽)를 본다.
 * 얼굴은 CUELO 그림체처럼 크고 세로로 긴 눈(눈매 선·눈동자·하이라이트 둘), 볼 터치, 작은 입, 가닥진
 * 앞머리와 옆머리로 만든다. 다 만든 뒤 관절마다 같은 재질 조각을 한 도형으로 합쳐 그리기 호출을
 * 줄인다(`bakeJoint`).
 */

export type HairLength = "short" | "bob" | "long";

/**
 * 앞머리 모양. `choppy` 는 고르게 들쭉날쭉, `curtain` 은 가운데 가르마로 양옆이 길고, `swept` 는
 * 한쪽으로 쓸어 넘기고, `wispy` 는 가는 가닥 사이로 이마가 보인다.
 */
export type BangsStyle = "choppy" | "curtain" | "swept" | "wispy";

/** 눈매. `round` 는 둥글고 큰 눈, `sharp` 는 눈꼬리가 올라간 아몬드 눈. */
export type EyeShape = "round" | "sharp";

/**
 * 머리핀 모양. `x` 는 X 자, `whale` 은 고래, `camera` 는 작은 카메라, `bar` 는 막대 핀이다.
 * `x` 는 -1(캐릭터 오른쪽 = 화면 왼쪽) 또는 1(화면 오른쪽).
 */
export type CharacterAccessory =
  | { kind: "bow"; color: string; x: number; y: number; z: number; size: number; tails?: boolean }
  | { kind: "goggles"; frame: string; lens: string }
  | { kind: "clip"; color: string; x: -1 | 1; shape?: "bar" | "x" | "whale" | "camera" }
  | { kind: "glasses"; color: string }
  | { kind: "pendant"; color: string }
  | { kind: "choker"; color: string };

export interface CharacterAppearance {
  hair: string;
  /** 앞머리 한 가닥·옆머리 안쪽의 다른 색(브리지). */
  streak?: string;
  length: HairLength;
  bangs: BangsStyle;
  /** 정수리에서 솟은 바보털. */
  ahoge?: boolean;
  /** 옆으로 묶은 머리. `x` 는 -1(캐릭터 오른쪽 = 화면 왼쪽) 또는 1, `high` 면 정수리 가까이 묶는다. */
  ponytail?: { x: -1 | 1; high: boolean };
  /** 어깨 앞으로 늘어뜨린 땋은 머리. */
  braid?: { x: -1 | 1; color?: string };
  eyes: string;
  eyeShape: EyeShape;
  skin: string;
  outfit: string;
  inner: string;
  accent: string;
  /** 소매 중간 줄무늬. */
  stripe?: string;
  /** 후드 집업의 등 뒤 모자. */
  hood?: boolean;
  /** 치마 색. 없으면 바지 차림이다. */
  skirt?: string;
  legs: string;
  accessories: readonly CharacterAccessory[];
}

/**
 * 자리 번호(`ACCOUNT_FACES` 순서: RIN·MIO·NOVA·YUKI·ISANA·SHION·HIKARI)별 겉모습. 색과 특징은
 * 아바타 그림(`public/avatars/<이름>.webp`)과 `docs/hero.webp` 에서 읽었다. 좌우는 화면 기준이다.
 */
export const OFFICE_APPEARANCES: readonly CharacterAppearance[] = [
  // RIN: 등까지 오는 검은 생머리, 가운데 가르마 앞머리, 화면 왼쪽 뒤의 큰 붉은 리본(꼬리 둘),
  // 호박색 아몬드 눈, 금장식 검은 블라우스와 금 펜던트.
  {
    hair: "#1d1719", length: "long", bangs: "curtain", eyes: "#c97828", eyeShape: "sharp", skin: "#f6d5c3",
    outfit: "#1c1a1f", inner: "#2e282d", accent: "#d4a853", skirt: "#151417", legs: "#1a171b",
    accessories: [
      { kind: "bow", color: "#a82e37", x: -0.16, y: 0.1, z: -0.12, size: 1.35, tails: true },
      { kind: "pendant", color: "#d6a84c" },
    ],
  },
  // MIO: 바깥으로 뻗친 밤색 단발, 사이가 뜬 가는 앞머리, 둥근 초록 눈, 짙은 후드 집업과 흰 티,
  // 금색 동전 목걸이.
  {
    hair: "#b08261", length: "bob", bangs: "wispy", eyes: "#3b9b52", eyeShape: "round", skin: "#ffe8d6",
    outfit: "#2d292b", inner: "#e6e1dc", accent: "#c0b8b2", hood: true, skirt: "#3b3a40", legs: "#2c2b30",
    accessories: [{ kind: "pendant", color: "#cba052" }],
  },
  // NOVA: 은빛 하늘색 짧은 삐침 머리와 바보털, 이마 위 황동 고글, 파란 눈, 주황 줄무늬 남색 작업복.
  {
    hair: "#c8d3e6", length: "short", bangs: "swept", ahoge: true, eyes: "#2d76c9", eyeShape: "round", skin: "#fce6d6",
    outfit: "#222b38", inner: "#15171b", accent: "#29c4d8", stripe: "#d97026", skirt: "#2a3545", legs: "#262b34",
    accessories: [{ kind: "goggles", frame: "#b88636", lens: "#d98a2c" }, { kind: "pendant", color: "#b88b46" }],
  },
  // YUKI: 분홍 머리, 화면 오른쪽 높은 사이드 포니테일과 검은 리본, 바보털, 보라 아몬드 눈,
  // 초커와 보라 장식의 검은 재킷, 검은 주름치마.
  {
    hair: "#f48cb6", length: "bob", bangs: "choppy", ahoge: true, ponytail: { x: 1, high: true }, eyes: "#7638b5", eyeShape: "sharp", skin: "#fde8e1",
    outfit: "#1b1822", inner: "#2e2a36", accent: "#8a5cf6", skirt: "#15131c", legs: "#1b1820",
    accessories: [
      { kind: "bow", color: "#18151d", x: 0.215, y: 0.17, z: -0.02, size: 1.1 },
      { kind: "choker", color: "#18151d" },
    ],
  },
  // ISANA: 짙은 남색 긴 머리와 파란 안쪽 머리, 화면 왼쪽 높은 포니테일, 바보털, 고래 머리핀,
  // 큰 하늘색 눈, 검은 후드 집업과 초커.
  {
    hair: "#162650", streak: "#3d9be9", length: "long", bangs: "choppy", ahoge: true, ponytail: { x: -1, high: true }, eyes: "#2c8ef8", eyeShape: "round", skin: "#fde8de",
    outfit: "#141720", inner: "#1f2433", accent: "#68b2f8", hood: true, skirt: "#1f2433", legs: "#14161f",
    accessories: [{ kind: "clip", color: "#b8dcff", x: -1, shape: "whale" }, { kind: "choker", color: "#4ee2ec" }],
  },
  // SHION: 청록 안쪽 머리의 검은 층진 단발, 화면 오른쪽의 가는 청록 땋은 가닥과 X 자 핀, 바보털,
  // 둥근 은테 안경, 청록 아몬드 눈, 은색 깃의 검은 재킷.
  {
    hair: "#11161b", streak: "#00c9b4", length: "bob", bangs: "swept", ahoge: true, braid: { x: 1, color: "#00a896" }, eyes: "#00d6bc", eyeShape: "sharp", skin: "#fcece5",
    outfit: "#1d1f24", inner: "#141416", accent: "#e0e5eb", skirt: "#151517", legs: "#18191c",
    accessories: [{ kind: "clip", color: "#00f0ff", x: 1, shape: "x" }, { kind: "glasses", color: "#d8dfe5" }],
  },
  // HIKARI: 적갈색 머리를 화면 오른쪽 어깨로 땋아 내림, 가운데 가르마 앞머리, 카메라 머리핀,
  // 둥근 호박색 눈, 베이지 가디건과 흰 블라우스·검은 리본 타이, 갈색 치마.
  {
    hair: "#9c5430", length: "bob", bangs: "curtain", braid: { x: 1 }, eyes: "#c88225", eyeShape: "round", skin: "#f6d3b6",
    outfit: "#d8bc94", inner: "#efeae0", accent: "#2e2a27", skirt: "#5a4636", legs: "#3f3732",
    accessories: [{ kind: "clip", color: "#a8a49d", x: 1, shape: "camera" }, { kind: "pendant", color: "#2e2a27" }],
  },
];

/** 캐릭터를 특정하지 못한 참여자. 머리카락 없는 회색 인형이라 어느 캐릭터와도 닮지 않는다. */
export const UNKNOWN_APPEARANCE: CharacterAppearance = {
  hair: "#9aa0a8", length: "short", bangs: "choppy", eyes: "#4b5058", eyeShape: "round", skin: "#c9ccd2",
  outfit: "#7d838d", inner: "#9aa0a8", accent: "#b6bbc3", legs: "#5d626b",
  accessories: [],
};

// ---------- 몸 치수(m). 머리 0.4m, 키 약 1.08m 의 2.7등신. ----------
const HIP = 0.36;
const LEG_LENGTH = 0.3;
const SHOULDER_Y = 0.27;
const SHOULDER_X = 0.14;
const ARM_LENGTH = 0.24;
const NECK_Y = 0.31;
const HEAD_RADIUS = 0.2;
const HEAD_CENTER = 0.19;
/** 눈 가운데 높이(머리 중심 기준). 크고 낮게 둬 이마가 넓어 보이게 한다. */
const EYE_Y = -0.035;
const EYE_X = 0.078;
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
    /** 끝이 뾰족한 머리 가닥. 위가 꼭짓점이다. */
    cone: THREE.ConeGeometry;
  };
  /** 빛을 받는 재질(몸·옷·머리). */
  material: (color: string) => THREE.MeshStandardMaterial;
  /** 빛을 받지 않는 재질(눈·하이라이트). 멀리서도 눈빛 색이 흐려지지 않는다. */
  flat: (color: string) => THREE.MeshBasicMaterial;
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
    cone: new THREE.ConeGeometry(1, 1, 10),
  };
  const lit = new Map<string, THREE.MeshStandardMaterial>();
  const unlit = new Map<string, THREE.MeshBasicMaterial>();
  return {
    geometry,
    material: (color) => {
      let material = lit.get(color);
      if (!material) {
        material = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0 });
        lit.set(color, material);
      }
      return material;
    },
    flat: (color) => {
      let material = unlit.get(color);
      if (!material) {
        material = new THREE.MeshBasicMaterial({ color });
        unlit.set(color, material);
      }
      return material;
    },
    dispose: () => {
      for (const value of Object.values(geometry)) value.dispose();
      for (const material of lit.values()) material.dispose();
      for (const material of unlit.values()) material.dispose();
      lit.clear();
      unlit.clear();
    },
  };
}

/** 애니메이션이 움직이는 관절. `baked` 는 이 캐릭터만 쓰는 합친 도형이라 내릴 때 반납한다. */
export interface CharacterRig {
  root: THREE.Group;
  body: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armLeft: THREE.Group;
  armRight: THREE.Group;
  legLeft: THREE.Group;
  legRight: THREE.Group;
  baked: THREE.BufferGeometry[];
}

type Vec3 = readonly [number, number, number];

function addMesh(
  kit: CharacterKit,
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  color: string | THREE.Material,
  position: Vec3,
  scale: Vec3,
  rotation: Vec3 = [0, 0, 0],
  order: THREE.EulerOrder = "XYZ",
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, typeof color === "string" ? kit.material(color) : color);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2], order);
  parent.add(mesh);
  return mesh;
}

function joint(parent: THREE.Object3D, position: Vec3): THREE.Group {
  const group = new THREE.Group();
  group.position.set(...position);
  parent.add(group);
  return group;
}

/** 머리 둘레 위의 한 점(머리 중심 기준 높이 `dy`, 정면에서 돈 각 `angle`). */
function headSurface(dy: number, angle: number, lift = 0): Vec3 {
  const r = HEAD_RADIUS;
  const ring = r * Math.sqrt(Math.max(0, 1 - (dy / (r * 0.97)) ** 2)) + lift;
  return [Math.sin(angle) * ring, HEAD_CENTER + dy, Math.cos(angle) * ring * 0.95];
}

/**
 * 아래로 뾰족한 머리 가닥 하나. 뿌리는 `rootY`(머리 중심 기준)이고 길이 `length`, 반폭 `width`.
 * `tilt` 만큼 끝이 얼굴 앞쪽으로 들리고 `roll` 만큼 옆으로 쓸린다.
 */
function strand(
  kit: CharacterKit,
  head: THREE.Group,
  color: string,
  { angle, rootY, length, width, tilt = 0.32, roll = 0, depth = 0.035, lift = 0.012 }: {
    angle: number; rootY: number; length: number; width: number; tilt?: number; roll?: number; depth?: number; lift?: number;
  },
): void {
  const center = rootY - length * 0.45;
  addMesh(kit, head, kit.geometry.cone, color, headSurface(center, angle, lift), [width, length, depth], [Math.PI - tilt, angle, roll], "YXZ");
}

const BANGS: Record<BangsStyle, readonly { angle: number; length: number; width: number; roll?: number }[]> = {
  choppy: [
    { angle: -0.95, length: 0.15, width: 0.055 },
    { angle: -0.55, length: 0.125, width: 0.06 },
    { angle: -0.18, length: 0.11, width: 0.06 },
    { angle: 0.2, length: 0.13, width: 0.06 },
    { angle: 0.58, length: 0.115, width: 0.06 },
    { angle: 0.95, length: 0.15, width: 0.055 },
  ],
  // 가운데가 갈라져 이마가 보이고 양옆으로 갈수록 길다.
  curtain: [
    { angle: -1.0, length: 0.19, width: 0.055, roll: 0.12 },
    { angle: -0.62, length: 0.15, width: 0.06, roll: 0.22 },
    { angle: -0.26, length: 0.1, width: 0.055, roll: 0.35 },
    { angle: 0.26, length: 0.1, width: 0.055, roll: -0.35 },
    { angle: 0.62, length: 0.15, width: 0.06, roll: -0.22 },
    { angle: 1.0, length: 0.19, width: 0.055, roll: -0.12 },
  ],
  // 화면 왼쪽으로 쓸어 넘긴 가닥. 한쪽이 길게 눈가로 내려온다.
  swept: [
    { angle: -0.95, length: 0.16, width: 0.06, roll: -0.25 },
    { angle: -0.55, length: 0.14, width: 0.065, roll: -0.4 },
    { angle: -0.15, length: 0.125, width: 0.065, roll: -0.45 },
    { angle: 0.25, length: 0.11, width: 0.065, roll: -0.45 },
    { angle: 0.62, length: 0.1, width: 0.06, roll: -0.35 },
    { angle: 0.98, length: 0.13, width: 0.055, roll: -0.2 },
  ],
  // 가는 가닥 사이로 이마가 비친다.
  wispy: [
    { angle: -0.95, length: 0.16, width: 0.05 },
    { angle: -0.5, length: 0.12, width: 0.042, roll: 0.15 },
    { angle: -0.12, length: 0.105, width: 0.04 },
    { angle: 0.3, length: 0.12, width: 0.042, roll: -0.15 },
    { angle: 0.95, length: 0.16, width: 0.05 },
  ],
};

/** 옆머리(볼 옆으로 내려오는 가닥) 길이. 짧은 머리는 볼, 단발은 턱 아래, 긴 머리는 가슴까지. */
const SIDE_LOCK: Record<HairLength, number> = { short: 0.22, bob: 0.27, long: 0.44 };

function buildHair(kit: CharacterKit, head: THREE.Group, look: CharacterAppearance): void {
  const { sphere, dome, box, cone } = kit.geometry;
  const c = HEAD_CENTER;
  const r = HEAD_RADIUS;
  const hair = look.hair;
  // 정수리 덮개: 뒤로 기울여 앞쪽 끝이 눈썹 위에서 멈춘다.
  addMesh(kit, head, dome, hair, [0, c + 0.014, -0.01], [r * 1.12, r * 1.12, r * 1.14], [-0.36, 0, 0]);
  // 앞머리 가닥.
  for (const lock of BANGS[look.bangs]) {
    strand(kit, head, hair, { angle: lock.angle, rootY: 0.145, length: lock.length, width: lock.width, roll: lock.roll ?? 0 });
  }
  if (look.streak) strand(kit, head, look.streak, { angle: 0.4, rootY: 0.13, length: 0.1, width: 0.026, roll: -0.3, lift: 0.022 });
  // 옆머리: 볼 바깥에서 아래로 뾰족하게 내려온다. 브리지가 있으면 안쪽 가닥이 그 색이다.
  const side = SIDE_LOCK[look.length];
  for (const x of [-1, 1]) {
    addMesh(kit, head, cone, hair, [x * 0.19, c + 0.03 - side * 0.5, 0.055], [0.05, side, 0.045], [Math.PI, 0, x * 0.1]);
    if (look.streak) addMesh(kit, head, cone, look.streak, [x * 0.168, c + 0.01 - side * 0.42, 0.075], [0.022, side * 0.7, 0.02], [Math.PI, 0, x * 0.06]);
  }
  // 뒷머리: 짧은 머리는 뒤통수와 뻗친 목덜미, 단발은 바깥으로 뻗친 끝, 긴 머리는 등까지.
  if (look.length === "short") {
    addMesh(kit, head, sphere, hair, [0, c + 0.01, -0.065], [0.212, 0.205, 0.175]);
    for (const x of [-0.1, 0, 0.1]) {
      addMesh(kit, head, cone, hair, [x, c - 0.14, -0.1], [0.05, 0.11, 0.045], [Math.PI + 0.45, 0, x * 2.5]);
    }
  } else {
    addMesh(kit, head, sphere, hair, [0, c - 0.035, -0.085], [0.232, 0.24, 0.188]);
    if (look.length === "bob") {
      for (const x of [-1, 1]) {
        addMesh(kit, head, sphere, hair, [x * 0.175, c - 0.2, -0.05], [0.075, 0.055, 0.09], [0, 0, x * -0.5]);
      }
    } else {
      addMesh(kit, head, sphere, hair, [0, c - 0.3, -0.13], [0.215, 0.33, 0.09], [-0.16, 0, 0]);
      for (const x of [-0.12, 0, 0.12]) {
        addMesh(kit, head, cone, hair, [x, c - 0.63, -0.17], [0.075, 0.13, 0.055], [Math.PI - 0.1, 0, x * 1.5]);
      }
    }
  }
  if (look.ahoge) {
    addMesh(kit, head, cone, hair, [0.02, c + r + 0.06, 0.03], [0.02, 0.13, 0.015], [0.45, 0, -0.55]);
  }
  if (look.ponytail) {
    const x = look.ponytail.x;
    const y = look.ponytail.high ? c + 0.13 : c + 0.02;
    addMesh(kit, head, sphere, hair, [x * 0.18, y, -0.07], [0.055, 0.055, 0.055]);
    addMesh(kit, head, sphere, hair, [x * 0.25, y - 0.06, -0.09], [0.075, 0.08, 0.075], [0, 0, x * 0.3]);
    addMesh(kit, head, sphere, hair, [x * 0.29, y - 0.18, -0.1], [0.062, 0.11, 0.064], [0, 0, x * 0.2]);
    addMesh(kit, head, cone, hair, [x * 0.3, y - 0.33, -0.1], [0.05, 0.13, 0.05], [Math.PI, 0, x * -0.15]);
  }
  if (look.braid) {
    const x = look.braid.x;
    const color = look.braid.color ?? hair;
    // 귀 뒤에서 어깨 앞으로 내려오는 매듭. 끝으로 갈수록 가늘어진다.
    for (let index = 0; index < 5; index += 1) {
      const size = 0.048 - index * 0.004;
      addMesh(kit, head, sphere, color, [x * (0.17 - index * 0.008), c - 0.1 - index * 0.068, 0.06 + index * 0.022], [size, size * 1.15, size]);
    }
    addMesh(kit, head, box, "#2b2b2b", [x * 0.135, c - 0.45, 0.16], [0.045, 0.02, 0.045]);
  }
}

/** 눈 하나: 속눈썹 선, 눈동자, 동공, 큰 하이라이트와 작은 하이라이트. 오른쪽(-x)이 `side` -1. */
function buildEye(kit: CharacterKit, head: THREE.Group, look: CharacterAppearance, side: number, pupil: string): void {
  const { sphere } = kit.geometry;
  const sharp = look.eyeShape === "sharp";
  const height = sharp ? 0.05 : 0.058;
  const x = side * EYE_X;
  const y = HEAD_CENTER + EYE_Y;
  // 얼굴 곡면을 따라 바깥으로 살짝 돌린다.
  const turn = side * 0.38;
  addMesh(kit, head, sphere, kit.flat(look.eyes), [x, y, 0.168], [0.043, height, 0.02], [0, turn, 0]);
  addMesh(kit, head, sphere, kit.flat(pupil), [x - side * 0.003, y - 0.006, 0.184], [0.023, height * 0.55, 0.008], [0, turn, 0]);
  // 눈매 선: 눈동자 뒤에 조금 크고 위로 올린 짙은 타원을 둬 윗눈꺼풀 선이 눈동자를 감싼다(따로 뜬
  // 막대면 눈썹처럼 읽혀 표정이 굳는다). 아몬드 눈은 눈꼬리 끝을 위로 짧게 뺀다.
  addMesh(kit, head, sphere, kit.flat("#2a1d22"), [x, y + height * 0.1, 0.167], [0.049, height * 1.1, 0.016], [0, turn, 0]);
  if (sharp) addMesh(kit, head, sphere, kit.flat("#2a1d22"), [x + side * 0.046, y + height * 0.92, 0.17], [0.018, 0.007, 0.008], [0, turn, side * 0.5]);
  addMesh(kit, head, sphere, kit.flat("#ffffff"), [x + side * 0.013, y + height * 0.3, 0.19], [0.014, 0.017, 0.006], [0, turn, 0]);
  addMesh(kit, head, sphere, kit.flat("#ffffff"), [x - side * 0.014, y - height * 0.5, 0.188], [0.007, 0.007, 0.004], [0, turn, 0]);
}

function buildAccessories(kit: CharacterKit, head: THREE.Group, torso: THREE.Group, look: CharacterAppearance): void {
  const { sphere, box, ring, cone } = kit.geometry;
  const c = HEAD_CENTER;
  for (const accessory of look.accessories) {
    switch (accessory.kind) {
      case "bow": {
        const s = accessory.size;
        const at: Vec3 = [accessory.x, c + accessory.y, accessory.z];
        for (const side of [-1, 1]) {
          addMesh(kit, head, sphere, accessory.color, [at[0] + side * 0.058 * s, at[1], at[2]], [0.064 * s, 0.042 * s, 0.026 * s], [0, 0, side * 0.35]);
          if (accessory.tails) {
            addMesh(kit, head, cone, accessory.color, [at[0] + side * 0.03 * s, at[1] - 0.09 * s, at[2] - 0.01], [0.024 * s, 0.13 * s, 0.01], [Math.PI, 0, side * -0.25]);
          }
        }
        addMesh(kit, head, sphere, accessory.color, at, [0.026 * s, 0.026 * s, 0.026 * s]);
        break;
      }
      case "goggles":
        for (const side of [-1, 1]) {
          addMesh(kit, head, ring, accessory.frame, [side * 0.066, c + 0.17, 0.12], [0.047, 0.047, 0.047], [-0.95, 0, 0]);
          addMesh(kit, head, sphere, accessory.lens, [side * 0.066, c + 0.173, 0.122], [0.04, 0.012, 0.04], [-0.95 + Math.PI / 2, 0, 0]);
        }
        break;
      case "clip": {
        const x = accessory.x;
        const at: Vec3 = [x * 0.15, c + 0.1, 0.125];
        switch (accessory.shape ?? "bar") {
          case "x":
            for (const roll of [0.78, -0.78]) addMesh(kit, head, box, accessory.color, at, [0.06, 0.016, 0.016], [0, x * 0.5, roll]);
            break;
          case "whale":
            addMesh(kit, head, sphere, accessory.color, at, [0.04, 0.027, 0.02], [0, x * 0.5, 0]);
            addMesh(kit, head, cone, accessory.color, [at[0] + x * 0.045, at[1] + 0.012, at[2] - 0.012], [0.018, 0.035, 0.008], [0, x * 0.5, x * 0.9]);
            break;
          case "camera":
            addMesh(kit, head, box, accessory.color, at, [0.055, 0.036, 0.022], [0, x * 0.5, 0]);
            addMesh(kit, head, sphere, "#2b2b2b", [at[0] - x * 0.005, at[1], at[2] + 0.012], [0.012, 0.012, 0.008]);
            break;
          default:
            addMesh(kit, head, box, accessory.color, at, [0.055, 0.022, 0.02], [0, 0, x * -0.5]);
        }
        break;
      }
      case "glasses":
        for (const side of [-1, 1]) {
          addMesh(kit, head, ring, accessory.color, [side * EYE_X, c + EYE_Y, 0.198], [0.056, 0.056, 0.03], [0, side * 0.3, 0]);
        }
        addMesh(kit, head, box, accessory.color, [0, c + EYE_Y + 0.01, 0.205], [0.04, 0.007, 0.007]);
        break;
      case "pendant":
        addMesh(kit, torso, sphere, accessory.color, [0, 0.235, 0.1], [0.022, 0.022, 0.012]);
        break;
      case "choker":
        addMesh(kit, torso, ring, accessory.color, [0, NECK_Y - 0.005, 0], [0.05, 0.05, 0.07], [Math.PI / 2, 0, 0]);
        addMesh(kit, torso, sphere, accessory.color, [0, NECK_Y - 0.03, 0.052], [0.014, 0.016, 0.01]);
        break;
    }
  }
}

/**
 * 관절 하나에 바로 붙은 조각들을 재질별로 한 도형으로 합친다. 관절(Group) 자식은 그대로 두어
 * 애니메이션이 움직이는 축은 바뀌지 않는다. 합친 도형은 이 캐릭터만 쓰므로 `baked` 에 모은다.
 */
function bakeJoint(group: THREE.Group, baked: THREE.BufferGeometry[]): void {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const meshes = group.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
  for (const mesh of meshes) {
    mesh.updateMatrix();
    const piece = mesh.geometry.clone().applyMatrix4(mesh.matrix);
    const material = mesh.material as THREE.Material;
    const list = byMaterial.get(material) ?? [];
    list.push(piece);
    byMaterial.set(material, list);
    group.remove(mesh);
  }
  for (const [material, pieces] of byMaterial) {
    const merged = pieces.length === 1 ? pieces[0] : mergeGeometries(pieces, false);
    if (pieces.length > 1) for (const piece of pieces) piece.dispose();
    if (!merged) continue;
    baked.push(merged);
    group.add(new THREE.Mesh(merged, material));
  }
}

/** 겉모습 하나로 캐릭터 한 명을 만든다. 도형·재질은 `kit` 것을 함께 쓴다. */
export function buildCharacter(kit: CharacterKit, look: CharacterAppearance, faceless = false): CharacterRig {
  const { sphere, cylinder, torso: torsoShape, box } = kit.geometry;
  const root = new THREE.Group();
  const body = joint(root, [0, 0, 0]);

  const legLeft = joint(body, [0.062, HIP, 0]);
  const legRight = joint(body, [-0.062, HIP, 0]);
  for (const leg of [legLeft, legRight]) {
    addMesh(kit, leg, cylinder, look.legs, [0, -LEG_LENGTH / 2, 0], [0.048, LEG_LENGTH, 0.048]);
    addMesh(kit, leg, box, "#2b2a2e", [0, -LEG_LENGTH - 0.022, 0.022], [0.08, 0.045, 0.13]);
  }

  const torso = joint(body, [0, HIP, 0]);
  addMesh(kit, torso, torsoShape, look.outfit, [0, 0.15, 0], [0.15, 0.3, 0.122]);
  // 겉옷 앞섶 사이로 보이는 안옷.
  addMesh(kit, torso, box, look.inner, [0, 0.17, 0.106], [0.075, 0.2, 0.02], [-0.13, 0, 0]);
  // 목깃.
  addMesh(kit, torso, kit.geometry.ring, look.accent, [0, 0.3, 0], [0.08, 0.08, 0.065], [Math.PI / 2, 0, 0]);
  addMesh(kit, torso, cylinder, look.skin, [0, NECK_Y, 0], [0.04, 0.06, 0.04]);
  if (look.hood) addMesh(kit, torso, sphere, look.outfit, [0, 0.29, -0.1], [0.13, 0.065, 0.07], [0.3, 0, 0]);
  // 치마: 허리에서 퍼지는 종 모양. 다리 관절과 따로라 걷고 앉아도 그대로 있다.
  if (look.skirt) addMesh(kit, torso, torsoShape, look.skirt, [0, -0.045, 0], [0.19, 0.13, 0.17]);

  const armLeft = joint(torso, [SHOULDER_X, SHOULDER_Y, 0]);
  const armRight = joint(torso, [-SHOULDER_X, SHOULDER_Y, 0]);
  for (const arm of [armLeft, armRight]) {
    addMesh(kit, arm, cylinder, look.outfit, [0, -ARM_LENGTH / 2, 0], [0.042, ARM_LENGTH, 0.042]);
    if (look.stripe) addMesh(kit, arm, cylinder, look.stripe, [0, -ARM_LENGTH * 0.45, 0], [0.045, 0.03, 0.045]);
    addMesh(kit, arm, cylinder, look.accent, [0, -ARM_LENGTH + 0.015, 0], [0.046, 0.03, 0.046]);
    addMesh(kit, arm, sphere, look.skin, [0, -ARM_LENGTH - 0.026, 0], [0.04, 0.042, 0.04]);
  }

  const head = joint(torso, [0, NECK_Y + 0.02, 0]);
  // 얼굴: 둥근 머리 하나. 턱을 따로 붙이면 만나는 선이 얼굴을 가로지르는 주름으로 보였다.
  addMesh(kit, head, sphere, look.skin, [0, HEAD_CENTER, 0], [HEAD_RADIUS, HEAD_RADIUS * 0.97, HEAD_RADIUS * 0.95]);
  if (faceless) {
    for (const side of [-1, 1]) {
      addMesh(kit, head, sphere, look.eyes, [side * 0.072, HEAD_CENTER - 0.02, 0.178], [0.034, 0.046, 0.02]);
    }
  } else {
    const pupil = `#${new THREE.Color(look.eyes).multiplyScalar(0.32).getHexString()}`;
    for (const side of [-1, 1]) {
      buildEye(kit, head, look, side, pupil);
      addMesh(kit, head, sphere, "#f6aaa6", [side * 0.105, HEAD_CENTER - 0.105, 0.122], [0.03, 0.012, 0.01], [0, side * 0.6, 0]);
    }
  }
  addMesh(kit, head, sphere, "#b85a5c", [0, HEAD_CENTER - 0.125, 0.143], [0.018, 0.007, 0.006]);
  if (!faceless) buildHair(kit, head, look);
  buildAccessories(kit, head, torso, look);

  const baked: THREE.BufferGeometry[] = [];
  for (const group of [legLeft, legRight, torso, armLeft, armRight, head]) bakeJoint(group, baked);
  return { root, body, torso, head, armLeft, armRight, legLeft, legRight, baked };
}

/** `buildCharacter` 가 이 캐릭터만을 위해 합친 도형을 반납한다. 공용 도형·재질은 `kit` 이 반납한다. */
export function disposeCharacter(rig: CharacterRig): void {
  for (const geometry of rig.baked) geometry.dispose();
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
