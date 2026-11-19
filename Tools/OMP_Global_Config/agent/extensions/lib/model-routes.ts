import { addAbortListener } from "node:events";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
// The extension loader rewrites runtime SDK imports to the host package.

export function isHydrogen(selector: string | undefined): boolean {
  return /^(?:[^/\s]+\/)?gemini-4-hydrogen(?::[^:\s]+)?$/i.test(selector ?? "");
}

export async function modelRoleSelector(cwd: string, role: string): Promise<string | undefined> {
  const { findScopedSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  return findScopedSettings(cwd)?.getModelRole(role);
}

export async function directFallbackModel(ctx: ExtensionContext, role: string): Promise<Model<Api> | undefined> {
  const selector = await modelRoleSelector(ctx.cwd, role);
  if (!selector || isHydrogen(selector) || !/^(?:openai-codex|anthropic)\/[^:\s*?]+$/.test(selector)) return;
  const model = ctx.models.resolve(selector);
  if (model && `${model.provider}/${model.id}` === selector) return model;
}

/** Distinguish local deadlines, missing credentials and transport outages from provider denials. */
export async function operationalFailure(error: unknown): Promise<boolean> {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  const raw = typeof error === "string" ? error : undefined;
  const detail = error && typeof error === "object" ? error : undefined;
  const message = raw ?? (error instanceof Error ? error.message
    : detail && "errorMessage" in detail && typeof detail.errorMessage === "string" ? detail.errorMessage : "");
  // Vertex sends these as error text; other routes may supply stop metadata instead.
  if ((detail && "stopDetails" in detail && detail.stopDetails)
    || (detail && "stopReason" in detail && detail.stopReason === "aborted")
    || /request blocked by google|finish reason:\s*(?:SAFETY|IMAGE_SAFETY|BLOCKLIST|PROHIBITED_CONTENT|IMAGE_PROHIBITED_CONTENT|SPII|RECITATION|IMAGE_RECITATION)\b|\b(?:refusal|account must be verified|verification required|captcha|safety policy|content[_ -]blocked)\b/i.test(message)) return false;
  const ai = await import("@oh-my-pi/pi-ai/error");
  const id = detail && "errorMessage" in detail
    ? ai.classifyMessage(detail as Parameters<typeof ai.classifyMessage>[0]) : ai.classify(error);
  const has = (flag: Parameters<typeof ai.is>[1]) => ai.is(id, flag);
  if (has(ai.Flag.ContentBlocked) || has(ai.Flag.AccountPolicy) || has(ai.Flag.Abort)
    || has(ai.Flag.UserInterrupt) || has(ai.Flag.SilentAbort) || has(ai.Flag.OAuthExpiry)) return false;
  const status = ai.status(detail && "errorStatus" in detail ? { status: detail.errorStatus, message } : error instanceof Error ? error : { message });
  if (status === 401 || status === 403) return false;
  if (/^(?:No API key (?:for provider: [\w-]+|available)\.?|Could not load the default credentials\.?)$/.test(message)
    || message.startsWith("Vertex AI requires Application Default Credentials. ")) return true;
  if (has(ai.Flag.AuthFailed)) return false;
  return ai.isTransientStatus(status) || has(ai.Flag.UsageLimit) || has(ai.Flag.Transient) || has(ai.Flag.Timeout)
    || /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/.test(message);
}

/** Enforce an attempt deadline even while provider cancellation is still unwinding. */
export async function beforeModelAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const { promise, reject } = Promise.withResolvers<never>();
  using listener = addAbortListener(signal, () => reject(signal.reason));
  return await Promise.race([promise, run()]);
}

/** Only exact model-key chains authorize same-model provider routes for direct helper calls. */
export async function sameModelRoutes(cwd: string, primary: string): Promise<string[]> {
  try {
    // Runtime SDK imports are rewritten to the host package by the extension loader.
    const [{ findScopedSettings }, { cfgRetryFallbackChains }, { parseRetryFallbackSelector }] = await Promise.all([
      import("@oh-my-pi/pi-coding-agent/config/settings"),
      import("@oh-my-pi/pi-coding-agent/session/settings"),
      import("@oh-my-pi/pi-coding-agent/session/retry-fallback-chains"),
    ]);
    const settings = findScopedSettings(cwd);
    if (!settings) return [];
    // Callers supply the resolved provider/id, so a colon here belongs to the literal model id.
    const slash = primary.indexOf("/");
    if (slash <= 0) return [];
    const provider = primary.slice(0, slash);
    const id = primary.slice(slash + 1);
    const chain = cfgRetryFallbackChains.get(settings)[primary];
    if (!Array.isArray(chain)) return [];
    const routes: string[] = [];
    for (const selector of chain) {
      if (typeof selector !== "string") continue;
      const literal = selector.trim();
      const cut = literal.indexOf("/");
      // Preserve literal colon tags, including a tag whose spelling is also a thinking level.
      const parsed = literal.slice(cut + 1) === id ? { provider: literal.slice(0, cut), id } : parseRetryFallbackSelector(literal);
      if (!parsed || cut <= 0 || parsed.provider === provider || parsed.id !== id) continue;
      const route = `${parsed.provider}/${parsed.id}`;
      if (!routes.includes(route)) routes.push(route);
    }
    return routes;
  } catch {
    // Optional route lookup must never suppress the helper's existing authorized fallback.
    return [];
  }
}
