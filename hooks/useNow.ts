"use client";

import { useEffect, useState } from "react";

/**
 * 렌더에서 쓸 현재 시각. 렌더 중에 `Date.now()`를 부르면 같은 입력에 다른 결과가 나오므로,
 * 시각은 상태로 두고 `intervalMs`마다 다시 읽는다.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
