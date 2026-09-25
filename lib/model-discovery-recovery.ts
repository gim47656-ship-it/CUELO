/**
 * Bounded single-flight recovery for a model the shared registry is missing.
 *
 * omp-web builds one `ModelRegistry` per process and discovers models once, at
 * startup (`lib/omp-runtime.ts`). When that pass fails, or when the cached
 * discovery row is one the loader discards because its credential headers were
 * stripped, the provider stays empty for the whole process lifetime and every
 * later lookup fails. `refresh("offline")` cannot repair that — offline never
 * fetches — so a lookup that actually missed pays for one provider-scoped
 * online pass instead. The bound and the single-flight below are what keep a
 * genuinely absent model from turning into a per-request fetch loop; neither
 * comes from a setting, because a missing model is not a configuration knob.
 */

/** Registry slice the recovery needs: one provider-scoped discovery pass. */
export interface ProviderDiscoveryRegistry {
  /** `strategy: "online"` forces the fetch; the default would honor a fresh cache. */
  refreshProvider(provider: string, strategy: "online"): Promise<void>;
}

export type MissingModelRefreshOutcome = "refreshed" | "joined" | "throttled" | "failed";

export interface MissingModelRecoveryResult {
  outcome: MissingModelRefreshOutcome;
  /** True when this call shared another lookup's in-flight pass instead of starting one. */
  shared: boolean;
  /** Discovery failure text. Present on failure, including when the shared pass failed. */
  error?: string;
}

export interface MissingModelRecoveryOptions {
  /** Skip the spacing window for an explicit user selection. In-flight work is still shared. */
  force?: boolean;
}

export interface MissingModelRecovery {
  recover(provider: string, options?: MissingModelRecoveryOptions): Promise<MissingModelRecoveryResult>;
}

/**
 * Minimum spacing between discovery attempts for one provider. A model that is
 * genuinely absent must not be re-fetched on every request, and a transient
 * discovery failure must not be retried in a loop.
 */
export const MISSING_MODEL_REFRESH_INTERVAL_MS = 60_000;

/**
 * Keep discovery diagnostics useful without reflecting provider response
 * bodies, headers, URLs, or credential values into an API response.
 */
function safeDiscoveryFailure(error: unknown): string {
  const details: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      details.push(current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === "object" && current !== null) {
      const value = current as { message?: unknown; code?: unknown; status?: unknown; cause?: unknown };
      if (typeof value.message === "string") details.push(value.message);
      if (typeof value.code === "string") details.push(value.code);
      if (typeof value.status === "number") details.push(`HTTP ${value.status}`);
      current = value.cause;
      continue;
    }
    details.push(String(current));
    break;
  }
  const message = details.join(" ");
  const status = message.match(/\b(?:HTTP\s*)?([45]\d{2})\b/i)?.[1];
  const authenticationFailure = status === "401"
    || status === "403"
    || /\b(?:api[- ]?key|credential|authentication|unauthorized|forbidden)\b/i.test(message);
  if (authenticationFailure) {
    return status ? `provider authentication failed (HTTP ${status})` : "provider authentication failed";
  }
  const networkCode = message.match(
    /\b(EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b/i,
  )?.[1];
  if (networkCode) return networkCode.toUpperCase();
  if (/\b(?:timed?\s*out|timeout)\b/i.test(message)) return "request timed out";
  if (status) return `HTTP ${status}`;
  return "discovery request failed";
}

/**
 * Create the recovery policy for one registry.
 *
 * Concurrent misses for the same provider join a single in-flight pass, so N
 * simultaneous lookups cost one fetch, not N. A miss on the normal path never
 * reaches this function at all: callers only recover after `find` returned
 * nothing.
 */
export function createMissingModelRecovery(
  registry: ProviderDiscoveryRegistry,
  options: { intervalMs?: number; now?: () => number } = {},
): MissingModelRecovery {
  const intervalMs = options.intervalMs ?? MISSING_MODEL_REFRESH_INTERVAL_MS;
  const now = options.now ?? Date.now;
  /** provider → start time of the last attempt, successful or not. */
  const lastAttemptAt = new Map<string, number>();
  /** provider → in-flight attempt every concurrent misser shares. */
  const inFlight = new Map<string, Promise<MissingModelRecoveryResult>>();

  const recover = (
    provider: string,
    recoveryOptions: MissingModelRecoveryOptions = {},
  ): Promise<MissingModelRecoveryResult> => {
    const running = inFlight.get(provider);
    if (running) {
      return running.then((result) => ({ ...result, shared: true }));
    }
    const attemptStartedAt = now();
    const lastAttempt = lastAttemptAt.get(provider);
    if (!recoveryOptions.force && lastAttempt !== undefined && attemptStartedAt - lastAttempt < intervalMs) {
      return Promise.resolve({ outcome: "throttled", shared: false });
    }
    // Forced attempts also move the normal-path window forward, preventing the
    // next background lookup from immediately paying for another online pass.
    lastAttemptAt.set(provider, attemptStartedAt);
    const attempt: Promise<MissingModelRecoveryResult> = registry
      .refreshProvider(provider, "online")
      .then((): MissingModelRecoveryResult => ({ outcome: "refreshed", shared: false }))
      .catch((error: unknown): MissingModelRecoveryResult => ({
        outcome: "failed",
        shared: false,
        error: safeDiscoveryFailure(error),
      }))
      .finally(() => {
        if (inFlight.get(provider) === attempt) inFlight.delete(provider);
      });
    inFlight.set(provider, attempt);
    return attempt;
  };

  return { recover };
}

/**
 * Why a lookup is still missing after its bounded recovery.
 *
 * Names the requested selector, whether the provider is even registered, and
 * what discovery did — including its error text. The message states the
 * observable cause instead of a bare "not found", so a failure is not read as a
 * typo when the provider has no credential or its discovery endpoint is down.
 */
export function describeMissingModel(args: {
  selector: string;
  provider: string;
  providerKnown: boolean;
  recovery: MissingModelRecoveryResult;
}): string {
  if (!args.providerKnown) {
    return `Unknown model provider "${args.provider}" for ${args.selector}: the provider is not registered.`;
  }
  if (args.recovery.outcome === "failed") {
    return `Model ${args.selector} is not in the model list and the discovery refresh for provider "${args.provider}" failed: ${args.recovery.error ?? "unknown error"}.`;
  }
  if (args.recovery.outcome === "throttled") {
    return `Model ${args.selector} is not in the model list. Discovery for provider "${args.provider}" was refreshed recently, so this lookup did not fetch again.`;
  }
  return `Model ${args.selector} is not in the model list after refreshing discovery for provider "${args.provider}".`;
}
