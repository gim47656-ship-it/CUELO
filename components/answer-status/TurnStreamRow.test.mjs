import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TurnStreamRow, TurnSelectionContext } = await jiti.import("./TurnInspector.tsx");
const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");
const { summarizeRequest } = await jiti.import("../../lib/answer-status/turn-summary.ts");

const summary = {
  ...summarizeRequest([], new Map(), 0, 0),
  remaining: [{ phase: "검증", content: "화면 확인", status: "pending", blocker: null }],
  latest: true,
};

function render(shown) {
  const value = { selected: null, shown, select: () => {} };
  return renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(TurnSelectionContext.Provider, { value },
      createElement(TurnStreamRow, { summary, turnKey: 1 }))));
}

test("the stream shows one result row while 이번 턴 is on screen", () => {
  const html = render(true);
  assert.match(html, /class="turn-row"/);
  assert.doesNotMatch(html, /turn-inline/);
});

test("the stream shows the full turn card while 이번 턴 is not on screen", () => {
  const html = render(false);
  assert.match(html, /class="turn-inline"/);
  assert.match(html, /turn-metrics/);
  assert.match(html, /화면 확인/);
  assert.doesNotMatch(html, /class="turn-row"/);
});
