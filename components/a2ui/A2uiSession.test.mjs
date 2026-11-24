import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("../MarkdownBody.tsx");
const { MessageView } = await jiti.import("../MessageView.tsx");
const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");
const render = (markdown) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MarkdownBody, null, markdown)));

const card = '```a2ui\n[{"version":"1.0","createSurface":{"surfaceId":"plan","catalogId":"cuelo"}}]\n```';
const action = '카드 동작: choose (plan)\n\n```a2ui-action\n{"version":"1.0","action":{"name":"choose","surfaceId":"plan","sourceComponentId":"b","timestamp":"t","context":{}}}\n```';

// Panes without a session store (the side chat) and server rendering must show
// the block as ordinary code, without loading the A2UI renderer.
test("an a2ui fence outside a chat session renders as a plain code block", () => {
  const html = render(`before\n\n${card}\n\nafter`);
  assert.match(html, /createSurface/);
  assert.match(html, /before/);
  assert.match(html, /after/);
  assert.doesNotMatch(html, /a2ui-answer/);
});

test("an a2ui-action message outside a chat session stays readable text", () => {
  const html = render(action);
  assert.match(html, /카드 동작: choose/);
  assert.match(html, /sourceComponentId/);
});

test("a user action message outside a chat session is shown as written, not as a chip", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MessageView, { message: { role: "user", content: action } })));
  assert.doesNotMatch(html, /a2ui-action-chip/);
  assert.match(html, /카드 동작: choose/);
  assert.match(html, /sourceComponentId/);
});
