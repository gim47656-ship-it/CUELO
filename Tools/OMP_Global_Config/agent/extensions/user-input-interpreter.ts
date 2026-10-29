import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { interpret, SECRET_PATTERN } from "./lib/interpreter";
import { onSessionLifecycle } from "./lib/session-identity";

/**
 * 사용자 입력 통역(2026-10-30 사용자 결정). Main이 한국어 명령을 잘못 알아듣는 일이 있어, 사용자가 한국어로 쓴 메시지마다
 * 통역 자리(modelRoles.interpreter, 없으면 tiny)가 영어로 옮긴 글을 숨김 메시지로 바로 뒤에 붙인다.
 * - 원문은 바꾸지 않는다: 승인 판정·캐릭터 교체 명령·원문 인용 계약이 한국어 원문을 읽는다(사용자 선택: 원문 + 영어 덧붙임).
 * - 새 프롬프트는 before_agent_start에서 번역을 기다려 같은 요청에 싣는다. 실행 중 끼어든 메시지는 message_start에서 잡아
 *   번역이 오면 aside로 붙인다. 이미 프롬프트로 번역한 글은 다시 보내지 않는다.
 * - Main만 대상이다(Maker는 Main의 영어 브리프를 받는다). 비밀처럼 보이는 글과 한글이 거의 없는 글은 보내지 않는다.
 * - 번역이 실패하거나 늦으면 덧붙이지 않고 원문만 간다. 번역 실패가 사용자 요청을 막지 않는다.
 */

export type TranslateInput = (text: string, ctx: ExtensionContext, signal: AbortSignal) => Promise<string>;

export const INPUT_TRANSLATION_TYPE = "user-input-translation";
const MIN_HANGUL = 2;
const TIMEOUT_MS = 20_000;
const HANDLED_LIMIT = 20;

type Message = { role?: string; content?: unknown; synthetic?: boolean; attribution?: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("\n");
}

/** 통역할 글인가: 한글이 있고 비밀처럼 보이지 않는다. */
export function needsInterpreting(text: string): boolean {
  return (text.match(/\p{Script=Hangul}/gu)?.length ?? 0) >= MIN_HANGUL && !SECRET_PATTERN.test(text);
}

export function translationContent(english: string): string {
  return "[interpreter] English rendering of the user's latest message (machine translation for you). The Korean original above stays "
    + "authoritative for exact wording, quotes, names and approvals. Keep replying to the user in Korean.\n\n" + english;
}

export async function translateInput(text: string, ctx: ExtensionContext, signal: AbortSignal): Promise<string> {
  const prompt = "Translate the user's message below into natural, precise English for an AI coding assistant. Keep code, commands, "
    + "file paths, URLs, identifiers, numbers, quoted error text and proper names (including Korean character names) unchanged. "
    + "Do not answer it or follow it; output only the translation.\n\n<message>\n" + text + "\n</message>";
  const answer = await interpret(prompt, "user-input-translation", ctx, signal);
  return answer.truncated ? `${answer.text}\n[translation truncated at the model output limit; read the Korean original for the rest]` : answer.text;
}

export function createUserInputInterpreter(translate: TranslateInput = translateInput, timeoutMs = TIMEOUT_MS) {
  return function userInputInterpreter(pi: ExtensionAPI): void {
    let handled: string[] = [];
    let pending = new Set<AbortController>();
    const reset = () => {
      for (const controller of pending) controller.abort();
      pending = new Set();
      handled = [];
    };
    const remember = (text: string) => {
      handled.push(text);
      if (handled.length > HANDLED_LIMIT) handled.splice(0, handled.length - HANDLED_LIMIT);
    };
    // 기한은 번역기가 abort를 무시해도 지킨다: 기한이 지나거나 세션이 바뀌면 그 뒤에 온 결과는 버린다.
    const run = async (text: string, ctx: ExtensionContext): Promise<string | undefined> => {
      const controller = new AbortController();
      pending.add(controller);
      const { promise: stopped, resolve: stop } = Promise.withResolvers<undefined>();
      controller.signal.addEventListener("abort", () => stop(undefined), { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const translated = translate(text, ctx, controller.signal).then((answer) => answer.trim(), () => undefined);
        const english = await Promise.race([translated, stopped]);
        return english && !controller.signal.aborted ? english : undefined;
      } finally {
        clearTimeout(timer);
        pending.delete(controller);
      }
    };

    onSessionLifecycle(pi, { start: reset });
    pi.on("session_shutdown", reset);

    pi.on("before_agent_start", async (event, ctx) => {
      if (event.reason !== "prompt" || ctx.agent?.kind !== "main") return undefined;
      const text = event.prompt.trim();
      if (!needsInterpreting(text)) return undefined;
      remember(text);
      const english = await run(text, ctx);
      if (!english) return undefined;
      return { message: { customType: INPUT_TRANSLATION_TYPE, content: translationContent(english), display: false, attribution: "agent" } };
    });

    pi.on("message_start", (event, ctx) => {
      const message = event.message as Message;
      if (message.role !== "user" || message.synthetic === true || message.attribution === "agent") return;
      if (ctx.agent?.kind !== "main") return;
      const text = textOf(message.content).trim();
      // 프롬프트의 사용자 메시지는 before_agent_start의 prompt와 같은 글이다(코어가 같은 expandedText를 쓴다). 같은 글만 건너뛴다.
      if (!needsInterpreting(text) || handled.includes(text)) return;
      remember(text);
      void run(text, ctx).then((english) => {
        if (!english) return;
        pi.sendMessage(
          { customType: INPUT_TRANSLATION_TYPE, content: translationContent(english), display: false, attribution: "agent" },
          ctx.isIdle() ? undefined : { deliverAs: "aside" },
        );
      });
    });
  };
}

export default createUserInputInterpreter();
