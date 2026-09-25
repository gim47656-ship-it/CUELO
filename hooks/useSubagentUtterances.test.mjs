import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  anchorCharacterSummonChildren,
  archiveSnapshot,
  utterancesForChild,
} = await jiti.import("./useSubagentUtterances.ts");
const { archiveTranscriptEntries } = await jiti.import("./useSubagentTranscripts.ts");
const { buildInlineTurns } = await jiti.import("../lib/inline-utterance.ts");


// 자식의 답은 assistant 메시지에서 나온다. 텍스트 블록이 있으면 그것이 답이고, 없으면 `yield`
// 도구 호출이 실어 온 보고 본문(`input.data.report`)이 답이다 — 보고만 남기고 끝난 자식도
// 대화창에서 자기 목소리를 가져야 한다. 사고 과정, 다른 도구 호출, 보고가 아닌 구조적 payload
// 는 여전히 대화창의 몫이 아니다.
//
// 실측 대조(세션 2026-09-19T06-14-35-755Z): 자식 ISANA3 은 [thinking, text, toolCall:yield] 이고
// 그 text 블록과 `arguments.data.report` 가 1537바이트로 완전히 같다 — 그래서 report 가 곧
// 대화창에 그려지던 답이다. ISANA·ISANA2 는 텍스트 블록 없이 yield 만 남겨 아무것도 그려지지
// 않았다(이 테스트가 잡는 회귀).

/** 자식 하나. provider 는 런타임이 기록한 모델 id 앞머리에서 온다. */
function child(status = "completed") {
  return {
    snapshot: {
      id: "ISANA",
      index: 0,
      agent: "maker",
      agentSource: "user",
      status,
      lastUpdate: 0,
      parentToolCallId: "call_task_1",
      progress: { resolvedModel: "anthropic/claude-opus-4-5" },
    },
    turnIndex: 3,
    sends: [],
  };
}

/** 실시간 기록 읽기 결과. 발화는 여기의 assistant 메시지에서만 나온다. */
function read(entries) {
  return { state: { kind: "ready-live", entries }, entries };
}

/** 도구 호출 표기는 `normalizeToolCalls` 가 지난 뒤의 모양이다(`name`→`toolName`). */
function assistantView(content) {
  return {
    id: `entry-${content.length}`,
    message: { role: "assistant", model: "claude-opus-4-5", provider: "anthropic", content },
  };
}

const thinking = { type: "thinking", thinking: "정리 중" };

function yieldCall(data) {
  return { type: "toolCall", toolCallId: "call_yield", toolName: "yield", input: { data } };
}

function parentTaskMessage(task) {
  return {
    role: "assistant",
    model: "gpt-daybreak-blue-latest",
    provider: "openai-codex",
    content: [{
      type: "toolCall",
      toolCallId: "call_task_1",
      toolName: "task",
      input: { tasks: [{ name: "ISANA", agent: "maker", task }] },
    }],
  };
}

function turnsForTask(task) {
  return buildInlineTurns(
    [{ role: "user", content: "작업해 줘" }, parentTaskMessage(task)],
    ["entry-user", "entry-assistant"],
  );
}

test("일반 top-level child는 대화 본문 화자로 연결하지 않는다", () => {
  const turns = turnsForTask("TASK_GUARD:\nWORK_CLASS: feature\n\n일반 구현 작업");

  assert.equal(turns[0].taskToolCallIds[0], "call_task_1");
  assert.deepEqual(turns[0].characterSummons, []);
  assert.deepEqual(anchorCharacterSummonChildren(turns, [child("running").snapshot]), []);
});

test("command guard의 character-summon 마커가 있는 child만 대화 본문에 연결한다", () => {
  const turns = turnsForTask([
    '[character-summon alias="MIO(미오)" model="anthropic/claude-opus-5" oauth-position="1"]',
    "# 캐릭터 호출 런타임 계약",
    "미오의 답변",
  ].join("\n"));

  const anchored = anchorCharacterSummonChildren(turns, [child("running").snapshot]);

  assert.equal(anchored.length, 1);
  assert.equal(anchored[0].snapshot.id, "ISANA");
  assert.equal(anchored[0].turnIndex, 0);
  assert.equal(anchored[0].summon.alias, "MIO(미오)");
  assert.equal(anchored[0].summon.model, "anthropic/claude-opus-5");
});

test("한 task 호출의 tasks[] 배치는 name으로 각 자식의 요청을 가른다", () => {
  const parent = {
    role: "assistant",
    model: "gpt-6-astra",
    provider: "openai-codex",
    content: [{
      type: "toolCall",
      toolCallId: "call_batch",
      toolName: "task",
      input: {
        tasks: [
          { name: "ISANA", agent: "maker", task: '[character-summon alias="ISANA(이사나)" model="b-ai/deepseek-v4.1-flash"]\n인사해 줘.' },
          { name: "NOVA", agent: "maker", task: '[character-summon alias="NOVA(노바)" model="opencode-go/muse-spark-1.3-contributor"]\n인사해 줘.' },
          { name: "Helper", agent: "maker", task: "TASK_GUARD:\nWORK_CLASS: feature\n\n마커 없는 일반 작업" },
        ],
      },
    }],
  };
  const turns = buildInlineTurns(
    [{ role: "user", content: "모두 불러 줘" }, parent],
    ["entry-user", "entry-assistant"],
  );
  const snapshots = ["ISANA", "NOVA", "Helper"].map((id) => ({
    ...child("running").snapshot,
    id,
    parentToolCallId: "call_batch",
  }));

  const anchored = anchorCharacterSummonChildren(turns, snapshots);

  // 마커 없는 Helper는 대화 본문에 연결하지 않는다.
  assert.equal(anchored.length, 2);
  assert.equal(anchored[0].snapshot.id, "ISANA");
  assert.equal(anchored[0].summon.model, "b-ai/deepseek-v4.1-flash");
  assert.equal(anchored[1].snapshot.id, "NOVA");
  assert.equal(anchored[1].summon.model, "opencode-go/muse-spark-1.3-contributor");
});
test("이름 없는 마커 하나가 든 다항목 배치는 근거 없는 child에 요청을 배정하지 않는다", () => {
  const parent = {
    role: "assistant",
    model: "gpt-6-astra",
    provider: "openai-codex",
    content: [{
      type: "toolCall",
      toolCallId: "call_mixed",
      toolName: "task",
      input: {
        tasks: [
          { task: '[character-summon alias="ISANA(이사나)" model="b-ai/deepseek-v4.1-flash"]\n인사해 줘.' },
          { task: "TASK_GUARD:\nWORK_CLASS: feature\n\n마커 없는 일반 작업" },
        ],
      },
    }],
  };
  const turns = buildInlineTurns(
    [{ role: "user", content: "불러 줘" }, parent],
    ["entry-user", "entry-assistant"],
  );
  // 자기 task 원문에 마커가 있는 자식만 그 요청을 받는다.
  const summoned = { ...child("running").snapshot, id: "ISANA", parentToolCallId: "call_mixed",
    task: '[character-summon alias="ISANA(이사나)" model="b-ai/deepseek-v4.1-flash"]\n인사해 줘.' };
  const plain = { ...child("running").snapshot, id: "Helper", parentToolCallId: "call_mixed",
    task: "TASK_GUARD:\nWORK_CLASS: feature\n\n마커 없는 일반 작업" };

  const anchored = anchorCharacterSummonChildren(turns, [summoned, plain]);

  assert.equal(anchored.length, 1);
  assert.equal(anchored[0].snapshot.id, "ISANA");
  assert.equal(anchored[0].summon.model, "b-ai/deepseek-v4.1-flash");
});

test("task 원문을 아직 모르는 다항목 배치의 이름 없는 자식은 요청을 배정하지 않는다", () => {
  const parent = {
    role: "assistant",
    model: "gpt-6-astra",
    provider: "openai-codex",
    content: [{
      type: "toolCall",
      toolCallId: "call_mixed",
      toolName: "task",
      input: {
        tasks: [
          { task: '[character-summon alias="ISANA(이사나)" model="b-ai/deepseek-v4.1-flash"]\n인사해 줘.' },
          { task: "TASK_GUARD:\nWORK_CLASS: feature\n\n마커 없는 일반 작업" },
        ],
      },
    }],
  };
  const turns = buildInlineTurns(
    [{ role: "user", content: "불러 줘" }, parent],
    ["entry-user", "entry-assistant"],
  );
  // progress가 아직 task를 싣지 않은 자식은 어느 요청의 것인지 알 수 없다.
  const unknown = { ...child("running").snapshot, id: "ISANA", parentToolCallId: "call_mixed", task: undefined };

  assert.deepEqual(anchorCharacterSummonChildren(turns, [unknown]), []);
});

test("task 항목이 하나뿐인 호출의 이름 없는 마커는 그 자식에게 배정된다", () => {
  const parent = {
    role: "assistant",
    model: "gpt-6-astra",
    provider: "openai-codex",
    content: [{
      type: "toolCall",
      toolCallId: "call_single",
      toolName: "task",
      input: { task: '[character-summon alias="MIO(미오)" model="anthropic/claude-opus-5"]\n인사해 줘.' },
    }],
  };
  const turns = buildInlineTurns(
    [{ role: "user", content: "불러 줘" }, parent],
    ["entry-user", "entry-assistant"],
  );
  const summoned = { ...child("running").snapshot, id: "MIO", parentToolCallId: "call_single", task: undefined };

  const anchored = anchorCharacterSummonChildren(turns, [summoned]);

  assert.equal(anchored.length, 1);
  assert.equal(anchored[0].summon.alias, "MIO(미오)");
});


test("실패한 호출은 요청 대상의 자리로 고정하고 다른 provider의 발화를 그 캐릭터의 말로 투영하지 않는다", () => {
  const turns = turnsForTask([
    '[character-summon alias="ISANA(이사나)" model="b-ai/deepseek-v4.1-flash"]',
    "인사해 줘.",
  ].join("\n"));
  const [anchored] = anchorCharacterSummonChildren(turns, [child("failed").snapshot]);
  // fallback이 실제로 돌았다면 기록된 모델·메시지 provider는 devin이다.
  anchored.snapshot.progress.resolvedModel = "devin/swe-2";
  anchored.snapshot.progress.retryFailure = { attempt: 2, errorMessage: "B.AI 모델 해석 실패" };
  const fallbackGreeting = {
    id: "entry-1",
    message: { role: "assistant", model: "swe-2", provider: "devin", content: [{ type: "text", text: "안녕, 노바야." }] },
  };

  const utterances = utterancesForChild(anchored, read([fallbackGreeting]), "devin");

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].provider, "b-ai");
  assert.equal(utterances[0].label, "ISANA(이사나)");
  assert.equal(utterances[0].status, "failed");
  assert.equal(utterances[0].text, "B.AI 모델 해석 실패");
  assert.equal(utterances[0].credentialId, undefined);
});

test("첫 요청부터 거절된 호출은 메시지의 errorMessage를 본문으로 쓴다", () => {
  // 실측 RinGallery.jsonl: fail-closed는 retry 없이 끝나 retryFailure가 없고,
  // 런타임은 빈 텍스트 + errorMessage로 거절 이유를 기록한다.
  const turns = turnsForTask([
    '[character-summon alias="RIN(린)" model="anthropic/claude-opus-5" oauth-position="0"]',
    "인사해 줘.",
  ].join("\n"));
  const [anchored] = anchorCharacterSummonChildren(turns, [child("failed").snapshot]);
  anchored.snapshot.progress.resolvedModel = "anthropic/claude-opus-5";
  const rejected = {
    id: "entry-1",
    message: {
      role: "assistant", model: "claude-opus-5", provider: "anthropic",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "[CharacterSummonRuntime] RIN(린)의 지정 OAuth 계정이 현재 사용할 수 없습니다.",
      credentialId: 9,
    },
  };

  const utterances = utterancesForChild(anchored, read([rejected]), "anthropic");

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].text, "[CharacterSummonRuntime] RIN(린)의 지정 OAuth 계정이 현재 사용할 수 없습니다.");
  assert.equal(utterances[0].status, "failed");
  assert.equal(utterances[0].label, "RIN(린)");
  assert.equal(utterances[0].credentialId, 9);
});

test("다른 provider가 남긴 errorMessage도 요청한 캐릭터의 말로 투영하지 않는다", () => {
  const turns = turnsForTask([
    '[character-summon alias="ISANA(이사나)" model="b-ai/deepseek-v4.1-flash"]',
    "인사해 줘.",
  ].join("\n"));
  const [anchored] = anchorCharacterSummonChildren(turns, [child("failed").snapshot]);
  anchored.snapshot.progress.resolvedModel = "devin/swe-2";
  const foreignError = {
    id: "entry-1",
    message: {
      role: "assistant", model: "swe-2", provider: "devin",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "fallback 계정이 남긴 오류",
    },
  };

  const utterances = utterancesForChild(anchored, read([foreignError]), "devin");

  // 다른 provider의 기록은 버리고 요청 대상의 자리만 남는다.
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].provider, "b-ai");
  assert.equal(utterances[0].text, "");
  assert.equal(utterances[0].status, "failed");
});

test("실패한 호출이 요청 provider의 발화를 남겼다면 그 부분 답은 중단 표시와 함께 남는다", () => {
  const turns = turnsForTask([
    '[character-summon alias="ISANA(이사나)" model="b-ai/deepseek-v4.1-flash"]',
    "인사해 줘.",
  ].join("\n"));
  const [anchored] = anchorCharacterSummonChildren(turns, [child("failed").snapshot]);
  const partial = {
    id: "entry-1",
    message: { role: "assistant", model: "deepseek-v4.1-flash", provider: "b-ai", content: [{ type: "text", text: "말하다 끊겼다" }] },
  };

  const utterances = utterancesForChild(anchored, read([partial]), "devin");

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].provider, "b-ai");
  assert.equal(utterances[0].text, "말하다 끊겼다");
  assert.equal(utterances[0].status, "failed");
});

test("TASK_GUARD 아래의 명시 호출도 해당 사용자 턴에 연결한다", () => {
  const turns = turnsForTask([
    "TASK_GUARD:",
    "WORK_CLASS: diagnostic",
    "OWNED_PATHS: .",
    "",
    '[character-summon alias="MIO(미오)" model="anthropic/claude-opus-5" oauth-position="1"]',
    "",
    "추석 인사를 해 줘.",
  ].join("\n"));
  assert.equal(anchorCharacterSummonChildren(turns, [child().snapshot])[0]?.turnIndex, 0);
});

test("발화의 실제 provider와 계정으로 얼굴을 고르고 부모 계정은 물려받지 않는다", () => {
  const entry = assistantView([{ type: "text", text: "반가워." }]);
  entry.message.credentialId = 13;
  const snapshot = child();
  snapshot.snapshot.progress.resolvedModel = "b-ai/deepseek-v4.1-flash";
  const [utterance] = utterancesForChild(snapshot, read([entry]), "openai-codex");
  assert.equal(utterance.provider, "anthropic");
  assert.equal(utterance.credentialId, 13);
  assert.equal(utterance.accountSessionId, null);
});

test("명시적 캐릭터 호출도 기존 yield 보고 폴백을 그대로 말한다", () => {
  const turns = turnsForTask([
    '[character-summon alias="ISANA(이사나)" model="b-ai/deepseek-v4.1-flash"]',
    "# 캐릭터 호출 런타임 계약",
    "이사나의 답변",
  ].join("\n"));
  const [anchored] = anchorCharacterSummonChildren(turns, [child().snapshot]);
  const report = "호출된 캐릭터의 최종 답변";

  const utterances = utterancesForChild(
    anchored,
    read([assistantView([thinking, yieldCall({ report })])]),
    undefined,
  );

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].text, report);
});

test("yield 로만 답한 자식도 자기 보고를 말한다", () => {
  const report = "1. 논제 후보\n① 인류는 AI 감속 의무가 있다.\n② 감속은 위험을 줄인다.";
  const entries = [
    assistantView([thinking, yieldCall({ report, files_changed: [], commands_run: [], notes: "" })]),
  ];

  const utterances = utterancesForChild(child(), read(entries), undefined);

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].text, report);
  assert.equal(utterances[0].status, "settled");
  assert.equal(utterances[0].turnIndex, 3);
  assert.equal(utterances[0].speakerId, "subagent:ISANA");
});

test("텍스트 블록이 있으면 그 답이 그대로 남고 yield 보고가 덮지 않는다", () => {
  const answer = "1.\n- 규범축: 감속은 옳은가?\n- 경험축: 감속은 위험을 줄이는가?";
  const entries = [
    assistantView([thinking, { type: "text", text: answer }, yieldCall({ report: "다른 보고 본문" })]),
  ];

  const utterances = utterancesForChild(child(), read(entries), undefined);

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].text, answer);
});

test("report 가 없는 구조적 yield 는 발화가 아니다", () => {
  const entries = [
    assistantView([thinking, yieldCall({ changed_paths: ["hooks/useSubagentUtterances.ts"], validation: "unverified" })]),
  ];

  assert.deepEqual(utterancesForChild(child(), read(entries), undefined), []);
});

test("report 없이 대사 필드로만 yield 한 캐릭터 자식도 그 대사를 말한다", () => {
  const greeting = "애갤 여러분, 추석 잘 보내고 계세요?";
  const entries = [assistantView([yieldCall({ character: "MIO(미오)", greeting })])];

  const utterances = utterancesForChild(child(), read(entries), undefined);

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].text, greeting);
});

test("yield 전체가 문자열이면 그 문자열이 보고다", () => {
  const entries = [assistantView([yieldCall("보고 본문 한 줄")])];

  const utterances = utterancesForChild(child(), read(entries), undefined);

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].text, "보고 본문 한 줄");
});

test("사고 과정과 다른 도구 호출은 답이 아니다", () => {
  const entries = [
    assistantView([
      thinking,
      { type: "toolCall", toolCallId: "call_eval", toolName: "eval", input: { code: "1 + 1", language: "py" } },
    ]),
  ];

  assert.deepEqual(utterancesForChild(child(), read(entries), undefined), []);
});

test("아직 말이 없는 자식은 자리를 지키고, 끝난 자식은 흔적을 남기지 않는다", () => {
  const running = utterancesForChild(child("running"), read([]), undefined);
  assert.equal(running.length, 1);
  assert.equal(running[0].text, "");
  assert.equal(running[0].status, "streaming");

  assert.deepEqual(utterancesForChild(child(), read([]), undefined), []);
});

// --- 후속 요청(DM)이 부른 발화는 그 요청이 있는 턴에 붙는다 ---
//
// 부모가 `write agent://<id>`로 자식에게 다시 말을 걸면 자식 기록에는 `irc:incoming` 경계가 남고,
// 그 뒤의 발화는 처음 띄운 summon 턴이 아니라 그 send가 속한 턴의 몫이다. 인과는
// 수신 경계의 본문·발신자와 부모 send의 수신자/본문/from이 같은 쌍으로만 잇는다.

function parentPeerSendMessage(to, message, callId = "call_send_1") {
  return {
    role: "assistant",
    model: "gpt-6-astra",
    provider: "openai-codex",
    content: [{
      type: "toolCall",
      toolCallId: callId,
      toolName: "write",
      input: { path: `agent://${to}`, content: message },
    }],
  };
}

function peerSendResult(callId, to, outcome = "injected", from = "Main") {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "write",
    content: [{ type: "text", text: `Delivered to ${to}: ${outcome}` }],
    details: { message: { op: "send", from, to, receipts: [{ to, outcome }] } },
  };
}

function ircIncoming(from, message, id = "irc-1") {
  return { id, irc: { from, message } };
}

const SUMMON_TASK = '[character-summon alias="ISANA(이사나)" model="b-ai/deepseek-v4.1-flash"]\n인사해 줘.';

function summonThenSendTurns(sendMessage = "새 인사 남겨줘", outcome = "injected", sendTo = "ISANA") {
  return buildInlineTurns(
    [
      { role: "user", content: "불러 줘" },
      parentTaskMessage(SUMMON_TASK),
      { role: "user", content: "다시 인사시켜 줘" },
      parentPeerSendMessage(sendTo, sendMessage),
      peerSendResult("call_send_1", sendTo === "all" ? "ISANA" : sendTo, outcome),
    ],
    ["e0", "e1", "e2", "e3", "e4"],
  );
}

test("부모가 write agent://로 다시 부른 뒤의 발화는 그 요청 턴에 붙고 이전 발화는 summon 턴에 남는다", () => {
  const turns = summonThenSendTurns();
  const [anchored] = anchorCharacterSummonChildren(turns, [child().snapshot]);
  const entries = [
    assistantView([{ type: "text", text: "첫 인사" }]),
    ircIncoming("Main", "새 인사 남겨줘"),
    assistantView([{ type: "text", text: "새 인사" }]),
  ];

  const utterances = utterancesForChild(anchored, read(entries), undefined);

  assert.equal(utterances.length, 2);
  assert.equal(utterances[0].text, "첫 인사");
  assert.equal(utterances[0].turnIndex, 0, "send 이전 발화는 summon 턴에 남는다");
  assert.equal(utterances[1].text, "새 인사");
  assert.equal(utterances[1].turnIndex, 2, "send가 부른 발화는 그 요청 턴에 붙는다");
});

test("실패한 send는 수신 경계와 잇지 않는다", () => {
  const turns = summonThenSendTurns("새 인사 남겨줘", "failed");
  const [anchored] = anchorCharacterSummonChildren(turns, [child().snapshot]);
  const entries = [
    assistantView([{ type: "text", text: "첫 인사" }]),
    ircIncoming("Main", "새 인사 남겨줘"),
    assistantView([{ type: "text", text: "새 인사" }]),
  ];

  const utterances = utterancesForChild(anchored, read(entries), undefined);

  assert.equal(utterances.length, 2);
  assert.equal(utterances[1].turnIndex, 0, "실패한 send는 trigger가 아니라 발화가 옮겨지지 않는다");
});

test("다른 발신자의 같은 본문 수신은 부모 send와 잇지 않는다", () => {
  const turns = summonThenSendTurns();
  const [anchored] = anchorCharacterSummonChildren(turns, [child().snapshot]);
  const entries = [
    ircIncoming("OtherAgent", "새 인사 남겨줘"),
    assistantView([{ type: "text", text: "새 인사" }]),
  ];

  const utterances = utterancesForChild(anchored, read(entries), undefined);

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].turnIndex, 0, "발신자가 다르면 summon 턴을 유지한다");
});

test("발신자를 모르는 수신 경계는 본문이 같아도 잇지 않는다", () => {
  const turns = summonThenSendTurns();
  const [anchored] = anchorCharacterSummonChildren(turns, [child().snapshot]);
  const entries = [
    ircIncoming(undefined, "새 인사 남겨줘"),
    assistantView([{ type: "text", text: "새 인사" }]),
  ];

  const utterances = utterancesForChild(anchored, read(entries), undefined);

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].turnIndex, 0, "발신자가 없으면 본문만으로 잇지 않고 summon 턴을 유지한다");
});

test("같은 본문을 두 번내면 수신 occurrence 순서대로 각 요청 턴에 잇는다", () => {
  const messages = [
    { role: "user", content: "불러 줘" },
    parentTaskMessage(SUMMON_TASK),
    { role: "user", content: "한 번 더" },
    parentPeerSendMessage("ISANA", "같은 지시", "call_send_1"),
    peerSendResult("call_send_1", "ISANA"),
    { role: "user", content: "또 한 번" },
    parentPeerSendMessage("ISANA", "같은 지시", "call_send_2"),
    peerSendResult("call_send_2", "ISANA"),
  ];
  const turns = buildInlineTurns(messages, ["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
  const [anchored] = anchorCharacterSummonChildren(turns, [child().snapshot]);
  const entries = [
    ircIncoming("Main", "같은 지시", "irc-1"),
    assistantView([{ type: "text", text: "첫 번째 답" }]),
    ircIncoming("Main", "같은 지시", "irc-2"),
    assistantView([{ type: "text", text: "두 번째 답" }]),
  ];

  const utterances = utterancesForChild(anchored, read(entries), undefined);

  assert.equal(utterances.length, 2);
  assert.equal(utterances[0].turnIndex, 2, "첫 수신은 첫 send의 턴");
  assert.equal(utterances[1].turnIndex, 5, "두 번째 수신은 두 번째 send의 턴");
});

test("all 방송은 그 자식의 성공 receipt가 있을 때만 잇는다", () => {
  const turns = summonThenSendTurns("모두에게 공지", "injected", "all");
  const [anchored] = anchorCharacterSummonChildren(turns, [child().snapshot]);
  const entries = [
    ircIncoming("Main", "모두에게 공지"),
    assistantView([{ type: "text", text: "방송에 답함" }]),
  ];

  const utterances = utterancesForChild(anchored, read(entries), undefined);

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].turnIndex, 2, "이 자식에게 도달한 방송은 그 요청 턴에 붙는다");
});

test("디스크 기록으로 복원한 자식도 summon 요청과 맞으면 발화를 되살린다", () => {
  const turns = turnsForTask([
    '[character-summon alias="ISANA(이사나)" model="b-ai/deepseek-v4.1-flash"]',
    "인사해 줘.",
  ].join("\n"));
  const summon = turns[0].characterSummons[0];
  const snapshot = archiveSnapshot({
    name: "ISANA",
    bytes: 100,
    modified: 1000,
    messages: 5,
    firstTask: "인사해 줘",
    model: "b-ai/deepseek-v4.1-flash",
    status: "completed",
  }, summon, 0);

  const [anchored] = anchorCharacterSummonChildren(turns, [snapshot]);
  assert.ok(anchored, "archive 자식이 summon 턴에 앵커되어야 한다");
  assert.equal(anchored.snapshot.status, "completed");
  assert.equal(anchored.snapshot.progress?.resolvedModel, "b-ai/deepseek-v4.1-flash");

  // 사이드카가 실어 보낸 archive entry 모양 그대로다.
  const entries = archiveTranscriptEntries([
    { role: "system", kind: "custom", text: "[irc:incoming]", at: null, irc: { from: "Main", message: "인사 부탁" } },
    {
      role: "assistant",
      kind: "message",
      text: "추석 잘 보내",
      at: null,
      message: {
        role: "assistant",
        model: "deepseek-v4.1-flash",
        provider: "b-ai",
        content: [
          { type: "text", text: "추석 잘 보내" },
          { type: "toolCall", toolCallId: "call_y1", toolName: "yield", input: { data: "추석 잘 보내" } },
        ],
      },
    },
  ]);

  const utterances = utterancesForChild(anchored, read(entries), undefined);
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].text, "추석 잘 보내");
  assert.equal(utterances[0].status, "settled");
  assert.equal(utterances[0].provider, "b-ai");
});

test("실패로 끝난 archive 자식은 기록된 errorMessage를 실어 보낸다", () => {
  const turns = turnsForTask([
    '[character-summon alias="RIN(린)" model="anthropic/claude-opus-5"]',
    "인사해 줘.",
  ].join("\n"));
  const summon = turns[0].characterSummons[0];
  const snapshot = archiveSnapshot({
    name: "RIN",
    bytes: 50,
    modified: 500,
    messages: 2,
    firstTask: "인사해 줘",
    status: "failed",
    stopReason: "error",
    errorMessage: "지정 OAuth 계정이 현재 사용할 수 없습니다.",
  }, summon, 0);

  const [anchored] = anchorCharacterSummonChildren(turns, [snapshot]);
  const utterances = utterancesForChild(anchored, read([]), undefined);

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].status, "failed");
  assert.equal(utterances[0].text, "지정 OAuth 계정이 현재 사용할 수 없습니다.");
});


test("종료 근거가 없는 archive 자식은 상태를 추정하지 않고 기록된 발화만 보존한다", () => {
  const turns = turnsForTask([
    '[character-summon alias="ISANA(이사나)" model="b-ai/deepseek-v4.1-flash"]',
    "인사해 줘.",
  ].join("\n"));
  const summon = turns[0].characterSummons[0];
  const snapshot = archiveSnapshot({
    name: "ISANA",
    bytes: 100,
    modified: 1000,
    messages: 5,
    firstTask: "인사해 줘",
    status: null,
  }, summon, 0);

  assert.equal(snapshot.status, "unknown", "미관측 상태를 completed로 둥글리지 않는다");

  const [anchored] = anchorCharacterSummonChildren(turns, [snapshot]);
  const entries = archiveTranscriptEntries([
    {
      role: "assistant",
      kind: "message",
      text: "기록된 답",
      at: null,
      message: {
        role: "assistant",
        model: "deepseek-v4.1-flash",
        provider: "b-ai",
        content: [{ type: "text", text: "기록된 답" }],
      },
    },
  ]);

  const utterances = utterancesForChild(anchored, read(entries), undefined);
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].text, "기록된 답");
  assert.equal(utterances[0].status, "settled", "기록이 끝난 발화는 최종으로 그린다");
});

test("잘린 irc 본문은 부모 send와 본문 매칭에 쓰지 않는다", () => {
  const turns = summonThenSendTurns("긴 지시 본문", "injected", "ISANA");
  const [anchored] = anchorCharacterSummonChildren(turns, [child().snapshot]);
  const entries = [
    // 사이드카가 cap을 넘는 본문에 붙이는 표시 그대로다.
    { id: "a0", irc: { from: "Main", message: "긴 지시 본문", truncated: true } },
    assistantView([{ type: "text", text: "답" }]),
  ];

  const utterances = utterancesForChild(anchored, read(entries), undefined);

  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].turnIndex, 0, "잘린 수신 경계는 send 턴으로 옮기지 않고 summon 턴을 유지한다");
});