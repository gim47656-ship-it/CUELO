/**
 * How often this browser picked each model in the chat model picker. Counted
 * locally so the picker can list the usual choices first; nothing leaves the
 * browser. The table is bounded: past the cap the least-picked entries go.
 */

export type ModelPickCounts = Record<string, number>;

export const MODEL_PICKS_STORAGE_KEY = "omp-web:model-picks";
const MAX_TRACKED_MODELS = 30;
/** A model picked once is not yet a habit; the list starts at the second pick. */
export const FREQUENT_MODEL_MIN_PICKS = 2;
export const FREQUENT_MODEL_LIMIT = 5;

export function modelPickKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function recordModelPick(counts: ModelPickCounts, key: string): ModelPickCounts {
  const next: ModelPickCounts = { ...counts, [key]: (counts[key] ?? 0) + 1 };
  const keys = Object.keys(next);
  if (keys.length <= MAX_TRACKED_MODELS) return next;
  // Drop the least-picked, never the one just picked.
  keys.sort((a, b) => next[a] - next[b]);
  for (const stale of keys) {
    if (Object.keys(next).length <= MAX_TRACKED_MODELS) break;
    if (stale !== key) delete next[stale];
  }
  return next;
}

/** The most-picked available models, most first; ties keep the picker's order. */
export function rankFrequentModels<T extends { provider: string; modelId: string }>(
  counts: ModelPickCounts,
  options: readonly T[],
): { option: T; count: number }[] {
  return options
    .map((option, order) => ({ option, order, count: counts[modelPickKey(option.provider, option.modelId)] ?? 0 }))
    .filter((entry) => entry.count >= FREQUENT_MODEL_MIN_PICKS)
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .slice(0, FREQUENT_MODEL_LIMIT)
    .map(({ option, count }) => ({ option, count }));
}

export function readModelPicks(): ModelPickCounts {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(MODEL_PICKS_STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const counts: ModelPickCounts = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) counts[key] = Math.floor(value);
    }
    return counts;
  } catch {
    return {};
  }
}

export function writeModelPicks(counts: ModelPickCounts): void {
  try {
    window.localStorage.setItem(MODEL_PICKS_STORAGE_KEY, JSON.stringify(counts));
  } catch {
    // Without storage the order simply stays the default one.
  }
}
