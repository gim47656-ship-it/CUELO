import {
  getAvailableThemes,
  getResolvedThemeColors,
  isLightTheme,
} from "@oh-my-pi/pi-tui/theme/theme";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgThemeDark, cfgThemeLight } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { WebThemeConfig, WebThemePalette } from "@/lib/settings-api";

function firstColor(...values: Array<string | undefined>): string {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? "transparent";
}


/**
 * Resolves a core theme name into the only web-side values that are not owned
 * by `@seed-design/css`: the three markdown accents. Surfaces, text, borders
 * and state colors all come from SEED semantic tokens in app/globals.css, so
 * nothing here is written onto `<html style>` that could outrank them.
 */
export async function getWebThemePalette(name: string): Promise<WebThemePalette> {
  const colors = await getResolvedThemeColors(name);
  const colorScheme = isLightTheme(name) ? "light" : "dark";
  const seedFallback = "var(--seed-color-fg-brand)";

  return {
    name,
    colorScheme,
    variables: {
      "--omp-md-heading": firstColor(colors.mdHeading, seedFallback),
      "--omp-md-link": firstColor(colors.mdLink, seedFallback),
      "--omp-md-code": firstColor(colors.mdCode, colors.syntaxString, seedFallback),
    },
  };
}

export async function getWebThemeConfig(settings: Settings): Promise<WebThemeConfig> {
  const dark = cfgThemeDark.get(settings) ?? "titanium";
  const light = cfgThemeLight.get(settings) ?? "light";
  const [darkPalette, lightPalette] = await Promise.all([
    getWebThemePalette(dark),
    getWebThemePalette(light),
  ]);
  return {
    names: { dark, light },
    palettes: { dark: darkPalette, light: lightPalette },
  };
}

export async function getAvailableWebThemes(): Promise<Array<{ name: string; colorScheme: "dark" | "light" }>> {
  const names = await getAvailableThemes();
  return names.map((name) => ({ name, colorScheme: isLightTheme(name) ? "light" : "dark" }));
}
