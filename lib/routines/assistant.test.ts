import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ASSISTANT_STATE_FILE, applyAssistantProposal, cancelAssistantProposal, extractAssistantProposals, readAssistantState, saveAssistantState, visibleAssistantText } from "./assistant-proposals";
import { type Routine, readRoutine, readRoutines, thisRoutineHost, writeRoutineFile } from "./store";
import { localParts, ROUTINE_TIMEZONE } from "./schedule";

const routine: Routine = { id: "test", name: "Exchange", enabled: true, host: "other-pc", prompt: "Report exchange rates", cwd: null, model: null, schedule: { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], times: ["08:00"] }, timezone: "Asia/Seoul", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" };
const block = (value: unknown) => `\`\`\`routine-proposal\n${JSON.stringify(value)}\n\`\`\``;
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "cuelo-assistant-test-"));
  const dir = join(root, "repo"); const agent = join(root, "agent");
  mkdirSync(dir); mkdirSync(agent);
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["config", "user.name", "Routine fixture"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: dir });
  writeRoutineFile(dir, routine);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const propose = (raw: unknown) => {
    const parsed = extractAssistantProposals(block(raw), dir, "turn");
    assert.deepEqual(parsed.errors, []);
    const state = readAssistantState(agent);
    state.proposals.push(...parsed.proposals); saveAssistantState(state, agent);
    return parsed.proposals[0];
  };
  return { dir, agent, propose };
}

test("proposal protocol extracts separate validated cards and hides JSON, including invalid and partial fences", (t) => {
  const f = fixture(t);
  const raw = `Before\n${block({ action: "update", routineId: "test", schedule: { ...routine.schedule, times: ["09:00"] } })}\nAfter\n${block({ action: "disable", routineId: "test" })}`;
  const parsed = extractAssistantProposals(raw, f.dir, "turn");
  assert.equal(parsed.proposals.length, 2); assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.proposals[0].input?.prompt, routine.prompt);
  assert.equal(parsed.proposals[0].before?.schedule.kind, "weekly");
  assert.equal(visibleAssistantText(raw), "Before\n\nAfter");
  for (const value of [null, [], {}, { action: "delete", routineId: "test" }, { action: "run", routineId: "../test" }, { action: "run", routineId: "missing" }, { action: "create", ...routine, prompt: "" }, { action: "create", ...routine, schedule: { kind: "invalid" } }, { action: "create", ...routine, oneOff: "yes" }, { action: "create", ...routine, oneOff: true }]) {
    const bad = extractAssistantProposals(block(value), f.dir, "turn");
    assert.equal(bad.proposals.length, 0, JSON.stringify(value)); assert.equal(bad.errors.length, 1);
    assert.equal(visibleAssistantText(block(value)), "");
  }
  const unfinished = "Note\n```routine-proposal\n{\"action\":\"create\"}";
  assert.equal(visibleAssistantText(unfinished), "Note");
  assert.equal(extractAssistantProposals(unfinished, f.dir, "turn").errors.length, 1);
});

test("apply maps create/update/toggle/run onto committed definitions and manual-run semantics, once only", async (t) => {
  const f = fixture(t);
  const runs: Routine[] = [];
  const run = (_dir: string, r: Routine) => { runs.push(r); return true; };
  const create = f.propose({ ...routine, name: "Daily FX", action: "create", oneOff: false });
  const saved = await applyAssistantProposal(f.dir, create.id, f.agent, run);
  assert.equal(saved.status, "applied"); assert.ok(saved.routineId);
  assert.equal(readRoutines(f.dir).length, 2);
  assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: f.dir, encoding: "utf8" }).trim(), "routine-assistant: create Daily FX");
  await assert.rejects(applyAssistantProposal(f.dir, create.id, f.agent, run), /이미 처리/);
  const update = f.propose({ action: "update", routineId: "test", schedule: { ...routine.schedule, times: ["09:00"] } });
  await applyAssistantProposal(f.dir, update.id, f.agent, run);
  const updated = readRoutine(f.dir, "test")!;
  assert.deepEqual(updated.schedule, { ...routine.schedule, times: ["09:00"] });
  assert.equal(updated.createdAt, routine.createdAt);
  for (const action of ["disable", "enable"] as const) {
    const proposal = f.propose({ action, routineId: "test" });
    await applyAssistantProposal(f.dir, proposal.id, f.agent, run);
    assert.equal(readRoutine(f.dir, "test")!.enabled, action === "enable");
  }
  const now = f.propose({ action: "run", routineId: "test" });
  await applyAssistantProposal(f.dir, now.id, f.agent, run);
  assert.equal(runs.length, 1); assert.equal(runs[0].host, "other-pc");
  await assert.rejects(applyAssistantProposal(f.dir, now.id, f.agent, run), /이미 처리/);
  assert.equal(runs.length, 1);
  assert.equal(statSync(join(f.agent, ASSISTANT_STATE_FILE)).mode & 0o777, 0o600);
});

test("stale, removed, cancelled and concurrent duplicate cards refuse without changing the routine", async (t) => {
  const f = fixture(t);
  const run = () => { throw new Error("Must not run"); };
  const stale = f.propose({ action: "disable", routineId: "test" });
  writeRoutineFile(f.dir, { ...routine, prompt: "External edit" });
  await assert.rejects(applyAssistantProposal(f.dir, stale.id, f.agent, run), /변경되었습니다/);
  assert.equal(readRoutine(f.dir, "test")!.enabled, true);
  const cancelled = f.propose({ action: "disable", routineId: "test" });
  cancelAssistantProposal(cancelled.id, f.agent);
  await assert.rejects(applyAssistantProposal(f.dir, cancelled.id, f.agent, run), /이미 처리/);
  assert.throws(() => cancelAssistantProposal(cancelled.id, f.agent), /이미 처리/);
  const duplicate = f.propose({ action: "disable", routineId: "test" });
  const first = applyAssistantProposal(f.dir, duplicate.id, f.agent, run);
  await assert.rejects(applyAssistantProposal(f.dir, duplicate.id, f.agent, run), /이미 처리/);
  await first;
  const removed = f.propose({ action: "run", routineId: "test" });
  rmSync(join(f.dir, "routines", "test", "routine.json"));
  await assert.rejects(applyAssistantProposal(f.dir, removed.id, f.agent, run), /찾을 수 없습니다/);
});

test("one-off create runs on this host only and never recreates after a run refusal", async (t) => {
  const f = fixture(t);
  let runs = 0;
  const run = () => { runs++; return false; };
  for (const host of [thisRoutineHost(), "remote-pc"]) {
    const p = f.propose({ ...routine, action: "create", oneOff: true, host, schedule: { kind: "once", date: "2026-11-16", time: "08:00" } });
    const result = await applyAssistantProposal(f.dir, p.id, f.agent, run);
    assert.equal(result.status, "applied");
    assert.ok(result.routineId);
    assert.match(result.result!, host === thisRoutineHost() ? /저장은 완료/ : /동기화/);
    await assert.rejects(applyAssistantProposal(f.dir, p.id, f.agent, run), /이미 처리/);
  }
  assert.equal(runs, 1); assert.equal(readRoutines(f.dir).length, 3);
});

test("an apply finishing after a prompt appended cards preserves those cards and concurrent cancellation", async (t) => {
  const f = fixture(t);
  const applying = f.propose({ action: "run", routineId: "test" });
  const cancelled = f.propose({ action: "disable", routineId: "test" });
  let appended = "";
  let during: string | undefined;
  await applyAssistantProposal(f.dir, applying.id, f.agent, () => {
    // The real Git callback runs before its promise resolves, interleaving the state writes.
    during = readAssistantState(f.agent).proposals.find((p) => p.id === applying.id)?.status;
    appended = f.propose({ action: "enable", routineId: "test" }).id;
    cancelAssistantProposal(cancelled.id, f.agent);
    return true;
  });
  assert.equal(during, "applying");
  const saved = readAssistantState(f.agent);
  assert.equal(saved.proposals.find((p) => p.id === appended)?.status, "pending");
  assert.equal(saved.proposals.find((p) => p.id === cancelled.id)?.status, "cancelled");
  assert.equal(saved.proposals.find((p) => p.id === applying.id)?.status, "applied");
});

test("a run refused because the routine is busy keeps the same card applicable", async (t) => {
  const f = fixture(t);
  const p = f.propose({ action: "run", routineId: "test" });
  await assert.rejects(applyAssistantProposal(f.dir, p.id, f.agent, () => false), /같은 카드를 다시 적용/);
  assert.equal(readAssistantState(f.agent).proposals.find((x) => x.id === p.id)?.status, "pending");
  assert.equal((await applyAssistantProposal(f.dir, p.id, f.agent, () => true)).status, "applied");
});

test("proposal fences inside JSON strings stay intact; malformed fence headers hide raw JSON", (t) => {
  const f = fixture(t);
  const raw = block({ ...routine, action: "create", prompt: "run ```npm test``` now" });
  assert.equal(extractAssistantProposals(raw, f.dir, "turn").proposals.length, 1);
  assert.equal(visibleAssistantText(raw), "");
  const malformed = raw.replace("routine-proposal\n", "routine-proposal json\n");
  assert.equal(extractAssistantProposals(malformed, f.dir, "turn").errors.length, 1);
  assert.equal(visibleAssistantText(malformed), "");
  const indented = "1. 생성\n" + raw.split("\n").map((line) => "    " + line).join("\n");
  assert.equal(extractAssistantProposals(indented, f.dir, "turn").proposals.length, 1);
  assert.equal(visibleAssistantText(indented), "1. 생성");
});

test("one-off execution is pinned to the apply-time slot, not a future model-supplied date", async (t) => {
  const f = fixture(t);
  const p = f.propose({ ...routine, action: "create", oneOff: true, enabled: false, host: thisRoutineHost(), schedule: { kind: "once", date: "2099-01-01", time: "09:00" } });
  assert.equal(p.input?.enabled, true);
  assert.notEqual(p.input?.schedule.kind === "once" && p.input.schedule.date, "2099-01-01");
  const slot = (parts: { date: string; time: string }) => `${parts.date}T${parts.time}`;
  const start = slot(localParts(new Date(), ROUTINE_TIMEZONE));
  await applyAssistantProposal(f.dir, p.id, f.agent, (_dir, next) => {
    // The slot is taken before the Git commit; the clock may cross a minute boundary meanwhile.
    assert.equal(next.schedule.kind, "once");
    const pinned = next.schedule.kind === "once" ? slot(next.schedule) : "";
    assert.ok(pinned >= start && pinned <= slot(localParts(new Date(), ROUTINE_TIMEZONE)), pinned);
    assert.equal(next.enabled, true);
    return true;
  });
});

test("a one-off create stays applied when the run after its commit throws", async (t) => {
  const f = fixture(t);
  const p = f.propose({ ...routine, action: "create", oneOff: true, host: thisRoutineHost(), schedule: { kind: "once", date: "2026-11-16", time: "08:00" } });
  const result = await applyAssistantProposal(f.dir, p.id, f.agent, () => { throw new Error("boom"); });
  assert.equal(result.status, "applied");
  const saved = readAssistantState(f.agent).proposals.find((x) => x.id === p.id);
  assert.equal(saved?.status, "applied");
  assert.match(saved?.result ?? "", /저장은 완료/);
  assert.equal(readRoutines(f.dir).length, 2);
});

test("failed git commits roll back create and update definitions instead of leaving runnable files", async (t) => {
  const f = fixture(t);
  const original = readFileSync(join(f.dir, "routines", "test", "routine.json"), "utf8");
  writeFileSync(join(f.dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const create = f.propose({ ...routine, action: "create", name: "must not remain" });
  await assert.rejects(applyAssistantProposal(f.dir, create.id, f.agent, () => true));
  assert.deepEqual(readRoutines(f.dir).map((r) => r.id), ["test"]);
  assert.deepEqual(readdirSync(join(f.dir, "routines")), ["test"]);
  const update = f.propose({ action: "update", routineId: "test", prompt: "must not remain" });
  await assert.rejects(applyAssistantProposal(f.dir, update.id, f.agent, () => true));
  assert.equal(readFileSync(join(f.dir, "routines", "test", "routine.json"), "utf8"), original);
});
