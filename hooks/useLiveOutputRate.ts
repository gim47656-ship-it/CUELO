"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { estimateUpdatedTokens, getTokenEstimateText, type TokenEstimateCacheEntry } from "@/lib/message-display";
import type { AssistantMessage } from "@/lib/types";

const TICK_MS = 1000;

/**
 * 지금 흐르는 답변의 출력 속도 추정(토큰/초). 받은 글을 토큰으로 어림해 요청 시작부터 지금까지의 시간으로
 * 나눈다 — 끝난 답변의 속도(`latestOutputTokensPerSecond`)와 같은 기준이라 생성이 끝날 때 숫자가 튀지 않는다.
 * 첫 글이 오기 전에도 흐르는 중이면 0이다(직전 답의 값을 남기지 않는다). provider가 요청 시작 시각을 주지 않으면
 * 이 답을 처음 본 시각을 쓴다. `answerKey`는 답마다 달라야 한다(끝난 assistant 답의 수) — 두 답 사이에 null이
 * 렌더되지 않아도 새 답의 시작 시각을 다시 잡기 위해서다. 흐르는 답이 없으면 `null`.
 */
export function useLiveOutputRate(message: AssistantMessage | null, answerKey: number): number | null {
  const cacheRef = useRef<Map<number, TokenEstimateCacheEntry>>(new Map());
  const tokens = useMemo(() => {
    if (!message) {
      cacheRef.current = new Map();
      return 0;
    }
    const next = new Map<number, TokenEstimateCacheEntry>();
    let total = 0;
    (message.content ?? []).forEach((block, index) => {
      const text = getTokenEstimateText(block);
      if (text === null) return;
      const blockTokens = estimateUpdatedTokens(cacheRef.current.get(index), text);
      next.set(index, { text, tokens: blockTokens });
      total += blockTokens;
    });
    cacheRef.current = next;
    return total;
  }, [message]);
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;

  const streaming = message !== null;
  const requestStart = message?.timestamp;
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    if (!streaming) {
      setRate(null);
      return;
    }
    const startedAt = requestStart ?? Date.now();
    const tick = () => {
      const elapsed = (Date.now() - startedAt) / 1000;
      setRate(elapsed >= 0.5 ? tokensRef.current / elapsed : 0);
    };
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [streaming, requestStart, answerKey]);
  return streaming ? (rate ?? 0) : null;
}
