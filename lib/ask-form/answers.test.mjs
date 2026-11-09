import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const answers = await jiti.import("./answers.ts");
const server = await jiti.import("./server.ts");
const core = await import("@oh-my-pi/pi-tui/html-form/data");
const { parseHtmlForm } = await import("@oh-my-pi/pi-tui/html-form/parse");

const FORM = `<form>
<fieldset><legend>Setup</legend>
<p>Which database?</p>
<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
<label><input type="radio" name="db" value="pg"> Postgres</label>
<label><input type="radio" name="db" value="old" disabled> Legacy</label>
<p>Targets</p>
<label><input type="checkbox" name="targets" value="linux" checked> Linux</label>
<label><input type="checkbox" name="targets" value="windows"> Windows</label>
<label>Region <select name="region" required><option value="eu">EU</option><option value="us" selected>US</option></select></label>
<label>Replicas <input type="number" name="replicas" min="1" max="9" value="3" required></label>
<label>Notes <textarea name="notes" rows="4" maxlength="12">hi</textarea></label>
<label><input type="checkbox" name="agree" value="yes"> I agree</label>
<input type="hidden" name="ticket" value="T-1">
</fieldset></form>`;

async function modelOf(html) {
  return (await server.prepareAskForm(html, { cwd: process.cwd() })).model;
}

test("defaults match the core's defaultFormData for preselected radio, checkbox, select, number and text", async () => {
  const model = await modelOf(FORM);
  const expected = core.defaultFormData(parseHtmlForm(FORM));
  assert.deepEqual(answers.defaultFormData(model), expected);
  assert.deepEqual(expected, {
    ticket: "T-1",
    db: "sqlite",
    targets: ["linux"],
    region: "us",
    replicas: 3,
    notes: "hi",
  });
});

test("each control reports the value shape the core defines", async () => {
  const model = await modelOf(FORM);
  const states = answers.initialFormState(model);
  const byName = (name) => model.fields.findIndex((field) => field.name === name);

  // radio: one string; the typed Other text replaces the picked option
  states[byName("db")] = { kind: "choice", checked: [1], otherOn: false, other: "ignored" };
  // checkbox group: array of the checked values, Other text appended
  states[byName("targets")] = { kind: "choice", checked: [0, 1], otherOn: true, other: " macOS " };
  // lone checkbox: its value when checked, nothing when not
  states[byName("agree")] = { kind: "choice", checked: [0], otherOn: false, other: "" };
  // single select: the chosen option's value
  states[byName("region")] = { kind: "choice", checked: [0], otherOn: false, other: "" };
  // number input: a number, not a string
  states[byName("replicas")] = { kind: "text", text: "7" };
  states[byName("notes")] = { kind: "text", text: "multi\nline" };

  const data = answers.formDataFromState(model, states);
  assert.deepEqual(data, {
    ticket: "T-1",
    db: "pg",
    targets: ["linux", "windows", "macOS"],
    region: "eu",
    replicas: 7,
    notes: "multi\nline",
    agree: "yes",
  });

  states[byName("db")] = { kind: "choice", checked: [0], otherOn: true, other: "MariaDB" };
  assert.equal(answers.formDataFromState(model, states).db, "MariaDB");
  states[byName("db")] = { kind: "choice", checked: [0], otherOn: true, other: "   " };
  assert.equal(answers.formDataFromState(model, states).db, "sqlite", "blank Other counts as no answer");
  states[byName("agree")] = { kind: "choice", checked: [], otherOn: false, other: "" };
  assert.equal("agree" in answers.formDataFromState(model, states), false);
});

test("a disabled option never contributes a value", async () => {
  const model = await modelOf(FORM);
  const field = model.fields.find((candidate) => candidate.name === "db");
  assert.equal(answers.choiceValue(field, new Set([2])), undefined);
});

// Cases the browser check and the core's check must agree on, including the message text.
const FIELD_CASES = [
  `<input name="a" required>`,
  `<input name="a" type="number" min="2" max="5">`,
  `<input name="a" type="number">`,
  `<input name="a" minlength="3" maxlength="5">`,
  `<input name="a" type="email">`,
  `<input name="a" type="url">`,
  `<input name="a" pattern="[a-c]+">`,
  `<input name="a" pattern="(">`,
  `<select name="a" required><option value="x">X</option></select>`,
  `<label><input type="checkbox" name="a" value="x" required> X</label><label><input type="checkbox" name="a" value="y"> Y</label>`,
  `<label><input type="radio" name="a" value="x" required> X</label><label><input type="radio" name="a" value="y"> Y</label>`,
];
const VALUES = [undefined, "", "  ", "x", "ab", "abcdefg", "abc", "1", "5", "6", "-1", "NaN", "a@b", "a@b.c", "https://x.test", "nope", ["x"], []];

test("fieldError agrees with the core's fieldError for every case and value", () => {
  for (const control of FIELD_CASES) {
    const form = parseHtmlForm(`<form>${control}</form>`);
    const field = form.fields[0];
    for (const value of VALUES) {
      const mine = answers.fieldError(field, value);
      const theirs = core.fieldError(field, value);
      assert.equal(
        mine === undefined ? undefined : answers.describeFieldErrorEnglish(mine),
        theirs,
        `${control} with ${JSON.stringify(value)}`,
      );
    }
  }
});

test("textValue and choiceValue agree with the core", () => {
  const form = parseHtmlForm(FORM);
  for (const field of form.fields) {
    if (field.kind === "text") {
      for (const text of ["", "3", " 4 ", "x", "1e3"]) {
        assert.deepEqual(answers.textValue(field, text), core.textValue(field, text));
      }
    } else {
      const options = field.options.map((_, index) => index);
      for (const checked of [[], [0], [1], options]) {
        for (const other of [undefined, "", " x "]) {
          assert.deepEqual(
            answers.choiceValue(field, new Set(checked), other),
            core.choiceValue(field, new Set(checked), other),
          );
        }
      }
    }
  }
});

test("first question comes from the label, the text before the field, the section title, then the name", async () => {
  assert.equal(answers.firstAskFormQuestion(await modelOf(FORM)), "Which database?");
  assert.equal(answers.firstAskFormQuestion(await modelOf(`<form><label>Name <input name="n"></label></form>`)), "Name");
  assert.equal(
    answers.firstAskFormQuestion(await modelOf(`<form><fieldset><legend>Who</legend><label><input type="radio" name="n" value="a"> A</label><label><input type="radio" name="n" value="b"> B</label></fieldset></form>`)),
    "Who",
  );
  assert.equal(answers.firstAskFormQuestion(await modelOf(`<form><input name="n"></form>`)), "n");
});

test("picking, Other and typing move a radio group, a checkbox group and a select the way the card shows them", async () => {
  const model = await modelOf(FORM);
  const field = (name) => model.fields.find((candidate) => candidate.name === name);
  const initial = (name) => answers.initialFieldState(field(name));
  const value = (name, state) => answers.fieldValue(field(name), state);

  // radio: Other takes over from the option, typing selects it, picking an option drops it again
  let db = answers.toggleOther(field("db"), initial("db"));
  assert.equal(value("db", db), undefined, "Other selected with no text is no answer");
  db = answers.typeOther(field("db"), db, "MariaDB");
  assert.equal(value("db", db), "MariaDB");
  db = answers.pickOption(field("db"), db, 1);
  assert.equal(value("db", db), "pg");
  db = answers.typeOther(field("db"), db, "Redis");
  assert.deepEqual([db.checked, db.otherOn, value("db", db)], [[], true, "Redis"]);

  // checkbox group: options toggle, Other stays alongside them
  let targets = answers.pickOption(field("targets"), initial("targets"), 1);
  assert.deepEqual(value("targets", targets), ["linux", "windows"]);
  targets = answers.pickOption(field("targets"), targets, 0);
  assert.deepEqual(value("targets", targets), ["windows"]);
  targets = answers.typeOther(field("targets"), targets, "macOS");
  assert.deepEqual(value("targets", targets), ["windows", "macOS"]);
  targets = answers.toggleOther(field("targets"), targets);
  assert.deepEqual(value("targets", targets), ["windows"], "unticking Other hides its text");

  // select: choosing an option replaces the selection
  const region = answers.pickOption(field("region"), initial("region"), 0);
  assert.equal(value("region", region), "eu");
});

test("required fields fail until answered, and every error points at its field", async () => {
  const model = await modelOf(FORM);
  const states = answers.initialFormState(model);
  const replicas = model.fields.findIndex((field) => field.name === "replicas");
  states[replicas] = { kind: "text", text: "" };
  const errors = answers.formErrors(model, answers.formDataFromState(model, states));
  assert.deepEqual(errors, { replicas: { code: "required" } });
  assert.equal(answers.firstErrorIndex(model, errors), replicas);
  states[replicas] = { kind: "text", text: "10" };
  assert.deepEqual(answers.formErrors(model, answers.formDataFromState(model, states)), { replicas: { code: "max", value: 9 } });
});

test("browser-side validation treats names like constructor and __proto__ as ordinary required fields", async () => {
  const model = await modelOf(`<form><label>A <input name="constructor" required></label><label>B <input name="__proto__" required></label></form>`);
  const empty = answers.formDataFromState(model, answers.initialFormState(model));
  const errors = answers.formErrors(model, empty);
  assert.deepEqual(Object.keys(errors).sort(), ["__proto__", "constructor"]);
  assert.equal(answers.firstErrorIndex(model, errors), 0);
  const filled = answers.formDataFromState(model, [{ kind: "text", text: "x" }, { kind: "text", text: "y" }]);
  assert.equal(Object.getOwnPropertyDescriptor(filled, "__proto__").value, "y");
  assert.deepEqual(answers.formErrors(model, filled), {});
});
