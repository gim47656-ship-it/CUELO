"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createHanseSideChatClient,
  SideChatRequestError,
  type HanseSideChatClient,
  type SideChatErrorKind,
  type SideChatFlightOutcome,
  type SideChatFlightRegistry,
  type SideChatHistoryStore,
  type SideChatSessionCensus,
  type SideChatTurn,
} from "@/lib/hanse-sidechat-client";

export interface SideChatPanelProps {
  /** Header label, supplied by the host surface so it matches the view switcher's locale. */
  title: string;
  sessionId: string | null;
  sessionPath: string | null;
  sessionName?: string;
  historyStore: SideChatHistoryStore;
  /** In-flight request ownership. AppShell keeps the stable instance so progress/abort survive panel unmounts. */
  flights: SideChatFlightRegistry;
  sessionCensus?: SideChatSessionCensus | null;
  client?: HanseSideChatClient;
  visible?: boolean;
  onClose?: () => void;
  onReturnFocus?: () => void;
}

type SideChatErrorEntry = {
  question: string;
  partialAnswer: string;
  kind: SideChatErrorKind | "unknown";
  message: string;
};

// ChatInput과 동일한 조합 종료 유예. Windows IME는 한글 확정 Enter를 조합
// 종료 직후 별도 keydown으로 흘려보내므로 그 Enter까지 전송으로 오인하지 않는다.
const COMPOSITION_END_ENTER_GRACE_MS = 100;

function panelButtonStyle(disabled = false): React.CSSProperties {
  return {
    minHeight: 30,
    padding: "4px 9px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg)",
    color: disabled ? "var(--text-dim)" : "var(--text-muted)",
    cursor: disabled ? "default" : "pointer",
    fontSize: "var(--seed-font-size-t2-static)",
    fontWeight: 650,
  };
}

function QuestionBlock({ children }: { children: string }) {
  return (
    <div className="side-chat-question" style={{ alignSelf: "flex-end", maxWidth: "92%", padding: "8px 10px", border: "1px solid var(--border)", color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "var(--seed-font-size-t3-static)", lineHeight: 1.55 }}>
      {children}
    </div>
  );
}

function AnswerBlock({ children, streaming = false }: { children: string; streaming?: boolean }) {
  return (
    <div className={`side-chat-answer${streaming ? " is-streaming" : ""}`} style={{ alignSelf: "flex-start", maxWidth: "100%", padding: "8px 10px", border: "1px solid var(--border)", color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "var(--seed-font-size-t3-static)", lineHeight: 1.58 }}>
      {children || (streaming ? "응답을 기다리는 중…" : "")}
      {streaming && <span aria-hidden="true" style={{ marginLeft: 2, color: "var(--accent)" }}>▍</span>}
    </div>
  );
}

export function SideChatPanel({
  title,
  sessionId,
  sessionPath,
  sessionName,
  historyStore,
  flights,
  sessionCensus,
  client,
  visible = true,
  onClose,
  onReturnFocus,
}: SideChatPanelProps) {
  const resolvedClient = useMemo(() => client ?? createHanseSideChatClient(), [client]);
  const normalizedSessionId = sessionId?.toLowerCase() ?? null;
  const [turns, setTurns] = useState<SideChatTurn[]>([]);
  // 초안도 세션별로 보관한다. 하나의 입력 상태를 공유하면 A에서 쓰던 질문이
  // 세션을 바꾼 뒤 B의 입력창에 남아 B로 잘못 전송된다.
  const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>({});
  const draftKey = normalizedSessionId ?? "";
  const input = draftsBySession[draftKey] ?? "";
  const writeDraft = (key: string, value: string) => {
    setDraftsBySession((current) => {
      if ((current[key] ?? "") === value) return current;
      const next = { ...current };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  };
  // 진행 중인 /btw 요청의 소유권은 패널이 아니라 flight 레지스트리에 둔다.
  // 덱은 닫힐 때·반응형 이동 때 탭을 언마운트하지만, AppShell 수준의 안정
  // 레지스트리는 AbortController와 스트림 누적을 유지하므로, 다시 열린
  // 패널이 진행 표시·중단·중복 전송 차단에 재부착된다.
  const flightStore = flights;
  const [flightTick, setFlightTick] = useState(0);
  const [errorsBySession, setErrorsBySession] = useState<Record<string, SideChatErrorEntry[]>>({});
  const [noticesBySession, setNoticesBySession] = useState<Record<string, string>>({});
  const [modelsBySession, setModelsBySession] = useState<Record<string, string>>({});
  const mountedRef = useRef(true);
  const currentSessionIdRef = useRef(normalizedSessionId);
  const visibleRef = useRef(visible);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  currentSessionIdRef.current = normalizedSessionId;
  visibleRef.current = visible;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 패널을 닫거나 교체해도 진행 중인 /btw 요청은 취소하지 않는다.
    };
  }, []);

  useEffect(() => {
    setTurns(normalizedSessionId ? historyStore.read(normalizedSessionId) : []);
  }, [historyStore, normalizedSessionId]);
  // 레지스트리의 flight에 재부착한다. 종료 결과(중단 notice·오류 entry·
  // 실패 질문 복원·완료 모델)는 시작한 인스턴스가 아니라 현재 마운트된
  // 패널이 outcome으로 받아 처리하므로, 닫힘·재부모화 뒤에도 유실되지
  // 않는다. 실패 질문은 이 세션의 초안이 비어 있을 때만 되돌려, 사용자가
  // 새로 입력한 초안을 덮어쓰지 않는다.
  useEffect(() => {
    if (!normalizedSessionId) return;
    const sid = normalizedSessionId;
    const applyOutcome = (outcome: SideChatFlightOutcome) => {
      if (outcome.kind === "aborted") {
        setNoticesBySession((current) => ({
          ...current,
          [sid]: outcome.saved
            ? "응답 생성을 중단했습니다. 받은 내용은 현재 세션 기록에 저장했습니다."
            : "응답 생성을 중단했습니다.",
        }));
      } else if (outcome.kind === "failed") {
        setErrorsBySession((current) => ({
          ...current,
          [sid]: [
            ...(current[sid] ?? []),
            { question: outcome.question, partialAnswer: outcome.partialAnswer, kind: outcome.errorKind, message: outcome.errorMessage },
          ],
        }));
        setDraftsBySession((current) => (
          (current[sid] ?? "").trim()
            ? current
            : { ...current, [sid]: outcome.question }
        ));
      } else if (outcome.model) {
        const finishedModel = outcome.model;
        setModelsBySession((current) => ({ ...current, [sid]: finishedModel }));
      }
      setTurns(historyStore.read(sid));
    };
    const syncFlight = () => {
      if (!mountedRef.current || currentSessionIdRef.current !== sid) return;
      const outcome = flightStore.takeOutcome(sid);
      if (outcome) applyOutcome(outcome);
      else if (flightStore.read(sid) === null) setTurns(historyStore.read(sid));
      setFlightTick((tick) => tick + 1);
    };
    const unsubscribe = flightStore.subscribe(sid, syncFlight);
    // 구독 등록 직후 현재 스냅샷을 동기화해, commit과 effect flush 사이
    // emit이나 닫혀 있는 동안의 종료를 놓치지 않는다.
    syncFlight();
    return unsubscribe;
  }, [flightStore, historyStore, normalizedSessionId]);

  useEffect(() => {
    if (sessionCensus) historyStore.cleanup(sessionCensus, normalizedSessionId);
  }, [historyStore, normalizedSessionId, sessionCensus]);

  useEffect(() => {
    if (!visible) return;
    inputRef.current?.focus();
  }, [visible, normalizedSessionId]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const log = logRef.current;
      if (log) log.scrollTop = log.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [flightTick, normalizedSessionId, turns.length, visible]);

  const ask = async (question: string) => {
    if (!normalizedSessionId || !sessionPath) {
      const key = normalizedSessionId ?? "";
      setNoticesBySession((current) => ({
        ...current,
        [key]: "세션 파일이 준비되지 않았습니다. 기록이 생성된 뒤 다시 시도하세요.",
      }));
      return;
    }

    // begin이 동기적으로 소유권을 등록하므로, 같은 세션의 중복 전송은
    // 여기서 null로 막히고 submit 쪽은 중단으로 바뀐다. 패널이 닫혔다
    // 다시 열려도 레지스트리의 flight가 살아 있어 재부착된다.
    const sessionId = normalizedSessionId;
    const begun = flightStore.begin(sessionId, question);
    if (!begun) return;
    const { signal } = begun.controller;
    setNoticesBySession((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });

    try {
      const result = await resolvedClient.ask({
        sessionPath,
        question,
        history: historyStore.history(sessionId),
        signal,
        onEvent: (event) => flightStore.ingest(sessionId, event),
      });
      // 저장소 기록은 마운트 여부와 무관하게 남기고, UI 부수효과(notice·
      // 오류·초안·모델)는 outcome으로 넘겨 현재 마운트된 패널이 처리한다.
      // 시작한 인스턴스의 mountedRef에 종료 결과를 가두지 않는다.
      historyStore.append(sessionId, {
        q: question,
        a: result.text,
        at: Date.now(),
      });
      flightStore.finish(sessionId, { kind: "done", model: result.model });
    } catch (error) {
      const partial = flightStore.read(sessionId)?.text ?? "";
      if (signal.aborted) {
        let saved = false;
        if (partial) {
          historyStore.append(sessionId, {
            q: question,
            a: partial,
            at: Date.now(),
          });
          saved = true;
        }
        flightStore.finish(sessionId, { kind: "aborted", saved });
      } else {
        const typed = error instanceof SideChatRequestError ? error.kind : "unknown";
        const message = error instanceof Error ? error.message : String(error);
        flightStore.finish(sessionId, {
          kind: "failed",
          question,
          partialAnswer: partial,
          errorKind: typed,
          errorMessage: message,
        });
      }
    } finally {
      if (mountedRef.current && visibleRef.current) inputRef.current?.focus();
    }
  };

  const submitOrAbort = () => {
    // 레지스트리가 소유권을 쥐고 있어, 닫혔다 다시 열린 패널에서도 같은
    // 세션의 진행 중 요청을 중단할 수 있고 중복 전송은 시작되지 않는다.
    if (normalizedSessionId && flightStore.read(normalizedSessionId) !== null) {
      flightStore.abort(normalizedSessionId);
      return;
    }
    const question = input.trim();
    if (!question) return;
    writeDraft(draftKey, "");
    void ask(question);
  };

  const clearCurrentSession = () => {
    if (!normalizedSessionId) return;
    if (flightStore.read(normalizedSessionId) !== null) return;
    historyStore.clear(normalizedSessionId);
    setTurns([]);
    setErrorsBySession((current) => {
      const next = { ...current };
      delete next[normalizedSessionId];
      return next;
    });
    setNoticesBySession((current) => ({
      ...current,
      [normalizedSessionId]: "현재 세션의 사이드채팅 기록을 비웠습니다.",
    }));
  };

  const closePanel = () => {
    onClose?.();
    onReturnFocus?.();
  };

  const sessionErrors = errorsBySession[normalizedSessionId ?? ""] ?? [];
  const notice = noticesBySession[normalizedSessionId ?? ""];
  const visibleRequest = normalizedSessionId ? flightStore.read(normalizedSessionId) : null;
  const hasConversation = turns.length > 0 || sessionErrors.length > 0 || visibleRequest !== null;
  const model = visibleRequest?.model ?? modelsBySession[normalizedSessionId ?? ""];
  const unavailable = !normalizedSessionId || !sessionPath;
  const streaming = visibleRequest !== null;
  const canSend = !streaming && !unavailable && input.trim().length > 0;
  const clearDisabled = !normalizedSessionId || streaming;

  return (
    <section
      className="side-chat-panel"
      aria-label="사이드채팅"
      aria-busy={visibleRequest !== null}
      data-state={!normalizedSessionId || !sessionPath ? "unavailable" : visibleRequest ? "streaming" : "ready"}
      style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden", background: "var(--bg-panel)", color: "var(--text)" }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 42, padding: "6px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: "var(--seed-font-size-t3-static)", fontWeight: 600 }}>{title}</div>
          <div title={sessionPath ?? undefined} style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--seed-font-size-t2-static)" }}>
            {sessionName || normalizedSessionId?.slice(0, 8) || "세션 없음"}{model ? ` · ${model}` : ""}
          </div>
        </div>
        <button type="button" onClick={clearCurrentSession} disabled={clearDisabled} style={panelButtonStyle(clearDisabled)}>
          Clear
        </button>
        {onClose && (
          <button type="button" onClick={closePanel} aria-label="사이드채팅 닫기" title="닫기" style={{ ...panelButtonStyle(), width: 32, padding: 0 }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
          </button>
        )}
      </header>

      <div ref={logRef} aria-live="polite" style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column", gap: 7, overflowY: "auto", padding: "11px 12px 18px" }}>
        {!normalizedSessionId || !sessionPath ? (
          <div role="status" style={{ margin: "auto 0", padding: 16, color: "var(--text-muted)", textAlign: "center", fontSize: 11, lineHeight: 1.6 }}>
            세션 기록을 준비하는 중입니다.<br />세션 파일이 생성되면 사이드채팅을 사용할 수 있습니다.
          </div>
        ) : (
          <>
            {turns.map((turn, index) => (
              <div key={`${turn.at}:${index}`} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 5 }}>
                <QuestionBlock>{turn.q}</QuestionBlock>
                <AnswerBlock>{turn.a}</AnswerBlock>
              </div>
            ))}
            {sessionErrors.map((entry, index) => (
              <div key={`${entry.question}:${index}`} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 5 }}>
                <QuestionBlock>{entry.question}</QuestionBlock>
                {entry.partialAnswer && <AnswerBlock>{entry.partialAnswer}</AnswerBlock>}
                <div role="alert" data-error-kind={entry.kind} style={{ padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--danger)", fontSize: 10.5, lineHeight: 1.5, overflowWrap: "anywhere" }}>
                  {entry.message}
                </div>
              </div>
            ))}
            {visibleRequest && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 5 }}>
                <QuestionBlock>{visibleRequest.question}</QuestionBlock>
                <AnswerBlock streaming>{visibleRequest.text}</AnswerBlock>
              </div>
            )}
            {!hasConversation && (
              <div style={{ margin: "auto 0", padding: 16, color: "var(--text-muted)", textAlign: "center", fontSize: 11, lineHeight: 1.65 }}>
                현재 세션의 전체 맥락을 보고 답합니다.<br />사이드채팅 기록은 부모 세션별로 보관됩니다.
              </div>
            )}
          </>
        )}
        {notice && <div role="status" style={{ padding: "7px 9px", color: "var(--text-muted)", fontSize: 10.5, lineHeight: 1.5 }}>{notice}</div>}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitOrAbort();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 6, padding: "9px 10px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}
      >
        <label htmlFor="side-chat-question" style={{ color: "var(--text-muted)", fontSize: "var(--seed-font-size-t2-static)", fontWeight: 600 }}>
          사이드채팅 질문
        </label>
        <textarea
          ref={inputRef}
          id="side-chat-question"
          rows={4}
          value={input}
          onChange={(event) => writeDraft(draftKey, event.target.value)}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
            lastCompositionEndAtRef.current = Date.now();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            const nativeEvent = event.nativeEvent;
            const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
            const composing =
              isComposingRef.current ||
              nativeEvent.isComposing ||
              nativeEvent.keyCode === 229;
            if (composing || recentlyComposed) {
              // 조합 확정 Enter는 줄바꿈도 전송도 아니다.
              if (recentlyComposed) event.preventDefault();
              return;
            }
            if (streaming) return;
            event.preventDefault();
            submitOrAbort();
          }}
          disabled={streaming || unavailable}
          placeholder="질문 입력 — Enter 전송, Shift+Enter 줄바꿈"
          style={{ width: "100%", minWidth: 0, minHeight: 88, maxHeight: 240, boxSizing: "border-box", resize: "vertical", padding: "8px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", outline: "none", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--seed-font-family)", fontSize: "var(--seed-font-size-t3-static)", lineHeight: 1.5 }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span aria-live="polite" style={{ flex: 1, minWidth: 0, color: "var(--text-muted)", fontSize: "var(--seed-font-size-t2-static)", lineHeight: 1.4, overflowWrap: "anywhere" }}>
            {unavailable
              ? "세션 파일이 준비되면 질문할 수 있습니다."
              : streaming
                ? "응답을 받는 중입니다."
                : "Enter 전송 · Shift+Enter 줄바꿈"}
          </span>
          <button type="submit" disabled={!streaming && !canSend} style={panelButtonStyle(!streaming && !canSend)}>
            {streaming ? "중단" : "전송"}
          </button>
        </div>
      </form>
    </section>
  );
}
