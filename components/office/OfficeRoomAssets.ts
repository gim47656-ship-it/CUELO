import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { OFFICE_LOUNGE, type OfficeLayout } from "@/lib/office/office-stage";

/**
 * 에셋으로 꾸민 사무실. `public/office3d/office-kit.glb` 한 장에서 노드를 복제해 배치(`OfficeLayout`)대로
 * 놓는다. 그 GLB 는 KayKit·Kenney CC0 모델을 이름 붙은 노드로 묶은 것이고, 출처는
 * `public/office3d/ASSETS.md` 에 있다. 움직이지 않는 조각은 재질마다 한 도형으로 합쳐 그리기 호출을
 * 줄이고, 일하는 동안 켜지는 모니터 화면만 따로 둔다. 좌석·휴게 자리 좌표는
 * `lib/office/office-stage.ts` 가 정하고, 여기서는 그 자리에 가구를 맞출 뿐이다.
 */

export const OFFICE_KIT_URL = "/office3d/office-kit.glb";

/** 장면 단위 치수. 책상 높이·깊이는 코드 도형 방(`OfficeScene3D` `Desk`)과 같다. */
const DESK_HEIGHT = 0.42;
const DESK_DEPTH = 0.5;
/** 사무 의자 좌판 높이. 앉은 엉덩이(`SEATED_HIP` 0.25) 바로 밑. */
const CHAIR_SEAT = 0.22;
/** 카운터 윗면 높이(키트 `counter`). 커피머신·화분을 그 위에 놓는다. */
const COUNTER_TOP = 0.456;

type Vec3 = readonly [number, number, number];

export interface AssetRoom {
  group: THREE.Group;
  /** 좌석 키별 모니터 화면. 일하는 동안 켠다. */
  setLit: (lit: ReadonlyMap<string, boolean>) => void;
  dispose: () => void;
}

interface Piece {
  name: string;
  at: Vec3;
  /** y 축 회전(도). 0 이면 앞이 +z(카메라 쪽). */
  yaw?: number;
  scale?: number | Vec3;
}

function place(kit: THREE.Object3D, parent: THREE.Object3D, piece: Piece): THREE.Object3D | null {
  const source = kit.getObjectByName(piece.name);
  if (!source) return null;
  const object = source.clone(true);
  object.position.set(...piece.at);
  object.rotation.y = ((piece.yaw ?? 0) * Math.PI) / 180;
  if (typeof piece.scale === "number") object.scale.setScalar(piece.scale);
  else if (piece.scale) object.scale.set(...piece.scale);
  parent.add(object);
  return object;
}

/** 방 껍데기와 고정 소품. 배치와 상관없이 늘 같다. 벽 안쪽 면은 뒤 z -2.85, 왼쪽 x -4.25 다. */
const SHELL: readonly Piece[] = [
  // 뒷벽: 민 벽, 창 둘, 민 벽. 조각 하나 폭 2.1m.
  { name: "wall", at: [-3.15, 0, -3.0], scale: [0.875, 1, 1] },
  { name: "wallWindow", at: [-1.05, 0, -3.0], scale: [0.875, 1, 1] },
  { name: "wallWindow", at: [1.05, 0, -3.0], scale: [0.875, 1, 1] },
  { name: "wall", at: [3.15, 0, -3.0], scale: [0.875, 1, 1] },
  // 왼벽: 문(z -0.75, `OFFICE_ENTRANCE`)을 사이에 둔 세 조각.
  { name: "wall", at: [-4.4, 0, -2.4], yaw: 90, scale: [0.375, 1, 1] },
  { name: "wallDoor", at: [-4.4, 0, -0.75], yaw: 90 },
  { name: "wall", at: [-4.4, 0, 1.75], yaw: 90, scale: [1.083, 1, 1] },
  // 벽 장식과 사무 소품.
  { name: "shelf", at: [-3.15, 1.25, -2.85] },
  { name: "frame", at: [3.15, 1.35, -2.85] },
  { name: "frameSmall", at: [2.6, 1.15, -2.85] },
  { name: "frameSmall", at: [-4.25, 1.35, 1.2], yaw: 90 },
  { name: "bookcase", at: [3.75, 0, -2.85] },
  { name: "bookcase", at: [-3.75, 0, -2.85] },
  { name: "plantTall", at: [4.0, 0, -0.9] },
  { name: "plantTall", at: [-0.05, 0, -2.45] },
  { name: "trashcan", at: [3.85, 0, 0.4] },
  { name: "lamp", at: [-4.0, 0, 0.45] },
  // 참여자가 쉬는 러그.
  { name: "rugOval", at: [0.3, 0.004, 2.05], scale: [1.7, 1, 1.75] },
  // 휴게 구역: 러그·소파·암체어·낮은 탁자.
  { name: "rugRect", at: [-2.75, 0.004, 1.35], scale: [2.1, 1, 1.6] },
  { name: "couch", at: [OFFICE_LOUNGE.couch.x, 0, OFFICE_LOUNGE.couch.z] },
  { name: "armchair", at: [OFFICE_LOUNGE.armchair.x, 0, OFFICE_LOUNGE.armchair.z], yaw: -18 },
  { name: "tableLow", at: [OFFICE_LOUNGE.couch.x + 0.1, 0, OFFICE_LOUNGE.couch.z + 0.8] },
  { name: "cactusSmall", at: [OFFICE_LOUNGE.couch.x - 0.1, 0.19, OFFICE_LOUNGE.couch.z + 0.8] },
  // 탕비 공간: 체크 바닥, 왼벽 카운터 둘과 커피머신, 둥근 탁자와 스툴.
  { name: "floorTile", at: [-3.65, 0.006, 2.55], scale: 0.5 },
  { name: "floorTile", at: [-2.45, 0.006, 2.55], scale: 0.5 },
  { name: "counter", at: [-3.86, 0, OFFICE_LOUNGE.counter.z - 0.38], yaw: 90 },
  { name: "counter", at: [-3.86, 0, OFFICE_LOUNGE.counter.z + 0.38], yaw: 90 },
  { name: "coffeeMachine", at: [-3.95, COUNTER_TOP, OFFICE_LOUNGE.counter.z + 0.4], yaw: 90 },
  { name: "cactusSmall", at: [-3.95, COUNTER_TOP, OFFICE_LOUNGE.counter.z - 0.45] },
  { name: "roundTable", at: [OFFICE_LOUNGE.table.x, 0, OFFICE_LOUNGE.table.z] },
  // 키트 스툴(높이 0.19)을 앉은 엉덩이 높이(0.25)까지 올린다.
  { name: "stool", at: [OFFICE_LOUNGE.table.x - OFFICE_LOUNGE.stool, 0, OFFICE_LOUNGE.table.z], scale: [1.15, 1.3, 1.15] },
  { name: "stool", at: [OFFICE_LOUNGE.table.x + OFFICE_LOUNGE.stool, 0, OFFICE_LOUNGE.table.z], scale: [1.15, 1.3, 1.15] },
  { name: "cactus", at: [-1.3, 0, 0.95] },
  { name: "plantTall", at: [3.95, 0, 2.75] },
];

/**
 * 배치 하나로 방을 짓는다. 책상은 그 줄의 좌석 수만큼 넓히고, 앉는 자리마다 사무 의자·모니터·
 * 키보드를 놓는다. 주인이 참여하지 않은 책상에는 의자 하나를 밀어 넣어 둔다. `cushion` 은 책상
 * 주인의 의자 좌판 색이다.
 */
export function buildAssetRoom(kit: THREE.Object3D, layout: OfficeLayout, cushion: (seat: number) => string): AssetRoom {
  const group = new THREE.Group();
  // 벽 안쪽 면(뒤 z -2.85, 왼쪽 x -4.25) 밑까지 깔아 이음매에 배경이 비치지 않게 한다.
  const floorGeometry = new THREE.PlaneGeometry(8.5, 6.0);
  const floorMaterial = new THREE.MeshStandardMaterial({ color: "#e9dfcf", roughness: 0.95 });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 0.1);
  group.add(floor);

  const statics = new THREE.Group();
  group.add(statics);
  for (const piece of SHELL) place(kit, statics, piece);

  const sizeOf = (name: string) => {
    const source = kit.getObjectByName(name);
    return source ? new THREE.Box3().setFromObject(source).getSize(new THREE.Vector3()) : new THREE.Vector3(1, 1, 1);
  };
  const deskSize = sizeOf("desk");
  // 키트 사무 의자의 좌판은 높이의 약 0.44 지점이다.
  const chairScale = CHAIR_SEAT / (sizeOf("chairDesk").y * 0.44);
  const screenOff = new THREE.MeshBasicMaterial({ color: "#2a3036" });
  const screenOn = new THREE.MeshBasicMaterial({ color: "#a8d8ff" });
  const lampOff = new THREE.MeshBasicMaterial({ color: "#565b63" });
  const lampOn = new THREE.MeshBasicMaterial({ color: "#7cc4ff" });
  const glowGeometry = new THREE.PlaneGeometry(1, 1);
  const dotGeometry = new THREE.CircleGeometry(0.018, 12);
  const screens = new Map<string, { face: THREE.Mesh; dot: THREE.Mesh }>();
  const cushions = new Map<string, THREE.MeshStandardMaterial>();

  layout.desks.forEach((desk, index) => {
    // 키트 책상은 앞(서랍·옆판)이 -z 라 돌려서 카메라 쪽에 가림판이 오게 한다.
    place(kit, statics, {
      name: "desk",
      at: [desk.center.x, 0, desk.center.z],
      yaw: 180,
      scale: [desk.width / deskSize.x, DESK_HEIGHT / deskSize.y, DESK_DEPTH / deskSize.z],
    });
    const seats = layout.stations.filter((station) => station.deskIndex === index);
    const spots = seats.length > 0
      ? seats.map((station) => ({ x: station.desk.point.x, z: station.desk.point.z, key: station.key }))
      : [{ x: desk.center.x, z: desk.center.z - 0.34, key: "" }];
    for (const spot of spots) {
      const chair = place(kit, statics, { name: "chairDesk", at: [spot.x, 0, spot.z - (spot.key ? 0.04 : 0)], scale: chairScale });
      // 의자 좌판(키트 재질 `carpet`)은 책상 주인의 머리색으로 물들인다.
      if (chair && desk.seat !== null) {
        const color = cushion(desk.seat);
        chair.traverse((child) => {
          if (!(child instanceof THREE.Mesh) || !(child.material instanceof THREE.MeshStandardMaterial) || child.material.name !== "carpet") return;
          let material = cushions.get(color);
          if (!material) {
            material = child.material.clone();
            material.color.set(color);
            cushions.set(color, material);
          }
          child.material = material;
        });
      }
      // 키트 모니터·키보드는 앞이 +z 라 돌려서 앉은 사람(-z) 쪽을 보게 한다.
      const monitor = place(kit, statics, { name: "screen", at: [spot.x, DESK_HEIGHT, spot.z + 0.33], yaw: 180 });
      place(kit, statics, { name: "keyboard", at: [spot.x, DESK_HEIGHT, spot.z + 0.2], yaw: 180 });
      if (monitor && spot.key) {
        // 화면은 앉은 사람 쪽(-z), 표시등은 카메라 쪽 뒷면에 붙인다.
        const box = new THREE.Box3().setFromObject(monitor);
        const size = box.getSize(new THREE.Vector3());
        const face = new THREE.Mesh(glowGeometry, screenOff);
        face.scale.set(size.x * 0.86, size.y * 0.62, 1);
        face.position.set(spot.x, box.min.y + size.y * 0.62, box.min.z - 0.003);
        face.rotation.y = Math.PI;
        const dot = new THREE.Mesh(dotGeometry, lampOff);
        dot.position.set(spot.x, box.min.y + size.y * 0.62, box.max.z + 0.003);
        group.add(face, dot);
        screens.set(spot.key, { face, dot });
      }
    }
  });

  const merged = mergeStatics(statics);

  return {
    group,
    setLit: (lit) => {
      for (const [key, screen] of screens) {
        const on = lit.get(key) === true;
        screen.face.material = on ? screenOn : screenOff;
        screen.dot.material = on ? lampOn : lampOff;
      }
    },
    dispose: () => {
      for (const geometry of merged) geometry.dispose();
      for (const material of [floorMaterial, screenOff, screenOn, lampOff, lampOn, ...cushions.values()]) material.dispose();
      for (const geometry of [floorGeometry, glowGeometry, dotGeometry]) geometry.dispose();
    },
  };
}

/**
 * 움직이지 않는 조각을 재질마다 한 도형으로 합친다. 합친 도형은 이 방만 쓰므로 돌려줘서 내릴 때
 * 반납한다. 키트 원본 도형·재질은 건드리지 않는다(키트는 장면이 따로 반납한다).
 */
function mergeStatics(statics: THREE.Group): THREE.BufferGeometry[] {
  statics.updateMatrixWorld(true);
  const inverse = statics.matrixWorld.clone().invert();
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const local = new THREE.Matrix4();
  statics.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) return;
    // 양자화된 키트 도형은 정수 속성이라 합치기 전에 실수로 펴 둔다.
    const piece = dequantized(child.geometry).applyMatrix4(local.multiplyMatrices(inverse, child.matrixWorld));
    const list = byMaterial.get(child.material) ?? [];
    list.push(piece);
    byMaterial.set(child.material, list);
  });
  statics.clear();
  const merged: THREE.BufferGeometry[] = [];
  for (const [material, pieces] of byMaterial) {
    const geometry = pieces.length > 1 ? mergeGeometries(pieces, false) : pieces[0];
    if (geometry && geometry !== pieces[0]) for (const piece of pieces) piece.dispose();
    const parts = geometry ? [geometry] : pieces;
    for (const part of parts) {
      merged.push(part);
      statics.add(new THREE.Mesh(part, material));
    }
  }
  return merged;
}

/** 위치·법선·UV 를 실수 속성으로 복사한 도형. 원본은 그대로 둔다. */
function dequantized(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"] as const) {
    const attribute = source.getAttribute(name);
    if (!attribute) continue;
    const values = new Float32Array(attribute.count * attribute.itemSize);
    for (let index = 0; index < attribute.count; index += 1) {
      for (let component = 0; component < attribute.itemSize; component += 1) {
        values[index * attribute.itemSize + component] = attribute.getComponent(index, component);
      }
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
  }
  const index = source.getIndex();
  if (index) geometry.setIndex(Array.from(index.array));
  return geometry;
}
