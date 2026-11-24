"use client";

import { createContext } from "react";

/**
 * 채팅의 작업 흐름(이번 턴 카드와 이번 턴 인스펙터)의 명령 행이 작업 과정 패널의 같은 실행으로 이동하라고 알리는 통로.
 * 값이 있을 때만 펼친 명령 본문에 이동 버튼이 보인다. 작업 과정 패널은 자기 안쪽에 null을 내린다.
 */
export const ToolCallRevealContext = createContext<((toolCallId: string) => void) | null>(null);

/** 작업 과정 패널이 지금 찾아 보여 주는 실행. 맞는 카드는 출력을 펼치고 잠시 강조된다. */
export interface ToolCallFocus {
  toolCallId: string;
  nonce: number;
}

export const ToolCallFocusContext = createContext<ToolCallFocus | null>(null);
