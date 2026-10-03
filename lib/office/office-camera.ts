/**
 * 오피스 3D 장면의 보기 조작. 장면은 늘 사무실 전체가 들어오는 거리(맞춤)를 먼저 잡고, 사용자가
 * 확대한 만큼 그 거리에서 다가가고 바라보는 점을 바닥 위로 옮긴다. 확대하지 않으면 옮길 곳이 없다.
 */

/** 화면에 늘 담는 사무실 상자(m). 휴게 구역 왼쪽 끝~오른쪽 책상, 뒷줄 의자~앞 러그, 바닥~머리 높이. */
export const OFFICE_CAMERA_BOUNDS = { minX: -3.95, maxX: 3.4, minZ: -2, maxZ: 3, height: 1.15 } as const;

export interface OfficeCameraView {
  /** 맞춤 거리 대비 배율. 1 이면 사무실 전체가 들어온다. */
  zoom: number;
  /** 바라보는 점을 맞춤 위치에서 옮긴 바닥 거리(m). x 는 화면 좌우, z 는 화면 위아래(깊이)다. */
  x: number;
  z: number;
}

export const OFFICE_CAMERA_FIT: OfficeCameraView = { zoom: 1, x: 0, z: 0 };
export const OFFICE_ZOOM_MAX = 3;
const ZOOM_STEP = 1.25;
/** 옮기기 버튼 한 번의 거리(m). 확대할수록 화면에서 같은 몫이 되게 배율로 나눈다. */
const PAN_STEP = 0.9;

const HALF_X = (OFFICE_CAMERA_BOUNDS.maxX - OFFICE_CAMERA_BOUNDS.minX) / 2;
const HALF_Z = (OFFICE_CAMERA_BOUNDS.maxZ - OFFICE_CAMERA_BOUNDS.minZ) / 2;

/** 배율을 1~최대로, 바라보는 점을 확대한 만큼만 상자 안에서 움직이게 묶는다. */
export function clampOfficeView(view: OfficeCameraView): OfficeCameraView {
  const zoom = Math.min(OFFICE_ZOOM_MAX, Math.max(1, view.zoom));
  const limitX = HALF_X * (1 - 1 / zoom);
  const limitZ = HALF_Z * (1 - 1 / zoom);
  return { zoom, x: Math.min(limitX, Math.max(-limitX, view.x)), z: Math.min(limitZ, Math.max(-limitZ, view.z)) };
}

/** 한 단계 확대(`1`)하거나 축소(`-1`)한다. 축소하면 옮길 수 있는 범위도 줄어 가운데로 당겨진다. */
export function zoomOfficeView(view: OfficeCameraView, direction: 1 | -1): OfficeCameraView {
  const raw = direction > 0 ? view.zoom * ZOOM_STEP : view.zoom / ZOOM_STEP;
  // 몇 번 누르면 정확히 1 로 돌아오게 반올림 오차를 버린다.
  return clampOfficeView({ ...view, zoom: Math.abs(raw - 1) < 0.01 ? 1 : raw });
}

/** 바닥 거리(m)만큼 바라보는 점을 옮긴다. 끌기는 바닥에서 잰 거리를 그대로 넘긴다. */
export function panOfficeView(view: OfficeCameraView, dx: number, dz: number): OfficeCameraView {
  return clampOfficeView({ zoom: view.zoom, x: view.x + dx, z: view.z + dz });
}

/** 옮기기 버튼 한 번. `dx`·`dz` 는 -1·0·1 방향이다. */
export function stepOfficeView(view: OfficeCameraView, dx: number, dz: number): OfficeCameraView {
  const step = PAN_STEP / view.zoom;
  return panOfficeView(view, dx * step, dz * step);
}

/** 이 방향으로 더 옮길 수 있는지. 끝에 닿은 버튼을 끈다. */
export function canPanOfficeView(view: OfficeCameraView, dx: number, dz: number): boolean {
  const room = 1 - 1 / view.zoom;
  const eps = 1e-3;
  if (dx < 0 && view.x <= -HALF_X * room + eps) return false;
  if (dx > 0 && view.x >= HALF_X * room - eps) return false;
  if (dz < 0 && view.z <= -HALF_Z * room + eps) return false;
  if (dz > 0 && view.z >= HALF_Z * room - eps) return false;
  return dx !== 0 || dz !== 0;
}
