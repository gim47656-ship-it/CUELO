import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { mergeSubagentSnapshots } = await jiti.import("./subagent-snapshots.ts");
const { resolveSubagentTaskPresentation } = await jiti.import("./hanse-subagent-client.ts");
const { anchorCharacterSummonChildren } = await jiti.import("../hooks/useSubagentUtterances.ts");

// 아래 스냅샷은 useAgentSession의 subagent_lifecycle·subagent_progress 처리가 프레임에서 만드는 모양 그대로다.
// 2026-10-04 MnemopiRecallFix 실측: 재시작 뒤 cold revive(core task/persisted-revive.ts:252)의 wake 턴은
// parentToolCallId·index·description 없이, agent=자식 id·agentSource=user로 started를 내고(executor.ts:3285),
// progress의 task에는 깨운 IRC 본문을 싣는다(executor.ts:3268,1684). park 자체는 프레임을 내지 않는다.
const SESSION_FILE = "/sessions/root/Maker.jsonl";
const TASK = "[character-summon alias=\"MIO\" model=\"anthropic/claude-opus-5-5\"]\nTASK_TITLE: 카드 유지 확인\n본문";

function firstRun() {
  const started = {
    id: "Maker", index: 2, agent: "maker", agentSource: "bundled", description: "측정",
    status: "running", sessionFile: SESSION_FILE, parentToolCallId: "toolu_A", lastUpdate: 1,
  };
  const progress = {
    ...started, task: TASK, assignment: TASK, lastUpdate: 2,
    progress: { id: "Maker", index: 2, agent: "maker", status: "running", task: TASK, description: "측정" },
  };
  const completed = { ...progress, status: "completed", lastUpdate: 3, progress: { ...progress.progress, status: "completed" } };
  return [started, progress, completed].reduce((list, snapshot) => mergeSubagentSnapshots(list, [snapshot]), []);
}

const coldStarted = {
  id: "Maker", index: 0, agent: "Maker", agentSource: "user", description: undefined,
  status: "running", sessionFile: SESSION_FILE, parentToolCallId: undefined, lastUpdate: 4,
};
const coldProgress = {
  id: "Maker", index: 0, agent: "Maker", agentSource: "user", description: "IRC",
  status: "running", task: "이어서 체크포인트를 보내세요", assignment: undefined,
  sessionFile: SESSION_FILE, parentToolCallId: undefined, lastUpdate: 5,
  progress: { id: "Maker", index: 0, agent: "Maker", status: "running", task: "이어서 체크포인트를 보내세요", description: "IRC" },
};

function identity(snapshot) {
  const { id, index, agent, agentSource, description, task, assignment, sessionFile, parentToolCallId } = snapshot;
  return { id, index, agent, agentSource, description, task, assignment, sessionFile, parentToolCallId };
}

test("a parked Maker revived by a cold wake keeps its card identity while its status follows the wake turn", () => {
  const before = firstRun();
  const original = identity(before[0]);

  const running = mergeSubagentSnapshots(before, [coldStarted]);
  assert.equal(running.length, 1);
  assert.equal(running[0].status, "running");
  assert.deepEqual(identity(running[0]), original);

  const progressed = mergeSubagentSnapshots(running, [coldProgress]);
  assert.equal(progressed[0].status, "running");
  assert.equal(progressed[0].progress.task, "이어서 체크포인트를 보내세요");
  assert.deepEqual(identity(progressed[0]), original);

  const settled = mergeSubagentSnapshots(progressed, [{ ...coldProgress, status: "completed", lastUpdate: 6 }]);
  assert.equal(settled[0].status, "completed");
  assert.deepEqual(identity(settled[0]), original);

  // 사용자에게 보이는 결과: 대화창의 캐릭터 카드는 parentToolCallId로 발주에 묶이고, 카드 제목은 최초 발주의 TASK_TITLE이다.
  const turns = [{ index: 0, characterSummons: [{ toolCallId: "toolu_A", name: "Maker", alias: "MIO", model: "anthropic/claude-opus-5-5", batchSize: 1 }], peerSends: [] }];
  assert.deepEqual(anchorCharacterSummonChildren(turns, settled).map((child) => child.snapshot.id), ["Maker"]);
  assert.equal(resolveSubagentTaskPresentation({ key: "live:Maker", identity: "live", live: settled[0] }).title, "카드 유지 확인");
});

test("a new dispatch that reuses the id replaces the previous card identity", () => {
  const respawned = {
    id: "Maker", index: 1, agent: "reviewer", agentSource: "project", description: "재발주",
    status: "running", sessionFile: SESSION_FILE, parentToolCallId: "toolu_B", lastUpdate: 4,
  };
  const [card] = mergeSubagentSnapshots(firstRun(), [respawned]);
  assert.deepEqual(identity(card), identity(respawned));
});
