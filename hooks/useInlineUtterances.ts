"use client";

import { useMemo } from "react";
import {
  groupInlineUtterances,
  normalizeInlineUtterances,
  type InlineUtterance,
  type InlineUtteranceContext,
  type InlineUtteranceSource,
} from "@/lib/inline-utterance";
import { subagentUtteranceSource } from "./useSubagentUtterances";
import { web6UtteranceSource } from "./useWeb6Utterances";

/**
 * 대화창에 자기 목소리로 끼어드는 화자 전부.
 *
 * 새 화자를 붙이는 일은 이 계약을 구현한 어댑터 하나를 만들어 여기에 한 줄 더하는 것으로
 * 끝난다 — 대화창도 렌더러도 그 화자를 알 필요가 없다. 로더도 동적 등록도 설정도 없다.
 */
export const INLINE_UTTERANCE_SOURCES: readonly InlineUtteranceSource[] = [
  subagentUtteranceSource,
  web6UtteranceSource,
];

/**
 * 이 창의 발화를 턴별로 묶어 돌려준다.
 *
 * 출처가 내놓은 발화는 여기서 한 번 정규화한 뒤 묶인다 — 겹쳐 세우는 규칙은 화자마다 다른
 * 사정이 아니라 모든 화자에게 공통된 것이므로, 어댑터가 아니라 이 합류 지점에 있다.
 *
 * 출처 목록은 모듈 상수라 길이와 순서가 고정이다. 출처별 결과의 정체성이 그대로면 지도도
 * 그대로여야 한다 — 값이 매 렌더 새로 생기면 이 값을 구독하는 스레드가 매 렌더 다시 그려진다.
 */
export function useInlineUtterances(
  context: InlineUtteranceContext,
): ReadonlyMap<number, readonly InlineUtterance[]> {
  const collected = INLINE_UTTERANCE_SOURCES.map((source) => source.use(context));
  return useMemo(
    () => groupInlineUtterances(normalizeInlineUtterances(collected.flat())),
    [...collected],
  );
}
