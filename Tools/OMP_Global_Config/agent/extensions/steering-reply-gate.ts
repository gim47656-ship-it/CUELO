import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Message = {
  role?: string;
  content?: unknown;
  steering?: boolean;
  synthetic?: boolean;
  attribution?: string;
};

/**
 * 첫 도구 호출 앞에 사용자에게 보인 답이 있었는지 본다. Anthropic은 도구 앞 문장을 서명된
 * `narration` 블록으로 보내고 core는 이를 본문이 빈 `thinking` 블록으로 저장한다(2026-09-25 실측).
 * 서명 안의 블록 종류 이름으로 구분한다.
 */
function hasIntroText(message: Message): boolean {
  if (!Array.isArray(message.content)) return false;
  for (const block of message.content) {
    if (block?.type === "toolCall") return false;
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) return true;
    if (block?.type === "thinking" && typeof block.thinkingSignature === "string"
      && Buffer.from(block.thinkingSignature, "base64").toString("latin1").includes("narration")) return true;
  }
  return false;
}

export default function steeringReplyGate(pi: ExtensionAPI): void {
  let awaitingReply = false;
  let assistantReplied = false;

  pi.on("session_start", () => {
    awaitingReply = false;
    assistantReplied = false;
  });
  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc") awaitingReply = false;
  });
  pi.on("message_start", (event) => {
    const message = event.message as Message;
    if (message.role === "user" && message.steering === true && message.synthetic !== true && message.attribution !== "agent") {
      awaitingReply = true;
      assistantReplied = false;
    } else if (message.role === "assistant" && awaitingReply) {
      assistantReplied = hasIntroText(message);
    }
  });
  pi.on("message_update", (event) => {
    if (awaitingReply && event.message.role === "assistant") {
      assistantReplied = hasIntroText(event.message);
    }
  });
  pi.on("message_end", (event) => {
    if (awaitingReply && event.message.role === "assistant") {
      assistantReplied = hasIntroText(event.message);
    }
  });
  pi.on("turn_end", (event) => {
    if (awaitingReply && event.message.role === "assistant" && assistantReplied && event.toolResults.length === 0) {
      awaitingReply = false;
    }
  });
  pi.on("tool_call", (event) => {
    if (!awaitingReply) return;
    const carried = "assistantMessage" in event ? event.assistantMessage : undefined;
    if (carried && typeof carried === "object" && hasIntroText(carried as Message)) assistantReplied = true;
    awaitingReply = false;
    if (assistantReplied) return;
    // 2026-09-25: 차단은 답을 먼저 쓴 응답까지 막아 거부·재시도 문구가 사용자 화면에 반복됐다.
    // 도구는 그대로 실행하고, 답 없이 시작한 경우에만 다음 단계에 안내를 끼운다. 판정 근거는 진단 로그로 남긴다.
    logGateMiss(event, carried);
    pi.sendMessage(
      { customType: "steering-reply-gate", content: REMINDER, display: false, attribution: "agent" },
      { deliverAs: "aside" },
    );
  });
}

const REMINDER = "사용자 메시지에 아직 답하지 않고 도구를 시작했다. 다음 응답 첫머리에 사용자 메시지에 대한 답을 1~2문장으로 쓰고, 같은 응답에서 작업을 이어 가라.";

function logGateMiss(event: unknown, carried: unknown): void {
  try {
    const blocks = carried && typeof carried === "object" && "content" in carried && Array.isArray(carried.content)
      ? carried.content.map((block: { type?: unknown }) => String(block?.type)) : null;
    const line = JSON.stringify({ ts: new Date().toISOString(), hasCarried: carried !== undefined, blocks, eventKeys: event && typeof event === "object" ? Object.keys(event) : [] });
    appendFileSync(join(homedir(), ".omp", "agent", "steering-gate-miss.jsonl"), `${line}\n`);
  } catch {
    // 진단 기록 실패가 도구 실행을 막지 않는다.
  }
}
