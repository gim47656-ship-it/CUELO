import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgComputerBackgroundFallback } from "@oh-my-pi/pi-coding-agent/tools/settings";

/**
 * Session-scoped, user-granted `computer.backgroundFallback: takeover`.
 *
 * The user's configured value is `refuse` (takeover input once leaked into the CUELO input box), so a
 * session may only be switched to `takeover` for one AnyDesk-style job at a time, on that session's own
 * `Settings` instance and never in config.yml. The core builds its computer snapshot from
 * `cfgComputerBackgroundFallback.get(session.settings)` on every call, so the override takes effect on the
 * next call and `clearOverride` returns the session to the configured value.
 */
export interface ComputerTakeoverState {
  /** This session currently runs with takeover granted by the user. */
  enabled: boolean;
  /** The configured value without our override. */
  configured: "refuse" | "takeover";
  /** The control may be offered: configured is `refuse` and this session owns its Settings. */
  available: boolean;
}

export type ComputerTakeoverRefusal = "shared_settings" | "already_takeover";

export class ComputerTakeoverError extends Error {
  constructor(readonly code: ComputerTakeoverRefusal, message: string) {
    super(message);
    this.name = "ComputerTakeoverError";
  }
}

/** Settings instances this module switched to takeover; the only ones `clearOverride` is ever called on. */
const granted = new WeakSet<Settings>();

/**
 * `shared` is true when the session uses the runtime's shared Settings instance (its cwd equals the
 * server's cwd). Writing the override there would leak into every session that later clones it, so
 * those sessions cannot use the toggle.
 */
export function computerTakeoverState(settings: Settings, shared: boolean): ComputerTakeoverState {
  if (granted.has(settings)) return { enabled: true, configured: "refuse", available: false };
  const configured = cfgComputerBackgroundFallback.get(settings);
  return { enabled: false, configured, available: configured === "refuse" && !shared };
}

export function setComputerTakeover(settings: Settings, shared: boolean, enabled: boolean): ComputerTakeoverState {
  if (!enabled) {
    revokeComputerTakeover(settings);
    return computerTakeoverState(settings, shared);
  }
  if (granted.has(settings)) return computerTakeoverState(settings, shared);
  if (shared) {
    throw new ComputerTakeoverError(
      "shared_settings",
      "This session shares the server's settings, so takeover cannot be allowed for it alone. Open the project in its own folder.",
    );
  }
  if (cfgComputerBackgroundFallback.get(settings) !== "refuse") {
    throw new ComputerTakeoverError("already_takeover", "Takeover is already allowed by the configuration.");
  }
  cfgComputerBackgroundFallback.override(settings, "takeover");
  granted.add(settings);
  return computerTakeoverState(settings, shared);
}

/** Back to the configured value. Safe to call when nothing was granted. */
export function revokeComputerTakeover(settings: Settings): void {
  if (!granted.delete(settings)) return;
  cfgComputerBackgroundFallback.clearOverride(settings);
}
