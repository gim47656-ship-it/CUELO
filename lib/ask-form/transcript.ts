/**
 * How an `ask` tool call reads in the chat transcript.
 *
 * Since core 18.18.3 the call carries `arguments.html` (one HTML form) and its result carries
 * `details.answers[{ name, question, answer }]` plus `details.timedOut`. Sessions recorded before that
 * carry `arguments.questions[]`, which this returns null for so they keep the generic tool card.
 */

export interface AskTranscriptRow {
  question: string;
  answer: string;
}

export interface AskTranscriptSummary {
  /** One line for the collapsed tool row: the first question, with how many more follow. */
  target: string;
  rows: AskTranscriptRow[];
  timedOut: boolean;
}

const TARGET_LIMIT = 120;

/** `details` of a finished new-style ask result (the core's `AskToolDetails`); every field may be absent in old records. */
interface AskResultDetails {
  answers?: unknown;
  timedOut?: unknown;
}

interface AskAnswerItem {
  question?: unknown;
  answer?: unknown;
}

/** Visible text of an agent's HTML, for the row shown before the answers arrive. */
function htmlHeadline(html: string): string {
  const withoutBlocks = html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, " ");
  return withoutBlocks
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAskToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "ask" || normalized.endsWith(".ask") || normalized.endsWith("_ask");
}

/** Null unless this is a new-style (`html`) ask call. */
export function summarizeAskCall(
  toolName: string,
  input: Record<string, unknown>,
  details: unknown,
): AskTranscriptSummary | null {
  const html = input.html;
  if (!isAskToolName(toolName) || typeof html !== "string") return null;

  const result = (typeof details === "object" && details !== null ? details : {}) as AskResultDetails;
  const rows: AskTranscriptRow[] = [];
  if (Array.isArray(result.answers)) {
    for (const item of result.answers as AskAnswerItem[]) {
      if (typeof item?.question === "string" && typeof item.answer === "string") {
        rows.push({ question: item.question, answer: item.answer });
      }
    }
  }
  const timedOut = result.timedOut === true;

  const first = rows[0]?.question || htmlHeadline(html);
  const more = rows.length > 1 ? ` (+${rows.length - 1})` : "";
  const room = Math.max(0, TARGET_LIMIT - more.length);
  const clipped = first.length > room ? `${first.slice(0, Math.max(0, room - 1))}…` : first;
  return { target: `${clipped}${more}`, rows, timedOut };
}
