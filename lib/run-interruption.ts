import type { AgentMessage, AssistantMessage } from "./types";

/**
 * Whether a saved transcript stops in the middle of a run: the agent was cut
 * off (server or PC went down) instead of finishing or being stopped. Only the
 * conversation roles decide it; notices, shell commands the user ran and other
 * custom records written after a turn are skipped.
 *
 * - a user prompt with nothing after it,
 * - a tool result the model never answered,
 * - an assistant message without a stop reason, or one that asked for tools
 *   whose results never arrived.
 *
 * A run the user stopped ends with `stopReason: "aborted"` and is not
 * interrupted; an `error` or `length` stop is a finished (failed) turn.
 */
export function isRunInterrupted(messages: readonly AgentMessage[]): boolean {
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const message = messages[idx];
    // Walking back, a tool result is met before the call it answers.
    if (message.role === "user" || message.role === "toolResult") return true;
    if (message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    if (!assistant.stopReason) return true;
    if (assistant.stopReason === "aborted") return false;
    return assistant.content.some((block) => block.type === "toolCall");
  }
  return false;
}
