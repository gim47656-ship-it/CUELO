import assert from "node:assert/strict";
import { test } from "bun:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  LAB_DRAFT_MAX_CHARS,
  createLabPanelHost,
  labLinesFor,
  splitLabWidgets,
} = await jiti.import("./plugin-lab-bridge.ts");

function makeHost({ lines = ["a"], sessionId = "s1", composerOpen = true } = {}) {
  const frame = { posted: [], postMessage(message, origin) { this.posted.push({ message, origin }); } };
  const composer = { inserted: [], sent: [], insertText(text) { this.inserted.push(text); }, send(text) { this.sent.push(text); } };
  const events = [];
  const host = createLabPanelHost({
    frame: () => frame,
    state: () => ({ sessionId, lines }),
    insertDraft: (text) => {
      if (!composerOpen) return false;
      composer.insertText(text);
      return true;
    },
    recordDraft: () => events.push("draft"),
  });
  return { host, frame, composer, events };
}

test("messages from a window other than the panel's own frame are ignored", () => {
  const { host, frame, composer, events } = makeHost();
  host.handleMessage({ source: {}, origin: "null", data: { type: "cuelo-lab:draft", text: "hi" } });
  host.handleMessage({ source: {}, origin: "null", data: { type: "cuelo-lab:ready" } });
  assert.deepEqual(composer.inserted, []);
  assert.deepEqual(events, []);
  assert.deepEqual(frame.posted, []);
});

test("a frame that is not sandboxed (real origin) is ignored", () => {
  const { host, frame, composer } = makeHost();
  host.handleMessage({ source: frame, origin: "http://127.0.0.1:30141", data: { type: "cuelo-lab:draft", text: "hi" } });
  assert.deepEqual(composer.inserted, []);
});

test("a draft goes into the input unsent and is recorded once", () => {
  const { host, frame, composer, events } = makeHost();
  host.handleMessage({ source: frame, origin: "null", data: { type: "cuelo-lab:draft", text: "새 요청" } });
  assert.deepEqual(composer.inserted, ["새 요청"]);
  assert.deepEqual(composer.sent, []);
  assert.deepEqual(events, ["draft"]);
});

test("a draft with no message box open is not counted", () => {
  const { host, frame, events } = makeHost({ composerOpen: false });
  host.handleMessage({ source: frame, origin: "null", data: { type: "cuelo-lab:draft", text: "hi" } });
  assert.deepEqual(events, []);
});

test("draft text over the cap never reaches the input in full", () => {
  const { host, frame, composer } = makeHost();
  host.handleMessage({ source: frame, origin: "null", data: { type: "cuelo-lab:draft", text: "x".repeat(LAB_DRAFT_MAX_CHARS + 50) } });
  assert.equal(composer.inserted.length, 1);
  assert.equal(composer.inserted[0].length, LAB_DRAFT_MAX_CHARS);
  // A surrogate pair straddling the cut is dropped whole.
  host.handleMessage({ source: frame, origin: "null", data: { type: "cuelo-lab:draft", text: `${"y".repeat(LAB_DRAFT_MAX_CHARS - 1)}😀` } });
  assert.equal(composer.inserted[1], "y".repeat(LAB_DRAFT_MAX_CHARS - 1));
});

test("malformed or blank messages are dropped", () => {
  const { host, frame, composer, events } = makeHost();
  for (const data of [
    null,
    "cuelo-lab:draft",
    ["cuelo-lab:draft"],
    { type: "cuelo-lab:draft" },
    { type: "cuelo-lab:draft", text: 3 },
    { type: "cuelo-lab:draft", text: "  " },
    { type: "cuelo-lab:draft", text: "hello", send: true },
    { type: "cuelo-lab:ready", extra: true },
    { type: "cuelo-lab:send", text: "x" },
  ]) {
    host.handleMessage({ source: frame, origin: "null", data });
  }
  assert.deepEqual(composer.inserted, []);
  assert.deepEqual(events, []);
  assert.deepEqual(frame.posted, []);
});

test("ready answers with the session's current lines", () => {
  const { host, frame } = makeHost({ lines: ["one", "two"], sessionId: "s9" });
  host.handleMessage({ source: frame, origin: "null", data: { type: "cuelo-lab:ready" } });
  assert.deepEqual(frame.posted, [{ message: { type: "cuelo-lab:state", sessionId: "s9", lines: ["one", "two"] }, origin: "*" }]);
});

test("lab widgets leave the text cards and route to their plugin only", () => {
  const widgets = [
    { key: "todo", lines: ["t"] },
    { key: "lab:demo", lines: ["d1"] },
    { key: "lab:demo-two", lines: ["x"] },
    { key: "lab:demo:status", lines: ["d2"] },
    { key: "lab:", lines: ["bad"] },
    { key: "labs", lines: ["l"] },
  ];
  const { regular, lab } = splitLabWidgets(widgets);
  assert.deepEqual(regular.map((w) => w.key), ["todo", "lab:", "labs"]);
  assert.deepEqual(lab.map((w) => w.key), ["lab:demo", "lab:demo-two", "lab:demo:status"]);
  assert.deepEqual(labLinesFor(lab, "demo"), ["d1", "d2"]);
  assert.deepEqual(labLinesFor(lab, "demo-two"), ["x"]);
});
