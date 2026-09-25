"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { Gpt6HandleSummary } from "@/lib/gpt6-bridge";

interface Props {
  /** 지금 입력창이 쓰는 세션. 없으면 배지도 없다. */
  sessionId?: string;
}

const HANDLES_POLL_MS = 5000;
/** 묶이지 않은 세션에서의 확인 주기. */
const UNBOUND_POLL_MS = 30000;

const badgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  flexShrink: 0,
  height: 32,
  padding: "0 10px",
  border: "1px solid var(--accent-line)",
  borderRadius: "var(--radius-control)",
  background: "var(--accent-soft)",
  color: "var(--accent-hover)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1.3,
  whiteSpace: "nowrap",
};

/**
 * 입력창 하단에 붙는 "6PRO H-####" 배지. 지금 열린 세션이 어느 연결번호에 묶였는지
 * 보여 주기 위해 직접 목록을 읽는다. 세션이 없거나
 * 묶인 연결번호가 없으면 아무것도 그리지 않아 레이아웃을 건드리지 않는다.
 */
export function Gpt6HandleBadge({ sessionId }: Props) {
  const { t } = useI18n();
  const [handle, setHandle] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setHandle(null);
      return;
    }
    let cancelled = false;
    let timer = 0;
    // 묶인 세션은 만료·폐기를 곧바로 반영해야 하지만, 묶이지 않은 세션에서 이 배지는
    // 늘 비어 있다. 입력창은 항상 떠 있으므로 그 경우의 주기를 늘려 빈 폴링을 줄인다.
    let bound = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/gpt6/handles", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { handles?: Gpt6HandleSummary[] };
        if (cancelled) return;
        const handles = Array.isArray(data.handles) ? data.handles : [];
        // 세션 하나에 active 연결번호는 최대 하나이므로 첫 일치가 지금 묶인 값이다.
        const found = handles.find((entry) => entry.sessionId === sessionId && entry.status === "active")?.handle ?? null;
        bound = found !== null;
        setHandle(found);
      } catch {
        // 목록을 못 읽으면 배지만 감춘다. 입력창 동작은 건드리지 않는다.
      }
    };
    const tick = async () => {
      await load();
      if (cancelled) return;
      timer = window.setTimeout(() => void tick(), bound ? HANDLES_POLL_MS : UNBOUND_POLL_MS);
    };
    // 세션이 바뀌면 다음 주기를 기다리지 않고 즉시 다시 판정한다.
    void tick();
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [sessionId]);

  if (!handle) return null;
  return <span style={badgeStyle} title={t("gpt6.boundBadgeHint", { handle })}>{t("gpt6.boundBadge", { handle })}</span>;
}
