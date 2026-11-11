/** Built-in interface languages. */
export const BUILT_IN_LOCALES = ["en", "ko"] as const;

export type Locale = (typeof BUILT_IN_LOCALES)[number];

/** Simple interpolation parameters for translated strings. */
export type TranslationParams = Record<string, string | number>;

/** A registrable locale. */
export interface LocalePlugin {
  /** Unique locale id. */
  id: string;
  /** Name shown in the language menu. */
  label: string;
  /** Translated messages keyed by stable keys. */
  messages: Record<string, string>;
}
