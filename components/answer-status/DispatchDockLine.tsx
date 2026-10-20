"use client";

import { useEffect, useId, useState } from "react";
import type { DockMaker, DockSummary } from "@/lib/answer-status/dispatch";
import { useAnswerStatusText } from "./i18n";

/**
 * 입력창 위 dock의 서브에이전트 한 줄. 긴 작업에서 발주 카드가 위로 밀려도 실행 중·판정 대기
 * 수와 가장 최근 발주 제목이 보이고, 누르면 그 발주 카드로 가서 강조한다. 카드가 붙을 답변이
 * 아직 없으면 서브에이전트 상세 패널을 연다. 둘 이상이면 제목 뒤에 「외 N」이 붙고, 옆 버튼으로
 * 펼치면 줄 위에 전체 발주가 최신 순으로 열려 각각 그 카드로 갈 수 있다.
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
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const count = summary?.makers.length ?? 0;
  useEffect(() => {
    if (count < 2) setExpanded(false);
  }, [count]);
  if (!summary) return null;
  const { target } = summary;
  if (target.position === null && !onOpenPanel) return null;

  const go = (entry: DockMaker) => {
    if (entry.position !== null) onJump(entry.position, entry.maker.member.key);
    else onOpenPanel?.();
  };
  const hintFor = (entry: DockMaker) =>
    st(entry.position !== null ? "dock.jump" : "dock.openPanel", { title: entry.maker.title });
  const others = count - 1;
  const listed = expanded ? [...summary.makers].reverse() : [];

  return (
    <div className="answer-dock">
      {listed.length > 0 && (
        <ul className="answer-dock-list" id={listId} aria-label={st("dock.list")}>
          {listed.map((entry) => (
            <li key={entry.maker.member.key}>
              <button
                type="button"
                className="answer-dock-item"
                title={hintFor(entry)}
                disabled={entry.position === null && !onOpenPanel}
                onClick={() => {
                  setExpanded(false);
                  go(entry);
                }}
              >
                <span className="answer-dock-count" data-phase={entry.phase}>
                  {st(entry.phase === "running" ? "dock.phase.running" : "dock.phase.awaiting")}
                </span>
                <span className="answer-dock-title">{entry.maker.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="answer-dock-row">
        <button
          type="button"
          className="run-status-line answer-dock-line"
          data-tone="accent"
          title={hintFor(target)}
          onClick={() => go(target)}
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
          {others > 0 && <span className="answer-dock-others">{st("dock.others", { count: others })}</span>}
          <svg className="answer-dock-go" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
        {others > 0 && (
          <button
            type="button"
            className="answer-dock-toggle"
            data-open={expanded}
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            aria-label={st(expanded ? "dock.collapse" : "dock.expand")}
            title={st(expanded ? "dock.collapse" : "dock.expand")}
            onClick={() => setExpanded((open) => !open)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="9" y1="6" x2="20" y2="6" />
              <line x1="9" y1="12" x2="20" y2="12" />
              <line x1="9" y1="18" x2="20" y2="18" />
              <circle cx="4.5" cy="6" r="1" />
              <circle cx="4.5" cy="12" r="1" />
              <circle cx="4.5" cy="18" r="1" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
