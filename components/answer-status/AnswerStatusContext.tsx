"use client";

import { createContext } from "react";
import { EMPTY_DISPATCH_LEDGER, type DispatchLedger, type MakerRunState, type VerdictRecord } from "@/lib/answer-status/dispatch";
import type { SubagentSnapshot, ToolResultMessage } from "@/lib/types";

export type AnswerStatusPanelView = "subagents" | "process";

/**
 * 덱의 Maker 상세에 열린 대상. 선택은 셸 한 곳이 들고, 발주 카드와 Subagents 패널이 같은 값을 본다.
 */
export interface MakerSelection {
  /** Subagents 패널 레코드 key(`live:<id>` 또는 `archive:<name>`). */
  key: string;
  /** 발주 카드에서 열었으면 그 task 호출 id. 레코드의 parentToolCallId와 같을 때만 상세를 보인다. */
  toolCallId?: string;
  /** 연 발주 카드 행(`DispatchMember.key`). 뒤로 가면 그 행의 자세히 버튼으로 초점이 돌아간다. */
  origin?: string;
  /** 카드가 관측한 실행 상태와 Main 판정. 목록에서 연 상세에는 판정 근거가 없어 비어 있다. */
  status?: { run: MakerRunState; verdict: VerdictRecord | null };
}

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
  /** 이 대화의 세션 id. 실행 중 Maker의 진행률·예상 시간을 읽을 때 쓴다. 없으면 그 줄을 숨긴다. */
  sessionId?: string | null;
  /** 이 대화의 작업 폴더. 자식 기록에서 임시 파일 쓰기를 가를 때 쓴다(밖의 임시 폴더만 임시로 본다). */
  cwd?: string;
  /**
   * Maker 상세를 덱에 연다. `reveal`이 false면 이미 열린 같은 대상의 상태만 갱신하고 보기를 옮기지 않는다.
   * 없으면 카드에 자세히 버튼이 없다.
   */
  onOpenMaker?: (selection: MakerSelection, reveal?: boolean) => void;
  /** 지금 덱에 열린 Maker. 그 카드 행에 data-focused가 붙는다. */
  selectedMaker?: MakerSelection | null;
}

export const AnswerStatusContext = createContext<AnswerStatusContextValue>({
  ledger: EMPTY_DISPATCH_LEDGER,
  subagents: [],
  toolResults: new Map(),
});
