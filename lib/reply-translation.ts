import type { AgentMessage, AssistantMessage, CustomMessage, TextContent } from "./types";

/**
 * korean-reply-guard 확장이 영어로 나간 Main 답에 붙이는 번역 통지.
 * details.sourceTimestamp·sourceHash가 원문 assistant 메시지를 가리키면 화면은 번역을 그 말풍선 본문으로
 * 그리고 영어 원문을 접는다. 연결이 없는 옛 기록은 지금처럼 별도 상자로 남는다.
 */
export const REPLY_TRANSLATION_CUSTOM_TYPE = "korean-reply-translation";

export type ReplyTranslation = NonNullable<AssistantMessage["replyTranslation"]>;

const TRANSLATED_PREFIX = "[한국어 번역]\n";

/** 번역 대상이 된 원문: 텍스트 블록을 "\n"으로 이은 것(확장의 textOf와 같다). */
function replyText(content: AssistantMessage["content"]): string {
  return content
    .filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** 확장의 hash()와 같은 식. 확장이 details.sourceHash에 남긴 값과 비교한다. */
export function replySourceHash(content: AssistantMessage["content"]): string {
  const text = replyText(content);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

/** 원문을 가리키는 번역 통지면 그 연결을, 아니면 null. */
function linkOf(message: AgentMessage): { sourceTimestamp?: number; sourceHash?: string } | null {
  if (message.role !== "custom" || message.customType !== REPLY_TRANSLATION_CUSTOM_TYPE) return null;
  const details = message.details;
  if (!details || typeof details !== "object") return null;
  const sourceTimestamp = "sourceTimestamp" in details && typeof details.sourceTimestamp === "number" ? details.sourceTimestamp : undefined;
  const sourceHash = "sourceHash" in details && typeof details.sourceHash === "string" ? details.sourceHash : undefined;
  if (sourceTimestamp === undefined && sourceHash === undefined) return null;
  return { sourceTimestamp, sourceHash };
}

/**
 * 원문 말풍선에 붙은 번역 통지. `attachReplyTranslations`가 짝을 못 찾은 연결은 떼어 두므로
 * 그 목록에서는 이 값이 참인 통지가 곧 말풍선 안에 그려진 번역이다.
 */
export function isAttachedReplyTranslation(message: AgentMessage): boolean {
  return linkOf(message) !== null;
}

function parseTranslation(message: CustomMessage, original: string): ReplyTranslation {
  const content = typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  if (content.startsWith(TRANSLATED_PREFIX)) return { kind: "translated", text: content.slice(TRANSLATED_PREFIX.length), original };
  if (content.startsWith("[번역 생략]")) return { kind: "skipped", text: content, original };
  return { kind: "failed", text: content, original };
}

/**
 * 연결된 번역을 원문 assistant 메시지의 `replyTranslation`으로 옮긴다. 인덱스는 그대로 둔다(entryIds 정렬).
 * 짝은 앞선 assistant 가운데 hash가 같은 하나(여럿이면 timestamp도 같은 하나)이고, hash가 없으면 timestamp가 같은 하나다.
 * 원문을 하나로 정하지 못한 번역은 연결을 떼어 옛 기록처럼 상자로 남긴다.
 */
export function attachReplyTranslations(messages: AgentMessage[]): AgentMessage[] {
  let next: AgentMessage[] | null = null;
  const hashes = new Map<number, string>();
  for (let idx = 0; idx < messages.length; idx++) {
    const message = messages[idx];
    const link = linkOf(message);
    if (!link || message.role !== "custom") continue;
    next ??= [...messages];
    let candidates: number[] = [];
    for (let j = 0; j < idx; j++) {
      const candidate = messages[j];
      if (candidate.role !== "assistant") continue;
      if (link.sourceHash === undefined) {
        if (candidate.timestamp === link.sourceTimestamp) candidates.push(j);
        continue;
      }
      let hash = hashes.get(j);
      if (hash === undefined) {
        hash = replySourceHash(candidate.content ?? []);
        hashes.set(j, hash);
      }
      if (hash === link.sourceHash) candidates.push(j);
    }
    if (candidates.length > 1 && link.sourceHash !== undefined && link.sourceTimestamp !== undefined) {
      candidates = candidates.filter((j) => messages[j].timestamp === link.sourceTimestamp);
    }
    const source = candidates.length === 1 ? next[candidates[0]] : null;
    if (source?.role !== "assistant") {
      next[idx] = { ...message, details: undefined };
      continue;
    }
    next[candidates[0]] = { ...source, replyTranslation: parseTranslation(message, replyText(source.content ?? [])) };
  }
  return next ?? messages;
}
