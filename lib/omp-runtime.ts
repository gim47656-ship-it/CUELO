import {
  discoverAuthStorage,
  getAgentDir,
  ModelRegistry,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
  createMissingModelRecovery,
  type MissingModelRecovery,
  type MissingModelRecoveryResult,
} from "./model-discovery-recovery";

/**
 * Process-wide omp services.
 *
 * The `omp` CLI builds `Settings` + `AuthStorage` + `ModelRegistry` once per
 * process and hands them to every session. omp-web serves many requests from
 * one process, so it builds them once too and re-scopes `Settings` per project
 * instead of re-opening SQLite for every route.
 *
 * Stored on `globalThis` so Next.js hot-reload does not leak a second SQLite
 * handle onto `~/.omp/agent/agent.db`.
 */

declare global {
  var __ompRuntimePromise: Promise<OmpRuntime> | undefined;
  var __ompMissingModelRecovery: WeakMap<object, MissingModelRecovery> | undefined;
}

export interface OmpRuntime {
  agentDir: string;
  settings: Settings;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

async function createRuntime(): Promise<OmpRuntime> {
  const agentDir = getAgentDir();
  const settings = await Settings.init({ agentDir });
  const authStorage = await discoverAuthStorage(agentDir);
  // Pinning the registry to this exact AuthStorage keeps credential_disabled
  // events flowing to the same instance the routes read from.
  const modelRegistry = new ModelRegistry(authStorage);
  await modelRegistry.refresh("online-if-uncached");
  return { agentDir, settings, authStorage, modelRegistry };
}

export function getOmpRuntime(): Promise<OmpRuntime> {
  globalThis.__ompRuntimePromise ??= createRuntime().catch((error) => {
    globalThis.__ompRuntimePromise = undefined;
    throw error;
  });
  return globalThis.__ompRuntimePromise;
}

/**
 * Settings scoped to `cwd`, so project-level `.omp/config.yml` overrides apply.
 *
 * Returns the shared instance when `cwd` is already the active scope; omp's
 * `cloneForCwd` reloads only the project layer, leaving global settings and
 * runtime overrides intact.
 */
export async function getSettingsForCwd(cwd: string | undefined): Promise<Settings> {
  const { settings } = await getOmpRuntime();
  if (!cwd || settings.getCwd() === cwd) return settings;
  return settings.cloneForCwd(cwd);
}

/** Drop the cached runtime so the next request rebuilds it (config/auth edits). */
export function invalidateOmpRuntime(): void {
  globalThis.__ompRuntimePromise = undefined;
}

/**
 * The registry slice the lookup and recovery need: a model view plus one
 * provider-scoped discovery pass.
 *
 * Generic over the model type on purpose. A caller keeps the view it already
 * holds — the session's `AgentSessionLike.modelRegistry` returns `ModelLike`,
 * the process registry returns the SDK `Model<Api>` — and only the members both
 * actually offer are contractual, so neither side has to widen to the other's
 * shape.
 */
type RecoverableModelRegistry<M> = {
  find(provider: string, modelId: string): M | undefined;
  hasProvider(provider: string): boolean;
  refreshProvider(provider: string, strategy?: string): Promise<void>;
};

/**
 * Recovery policy bound to one registry instance.
 *
 * Keyed by registry so a rebuilt runtime (`invalidateOmpRuntime`) starts a fresh
 * window, and so a caller that supplies its own registry never shares the
 * process registry's in-flight pass.
 */
export function missingModelRecoveryFor<M>(registry: RecoverableModelRegistry<M>): MissingModelRecovery {
  const recoveries = (globalThis.__ompMissingModelRecovery ??= new WeakMap<object, MissingModelRecovery>());
  let recovery = recoveries.get(registry);
  if (!recovery) {
    recovery = createMissingModelRecovery(registry);
    recoveries.set(registry, recovery);
  }
  return recovery;
}

/** A lookup that stayed empty even after its bounded discovery pass. */
export interface ModelLookupMiss {
  selector: string;
  provider: string;
  providerKnown: boolean;
  recovery: MissingModelRecoveryResult;
}

export type ModelLookupOutcome<M = Model<Api>> =
  | { model: M; miss?: undefined }
  | { model?: undefined; miss: ModelLookupMiss };

export interface FindModelWithRecoveryOptions {
  /**
   * An explicit user selection may bypass the provider spacing window. It
   * still joins an existing provider-scoped discovery pass.
   */
  forceDiscovery?: boolean;
}

/**
 * Look `provider/modelId` up for execution, repairing discovery once when the
 * shared registry does not have it.
 *
 * A hit costs nothing — no refresh, no network. Only a miss pays for one
 * provider-scoped online pass, bounded and single-flight per provider. The
 * caller decides what a miss means; `describeMissingModel` renders its cause.
 */
export async function findModelWithRecovery<M>(
  registry: RecoverableModelRegistry<M>,
  provider: string,
  modelId: string,
  options: FindModelWithRecoveryOptions = {},
): Promise<ModelLookupOutcome<M>> {
  const found = registry.find(provider, modelId);
  if (found) return { model: found };
  const recovery = await missingModelRecoveryFor(registry).recover(provider, {
    force: options.forceDiscovery,
  });
  const recovered = registry.find(provider, modelId);
  if (recovered) return { model: recovered };
  return {
    miss: { selector: `${provider}/${modelId}`, provider, providerKnown: registry.hasProvider(provider), recovery },
  };
}

/**
 * Refresh discovery for configured model references the registry cannot find,
 * before a session starts executing on them.
 *
 * Session startup and child spawns resolve their model inside the core against
 * this shared registry, so a role whose model never made it into the
 * process-wide catalog would otherwise run the session on a model nobody asked
 * for. Only missing providers are refreshed, once per window, shared across
 * concurrent callers; a registry that has every reference pays nothing.
 */
export async function recoverMissingModelRefs<M>(
  registry: RecoverableModelRegistry<M>,
  refs: Iterable<{ provider: string; modelId: string }>,
): Promise<void> {
  const missingProviders = new Set<string>();
  for (const ref of refs) {
    if (!ref.provider || !ref.modelId) continue;
    if (registry.find(ref.provider, ref.modelId)) continue;
    missingProviders.add(ref.provider);
  }
  if (missingProviders.size === 0) return;
  await Promise.all([...missingProviders].map((provider) => missingModelRecoveryFor(registry).recover(provider)));
}
