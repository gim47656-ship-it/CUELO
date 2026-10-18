import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { askSubmissionValue, canSubmitAskAnswers, chooseAskOption, initialAskAnswers, typeAskAnswer } =
  await jiti.import("./ChatWindow.tsx");

const single = {
  id: "db",
  question: "Database?",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
  recommended: 0,
};
const multi = {
  id: "targets",
  question: "Targets?",
  options: [{ label: "Linux" }, { label: "Windows" }],
  multi: true,
};

function submitted(questions, answers) {
  return JSON.parse(askSubmissionValue(questions, answers)).results;
}

test("a typed answer on a single-choice question replaces the recommended pick", () => {
  const answers = typeAskAnswer(initialAskAnswers([single]), single, "  MariaDB ");

  assert.deepEqual(answers.selected.db, []);
  assert.equal(canSubmitAskAnswers([single], answers), true);
  const [result] = submitted([single], answers);
  assert.deepEqual(result.selectedOptions, []);
  assert.equal(result.customInput, "MariaDB");
});

test("picking an option on a single-choice question drops the typed answer", () => {
  const typed = typeAskAnswer(initialAskAnswers([single]), single, "MariaDB");
  const answers = chooseAskOption(typed, single, 1);

  const [result] = submitted([single], answers);
  assert.deepEqual(result.selectedOptions, ["Postgres"]);
  assert.equal("customInput" in result, false);
});

test("whitespace alone keeps the recommended pick", () => {
  const answers = typeAskAnswer(initialAskAnswers([single]), single, "   ");

  const [result] = submitted([single], answers);
  assert.deepEqual(result.selectedOptions, ["SQLite"]);
  assert.equal("customInput" in result, false);
});

test("a multi-choice question keeps checked options and the typed answer together", () => {
  let answers = initialAskAnswers([multi]);
  answers = chooseAskOption(answers, multi, 0);
  answers = chooseAskOption(answers, multi, 1);
  answers = typeAskAnswer(answers, multi, "macOS");
  answers = chooseAskOption(answers, multi, 0);

  const [result] = submitted([multi], answers);
  assert.deepEqual(result.selectedOptions, ["Windows"]);
  assert.equal(result.customInput, "macOS");
});

test("submission needs an answer for every question", () => {
  const answers = initialAskAnswers([single, multi]);
  assert.equal(canSubmitAskAnswers([single, multi], answers), false);
  assert.equal(canSubmitAskAnswers([single, multi], typeAskAnswer(answers, multi, "BSD")), true);
});
