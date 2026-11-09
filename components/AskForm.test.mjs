import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { AskForm } = await jiti.import("./AskForm.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { prepareAskForm } = await jiti.import("../lib/ask-form/server.ts");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const HTML = `<form>
<p>Review the plan &lt;script&gt;alert(1)&lt;/script&gt;</p>
<fieldset><legend>Setup</legend>
<p>Which database?</p>
<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
<label><input type="radio" name="db" value="pg"> Postgres</label>
<label><input type="radio" name="db" value="old" disabled> Legacy</label>
<p>Targets</p>
<label><input type="checkbox" name="targets" value="linux" checked> Linux</label>
<label><input type="checkbox" name="targets" value="windows"> Windows</label>
<label>Region <select name="region"><option value="eu">EU</option><option value="us" selected>US</option></select></label>
<label>Replicas <input type="number" name="replicas" min="1" max="9" value="3" required></label>
<label>Notes <textarea name="notes" rows="4" placeholder="Anything else">hi</textarea></label>
</fieldset>
<table><tr><th>Host</th><th>Load</th></tr><tr><td>a</td><td>12</td></tr></table>
<pre>line 1
line 2</pre>
<img src="${PNG}" alt="diagram">
<img src="missing.png" alt="lost picture">
</form>`;

/** The <label> element whose visible text is `text`, so a check reads that one row rather than the whole card. */
function rowOf(html, text) {
  return html.split("<label").find((chunk) => chunk.includes(`<span>${text}</span>`) || chunk.includes(`>${text}</span>`));
}

async function render(html, extra = {}) {
  const prepared = await prepareAskForm(html, { cwd: process.cwd() });
  const request = { type: "extension_ui_request", id: "form-1", method: "form", form: prepared.model, ...extra };
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AskForm, { request, onRespond() {}, onActivity() {}, delivery: null }),
    ),
  );
}

test("the whole form is drawn at once with its preselected values as the initial state", async () => {
  const html = await render(HTML);
  assert.match(html, /Agent needs your input/);
  assert.match(html, /<h3[^>]*><span>Setup<\/span><\/h3>/);
  assert.match(html, /role="radiogroup"/);
  assert.match(rowOf(html, "SQLite"), /type="radio"[^>]*checked=""/);
  assert.doesNotMatch(rowOf(html, "Postgres"), /checked=""/);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 4, "three options plus Other");
  assert.match(rowOf(html, "Legacy"), /disabled=""/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3, "two options plus Other");
  assert.match(html, /<option value="1" selected="">US<\/option>/);
  assert.match(html, /type="number"[^>]*min="1"[^>]*max="9"|min="1"[^>]*max="9"[^>]*type="number"/);
  assert.match(html, /value="3"/);
  assert.match(html, /<textarea[^>]*rows="4"[^>]*>hi<\/textarea>/);
  assert.match(html, /placeholder="Anything else"/);
  assert.match(html, />Required</);
  assert.match(html, /Other/);
});

test("context blocks keep tables and code scrollable and pictures inside the card", async () => {
  const html = await render(HTML);
  assert.match(html, /overflow-x:auto[^"]*"[^>]*><table|tabindex="0"[^>]*style="[^"]*overflow-x:auto[^"]*"><table/);
  assert.match(html, /<th scope="col"[^>]*><span>Host<\/span><\/th>/);
  assert.match(html, /<pre[^>]*overflow-x:auto/);
  assert.match(html, /<img src="data:image\/png;base64,[^"]+" alt="diagram"[^>]*max-width:100%/);
  assert.match(html, /<p[^>]*>lost picture<\/p>/, "an unreadable picture shows its alt text");
  assert.equal(html.includes("missing.png"), false);
});

test("text the agent wrote is escaped, never injected as markup", async () => {
  const html = await render(HTML);
  assert.equal(html.includes("<script"), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("it is not a <form>, so Enter in a field cannot submit early", async () => {
  const html = await render(HTML);
  assert.equal(/<form[\s>]/.test(html), false);
  assert.match(html, /Cancel/);
  assert.match(html, /Submit answer/);
});

test("the auto-submit hint appears only when the request has a timeout", async () => {
  assert.equal((await render(HTML)).includes("currently in the form"), false);
  assert.match(await render(HTML, { timeout: 120_000, expiresAt: Date.now() + 120_000 }), /If you do not respond in 120s, the values currently in the form are submitted/);
});
