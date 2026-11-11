import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSavedPrompts, createSavedPrompt, deleteSavedPrompt, MAX_SAVED_PROMPT_BYTES } from "./saved-prompts-store.ts";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "cuelo-saved-prompts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, "cuelo-saved-prompts.json") };
}

test("creates and lists private persisted prompts, deleting only the requested entry", (t) => {
  const { dir, file } = fixture(t);
  assert.deepEqual(listSavedPrompts(dir), []);
  const one = createSavedPrompt({ body: "  First line\n{{project_name}}" }, dir);
  const two = createSavedPrompt({ title: "Custom", body: "second body" }, dir);
  assert.equal(one.title, "First line");
  assert.equal(one.body, "  First line\n{{project_name}}");
  assert.notEqual(one.id, two.id);
  assert.equal(one.createdAt, one.updatedAt);
  assert.ok(Number.isFinite(Date.parse(one.createdAt)));
  assert.deepEqual(listSavedPrompts(dir), [one, two]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(deleteSavedPrompt(one.id, dir), true);
  assert.equal(deleteSavedPrompt(one.id, dir), false);
  assert.deepEqual(listSavedPrompts(dir), [two]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("rejects blank and oversized UTF-8 bodies without changing existing data", (t) => {
  const { dir, file } = fixture(t);
  createSavedPrompt({ body: "x".repeat(MAX_SAVED_PROMPT_BYTES) }, dir);
  const before = readFileSync(file);
  for (const body of [" \n", "x".repeat(MAX_SAVED_PROMPT_BYTES + 1), "가".repeat(7000)]) {
    assert.throws(() => createSavedPrompt({ body }, dir), /required|20 KB/);
    assert.deepEqual(readFileSync(file), before);
  }
});

test("corrupt and unsupported stores refuse list, save and delete without overwriting", (t) => {
  const { dir, file } = fixture(t);
  for (const raw of ["{invalid", '{"version":2,"prompts":[]}', '{"version":1,"prompts":[{"id":"bad"}]}']) {
    writeFileSync(file, raw);
    assert.throws(() => listSavedPrompts(dir), /corrupt|unsupported/);
    assert.throws(() => createSavedPrompt({ body: "new" }, dir), /corrupt|unsupported/);
    assert.throws(() => deleteSavedPrompt("bad", dir), /corrupt|unsupported/);
    assert.equal(readFileSync(file, "utf8"), raw);
  }
});
