import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { onSessionLifecycle } from "./lib/session-identity";

// 전역 AGENTS.md 「사용자가 명시하지 않으면 `goal`에 `token_budget`을 두지 않는다」를 글 대신 지키는 안내다.
// 막지 않는다(2026-11-11 사용자 결정: 안내). Main이 이번 요청의 사용자 글에 없는 예산을 걸면 입력당 한 번 aside로 알린다.
// 명시 요청 판정은 휴리스틱이다: 토큰 낱말과 예산·한도 낱말이 가까이 함께 있거나, 토큰 수에 한도 표현이 붙어 있으면("no more than 1000 tokens", "토큰 5만 이내") 요청으로 본다.
// 토큰 낱말 없이 숫자만 준 요청("50만으로")은 놓치고, 예산과 무관한 토큰 한도 이야기("token limit error")에도 안내를 생략한다(안내라서 조용한 쪽으로 둔다).
const COUNT = String.raw`\d[\d,._]*\s*(?:k|m|천|만|억)?\s*(?:개\s*)?`;
const EXPLICIT_BUDGET = new RegExp([
  String.raw`(?:토큰|token)[\s\S]{0,24}(?:예산|한도|상한|제한|budget|limit|cap)`,
  String.raw`(?:예산|한도|상한|budget|limit|cap)[\s\S]{0,24}(?:토큰|token)`,
  String.raw`(?:no more than|at most|up to|under|within|max(?:imum)?|less than)\s+${COUNT}(?:tokens?|토큰)`,
  String.raw`${COUNT}(?:tokens?|토큰)\s*(?:이내|이하|안에서|안으로|까지|안쪽|or less|max)`,
  String.raw`(?:토큰|tokens?)\s*(?:은|는|을|를|:|=)?\s*${COUNT}(?:이내|이하|안에서|안으로|까지|안쪽)`,
].join("|"), "iu");

const NOTICE = "사용자가 요청하지 않은 goal token_budget을 걸었다. 사용자가 예산을 말하지 않았다면 token_budget 없이 다시 만들어라.";

function userText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join(" ");
}

export default function goalBudgetHint(pi: ExtensionAPI): void {
  let texts: string[] = [];
  let notedThisInput = false;
  const reset = () => {
    texts = [];
    notedThisInput = false;
  };
  onSessionLifecycle(pi, { start: reset });
  pi.on("input", (event) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    texts = [event.text];
    notedThisInput = false;
  });
  // 실행 도중 사용자가 끼어든 말도 같은 요청의 글이다.
  pi.on("message_start", (event) => {
    const message = event.message as { role?: string; steering?: boolean; synthetic?: boolean; attribution?: string; content?: unknown };
    if (message.role !== "user" || message.steering !== true || message.synthetic === true || message.attribution === "agent") return;
    texts.push(userText(message));
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "goal" || ctx.agent?.kind === "sub" || notedThisInput) return;
    const input = event.input as { token_budget?: unknown } | undefined;
    if (input?.token_budget === undefined) return;
    if (texts.some((text) => EXPLICIT_BUDGET.test(text))) return;
    notedThisInput = true;
    pi.sendMessage({ customType: "goal-budget-hint", content: NOTICE, display: false, attribution: "agent" }, { deliverAs: "aside" });
  });
}
