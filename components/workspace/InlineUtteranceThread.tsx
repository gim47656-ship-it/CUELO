"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { InlineUtterance } from "@/lib/inline-utterance";
import { useAccountFace } from "@/hooks/useAccountFaces";
import { providerDisplayName } from "@/lib/hanse-resource-client";
import { MarkdownBody } from "@/components/MarkdownBody";
import { inlineStickerFor } from "@/lib/inline-sticker";
import { AccountAvatar } from "./AccountAvatar";

/** 접지 않고 보여 주는 줄 수. 이보다 길면 접고 「더보기」를 붙인다. */
const COLLAPSE_LINES = 12;
/** 본문 글자 크기와 줄 높이. 접힌 높이는 이 둘에서 바로 나온다. */
const BODY_FONT_SIZE = 12.5;
const BODY_LINE_HEIGHT = 1.6;
const COLLAPSED_MAX_HEIGHT = COLLAPSE_LINES * BODY_FONT_SIZE * BODY_LINE_HEIGHT;

const EMPTY_UTTERANCES: ReadonlyMap<number, readonly InlineUtterance[]> = new Map();
const InlineUtterancesContext = createContext<ReadonlyMap<number, readonly InlineUtterance[]>>(EMPTY_UTTERANCES);

/**
 * 발화 지도를 대화 기록에 흘려 넣는다.
 *
 * 대화 기록은 memo 경계 안에 있어서 자식이 한 마디 할 때마다 다시 그려지면 안 된다.
 * 발화는 prop 이 아니라 문맥으로 내려가므로, 다시 그려지는 것은 이 값을 실제로 읽는
 * 스레드뿐이다. 값은 이미 만들어진 지도 하나이고, 렌더마다 새로 만들지 않는다.
 */
export function InlineUtterancesProvider({
  utterances,
  children,
}: {
  utterances: ReadonlyMap<number, readonly InlineUtterance[]>;
  children: ReactNode;
}) {
  return <InlineUtterancesContext.Provider value={utterances}>{children}</InlineUtterancesContext.Provider>;
}

/**
 * 한 턴 뒤에 붙는 발화 묶음.
 *
 * 자식이 없던 턴에서는 아무것도 그리지 않는다 — 어느 턴에 발화가 있는지는 이 컴포넌트만
 * 알고, 그 밖의 대화 항목은 다시 그리지 않는다. 화자마다 한 단계씩 들어가지 않는다:
 * 모두 같은 층에 서고, 누구인지는 머리의 얼굴과 이름이 말한다.
 */
export function InlineTurnThreads({
  turnIndex,
  turnEntryId,
  sessionId,
  cwd,
  onOpenFile,
}: {
  turnIndex: number;
  /** 이 턴을 가리키는 항목 id. 화면에 붙는 표시는 없고 자리를 가리키는 이름으로만 남는다. */
  turnEntryId?: string;
  sessionId?: string;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}) {
  const utterances = useContext(InlineUtterancesContext).get(turnIndex);
  if (!utterances || utterances.length === 0) return null;
  // `display: contents` 라 감싼 자리는 레이아웃에 없고, 발화들은 대화 기록의 같은 층에 선다.
  return (
    <div
      className="inline-utterance-thread"
      data-turn={turnIndex}
      data-turn-entry={turnEntryId}
      style={{ display: "contents" }}
    >
      {utterances.map((utterance) => (
        <InlineUtteranceBlock
          key={utterance.key}
          utterance={utterance}
          sessionId={sessionId}
          cwd={cwd}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

/**
 * 발화 하나. 얼굴은 `provider` 와 `credentialId` 로만 고른다 — `label` 은 화면에 붙는
 * 표시 텍스트일 뿐 얼굴 해소에는 관여하지 않는다.
 */
function InlineUtteranceBlock({
  utterance,
  sessionId,
  cwd,
  onOpenFile,
}: {
  utterance: InlineUtterance;
  sessionId?: string;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}) {
  const accountSessionId = utterance.accountSessionId === null ? undefined : utterance.accountSessionId ?? sessionId;
  const accountFace = useAccountFace(accountSessionId, utterance.provider, utterance.credentialId);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 접힌 상태에서만 잰다. 펼친 뒤에는 넘침이 사라져 다시 접을 근거가 없어지므로,
  // 넘쳤다는 사실은 그대로 두고 「접기」만 남긴다.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || expanded) return;
    setClipped(body.scrollHeight > body.clientHeight + 1);
  }, [utterance.text, expanded]);

  const hasText = utterance.text.trim().length > 0;
  const name = utterance.label?.trim();
  const speaker = accountFace?.alias ?? name ?? providerDisplayName(utterance.provider);
  const romanAlias = accountFace?.alias.split("(", 1)[0]?.trim();
  const taskLabel = accountFace && name && name !== accountFace.alias && name !== romanAlias
    ? `작업 · ${name}`
    : null;
  const sticker = inlineStickerFor(accountFace?.alias, utterance.status, utterance.key);
  const statusLabel = utterance.status === "failed"
    ? "중단됨"
    : utterance.status === "streaming" && hasText ? "작업 중" : null;

  return (
    <div className="inline-utterance" data-status={utterance.status} style={{ marginBottom: 16 }}>
      <div
        className="inline-utterance-role"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          marginBottom: 2,
          fontSize: 11,
          color: "var(--text-dim)",
          ...(accountFace ? { minHeight: 40 } : null),
        }}
      >
        {accountFace && <AccountAvatar seed={accountFace.seed} size={40} provider={utterance.provider} />}
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{speaker}</span>
            {statusLabel && (
              <span style={{ color: utterance.status === "failed" ? "var(--danger)" : "var(--text-dim)" }}>
                {statusLabel}
              </span>
            )}
          </div>
          {taskLabel && (
            <div
              style={{
                marginTop: 1,
                fontSize: 11,
                lineHeight: 1.35,
                color: "var(--text-muted)",
                overflowWrap: "anywhere",
              }}
            >
              {taskLabel}
            </div>
          )}
        </div>
      </div>

      {hasText ? (
        <div
          ref={bodyRef}
          style={{
            fontSize: BODY_FONT_SIZE,
            lineHeight: BODY_LINE_HEIGHT,
            ...(expanded ? null : { maxHeight: COLLAPSED_MAX_HEIGHT, overflow: "hidden" }),
          }}
        >
          <MarkdownBody isStreaming={utterance.status === "streaming"} cwd={cwd} onOpenFile={onOpenFile}>
            {utterance.text}
          </MarkdownBody>
        </div>
      ) : (
        <div role="status" style={{ color: "var(--text-muted)", fontSize: 11.5, lineHeight: 1.6 }}>
          {utterance.status === "failed" ? "발화 없이 중단되었습니다" : "아직 발화가 없습니다"}
        </div>
      )}

      {hasText && (clipped || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          style={{
            marginTop: 4,
            padding: "3px 9px",
            height: 22,
            border: "1px solid var(--border)",
            borderRadius: 5,
            background: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {expanded ? "접기" : "더보기"}
        </button>
      )}
      {sticker && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="inline-utterance-sticker"
            src={sticker.src}
            alt={sticker.alt}
            style={{ display: "block", width: "min(148px, 34vw)", maxWidth: "100%", height: "auto" }}
          />
          <style jsx global>{`
            .inline-utterance-sticker {
              transform-origin: center 75%;
              animation: inline-utterance-sticker-pop 200ms cubic-bezier(0, 0, 0.15, 1) both;
            }
            @keyframes inline-utterance-sticker-pop {
              from { opacity: 0; transform: scale(.88); }
              to { opacity: 1; transform: scale(1); }
            }
            @media (prefers-reduced-motion: reduce) {
              .inline-utterance-sticker { animation: none; }
            }
          `}</style>
        </>
      )}
    </div>
  );
}
