import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillSection } from "./collect.ts";
import { buildNightlyExport, planInboxRun, readNightlyInbox } from "./nightly-inbox.ts";
import { scanSessions } from "./sessions.ts";
import { observedCandidates } from "./skill-candidates.ts";
import { buildSkillUsage, emptySkillWindow, installedSkills, skillAssociationStatus, skillNamesFromPath } from "./skill-usage.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixture-report.json", import.meta.url), "utf8"));
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");
const SECRET = "ghp_abcdefghijklmnop1234567890";
const HASH_ERROR = `hash is not from this session token=${SECRET}`;
/** 열린 이슈가 없던 조회. 이슈와 상관없는 시험의 기본값이다. */
const NO_ISSUES = { status: "ok", repo: "gim47656-ship-it/CUELO", issues: [], partial: false };

/** 세션 파일 한 줄씩. id는 파일·호출 사이에서 겹치지 않게 접두사를 붙인다. */
function session(prefix, start) {
  let n = 0, t = start;
  const ts = () => new Date((t += 1000)).toISOString();
  return {
    header: { type: "session", id: `${prefix}-session`, timestamp: new Date(start).toISOString() },
    user: (text) => ({ type: "message", id: `${prefix}-u${++n}`, timestamp: ts(), message: { role: "user", content: text } }),
    call: (id, name, args) => ({ type: "message", id: `${prefix}-a${++n}`, timestamp: ts(), message: { role: "assistant", content: [{ type: "toolCall", id: `${prefix}-${id}`, name, arguments: args }] } }),
    result: (id, name, text, isError = false) => ({
      type: "message", id: `${prefix}-r${++n}`, timestamp: ts(),
      message: { role: "toolResult", toolCallId: `${prefix}-${id}`, toolName: name, isError, content: [{ type: "text", text }] },
    }),
  };
}

/** s1: 스킬을 연 턴에 실패·넘김·지적이 있고, 다음 턴에 따로 실패가 하나 있다. */
function firstSession(now) {
  const s = session("s1", now - 3_600_000);
  return [
    s.header,
    s.user("배포해줘"),
    s.call("k1", "read", { path: "skill://alpha/references/x.md:1-20", i: "Reading skill" }), s.result("k1", "read", "# alpha"),
    // 실패한 스킬 읽기는 열람이 아니다(연 뒤 호출로는 센다).
    s.call("k0", "read", { path: "skill://beta" }), s.result("k0", "read", "Skill not found: beta", true),
    s.call("c1", "edit", { input: "[a.ts#AB12]\nPUT 1.=1:\n+x", i: "Editing" }), s.result("c1", "edit", HASH_ERROR, true),
    s.call("c2", "edit", { input: "[a.ts#CD34]\nPUT 1.=1:\n+x", i: "Editing again" }), s.result("c2", "edit", "ok"),
    s.user("또 안 되잖아"),
    s.call("c3", "edit", { input: "x" }), s.result("c3", "edit", "ok"),
    s.call("c4", "edit", { input: "y" }), s.result("c4", "edit", "other failure", true),
  ];
}

/** s2: 다른 세션에서 같은 실패를 같은 모양의 호출로 넘긴다. */
function secondSession(now) {
  const s = session("s2", now - 1_800_000);
  return [
    s.header,
    s.user("고쳐줘"),
    s.call("e1", "edit", { input: "[b.ts#1111]\nPUT 2.=2:\n+y", i: "Editing" }), s.result("e1", "edit", HASH_ERROR.replace("session", "session"), true),
    s.call("e2", "edit", { input: "[b.ts#2222]\nPUT 2.=2:\n+y", i: "Retry" }), s.result("e2", "edit", "ok"),
  ];
}

function withDir(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), name));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("skill paths reduce to the skill names; anything else is not a skill open", () => {
  assert.deepEqual(skillNamesFromPath("skill://alpha/references/x.md:1-20"), ["alpha"]);
  assert.deepEqual(skillNamesFromPath("skill://alpha:5"), ["alpha"]);
  assert.deepEqual(skillNamesFromPath("rule://alpha"), []);
  assert.deepEqual(skillNamesFromPath(undefined), []);
  // `read`가 `;`로 이은 여러 경로는 조각마다 보고, 스킬이 아닌 조각은 이름에 붙지 않는다.
  assert.deepEqual(skillNamesFromPath("skill://alpha;.omp/probe.ts:1-100"), ["alpha"]);
  assert.deepEqual(skillNamesFromPath("skill://alpha;rule://subagent;skill://beta/x.md;skill://alpha:3"), ["alpha", "beta"]);
});

test("skill opens, sessions, after-open failures, rest of session and the following complaint are counted per window", () => withDir("upkeep-skills-", async (dir) => {
  const now = Date.now();
  const old = session("s3", now - 9 * 86_400_000);
  writeFileSync(join(dir, "s1.jsonl"), lines(firstSession(now)));
  writeFileSync(join(dir, "s3.jsonl"), lines([old.header, old.user("x"), old.call("k9", "read", { path: "skill://alpha" }), old.result("k9", "read", "# alpha")]));
  const scan = await scanSessions(dir, now);
  const alpha = scan.skills.windows[0].alpha;
  assert.deepEqual(
    { ...alpha, lastOpenedAt: typeof alpha.lastOpenedAt },
    { opens: 1, sessions: 1, lastOpenedAt: "string", afterCalls: 3, afterFailures: 2, restCalls: 3, restFailures: 1, openTurns: 1, complaintTurns: 1 },
  );
  assert.equal(scan.skills.windows[0].beta, undefined);
  assert.equal(scan.skills.windows[1].alpha.opens, 1);
  assert.deepEqual(scan.skills.sessions.alpha.map((s) => [s.sessionId, s.opens, s.afterFailures, s.afterCalls]), [["s1-session", 1, 2, 3]]);
  // 기존 집계는 그대로다.
  assert.equal(scan.windows[0].calls, 6);
  assert.equal(scan.windows[0].errors, 3);
}));

test("installed skills never opened are listed; skills changed within 30 days are marked young; the section shows both", () => withDir("upkeep-installed-", async (agentDir) => {
  const now = Date.now();
  for (const [folder, name] of [["managed-skills", "alpha"], ["skills", "old-skill"], ["skills", "new-skill"], ["managed-skills", "stale-managed"]]) {
    mkdirSync(join(agentDir, folder, name), { recursive: true });
    writeFileSync(join(agentDir, folder, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }
  const longAgo = new Date(now - 40 * 86_400_000);
  utimesSync(join(agentDir, "skills", "old-skill", "SKILL.md"), longAgo, longAgo);
  utimesSync(join(agentDir, "managed-skills", "stale-managed", "SKILL.md"), longAgo, longAgo);
  const { skills } = await installedSkills(agentDir);
  const sessionsDir = join(agentDir, "sessions");
  mkdirSync(sessionsDir);
  writeFileSync(join(sessionsDir, "s1.jsonl"), lines(firstSession(now)));
  const scan = await scanSessions(sessionsDir, now);
  const usage = buildSkillUsage(scan.skills.windows, scan.skills.sessions, skills, now);
  assert.deepEqual(usage.rows.map((r) => [r.name, r.scope, r.status]), [["alpha", "managed", "unknown"]]);
  assert.deepEqual(usage.unused, [
    { name: "new-skill", scope: "user", young: true },
    { name: "old-skill", scope: "user", young: false },
    { name: "stale-managed", scope: "managed", young: false },
  ]);

  const section = skillSection(scan, skills, now);
  assert.equal(section.id, "skills");
  const alpha = section.metrics.find((m) => m.id === "skill:alpha");
  assert.deepEqual([alpha.current, alpha.previous, alpha.status], [1, 0, "unknown"]);
  assert.match(alpha.note, /연 뒤 도구 오류 2\/3건 \(66\.7%\), 같은 세션의 나머지 1\/3건 \(33\.3%\)/);
  assert.match(alpha.note, /지적 표현이 나온 턴 1번/);
  assert.match(alpha.note, /20건 미만/);
  assert.match(alpha.criterion, /알 수 없습니다/);
  assert.equal(alpha.evidence[0].sessionId, "s1-session");
  const unused = section.metrics.find((m) => m.id === "skills-unused");
  assert.equal(unused.current, 2);
  assert.deepEqual(unused.evidence.map((e) => e.label), ["stale-managed · 관리 스킬", "old-skill · 사용자 스킬"]);
  assert.match(unused.note, /아직 판정하지 않는 스킬 1개/);
}));

test("after-open failure association is judged only with 20+ calls on both sides", () => {
  const w = (afterFailures, afterCalls, restFailures, restCalls) => ({ ...emptySkillWindow(), opens: 1, afterFailures, afterCalls, restFailures, restCalls });
  assert.equal(skillAssociationStatus(w(10, 20, 2, 40)), "problem");
  assert.equal(skillAssociationStatus(w(4, 20, 4, 40)), "problem");
  assert.equal(skillAssociationStatus(w(3, 20, 4, 40)), "ok");
  assert.equal(skillAssociationStatus(w(10, 19, 2, 40)), "unknown");
  assert.equal(skillAssociationStatus(w(10, 20, 2, 19)), "unknown");
});

test("an observed candidate needs the same failure and recovery shape in two different sessions", () => withDir("upkeep-observed-", async (dir) => {
  const now = Date.now();
  writeFileSync(join(dir, "s1.jsonl"), lines(firstSession(now)));
  const one = await scanSessions(dir, now);
  assert.equal(one.recoveries.length, 1);
  assert.deepEqual(observedCandidates(one.recoveries, 0), []);

  writeFileSync(join(dir, "s2.jsonl"), lines(secondSession(now)));
  const two = await scanSessions(dir, now);
  const candidates = observedCandidates(two.recoveries, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "observed");
  assert.equal(candidates[0].sessionCount, 2);
  assert.equal(candidates[0].sessionId, "s2-session");
  assert.match(candidates[0].memory, /edit\(input\)/);
  assert.ok(!candidates[0].memory.includes(SECRET));
  // since 뒤 흔적만 센다.
  assert.deepEqual(observedCandidates(two.recoveries, now), []);

  const [signature] = Object.keys(two.failureExcerpts).filter((key) => key.startsWith("edit: hash"));
  const excerpts = two.failureExcerpts[signature];
  assert.equal(excerpts.length, 2);
  assert.ok(excerpts.every((e) => e.recovery && e.recovery.includes("input=") && !e.error.includes(SECRET)), JSON.stringify(excerpts));
}));

const NOW = new Date("2026-11-01T19:30:00.000Z");
const recent = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
const REPO = "/data/cuelo/workspace/CUELO-private";
const weeklyDone = { date: "2026-11-01", sessionId: "prev", worktree: "/w", startedAt: recent(24), sources: { home: { performanceReviewDate: "2026-10-31" } } };

function exportHome(extra = {}) {
  const window = (o) => ({ ...emptySkillWindow(), ...o });
  return buildNightlyExport({
    source: "home",
    now: NOW,
    report: fixture,
    skillCandidates: [
      { memory: "관찰", topic: "edit", sessionId: "S2", timestamp: recent(3), kind: "observed", sessionCount: 2, signature: "edit: hash is not from this session token=[가림]" },
      { memory: "한 세션뿐", topic: "edit", sessionId: "S1", timestamp: recent(3), kind: "observed", sessionCount: 1, signature: "x" },
      { memory: `요령 ${SECRET}`, topic: null, sessionId: "S3", timestamp: recent(4), kind: "learned" },
    ],
    errorsBySignature: { "edit: hash is not from this session token=[가림]": 5, "bash: other": 1 },
    skillUsage: {
      rows: [{
        name: "alpha", scope: "managed", status: "ok",
        current: window({ opens: 30, sessions: 4, lastOpenedAt: recent(5), afterCalls: 20, afterFailures: 10, restCalls: 40, restFailures: 2 }),
        previous: window({ opens: 2 }),
        sessions: [{ sessionId: "S1", sessionPath: "/home/user/.omp/agent/sessions/x.jsonl", opens: 1, afterCalls: 1, afterFailures: 1, lastOpenedAt: recent(5) }],
      }],
      unused: [{ name: "stale", scope: "managed", young: false }, { name: "fresh", scope: "user", young: true }],
    },
    failureExcerpts: {
      "edit: hash is not from this session token=[가림]": [1, 2, 3, 4].map((i) => ({
        args: `input=[a.ts#${i}] api_key=${SECRET}`, error: `${HASH_ERROR} ${"long ".repeat(400)}`, recovery: i === 4 ? null : `input=retry ${i}`,
      })),
    },
    ...extra,
  });
}

test("v2 export masks and caps every new field, enforces two sessions for observed candidates, and round-trips through the inbox", () => withDir("nightly-v2-", (dir) => {
  const exported = exportHome();
  assert.equal(exported.version, 2);
  assert.deepEqual(exported.skillCandidates.map((c) => [c.kind, c.sessionCount ?? null]), [["observed", 2], ["learned", null]]);
  assert.ok(!exported.skillCandidates[1].memory.includes(SECRET));
  // 판정은 숫자에서 다시 내고, 세션 경로는 묶음에 싣지 않는다.
  assert.equal(exported.skillUsage.rows[0].status, "problem");
  assert.equal(exported.skillUsage.rows[0].sessions, undefined);
  assert.deepEqual(exported.skillUsage.unused, [{ name: "stale", scope: "managed", young: false }, { name: "fresh", scope: "user", young: true }]);
  assert.equal(exported.failureExcerpts.length, 1);
  const [group] = exported.failureExcerpts;
  assert.equal(group.excerpts.length, 3);
  assert.equal(group.excerpts[0].recovery, null, "newest excerpt first");
  for (const e of group.excerpts) {
    assert.ok(e.error.length <= 401 && e.args.length <= 301, `${e.error.length}/${e.args.length}`);
    assert.ok(!e.error.includes(SECRET) && !e.args.includes(SECRET), JSON.stringify(e));
  }
  writeFileSync(join(dir, "home.json"), JSON.stringify(exported));
  const { bundles, skipped } = readNightlyInbox(dir, NOW);
  assert.deepEqual(skipped, []);
  assert.deepEqual(bundles[0], exported);
}));

test("a tampered v2 bundle is re-masked and re-clipped, and a v1 bundle still parses with empty new fields", () => withDir("nightly-tamper-", (dir) => {
  const raw = JSON.parse(JSON.stringify(exportHome()));
  raw.failureExcerpts[0].excerpts[0].error = `${SECRET} ${"y".repeat(5000)}`;
  raw.failureExcerpts[0].excerpts[1].args = `password=${SECRET}`;
  raw.skillCandidates.push({ memory: "가짜", topic: null, sessionId: "S", timestamp: recent(1), kind: "observed", sessionCount: 1 });
  // 옛 PC가 아직 보내는 실험 플러그인 칸: 모양과 상관없이 무시되어야 한다.
  raw.labPlugins = [{ plugin: { id: "Bad Id" }, usage: {}, files: [{ path: "../escape.ts", text: `secret: ${SECRET}` }] }];
  raw.skillUsage.rows[0].name = `alpha ${SECRET}`;
  writeFileSync(join(dir, "home.json"), JSON.stringify(raw));
  writeFileSync(join(dir, "office.json"), JSON.stringify({
    version: 1, source: "office", generatedAt: recent(1), problems: [], toolFailures: [],
    skillCandidates: [{ memory: "옛 후보", topic: null, sessionId: "O", timestamp: recent(2) }],
  }));
  const { bundles } = readNightlyInbox(dir, NOW);
  const [home, office] = bundles;
  const text = JSON.stringify(home);
  assert.ok(!text.includes(SECRET), "every new string field is re-masked");
  assert.ok(home.failureExcerpts[0].excerpts[0].error.length <= 401);
  assert.deepEqual(home.skillCandidates.map((c) => c.kind), ["observed", "learned"]);
  assert.equal("labPlugins" in home, false, "the retired lab field is dropped, not carried");

  assert.equal(office.version, 1);
  assert.deepEqual(office.skillCandidates.map((c) => [c.memory, c.kind]), [["옛 후보", "learned"]]);
  assert.deepEqual([office.skillUsage, office.failureExcerpts], [{ rows: [], unused: [] }, []]);
}));

const v2 = (overrides) => ({
  version: 2, source: "home", generatedAt: recent(1), problems: [], skillCandidates: [], toolFailures: [],
  skillUsage: { rows: [], unused: [] }, failureExcerpts: [], ...overrides,
});

test("a bundle that still carries the retired lab field starts no promotion work and its files never reach the prompt", () => {
  // 옛 칸만 채운 묶음은 그 일로 아무 일도 맡기지 않는다(묶음 자체는 받아들인다).
  const labOnly = planInboxRun([v2({ labPlugins: [{ plugin: { id: "ready-one" }, usage: { sessions: 9, activeDays: 9 }, files: [{ path: "src/index.ts", text: "RETIRED_BODY" }] }] })], weeklyDone, NOW, [], REPO, null, NO_ISSUES);
  assert.deepEqual(Object.keys(labOnly.sources?.[0]?.jobs ?? {}).sort(), ["problems", "skillCandidates", "weeklyReview"]);
  assert.doesNotMatch(labOnly.prompt, /승격|RETIRED_BODY/);
  const problem = { id: "cost/x", section: "비용", title: "x", summary: "s" };
  const withProblem = planInboxRun([v2({ problems: [problem], labPlugins: [{ plugin: { id: "ready-one" }, files: [{ path: "a.ts", text: "RETIRED_BODY" }] }] })], weeklyDone, NOW, [], REPO, null, NO_ISSUES);
  assert.equal(withProblem.action, "run");
  assert.doesNotMatch(withProblem.prompt, /승격|RETIRED_BODY/);
});

test("a managed skill associated with failures starts a run; removal proposals skip young skills; observed candidates come with their excerpts", () => {
  const window = (o) => ({ ...emptySkillWindow(), ...o });
  const flagged = (name, scope) => ({ name, scope, status: "problem", current: window({ opens: 5, sessions: 3, afterCalls: 20, afterFailures: 10, restCalls: 40, restFailures: 2 }), previous: window({}) });
  const userOnly = v2({ skillUsage: { rows: [flagged("mine", "user")], unused: [] } });
  // 사용자 스킬은 고칠 수 없으므로 스킬 점검 일로 잡지 않는다.
  assert.equal(planInboxRun([userOnly], weeklyDone, NOW, [], REPO, null, NO_ISSUES).jobs.skillHealth, undefined);

  const signature = "edit: hash is not from this session";
  const plan = planInboxRun([v2({
    skillUsage: { rows: [flagged("alpha", "managed")], unused: [{ name: "stale", scope: "managed", young: false }, { name: "fresh", scope: "user", young: true }] },
    skillCandidates: [{ memory: "넘김 관찰", topic: "edit", sessionId: "S2", timestamp: recent(2), kind: "observed", sessionCount: 2, signature }],
    failureExcerpts: [{ tool: "edit", key: "hash is not from this session", excerpts: [{ args: "input=[a.ts#AB]", error: "hash is not from this session", recovery: "input=[a.ts#CD]" }] }],
  })], weeklyDone, NOW, [], REPO, null, NO_ISSUES);
  assert.equal(plan.action, "run");
  assert.deepEqual(plan.jobs.skillHealth, ["home:alpha"]);
  assert.match(plan.prompt, /## 스킬 사용 점검/);
  assert.match(plan.prompt, /- alpha \(관리 스킬, 판정 problem\)/);
  assert.match(plan.prompt, /스킬을 지우거나 옮기지 않습니다/);
  assert.match(plan.prompt, /정리 제안 대상 1개\):\n- stale \(관리 스킬\)/);
  assert.doesNotMatch(plan.prompt, /- fresh/);
  assert.match(plan.prompt, /### 세션 기록에서 찾은 넘김 방법/);
  assert.match(plan.prompt, /서로 다른 세션 2곳에서 관찰/);
  assert.match(plan.prompt, /넘김: input=\[a\.ts#CD\]/);
});

test("a complaint is counted in the window of the skill open, and a late result from an earlier turn is not a recovery", () => withDir("upkeep-turns-", async (dir) => {
  const now = Date.now();
  const s = session("b1", now - 7 * 86_400_000 - 3500);
  // 직전 7일 끝에 스킬을 열고, 최근 7일 첫머리에 지적한다.
  writeFileSync(join(dir, "b1.jsonl"), lines([s.header, s.user("시작"), s.call("k", "read", { path: "skill://alpha" }), s.result("k", "read", "# alpha"), s.user("또 안 되잖아")]));
  const t = session("t1", now - 600_000);
  writeFileSync(join(dir, "t1.jsonl"), lines([
    t.header, t.user("A"), t.call("f", "edit", { input: "[a.ts#1]" }), t.user("B"), t.result("f", "edit", HASH_ERROR, true),
    t.call("g", "edit", { input: "[a.ts#2]" }), t.result("g", "edit", "ok"),
  ]));
  const scan = await scanSessions(dir, now);
  assert.equal(scan.skills.windows[1].alpha.complaintTurns, 1);
  assert.equal(scan.skills.windows[0].alpha, undefined);
  assert.deepEqual(scan.recoveries, []);
  assert.equal(Object.values(scan.failureExcerpts)[0][0].recovery, null);
}));

test("an unreadable session history never yields unused skills", async () => {
  const scan = await scanSessions("/nonexistent-upkeep-dir", Date.now());
  assert.ok(scan.warnings.length);
  const usage = buildSkillUsage(scan.skills.windows, {}, [{ name: "old", scope: "managed", modifiedAt: 0 }], Date.now(), !scan.warnings.length);
  assert.deepEqual(usage.unused, []);
  const section = skillSection(scan, [{ name: "old", scope: "managed", modifiedAt: 0 }], Date.now());
  const row = section.metrics.find((m) => m.id === "skills-unused");
  assert.deepEqual([row.current, row.status], [null, "unknown"]);
});

test("an observed candidate outside the top failure ranks still carries its excerpt, and flagged skill rows survive the row cap", () => {
  const window = (o) => ({ ...emptySkillWindow(), ...o });
  const errors = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`bash: common ${i}`, 100 - i]));
  const rows = Array.from({ length: 90 }, (_, i) => ({ name: `s${i}`, scope: "managed", current: window({ opens: 100 - i }), previous: window({}) }));
  rows.push({ name: "bad", scope: "managed", current: window({ opens: 1, afterCalls: 20, afterFailures: 10, restCalls: 40, restFailures: 2 }), previous: window({}) });
  const exported = buildNightlyExport({
    source: "home", now: NOW, report: fixture, errorsBySignature: { ...errors, "edit: rare": 1 },
    skillCandidates: [{ memory: "드문 넘김", topic: "edit", sessionId: "S", timestamp: recent(1), kind: "observed", sessionCount: 2, signature: "edit: rare" }],
    failureExcerpts: { "edit: rare": [{ args: "input=1", error: "rare", recovery: "input=2" }] },
    skillUsage: { rows, unused: [] },
  });
  assert.deepEqual(exported.failureExcerpts[0], { tool: "edit", key: "rare", excerpts: [{ args: "input=1", error: "rare", recovery: "input=2" }] });
  assert.equal(exported.skillUsage.rows[0].name, "bad");
  assert.equal(exported.skillUsage.rows[0].status, "problem");

  // 주의·문제인 사용자 스킬 80개가 앞에 있어도 야간 실행 계기인 관리 스킬 행은 남는다.
  const flaggedRow = (name, scope) => ({ name, scope, current: window({ opens: 5, afterCalls: 20, afterFailures: 10, restCalls: 40, restFailures: 2 }), previous: window({}) });
  const users = Array.from({ length: 80 }, (_, i) => flaggedRow(`u${i}`, "user"));
  const usersExport = buildNightlyExport({ source: "home", now: NOW, report: { ...fixture, sections: [] }, skillCandidates: [], errorsBySignature: {}, skillUsage: { rows: [...users, flaggedRow("managed-one", "managed")], unused: [] } });
  const plan = planInboxRun([usersExport], weeklyDone, NOW, [], REPO, null, NO_ISSUES);
  assert.deepEqual(plan.jobs.skillHealth, ["home:managed-one"]);
});
