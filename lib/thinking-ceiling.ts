/**
 * 「Auto, 최대 X」 — 이 세션의 사용자 thinking 상한.
 *
 * 상한은 CUELO custom **entry**(`type: "custom"`)로 세션 기록에 남는다. custom message와 달리
 * omp는 custom entry를 모델 문맥에 넣지 않으므로 모델은 이 기록을 보지 못한다. 세션을 다시 열면
 * 현재 가지의 마지막 기록이 상한이 된다(`ceiling: null`은 해제).
 */
export const THINKING_CEILING_ENTRY_TYPE = "cuelo-thinking-ceiling";

/** omp `Effort` 값 — 서버가 받는 상한. 화면은 이 중 모델이 지원하는 low~xhigh만 내놓는다. */
export const THINKING_CEILING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingCeiling = (typeof THINKING_CEILING_LEVELS)[number];

export function isThinkingCeiling(value: unknown): value is ThinkingCeiling {
  return typeof value === "string" && (THINKING_CEILING_LEVELS as readonly string[]).includes(value);
}

/** 기록 순서대로 놓인 entry에서 마지막 상한 기록을 읽는다. 기록이 없거나 해제면 `null`. */
export function latestThinkingCeiling(entries: readonly unknown[]): ThinkingCeiling | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as { type?: unknown; customType?: unknown; data?: { ceiling?: unknown } } | null;
    if (entry?.type !== "custom" || entry.customType !== THINKING_CEILING_ENTRY_TYPE) continue;
    const ceiling = entry.data?.ceiling;
    return isThinkingCeiling(ceiling) ? ceiling : null;
  }
  return null;
}
