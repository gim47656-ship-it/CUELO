"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  STALL_MAX_EVENTS,
  STALL_MIN_MS,
  nextPostDelay,
  type FaceTrigger,
  type StallEvent,
  type StallPhase,
} from "./stall-report";

/**
 * 한 페이지 동안 보낸 횟수, 마지막으로 보낸 때, 아직 못 보낸 사건. 화면이 사라져도 모은 사건은
 * 다음 보낼 때 나가도록 모듈에 두고, 보내기 타이머도 화면과 함께 지우지 않는다.
 */
const posting = {
  posts: 0,
  lastPostAt: null as number | null,
  queue: [] as StallEvent[],
  timer: undefined as number | undefined,
};

function flush() {
  posting.timer = undefined;
  const delay = nextPostDelay(posting.lastPostAt, posting.posts, Date.now());
  if (delay === null) {
    posting.queue = [];
    return;
  }
  if (delay > 0) {
    posting.timer = window.setTimeout(flush, delay);
    return;
  }
  const events = posting.queue.splice(0, STALL_MAX_EVENTS);
  if (events.length === 0) return;
  posting.posts += 1;
  posting.lastPostAt = Date.now();
  void fetch("/api/live/stall", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
    keepalive: true,
  }).catch(() => {
    // Diagnostics only: a lost report must never disturb interpreting.
  });
  if (posting.queue.length > 0) posting.timer = window.setTimeout(flush, 0);
}

function record(event: StallEvent) {
  posting.queue.push(event);
  if (posting.queue.length > STALL_MAX_EVENTS) posting.queue.splice(0, posting.queue.length - STALL_MAX_EVENTS);
  if (posting.timer === undefined) posting.timer = window.setTimeout(flush, 0);
}

interface StallContext {
  visible: boolean;
  phase: StallPhase;
  face: boolean;
  segmentCount: number;
}

/**
 * 통역 화면이 보이는 동안 0.5초 넘게 멈춘 긴 작업(`longtask`)과 마주보기를 켜고 끈 일을 모아
 * `/api/live/stall`로 보낸다. 숫자와 정해진 낱말만 보내고 대화 글은 보내지 않는다. 긴 작업을 잴 수
 * 없는 브라우저에서는 멈춤 기록만 조용히 건너뛴다.
 */
export function useStallLog({ visible, phase, face, segmentCount }: StallContext) {
  const contextRef = useRef({ phase, face, segmentCount });
  useEffect(() => {
    contextRef.current = { phase, face, segmentCount };
  });

  useEffect(() => {
    if (!visible || typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < STALL_MIN_MS) continue;
        record({ kind: "stall", durationMs: Math.round(entry.duration), ...contextRef.current });
      }
    });
    observer.observe({ type: "longtask" });
    return () => observer.disconnect();
  }, [visible]);

  /** 마주보기를 켜고 끈 일. `on`은 바뀐 뒤 상태다. */
  const recordFace = useCallback((on: boolean, trigger: FaceTrigger) => {
    record({ kind: on ? "face-on" : "face-off", trigger, ...contextRef.current, face: on });
  }, []);

  return { recordFace };
}
