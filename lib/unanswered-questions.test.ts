import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHtmlForm } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { defaultFormData, formAnswers } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { archiveFormHtml, finishArchivedQuestion, updateUnansweredQuestions, type UnansweredQuestion } from "./unanswered-questions";

const form = `<form><img src="data:image/png;base64,AAAAAAAA"><svg><text>private-art</text></svg><input type=hidden name=token value=hidden-secret><fieldset><legend>Which sample?</legend><label><input type=radio name=choice value=private-id checked>North</label><label><input type=radio name=choice value=south>South</label></fieldset><label>Note<input type=password name=secret value=private-default></label></form>`;
test("archives only visible questions/options; a late reply starts blank and returns the option label", () => {
  const html = archiveFormHtml(parseHtmlForm(form));
  expect(html).not.toMatch(/data:|AAAA|private-|hidden-secret|<img|<svg|checked|password|token/);
  const stored = parseHtmlForm(html);
  const sensitive = archiveFormHtml(parseHtmlForm('<form><p>API_KEY=test-private-key</p><label>Name<input name=n></label></form>'));
  expect(sensitive).not.toContain("test-private-key");
  expect(stored.fields).toHaveLength(2);
  expect(defaultFormData(stored).q1).toBeUndefined();
  expect(formAnswers(stored, { q1: "1", q2: "later" })).toEqual([
    { name: "q1", question: "Which sample?", answer: "South" }, { name: "q2", question: "Note", answer: "later" },
  ]);
});

test("atomic private store prunes expired and excess rows and removes only the answered ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "cuelo-unanswered-"));
  const file = join(dir, "cuelo-unanswered-questions.json");
  try {
    const now = Date.now();
    const q = (id: string): UnansweredQuestion => ({ id, sessionId: "original", cwd: dir, createdAt: now, toolCallId: id, reason: "restart", html: "<form>text</form>" });
    const add = Array.from({ length: 202 }, (_, i) => q(String(i)));
    updateUnansweredQuestions(rows => { rows.push(...add); return true; }, dir, now);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const rows = updateUnansweredQuestions(undefined, dir, now);
    expect(rows.length).toBe(200); expect(rows[0].id).toBe("2");
    finishArchivedQuestion("2", "interrupted", dir);
    expect(updateUnansweredQuestions(undefined, dir)[0].reason).toBe("interrupted");
    finishArchivedQuestion("2", "answered", dir);
    expect(updateUnansweredQuestions(undefined, dir)).toHaveLength(199);
    expect(updateUnansweredQuestions(undefined, dir, now + 30 * 86_400_000)).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).questions).toEqual([]);
    writeFileSync(file, "{damaged");
    expect(updateUnansweredQuestions(undefined, dir)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("{damaged");
    updateUnansweredQuestions(rows => { rows.push(q("new")); return true; }, dir);
    expect(updateUnansweredQuestions(undefined, dir)[0].id).toBe("new");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
