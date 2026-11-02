import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCheckMarks } from "./collect.ts";
import { activeCheckMarks, CHECK_MARKS_FILE, checkMetricIdFrom, checkNoteFrom, clearCheckMark, readCheckMarks, setCheckMark } from "./checks.ts";

const DAY = 86_400_000;

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-check-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a check mark is stored with its note, replaced by a newer one and cleared on its own", () =>
  withDir((dir) => {
    const at = new Date("2026-11-02T08:10:00.000Z");
    setCheckMark(dir, "purpose:draft", at, "Argon 청구분, 10-30 환원");
    setCheckMark(dir, "ci", at, null);
    assert.deepEqual(readCheckMarks(dir), {
      "purpose:draft": { at: at.toISOString(), note: "Argon 청구분, 10-30 환원" },
      ci: { at: at.toISOString(), note: null },
    });
    const later = new Date(at.getTime() + 60_000);
    setCheckMark(dir, "purpose:draft", later, "다시 확인");
    assert.deepEqual(readCheckMarks(dir)["purpose:draft"], { at: later.toISOString(), note: "다시 확인" });
    clearCheckMark(dir, "purpose:draft");
    assert.deepEqual(Object.keys(readCheckMarks(dir)), ["ci"]);
  }));

test("marks older than seven days are dropped from the report and from the file", () =>
  withDir((dir) => {
    const now = Date.parse("2026-11-09T00:00:00.000Z");
    setCheckMark(dir, "old", new Date(now - 7 * DAY - 1), "지난 창");
    setCheckMark(dir, "fresh", new Date(now - 7 * DAY + 1), "이번 창");
    assert.deepEqual(Object.keys(activeCheckMarks(dir, now)), ["fresh"]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, CHECK_MARKS_FILE), "utf8"))), ["fresh"]);
  }));

test("an unreadable marks file is left alone and refuses changes instead of overwriting it", () =>
  withDir((dir) => {
    writeFileSync(join(dir, CHECK_MARKS_FILE), "{ not json");
    assert.deepEqual(activeCheckMarks(dir, Date.now()), {});
    assert.throws(() => setCheckMark(dir, "ci", new Date(), null));
    assert.equal(readFileSync(join(dir, CHECK_MARKS_FILE), "utf8"), "{ not json");
  }));

test("the request body's id and note are validated", () => {
  assert.equal(checkMetricIdFrom({ metricId: "purpose:draft" }), "purpose:draft");
  assert.equal(checkMetricIdFrom({ metricId: "" }), null);
  assert.equal(checkMetricIdFrom({ metricId: " ci" }), null);
  assert.equal(checkMetricIdFrom({ metricId: "x".repeat(201) }), null);
  assert.equal(checkMetricIdFrom({}), null);
  assert.equal(checkNoteFrom({}), null);
  assert.equal(checkNoteFrom({ note: "  " }), null);
  assert.equal(checkNoteFrom({ note: " 원인\n한 줄 " }), "원인 한 줄");
  assert.equal(checkNoteFrom({ note: 3 }), undefined);
  assert.equal(checkNoteFrom({ note: "가".repeat(301) }), undefined);
});

test("a check mark attaches to its row and leaves every verdict as it was", () => {
  const metric = (id, status) => ({ id, label: id, unit: "usd", current: 1, previous: 0.1, status, criterion: "", evidence: [] });
  const sections = [{ id: "cost", title: "cost", status: "problem", summary: "", warnings: [], metrics: [metric("purpose:draft", "problem"), metric("purpose:skim", "watch")] }];
  applyCheckMarks(sections, { "purpose:draft": { at: "2026-11-02T08:10:00.000Z", note: "환원됨" }, "not-a-row": { at: "2026-11-02T08:10:00.000Z", note: null } });
  const [draft, skim] = sections[0].metrics;
  assert.deepEqual(draft.check, { checkedAt: "2026-11-02T08:10:00.000Z", note: "환원됨" });
  assert.equal(draft.status, "problem");
  assert.equal(skim.check, undefined);
  assert.equal(sections[0].status, "problem");
});
