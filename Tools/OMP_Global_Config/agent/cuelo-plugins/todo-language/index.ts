import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { onSessionLifecycle } from "../../extensions/lib/session-identity";
import { hasJapaneseTodoProse, introducedTodoFields, requestedTodoJapanese } from "./todo-language";

export default function todoLanguageGuard(pi: ExtensionAPI): void {
  let japaneseRequested = false;
  const readRequest = (message: { role?: string; synthetic?: boolean; attribution?: string; content?: unknown }) => {
    if (message.role !== "user" || message.synthetic === true || message.attribution === "agent") return;
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
    japaneseRequested = requestedTodoJapanese(text) ?? japaneseRequested;
  };
  onSessionLifecycle(pi, { start: ctx => {
    japaneseRequested = false;
    if (ctx.agent.kind !== "main") return;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message") readRequest(entry.message);
    }
  } });
  pi.on("input", (event, ctx) => {
    if (ctx.agent.kind !== "main" || (event.source !== "interactive" && event.source !== "rpc")) return;
    japaneseRequested = requestedTodoJapanese(event.text) ?? japaneseRequested;
  });
  pi.on("message_start", (event, ctx) => {
    const message = event.message as { role?: string; synthetic?: boolean; attribution?: string; steering?: boolean; content?: unknown };
    if (ctx.agent.kind !== "main" || message.role !== "user" || message.steering !== true
      || message.synthetic === true || message.attribution === "agent") return;
    readRequest(message);
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "todo" || ctx.agent.kind !== "main" || japaneseRequested) return;
    if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) return;
    const phases = getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch());
    const field = introducedTodoFields(event.input, new Set(phases.map(phase => phase.name)))
      .find(candidate => hasJapaneseTodoProse(candidate.text));
    if (field) return {
      block: true,
      reason: `todo-language-guard: ${field.location}에 일본어 가나 산문이 있다. 새 표시 문구를 짧은 한국어로 바꿔 다시 호출하라. 코드, 경로, API 이름, 원본 오류와 인용은 그대로 보존하라. 사용자가 직접 일본어 할 일을 요청한 경우만 예외다. 기존 할 일 상태는 변경하지 않았다.`,
    };
  });
}
