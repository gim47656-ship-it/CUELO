import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { formatRoleSelector } from "./model-roles";

export interface ExplicitStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ConfiguredThinkingLevel;
}

export interface EffectiveStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel: ThinkingLevel;
  supportsThinking: boolean;
}

/**
 * Opt-in global persistence for callers that explicitly intend to update omp
 * defaults. Session creation must not call this function: model and thinking
 * overrides passed to createAgentSession are local to that session.
 *
 * This writes settings directly instead of re-running AgentSession setters.
 * The session constructor already records the effective model and thinking
 * level, while calling setModel()/setThinkingLevel() would append duplicate
 * session entries and emit duplicate extension events.
 *
 * The model is stored as omp's `default` role, matching the slot written by
 * explicit global model-role settings.
 */
export async function persistExplicitStartupPreferences(
  settings: Settings,
  explicit: ExplicitStartupPreferences,
  effective: EffectiveStartupPreferences,
): Promise<{ modelDefaultChanged: boolean }> {
  if (!explicit.model && !explicit.thinkingLevel) {
    return { modelDefaultChanged: false };
  }

  let modelDefaultChanged = false;

  if (
    explicit.model
    && effective.model
    && explicit.model.provider === effective.model.provider
    && explicit.model.modelId === effective.model.modelId
  ) {
    settings.setModelRole("default", formatRoleSelector(effective.model));
    modelDefaultChanged = true;
  }

  if (
    explicit.thinkingLevel
    && (explicit.thinkingLevel === "auto" || effective.supportsThinking || effective.thinkingLevel !== "off")
  ) {
    settings.set("defaultThinkingLevel", (explicit.thinkingLevel === "auto" ? "auto" : effective.thinkingLevel) as never);
  }

  await settings.flush();
  return { modelDefaultChanged };
}
