import { CHARACTER_TARGETS } from "../Tools/OMP_Global_Config/agent/extensions/character-voice";
import { anthropicOverDaySlot, enabledAnthropicCredentialIds, readSidecarQuota, type QuotaSnapshot } from "../Tools/OMP_Global_Config/agent/extensions/lib/anthropic-quota";
import { selectInitialModelScope, type InitialModelScopeOptions, type ModelScopeResult } from "./model-scope";

export const DAY_SLOT_START_NOTICE = "Anthropic 계정의 오늘 하루 몫이 소진되어 이 새 세션은 YUKI(Sol)로 시작했어요.";

/** Called only before construction; it never mutates a running session. */
export async function selectNewSessionModel(
  scope: ModelScopeResult,
  options: InitialModelScopeOptions & {
    freshTopLevel: boolean;
    sessionFile: string;
    hasExistingMessages: boolean;
    defaultThinkingLevel?: InitialModelScopeOptions["thinkingLevel"];
  },
  storage: Parameters<typeof enabledAnthropicCredentialIds>[0],
  readQuota: typeof readSidecarQuota = readSidecarQuota,
) {
  const normal = () => ({ initial: options.hasExistingMessages
    ? { scopedModels: [...scope.scopedModels], model: undefined, thinkingLevel: undefined }
    : selectInitialModelScope(scope, { ...options, thinkingLevel: options.thinkingLevel ?? options.defaultThinkingLevel }), notice: null });
  if (!options.freshTopLevel || options.sessionFile || options.hasExistingMessages || options.requestedModel) return normal();
  const selector = CHARACTER_TARGETS["YUKI(유키)"].model;
  const slash = selector.indexOf("/");
  const target = { provider: selector.slice(0, slash), modelId: selector.slice(slash + 1) };
  // An unavailable/disabled target does not prevent an otherwise normal startup.
  if (!scope.visible.some((model) => model.provider === target.provider && model.id === target.modelId)) return normal();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { promise: timeout, resolve } = Promise.withResolvers<QuotaSnapshot>();
    timer = setTimeout(() => {
      controller.abort();
      resolve({ state: "unavailable", observedAt: Date.now(), reason: "new-session quota budget exceeded" });
    }, 2_000);
    const quota = await Promise.race([readQuota(["anthropic"], controller.signal), timeout]);
    // Fable counts against its own weekly window, so a Fable default is judged on that window's daily share.
    const window = options.defaultModel?.provider === "anthropic" && options.defaultModel.modelId.startsWith("claude-fable-") ? "fable" : "shared";
    if (!anthropicOverDaySlot(quota, enabledAnthropicCredentialIds(storage), window)) return normal();
    return { initial: selectInitialModelScope(scope, { ...options, requestedModel: target }), notice: DAY_SLOT_START_NOTICE };
  } catch {
    return normal();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
