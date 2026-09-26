import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { translateSettingsResponseToKorean } = await jiti.import("./settings.ts");

test("설정 메타데이터 변환은 값·동적 식별자·테마를 보존한다", () => {
  const response = {
    tabs: [{ id: "appearance", label: "Appearance", groups: ["Theme", "Custom group"] }],
    fields: [
      {
        path: "theme.dark",
        tab: "appearance",
        group: "Theme",
        label: "Dark theme",
        description: "Theme used when the terminal has a dark background",
        type: "select",
        value: "custom-dark",
        defaultValue: "dark",
        configured: true,
        options: [{ value: "custom-provider/model-x", label: "custom-provider/model-x" }],
      },
      {
        path: "dynamic.model",
        tab: "model",
        group: "Custom group",
        label: "custom-provider/model-y",
        description: "User supplied model",
        type: "text",
        value: "custom-provider/model-y",
        defaultValue: null,
        configured: true,
      },
    ],
    availableThemes: [{ name: "custom-dark", colorScheme: "dark" }],
    theme: {
      names: { dark: "custom-dark", light: "custom-light" },
      palettes: {
        dark: { name: "custom-dark", colorScheme: "dark", variables: { "--bg": "#000" } },
        light: { name: "custom-light", colorScheme: "light", variables: { "--bg": "#fff" } },
      },
    },
  };
  const original = structuredClone(response);

  const translated = translateSettingsResponseToKorean(response);

  assert.equal(translated, response);
  assert.deepEqual(translated.fields[0].options, [{ value: "custom-provider/model-x", label: "custom-provider/model-x" }]);
  assert.equal(translated.fields[0].path, original.fields[0].path);
  assert.equal(translated.fields[0].value, original.fields[0].value);
  assert.equal(translated.fields[1].label, "custom-provider/model-y");
  assert.equal(translated.fields[1].description, "User supplied model");
  assert.equal(translated.fields[1].value, "custom-provider/model-y");
  assert.deepEqual(translated.availableThemes, original.availableThemes);
  assert.deepEqual(translated.theme, original.theme);
});
