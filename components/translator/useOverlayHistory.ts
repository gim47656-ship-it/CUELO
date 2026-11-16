"use client";

import { useEffect, useRef } from "react";
import { applyPop, markerState, planSync, preserveMarker, stateDepth, type OverlayMarker } from "./overlay-history";

/**
 * 통역 화면은 하나뿐이라 얹은 기록 칸을 모듈에 둔다. React 개발 모드가 마운트·정리·마운트를 곧바로
 * 되풀이해도 칸을 걷었다 다시 얹지 않고, 진짜로 사라질 때만 걷는다.
 */
const shared = {
  pushed: [] as OverlayMarker[],
  /** 이 화면이 스스로 부른 `history.go`가 아직 도착하지 않은 수. 그 `popstate`로는 덮개를 닫지 않는다. */
  ignore: 0,
  release: undefined as number | undefined,
  /** 화면이 사라져 칸을 걷는 중. 걷기가 끝날 때까지 `popstate` 듣기를 이어 간다. */
  releasing: false,
  listener: null as ((event: PopStateEvent) => void) | null,
  replaceGuard: false,
};

/**
 * 같은 주소에서 지금 칸의 상태를 갈아 끼우는 `replaceState`가 이 화면 표시를 지우지 않게 한 번만
 * 감싼다(`preserveMarker`). Next 라우터가 이미 감싼 함수를 다시 감싸므로 그쪽 처리는 그대로 거친다.
 * 지금 칸이 이 화면 것이 아닐 때는 아무것도 바꾸지 않는다.
 */
function installReplaceGuard() {
  if (shared.replaceGuard) return;
  shared.replaceGuard = true;
  const replace = window.history.replaceState;
  window.history.replaceState = function replaceState(data: unknown, unused: string, url?: string | URL | null) {
    const sameUrl = url === undefined || url === null || new URL(url, window.location.href).href === window.location.href;
    return replace.call(this, preserveMarker(window.history.state, data, sameUrl), unused, url);
  };
}

// 새로 고침한 페이지에서는 Next 라우터가 첫 그리기 때 지금 칸을 덮는다. 화면이 마운트되기 전이라도
// 지난번 칸 표시를 지키도록 모듈을 읽을 때 바로 감싼다.
if (typeof window !== "undefined") installReplaceGuard();

function sync(desired: readonly OverlayMarker[]) {
  if (shared.ignore > 0) return;
  const plan = planSync(shared.pushed, desired);
  if (plan.back > 0) {
    if (stateDepth(window.history.state) === shared.pushed.length) {
      // 한 번에 걷는다. 도착한 `popstate`에서 남은 칸을 마저 얹는다.
      shared.ignore += 1;
      window.history.go(-plan.back);
      return;
    }
    // 기록이 이 화면 모르게 움직였다. 걷을 수 없는 칸은 잊는다.
    shared.pushed = shared.pushed.slice(0, shared.pushed.length - plan.back);
  }
  for (const marker of plan.push) {
    shared.pushed = [...shared.pushed, marker];
    window.history.pushState({ ...(window.history.state ?? {}), ...markerState(marker, shared.pushed.length) }, "");
  }
}

/**
 * 화면이 사라진 뒤 이 화면 칸을 모두 걷는다. 아직 도착하지 않은 `history.go`가 있으면 그 `popstate`가
 * 다시 부른다. 몇 칸을 걷을지는 기억한 목록이 아니라 지금 칸의 깊이로 정해, 이미 걷힌 칸을 또 걷거나
 * 앱 밖으로 나가지 않는다. 걷는 이동도 도착할 때까지 세어 두어, 그 사이 다시 마운트한 화면이 같은
 * 칸을 한 번 더 걷지 않는다.
 */
function finishRelease() {
  window.clearTimeout(shared.release);
  shared.release = undefined;
  if (shared.ignore > 0) return;
  const depth = stateDepth(window.history.state);
  shared.pushed = [];
  if (depth > 0) {
    shared.ignore += 1;
    window.history.go(-depth);
    return;
  }
  if (shared.listener) window.removeEventListener("popstate", shared.listener);
  shared.listener = null;
  shared.releasing = false;
}

/**
 * `desired`(아래에서 위 차례로 열려 있어야 할 덮개)를 기록 칸과 맞춘다. 사용자가 뒤로가기를 하면
 * 걷힌 칸의 덮개마다 `onClose`를 부른다. 덮개를 단추로 닫거나 화면을 떠나면 그 칸을 스스로 걷는다.
 */
export function useOverlayHistory(desired: readonly OverlayMarker[], onClose: (marker: OverlayMarker) => void) {
  const desiredRef = useRef(desired);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    desiredRef.current = desired;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    installReplaceGuard();
    window.clearTimeout(shared.release);
    shared.release = undefined;
    shared.releasing = false;
    if (shared.listener) window.removeEventListener("popstate", shared.listener);
    const onPop = (event: PopStateEvent) => {
      const result = applyPop(shared.pushed, event.state);
      shared.pushed = result.pushed;
      if (shared.ignore > 0) shared.ignore -= 1;
      else if (!shared.releasing && result.forward > 0) {
        shared.ignore += 1;
        window.history.go(-result.forward);
        return;
      } else if (!shared.releasing) {
        // 덮개를 닫는 상태 변경이 다시 그리면 아래 효과가 나머지를 맞춘다.
        for (const marker of result.closed) onCloseRef.current(marker);
        return;
      }
      if (shared.releasing) finishRelease();
      else sync(desiredRef.current);
    };
    shared.listener = onPop;
    window.addEventListener("popstate", onPop);
    // 새로 고침하면 브라우저가 지난번 이 화면 칸에 그대로 서 있다. 그 칸들을 먼저 걷고 새로 얹는다.
    if (shared.pushed.length === 0 && shared.ignore === 0) {
      const leftover = stateDepth(window.history.state);
      if (leftover > 0) {
        shared.ignore += 1;
        window.history.go(-leftover);
      }
    }
    return () => {
      shared.releasing = true;
      shared.release = window.setTimeout(finishRelease, 0);
    };
  }, []);

  const key = desired.join(">");
  useEffect(() => {
    sync(desiredRef.current);
  }, [key]);
}
