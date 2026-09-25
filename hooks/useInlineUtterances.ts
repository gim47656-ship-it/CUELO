"use client";

import { useMemo } from "react";
import {
  groupInlineUtterances,
  normalizeInlineUtterances,
  type InlineUtterance,
  type InlineUtteranceContext,
} from "@/lib/inline-utterance";
import { subagentUtteranceSource } from "./useSubagentUtterances";
import { web6UtteranceSource } from "./useWeb6Utterances";

/**
 * 이 창의 발화를 턴별로 묶어 돌려준다.
 *
 * 대화창에 자기 목소리로 끼어드는 화자는 여기서 부르는 출처가 전부다. 새 화자를 붙이는 일은
 * 그 계약을 구현한 어댑터 하나를 만들어 여기서 한 번 부르고 memo 의존성에 더하는 것으로
 * 끝난다 — 대화창도 렌더러도 그 화자를 알 필요가 없다.
 *
 * 출처가 내놓은 발화는 여기서 한 번 정규화한 뒤 묶인다 — 겹쳐 세우는 규칙은 화자마다 다른
 * 사정이 아니라 모든 화자에게 공통된 것이므로, 어댑터가 아니라 이 합류 지점에 있다.
 *
 * 출처별 결과의 정체성이 그대로면 지도도 그대로여야 한다 — 값이 매 렌더 새로 생기면 이 값을
 * 구독하는 스레드가 매 렌더 다시 그려진다. 의존성은 React Compiler가 검증할 수 있게 출처마다
 * 하나씩 적는다.
 */
export function useInlineUtterances(
  context: InlineUtteranceContext,
): ReadonlyMap<number, readonly InlineUtterance[]> {
  const subagent = subagentUtteranceSource.use(context);
  const web6 = web6UtteranceSource.use(context);
  return useMemo(
    () => groupInlineUtterances(normalizeInlineUtterances([...subagent, ...web6])),
    [subagent, web6],
  );
}
