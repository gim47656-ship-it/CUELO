import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  koreanSettingsMetadata,
  translateSettingsResponseToKorean,
} = await jiti.import("./settings.ts");

test("exposes the complete Korean settings metadata", () => {
  assert.equal(Object.keys(koreanSettingsMetadata.fields).length, 306);
  assert.equal(koreanSettingsMetadata.tabs.providers, "제공자");
  assert.equal(koreanSettingsMetadata.groups["Retry & Fallback"], "재시도 및 폴백");
  assert.equal(koreanSettingsMetadata.shell["Loading omp settings…"], "omp 설정을 불러오는 중…");
  assert.deepEqual(koreanSettingsMetadata.fields["searxng.endpoint"], {
    label: "SearXNG 엔드포인트",
    description: "웹 검색에 사용하는 자체 호스팅 SearXNG 인스턴스의 기본 URL이다",
  });
});

test("translates settings metadata without changing values or dynamic identifiers", () => {
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
  assert.deepEqual(translated.tabs, [{ id: "appearance", label: "외관", groups: ["테마", "Custom group"] }]);
  assert.equal(translated.fields[0].label, "다크 테마");
  assert.equal(translated.fields[0].description, "터미널 배경이 어두울 때 사용하는 테마이다");
  assert.equal(translated.fields[0].group, "테마");
  assert.deepEqual(translated.fields[0].options, [{ value: "custom-provider/model-x", label: "custom-provider/model-x" }]);
  assert.equal(translated.fields[0].path, original.fields[0].path);
  assert.equal(translated.fields[0].value, original.fields[0].value);
  assert.equal(translated.fields[1].label, "custom-provider/model-y");
  assert.equal(translated.fields[1].description, "User supplied model");
  assert.equal(translated.fields[1].value, "custom-provider/model-y");
  assert.deepEqual(translated.availableThemes, original.availableThemes);
  assert.deepEqual(translated.theme, original.theme);
});
