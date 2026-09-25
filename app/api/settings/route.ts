import { NextResponse } from "next/server";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import { type AnySetting, lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { SETTING_TABS, TAB_GROUPS, TAB_METADATA } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { getOmpRuntime, getSettingsForCwd } from "@/lib/omp-runtime";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getAvailableWebThemes, getWebThemeConfig } from "@/lib/omp-theme";
import { translateSettingsResponseToKorean } from "@/lib/i18n/settings";
import type {
  SettingsField,
  SettingsFieldType,
  SettingsOption,
  SettingsResponse,
  SettingsValue,
} from "@/lib/settings-api";

export const dynamic = "force-dynamic";

async function validateCwd(cwd: string | null): Promise<string | undefined> {
  if (!cwd) return undefined;
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new Error("Access denied");
  return cwd;
}

function optionsFor(setting: AnySetting, runtimeThemes: string[]): SettingsOption[] | undefined {
  const path = setting.id;
  const ui = setting.ui;
  if (!ui) return undefined;
  if (ui.options === "runtime") {
    return path === "theme.dark" || path === "theme.light"
      ? runtimeThemes.map((value) => ({ value, label: value }))
      : [];
  }
  if (Array.isArray(ui.options)) return ui.options.map((option) => ({ ...option }));
  const values = setting.enumValues;
  return values?.map((value) => ({ value, label: value }));
}

function fieldTypeFor(setting: AnySetting): SettingsFieldType | null {
  const schemaType = setting.type;
  const ui = setting.ui;
  if (!ui) return null;
  if (schemaType === "boolean") return "boolean";
  if (schemaType === "enum") return "select";
  if (schemaType === "string") return setting.isCredential ? "secret" : ui.options ? "select" : "text";
  if (schemaType === "number") return ui.options ? "select" : null;
  if (schemaType === "array") return ui.options ? "multiselect" : null;
  if (schemaType === "record") return setting.id === "providers.maxInFlightRequests" ? "providerLimits" : "text";
  return null;
}

function serializableValue(value: unknown): SettingsValue {
  if (value === undefined) return null;
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
    || typeof value === "number"
    || Array.isArray(value)
  ) return value as SettingsValue;
  return value as Record<string, number>;
}

function validateSettingValue(setting: AnySetting, value: unknown): SettingsValue {
  const schemaType = setting.type;
  const ui = setting.ui;
  if (!ui) throw new Error("Setting is not exposed by /settings");

  if (schemaType === "boolean") {
    if (typeof value !== "boolean") throw new Error("Expected a boolean");
    return value;
  }
  if (schemaType === "string") {
    if (typeof value !== "string") throw new Error("Expected text");
    const allowed = optionsFor(setting, []);
    if (ui.options !== "runtime" && allowed?.length && !allowed.some((option) => option.value === value)) {
      throw new Error("Invalid option");
    }
    return value;
  }
  if (schemaType === "enum") {
    if (typeof value !== "string" || !setting.enumValues?.includes(value)) throw new Error("Invalid option");
    return value;
  }
  if (schemaType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a finite number");
    const allowed = Array.isArray(ui.options) ? ui.options.map((option) => Number(option.value)) : [];
    if (allowed.length && !allowed.includes(value)) throw new Error("Invalid option");
    return value;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Expected a string list");
    const allowed = Array.isArray(ui.options) ? new Set(ui.options.map((option) => option.value)) : null;
    if (!allowed || value.some((item) => !allowed.has(item))) throw new Error("Invalid list option");
    return [...new Set(value)] as string[];
  }
  if (schemaType === "record" && setting.id === "providers.maxInFlightRequests") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected provider limits");
    const result: Record<string, number> = {};
    for (const [provider, limit] of Object.entries(value)) {
      if (!provider.trim() || typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
        throw new Error("Provider limits must be positive numbers");
      }
      result[provider.trim()] = Math.floor(limit);
    }
    return result;
  }
  throw new Error("Unsupported setting type");
}

export async function GET(req: Request) {
  try {
    const cwd = await validateCwd(new URL(req.url).searchParams.get("cwd"));
    const settings = await getSettingsForCwd(cwd);
    const [availableThemes, theme] = await Promise.all([
      getAvailableWebThemes(),
      getWebThemeConfig(settings),
    ]);
    const themeNames = availableThemes.map(({ name }) => name);
    const fields: SettingsField[] = [];

    for (const tab of SETTING_TABS) {
      for (const setting of orderedSettings()) {
        const ui = setting.ui;
        if (ui?.tab !== tab) continue;
        const fieldType = fieldTypeFor(setting);
        if (!fieldType) continue;
        const secret = setting.isCredential;
        fields.push({
          path: setting.id,
          tab,
          group: ui.group,
          label: ui.label,
          description: ui.description,
          type: fieldType,
          value: secret ? null : serializableValue(setting.layered(settings)),
          defaultValue: secret ? null : serializableValue(setting.default),
          configured: settings.isConfigured(setting),
          options: optionsFor(setting, themeNames),
          ordered: ui.ordered === true,
          condition: ui.condition,
        });
      }
    }

    const response: SettingsResponse = {
      tabs: SETTING_TABS.map((id) => ({ id, label: TAB_METADATA[id].label, groups: [...TAB_GROUPS[id]] })),
      fields,
      availableThemes,
      theme,
    };
    return NextResponse.json(translateSettingsResponseToKorean(response));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { path?: string; value?: unknown };
    const setting = body.path ? lookup(body.path) : undefined;
    if (!setting?.ui) {
      return NextResponse.json({ error: "Unknown setting" }, { status: 400 });
    }
    const path = setting.id;
    const value = validateSettingValue(setting, body.value);
    if (
      (path === "theme.dark" || path === "theme.light")
      && (typeof value !== "string" || !(await getAvailableWebThemes()).some(({ name }) => name === value))
    ) {
      throw new Error("Unknown omp theme");
    }
    const { settings } = await getOmpRuntime();
    setting.set(settings, value);
    await settings.flush();
    return NextResponse.json({ success: true, value: serializableValue(setting.layered(settings)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
