/**
 * 사용자에게 보이는 assistant 본문 조각을 고른다. text 블록과 **한국어로 쓴 thinking 블록**이다.
 *
 * `omitThinking: false`(2026-09-28 사용자 결정)에서는 Anthropic이 reasoning 요약과 Opus 5.5의 도구 앞
 * 진행 문장을 둘 다 thinking 블록으로 보내고, 블록 종류로는 둘을 가를 수 없다(공식 문서). 진행 문장은
 * 사용자 말투 규칙대로 한국어이고 reasoning 요약은 영어로 오므로, 한글 비율로 진행 문장만 본문에 넣는다.
 */
type Block = { type?: unknown; text?: unknown; thinking?: unknown };

const KOREAN_SHARE = 0.3;

function isKoreanProse(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const hangul = prose.match(/[\uAC00-\uD7A3]/g)?.length ?? 0;
  if (hangul < 2) return false;
  const latin = prose.match(/[A-Za-z]/g)?.length ?? 0;
  return hangul / (hangul + latin) >= KOREAN_SHARE;
}

/** 그 블록이 사용자에게 보이는 본문이면 그 글을, 아니면 undefined를 준다. */
export function visibleBlockText(block: unknown): string | undefined {
  if (!block || typeof block !== "object") return undefined;
  const { type, text, thinking } = block as Block;
  if (type === "text" && typeof text === "string") return text;
  if (type === "thinking" && typeof thinking === "string" && thinking.trim() && isKoreanProse(thinking)) return thinking;
  return undefined;
}
