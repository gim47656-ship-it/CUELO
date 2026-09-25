import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { utterancesForConsults } = await createJiti(import.meta.url)
  .import("./useWeb6Utterances.ts");

const messages = [{ role: "user", content: "질문", timestamp: 100 }];
const base = {
  sessionId: "session-a",
  startedAt: 110,
  finishedAt: 120,
  elapsedMs: 10,
  model: "gpt-6-pro",
};

test("현재 sessionId의 실패만 보조 발화로 표시한다", () => {
  const utterances = utterancesForConsults([
    { ...base, status: "failed", error: "현재 세션 실패" },
    { ...base, sessionId: "session-b", status: "failed", error: "다른 세션 실패" },
  ], messages, "session-a");
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].text, "현재 세션 실패");
  assert.equal(utterances[0].status, "failed");
});

test("성공 답변은 session-native entry가 정본이므로 JSONL에서 다시 표시하지 않는다", () => {
  const utterances = utterancesForConsults([
    { ...base, status: "ok", text: "중복되면 안 되는 성공 답변" },
  ], messages, "session-a");
  assert.deepEqual(utterances, []);
});
