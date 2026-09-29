import assert from "node:assert/strict";
import { test } from "bun:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { loungeReducer, INITIAL_LOUNGE_STATE } = await jiti.import("./useLounge.ts");

function snapshot(revision, overrides = {}) {
  return {
    revision,
    room: { id: "main", enabled: true, autoTalk: false, participants: ["yuki"], pace: "normal", sleepAfterMinutes: 10, asleep: false, sleepAt: null },
    members: [],
    messages: [],
    run: { active: false, generation: 1, currentMemberId: null, queuedMemberIds: [], startedAt: null, calls: { used: 0, limit: 20, windowMs: 3_600_000 }, perTurnLimit: 3 },
    ...overrides,
  };
}

const speaking = (revision, generation = 1) => ({
  revision,
  members: [],
  room: snapshot(0).room,
  run: { ...snapshot(0).run, active: true, generation, currentMemberId: "yuki" },
});

const idle = (revision, generation = 1) => ({ ...speaking(revision, generation), run: { ...snapshot(0).run, generation } });

test("늦게 도착한 POST 응답 snapshot은 이미 반영한 더 새 SSE 상태를 되돌리지 않는다", () => {
  let state = loungeReducer(INITIAL_LOUNGE_STATE, { type: "snapshot", source: "sse", data: snapshot(10) });
  state = loungeReducer(state, { type: "state", data: speaking(12) });
  state = loungeReducer(state, { type: "snapshot", source: "post", data: snapshot(11) });

  assert.equal(state.revision, 12);
  assert.equal(state.snapshot.run.active, true);
  assert.equal(state.snapshot.run.currentMemberId, "yuki");
});

test("run 종료 state가 확정 메시지보다 먼저 와도 말하던 본문은 확정 메시지가 올 때까지 남는다", () => {
  let state = loungeReducer(INITIAL_LOUNGE_STATE, { type: "snapshot", source: "sse", data: snapshot(10) });
  state = loungeReducer(state, { type: "delta", data: { revision: 10, generation: 1, messageId: "m1", memberId: "yuki", text: "안녕" } });
  state = loungeReducer(state, { type: "state", data: idle(11) });

  assert.equal(state.streaming.get("m1")?.text, "안녕");

  const message = { id: "m1", memberId: "yuki", text: "안녕!", createdAt: 1, reactions: [] };
  state = loungeReducer(state, { type: "message", data: { revision: 12, message } });

  assert.equal(state.streaming.size, 0);
  assert.deepEqual(state.snapshot.messages.map((m) => m.text), ["안녕!"]);
});

test("중단으로 generation이 오르면 이전 본문은 사라지고 그 generation의 늦은 delta도 버린다", () => {
  let state = loungeReducer(INITIAL_LOUNGE_STATE, { type: "snapshot", source: "sse", data: snapshot(10) });
  state = loungeReducer(state, { type: "delta", data: { revision: 10, generation: 1, messageId: "m1", memberId: "yuki", text: "잠깐" } });
  state = loungeReducer(state, { type: "state", data: idle(11, 2) });

  assert.equal(state.streaming.size, 0);

  state = loungeReducer(state, { type: "delta", data: { revision: 11, generation: 1, messageId: "m1", memberId: "yuki", text: "잠깐 생각" } });
  assert.equal(state.streaming.size, 0);
});

test("반응이 바뀐 같은 id 메시지는 교체되고, 이미 확정된 id의 delta는 다시 말풍선을 만들지 않는다", () => {
  const message = { id: "m1", memberId: "yuki", text: "안녕", createdAt: 1, reactions: [] };
  let state = loungeReducer(INITIAL_LOUNGE_STATE, { type: "snapshot", source: "sse", data: snapshot(10, { messages: [message] }) });
  state = loungeReducer(state, { type: "message", data: { revision: 11, message: { ...message, reactions: [{ emoji: "👍", by: ["user"] }] } } });
  state = loungeReducer(state, { type: "delta", data: { revision: 11, generation: 1, messageId: "m1", memberId: "yuki", text: "안녕" } });

  assert.equal(state.snapshot.messages.length, 1);
  assert.deepEqual(state.snapshot.messages[0].reactions, [{ emoji: "👍", by: ["user"] }]);
  assert.equal(state.streaming.size, 0);
});
