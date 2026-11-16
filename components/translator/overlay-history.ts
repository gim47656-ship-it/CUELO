/**
 * 통역 화면이 덮어 띄우는 것(마주보기·보여주기 카드·자주 쓰는 문장·사진 해설)을 폰의 뒤로가기로 닫게 하는
 * 기록 쌓기. 앱은 브라우저 기록을 쓰지 않으므로(doc/history/2026/11/15-routine-back-scroll) 이 화면은
 * 덮개 하나마다 같은 주소에 기록 한 칸을 얹고, 덮개를 닫으면 그 칸을 스스로 걷어 낸다. 뒤로가기가
 * 앱을 닫거나 통역 화면을 떠나는 일은 덮개가 열려 있는 동안 일어나지 않는다.
 *
 * React 밖의 순수 함수다. 화면 쪽(`useOverlayHistory`)은 지금 기록에 얹힌 칸 목록과 열려 있어야 할
 * 덮개 목록만 넘기고, 여기서 몇 칸을 걷고 무엇을 얹을지 정한다.
 */

export type OverlayMarker = "face" | "phrases" | "scan" | "card";

/** 이 화면이 얹은 기록 칸의 `history.state` 속 표시. 칸의 깊이(1부터)를 함께 둬 어디까지 돌아왔는지 안다. */
export const HISTORY_MARKER_KEY = "cueloTranslator";

export interface MarkerState {
  [HISTORY_MARKER_KEY]: OverlayMarker;
  cueloTranslatorDepth: number;
}

export function markerState(marker: OverlayMarker, depth: number): MarkerState {
  return { [HISTORY_MARKER_KEY]: marker, cueloTranslatorDepth: depth };
}

/** `history.state`가 이 화면이 얹은 칸이면 그 깊이, 아니면 0. */
export function stateDepth(state: unknown): number {
  if (!state || typeof state !== "object") return 0;
  const record = state as Record<string, unknown>;
  const depth = record.cueloTranslatorDepth;
  return typeof record[HISTORY_MARKER_KEY] === "string" && typeof depth === "number" && Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * 같은 주소에서 지금 칸의 상태를 갈아 끼울 때(`replaceState`) 이 화면 표시를 잇는다. Next 라우터는 자기
 * 상태가 바뀌면 지금 칸을 표시 없는 새 상태로 덮는데(2026-11-16 격리 빌드: 마주보기를 켠 지 70ms 뒤),
 * 그러면 그 칸이 이 화면 것인지 알 수 없어 걷지 못하고 남는다. 지금 칸이 이 화면 것이 아니거나, 새
 * 상태가 이미 표시를 가졌거나, 주소가 바뀌면 그대로 둔다.
 */
export function preserveMarker(current: unknown, next: unknown, sameUrl: boolean): unknown {
  const depth = stateDepth(current);
  if (depth === 0 || !sameUrl || stateDepth(next) > 0) return next;
  if (next !== null && next !== undefined && (typeof next !== "object" || Array.isArray(next))) return next;
  const marker = (current as MarkerState)[HISTORY_MARKER_KEY];
  return { ...(next ?? {}), ...markerState(marker, depth) };
}

export interface SyncPlan {
  /** 걷어 낼 칸 수(`history.go(-back)`). */
  back: number;
  /** 걷어 낸 뒤 얹을 칸. 걷어 낼 칸이 있으면 그 이동이 끝난 뒤에 얹는다. */
  push: OverlayMarker[];
}

/** 얹힌 칸(`pushed`)을 열려 있어야 할 덮개(`desired`)에 맞춘다. 앞에서부터 같은 칸은 그대로 둔다. */
export function planSync(pushed: readonly OverlayMarker[], desired: readonly OverlayMarker[]): SyncPlan {
  let common = 0;
  while (common < pushed.length && common < desired.length && pushed[common] === desired[common]) common += 1;
  return { back: pushed.length - common, push: desired.slice(common) };
}

export interface PopResult {
  /** 이동 뒤 기록에 남은 이 화면의 칸. */
  pushed: OverlayMarker[];
  /** 이번 이동으로 걷힌 칸, 위에서부터. 사용자가 뒤로가기를 했으면 이 덮개들을 닫는다. */
  closed: OverlayMarker[];
  /** 앞으로가기로 이미 걷어 낸 칸에 다시 올라왔으면 그만큼 되돌아갈 칸 수. */
  forward: number;
}

/** `popstate`로 도착한 기록 칸의 상태를 보고 얹힌 칸 목록을 고친다. */
export function applyPop(pushed: readonly OverlayMarker[], state: unknown): PopResult {
  const depth = stateDepth(state);
  if (depth > pushed.length) return { pushed: [...pushed], closed: [], forward: depth - pushed.length };
  return { pushed: pushed.slice(0, depth), closed: pushed.slice(depth).reverse(), forward: 0 };
}
