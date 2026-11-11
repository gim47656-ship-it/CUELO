import type { InitialModelScopeOptions, ModelScopeResult } from "./model-scope";
import { selectInitialModelScope } from "./model-scope";

/**
 * Select the model a new AgentSession starts on. Called only before construction; it
 * never mutates a running session.
 *
 * 2026-11-11 user decision: a fresh session starts on the configured default model even
 * when the Anthropic account is at or over its daily share. Switching on usage ratios,
 * and the automatic return that followed, are gone; only a real provider usage-limit
 * error moves a session, through the configured retry fallback chain. An explicit
 * selection, a resumed transcript and a child therefore keep their own choice.
 */
export function selectNewSessionModel(
  scope: ModelScopeResult,
  options: InitialModelScopeOptions & {
    hasExistingMessages: boolean;
    defaultThinkingLevel?: InitialModelScopeOptions["thinkingLevel"];
  },
) {
  return options.hasExistingMessages
    ? { scopedModels: [...scope.scopedModels], model: undefined, thinkingLevel: undefined }
    : selectInitialModelScope(scope, { ...options, thinkingLevel: options.thinkingLevel ?? options.defaultThinkingLevel });
}
