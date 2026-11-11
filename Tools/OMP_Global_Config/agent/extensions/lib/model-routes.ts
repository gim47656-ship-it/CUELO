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
