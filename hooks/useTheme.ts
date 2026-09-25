"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { WebThemeConfig } from "@/lib/settings-api";

export type ThemePreference = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

type ThemeState = {
  preference: ThemePreference;
  theme: ResolvedTheme;
};

type ToggleOrigin = { x: number; y: number };

const STORAGE_KEY = "pi-theme";
const PREFERENCE_CYCLE: ThemePreference[] = ["light", "dark", "auto"];
const SERVER_SNAPSHOT: ThemeState = { preference: "auto", theme: "light" };

const THEME_MODE_KEY = "omp-theme";
const THEME_CONFIG_KEY = "omp-theme-config";
let themeConfig: WebThemeConfig | null = null;
let themeRequestId = 0;

const listeners = new Set<() => void>();
let state: ThemeState | null = null;
let systemListening = false;

function emit(): void {
  listeners.forEach((cb) => cb());
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "auto") return value;
    // Legacy omp-web key: a stored mode keeps meaning as that preference so
    // existing dark-mode users do not silently flip to auto on upgrade.
    const legacy = localStorage.getItem(THEME_MODE_KEY);
    if (legacy === "light" || legacy === "dark") return legacy;
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  return "auto";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "auto" ? getSystemTheme() : preference;
}

/** The only variables this app writes inline; every surface color is SEED's. */
const MARKDOWN_VARIABLE_PREFIX = "--omp-md-";

/**
 * Apply the resolved color mode to the DOM. `data-seed-color-mode` is the
 * attribute `@seed-design/css` switches its token scheme on, so it is the one
 * signal that decides every surface color; `.dark` and `data-omp-theme-mode`
 * stay for this app's own selectors. The palette variables written inline are
 * only the markdown accents (`--omp-md-*`) that SEED does not define. The mode
 * is persisted under the legacy key so the SSR bootstrap paints the same thing
 * before hydration.
 */
function applyOmpPalette(theme: ResolvedTheme): void {
  const root = document.documentElement;
  const palette = themeConfig?.palettes[theme];
  root.dataset.ompThemeMode = theme;
  root.setAttribute("data-seed-color-mode", theme === "dark" ? "dark-only" : "light-only");
  root.classList.toggle("dark", theme === "dark");
  // A palette cached by an older build carries the whole surface palette
  // (`--bg`, `--text`, `--accent`, ...). Those would outrank SEED's tokens, so
  // any inline leftovers are dropped before the markdown accents are written.
  for (let index = root.style.length - 1; index >= 0; index -= 1) {
    const name = root.style.item(index);
    if (name.startsWith("--") && !name.startsWith(MARKDOWN_VARIABLE_PREFIX)) {
      root.style.removeProperty(name);
    }
  }
  if (palette) {
    for (const [name, value] of Object.entries(palette.variables)) {
      if (!name.startsWith(MARKDOWN_VARIABLE_PREFIX)) continue;
      root.style.setProperty(name, value);
    }
    root.dataset.ompThemeName = palette.name;
  }
  try {
    localStorage.setItem(THEME_MODE_KEY, theme);
  } catch {
    // The in-memory state still applies when storage is unavailable.
  }
}

function ensureState(): ThemeState {
  if (typeof window === "undefined") return SERVER_SNAPSHOT;
  if (state) return state;

  const preference = readStoredPreference();
  const theme = resolveTheme(preference);
  applyOmpPalette(theme);
  state = { preference, theme };
  return state;
}

function setThemeState(preference: ThemePreference, theme: ResolvedTheme, persist: boolean): void {
  applyOmpPalette(theme);
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // ignore storage errors (private mode, quota, etc.)
    }
  }
  state = { preference, theme };
  emit();
}

function syncAutoThemeFromSystem(): void {
  const current = ensureState();
  if (current.preference !== "auto") return;
  const theme = getSystemTheme();
  if (theme === current.theme) return;
  setThemeState("auto", theme, false);
}

function ensureSystemListener(): void {
  if (systemListening || typeof window === "undefined" || !window.matchMedia) return;

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", syncAutoThemeFromSystem);
  // Some browsers delay or miss scheme events while backgrounded.
  window.addEventListener("focus", syncAutoThemeFromSystem);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncAutoThemeFromSystem();
  });
  systemListening = true;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  ensureState();
  ensureSystemListener();
  syncAutoThemeFromSystem();
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ThemeState {
  return ensureState();
}

function getServerSnapshot(): ThemeState {
  return SERVER_SNAPSHOT;
}

function nextPreference(preference: ThemePreference): ThemePreference {
  const index = PREFERENCE_CYCLE.indexOf(preference);
  return PREFERENCE_CYCLE[(index + 1) % PREFERENCE_CYCLE.length];
}

export async function refreshOmpTheme(cwd?: string | null): Promise<void> {
  const requestId = ++themeRequestId;
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const response = await fetch(`/api/theme${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Theme request failed (${response.status})`);
  const nextConfig = await response.json() as WebThemeConfig;
  if (requestId !== themeRequestId) return;
  themeConfig = nextConfig;
  try {
    localStorage.setItem(THEME_CONFIG_KEY, JSON.stringify(themeConfig));
  } catch {
    // The in-memory configuration still applies when storage is unavailable.
  }
  applyOmpPalette(ensureState().theme);
}

export function useTheme(options?: { cwd?: string | null; syncWithOmp?: boolean }) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!options?.syncWithOmp) return;
    // A failed theme request leaves SEED's tokens in place. Re-reading the
    // cached configuration here would only restore a stale palette, and the
    // markdown accents it carries are not worth resurrecting a previous
    // build's surface colors.
    void refreshOmpTheme(options.cwd).catch(() => {});
  }, [options?.cwd, options?.syncWithOmp]);

  /** Apply one preference and persist it; the single writer both controls share. */
  const applyPreference = useCallback((preference: ThemePreference, origin?: ToggleOrigin) => {
    const theme = resolveTheme(preference);

    const apply = () => {
      setThemeState(preference, theme, true);
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsVT = typeof document.startViewTransition === "function";

    if (!supportsVT || reduceMotion) {
      apply();
      return;
    }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const transition = document.startViewTransition(apply);
    transition.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${endRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 450,
            easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {
        // transition cancelled — ignore
      });
  }, []);

  /** The menu item cycles one step: light → dark → auto. */
  const toggleTheme = useCallback((origin?: ToggleOrigin) => {
    applyPreference(nextPreference(ensureState().preference), origin);
  }, [applyPreference]);

  /** A control that names a mode applies that mode, not the next step of the cycle. */
  const setPreference = useCallback((preference: ThemePreference, origin?: ToggleOrigin) => {
    applyPreference(preference, origin);
  }, [applyPreference]);

  return {
    theme: snapshot.theme,
    preference: snapshot.preference,
    toggleTheme,
    setPreference,
    isDark: snapshot.theme === "dark",
  };
}
