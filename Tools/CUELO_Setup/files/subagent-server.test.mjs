// subagent-server.js 사이드카의 /archive·/transcript 계약 테스트.
// fixture JSONL을 임시 agent dir에 쓰고 실제 서버 프로세스를 띄워 응답을 확인한다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const SERVER = join(import.meta.dirname, "subagent-server.js");

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

// 정상 종료 자식: user → irc 수신 → assistant(text + yield) → session_exit.
const COMPLETED_CHILD = jsonl([
  { type: "model_change", model: "openai/gpt-5", resolvedModelIsFallback: false, timestamp: "2026-09-20T09:00:00.000Z" },
  { type: "thinking_level_change", thinkingLevel: "medium", configured: null, timestamp: "2026-09-20T09:00:00.100Z" },
  { type: "message", timestamp: "2026-09-20T09:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "인사해줘" }] } },
  {
    type: "custom_message",
    customType: "irc:incoming",
    content: "<irc>…</irc>",
    details: { id: "abc123", from: "Main", message: "추석 인사 부탁" },
    timestamp: "2026-09-20T09:00:02.000Z",
  },
  {
    type: "message",
    timestamp: "2026-09-20T09:00:03.000Z",
    message: {
      role: "assistant",
      provider: "openai",
      model: "gpt-5",
      credentialId: 3,
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "생각 중" },
        { type: "text", text: "추석 잘 보내" },
        { type: "toolCall", id: "call_y1", name: "yield", arguments: { data: "추석 잘 보내" } },
      ],
    },
  },
  { type: "custom", customType: "session_exit", data: { reason: "dispose", kind: "normal" }, timestamp: "2026-09-20T09:00:04.000Z" },
]);

// 실패 자식: 마지막 assistant가 stopReason error + errorMessage.
const FAILED_CHILD = jsonl([
  { type: "message", timestamp: "2026-09-20T09:10:00.000Z", message: { role: "user", content: [{ type: "text", text: "실패할 작업" }] } },
  {
    type: "message",
    timestamp: "2026-09-20T09:10:01.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-opus-5",
      credentialId: 9,
      stopReason: "error",
      errorMessage: "지정 OAuth 계정이 현재 사용할 수 없습니다.",
      content: [{ type: "text", text: "" }],
    },
  },
]);

// 재개 뒤 중단된 자식: 첫 실행은 정상 exit, 새 user 입력 뒤에는 종료 기록이 없다.
// 옛 session_exit 때문에 completed로 둥글리면 안 된다.
const RESUMED_THEN_ABORTED = jsonl([
  { type: "message", timestamp: "2026-09-20T09:20:00.000Z", message: { role: "user", content: [{ type: "text", text: "첫 작업" }] } },
  {
    type: "message",
    timestamp: "2026-09-20T09:20:01.000Z",
    message: { role: "assistant", provider: "openai", model: "gpt-5", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "yield", arguments: { data: "첫 답" } }] },
  },
  { type: "custom", customType: "session_exit", data: { reason: "dispose", kind: "normal" }, timestamp: "2026-09-20T09:20:02.000Z" },
  { type: "message", timestamp: "2026-09-20T09:30:00.000Z", message: { role: "user", content: [{ type: "text", text: "이어서" }] } },
  {
    type: "message",
    timestamp: "2026-09-20T09:30:01.000Z",
    message: { role: "assistant", provider: "openai", model: "gpt-5", stopReason: "toolUse", content: [{ type: "toolCall", id: "c2", name: "read", arguments: {} }] },
  },
]);

// 실패한 yield(isError)는 성공 근거가 아니다.
const FAILED_YIELD = jsonl([
  { type: "message", timestamp: "2026-09-20T09:40:00.000Z", message: { role: "user", content: [{ type: "text", text: "작업" }] } },
  {
    type: "message",
    timestamp: "2026-09-20T09:40:01.000Z",
    message: { role: "assistant", provider: "openai", model: "gpt-5", stopReason: "toolUse", content: [{ type: "toolCall", id: "c3", name: "yield", arguments: { data: "x" } }] },
  },
  {
    type: "message",
    timestamp: "2026-09-20T09:40:02.000Z",
    message: { role: "toolResult", toolCallId: "c3", toolName: "yield", isError: true, content: [{ type: "text", text: "yield rejected" }] },
  },
]);

// 최초 assignment의 명시 제목은 follow-up IRC와 별개로 보존한다.
const TITLED_CHILD = jsonl([
  {
    type: "message",
    timestamp: "2026-09-20T09:50:00.000Z",
    message: {
      role: "user",
      content: [{
        type: "text",
        text: "TASK_GUARD:\nWORK_CLASS: feature\nPRIMARY_DELIVERABLE: 카드가 실제 담당업무를 표시한다\nOWNED_PATHS: src/\nTASK_TITLE: 서브카드 실제 담당업무 표시\nTODO_TASKS: [\"stable title 구현\", \"focused 검증\"]",
      }],
    },
  },
  {
    type: "custom_message",
    customType: "irc:incoming",
    details: { id: "followup", from: "Main", message: "검증만 이어서 실행해줘" },
    timestamp: "2026-09-20T09:50:01.000Z",
  },
]);

// 포트 충돌과 기존 프로세스 오인을 피하려고 매번 다른 포트를 고르고, health 응답의
// port가 요청한 값과 같은지 확인해 우리가 띄운 프로세스인지 검증한다.
async function startSidecar(t, agentDir) {
  const port = 32000 + Math.floor(Math.random() * 7000);
  const server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OMP_SUBAGENT_PORT: String(port), PI_CODING_AGENT_DIR: agentDir },
    stdio: "ignore",
  });
  let exited = false;
  const exitPromise = new Promise((resolve) => server.once("exit", () => { exited = true; resolve(); }));
  t.after(async () => {
    if (!exited) server.kill();
    await exitPromise;
  });

  for (let i = 0; i < 50; i += 1) {
    if (exited) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.port === port) return { port };
      }
    } catch { /* 아직 안 떴다 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`sidecar did not start on port ${port}`);
}

function makeAgentDir(t, children) {
  const root = mkdtempSync(join(tmpdir(), "omp-subagent-"));
  const sessionDir = join(root, "sessions", "ws", `2026-09-20T09-00-00-000Z_${SESSION_ID}`);
  mkdirSync(sessionDir, { recursive: true });
  for (const [name, content] of Object.entries(children)) {
    writeFileSync(join(sessionDir, `${name}.jsonl`), content);
  }
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return root;
}

test("archive 목록이 종료 상태를 기록에서 복원한다", async (t) => {
  const root = makeAgentDir(t, {
    DoneChild: COMPLETED_CHILD,
    FailedChild: FAILED_CHILD,
    ResumedChild: RESUMED_THEN_ABORTED,
    FailedYield: FAILED_YIELD,
    TitledChild: TITLED_CHILD,
  });
  const { port } = await startSidecar(t, root);

  const res = await fetch(`http://127.0.0.1:${port}/archive?session=${SESSION_ID}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  const byName = new Map(body.subagents.map((record) => [record.name, record]));

  const done = byName.get("DoneChild");
  assert.equal(done.status, "completed");
  assert.equal(done.model, "openai/gpt-5");
  assert.equal(done.thinkingLevel, "medium");
  assert.equal(done.firstTask, "인사해줘");

  const failed = byName.get("FailedChild");
  assert.equal(failed.status, "failed");
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.errorMessage, "지정 OAuth 계정이 현재 사용할 수 없습니다.");

  // 재개 뒤 종료 기록이 없으면 옛 session_exit로 completed를 만들지 않는다.
  assert.equal(byName.get("ResumedChild").status, null);
  // isError인 yield는 성공 근거가 아니다.
  assert.equal(byName.get("FailedYield").status, null);
  assert.equal(byName.get("TitledChild").taskTitle, "서브카드 실제 담당업무 표시");
});

test("transcript가 assistant 본문과 irc 수신 경계를 실어 보낸다", async (t) => {
  const root = makeAgentDir(t, { DoneChild: COMPLETED_CHILD });
  const { port } = await startSidecar(t, root);

  const res = await fetch(`http://127.0.0.1:${port}/transcript?session=${SESSION_ID}&name=DoneChild`);
  const body = await res.json();
  assert.equal(res.status, 200);

  const irc = body.entries.find((entry) => entry.irc);
  assert.ok(irc, "irc:incoming entry missing");
  assert.equal(irc.irc.from, "Main");
  assert.equal(irc.irc.message, "추석 인사 부탁");
  assert.equal(irc.irc.truncated, undefined);

  const assistant = body.entries.find((entry) => entry.message?.role === "assistant");
  assert.ok(assistant, "assistant message entry missing");
  // thinking은 빠지고 text와 yield 호출만 남는다.
  assert.deepEqual(
    assistant.message.content.map((part) => part.type),
    ["text", "toolCall"],
  );
  assert.equal(assistant.message.content[0].text, "추석 잘 보내");
  const yieldCall = assistant.message.content[1];
  assert.equal(yieldCall.toolName, "yield");
  assert.equal(yieldCall.input.data, "추석 잘 보내");
  assert.equal(assistant.message.provider, "openai");
  assert.equal(assistant.message.credentialId, 3);
});
