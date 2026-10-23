import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  buildElementLocatorText,
  findStartTagLine,
  HTML_PICK_EXIT_MESSAGE,
  HTML_PICK_MESSAGE,
  injectPickerScript,
  readPickMessage,
} = await jiti.import("./html-element-pick.ts");

const frame = { name: "preview frame window" };
const NONCE = "n-123";
const pick = (overrides = {}) => ({
  type: HTML_PICK_MESSAGE,
  nonce: NONCE,
  selector: "table > tbody > tr:nth-of-type(2) > td:nth-of-type(3)",
  tag: "td",
  id: "",
  classes: ["price"],
  text: "4,500원",
  startTag: '<td class="price">',
  rect: { x: 412.4, y: 188.6, w: 96.2, h: 31.5 },
  viewport: { w: 1024, h: 640 },
  ...overrides,
});

test("a pick from the preview frame with the current nonce is accepted", () => {
  const message = readPickMessage(frame, pick(), frame, NONCE);
  assert.equal(message?.kind, "pick");
  assert.equal(message.element.selector, "table > tbody > tr:nth-of-type(2) > td:nth-of-type(3)");
  assert.deepEqual(message.element.rect, { x: 412.4, y: 188.6, w: 96.2, h: 31.5 });
  assert.deepEqual(readPickMessage(frame, { type: HTML_PICK_EXIT_MESSAGE, nonce: NONCE }, frame, NONCE), { kind: "exit" });
});

test("another window, another nonce or a missing frame is ignored", () => {
  assert.equal(readPickMessage({ name: "parent" }, pick(), frame, NONCE), null);
  assert.equal(readPickMessage(frame, pick({ nonce: "guess" }), frame, NONCE), null);
  assert.equal(readPickMessage(frame, { type: HTML_PICK_EXIT_MESSAGE, nonce: "guess" }, frame, NONCE), null);
  assert.equal(readPickMessage(null, pick(), null, NONCE), null);
  assert.equal(readPickMessage(frame, pick({ nonce: "" }), frame, ""), null);
});

test("a wrongly shaped or over-long pick is ignored", () => {
  for (const bad of [
    { type: "other" },
    { selector: "" },
    { tag: "TD<script>" },
    { classes: "price" },
    { classes: [1] },
    { text: "가".repeat(161) },
    { startTag: "<".repeat(301) },
    { rect: { x: 1, y: 2, w: -1, h: 3 } },
    { rect: { x: 1, y: 2, w: Number.NaN, h: 3 } },
    { viewport: { w: 0, h: 640 } },
    { viewport: null },
  ]) {
    assert.equal(readPickMessage(frame, pick(bad), frame, NONCE), null, JSON.stringify(bad));
  }
  assert.equal(readPickMessage(frame, "cuelo-html-pick", frame, NONCE), null);
});

test("an opening tag found exactly once gives its line; none or several give null", () => {
  const content = '<html>\n<body>\n<h1 id="title">Menu</h1>\n<td class="price">\n<td class="price">\n<p>\n</body>\n</html>';
  assert.equal(findStartTagLine(content, '<h1 id="title">'), 3);
  assert.equal(findStartTagLine(content, "<html>"), 1);
  assert.equal(findStartTagLine(content, '<td class="price">'), null);
  assert.equal(findStartTagLine(content, "<section>"), null);
  assert.equal(findStartTagLine(content, ""), null);
});

const labels = {
  element: (selector) => `E ${selector}`,
  text: (text) => `T "${text}"`,
  position: ({ x, y, w, h, vw, vh }) => `P ${x},${y},${w},${h} @${vw}x${vh}`,
};

test("locator text puts the mention first, rounds the box and skips empty text", () => {
  const element = readPickMessage(frame, pick(), frame, NONCE).element;
  assert.equal(
    buildElementLocatorText("@out/index.html:12 ", element, labels),
    '@out/index.html:12\nE table > tbody > tr:nth-of-type(2) > td:nth-of-type(3)\nT "4,500원"\nP 412,189,96,32 @1024x640\n',
  );
  assert.equal(
    buildElementLocatorText("@out/index.html ", { ...element, text: "" }, labels),
    "@out/index.html\nE table > tbody > tr:nth-of-type(2) > td:nth-of-type(3)\nP 412,189,96,32 @1024x640\n",
  );
});

test("the picker script goes before the last </body>, or at the end without one", () => {
  const withBody = injectPickerScript("<body><p>a</p></BODY>\n", "n");
  assert.match(withBody, /^<body><p>a<\/p><script>[\s\S]*<\/script><\/BODY>\n$/);
  const bare = injectPickerScript("<p>a</p>", "n");
  assert.ok(bare.startsWith("<p>a</p><script>") && bare.endsWith("</script>"));
  // İ lowercases to two code units; the offset must still come from the original text.
  const dotted = injectPickerScript("<body>İ</body>", "n");
  assert.match(dotted, /^<body>İ<script>[\s\S]*<\/script><\/body>$/);
});
