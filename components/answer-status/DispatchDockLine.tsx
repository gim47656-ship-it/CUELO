"use client";

import type { DockSummary } from "@/lib/answer-status/dispatch";
import { useAnswerStatusText } from "./i18n";

/**
 * 입력창 위 dock의 서브에이전트 한 줄. 긴 작업에서 발주 카드가 위로 밀려도 실행 중·판정 대기
 * 수와 가장 최근 발주 제목이 보이고, 누르면 그 발주 카드로 가서 강조한다. 카드가 붙을 답변이
 * 아직 없으면 서브에이전트 상세 패널을 연다.
 */
export function DispatchDockLine({
  summary,
  onJump,
  onOpenPanel,
}: {
  summary: DockSummary | null;
  onJump: (position: number, dispatchKey: string) => void;
  onOpenPanel?: () => void;
}) {
  const { st } = useAnswerStatusText();
  if (!summary) return null;
  const { target } = summary;
  const position = target.position;
  if (position === null && !onOpenPanel) return null;
  const hint = st(position !== null ? "dock.jump" : "dock.openPanel", { title: target.maker.title });
  return (
    <button
      type="button"
      className="run-status-line answer-dock-line"
      data-tone="accent"
      title={hint}
      onClick={() => {
        if (position !== null) onJump(position, target.maker.member.key);
        else onOpenPanel?.();
      }}
    >
      <span className="run-status-label">{st("dock.label")}</span>
      <span className="answer-dock-counts">
        {summary.running > 0 && (
          <span className="answer-dock-count" data-phase="running">{st("dock.running", { count: summary.running })}</span>
        )}
        {summary.awaiting > 0 && (
          <span className="answer-dock-count" data-phase="awaiting">{st("dock.awaiting", { count: summary.awaiting })}</span>
        )}
      </span>
      <span className="answer-dock-title">{target.maker.title}</span>
      <svg className="answer-dock-go" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="18 15 12 9 6 15" />
      </svg>
    </button>
  );
}
