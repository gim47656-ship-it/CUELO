/**
 * Providers the product no longer offers. They stay out of every provider list, cannot get a new credential
 * or login through the app, and cannot be picked as a model. Stored credentials, session history and past usage
 * rows are left exactly as they are: this only closes the way in.
 *
 * `b-ai` (B.AI) was retired on 2026-11-19 at the user's request.
 */
const RETIRED_PROVIDERS: Record<string, true> = { "b-ai": true };

export function isRetiredProvider(provider: string): boolean {
  // The model registry matches provider ids after trim + lower-case, so the guard has to as well.
  return Object.hasOwn(RETIRED_PROVIDERS, provider.trim().toLowerCase());
}

/** `provider/modelId[:level]` — omp's role selector syntax. Only the provider part decides. */
export function isRetiredModelSelector(selector: string): boolean {
  const slash = selector.indexOf("/");
  return slash > 0 && isRetiredProvider(selector.slice(0, slash));
}
