import { enLocale } from "./messages/en";
import { koLocale } from "./messages/ko";
import { BUILT_IN_LOCALES, type Locale, type LocalePlugin } from "./types";

const localePlugins = new Map<string, LocalePlugin>();

/** Registers a locale; registering the same id twice throws instead of silently replacing translations. */
export function registerLocale(plugin: LocalePlugin): void {
  if (!plugin.id.trim()) throw new Error("Locale id must not be empty");
  if (localePlugins.has(plugin.id)) throw new Error(`Locale already registered: ${plugin.id}`);
  localePlugins.set(plugin.id, plugin);
}

/** Returns the registered locale for `id`, or undefined. */
export function getLocalePlugin(id: string): LocalePlugin | undefined {
  return localePlugins.get(id);
}

/** Registered locale ids in a stable order. */
export function getSupportedLocales(): string[] {
  return [...localePlugins.keys()];
}

/** Whether the value is a built-in locale id. */
export function isLocale(id: string | null | undefined): id is Locale {
  return typeof id === "string" && BUILT_IN_LOCALES.includes(id as Locale);
}

/** Uses the stored built-in locale when there is one, otherwise the browser languages. */
export function resolveLocalePreference(stored: string | null, languages: readonly string[]): Locale {
  return isLocale(stored) ? stored : resolveBrowserLocale(languages);
}

/** Maps the browser's language list to a built-in locale; Korean when nothing matches. */
export function resolveBrowserLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
  }
  return "ko";
}

registerLocale(enLocale);
registerLocale(koLocale);
