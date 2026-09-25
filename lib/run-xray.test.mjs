import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildConfigSignature,
  getRunDetail,
  listExperiments,
  listRuns,
  median,
  parseTaskRoleMap,
  pickBottlenecks,
  unionCoverageMs,
} = await jiti.import("./run-xray.ts");

function taskLine(name, agent, task) {
  return JSON.stringify({
    type: "message",
    id: "assistant-1",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "task", arguments: { tasks: [{ name, agent, task }] } }],
    },
  });
}

test("겹치는 구간은 합집합으로 한 번만 센다", () => {
  assert.equal(
    unionCoverageMs(
      [
        [0, 100],
        [50, 150],
        [200, 300],
      ],
      0,
      1000,
    ),
    250,
  );
});

test("창 밖 구간은 잘라내고 창이 비었으면 0이다", () => {
  assert.equal(
    unionCoverageMs(
      [
        [-100, 50],
        [900, 1200],
      ],
      0,
      1000,
    ),
    150,
  );
  assert.equal(unionCoverageMs([[0, 10]], 5, 5), 0);
  assert.equal(unionCoverageMs([], 0, 100), 0);
});

test("병목은 큰 것부터 최대 3개, 동률은 id 오름차순이다", () => {
  const bottlenecks = pickBottlenecks(
    [
      { id: "zeta", ms: 100 },
      { id: "alpha", ms: 100 },
      { id: "main", ms: 300 },
      { id: "small", ms: 10 },
    ],
    50,
  );
  assert.deepEqual(
    bottlenecks.map((entry) => entry.id),
    ["main", "alpha", "zeta"],
  );
  assert.equal(bottlenecks[0].kind, "role-busy");
  // 1위 대비 길이다. 경과시간으로 나누면 병렬 역할에서 합이 100%를 넘는다.
  assert.equal(bottlenecks[0].relative, 1);
  assert.equal(bottlenecks[1].relative, 100 / 300);
});

test("미측정 공백이 있으면 후보에 들고 비어 있으면 빈 배열이다", () => {
  const bottlenecks = pickBottlenecks([{ id: "main", ms: 40 }], 60);
  assert.equal(bottlenecks[0].id, "unmeasured");
  assert.equal(bottlenecks[0].kind, "unmeasured-gap");
  assert.equal(bottlenecks[0].relative, 1);
  assert.equal(bottlenecks[1].relative, 40 / 60);
  assert.deepEqual(pickBottlenecks([], 0), []);
});

test("서명은 같은 역할 조합을 합치고 kind·model·effort 순으로 정렬한다", () => {
  const built = buildConfigSignature([
    { kind: "checker", models: ["anthropic/claude-fable-5-1"], efforts: ["xhigh"] },
    { kind: "maker", models: ["b-ai/deepseek-v4.1-flash"], efforts: ["max"] },
    { kind: "maker", models: ["b-ai/deepseek-v4.1-flash"], efforts: ["max"] },
    { kind: "main", models: ["openai-codex/gpt-6-astra"], efforts: ["high"] },
  ]);
  assert.equal(
    built.signature,
    "main=openai-codex/gpt-6-astra:high|maker x2=b-ai/deepseek-v4.1-flash:max|checker x1=anthropic/claude-fable-5-1:xhigh",
  );
  assert.deepEqual(
    built.roles.map((role) => [role.kind, role.model, role.effort, role.count]),
    [
      ["main", "openai-codex/gpt-6-astra", "high", 1],
      ["maker", "b-ai/deepseek-v4.1-flash", "max", 2],
      ["checker", "anthropic/claude-fable-5-1", "xhigh", 1],
    ],
  );
});

test("서명은 대표값을 첫 관측값으로 쓰고 effort가 없으면 ?로 쓴다", () => {
  const built = buildConfigSignature([
    { kind: "main", models: ["openai-codex/gpt-6-astra", "other/model"], efforts: [] },
    { kind: "maker", models: [], efforts: ["high", "low"] },
  ]);
  assert.equal(built.signature, "main=openai-codex/gpt-6-astra:?|maker x1=?:high");
  assert.equal(built.roles[0].effort, null);
  assert.equal(built.roles[1].model, "?");
});

test("중앙값은 빈 배열이면 0, 짝수면 두 중앙값의 평균이다", () => {
  assert.equal(median([]), 0);
  assert.equal(median([9]), 9);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("PURPOSE는 정상 값만 인정한다", () => {
  const map = parseTaskRoleMap([
    taskLine("Maker", "maker", "TASK_GUARD:\nPURPOSE: primary\n본문"),
    taskLine("Checker", "checker", "TASK_GUARD:\nPURPOSE: review\n본문"),
    taskLine("Reworker", "maker", "TASK_GUARD:\nPURPOSE: rework\n본문"),
    taskLine("NoPurpose", "maker", "TASK_GUARD:\n본문만 있음"),
    taskLine("Typo", "checker", "TASK_GUARD:\nPURPOSE: priamry\n오타"),
  ]);
  assert.equal(map.get("Maker")?.purpose, "primary");
  assert.equal(map.get("Checker")?.purpose, "review");
  assert.equal(map.get("Reworker")?.purpose, "rework");
  assert.equal(map.get("NoPurpose")?.purpose, null);
  assert.equal(map.get("Typo")?.purpose, null);
  assert.equal(map.get("Maker")?.agent, "maker");
});

test("PURPOSE 파싱은 깨진 줄과 task 외 호출을 건너뛴다", () => {
  const map = parseTaskRoleMap([
    "깨진 JSON {",
    JSON.stringify({ type: "message", id: "x", message: { role: "assistant", content: [] } }),
    JSON.stringify({
      type: "message",
      id: "y",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "a" } }],
      },
    }),
    taskLine("Late.jsonl", "maker", "PURPOSE: primary"),
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get("Late")?.purpose, "primary");
});

// ---------------------------------------------------------------------------
// 실제 stats.db + transcript를 임시 HOME에 만들어 끝에서 끝까지 확인한다.
// 아래 4가지는 모두 "200 OK인데 값만 조용히 틀리는" 회귀였다.
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_file TEXT NOT NULL, entry_id TEXT NOT NULL,
  folder TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, api TEXT NOT NULL,
  timestamp INTEGER NOT NULL, duration INTEGER, ttft INTEGER, stop_reason TEXT NOT NULL,
  error_message TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL, premium_requests REAL NOT NULL, cost_input REAL NOT NULL,
  cost_output REAL NOT NULL, cost_cache_read REAL NOT NULL, cost_cache_write REAL NOT NULL,
  cost_total REAL NOT NULL, cost_no_cache_input REAL,
  agent_type TEXT NOT NULL DEFAULT 'main', cost_unpriced INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_file, entry_id));
CREATE TABLE user_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_file TEXT NOT NULL, entry_id TEXT NOT NULL,
  folder TEXT NOT NULL, timestamp INTEGER NOT NULL, model TEXT, provider TEXT,
  chars INTEGER NOT NULL, words INTEGER NOT NULL, yelling INTEGER NOT NULL,
  profanity INTEGER NOT NULL, anguish INTEGER NOT NULL, negation INTEGER NOT NULL DEFAULT 0,
  repetition INTEGER NOT NULL DEFAULT 0, blame INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_file, entry_id));
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_file TEXT NOT NULL, entry_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL, folder TEXT NOT NULL, tool_name TEXT NOT NULL, model TEXT NOT NULL,
  provider TEXT NOT NULL, timestamp INTEGER NOT NULL, agent_type TEXT NOT NULL DEFAULT 'main',
  calls_in_turn INTEGER NOT NULL DEFAULT 1, args_chars INTEGER NOT NULL DEFAULT 0,
  result_chars INTEGER, is_error INTEGER, UNIQUE(session_file, tool_call_id));
`;

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const FOLDER = "/fixture-folder/";

function insertMessage(db, sessionFile, entryId, timestamp, provider, model, stopReason, duration = 500) {
  db.query(
    `INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp,
       duration, ttft, stop_reason, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
       cost_cache_read, cost_cache_write, cost_total, agent_type, cost_unpriced)
     VALUES (?, ?, ?, ?, ?, 'chat', ?, ?, 100, ?, 10, 5, 0, 0, 15, 0, 0, 0, 0, 0, 0.25, 'main', 0)`,
  ).run(sessionFile, entryId, FOLDER, model, provider, timestamp, duration, stopReason);
}

function insertUser(db, sessionFile, entryId, timestamp) {
  db.query(
    `INSERT INTO user_messages (session_file, entry_id, folder, timestamp, chars, words,
       yelling, profanity, anguish) VALUES (?, ?, ?, ?, 10, 2, 0, 0, 0)`,
  ).run(sessionFile, entryId, FOLDER, timestamp);
}

/** 임시 HOME으로 갈아끼우고 원복 함수를 돌려준다. fixture들이 같은 방식으로 격리한다. */
function useTmpHome(home) {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    restore() {
      process.env.HOME = previous.HOME;
      process.env.USERPROFILE = previous.USERPROFILE;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 임시 HOME에 stats.db와 부모/자식 transcript를 만든다. */
function makeFixture({
  childName = "MakerOne.jsonl",
  taskName = "MakerOne",
  agent = "maker",
  orphanChild = null,
  rolelessRun = false,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "run-xray-"));
  mkdirSync(join(home, ".omp"), { recursive: true });
  const projects = join(home, "projects");
  // 실제 파일명 모양 그대로 쓴다: `<ISO-ish ts>_<sessionId>.jsonl`.
  const parentFile = join(projects, `2023-11-14T22-13-20-000Z_${SESSION_ID}.jsonl`);
  const childDir = parentFile.slice(0, -".jsonl".length);
  const childFile = join(childDir, childName);
  // advisor는 `tasks[]`에 실리지 않는다. 파일명 규약이 유일한 근거다.
  const advisorFile = join(childDir, "__advisor.jsonl");
  mkdirSync(childDir, { recursive: true });

  writeFileSync(
    parentFile,
    [
      // run 1 창이 열리기 "전"에 걸린 effort. 변경 기록은 바뀔 때만 남는다.
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high", timestamp: "2023-11-14T22:13:19.000Z" }),
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "첫 요청" }] } }),
      taskLine(taskName, agent, "TASK_GUARD:\nPURPOSE: primary\n"),
      JSON.stringify({ type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "둘째 요청" }] } }),
      // run 2 시작 시각과 **정확히 같은** effort 변경. half-open 규칙상 run 2 것이다.
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "low", timestamp: "2023-11-14T22:13:25.000Z" }),
      // 마지막 run의 창(마지막 관측 기록)보다 **뒤**의 변경. 어느 run에서도 쓰이지 않았다.
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "xhigh", timestamp: "2023-11-14T22:13:35.000Z" }),
    ].join("\n"),
  );
  writeFileSync(
    childFile,
    [
      // 자식 effort는 자식 transcript에만 기록된다.
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "max", timestamp: "2023-11-14T22:13:21.500Z" }),
      JSON.stringify({ type: "message", id: "cu1", message: { role: "user", content: [{ type: "text", text: "브리프" }] } }),
    ].join("\n"),
  );
  writeFileSync(
    advisorFile,
    [JSON.stringify({ type: "message", id: "au1", message: { role: "user", content: [{ type: "text", text: "조언 요청" }] } })].join("\n"),
  );
  // 부모 `tasks[]`에도 없고 advisor 규약도 아닌 자식. 역할을 못 정해 `unattributed`로 남는다.
  const orphanFile = orphanChild ? join(childDir, orphanChild) : null;
  if (orphanFile) {
    writeFileSync(
      orphanFile,
      [JSON.stringify({ type: "message", id: "ou1", message: { role: "user", content: [{ type: "text", text: "고아 자식" }] } })].join("\n"),
    );
  }

  const db = new Database(join(home, ".omp", "stats.db"));
  db.run(SCHEMA);
  insertUser(db, parentFile, "u1", 1_700_000_001_000);
  insertUser(db, parentFile, "u2", 1_700_000_005_000);
  // 자식도 user_messages에 행을 남긴다(브리프가 자식에게는 사용자 메시지다).
  insertUser(db, childFile, "cu1", 1_700_000_002_000);
  insertMessage(db, parentFile, "a1", 1_700_000_002_000, "openai", "gpt-x", "toolUse");
  insertMessage(db, parentFile, "a2", 1_700_000_006_000, "openai", "gpt-x", "stop");
  insertMessage(db, childFile, "c1", 1_700_000_003_000, "vendor", "small-model", "stop");
  if (orphanFile) {
    insertUser(db, orphanFile, "ou1", 1_700_000_002_500);
    insertMessage(db, orphanFile, "o1", 1_700_000_003_500, "vendor", "orphan-model", "stop");
  }
  // 창에 모델·자식 message가 하나도 없는 run. 역할 목록이 빈 배열로 남는다.
  if (rolelessRun) insertUser(db, parentFile, "u3", 1_700_000_020_000);
  // 소요시간이 기록되지 않은 요청. 생성시간 합은 하한이 된다.
  db.query(
    `INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp,
       duration, ttft, stop_reason, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
       cost_cache_read, cost_cache_write, cost_total, agent_type, cost_unpriced)
     VALUES (?, 'ad1', ?, 'advice-model', 'vendor', 'chat', ?, NULL, NULL, 'stop', 4, 2, 0, 0, 6, 0, 0, 0, 0, 0, 0.01, 'advisor', 0)`,
  ).run(advisorFile, FOLDER, 1_700_000_006_500);
  // 마지막 모델 응답(1_700_000_006_000)보다 뒤에 남은 도구 호출.
  db.query(
    `INSERT INTO tool_calls (session_file, entry_id, tool_call_id, folder, tool_name, model,
       provider, timestamp, is_error) VALUES (?, 'a2', 'tc1', ?, 'bash', 'gpt-x', 'openai', ?, 0)`,
  ).run(parentFile, FOLDER, 1_700_000_009_000);
  db.close();

  return useTmpHome(home);
}

/** 요청 1건짜리 최소 세션. 미가격 판정만 보도록 provider와 가격을 직접 정한다. */
function makeCostFixture(provider, costTotal, costUnpriced) {
  const home = mkdtempSync(join(tmpdir(), "run-xray-cost-"));
  mkdirSync(join(home, ".omp"), { recursive: true });
  const projects = join(home, "projects");
  mkdirSync(projects, { recursive: true });
  const parentFile = join(projects, `2023-11-14T22-13-20-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(
    parentFile,
    [JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "요청" }] } })].join("\n"),
  );

  const db = new Database(join(home, ".omp", "stats.db"));
  db.run(SCHEMA);
  insertUser(db, parentFile, "u1", 1_700_000_001_000);
  // 토큰은 있고 가격은 0인 요청. 미가격으로 볼지는 provider·cost_unpriced가 가른다.
  db.query(
    `INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp,
       duration, ttft, stop_reason, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
       cost_cache_read, cost_cache_write, cost_total, agent_type, cost_unpriced)
     VALUES (?, 'a1', ?, 'model-x', ?, 'chat', ?, 500, 100, 'stop', 10, 5, 0, 0, 15, 0, 0, 0, 0, 0, ?, 'main', ?)`,
  ).run(parentFile, FOLDER, provider, 1_700_000_002_000, costTotal, costUnpriced);
  db.close();

  return useTmpHome(home);
}

/** 생성 시작 timestamp와 duration으로 겹치고 창 끝을 넘는 요청 구간을 만든다. */
function makeCoverageFixture() {
  const home = mkdtempSync(join(tmpdir(), "run-xray-coverage-"));
  mkdirSync(join(home, ".omp"), { recursive: true });
  const projects = join(home, "projects");
  mkdirSync(projects, { recursive: true });
  const parentFile = join(projects, `2023-11-14T22-13-20-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(
    parentFile,
    [
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "첫 요청" }] } }),
      JSON.stringify({ type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "둘째 요청" }] } }),
    ].join("\n"),
  );

  const db = new Database(join(home, ".omp", "stats.db"));
  db.run(SCHEMA);
  insertUser(db, parentFile, "u1", 1_700_000_001_000);
  insertUser(db, parentFile, "u2", 1_700_000_005_000);
  // [1000, 3500]과 [3000, 6000]: 500ms 겹치고 두 번째는 run 창 끝(5000)을 넘는다.
  insertMessage(db, parentFile, "a1", 1_700_000_001_000, "openai", "gpt-x", "toolUse", 2_500);
  insertMessage(db, parentFile, "a2", 1_700_000_003_000, "openai", "gpt-x", "stop", 3_000);
  db.close();

  return useTmpHome(home);
}

test("요청 timestamp를 생성 시작으로 해석해 겹침과 창 경계를 올바르게 센다", () => {
  const fixture = makeCoverageFixture();
  try {
    const summary = listRuns(SESSION_ID).runs.find((run) => run.index === 1);
    assert.ok(summary, "run 1이 있어야 한다");
    const detail = getRunDetail(SESSION_ID, summary.entryId);
    assert.equal(detail.wallClockMs, 4_000);
    assert.equal(detail.busyMs, 5_500);
    assert.equal(detail.unmeasuredMs, 0);
    assert.ok(!detail.unmeasured.includes("wait-attribution"));
    assert.ok(detail.bottlenecks.every((entry) => entry.kind !== "unmeasured-gap"));
  } finally {
    fixture.restore();
  }
});

test("자식 transcript를 역할로 잡고 창 시작 시점 effort를 이어받는다", () => {
  const fixture = makeFixture();
  try {
    const summary = listRuns(SESSION_ID).runs.find((run) => run.index === 1);
    assert.ok(summary, "run 1이 있어야 한다");
    assert.equal(summary.childCount, 1);
    const detail = getRunDetail(SESSION_ID, summary.entryId);
    const child = detail.roles.find((role) => role.id === "MakerOne");
    // 자식 경로 LIKE 패턴에서 구분자 `\`를 escape하지 않으면 조용히 0건이 된다.
    assert.ok(child, "자식 역할이 잡혀야 한다");
    assert.equal(child.kind, "maker");
    assert.equal(child.purpose, "primary");
    assert.deepEqual(child.efforts, ["max"]);
    // effort 변경이 창보다 앞에 있어도 그 값이 이 run에 적용된 값이다.
    assert.deepEqual(detail.roles.find((role) => role.id === "main")?.efforts, ["high"]);
    assert.ok(!detail.unmeasured.includes("effort-unrecorded"));
  } finally {
    fixture.restore();
  }
});

test("이름이 겹쳐 -N이 붙은 child도 같은 task의 역할로 귀속한다", () => {
  const fixture = makeFixture({ childName: "LiveVoiceContract-2.jsonl", taskName: "LiveVoiceContract" });
  try {
    const runs = listRuns(SESSION_ID).runs;
    const detail = getRunDetail(SESSION_ID, runs.find((run) => run.index === 1).entryId);
    const child = detail.roles.find((role) => role.id === "LiveVoiceContract-2");
    // 정확 일치가 실패했을 때만 접미사를 떼므로, 붙은 이름 그대로 역할에 남아야 한다.
    assert.ok(child, "-N child가 역할로 잡혀야 한다");
    assert.equal(child.kind, "maker");
    assert.equal(child.purpose, "primary");
  } finally {
    fixture.restore();
  }
});

test("경계 시각의 effort 변경은 다음 run 것이고 마지막 도구 호출까지 경과에 든다", () => {
  const fixture = makeFixture();
  try {
    const runs = listRuns(SESSION_ID).runs;
    const first = getRunDetail(SESSION_ID, runs.find((run) => run.index === 1).entryId);
    const second = getRunDetail(SESSION_ID, runs.find((run) => run.index === 2).entryId);
    // u2와 같은 시각의 변경이 run 1에 새면 경계 run의 구성 서명이 오염된다.
    assert.deepEqual(first.roles.find((role) => role.id === "main")?.efforts, ["high"]);
    assert.deepEqual(second.roles.find((role) => role.id === "main")?.efforts, ["low"]);
    // 마지막 모델 응답 뒤의 도구 호출(+3초)까지 창이 닫히지 않는다.
    assert.equal(second.wallClockMs, 1_700_000_009_000 - 1_700_000_005_000);
    assert.equal(second.toolTotals.find((tool) => tool.toolName === "bash")?.calls, 1);
  } finally {
    fixture.restore();
  }
});

test("창이 닫힌 뒤의 effort 변경은 마지막 run에 들어가지 않는다", () => {
  const fixture = makeFixture();
  try {
    const runs = listRuns(SESSION_ID).runs;
    // 목록은 최신순이므로 마지막 run은 배열 끝이 아니라 index가 가장 큰 것이다.
    const last = runs.reduce((a, b) => (b.index > a.index ? b : a));
    assert.equal(last.index, 2);
    const detail = getRunDetail(SESSION_ID, last.entryId);
    // 마지막 run은 뒤에 사용자 요청이 없어 상한을 따로 주지 않으면 이후 모든 기록을 삼킨다.
    assert.deepEqual(detail.roles.find((role) => role.id === "main")?.efforts, ["low"]);
    assert.ok(!detail.configSignature.includes("xhigh"));
  } finally {
    fixture.restore();
  }
});

test("advisor는 파일명 규약으로만 잡고 소요시간 미기록을 하한으로 드러낸다", () => {
  const fixture = makeFixture();
  try {
    const runs = listRuns(SESSION_ID).runs;
    const detail = getRunDetail(SESSION_ID, runs.find((run) => run.index === 2).entryId);
    const advisor = detail.roles.find((role) => role.id === "__advisor");
    assert.ok(advisor, "advisor 역할이 잡혀야 한다");
    assert.equal(advisor.kind, "advisor");
    assert.equal(advisor.purpose, null);
    // duration이 NULL이면 0으로 합산되므로 생성시간은 하한이다. 세지 않으면 조용히 감춰진다.
    assert.equal(advisor.untimedRequests, 1);
    assert.equal(advisor.busyMs, 0);
    assert.ok(detail.unmeasured.includes("busy-unrecorded"));
    // 구성 비교에서도 같은 하한이 드러나야 중앙값을 확정값으로 읽지 않는다.
    const configs = listExperiments(FOLDER, 30).configs;
    assert.equal(configs.reduce((sum, config) => sum + config.untimedRuns, 0), 1);
  } finally {
    fixture.restore();
  }
});

test("다음 요청이 창을 닫으면 running이 아니라 interrupted다", () => {
  const fixture = makeFixture();
  try {
    const runs = listRuns(SESSION_ID).runs;
    assert.equal(runs.find((run) => run.index === 1)?.outcome, "interrupted");
    assert.equal(runs.find((run) => run.index === 1)?.endedAt, 1_700_000_005_000);
    assert.equal(runs.find((run) => run.index === 2)?.outcome, "completed");
  } finally {
    fixture.restore();
  }
});

test("구성 비교는 자식 transcript를 독립 세션으로 세지 않는다", () => {
  const fixture = makeFixture();
  try {
    const result = listExperiments(FOLDER, 30);
    assert.equal(result.sessionCount, 1);
    assert.equal(result.runCount, 2);
    // 자식 모델은 maker 역할로만 나와야 하고 main 구성으로 올라오면 안 된다.
    assert.ok(
      result.configs.every((config) => !config.signature.startsWith("main=vendor/small-model")),
      "자식 transcript가 독립 세션으로 잡혔다",
    );
    assert.ok(
      result.configs.some((config) => config.signature.includes("maker x1=vendor/small-model")),
      "자식은 부모 run의 maker 역할로 남아야 한다",
    );
  } finally {
    fixture.restore();
  }
});

test("attributed 범위는 역할을 확정하지 못한 run을 그룹화 전에 뺀다", () => {
  const fixture = makeFixture({ orphanChild: "Orphan.jsonl" });
  try {
    const all = listExperiments(FOLDER, 30, "all");
    assert.equal(all.scope, "all");
    assert.equal(all.runCount, 2);
    assert.equal(all.excludedRunCount, 0);
    const attributed = listExperiments(FOLDER, 30, "attributed");
    assert.equal(attributed.scope, "attributed");
    assert.equal(attributed.runCount, 1);
    assert.equal(attributed.excludedRunCount, 1);
    // 걸러낸 run이 그룹화에 섞이면 구성별 run 수 합이 남은 run 수와 어긋난다.
    assert.equal(
      attributed.configs.reduce((sum, config) => sum + config.runCount, 0),
      1,
    );
  } finally {
    fixture.restore();
  }
});

test("attributed 범위는 역할이 하나도 없는 run도 제외한다", () => {
  const fixture = makeFixture({ rolelessRun: true });
  try {
    const all = listExperiments(FOLDER, 30, "all");
    assert.equal(all.runCount, 3);
    assert.equal(all.excludedRunCount, 0);
    const attributed = listExperiments(FOLDER, 30, "attributed");
    assert.equal(attributed.runCount, 2);
    assert.equal(attributed.excludedRunCount, 1);
    // 역할 없는 run이 그룹화에 섞이면 구성 서명이 빈 문자열인 묶음이 남는다.
    assert.ok(
      attributed.configs.every((config) => config.signature !== ""),
      "역할 없는 run이 빈 서명 구성으로 집계됐다",
    );
    assert.equal(
      attributed.configs.reduce((sum, config) => sum + config.runCount, 0),
      2,
    );
  } finally {
    fixture.restore();
  }
});

test("xai-oauth 구독 사용량은 0원이 아니라 미가격으로 계수한다", () => {
  // SuperGrok은 요청별 가격을 남기지 않는다. 조건에서 빼면 구독 사용량이 "무료"로 보인다.
  const fixture = makeCostFixture("xai-oauth", 0, 0);
  try {
    const runs = listRuns(SESSION_ID).runs;
    const main = getRunDetail(SESSION_ID, runs[0].entryId).roles.find((role) => role.id === "main");
    assert.equal(main?.unpricedRequests, 1);
  } finally {
    fixture.restore();
  }
});

test("카탈로그에 없는 provider의 0원은 미가격으로 오분류하지 않는다", () => {
  // 카드 없는 모델·무료 flat 카드의 0원은 실제 가격이다. 토큰만 보고 세면 오표시가 된다.
  const fixture = makeCostFixture("b-ai", 0, 0);
  try {
    const runs = listRuns(SESSION_ID).runs;
    const main = getRunDetail(SESSION_ID, runs[0].entryId).roles.find((role) => role.id === "main");
    assert.equal(main?.unpricedRequests, 0);
  } finally {
    fixture.restore();
  }
});
