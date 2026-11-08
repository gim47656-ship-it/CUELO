/**
 * 흑연 테마(선택형, 기본 꺼짐). 브라우저마다 `localStorage`에 켜짐 여부와 마지막 배경을 두고,
 * `<html>`의 두 속성으로만 화면에 반영한다. 색과 배치는 `app/globals.css`의
 * `html.dark[data-cuelo-look="graphite"]` 아래에만 있어 꺼져 있거나 라이트 모드면 아무것도 바뀌지 않는다.
 *
 * - `data-cuelo-look="graphite"`: 테마가 켜져 있다.
 * - `data-cuelo-wallpaper="default" | "office"`: 지금 캐릭터 모드의 배경. 모드를 아직 모르면 속성이 없고
 *   그림 없이 흑연만 보인다. 사무실 배경 파일이 없는 PC에서도 그림만 비고, 기본 모드 그림으로 바꾸지 않는다.
 *
 * `<html>`의 인라인 사용자 변수는 `hooks/useTheme.ts`가 테마를 적용할 때마다 지우므로 속성을 쓴다.
 */

export const GRAPHITE_STORAGE_KEY = "cuelo-look";
export const GRAPHITE_WALLPAPER_STORAGE_KEY = "cuelo-look-wallpaper";
export const GRAPHITE_LOOK_ATTRIBUTE = "data-cuelo-look";
export const GRAPHITE_WALLPAPER_ATTRIBUTE = "data-cuelo-wallpaper";

export type GraphiteWallpaper = "default" | "office";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 저장했으면 true. 막혀 있으면 false를 돌려주고, 부른 쪽이 이번 화면 상태를 따로 들고 있는다. */
function writeStorage(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function readStoredWallpaper(): GraphiteWallpaper | null {
  const stored = readStorage(GRAPHITE_WALLPAPER_STORAGE_KEY);
  return stored === "default" || stored === "office" ? stored : null;
}

function applyAttributes(enabled: boolean, wallpaper: GraphiteWallpaper | null): void {
  const root = document.documentElement;
  if (enabled) root.setAttribute(GRAPHITE_LOOK_ATTRIBUTE, "graphite");
  else root.removeAttribute(GRAPHITE_LOOK_ATTRIBUTE);
  if (enabled && wallpaper) root.setAttribute(GRAPHITE_WALLPAPER_ATTRIBUTE, wallpaper);
  else root.removeAttribute(GRAPHITE_WALLPAPER_ATTRIBUTE);
}

const listeners = new Set<() => void>();
/** 저장하지 못했을 때만 쓰는 이번 화면의 값. 다음 저장이 되면 다시 저장값을 따른다. */
let unsavedEnabled: boolean | null = null;
let unsavedWallpaper: GraphiteWallpaper | null = null;

export function isGraphiteEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return unsavedEnabled ?? readStorage(GRAPHITE_STORAGE_KEY) === "graphite";
}

export function setGraphiteEnabled(enabled: boolean): void {
  unsavedEnabled = writeStorage(GRAPHITE_STORAGE_KEY, enabled ? "graphite" : null) ? null : enabled;
  applyAttributes(enabled, unsavedWallpaper ?? readStoredWallpaper());
  listeners.forEach((listener) => listener());
}

/** 캐릭터 모드를 알게 됐을 때 부른다. 사무실이 아니면 기본 모드 배경이고, 다음 첫 화면도 같은 배경으로 그리도록 저장한다. */
export function applyGraphiteWallpaper(mode: string): void {
  const wallpaper: GraphiteWallpaper = mode === "office" ? "office" : "default";
  unsavedWallpaper = writeStorage(GRAPHITE_WALLPAPER_STORAGE_KEY, wallpaper) ? null : wallpaper;
  applyAttributes(isGraphiteEnabled(), wallpaper);
}

export function subscribeGraphite(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `<head>`에서 첫 화면 전에 도는 스크립트. 위 `applyAttributes`와 같은 규칙을 저장값으로 적용한다.
 * 기존 색 모드 스크립트(`app/layout.tsx`)와 분리해 그 스크립트의 계약을 건드리지 않는다.
 */
export const GRAPHITE_BOOTSTRAP = `(function(){try{var s=localStorage,r=document.documentElement;if(s.getItem(${JSON.stringify(GRAPHITE_STORAGE_KEY)})!=="graphite")return;r.setAttribute(${JSON.stringify(GRAPHITE_LOOK_ATTRIBUTE)},"graphite");var w=s.getItem(${JSON.stringify(GRAPHITE_WALLPAPER_STORAGE_KEY)});if(w==="default"||w==="office")r.setAttribute(${JSON.stringify(GRAPHITE_WALLPAPER_ATTRIBUTE)},w)}catch(e){}})()`;
