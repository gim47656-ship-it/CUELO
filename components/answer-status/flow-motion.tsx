"use client";

import { useSyncExternalStore } from "react";
import { useAnswerStatusText } from "./i18n";

/**
 * 실행 중인 그래프의 움직임을 멈춘 사용자 선택(WCAG 2.2.2). 실행이 끝나 카드가 다시 그려져도 이어지도록 이 브라우저에 남긴다.
 * 요청 카드 그래프와 서브에이전트 카드 그래프가 같은 선택을 따른다.
 */
const MOTION_STORAGE_KEY = "omp-web:flow-motion";
const motionListeners = new Set<() => void>();
let motionPaused: boolean | null = null;

function readMotionPaused(): boolean {
  if (motionPaused === null) {
    try {
      motionPaused = window.localStorage.getItem(MOTION_STORAGE_KEY) === "paused";
    } catch {
      motionPaused = false;
    }
  }
  return motionPaused;
}

function subscribeMotion(listener: () => void): () => void {
  motionListeners.add(listener);
  return () => {
    motionListeners.delete(listener);
  };
}

function setMotionPaused(paused: boolean): void {
  motionPaused = paused;
  try {
    if (paused) window.localStorage.setItem(MOTION_STORAGE_KEY, "paused");
    else window.localStorage.removeItem(MOTION_STORAGE_KEY);
  } catch {
    // 저장하지 못해도 이 화면에서는 멈춘 채로 둔다.
  }
  for (const listener of motionListeners) listener();
}

export function useFlowMotionPaused(): boolean {
  return useSyncExternalStore(subscribeMotion, readMotionPaused, () => false);
}

/** 움직이는 그래프 옆의 움직임 멈춤 단추. 동작 줄이기 설정에서는 멈출 움직임이 없어 숨는다(CSS). */
export function FlowMotionToggle({ paused }: { paused: boolean }) {
  const { st } = useAnswerStatusText();
  return (
    <button type="button" className="flow-graph-motion" aria-pressed={paused} onClick={() => setMotionPaused(!paused)}>
      {st("graph.motion.pause")}
    </button>
  );
}
