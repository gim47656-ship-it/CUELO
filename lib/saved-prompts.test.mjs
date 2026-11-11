import { test } from "node:test";
import assert from "node:assert/strict";
import { findSavedPromptToken, fillPromptTemplate, derivePromptTitle } from "./saved-prompts.ts";

test("finds only whitespace-bounded double-slash tokens before the caret", () => {
  assert.deepEqual(findSavedPromptToken("//", 2), { start: 0, end: 2, query: "" });
  assert.deepEqual(findSavedPromptToken("hello //Plan", 12), { start: 6, end: 12, query: "Plan" });
  assert.deepEqual(findSavedPromptToken("hello\n//Plan", 12), { start: 6, end: 12, query: "Plan" });
  for (const value of ["http://x", "a//b", "/", "//one two", "//one\n"]) {
    assert.equal(findSavedPromptToken(value, value.length), null, value);
  }
});

test("mid-token query ends at caret but replacement removes the entire token", () => {
  const value = "before //planning after";
  const token = findSavedPromptToken(value, 12);
  assert.deepEqual(token, { start: 7, end: 17, query: "pla" });
  assert.equal(value.slice(0, token.start) + "inserted" + value.slice(token.end), "before inserted after");
  assert.equal(value.slice(0, token.start) + value.slice(token.end), "before  after");
});

test("fills known variables once and preserves unknown or missing literals", () => {
  assert.equal(fillPromptTemplate("{{project_name}} {{ date }} {{unknown}} {{session_name}} {{cwd}}", {
    project_name: "repo", date: "2026-11-11", session_name: undefined, cwd: "",
  }), "repo 2026-11-11 {{unknown}} {{session_name}} {{cwd}}");
  assert.equal(fillPromptTemplate("{{session_name}} {{constructor}}", { session_name: "{{date}}", date: "today" }), "{{date}} {{constructor}}");
});

test("derives a trimmed first-line title capped at 60 characters", () => {
  assert.equal(derivePromptTitle("  Review this  \nbody"), "Review this");
  assert.equal(derivePromptTitle("😀".repeat(61)), "😀".repeat(60));
});
