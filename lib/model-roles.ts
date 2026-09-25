import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import {
  getKnownRoleIds,
  getRoleInfo,
  MODEL_ROLES,
  MODEL_ROLE_IDS,
  type ModelRole,
} from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRoleAssignment, ModelRoleModelRef, ModelRoleScope } from "./api-types";

export type { ModelRoleAssignment, ModelRoleModelRef, ModelRoleScope };

/**
 * omp's model roles, projected onto the web UI.
 *
 * omp does not have "the" model: it has a model per *scope of work* — `default`
 * for normal turns, `smol` for cheap subagent work, `slow` for deep reasoning,
 * `plan` for plan mode, `commit` for changelog generation, and so on. The TUI
 * exposes these through `/model` and Ctrl+P; this module is the equivalent data
 * source for the browser, so both surfaces read and write the same
 * `modelRoles` record in `~/.omp/agent/config.yml`.
 */

/** Description shown under each role in the web selector. */
const ROLE_DESCRIPTIONS: Record<string, string> = {
  default: "Model used for ordinary turns.",
  smol: "Cheap, fast model for subagent and background work.",
  slow: "Deep-reasoning model for hard problems.",
  vision: "Model used when a turn carries images.",
  plan: "Model that drives plan mode.",
  designer: "Model used for UI and design work.",
  commit: "Model that writes commit messages and changelogs.",
  tiny: "Smallest model, used for classification and routing.",
  task: "Model subagents spawn with by default.",
  advisor: "Second model that reviews every turn inline.",
};

export function describeModelRole(role: string): string | undefined {
  return ROLE_DESCRIPTIONS[role];
}

function toModelRef(model: Model<Api>, thinkingLevel?: string): ModelRoleModelRef {
  return {
    provider: model.provider,
    modelId: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/** Parse a role selector into a plain reference, dropping any `:thinkingLevel` suffix. */
function parseModelRoleSelector(selector: string | undefined): { provider: string; modelId: string } | undefined {
  if (!selector) return undefined;
  const slash = selector.indexOf("/");
  if (slash <= 0) return undefined;
  const modelId = selector.slice(slash + 1).split(":")[0];
  if (!modelId) return undefined;
  return { provider: selector.slice(0, slash), modelId };
}

/**
 * The `default` role as a plain model reference plus its selector effort.
 *
 * Session startup uses this the way pi-web used `settings.defaultModel`: as the
 * preferred model when the browser did not pick one explicitly.
 *
 * `provider/model:level`의 `:level`은 SDK와 같은 파서로 읽어 함께 싣는다. 새 세션의 초기
 * thinking level은 이 값이 정본이고, 호출자가 명시한 모델/level이 있으면 그쪽이 이긴다.
 * `:auto`는 SDK가 다시 계산하라는 뜻이므로 구체 level로 올리지 않는다.
 */
export function readDefaultModelRole(
  settings: Settings,
): { provider: string; modelId: string; thinkingLevel?: ThinkingLevel } | undefined {
  const parsed = parseModelString(settings.getModelRole("default") ?? "");
  if (!parsed) return undefined;
  const thinkingLevel = parsed.thinkingLevel === undefined || parsed.thinkingLevel === "auto" ? undefined : parsed.thinkingLevel;
  return {
    provider: parsed.provider,
    modelId: parsed.id,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/**
 * Every configured role as a plain model reference, deduplicated.
 *
 * Session startup checks these against the registry before the session can
 * spawn children on them, so a role whose model is missing from the process
 * catalog is repaired instead of silently resolved to something else.
 */
export function readConfiguredModelRoleRefs(settings: Settings): { provider: string; modelId: string }[] {
  const seen = new Set<string>();
  const refs: { provider: string; modelId: string }[] = [];
  for (const role of getKnownRoleIds(settings)) {
    const ref = parseModelRoleSelector(settings.getModelRole(role));
    if (!ref) continue;
    const key = `${ref.provider}/${ref.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/**
 * Every role omp knows about, with its configured selector and what that
 * selector resolves to against the currently available models.
 */
export function listModelRoles(
  settings: Settings,
  availableModels: Model<Api>[],
): ModelRoleAssignment[] {
  const builtinIds = new Set<string>(MODEL_ROLE_IDS);
  return getKnownRoleIds(settings).map((role) => {
    const info = getRoleInfo(role, settings);
    const selector = settings.getModelRole(role);
    const resolution = selector
      ? resolveModelRoleValue(selector, availableModels, { settings })
      : undefined;
    // Core `config/model-resolver.ts` warns only about a malformed thinking
    // suffix, so a selector that matches no model resolves silently. Without
    // this the panel would render a saved assignment as "not set".
    const warning = resolution?.model
      ? resolution.warning
      : resolution
        ? resolution.warning ?? `No available model matches "${selector}". The saved assignment is kept.`
        : undefined;

    return {
      role,
      ...(info.tag ? { tag: info.tag } : {}),
      name: info.name,
      ...(info.color ? { color: String(info.color) } : {}),
      builtin: builtinIds.has(role),
      hidden: Boolean(MODEL_ROLES[role as ModelRole]?.hidden),
      ...(selector ? { selector } : {}),
      source: settings.getModelRoleSource(role),
      provenance: settings.getModelRoleProvenance(role),
      ...(resolution?.model ? { resolved: toModelRef(resolution.model, resolution.thinkingLevel) } : {}),
      ...(warning ? { warning } : {}),
    };
  });
}

/**
 * Assign (or clear) a role's model.
 *
 * `scope: "project"` writes `.omp/config.yml` next to the project so a
 * repository can pin its own reviewer or commit model; `"global"` writes the
 * user's `~/.omp/agent/config.yml`. Passing `selector: undefined` clears the
 * assignment at that layer and lets the next layer down take over.
 */
export function writeModelRole(
  settings: Settings,
  role: string,
  selector: string | undefined,
  scope: ModelRoleScope,
): void {
  if (scope === "project") {
    if (selector) settings.setProjectModelRole(role, selector);
    else settings.clearProjectModelRole(role);
    return;
  }
  settings.setModelRole(role, selector);
}

/** Format a model plus optional thinking level back into a role selector. */
export function formatRoleSelector(
  model: { provider: string; modelId: string },
  thinkingLevel?: string,
): string {
  const base = `${model.provider}/${model.modelId}`;
  return thinkingLevel && thinkingLevel !== "off" ? `${base}:${thinkingLevel}` : base;
}
