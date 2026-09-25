import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createHanseSubagentClient, mergeSubagentRecords, readExplicitTaskTitle, resolveSubagentRole, resolveSubagentModelMeta, resolveSubagentTaskPresentation } = await jiti.import("./hanse-subagent-client.ts");

function roleRecord(agent, extra = {}) {
  return {
    key: "live:role",
    identity: "live",
    live: { id: "role", index: 0, agent, agentSource: "project", status: "running", lastUpdate: 100, ...extra },
  };
}

function live(id, status, sessionFile) {
  return {
    id,
    index: 0,
    agent: "maker",
    agentSource: "bundled",
    status,
    sessionFile,
    lastUpdate: 100,
  };
}

function archived(name, modified = 90) {
  return {
    name,
    bytes: 1024,
    modified,
    messages: 4,
    firstTask: `task for ${name}`,
  };
}

test("merges a live snapshot and disk record with the same identity", () => {
  const snapshot = live("worker-a", "running", "C:\\sessions\\worker-a.jsonl");
  const disk = archived("worker-a");
  const result = mergeSubagentRecords([snapshot], [disk]);

  assert.equal(result.length, 1);
  assert.equal(result[0].identity, "live-archive");
  assert.equal(result[0].live, snapshot);
  assert.equal(result[0].archive, disk);
  assert.equal(result[0].live.status, "running");
});

test("uses the live sessionFile basename when the display id differs", () => {
  const snapshot = live("worker-display", "completed", "/sessions/worker-on-disk.jsonl");
  const disk = archived("worker-on-disk");
  const result = mergeSubagentRecords([snapshot], [disk]);

  assert.equal(result.length, 1);
  assert.equal(result[0].identity, "live-archive");
  assert.equal(result[0].archive.name, "worker-on-disk");
  assert.equal(result[0].live.status, "completed");
});

test("keeps live-only and archive-only identity states explicit", () => {
  const running = live("running-only", "pending");
  const disk = archived("archive-only");
  const result = mergeSubagentRecords([running], [disk]);

  assert.deepEqual(result.map((record) => record.identity), ["live", "archive"]);
  assert.equal(result[0].live.status, "pending");
  assert.equal(result[0].archive, undefined);
  assert.equal(result[1].live, undefined);
  assert.equal(result[1].archive, disk);
  assert.equal(Object.hasOwn(result[1], "status"), false);
});

test("never assigns a completed status merely because a disk record exists", () => {
  const [record] = mergeSubagentRecords([], [archived("history")]);
  assert.equal(record.identity, "archive");
  assert.equal(record.live, undefined);
  assert.equal("status" in record, false);
});

test("preserves live order and appends unmatched disk history in server order", () => {
  const first = live("first", "failed");
  const second = live("second", "aborted");
  const result = mergeSubagentRecords(
    [first, second],
    [archived("second", 300), archived("older", 200), archived("oldest", 100)],
  );

  assert.deepEqual(result.map((record) => record.key), [
    "live:first",
    "live:second",
    "archive:older",
    "archive:oldest",
  ]);
  assert.equal(result[0].live.status, "failed");
  assert.equal(result[1].live.status, "aborted");
  assert.equal(result[1].identity, "live-archive");
});

test("normalizes separators in the live agent id while keeping the source id intact", () => {
  assert.deepEqual(resolveSubagentRole(roleRecord("maker-deep")), {
    kind: "known",
    agent: "maker-deep",
    source: "project",
    label: "maker deep",
  });
  assert.equal(resolveSubagentRole(roleRecord("Interaction_Tester")).label, "interaction tester");
  assert.equal(resolveSubagentRole(roleRecord("Interaction_Tester")).agent, "Interaction_Tester");
  assert.equal(resolveSubagentRole(roleRecord("  checker-deep  ")).agent, "checker-deep");
});

test("keeps an unrecognized custom agent id as a role instead of guessing", () => {
  const role = resolveSubagentRole(roleRecord("factory.comm/audit", { agentSource: "user" }));
  assert.deepEqual(role, {
    kind: "known",
    agent: "factory.comm/audit",
    source: "user",
    label: "factory comm audit",
  });
});

test("falls back to live progress metadata when the snapshot agent is blank", () => {
  const withProgress = roleRecord("", { progress: { agent: "validator" } });
  assert.equal(resolveSubagentRole(withProgress).kind, "known");
  assert.equal(resolveSubagentRole(withProgress).agent, "validator");
  assert.deepEqual(resolveSubagentRole(roleRecord("   ")), { kind: "unknown" });
  assert.deepEqual(resolveSubagentRole(roleRecord("-_-")), { kind: "unknown" });
});

test("never infers a role for archive-only records", () => {
  const [record] = mergeSubagentRecords([], [archived("maker-deep-20260911")]);
  assert.deepEqual(resolveSubagentRole(record), { kind: "unknown" });
});

test("keeps explicit TASK_TITLE stable while progress shows the follow-up stage", () => {
  const assignment = [
    "TASK_GUARD:",
    "WORK_CLASS: feature",
    "PRIMARY_DELIVERABLE: 카드가 실제 업무를 표시한다",
    "OWNED_PATHS: src/",
    "TASK_TITLE: 서브카드 실제 담당업무 표시",
    "TODO_TASKS: [\"stable title 구현\", \"focused 검증\"]",
  ].join("\n");
  const record = roleRecord("maker", {
    assignment,
    task: "follow-up hub DM: 검증만 실행해줘",
    progress: {
      task: "follow-up hub DM: 검증만 실행해줘",
      lastIntent: "focused 검증 실행",
      currentTool: "bash",
    },
  });

  assert.deepEqual(resolveSubagentTaskPresentation(record), {
    title: "서브카드 실제 담당업무 표시",
    stage: "focused 검증 실행 · bash",
    explicitTitle: true,
  });
  assert.equal(readExplicitTaskTitle(assignment), "서브카드 실제 담당업무 표시");
});

test("ignores TASK_TITLE lookalikes inside TASK_GUARD and uses archive metadata", () => {
  const guardOnly = [
    "TASK_GUARD:",
    "WORK_CLASS: feature",
    "PRIMARY_DELIVERABLE: TASK_TITLE: 가짜 제목",
    "OWNED_PATHS: src/",
  ].join("\n");
  assert.equal(readExplicitTaskTitle(guardOnly), null);
  assert.equal(readExplicitTaskTitle("TASK_TITLE: English title"), null);
  const presentation = resolveSubagentTaskPresentation({
    key: "live-archive:stable",
    identity: "live-archive",
    archiveMatch: "session-file",
    live: {
      ...live("stable", "running"),
      task: "검증만 이어서 실행해줘",
      progress: { currentTool: "bash" },
    },
    archive: { ...archived("stable"), taskTitle: "아카이브에 기록된 원래 업무" },
  });
  assert.equal(presentation.title, "아카이브에 기록된 원래 업무");
  assert.equal(presentation.stage, "bash 실행 중");
  const staleArchive = resolveSubagentTaskPresentation({
    key: "live-archive:stale",
    identity: "live-archive",
    archiveMatch: "name",
    live: { ...live("stale", "running"), task: "현재 런 업무" },
    archive: { ...archived("stale"), taskTitle: "이전 런 업무" },
  });
  assert.equal(staleArchive.title, "담당 업무 미확인");
  const legacySameRun = resolveSubagentTaskPresentation({
    key: "live-archive:legacy",
    identity: "live-archive",
    archiveMatch: "session-file",
    live: {
      ...live("legacy", "running"),
      task: "후속 DM의 긴 실행 지시",
      progress: {
        task: "후속 DM의 긴 실행 지시",
        lastIntent: "검증 이어서 실행",
        currentTool: "bash",
      },
    },
    archive: { ...archived("legacy"), firstTask: "과거 TASK_GUARD 전문" },
  });
  assert.deepEqual(legacySameRun, {
    title: "담당 업무 미확인",
    stage: "검증 이어서 실행 · bash",
    explicitTitle: false,
  });
});

test("shows only recorded model and effort, never a guess", () => {
  const liveRun = {
    key: "live:a",
    identity: "live",
    live: {
      id: "a",
      index: 0,
      agent: "maker",
      agentSource: "project",
      status: "running",
      lastUpdate: 0,
      progress: { resolvedModel: "anthropic/claude-opus-5", resolvedModelIsFallback: true },
    },
  };
  const meta = resolveSubagentModelMeta(liveRun);
  assert.equal(meta.model, "anthropic/claude-opus-5");
  assert.equal(meta.modelShort, "claude-opus-5");
  assert.equal(meta.modelIsFallback, true);
  // 실시간 스냅샷에는 추론 강도 기록이 없다 - 역할이나 전역 설정에서 채우지 않는다.
  assert.equal(meta.effort, null);

  const unobserved = resolveSubagentModelMeta({ key: "archive:h", identity: "archive", archive: archived("h") });
  assert.deepEqual(unobserved, { model: null, modelShort: null, modelIsFallback: false, effort: null });
});

test("reads model, fallback and effort from one run generation only", () => {
  const liveSnapshot = (extra) => ({
    id: "b",
    index: 0,
    agent: "maker",
    agentSource: "project",
    status: "running",
    lastUpdate: 0,
    progress: { resolvedModel: "openai/gpt-5" },
    ...extra,
  });
  const otherRunArchive = { ...archived("b"), model: "anthropic/claude-opus-5", modelIsFallback: true, thinkingLevel: "high" };

  // 이름만 겹친 아카이브는 이전 런의 기록이므로 fallback도 effort도 근거가 아니다.
  const [nameMatched] = mergeSubagentRecords([liveSnapshot()], [otherRunArchive]);
  assert.equal(nameMatched.archiveMatch, "name");
  const nameMeta = resolveSubagentModelMeta(nameMatched);
  assert.equal(nameMeta.model, "openai/gpt-5");
  assert.equal(nameMeta.modelIsFallback, false);
  assert.equal(nameMeta.effort, null);

  // 이 런의 sessionFile 로 일치한 아카이브는 같은 세대이므로 effort가 관측된다.
  const [sameRun] = mergeSubagentRecords(
    [liveSnapshot({ sessionFile: "/s/agents/run-77.jsonl" })],
    [{ ...otherRunArchive, name: "run-77" }],
  );
  assert.equal(sameRun.archiveMatch, "session-file");
  const sameRunMeta = resolveSubagentModelMeta(sameRun);
  assert.equal(sameRunMeta.model, "openai/gpt-5");
  assert.equal(sameRunMeta.effort, "high");

  const archiveOnly = resolveSubagentModelMeta({
    key: "archive:c",
    identity: "archive",
    archive: { ...archived("c"), model: "  anthropic/claude-sonnet-5  ", modelIsFallback: true, thinkingLevel: " medium " },
  });
  assert.equal(archiveOnly.model, "anthropic/claude-sonnet-5");
  assert.equal(archiveOnly.modelIsFallback, true);
  assert.equal(archiveOnly.effort, "medium");
});

test("reads archives through same-origin routes while preserving archive-base injection", async () => {
  const calls = [];
  const sessionId = "11111111-1111-1111-1111-111111111111";
  const fetchImpl = async (url, init) => {
    const value = String(url);
    calls.push({ url: value, method: init.method });
    if (value.includes("/transcript?")) {
      return new Response(JSON.stringify({
        sessionId,
        name: "worker-a",
        bytes: 0,
        truncated: false,
        entries: [],
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      sessionId,
      dir: "C:/sessions",
      found: true,
      subagents: [],
    }), { headers: { "Content-Type": "application/json" } });
  };

  const client = createHanseSubagentClient(fetchImpl);
  await client.getArchive(sessionId);
  await client.getArchiveTranscript(sessionId, "worker-a", 25);
  await createHanseSubagentClient(fetchImpl, "/test-subagent").getArchive(sessionId);

  assert.deepEqual(calls, [
    {
      url: `/api/sidecars/subagent/archive?session=${sessionId}`,
      method: "GET",
    },
    {
      url: `/api/sidecars/subagent/transcript?session=${sessionId}&name=worker-a&limit=25`,
      method: "GET",
    },
    {
      url: `/test-subagent/archive?session=${sessionId}`,
      method: "GET",
    },
  ]);
});
