"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { SurfaceModel } from "@a2ui/web_core";
import { A2UI_ACTION_LANG, A2UI_LANG, extractFencedBlocks, type A2uiActionEnvelope } from "@/lib/a2ui/blocks";
import { A2uiSessionStore, type A2uiBlockView, type A2uiSendOutcome } from "@/lib/a2ui/session-store";
import { CodeBlock } from "../MermaidBlock";
import type * as RuntimeModule from "./runtime";

type Runtime = typeof RuntimeModule;

interface SessionValue { store: A2uiSessionStore; runtime: Runtime }

/** `undefined`: no card renderer here (e.g. the side chat); `null`: the renderer is still loading. */
const SessionContext = createContext<SessionValue | null | undefined>(undefined);
/** The assistant text part a markdown body renders, so its fences find their results. */
const PartContext = createContext<object | null>(null);

export function A2uiPartScope({ part, children }: { part: object; children: ReactNode }) {
  return <PartContext.Provider value={part}>{children}</PartContext.Provider>;
}

/**
 * One A2UI processor for one chat session view. It syncs with each committed
 * transcript in a layout effect (idempotent per `messages` array) and the
 * version bump re-renders the fences before paint. The renderer bundle loads
 * only once the transcript mentions a card.
 */
export function A2uiSessionProvider({ sessionKey, messages, onSend, children }: {
  sessionKey: string;
  messages: readonly { role: string; content?: unknown }[];
  onSend: (text: string) => Promise<A2uiSendOutcome>;
  children: ReactNode;
}) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // The renderer bundle loads only for a transcript that mentions a card (or an action) at all.
  const wanted = useMemo(
    () => runtime !== null || messages.some((message) => (message.role === "assistant" || message.role === "user") && JSON.stringify(message.content ?? "").includes(A2UI_LANG)),
    [runtime, messages],
  );
  useEffect(() => {
    if (!wanted || runtime || loadFailed) return;
    let live = true;
    // A renderer that cannot load leaves every card as its plain code block.
    import("./runtime").then((loaded) => { if (live) setRuntime(loaded); }, () => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [wanted, runtime, loadFailed]);

  const sendRef = useRef(onSend);
  useEffect(() => { sendRef.current = onSend; }, [onSend]);
  const store = useMemo(
    () => (runtime ? new A2uiSessionStore(runtime.createProcessor, (text) => sendRef.current(text)) : null),
    // A new session view starts from an empty processor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtime, sessionKey],
  );
  useEffect(() => () => store?.dispose(), [store]);
  // Sync only for a committed transcript, so an abandoned render cannot rebuild the processor;
  // the version bump re-renders the fences before paint.
  useLayoutEffect(() => {
    store?.sync(messages);
    store?.flush();
  }, [store, messages]);

  const value = useMemo(() => (store && runtime ? { store, runtime } : null), [store, runtime]);
  return <SessionContext.Provider value={loadFailed ? undefined : value}>{children}</SessionContext.Provider>;
}

const ERROR_TEXT: Record<NonNullable<A2uiBlockView["error"]>["reason"], string> = {
  json: "카드 내용을 읽지 못했어요. JSON이 끝까지 쓰이지 않았거나 형식이 틀렸어요.",
  shape: "카드 메시지 형식이 맞지 않아요.",
  empty: "카드 블록이 비어 있어요.",
  processor: "카드의 일부를 그리지 못했어요.",
};

const ACTION_TEXT = {
  sending: "보내는 중…",
  queued: "지금 답이 끝나면 전달돼요.",
  failed: "보내지 못했어요. 다시 눌러 주세요.",
} as const;

function Note({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return <p className="a2ui-answer-note" data-tone={tone}>{children}</p>;
}

function Surface({ surface, store, runtime }: { surface: SurfaceModel<never>; store: A2uiSessionStore; runtime: Runtime }) {
  const state = store.actionState(surface.id);
  const busy = state === "sending" || state === "queued";
  return (
    <div className="a2ui-answer-card" data-surface-id={surface.id} aria-busy={busy || undefined} inert={busy || undefined}>
      <runtime.SurfaceView surface={surface} />
      {state && <p className="a2ui-answer-status" role="status" data-state={state}>{ACTION_TEXT[state]}</p>}
    </div>
  );
}

/** True inside a chat pane that renders cards; elsewhere card messages stay plain text. */
export function useInA2uiSession(): boolean {
  return useContext(SessionContext) !== undefined;
}

/** The markdown text a MarkdownBody is rendering, so a fence can find its place among the part's fences. */
export const A2uiMarkdownSource = createContext("");

/** What MarkdownBody renders for an ```a2ui fence starting at `offset` in the rendered markdown. */
export function A2uiFence({ code, offset, isStreaming }: { code: string; offset?: number; isStreaming?: boolean }) {
  const session = useContext(SessionContext);
  const part = useContext(PartContext);
  const source = useContext(A2uiMarkdownSource);
  const store = session?.store;
  useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getVersion ?? zero, zero);

  if (session === undefined || (!part && !isStreaming)) return <CodeBlock code={code} lang={A2UI_LANG} isStreaming={isStreaming} />;
  if (isStreaming || !session) return <Note>카드를 그리는 중…</Note>;
  const ordinal = offset === undefined ? undefined : extractFencedBlocks(source.slice(0, offset), A2UI_LANG).length;
  const view = session.store.lookup(part!, ordinal, code);
  if (!view) return <CodeBlock code={code} lang={A2UI_LANG} />;

  const live = view.surfaces.filter((surface) => session.store.liveSurface(surface));
  const closed = view.surfaces.filter((surface) => !live.includes(surface)).map((surface) => surface.id);
  const updated = view.updated.filter((id) => !view.created.includes(id));
  const deleted = view.deleted;
  const errorLine = view.error && (
    <Note tone="error">{ERROR_TEXT[view.error.reason]}{view.error.detail ? ` (${view.error.detail})` : ""}</Note>
  );
  if (view.error && view.error.reason !== "processor") {
    return <div className="a2ui-answer-invalid"><CodeBlock code={code} lang={A2UI_LANG} />{errorLine}</div>;
  }
  const notes = [
    ...updated.map((id) => `‘${id}’ 카드를 고쳤어요.`),
    ...deleted.map((id) => `‘${id}’ 카드를 닫았어요.`),
    ...closed.filter((id) => !deleted.includes(id)).map((id) => `‘${id}’ 카드는 닫혔어요.`),
    ...view.missing.map((id) => `‘${id}’ 카드가 이 대화에 없어 변경을 건너뛰었어요.`),
  ];
  if (live.length === 0 && notes.length === 0) {
    return <div className="a2ui-answer-invalid"><CodeBlock code={code} lang={A2UI_LANG} />{errorLine}</div>;
  }
  return (
    <div className="a2ui-answer">
      {live.map((surface) => <Surface key={surface.id} surface={surface} store={session.store} runtime={session.runtime} />)}
      {notes.map((note) => <Note key={note}>{note}</Note>)}
      {view.error && <CodeBlock code={code} lang={A2UI_LANG} />}
      {errorLine}
    </div>
  );
}

/** A user message that is one card action: the action and card, with the JSON on demand. */
export function A2uiActionChip({ envelope, code }: { envelope: A2uiActionEnvelope; code: string }) {
  const context = Object.entries(envelope.action.context ?? {})
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
  return (
    <details className="a2ui-action-chip">
      <summary>
        <span className="a2ui-action-chip-name">카드 동작: {envelope.action.name}</span>
        <span className="a2ui-action-chip-meta">{[`카드 ${envelope.action.surfaceId}`, context].filter(Boolean).join(", ")}</span>
      </summary>
      <CodeBlock code={code} lang={A2UI_ACTION_LANG} />
    </details>
  );
}

const noopSubscribe = () => () => {};
const zero = () => 0;
