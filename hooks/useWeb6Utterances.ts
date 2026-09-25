"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage } from "@/lib/types";
import {
  createHanseWeb6Client,
  type Web6ConsultRecord,
} from "@/lib/hanse-web6-client";
import type {
  InlineUtterance,
  InlineUtteranceContext,
  InlineUtteranceSource,
} from "@/lib/inline-utterance";

/** 이 출처의 이름. 화자 이름의 앞머리이자 등록 이름이다. */
const WEB6_SOURCE_ID = "web6";

/**
 * 얼굴을 고르는 유일한 입력. `web6` 는 `models.yml` 에서 `auth: none` 이라 계정이 구조적으로
 * 하나뿐이고, 그래서 SHION 이 예약 얼굴이다(`lib/hanse-resource-client.ts` 의 `ACCOUNT_FACES`).
 * `credentialId` 는 싣지 않는다 — 예약 얼굴은 provider 하나로 해소된다.
 */
const WEB6_PROVIDER = "web6";

/** 기록을 다시 읽는 간격. 상담은 분 단위로 끝나므로 이보다 자주 볼 이유가 없다. */
export const WEB6_CONSULT_POLL_INTERVAL_MS = 5000;

const NO_UTTERANCES: readonly InlineUtterance[] = [];
const NO_CONSULTS: readonly Web6ConsultRecord[] = [];

/**
 * 턴 하나가 열린 시각. 인덱스는 대화창이 그리고 있는 messages 배열의 인덱스 그대로이며,
 * 그것이 곧 `InlineUtterance.turnIndex` 다.
 */
export interface ConsultTurnWindow {
  index: number;
  openedAt: number;
}

/**
 * 사용자 메시지가 연 턴의 경계들. 시각이 없는 메시지는 경계가 될 수 없으므로 건너뛴다 —
 * 그 턴의 발화는 바로 앞 경계에 붙는다.
 */
export function consultTurnWindows(messages: readonly AgentMessage[]): ConsultTurnWindow[] {
  const windows: ConsultTurnWindow[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const openedAt = (message as { timestamp?: unknown }).timestamp;
    if (typeof openedAt !== "number" || !Number.isFinite(openedAt)) continue;
    windows.push({ index, openedAt });
  }
  return windows;
}

/**
 * 그 시각이 속한 턴.
 *
 * 열린 시각이 상담 시작보다 앞선 턴 중 **가장 나중** 것이다. 순회를 일찍 끊지 않는 이유는
 * 분기를 오간 기록에서 시각이 단조롭지 않을 수 있기 때문이고, 그때도 고르는 규칙은 같다.
 * 첫 턴보다도 앞선 상담은 이 대화의 것이 아니므로 `undefined` 다.
 */
export function anchorTurnIndex(
  windows: readonly ConsultTurnWindow[],
  startedAt: number,
): number | undefined {
  let chosen: ConsultTurnWindow | undefined;
  for (const window of windows) {
    if (window.openedAt > startedAt) continue;
    if (!chosen || window.openedAt >= chosen.openedAt) chosen = window;
  }
  return chosen?.index;
}

/**
 * 현재 세션의 실패 기록만 보조 발화로 만든다. 성공 답변은 `omp_publish_reply`가 남긴
 * session-native custom entry가 화면 정본이므로 JSONL에서 다시 투영하지 않는다.
 *
 * `label` 은 비운다. 화면 이름은 예약 얼굴이 주는 별칭(SHION)이다.
 */
export function utterancesForConsults(
  consults: readonly Web6ConsultRecord[],
  messages: readonly AgentMessage[],
  sessionId: string,
): readonly InlineUtterance[] {
  if (consults.length === 0) return NO_UTTERANCES;
  const windows = consultTurnWindows(messages);
  if (windows.length === 0) return NO_UTTERANCES;

  const utterances: InlineUtterance[] = [];
  for (const consult of [...consults].sort((left, right) => left.startedAt - right.startedAt)) {
    if (consult.sessionId !== sessionId || consult.status !== "failed") continue;
    const turnIndex = anchorTurnIndex(windows, consult.startedAt);
    if (turnIndex === undefined) continue;
    // 실패 사유조차 없으면 화면에 세울 말이 없다.
    const text = consult.error ?? "";
    if (text.trim().length === 0) continue;
    utterances.push({
      // 폴링이 반복돼도 값이 변하지 않아야 한다. 상담은 직렬이라 시작·종료 시각 쌍이 유일하다.
      key: `${WEB6_SOURCE_ID}:${consult.startedAt}:${consult.finishedAt}`,
      turnIndex,
      provider: WEB6_PROVIDER,
      speakerId: `${WEB6_SOURCE_ID}:${consult.conversationId ?? "unknown"}`,
      text,
      status: "failed",
    });
  }
  return utterances.length > 0 ? utterances : NO_UTTERANCES;
}

/**
 * 폴링이 같은 목록을 다시 가져왔는지 가리는 값. 기록은 append-only 이고 상담은 끝난 뒤에
 * 기록되므로 이미 있는 줄의 본문은 바뀌지 않는다 — 시각과 상태만 비교하면 충분하고,
 * 상담 전문을 5초마다 직렬화하는 비용을 치르지 않는다.
 */
function consultSignature(consults: readonly Web6ConsultRecord[]): string {
  return consults.map((c) => `${c.startedAt}.${c.finishedAt}.${c.status}`).join("|");
}

/**
 * 6 Pro(SHION) 실패 기록 출처. provider 요청이 실어 보낸 authoritative sessionId로 먼저
 * 격리한 뒤 startedAt은 그 세션 안에서 실패를 어느 턴에 둘지 정하는 데만 쓴다.
 */
export function useWeb6Utterances(context: InlineUtteranceContext): readonly InlineUtterance[] {
  const client = useMemo(() => createHanseWeb6Client(), []);
  const [consults, setConsults] = useState<readonly Web6ConsultRecord[]>(NO_CONSULTS);
  const signatureRef = useRef("");
  const sessionId = context.sessionId ?? "";
  const enabled = sessionId.length > 0;
  useEffect(() => {
    if (!enabled) {
      signatureRef.current = "";
      setConsults(NO_CONSULTS);
      return;
    }
    const controller = new AbortController();
    const read = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const next = await client.listConsults(sessionId, controller.signal);
        const signature = consultSignature(next);
        // 같은 목록이면 상태를 갈지 않는다 — 5초마다 새 배열을 세우면 이 값을 구독하는
        // 발화 스레드가 5초마다 다시 그려진다.
        if (signature === signatureRef.current) return;
        signatureRef.current = signature;
        setConsults(next);
      } catch {
        // 기록을 못 읽으면 직전 상태를 그대로 둔다. 화면에서 화자가 사라지는 편이 더 나쁘다.
      }
    };
    void read();
    const timer = setInterval(() => void read(), WEB6_CONSULT_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [client, enabled, sessionId]);

  return useMemo(
    () => utterancesForConsults(consults, context.messages, sessionId),
    [consults, context.messages, sessionId],
  );
}

export const web6UtteranceSource: InlineUtteranceSource = {
  id: WEB6_SOURCE_ID,
  use: useWeb6Utterances,
};
