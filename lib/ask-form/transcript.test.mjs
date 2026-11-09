import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { summarizeAskCall } = await jiti.import("./transcript.ts");

const HTML = `<form><p>Which <b>database</b> &amp; why?</p><input name="db"></form>`;

test("a new-style ask call reads as questions with their answers", () => {
  const summary = summarizeAskCall("ask", { html: HTML }, {
    answers: [
      { name: "db", question: "Which database?", answer: "SQLite" },
      { name: "n", question: "Replicas", answer: "3" },
    ],
    timedOut: true,
  });
  assert.deepEqual(summary, {
    target: "Which database? (+1)",
    rows: [
      { question: "Which database?", answer: "SQLite" },
      { question: "Replicas", answer: "3" },
    ],
    timedOut: true,
  });
});

test("before the answers arrive the row shows the form's own text", () => {
  assert.deepEqual(summarizeAskCall("ask", { html: HTML }, undefined), {
    target: "Which database & why?",
    rows: [],
    timedOut: false,
  });
});

test("calls recorded with the old questions[] ask, and other tools, are left to the generic card", () => {
  const old = { questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }] };
  assert.equal(summarizeAskCall("ask", old, { results: [] }), null);
  assert.equal(summarizeAskCall("read", { html: HTML }, undefined), null);
  assert.equal(summarizeAskCall("ask", {}, null), null);
});

test("malformed answers are skipped instead of breaking the row", () => {
  const summary = summarizeAskCall("ask", { html: HTML }, { answers: [null, { question: 3 }, { question: "Q", answer: "A" }, "x"] });
  assert.deepEqual(summary.rows, [{ question: "Q", answer: "A" }]);
});
