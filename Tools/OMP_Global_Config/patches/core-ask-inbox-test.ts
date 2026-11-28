// Run with OMP_CORE_PATCH_TARGET pointing at the isolated patched core.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required");
const src = resolve(target, "src");
const { AskTool } = await import(`${src}/tools/ask.ts`);
const { Settings } = await import(`${src}/config/settings.ts`);
const ask = new AskTool({ hasUI: false, settings: Settings.isolated({}) });
const html = '<form><label>Color?<input name="color"></label></form>';
const params = { html, background: true };
const unsupported = { hasUI: true, ui: { formDialog: () => assert.fail("must not block") }, abort: () => assert.fail("must not abort") };
await assert.rejects(ask.execute("id", params, undefined, undefined, unsupported), /no question inbox/);
type Format = Parameters<NonNullable<ExtensionUIContext["postInboxForm"]>>[2];
let format: Format | undefined;
const context = { ...unsupported, ui: { ...unsupported.ui, postInboxForm: async (s: string, id: string, callback: Format) => {
  assert.equal(s, html); assert.equal(id, "id"); format = callback;
} } };
await assert.rejects(ask.execute("id", { ...params, autoSelectRecommended: true }, undefined, undefined, context), /explicit answer/);
const result = await ask.execute("id", params, undefined, () => assert.fail("background is not waiting for user"), context);
assert.match(result.content[0].text, /pending \(id\)/);
assert.ok(format);
const image = { type: "image" as const, data: "AQID", mimeType: "image/png" };
const content = await format({ data: { color: "blue" }, notes: [{ name: "color", question: "Color?", option: "blue", value: "blue", text: "sample swatch [Image #1]", images: [image] }] });
assert.ok(content[0].type === "text");
assert.match(content[0].text, /blue/); assert.match(content[0].text, /sample swatch/); assert.deepEqual(content.at(-1), image);
console.log("Inbox: pending before answer, no blocking fallback, no timeout, note and image retained.");
