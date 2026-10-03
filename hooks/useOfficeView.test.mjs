import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { officeAccountTargets, officeMakerAccounts } = await jiti.import("./useOfficeView.ts");

function snapshot(id, status = "running") {
  return { id, index: 0, agent: "maker", agentSource: "bundled", status, lastUpdate: 1 };
}

function liveRead(...messages) {
  const entries = messages.map((message, index) => ({ id: `e${index}`, message }));
  return { state: { kind: "ready-live", entries }, entries };
}

const reply = (credentialId) => ({ role: "assistant", content: [], model: "claude-opus-5-5", provider: "anthropic", credentialId, timestamp: 1 });

test("every Maker of the open office is read, and its last reply's account is the evidence", () => {
  const subagents = [snapshot("Mio"), snapshot("Quiet")];
  const targets = officeAccountTargets("session-a", subagents);
  assert.deepEqual(targets.map((target) => target.liveId), ["Mio", "Quiet"]);
  const reads = new Map([
    [targets[0].key, liveRead({ role: "user", content: "작업", timestamp: 0 }, reply(11), reply(12))],
    // 아직 답이 없는 Maker 는 근거가 없다 — 비워 두어 기록된 모델 provider 만 쓰게 한다.
    [targets[1].key, liveRead({ role: "user", content: "작업", timestamp: 0 })],
  ]);
  const accounts = officeMakerAccounts("session-a", subagents, reads);
  assert.deepEqual([...accounts], [["Mio", { provider: "anthropic", credentialId: 12 }]]);
});

test("after a session switch the previous session's reads never answer for a same-named Maker", () => {
  const subagents = [snapshot("Maker")];
  const [previous] = officeAccountTargets("session-a", subagents);
  // 세션 A 의 같은 이름 Maker 기록이 아직 읽기 결과에 남아 있다(새 세션의 첫 읽기 전).
  const reads = new Map([[previous.key, liveRead(reply(11))]]);
  const [current] = officeAccountTargets("session-b", subagents);
  assert.notEqual(current.key, previous.key);
  assert.equal(officeMakerAccounts("session-b", subagents, reads).size, 0);
  assert.equal(officeMakerAccounts(null, subagents, reads).size, 0);
  assert.deepEqual(officeAccountTargets(null, subagents), []);
});
