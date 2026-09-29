"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  LOUNGE_ROOM_ID,
  type LoungeAction,
  type LoungeDeltaEvent,
  type LoungeMessage,
  type LoungeMessageEvent,
  type LoungePostResponse,
  type LoungeRoomSettings,
  type LoungeSnapshot,
  type LoungeStateEvent,
} from "@/lib/lounge/types";

/**
 * 단톡방 하나의 화면 상태. 서버가 정본이다 — 조회(GET)와 구독(SSE)은 호출을 시작하지 않고,
 * 사용자의 명시 조작만 POST로 보낸다. 받은 상태를 낙관적으로 바꾸지 않고, 서버가 준
 * snapshot/state/message만 반영한다.
 *
 * 순서 경합은 서버의 단조 증가 `revision`으로 가른다: 지금 반영한 값보다 오래된 snapshot·state·
 * message는 버린다(POST 응답이 이미 도착한 더 새 SSE 상태를 되돌리지 않는다). 말하는 중인
 * 누적 본문(delta)은 확정 메시지(message)가 올 때까지 지우지 않고, 중단·OFF로 run generation이
 * 오르면 그 이전 generation의 본문만 버린다.
 *
 * 앱에서 한 번만 부르고(AppShell), 멤버 패널과 대화 화면에 같은 컨트롤러를 넘긴다 — 두 곳이
 * 따로 부르면 SSE 연결이 둘이 된다.
 */

export interface LoungeStreamingText {
  messageId: string;
  memberId: string;
  text: string;
  generation: number;
}

export type LoungeConnection = "connecting" | "live" | "reconnecting";

export interface LoungeViewState {
  snapshot: LoungeSnapshot | null;
  /** 지금까지 반영한 가장 큰 서버 revision. */
  revision: number;
  /** messageId → 말하는 중인 누적 본문. 바꿀 때마다 새 Map으로 교체한다. */
  streaming: ReadonlyMap<string, LoungeStreamingText>;
}

export type LoungeEvent =
  | { type: "snapshot"; source: "sse" | "post" | "get"; data: LoungeSnapshot }
  | { type: "state"; data: LoungeStateEvent }
  | { type: "message"; data: LoungeMessageEvent }
  | { type: "delta"; data: LoungeDeltaEvent };

export const INITIAL_LOUNGE_STATE: LoungeViewState = { snapshot: null, revision: 0, streaming: new Map() };

/** 확정됐거나 이미 중단된 generation의 본문을 뺀다. 뺄 것이 없으면 같은 Map을 돌려준다. */
function pruneStreaming(
  streaming: ReadonlyMap<string, LoungeStreamingText>,
  generation: number,
  persisted: readonly LoungeMessage[],
): ReadonlyMap<string, LoungeStreamingText> {
  if (streaming.size === 0) return streaming;
  const persistedIds = new Set(persisted.map((message) => message.id));
  const next = new Map(streaming);
  for (const [id, entry] of streaming) {
    if (entry.generation < generation || persistedIds.has(id)) next.delete(id);
  }
  return next.size === streaming.size ? streaming : next;
}

function upsertMessage(messages: readonly LoungeMessage[], message: LoungeMessage): LoungeMessage[] {
  const index = messages.findIndex((existing) => existing.id === message.id);
  if (index >= 0) {
    const next = messages.slice();
    next[index] = message;
    return next;
  }
  const next = [...messages, message];
  // 서버는 시간순으로 보낸다. 같은 시각이 뒤섞여 온 드문 경우만 제자리로 옮긴다.
  if (messages.length > 0 && messages[messages.length - 1].createdAt > message.createdAt) {
    next.sort((a, b) => a.createdAt - b.createdAt);
  }
  return next;
}

export function loungeReducer(state: LoungeViewState, event: LoungeEvent): LoungeViewState {
  switch (event.type) {
    case "snapshot": {
      const data = event.data;
      if (data.revision < state.revision) return state;
      // SSE snapshot은 연결·재연결 복원이다. 서버가 진행 중 본문을 곧바로 다시 보내므로 버퍼를
      // 비우고 새로 받는다. POST/GET 응답은 진행 중 본문을 모르니 확정·중단된 것만 뺀다.
      const streaming = event.source === "sse"
        ? new Map<string, LoungeStreamingText>()
        : pruneStreaming(state.streaming, data.run.generation, data.messages);
      return { snapshot: data, revision: data.revision, streaming };
    }
    case "state": {
      const data = event.data;
      if (!state.snapshot || data.revision < state.revision) return state;
      const snapshot: LoungeSnapshot = {
        ...state.snapshot,
        revision: data.revision,
        room: data.room,
        members: data.members,
        run: data.run,
        loadError: data.loadError,
      };
      return {
        snapshot,
        revision: data.revision,
        streaming: pruneStreaming(state.streaming, data.run.generation, snapshot.messages),
      };
    }
    case "message": {
      const data = event.data;
      if (!state.snapshot || data.revision < state.revision) return state;
      const messages = upsertMessage(state.snapshot.messages, data.message);
      let streaming = state.streaming;
      if (streaming.has(data.message.id)) {
        const next = new Map(streaming);
        next.delete(data.message.id);
        streaming = next;
      }
      return { snapshot: { ...state.snapshot, revision: data.revision, messages }, revision: data.revision, streaming };
    }
    case "delta": {
      const data = event.data;
      if (!state.snapshot) return state;
      if (data.generation < state.snapshot.run.generation) return state;
      if (state.snapshot.messages.some((message) => message.id === data.messageId)) return state;
      const current = state.streaming.get(data.messageId);
      if (current && current.text === data.text && current.generation === data.generation) return state;
      const streaming = new Map(state.streaming);
      streaming.set(data.messageId, {
        messageId: data.messageId,
        memberId: data.memberId,
        text: data.text,
        generation: data.generation,
      });
      return { ...state, streaming };
    }
  }
}

/** 방 설정 변경. `accountBindings`는 멤버 id → 단톡방 전용 계정(credentialId) 고정이다. */
export type LoungeSettingsUpdate = Partial<LoungeRoomSettings> & { accountBindings?: Record<string, number> };

type LoungeActionBody =
  | ({ action: "settings" } & LoungeSettingsUpdate)
  | { action: "send"; text: string; replyToId?: string }
  | { action: "stop" }
  | { action: "reaction"; messageId: string; emoji: string };

export type LoungePendingAction = LoungeActionBody["action"];

export interface LoungeController {
  snapshot: LoungeSnapshot | null;
  streaming: LoungeStreamingText[];
  connection: LoungeConnection;
  /** 첫 조회가 실패한 사유. snapshot을 한 번이라도 받았으면 null. */
  loadError: string | null;
  /** 마지막 조작이 실패한 사유. 다음 조작이 성공하면 지워진다. */
  actionError: string | null;
  pending: ReadonlySet<LoungePendingAction>;
  updateSettings: (settings: LoungeSettingsUpdate) => Promise<boolean>;
  send: (text: string, replyToId?: string) => Promise<boolean>;
  stop: () => Promise<boolean>;
  react: (messageId: string, emoji: string) => Promise<boolean>;
  dismissActionError: () => void;
}

const EVENTS_URL = "/api/lounge/events";
const API_URL = "/api/lounge";
/** 브라우저가 스스로 재연결을 포기(CLOSED)했을 때 다시 열기까지의 간격. */
const REOPEN_DELAY_MS = 3_000;

function requestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function parseEvent<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(event.data as string) as T;
  } catch {
    return null;
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    // 본문이 JSON이 아니면 상태 코드로 말한다.
  }
  return `HTTP ${response.status}`;
}

/**
 * @param enabled 연결을 열지. 부모는 단톡방을 처음 열 때 켜고 그 뒤로는 켠 채 둔다 — 작업
 *   화면으로 돌아가도 말하던 본문과 상태가 끊기지 않는다.
 */
export function useLounge(enabled = true): LoungeController {
  const [state, dispatch] = useReducer(loungeReducer, INITIAL_LOUNGE_STATE);
  const [connection, setConnection] = useState<LoungeConnection>("connecting");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<LoungePendingAction>>(() => new Set());
  const hasSnapshot = useRef(false);
  hasSnapshot.current = state.snapshot !== null;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let source: EventSource | null = null;
    let reopenTimer: number | undefined;
    const controller = new AbortController();

    // 첫 화면을 SSE 연결보다 먼저 채우고, 연결 자체가 막혀도 무엇이 실패했는지 말하기 위한 조회.
    void fetch(API_URL, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorText(response));
        const data = await response.json() as LoungeSnapshot;
        if (!disposed) {
          dispatch({ type: "snapshot", source: "get", data });
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted) return;
        if (!hasSnapshot.current) setLoadError(error instanceof Error ? error.message : String(error));
      });

    const open = () => {
      if (disposed) return;
      const next = new EventSource(EVENTS_URL);
      source = next;
      next.onopen = () => {
        if (!disposed) setConnection("live");
      };
      next.onerror = () => {
        if (disposed) return;
        setConnection("reconnecting");
        if (next.readyState === EventSource.CLOSED) {
          next.close();
          reopenTimer = window.setTimeout(open, REOPEN_DELAY_MS);
        }
      };
      next.addEventListener("snapshot", (event) => {
        const data = parseEvent<LoungeSnapshot>(event as MessageEvent);
        if (!data || disposed) return;
        dispatch({ type: "snapshot", source: "sse", data });
        setLoadError(null);
        setConnection("live");
      });
      next.addEventListener("state", (event) => {
        const data = parseEvent<LoungeStateEvent>(event as MessageEvent);
        if (data && !disposed) dispatch({ type: "state", data });
      });
      next.addEventListener("message", (event) => {
        const data = parseEvent<LoungeMessageEvent>(event as MessageEvent);
        if (data && !disposed) dispatch({ type: "message", data });
      });
      next.addEventListener("delta", (event) => {
        const data = parseEvent<LoungeDeltaEvent>(event as MessageEvent);
        if (data && !disposed) dispatch({ type: "delta", data });
      });
    };
    open();

    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(reopenTimer);
      source?.close();
    };
  }, [enabled]);

  const post = useCallback(async (body: LoungeActionBody): Promise<boolean> => {
    // 조작 하나에 requestId 하나. 자동 재시도는 하지 않는다 — 같은 의도를 두 번 보내는 일은
    // 사용자가 다시 누를 때뿐이고, 그때는 새 의도다.
    const payload = { ...body, requestId: requestId(), roomId: LOUNGE_ROOM_ID } as LoungeAction;
    setPending((current) => new Set(current).add(body.action));
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setActionError(await errorText(response));
        return false;
      }
      const result = await response.json() as LoungePostResponse;
      if (result?.snapshot) dispatch({ type: "snapshot", source: "post", data: result.snapshot });
      setActionError(null);
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(body.action);
        return next;
      });
    }
  }, []);

  const updateSettings = useCallback(
    (settings: LoungeSettingsUpdate) => post({ action: "settings", ...settings }),
    [post],
  );
  const send = useCallback(
    (text: string, replyToId?: string) => post(replyToId ? { action: "send", text, replyToId } : { action: "send", text }),
    [post],
  );
  const stop = useCallback(() => post({ action: "stop" }), [post]);
  const react = useCallback(
    (messageId: string, emoji: string) => post({ action: "reaction", messageId, emoji }),
    [post],
  );
  const dismissActionError = useCallback(() => setActionError(null), []);

  const streaming = useMemo(() => [...state.streaming.values()], [state.streaming]);

  return {
    snapshot: state.snapshot,
    streaming,
    connection,
    loadError,
    actionError,
    pending,
    updateSettings,
    send,
    stop,
    react,
    dismissActionError,
  };
}
