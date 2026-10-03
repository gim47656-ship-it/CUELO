"use client";

import { useEffect, useState } from "react";
import { DELIVERY_VISIBLE_ROWS, visibleDeliveryRows, type DeliveryKind, type DeliveryRow, type DeliveryStage } from "@/lib/answer-status/delivery";
import { parseDocumentPrompt } from "@/lib/document-attachments";
import { useAnswerStatusText, type AnswerStatusMessageKey } from "./i18n";

const KIND_LABEL: Record<DeliveryKind, AnswerStatusMessageKey> = {
  steer: "delivery.kind.steer",
  followUp: "delivery.kind.followUp",
};

const STAGE_LABEL: Record<DeliveryStage, AnswerStatusMessageKey> = {
  sending: "delivery.stage.sending",
  accepted: "delivery.stage.accepted",
  delivered: "delivery.stage.delivered",
  unconfirmed: "delivery.stage.unconfirmed",
  failed: "delivery.stage.failed",
};

/**
 * 입력창 위 큐 패널의 행들. 종류(지금 지시·완료 후 요청)와 관측된 전달 단계를 글로 보여 준다.
 * 서버 큐에 있는 글만 거둘 수 있다. 기본으로 최근 행만 보이고, 이전 행은 펼쳐서 볼 수 있다.
 */
export function DeliveryRows({ rows, removeLabel, onRemove }: {
  rows: readonly DeliveryRow[];
  removeLabel: string;
  onRemove?: (kind: DeliveryKind, text: string) => void;
}) {
  const { st } = useAnswerStatusText();
  const [expanded, setExpanded] = useState(false);
  const { rows: shown, hidden } = visibleDeliveryRows(rows, expanded);
  const overflow = rows.length > DELIVERY_VISIBLE_ROWS;
  // 행이 다시 기본 개수 안으로 줄면 다음에 늘어날 때도 최근 행만 보이게 접어 둔다.
  useEffect(() => {
    if (!overflow) setExpanded(false);
  }, [overflow]);
  return (
    <>
      {overflow && (
        <button
          type="button"
          className="answer-delivery-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? st("delivery.showRecent", { count: DELIVERY_VISIBLE_ROWS })
            : st("delivery.showOlder", { count: hidden })}
        </button>
      )}
      <ul className="answer-delivery-list" aria-live="polite">
        {shown.map((row) => {
          const parsed = parseDocumentPrompt(row.text);
          const written = parsed
            ? [parsed.message, parsed.documents.map((document) => document.name).join(", ")].filter(Boolean).join(" · ")
            : row.text.trim();
          const displayText = [written, row.images > 0 ? st("delivery.images", { count: row.images }) : ""]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={row.key} className="answer-delivery-row" data-kind={row.kind} data-stage={row.stage}>
              <span className="answer-delivery-kind">{st(KIND_LABEL[row.kind])}</span>
              <span className="answer-delivery-text" title={displayText}>{displayText}</span>
              <span className="answer-delivery-stage">{st(STAGE_LABEL[row.stage])}</span>
              {row.removable && onRemove && (
                <button
                  type="button"
                  className="answer-delivery-remove"
                  title={removeLabel}
                  aria-label={`${removeLabel}: ${displayText}`}
                  onClick={() => onRemove(row.kind, row.text)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
