import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const server = await jiti.import("./server.ts");

// 1x1 transparent PNG
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const FORM = `<form>
<p>Which database?</p>
<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
<label><input type="radio" name="db" value="pg"> Postgres</label>
<label><input type="checkbox" name="targets" value="linux"> Linux</label>
<label><input type="checkbox" name="targets" value="windows"> Windows</label>
<label>Replicas <input type="number" name="replicas" min="1" max="9" value="3" required></label>
<label>Region <select name="region"><option value="eu">EU</option><option value="us">US</option></select></label>
<input type="hidden" name="ticket" value="T-1">
<input value="nameless">
</form>`;

test("the model carries named fields only, with hidden pairs and no markup", async () => {
  const { model } = await server.prepareAskForm(`<script>alert(1)</script>${FORM}`, { cwd: process.cwd() });
  assert.deepEqual(model.hidden, [["ticket", "T-1"]]);
  assert.deepEqual(model.fields.map((field) => field.name), ["db", "targets", "replicas", "region"]);
  const json = JSON.stringify(model);
  assert.equal(json.includes("<script"), false);
  const blocks = model.sections.flatMap((section) => section.blocks);
  assert.deepEqual(blocks.filter((block) => block.kind === "field").map((block) => block.index), [0, 1, 2, 3]);
});

test("pictures become data URIs; unreadable or oversize ones become null", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ask-form-"));
  try {
    writeFileSync(join(cwd, "dot.png"), Buffer.from(PNG_BASE64, "base64"));
    writeFileSync(join(cwd, "notes.txt"), "not an image");
    const html = `<form>
      <img src="dot.png" alt="local">
      <img src="data:image/png;base64,${PNG_BASE64}" alt="inline">
      <img src="missing.png" alt="gone">
      <img src="notes.txt" alt="text file">
      <svg viewBox="0 0 10 20" aria-label="drawing"><circle cx="5" cy="5" r="4"/></svg>
      <input name="a">
    </form>`;
    const { model } = await server.prepareAskForm(html, { cwd });
    const pictures = model.sections.flatMap((section) => section.blocks).filter((block) => block.kind === "image");
    assert.deepEqual(pictures.map((picture) => picture.alt), ["local", "inline", "gone", "text file", "drawing"]);
    assert.match(pictures[0].src, /^data:image\/png;base64,/);
    assert.equal(pictures[0].src, pictures[1].src);
    assert.equal(pictures[2].src, null);
    assert.equal(pictures[3].src, null);
    assert.match(pictures[4].src, /^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(pictures[4].src.split(",")[1], "base64").toString();
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /width="10" height="20"/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a valid submission passes with hidden pairs taken from the form, and unknown keys are dropped", async () => {
  const prepared = await server.prepareAskForm(FORM, { cwd: process.cwd() });
  const result = server.validateAskFormSubmission(prepared, {
    db: "pg",
    targets: ["linux", "macOS"],
    replicas: 5,
    region: "us",
    ticket: "forged",
    extra: "dropped",
  });
  assert.deepEqual(result, {
    data: { ticket: "T-1", db: "pg", targets: ["linux", "macOS"], replicas: 5, region: "us" },
  });
});

test("answers that break the form's rules are rejected with the field named", async () => {
  const prepared = await server.prepareAskForm(FORM, { cwd: process.cwd() });
  const base = { db: "sqlite", targets: [], replicas: 3, region: "eu" };
  const cases = [
    [{ ...base, replicas: "" }, /replicas: Required/],
    [{ ...base, replicas: 12 }, /replicas: Must be at most 9/],
    [{ ...base, replicas: "abc" }, /replicas: Enter a number/],
    [{ ...base, region: "mars" }, /region: wrong value/],
    [{ ...base, targets: "linux" }, /targets: wrong value/],
    [{ ...base, targets: [1] }, /targets: wrong value/],
    [{ ...base, db: ["pg"] }, /db: wrong value/],
    [{ ...base, replicas: { n: 1 } }, /replicas: wrong value/],
    [null, /not an object/],
    [[], /not an object/],
  ];
  for (const [raw, pattern] of cases) {
    const result = server.validateAskFormSubmission(prepared, raw);
    assert.match(result.error ?? "", pattern, JSON.stringify(raw));
  }
});

test("free Other text is accepted only where the form offers Other, and disabled options never", async () => {
  const prepared = await server.prepareAskForm(
    `<form><label><input type="radio" name="a" value="x" disabled> X</label><label><input type="radio" name="a" value="y"> Y</label>
     <label>Pick <select name="s"><option value="p">P</option><option value="q">Q</option></select></label></form>`,
    { cwd: process.cwd() },
  );
  assert.deepEqual(server.validateAskFormSubmission(prepared, { a: "something else", s: "p" }), { data: { a: "something else", s: "p" } });
  assert.match(server.validateAskFormSubmission(prepared, { a: "x", s: "p" }).data?.a ?? "x", /x/, "disabled value only passes as free text");
  assert.match(server.validateAskFormSubmission(prepared, { a: "y", s: "free text" }).error, /s: wrong value/);
});

test("the timed-out values are the latest valid snapshot, else the defaults", async () => {
  const prepared = await server.prepareAskForm(FORM, { cwd: process.cwd() });
  const defaults = { ticket: "T-1", db: "sqlite", replicas: 3, region: "eu" };
  assert.deepEqual(server.defaultAskFormData(prepared), { ...defaults, targets: [] });
  const snapshot = { db: "pg", targets: ["windows"], replicas: 4, region: "us" };
  assert.deepEqual(server.timedOutAskFormData(prepared, snapshot), { ticket: "T-1", ...snapshot });
  assert.deepEqual(server.timedOutAskFormData(prepared, { ...snapshot, replicas: 99 }), { ...defaults, targets: [] });
  assert.deepEqual(server.timedOutAskFormData(prepared, undefined), { ...defaults, targets: [] });
});

test("snapshot payloads that are not JSON or too large are ignored", () => {
  assert.equal(server.parseAskFormSnapshot("{nope"), undefined);
  assert.equal(server.parseAskFormSnapshot("x".repeat(600 * 1024)), undefined);
  assert.deepEqual(server.parseAskFormSnapshot('{"a":1}'), { a: 1 });
});

test("field names that are also object keys are ordinary answers, never lost or inherited", async () => {
  const prepared = await server.prepareAskForm(
    `<form><label>A <input name="__proto__" required></label><label>B <input name="constructor" required></label></form>`,
    { cwd: process.cwd() },
  );
  const ok = server.validateAskFormSubmission(prepared, JSON.parse('{"__proto__":"Alice","constructor":"Bob"}'));
  assert.equal(Object.hasOwn(ok.data, "__proto__"), true);
  assert.equal(Object.getOwnPropertyDescriptor(ok.data, "__proto__").value, "Alice");
  assert.equal(ok.data.constructor, "Bob");
  // a missing required answer is not satisfied by the inherited Object.prototype.constructor
  assert.match(server.validateAskFormSubmission(prepared, JSON.parse('{"__proto__":"Alice"}')).error, /constructor: Required/);
});
