"use client";

import { createContext } from "react";
import { EMPTY_DISPATCH_LEDGER, type DispatchLedger } from "@/lib/answer-status/dispatch";
import type { SubagentSnapshot, ToolResultMessage } from "@/lib/types";

export type AnswerStatusPanelView = "subagents" | "process";

/**
 * 답변 안 카드가 읽는 세션 단위 관측값. 실시간 스냅샷은 자주 바뀌므로 메시지 렌더(memo) 밖의
 * context로 흘려, 바뀔 때 카드만 다시 그린다.
 */
export interface AnswerStatusContextValue {
  ledger: DispatchLedger;
  subagents: readonly SubagentSnapshot[];
  toolResults: Map<string, ToolResultMessage>;
  /** 기존 상세 패널(서브에이전트·작업 기록)을 연다. 없으면 링크를 숨긴다. */
  onOpenPanel?: (view: AnswerStatusPanelView) => void;
  /** dock 줄에서 막 건너온 발주(`DispatchMember.key`). 그 카드와 행이 한 번 강조된다. */
  focusedDispatch?: string | null;
}

export const AnswerStatusContext = createContext<AnswerStatusContextValue>({
  ledger: EMPTY_DISPATCH_LEDGER,
  subagents: [],
  toolResults: new Map(),
});
