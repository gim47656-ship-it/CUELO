import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { onSessionLifecycle } from "../../extensions/lib/session-identity";
import { hasEnglishOnlyTodoProse, hasJapaneseTodoProse, introducedTodoFields, requestedTodoEnglish, requestedTodoJapanese, userWritesKorean } from "./todo-language";

export default function todoLanguageGuard(pi: ExtensionAPI): void {
  let japaneseRequested = false;
  let englishRequested = false;
  let koreanUser = false;
  const remember = (text: string) => {
    japaneseRequested = requestedTodoJapanese(text) ?? japaneseRequested;
    englishRequested = requestedTodoEnglish(text) ?? englishRequested;
    koreanUser = userWritesKorean(text) ?? koreanUser;
  };
  const readRequest = (message: { role?: string; synthetic?: boolean; attribution?: string; content?: unknown }) => {
    if (message.role !== "user" || message.synthetic === true || message.attribution === "agent") return;
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
    remember(text);
  };
  onSessionLifecycle(pi, { start: ctx => {
    japaneseRequested = false;
    englishRequested = false;
    koreanUser = false;
    if (ctx.agent.kind !== "main") return;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message") readRequest(entry.message);
    }
  } });
  pi.on("input", (event, ctx) => {
    if (ctx.agent.kind !== "main" || (event.source !== "interactive" && event.source !== "rpc")) return;
    remember(event.text);
  });
  pi.on("message_start", (event, ctx) => {
    const message = event.message as { role?: string; synthetic?: boolean; attribution?: string; steering?: boolean; content?: unknown };
    if (ctx.agent.kind !== "main" || message.role !== "user" || message.steering !== true
      || message.synthetic === true || message.attribution === "agent") return;
    readRequest(message);
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "todo" || ctx.agent.kind !== "main") return;
    if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) return;
    const phases = getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch());
    const fields = introducedTodoFields(event.input, new Set(phases.map(phase => phase.name)));
    const japanese = japaneseRequested ? undefined : fields.find(candidate => hasJapaneseTodoProse(candidate.text));
    if (japanese) return {
      block: true,
      reason: `todo-language-guard: ${japanese.location}에 일본어 가나 산문이 있다. 새 표시 문구를 짧은 한국어로 바꿔 다시 호출하라. 코드, 경로, API 이름, 원본 오류와 인용은 그대로 보존하라. 사용자가 직접 일본어 할 일을 요청한 경우만 예외다. 기존 할 일 상태는 변경하지 않았다.`,
    };
    // Only a Korean-speaking user sees an English todo as a foreign language; English users keep English todos.
    const english = !koreanUser || englishRequested ? undefined : fields.find(candidate => hasEnglishOnlyTodoProse(candidate.text));
    if (english) return {
      block: true,
      reason: `todo-language-guard: ${english.location}이 한글 없는 영어 문장이다. 사용자가 한국어로 말하므로 할 일은 사용자 화면에 그대로 보인다. 새 표시 문구를 짧은 한국어로 바꿔 다시 호출하라. 코드, 경로, 명령, API 이름은 백틱으로 감싸 그대로 두라. 사용자가 직접 영어 할 일을 요청한 경우만 예외다. 기존 할 일 상태는 변경하지 않았다.`,
    };
  });
}
