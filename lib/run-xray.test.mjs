import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { createJiti } from "jiti";

// 설정되면 이 파일은 fixture 케이스 하나만 실행하는 자식 프로세스다(`fixtureTest` 참고).
const CHILD_CASE = process.env.RUN_XRAY_CASE;
const test = CHILD_CASE ? () => {} : nodeTest;

const jiti = createJiti(import.meta.url);
const {
  buildConfigSignature,
  classifyToolError,
  buildHarnessTimeline,
  getRunDetail,
  harnessRevisionAt,
  listExperiments,
  listRuns,
  median,
  parseHarnessDeployLog,
  parseTaskRoleMap,
  pickBottlenecks,
  unionCoverageMs,
} = await jiti.import("./run-xray.ts");
const { parseExperimentResponse } = await jiti.import("./hanse-efficiency-client.ts");

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

test("단일 역할은 관측값을 그대로 쓰고 effort가 없으면 ?로 쓴다", () => {
  const built = buildConfigSignature([
    { kind: "main", models: ["openai-codex/gpt-6-astra"], efforts: [] },
    { kind: "maker", models: [], efforts: ["high"] },
  ]);
  assert.equal(built.signature, "main=openai-codex/gpt-6-astra:?|maker x1=?:high");
  assert.equal(built.roles[0].effort, null);
  assert.equal(built.roles[1].model, "?");
  assert.deepEqual(built.roles.map((role) => role.pairing), ["single", "single"]);
  assert.deepEqual(built.roles[1].models, []);
});

test("첫 값이 같은 단일·혼합 역할은 서로 다른 구성이고 같은 집합이어도 짝·순서 미상이다", () => {
  const single = buildConfigSignature([{ kind: "main", models: ["model-A"], efforts: ["medium"] }]);
  const mixed = buildConfigSignature([{ kind: "main", models: ["model-A", "model-B"], efforts: ["medium", "high"] }]);
  assert.equal(single.signature, "main=model-A:medium");
  assert.equal(mixed.signature, "main={model-A,model-B}:{high,medium}");
  assert.notEqual(single.identity, mixed.identity);
  assert.equal(mixed.roles[0].pairing, "unknown");
  assert.equal(single.roles[0].pairing, "single");

  // 관측 순서·요청별 짝이 달라도 배열만으로는 구별할 수 없으므로 같은 집합 묶음이 되고, 그 사실은 pairing으로 남는다.
  const reordered = buildConfigSignature([{ kind: "main", models: ["model-B", "model-A"], efforts: ["high", "medium"] }]);
  assert.equal(reordered.identity, mixed.identity);
  assert.equal(reordered.roles[0].pairing, "unknown");

  // model 하나·effort 여러 개, model 여러 개·effort 미기록도 단일이 아니다.
  const effortOnly = buildConfigSignature([{ kind: "main", models: ["model-A"], efforts: ["medium", "high"] }]);
  assert.equal(effortOnly.signature, "main=model-A:{high,medium}");
  assert.equal(effortOnly.roles[0].pairing, "unknown");
  const unknownEffort = buildConfigSignature([{ kind: "main", models: ["model-A", "model-B"], efforts: [] }]);
  assert.equal(unknownEffort.signature, "main={model-A,model-B}:?");
  assert.equal(unknownEffort.roles[0].effort, null);
  assert.deepEqual(unknownEffort.roles[0].efforts, []);
  assert.equal(unknownEffort.roles[0].pairing, "unknown");
});

test("표시 서명이 같아도 구조 identity가 다르면 다른 구성이다", () => {
  const literal = buildConfigSignature([{ kind: "main", models: ["{a,b}"], efforts: ["low"] }]);
  const set = buildConfigSignature([{ kind: "main", models: ["a", "b"], efforts: ["low"] }]);
  assert.equal(literal.signature, set.signature);
  assert.notEqual(literal.identity, set.identity);
});

test("표시 라벨이 같은 역할이 섞여도 입력 순서와 무관하게 같은 identity·역할 순서이고 일반 정렬은 유지된다", () => {
  const roles = [
    { kind: "maker", models: ["{a,b}"], efforts: ["low"] },
    { kind: "maker", models: ["a", "b"], efforts: ["low"] },
    { kind: "checker", models: ["z"], efforts: ["high"] },
    { kind: "main", models: ["m"], efforts: ["high"] },
  ];
  const forward = buildConfigSignature(roles);
  const backward = buildConfigSignature([...roles].reverse());
  assert.equal(forward.identity, backward.identity);
  assert.equal(forward.signature, backward.signature);
  assert.deepEqual(forward.roles, backward.roles);
  // 같은 라벨 둘은 별개 역할로 남고(합쳐지지 않음), 종류·모델·effort 정렬은 그대로다.
  assert.deepEqual(forward.roles.map((role) => role.kind), ["main", "maker", "maker", "checker"]);
  assert.deepEqual(forward.roles.slice(1, 3).map((role) => role.models), [["a", "b"], ["{a,b}"]]);
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
// 하네스 revision: WSL 갱신 기록(`<UTC ISO> 단계 ...`)으로만 정하고 나머지는 unknown이다.
// ---------------------------------------------------------------------------

const REV_A = "a".repeat(40);
const REV_B = "b".repeat(40);
const REV_C = "c".repeat(40);

test("갱신 기록은 단계 줄만 읽고 빌드 출력·미리 빌드 실패는 사건으로 세지 않는다", () => {
  const events = parseHarnessDeployLog([
    `2026-10-10T02:31:16Z START old=${REV_A} target=${REV_B} distro=Ubuntu`,
    "2026-10-10T02:31:16Z HOLD pid=1918",
    "  READY 이건 빌드 출력이다",
    "2026-10-10T02:38:00Z FAIL prebuild of bbbbbbbbbbbb; the running version is unchanged",
    `2026-10-10T02:48:54Z READY ${REV_B} OK   web 127.0.0.1 GET /x -> 200 OK`,
    `2026-10-10T03:00:00Z ROLLED_BACK ${REV_B}`,
    `2026-10-10T04:00:00Z ROLLBACK_FAILED ${REV_C}`,
    "2026-10-10T05:00:00Z START old= target=x",
  ].join("\n"));
  assert.deepEqual(events.map((event) => [event.kind, event.revision]), [
    ["start", REV_A],
    ["ready", REV_B],
    ["rolled-back", REV_B],
    ["rollback-failed", null],
    ["start", null],
  ]);
  assert.equal(events[1].at, Date.parse("2026-10-10T02:48:54Z"));
});

test("첫 기록 이전은 unknown이고 READY 시각과 같은 run부터 새 revision이다", () => {
  const start = Date.parse("2026-10-11T01:54:06Z");
  const ready = Date.parse("2026-10-11T02:01:31Z");
  const timeline = buildHarnessTimeline([
    { at: ready, kind: "ready", revision: REV_B },
    { at: start, kind: "start", revision: REV_A },
  ]);
  assert.equal(harnessRevisionAt(timeline, start - 1), null);
  assert.equal(harnessRevisionAt(timeline, start), REV_A);
  assert.equal(harnessRevisionAt(timeline, ready - 1), REV_A);
  assert.equal(harnessRevisionAt(timeline, ready), REV_B);
  assert.equal(harnessRevisionAt([], ready), null);
});

test("하루 안에 revision이 바뀌면 run 시작 시각으로 나누고 일치하는 START는 구간을 잇는다", () => {
  const at = (time) => Date.parse(`2026-10-11T${time}Z`);
  const timeline = buildHarnessTimeline([
    { at: at("02:55:57"), kind: "start", revision: REV_A },
    { at: at("03:04:39"), kind: "ready", revision: REV_B },
    { at: at("09:17:45"), kind: "start", revision: REV_B },
    { at: at("09:25:43"), kind: "ready", revision: REV_C },
  ]);
  assert.equal(harnessRevisionAt(timeline, at("05:00:00")), REV_B);
  // 09:17 START는 old가 직전 READY와 같으므로 구간을 끊거나 unknown으로 만들지 않는다.
  assert.equal(harnessRevisionAt(timeline, at("09:20:00")), REV_B);
  assert.equal(harnessRevisionAt(timeline, at("12:00:00")), REV_C);
});

test("START old가 직전 revision과 다르면 바뀐 시각을 모르는 직전 구간 전체가 unknown이다", () => {
  const at = (time) => Date.parse(`2026-10-09T${time}Z`);
  const timeline = buildHarnessTimeline([
    { at: at("01:00:00"), kind: "ready", revision: REV_A },
    // 기록 밖에서 B로 바뀌었다. 01:00~05:00의 어느 run이 A였는지는 알 수 없다.
    { at: at("05:00:00"), kind: "start", revision: REV_B },
    { at: at("05:10:00"), kind: "ready", revision: REV_C },
  ]);
  assert.equal(harnessRevisionAt(timeline, at("01:00:00")), null);
  assert.equal(harnessRevisionAt(timeline, at("04:59:59")), null);
  assert.equal(harnessRevisionAt(timeline, at("05:00:00")), REV_B);
  assert.equal(harnessRevisionAt(timeline, at("05:10:00")), REV_C);
});

test("되돌림 성공은 이전 revision을 잇고 되돌림 실패는 그 시각부터 unknown이다", () => {
  const at = (time) => Date.parse(`2026-10-09T${time}Z`);
  const timeline = buildHarnessTimeline([
    { at: at("01:00:00"), kind: "start", revision: REV_A },
    { at: at("01:08:00"), kind: "rolled-back", revision: REV_A },
    { at: at("02:00:00"), kind: "start", revision: REV_A },
    { at: at("02:09:00"), kind: "rollback-failed", revision: null },
  ]);
  assert.equal(harnessRevisionAt(timeline, at("01:30:00")), REV_A);
  assert.equal(harnessRevisionAt(timeline, at("02:08:59")), REV_A);
  assert.equal(harnessRevisionAt(timeline, at("02:09:00")), null);
});

test("도구 오류 분류: 중단·건너뜀은 도구와 무관하게 중단이다", () => {
  const skip = "실행하지 않음: 이 호출이 실행되기 전에 사용자 메시지가 도착했다. 다시 호출하라.";
  assert.equal(classifyToolError("read", null, skip), "cancelled");
  assert.equal(classifyToolError("bash", "ls", skip), "cancelled");
  assert.equal(classifyToolError("bash", "sleep 9", "[Command cancelled]\npartial"), "cancelled");
  assert.equal(classifyToolError("bash", "sleep 9", "x\n\n[Command aborted]"), "cancelled");
  assert.equal(classifyToolError("bash", "sleep 9", "x\n\n[Command aborted]\n\n[artifact capture failed]"), "cancelled");
  assert.equal(classifyToolError("bash", "sleep 9", "Command aborted"), "cancelled");
});

test("도구 오류 분류: 명령 출력이 하네스 표지를 흉내 내도 위치가 다르면 중단·무일치가 아니다", () => {
  const exit2 = (body) => `${body}\n\nCommand exited with code 2`;
  assert.equal(classifyToolError("bash", "grep -F '[Command aborted]' a.txt missing.txt", exit2("a.txt:[Command aborted]")), "failed");
  assert.equal(classifyToolError("bash", "echo hi", exit2("note: [Command cancelled] seen")), "failed");
  // 출력에 찍힌 `Command exited with code 1` 줄은 마지막 상태 줄이 아니다.
  assert.equal(classifyToolError("bash", "grep foo bar", exit2("Command exited with code 1\nmore")), "failed");
  assert.equal(classifyToolError("bash", "grep foo bar", "Command exited with code 1\n\nCommand exited with code 2"), "failed");
  // 맨 앞 표지가 있어도 종료 줄이 붙어 있으면 명령이 흉내 낸 것이다.
  assert.equal(classifyToolError("bash", "printf '[Command cancelled]\\n'; exit 2", "[Command cancelled]\n\nCommand exited with code 2"), "failed");
  assert.equal(classifyToolError("bash", "printf 'x\\n\\n[Command aborted]'; exit 3", "x\n\n[Command aborted]\n\nCommand exited with code 3"), "failed");
  assert.equal(classifyToolError("bash", "cd /nonexistent 2>/dev/null && grep foo bar", "\n\nCommand exited with code 1"), "failed");
  assert.equal(classifyToolError("bash", "cd /nonexistent >/dev/null 2>&1 && grep foo bar", "\n\nCommand exited with code 1"), "failed");
  assert.equal(classifyToolError("bash", "cd /nonexistent &>/dev/null && grep foo bar", "\n\nCommand exited with code 1"), "failed");
  assert.equal(classifyToolError("bash", "cd /nonexistent 2>&- && grep foo bar", "\n\nCommand exited with code 1"), "failed");
  // 마지막 grep 자신의 stderr 억제는 무일치 판정에 영향이 없다.
  assert.equal(classifyToolError("bash", "cd x && grep foo bar 2>/dev/null", "\n\nCommand exited with code 1"), "noMatch");
  assert.equal(classifyToolError("bash", "cd x && grep -c foo bar", "0\n\nCommand exited with code 1"), "noMatch");
  assert.equal(classifyToolError("read", null, "ENOENT"), "failed");
});

test("도구 오류 분류: exit 1의 grep·test류 마지막 명령만 무일치다", () => {
  const exit1 = "\n\nCommand exited with code 1";
  assert.equal(classifyToolError("bash", "grep foo bar", exit1), "noMatch");
  assert.equal(classifyToolError("bash", "cd x && grep -c foo bar", "0\n\nCommand exited with code 1"), "noMatch");
  // cd가 실패하면 grep은 실행되지 않았다. 셸 오류 표지가 있으면 무일치로 보지 않는다.
  const noDir = "bash: line 1: cd: /nonexistent: No such file or directory\n\nCommand exited with code 1";
  assert.equal(classifyToolError("bash", "cd /nonexistent && grep foo bar", noDir), "failed");
  assert.equal(classifyToolError("bash", "grep foo bar", "bash: foo: command not found\n\nCommand exited with code 1"), "failed");
  assert.equal(classifyToolError("bash", "grep foo bar", "syntax error near x\n\nCommand exited with code 1"), "failed");
});

test("도구 오류 분류: 따옴표 안 구분자와 heredoc은 마지막 명령으로 읽지 않는다", () => {
  const exit1 = "\n\nCommand exited with code 1";
  assert.equal(classifyToolError("bash", `python -c 'raise Exception("; grep foo")'`, exit1), "failed");
  assert.equal(classifyToolError("bash", `echo "a && grep x"`, exit1), "failed");
  assert.equal(classifyToolError("bash", `echo a\\; grep x`, exit1), "failed");
  assert.equal(classifyToolError("bash", "python - <<'PY'\nprint(1)\nPY\ngrep foo bar", exit1), "failed");
  assert.equal(classifyToolError("bash", "cat <<-EOF\ngrep foo\nEOF", exit1), "failed");
  assert.equal(classifyToolError("bash", `grep 'a;b' file`, exit1), "noMatch");
  assert.equal(classifyToolError("bash", `echo x; grep "a|b" file`, exit1), "noMatch");
  assert.equal(classifyToolError("bash", `grep foo <<< "$x"`, exit1), "noMatch");
  assert.equal(classifyToolError("bash", `grep 'unterminated`, exit1), "failed");
  assert.equal(classifyToolError("bash", "echo a; test -f nope", exit1), "noMatch");
  assert.equal(classifyToolError("bash", "[ -d x ]", exit1), "noMatch");
  assert.equal(classifyToolError("bash", "[[ -d x ]]\n", exit1), "noMatch");
  assert.equal(classifyToolError("bash", "ls | rg foo", exit1), "noMatch");
  assert.equal(classifyToolError("bash", "grep foo | head", exit1), "failed");
  assert.equal(classifyToolError("bash", "ls nope", exit1), "failed");
  assert.equal(classifyToolError("bash", "grep foo bar; ls", exit1), "failed");
  assert.equal(classifyToolError("bash", "grep foo bar", "\n\nCommand exited with code 2"), "failed");
  assert.equal(classifyToolError("bash", "grep foo bar", "\n\nCommand exited with code 10"), "failed");
  assert.equal(classifyToolError("bash", null, exit1), "failed");
  assert.equal(classifyToolError("eval", "grep foo", exit1), "failed");
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

function insertMessage(db, sessionFile, entryId, timestamp, provider, model, stopReason, duration = 500, ttft = 100) {
  db.query(
    `INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp,
       duration, ttft, stop_reason, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
       cost_cache_read, cost_cache_write, cost_total, agent_type, cost_unpriced)
     VALUES (?, ?, ?, ?, ?, 'chat', ?, ?, ?, ?, 10, 5, 0, 0, 15, 0, 0, 0, 0, 0, 0.25, 'main', 0)`,
  ).run(sessionFile, entryId, FOLDER, model, provider, timestamp, duration, ttft, stopReason);
}

function insertUser(db, sessionFile, entryId, timestamp) {
  db.query(
    `INSERT INTO user_messages (session_file, entry_id, folder, timestamp, chars, words,
       yelling, profanity, anguish) VALUES (?, ?, ?, ?, 10, 2, 0, 0, 0)`,
  ).run(sessionFile, entryId, FOLDER, timestamp);
}

/** 임시 HOME에 stats.db와 부모/자식 transcript를 만든다. */
function makeFixture({
  childName = "MakerOne.jsonl",
  taskName = "MakerOne",
  agent = "maker",
  orphanChild = null,
  rolelessRun = false,
} = {}) {
  const home = homedir();
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

}

/** 요청 1건짜리 최소 세션. 미가격 판정만 보도록 provider와 가격을 직접 정한다. */
function makeCostFixture(provider, costTotal, costUnpriced) {
  const home = homedir();
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

}

/** 생성 시작 timestamp와 duration으로 겹치고 창 끝을 넘는 요청 구간을 만든다. */
function makeCoverageFixture() {
  const home = homedir();
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

}

/**
 * 대화 밖 보조 호출(`model_usage`)과 첫 토큰 대기(ttft)가 섞인 세션. stats.db는 보조 호출도
 * `messages`에 duration·ttft 없이 넣으므로 transcript의 `model_usage` id가 유일한 구분 근거다.
 */
function makeHelperFixture() {
  const home = homedir();
  mkdirSync(join(home, ".omp"), { recursive: true });
  const parentFile = join(home, "projects", `2023-11-14T22-13-20-000Z_${SESSION_ID}.jsonl`);
  const childFile = join(parentFile.slice(0, -".jsonl".length), "MakerOne.jsonl");
  mkdirSync(join(parentFile.slice(0, -".jsonl".length)), { recursive: true });
  const usageLine = (id, purpose, role) => JSON.stringify({ type: "model_usage", id, parentId: null, purpose, role });
  writeFileSync(
    parentFile,
    [
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "첫 요청" }] } }),
      taskLine("MakerOne", "maker", "PURPOSE: primary"),
      usageLine("mu1", "skim", "skim"),
      JSON.stringify({ type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "보조 호출만 있는 요청" }] } }),
      usageLine("mu2", "find", "typesafe"),
      JSON.stringify({ type: "message", id: "u3", message: { role: "user", content: [{ type: "text", text: "옛 기록" }] } }),
    ].join("\n"),
  );
  writeFileSync(
    childFile,
    [
      JSON.stringify({ type: "message", id: "cu1", message: { role: "user", content: [{ type: "text", text: "브리프" }] } }),
      JSON.stringify({ type: "model_usage", id: "cmu1", parentId: null, purpose: "skim" }),
    ].join("\n"),
  );
  const db = new Database(join(home, ".omp", "stats.db"));
  db.run(SCHEMA);
  insertUser(db, parentFile, "u1", 1_700_000_001_000);
  insertUser(db, parentFile, "u2", 1_700_000_010_000);
  insertUser(db, parentFile, "u3", 1_700_000_020_000);
  insertUser(db, childFile, "cu1", 1_700_000_002_500);
  insertMessage(db, parentFile, "a1", 1_700_000_002_000, "openai", "gpt-x", "toolUse", 3_000, 1_200.5);
  // 기록된 0은 미기록(null)과 다르다. 평균 분모에 들어간다.
  insertMessage(db, parentFile, "a2", 1_700_000_006_000, "openai", "gpt-x", "stop", 1_000, 0);
  // 최종 답변 뒤에 남은 보조 호출. `stop`이지만 결과·요청 수·생성시간을 바꾸면 안 된다.
  insertMessage(db, parentFile, "mu1", 1_700_000_006_500, "google-antigravity", "gemini-3.8-flash", "stop", null, null);
  insertMessage(db, childFile, "c1", 1_700_000_003_000, "vendor", "small-model", "stop", 500, 300);
  insertMessage(db, childFile, "cmu1", 1_700_000_003_200, "opencode-go", "deepseek-v4.1-flash", "stop", null, null);
  // run 2에는 대화 응답 없이 보조 호출만 있다.
  insertMessage(db, parentFile, "mu2", 1_700_000_011_000, "openrouter", "typesafe/jev-1.13", "stop", null, null);
  // run 3은 ttft 열이 비어 있던 옛 기록이다.
  insertMessage(db, parentFile, "a3", 1_700_000_021_000, "openai", "gpt-x", "stop", 500, null);
  db.close();
}

/** 마지막 run에서 Main이 도구 실행 중(`toolUse`)인데 그 뒤에 judge 보조 호출이 `stop`으로 남은 세션. */
function makeInFlightHelperFixture() {
  const home = homedir();
  mkdirSync(join(home, ".omp"), { recursive: true });
  mkdirSync(join(home, "projects"), { recursive: true });
  const parentFile = join(home, "projects", `2023-11-14T22-13-20-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(
    parentFile,
    [
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "도구 실행 중" }] } }),
      JSON.stringify({ type: "model_usage", id: "mu1", parentId: null, purpose: "unexpected-stop", role: "typesafe" }),
    ].join("\n"),
  );
  const db = new Database(join(home, ".omp", "stats.db"));
  db.run(SCHEMA);
  insertUser(db, parentFile, "u1", 1_700_000_001_000);
  insertMessage(db, parentFile, "a1", 1_700_000_002_000, "openai", "gpt-x", "toolUse", 1_000, 400);
  insertMessage(db, parentFile, "mu1", 1_700_000_004_000, "openrouter", "typesafe/jev-1.13", "stop", null, null);
  db.close();
}

/**
 * 같은 구성(main gpt-x)의 run 3개와 그 사이의 WSL 갱신 기록. 1_700_000_000_000은 2023-11-14T22:13:20Z다.
 * run 1(22:13:21)은 첫 기록(START 22:13:23) 이전이라 unknown, run 2(22:13:25)는 A, run 3(22:13:29)은
 * READY(22:13:27) 뒤라 B다.
 */
function makeHarnessFixture() {
  const home = homedir();
  mkdirSync(join(home, ".omp", "wsl-update"), { recursive: true });
  mkdirSync(join(home, "projects"), { recursive: true });
  const parentFile = join(home, "projects", `2023-11-14T22-13-20-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(
    parentFile,
    ["u1", "u2", "u3"]
      .map((id) => JSON.stringify({ type: "message", id, message: { role: "user", content: [{ type: "text", text: id }] } }))
      .join("\n"),
  );
  writeFileSync(
    join(home, ".omp", "wsl-update", "20231114T221323Z.log"),
    [
      `2023-11-14T22:13:23Z START old=${REV_A} target=${REV_B} distro=Ubuntu`,
      "빌드 출력 READY 무시",
      `2023-11-14T22:13:27Z READY ${REV_B} OK   web 127.0.0.1 -> 200 OK`,
    ].join("\n"),
  );
  const db = new Database(join(home, ".omp", "stats.db"));
  db.run(SCHEMA);
  insertUser(db, parentFile, "u1", 1_700_000_001_000);
  insertUser(db, parentFile, "u2", 1_700_000_005_000);
  insertUser(db, parentFile, "u3", 1_700_000_009_000);
  insertMessage(db, parentFile, "a1", 1_700_000_002_000, "openai", "gpt-x", "stop");
  insertMessage(db, parentFile, "a2", 1_700_000_006_000, "openai", "gpt-x", "stop");
  insertMessage(db, parentFile, "a3", 1_700_000_010_000, "openai", "gpt-x", "stop");
  db.close();
}

// 임시 HOME에 세션 파일과 stats.db를 만드는 테스트들이다. Linux의 Bun은 `os.homedir()`을
// 시작 때 한 번만 읽어 실행 중 `HOME` 교체가 먹지 않으므로, 케이스마다 새 HOME으로 띄운 자식
// 프로세스에서 돌린다(fixture는 자식의 `homedir()`에 만든다). 평소 CI에서 0.3~0.5초지만,
// 러너가 느린 순간(run 36275079772·36276227870)에는 7~10초가 걸려 bun 기본 5초를 넘겼다.
// 다시 돌리면 코드 변경 없이 통과했으므로 제한만 넉넉히 둔다.
const FIXTURE_TEST = { timeout: 30_000 };
// Bun의 transpiler 캐시는 `$HOME/.bun/install/cache`에 쌓여, 케이스마다 새 HOME이면 자식마다
// 캐시가 비어 의존 그래프를 다시 변환한다. HOME 격리는 유지하고 변환 캐시 위치만 분리해
// 자식들이 공유한다.
const BUN_CACHE = join(tmpdir(), "run-xray-bun-cache");
const childCases = new Map();

function fixtureTest(name, body) {
  if (CHILD_CASE) {
    if (name === CHILD_CASE) childCases.set(name, body);
    return;
  }
  nodeTest(name, FIXTURE_TEST, () => {
    const home = mkdtempSync(join(tmpdir(), "run-xray-"));
    try {
      const result = spawnSync(process.execPath, ["run", fileURLToPath(import.meta.url)], {
        env: { ...process.env, RUN_XRAY_CASE: name, HOME: home, USERPROFILE: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: BUN_CACHE },
        encoding: "utf8",
        timeout: 60_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.ok(result.status === 0 && output.includes(`CASE OK ${name}`), output.trim());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

fixtureTest("요청 timestamp를 생성 시작으로 해석해 겹침과 창 경계를 올바르게 센다", () => {
  makeCoverageFixture();
  const summary = listRuns(SESSION_ID).runs.find((run) => run.index === 1);
  assert.ok(summary, "run 1이 있어야 한다");
  const detail = getRunDetail(SESSION_ID, summary.entryId);
  assert.equal(detail.wallClockMs, 4_000);
  assert.equal(detail.busyMs, 5_500);
  assert.equal(detail.unmeasuredMs, 0);
  assert.ok(!detail.unmeasured.includes("wait-attribution"));
  assert.ok(detail.bottlenecks.every((entry) => entry.kind !== "unmeasured-gap"));
});

fixtureTest("보조 호출은 호출 역할의 내역으로만 한 번 세고 첫 응답 대기는 기록된 대화 요청만 평균한다", () => {
  makeHelperFixture();
  const byIndex = new Map(listRuns(SESSION_ID).runs.map((run) => [run.index, run]));

  const first = getRunDetail(SESSION_ID, byIndex.get(1).entryId);
  const main = first.roles.find((role) => role.id === "main");
  const child = first.roles.find((role) => role.id === "MakerOne");
  assert.equal(first.outcome, "completed");
  assert.equal(main.requestCount, 2);
  assert.equal(main.busyMs, 4_000);
  assert.equal(main.untimedRequests, 0);
  assert.ok(!first.unmeasured.includes("busy-unrecorded"), "보조 호출의 빈 duration으로 생성시간을 하한 처리하면 안 된다");
  assert.deepEqual(main.models, ["openai/gpt-x"]);
  assert.equal(main.ttftMs, 1_200.5);
  assert.equal(main.ttftRequests, 2);
  assert.deepEqual(main.helpers.map((helper) => [helper.purpose, helper.role, helper.model, helper.requestCount, helper.totalTokens]), [
    ["skim", "skim", "google-antigravity/gemini-3.8-flash", 1, 15],
  ]);
  assert.equal(main.totalTokens, 45);
  assert.equal(main.estimatedCostUsd, 0.75);
  // 자식의 보조 호출은 자식 것이다.
  assert.deepEqual(child.helpers.map((helper) => [helper.purpose, helper.role, helper.model]), [
    ["skim", null, "opencode-go/deepseek-v4.1-flash"],
  ]);
  assert.equal(child.requestCount, 1);
  assert.equal(child.ttftMs, 300);
  // run 합계는 역할 합계와 같다. helpers를 다시 더하지 않는다.
  assert.equal(first.totalTokens, 75);
  assert.equal(first.estimatedCostUsd, 1.25);
  assert.equal(byIndex.get(1).totalTokens, 75);
  assert.equal(first.configSignature, "main=openai/gpt-x:?|maker x1=vendor/small-model:?");

  // 대화 응답 없이 보조 호출만 있던 run은 "완료"가 아니다. 비용은 그대로 남는다.
  const second = getRunDetail(SESSION_ID, byIndex.get(2).entryId);
  assert.equal(second.outcome, "interrupted");
  assert.equal(second.roles[0].requestCount, 0);
  assert.equal(second.roles[0].ttftMs, null);
  assert.equal(second.roles[0].helpers[0].purpose, "find");
  assert.equal(second.totalTokens, 15);

  // ttft가 없던 옛 기록은 0이 아니라 미측정이다.
  const third = getRunDetail(SESSION_ID, byIndex.get(3).entryId);
  assert.equal(third.roles[0].ttftMs, null);
  assert.equal(third.roles[0].ttftRequests, 0);
  assert.equal(third.roles[0].requestCount, 1);
});

fixtureTest("도구 실행 중인 마지막 run은 뒤에 남은 보조 호출 stop으로 완료가 되지 않고 비용은 남는다", () => {
  makeInFlightHelperFixture();
  const [summary] = listRuns(SESSION_ID).runs;
  assert.equal(summary.outcome, "running");
  assert.equal(summary.endedAt, null);
  assert.equal(summary.totalTokens, 30);
  assert.equal(summary.estimatedCostUsd, 0.5);
  const detail = getRunDetail(SESSION_ID, summary.entryId);
  assert.equal(detail.roles[0].requestCount, 1);
  assert.equal(detail.roles[0].helpers[0].purpose, "unexpected-stop");
});

fixtureTest("자식 transcript를 역할로 잡고 창 시작 시점 effort를 이어받는다", () => {
  makeFixture();
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
});

fixtureTest("이름이 겹쳐 -N이 붙은 child도 같은 task의 역할로 귀속한다", () => {
  makeFixture({ childName: "LiveVoiceContract-2.jsonl", taskName: "LiveVoiceContract" });
  const runs = listRuns(SESSION_ID).runs;
  const detail = getRunDetail(SESSION_ID, runs.find((run) => run.index === 1).entryId);
  const child = detail.roles.find((role) => role.id === "LiveVoiceContract-2");
  // 정확 일치가 실패했을 때만 접미사를 떼므로, 붙은 이름 그대로 역할에 남아야 한다.
  assert.ok(child, "-N child가 역할로 잡혀야 한다");
  assert.equal(child.kind, "maker");
  assert.equal(child.purpose, "primary");
});

fixtureTest("경계 시각의 effort 변경은 다음 run 것이고 마지막 도구 호출까지 경과에 든다", () => {
  makeFixture();
  const runs = listRuns(SESSION_ID).runs;
  const first = getRunDetail(SESSION_ID, runs.find((run) => run.index === 1).entryId);
  const second = getRunDetail(SESSION_ID, runs.find((run) => run.index === 2).entryId);
  // u2와 같은 시각의 변경이 run 1에 새면 경계 run의 구성 서명이 오염된다.
  assert.deepEqual(first.roles.find((role) => role.id === "main")?.efforts, ["high"]);
  assert.deepEqual(second.roles.find((role) => role.id === "main")?.efforts, ["low"]);
  // 마지막 모델 응답 뒤의 도구 호출(+3초)까지 창이 닫히지 않는다.
  assert.equal(second.wallClockMs, 1_700_000_009_000 - 1_700_000_005_000);
  assert.equal(second.toolTotals.find((tool) => tool.toolName === "bash")?.calls, 1);
});

fixtureTest("도구 오류를 실패·무일치·중단으로 가르고 합이 is_error 합과 같다", () => {
  const home = homedir();
  mkdirSync(join(home, ".omp"), { recursive: true });
  const parentFile = join(home, "projects", `2023-11-14T22-13-20-000Z_${SESSION_ID}.jsonl`);
  const childDir = parentFile.slice(0, -".jsonl".length);
  const childFile = join(childDir, "MakerOne.jsonl");
  mkdirSync(childDir, { recursive: true });
  const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
  const assistant = (id, ...blocks) => JSON.stringify({ type: "message", id, message: { role: "assistant", content: blocks } });
  const result = (id, toolCallId, toolName, text, isError = true) =>
    JSON.stringify({ type: "message", id, message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError } });
  const user = (id) => JSON.stringify({ type: "message", id, message: { role: "user", content: [{ type: "text", text: "요청" }] } });
  writeFileSync(
    parentFile,
    [
      user("u1"),
      assistant(
        "a1",
        call("g1", "bash", { command: "cd x && grep -c foo bar" }),
        call("g2", "bash", { command: "ls nope" }),
        call("g3", "bash", { command: "sleep 99" }),
        call("g4", "bash", { command: "grep foo file" }),
        call("g5", "read", { path: "x" }),
      ),
      result("r1", "g1", "bash", "0\n\nCommand exited with code 1"),
      result("r2", "g2", "bash", "ls: cannot access\n\nCommand exited with code 1"),
      result("r3", "g3", "bash", "partial\n\n[Command aborted]"),
      result("r4", "g4", "bash", "ok", false),
      result("r5", "g5", "read", "실행하지 않음: 이 호출이 실행되기 전에 사용자 메시지가 도착했다. 다시 필요하면 호출하라."),
    ].join("\n"),
  );
  writeFileSync(
    childFile,
    [
      user("cu1"),
      assistant("ca1", call("c1", "bash", { command: "test -f a; grep zzz b | wc -l; rg q" })),
      result("cr1", "c1", "bash", "Command exited with code 1"),
    ].join("\n"),
  );
  const db = new Database(join(home, ".omp", "stats.db"));
  db.run(SCHEMA);
  insertUser(db, parentFile, "u1", 1_700_000_001_000);
  insertUser(db, childFile, "cu1", 1_700_000_002_000);
  insertMessage(db, parentFile, "m1", 1_700_000_002_000, "openai", "gpt-x", "stop");
  insertMessage(db, childFile, "cm1", 1_700_000_003_000, "vendor", "small-model", "stop");
  const insertTool = (file, id, name, isError) =>
    db
      .query(
        `INSERT INTO tool_calls (session_file, entry_id, tool_call_id, folder, tool_name, model,
           provider, timestamp, is_error) VALUES (?, 'm1', ?, ?, ?, 'gpt-x', 'openai', ?, ?)`,
      )
      .run(file, id, FOLDER, name, 1_700_000_004_000, isError);
  insertTool(parentFile, "g1", "bash", 1);
  insertTool(parentFile, "g2", "bash", 1);
  insertTool(parentFile, "g3", "bash", 1);
  insertTool(parentFile, "g4", "bash", 0);
  insertTool(parentFile, "g5", "read", 1);
  // transcript에 없는 오류 행은 조용히 빠지지 않고 실패로 센다.
  insertTool(parentFile, "gone", "bash", 1);
  insertTool(childFile, "c1", "bash", 1);
  db.close();

  const [summary] = listRuns(SESSION_ID).runs;
  const totals = new Map(getRunDetail(SESSION_ID, summary.entryId).toolTotals.map((tool) => [tool.toolName, tool]));
  const bash = totals.get("bash");
  assert.equal(bash.calls, 6);
  // g1 무일치, g2 ls exit 1 실패, g3 중단, gone 실패(미상), c1은 마지막 단순 명령이 rg라 무일치.
  assert.deepEqual([bash.failed, bash.noMatch, bash.cancelled], [2, 2, 1]);
  assert.deepEqual([totals.get("read").failed, totals.get("read").noMatch, totals.get("read").cancelled], [0, 0, 1]);
  const sum = [...totals.values()].reduce((acc, tool) => acc + tool.failed + tool.noMatch + tool.cancelled, 0);
  assert.equal(sum, 6, "세 분류의 합은 기존 is_error 합(6)과 같아야 한다");
});

fixtureTest("창이 닫힌 뒤의 effort 변경은 마지막 run에 들어가지 않는다", () => {
  makeFixture();
  const runs = listRuns(SESSION_ID).runs;
  // 목록은 최신순이므로 마지막 run은 배열 끝이 아니라 index가 가장 큰 것이다.
  const last = runs.reduce((a, b) => (b.index > a.index ? b : a));
  assert.equal(last.index, 2);
  const detail = getRunDetail(SESSION_ID, last.entryId);
  // 마지막 run은 뒤에 사용자 요청이 없어 상한을 따로 주지 않으면 이후 모든 기록을 삼킨다.
  assert.deepEqual(detail.roles.find((role) => role.id === "main")?.efforts, ["low"]);
  assert.ok(!detail.configSignature.includes("xhigh"));
});

fixtureTest("advisor는 파일명 규약으로만 잡고 소요시간 미기록을 하한으로 드러낸다", () => {
  makeFixture();
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
});

fixtureTest("다음 요청이 창을 닫으면 running이 아니라 interrupted다", () => {
  makeFixture();
  const runs = listRuns(SESSION_ID).runs;
  assert.equal(runs.find((run) => run.index === 1)?.outcome, "interrupted");
  assert.equal(runs.find((run) => run.index === 1)?.endedAt, 1_700_000_005_000);
  assert.equal(runs.find((run) => run.index === 2)?.outcome, "completed");
});

fixtureTest("구성 비교는 자식 transcript를 독립 세션으로 세지 않는다", () => {
  makeFixture();
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
});

fixtureTest("attributed 범위는 역할을 확정하지 못한 run을 그룹화 전에 뺀다", () => {
  makeFixture({ orphanChild: "Orphan.jsonl" });
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
});

fixtureTest("attributed 범위는 역할이 하나도 없는 run도 제외한다", () => {
  makeFixture({ rolelessRun: true });
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
});

fixtureTest("xai-oauth 구독 사용량은 0원이 아니라 미가격으로 계수한다", () => {
  // SuperGrok은 요청별 가격을 남기지 않는다. 조건에서 빼면 구독 사용량이 "무료"로 보인다.
  makeCostFixture("xai-oauth", 0, 0);
  const runs = listRuns(SESSION_ID).runs;
  const main = getRunDetail(SESSION_ID, runs[0].entryId).roles.find((role) => role.id === "main");
  assert.equal(main?.unpricedRequests, 1);
});

fixtureTest("카탈로그에 없는 provider의 0원은 미가격으로 오분류하지 않는다", () => {
  // 카드 없는 모델·무료 flat 카드의 0원은 실제 가격이다. 토큰만 보고 세면 오표시가 된다.
  makeCostFixture("b-ai", 0, 0);
  const runs = listRuns(SESSION_ID).runs;
  const main = getRunDetail(SESSION_ID, runs[0].entryId).roles.find((role) => role.id === "main");
  assert.equal(main?.unpricedRequests, 0);
});

fixtureTest("run마다 시작 시각의 하네스 revision이 붙고 구성 비교는 기본 묶음을 유지한 채 나누기·필터를 고른다", () => {
  makeHarnessFixture();
  const byIndex = new Map(listRuns(SESSION_ID).runs.map((run) => [run.index, run]));
  assert.equal(byIndex.get(1).harnessRevision, null);
  assert.equal(byIndex.get(2).harnessRevision, REV_A);
  assert.equal(byIndex.get(3).harnessRevision, REV_B);
  assert.equal(getRunDetail(SESSION_ID, byIndex.get(3).entryId).harnessRevision, REV_B);
  // 하네스는 구성 서명에 섞이지 않는다.
  assert.equal(byIndex.get(2).configSignature, byIndex.get(3).configSignature);

  // 기본 보기는 기존과 같은 구성 하나이고, 어떤 하네스의 run을 담았는지만 덧붙인다.
  const merged = listExperiments(FOLDER, 30);
  assert.equal(merged.groupBy, "config");
  assert.equal(merged.harness, null);
  assert.equal(merged.configs.length, 1);
  assert.equal(merged.configs[0].runCount, 3);
  assert.deepEqual(merged.configs[0].harnesses, [
    { revision: REV_B, runCount: 1 },
    { revision: REV_A, runCount: 1 },
    { revision: null, runCount: 1 },
  ]);
  assert.deepEqual(merged.harnesses, merged.configs[0].harnesses);

  // 나누면 같은 서명이 하네스마다 따로 나오고 최근 하네스가 먼저 온다.
  const split = listExperiments(FOLDER, 30, "all", "harness");
  assert.equal(split.groupBy, "harness");
  assert.deepEqual(
    split.configs.map((config) => [config.signature, config.harnesses.map((entry) => entry.revision), config.runCount]),
    [
      [merged.configs[0].signature, [REV_B], 1],
      [merged.configs[0].signature, [REV_A], 1],
      [merged.configs[0].signature, [null], 1],
    ],
  );

  // 필터는 집계만 좁히고 선택지는 그대로 둔다.
  const onlyA = listExperiments(FOLDER, 30, "all", "config", REV_A);
  assert.equal(onlyA.harness, REV_A);
  assert.equal(onlyA.runCount, 1);
  assert.equal(onlyA.configs[0].medianWallClockMs, 4_000);
  assert.equal(onlyA.harnesses.length, 3);
  const onlyUnknown = listExperiments(FOLDER, 30, "all", "config", "unknown");
  assert.equal(onlyUnknown.runCount, 1);
  assert.deepEqual(onlyUnknown.configs[0].harnesses, [{ revision: null, runCount: 1 }]);
});

/**
 * 같은 세션의 run 3개. run 1은 gpt-x·medium 하나뿐이고, run 2·3은 첫 모델이 gpt-x/gpt-y로 다르지만 같은 모델 집합과
 * {medium, high} effort를 관측한다. 첫 관측값(gpt-x:medium)만 보면 run 1·2가 같은 구성으로 합쳐진다.
 */
function makeMixedFixture() {
  const home = homedir();
  mkdirSync(join(home, ".omp"), { recursive: true });
  mkdirSync(join(home, "projects"), { recursive: true });
  const parentFile = join(home, "projects", `2023-11-14T22-13-20-000Z_${SESSION_ID}.jsonl`);
  const user = (id) => JSON.stringify({ type: "message", id, message: { role: "user", content: [{ type: "text", text: id }] } });
  const level = (time, thinkingLevel) => JSON.stringify({ type: "thinking_level_change", thinkingLevel, timestamp: `2023-11-14T${time}Z` });
  writeFileSync(
    parentFile,
    [
      level("22:13:19.000", "medium"),
      user("u1"),
      user("u2"),
      level("22:13:27.000", "high"),
      user("u3"),
      level("22:13:29.000", "medium"),
      level("22:13:31.000", "high"),
    ].join("\n"),
  );
  const db = new Database(join(home, ".omp", "stats.db"));
  db.run(SCHEMA);
  insertUser(db, parentFile, "u1", 1_700_000_001_000);
  insertUser(db, parentFile, "u2", 1_700_000_005_000);
  insertUser(db, parentFile, "u3", 1_700_000_009_000);
  insertMessage(db, parentFile, "a1", 1_700_000_002_000, "openai", "gpt-x", "stop");
  insertMessage(db, parentFile, "a2", 1_700_000_006_000, "openai", "gpt-x", "toolUse");
  insertMessage(db, parentFile, "a3", 1_700_000_007_000, "openai", "gpt-y", "stop");
  insertMessage(db, parentFile, "a4", 1_700_000_010_000, "openai", "gpt-y", "toolUse");
  insertMessage(db, parentFile, "a5", 1_700_000_012_000, "openai", "gpt-x", "stop");
  db.close();
}

fixtureTest("첫 모델·effort가 같은 단일 run과 혼합 run은 구성 비교에서 합쳐지지 않고 짝 미상으로 표시된다", () => {
  makeMixedFixture();
  const runs = new Map(listRuns(SESSION_ID).runs.map((run) => [run.index, run]));
  // 요약의 서명은 run 상세 서명과 같고, 단일 run은 기존 서명 그대로다.
  assert.equal(runs.get(1).configSignature, "main=openai/gpt-x:medium");
  assert.equal(runs.get(2).configSignature, "main={openai/gpt-x,openai/gpt-y}:{high,medium}");
  assert.equal(runs.get(3).configSignature, runs.get(2).configSignature);
  const detail = getRunDetail(SESSION_ID, runs.get(2).entryId);
  // 역할의 관측 배열은 지워지지 않는다. 순서는 관측 순서 그대로다.
  assert.deepEqual(detail.roles[0].models, ["openai/gpt-x", "openai/gpt-y"]);
  assert.deepEqual(detail.roles[0].efforts, ["medium", "high"]);

  const result = listExperiments(FOLDER, 30);
  assert.equal(result.runCount, 3);
  assert.equal(result.configs.length, 2);
  const [mixed, single] = result.configs;
  assert.equal(mixed.runCount, 2);
  assert.equal(mixed.signature, "main={openai/gpt-x,openai/gpt-y}:{high,medium}");
  assert.deepEqual(mixed.roles.map((role) => [role.models, role.efforts, role.pairing]), [
    [["openai/gpt-x", "openai/gpt-y"], ["high", "medium"], "unknown"],
  ]);
  assert.equal(single.runCount, 1);
  assert.equal(single.signature, "main=openai/gpt-x:medium");
  assert.deepEqual(single.roles.map((role) => [role.models, role.efforts, role.pairing]), [
    [["openai/gpt-x"], ["medium"], "single"],
  ]);
  // 비용은 run 별 합을 한 번씩만 더한다(요청 2개 x 0.25, 요청 1개 x 0.25).
  assert.equal(mixed.totalEstimatedCostUsd, 1);
  assert.equal(single.totalEstimatedCostUsd, 0.25);

  // 하네스 기준으로 나눠도 혼합 run은 단일 run과 섞이지 않는다.
  const split = listExperiments(FOLDER, 30, "all", "harness");
  assert.deepEqual(split.configs.map((config) => [config.signature, config.runCount]), [
    ["main={openai/gpt-x,openai/gpt-y}:{high,medium}", 2],
    ["main=openai/gpt-x:medium", 1],
  ]);

  // API 응답(JSON)은 클라이언트 검증을 통과하고, 새 필수 필드가 빠지면 거부된다.
  const wire = JSON.parse(JSON.stringify(result));
  assert.equal(parseExperimentResponse(wire).configs[0].roles[0].pairing, "unknown");
  for (const field of ["pairing", "models", "efforts"]) {
    const broken = JSON.parse(JSON.stringify(result));
    delete broken.configs[0].roles[0][field];
    assert.throws(() => parseExperimentResponse(broken), /구성 비교 응답/, `${field} 누락을 거부해야 한다`);
  }
});

if (CHILD_CASE) {
  const body = childCases.get(CHILD_CASE);
  if (!body) throw new Error(`unknown case: ${CHILD_CASE}`);
  await body();
  console.log(`CASE OK ${CHILD_CASE}`);
}
