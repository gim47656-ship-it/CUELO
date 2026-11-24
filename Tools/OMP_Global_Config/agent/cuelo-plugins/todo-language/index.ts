import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { onSessionLifecycle } from "../../extensions/lib/session-identity";
import { hasEnglishOnlyTodoProse, hasJapaneseTodoProse, introducedTodoFields, requestedTodoEnglish, requestedTodoJapanese, userWritesKorean } from "./todo-language";

// 야간 묶음(lib/upkeep/plugin-events.ts)이 종류별 건수만 센다. 문구, 세션, 경로는 남기지 않는다.
// 설치된 플러그인 폴더(cuelo-plugins/<id>)에서 두 단계 위가 에이전트 폴더다.
export const EVENTS_FILE = "cuelo-todo-language-events.jsonl";

/**
 * `checked`: 새 표시 문구가 있는 Main todo 호출을 검사함. `allow-*`: 사용자 요청 덕에 그 언어 문구가 든 호출이 통과함.
 * `rewritten`: 거절 뒤 새 문구가 있는 다음 todo 호출이 예외 없이(일본어 가나 산문도 한글 없는 영어도 없이) 통과함.
 */
type TodoLanguageEvent = "checked" | "block-japanese" | "block-english" | "rewritten" | "allow-japanese" | "allow-english";

function record(kind: TodoLanguageEvent): void {
  try {
    const path = process.env.CUELO_TODO_LANGUAGE_EVENTS_PATH || join(import.meta.dir, "..", "..", EVENTS_FILE);
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), kind })}\n`);
  } catch {
    // 기록 실패는 검사를 막지 않는다.
  }
}

export default function todoLanguageGuard(pi: ExtensionAPI): void {
  let japaneseRequested = false;
  let englishRequested = false;
  let koreanUser = false;
  let blocked = false;
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
    blocked = false;
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
    if (!fields.length) return;
    record("checked");
    const japaneseField = fields.find(candidate => hasJapaneseTodoProse(candidate.text));
    const japanese = japaneseRequested ? undefined : japaneseField;
    if (japanese) {
      blocked = true;
      record("block-japanese");
      return {
        block: true,
        reason: `todo-language-guard: ${japanese.location}에 일본어 가나 산문이 있다. 새 표시 문구를 짧은 한국어로 바꿔 다시 호출하라. 코드, 경로, API 이름, 원본 오류와 인용은 그대로 보존하라. 사용자가 직접 일본어 할 일을 요청한 경우만 예외다. 기존 할 일 상태는 변경하지 않았다.`,
      };
    }
    // Only a Korean-speaking user sees an English todo as a foreign language; English users keep English todos.
    const englishField = koreanUser ? fields.find(candidate => hasEnglishOnlyTodoProse(candidate.text)) : undefined;
    const english = englishRequested ? undefined : englishField;
    if (english) {
      blocked = true;
      record("block-english");
      return {
        block: true,
        reason: `todo-language-guard: ${english.location}이 한글 없는 영어 문장이다. 사용자가 한국어로 말하므로 할 일은 사용자 화면에 그대로 보인다. 새 표시 문구를 짧은 한국어로 바꿔 다시 호출하라. 코드, 경로, 명령, API 이름은 백틱으로 감싸 그대로 두라. 사용자가 직접 영어 할 일을 요청한 경우만 예외다. 기존 할 일 상태는 변경하지 않았다.`,
      };
    }
    if (japaneseField) record("allow-japanese");
    if (englishField) record("allow-english");
    if (blocked && !japaneseField && !englishField) record("rewritten");
    blocked = false;
  });
}
