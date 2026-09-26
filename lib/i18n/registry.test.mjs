import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getLocalePlugin,
  getSupportedLocales,
  isLocale,
  registerLocale,
  resolveBrowserLocale,
  resolveLocalePreference,
} = await jiti.import("./registry.ts");

test("uses the first supported browser language and defaults to Korean", () => {
  assert.equal(resolveBrowserLocale(["ko-KR", "en-US"]), "ko");
  assert.equal(resolveBrowserLocale(["zh-CN", "ko-KR"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["en-US", "ko-KR"]), "en");
  assert.equal(resolveBrowserLocale(["fr-FR", "zh-CN"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["fr-FR"]), "ko");
  assert.equal(resolveBrowserLocale([]), "ko");
});

test("returns only registered locales", () => {
  assert.deepEqual(getSupportedLocales(), ["en", "zh-CN", "ko"]);
  assert.equal(getLocalePlugin("en").id, "en");
  assert.equal(getLocalePlugin("ko").label, "한국어");
  assert.equal(getLocalePlugin("missing"), undefined);
});

test("validates and restores only explicit built-in locale preferences", () => {
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("zh-CN"), true);
  assert.equal(isLocale("ko"), true);
  assert.equal(isLocale("ko-KR"), false);
  assert.equal(isLocale("test"), false);
  assert.equal(resolveLocalePreference("en", ["ko-KR"]), "en");
  assert.equal(resolveLocalePreference("zh-CN", ["ko-KR"]), "zh-CN");
  assert.equal(resolveLocalePreference("ko", ["en-US"]), "ko");
  assert.equal(resolveLocalePreference("invalid", ["en-US"]), "en");
  assert.equal(resolveLocalePreference(null, ["fr-FR"]), "ko");
});

test("ships complete built-in dictionaries", () => {
  const english = getLocalePlugin("en").messages;
  const chinese = getLocalePlugin("zh-CN").messages;
  const korean = getLocalePlugin("ko").messages;
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
  assert.deepEqual(Object.keys(korean).sort(), Object.keys(english).sort());
});

test("allows a new locale plugin and rejects duplicate ids", () => {
  registerLocale({ id: "test", label: "Test", messages: { "common.ok": "OK" } });
  assert.equal(getLocalePlugin("test")?.label, "Test");
  assert.throws(() => registerLocale({ id: "test", label: "Again", messages: {} }));
});
