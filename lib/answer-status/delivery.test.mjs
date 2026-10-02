import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildDeliveryRows, deliveryReducer, userMessageText } = await jiti.import("./delivery.ts");

const run = (actions, initial = []) => actions.reduce(deliveryReducer, initial);
const queue = (steering = [], followUp = []) => ({ type: "queue", steering, followUp });
const stages = (entries) => entries.map((entry) => `${entry.kind}:${entry.stage}`);

test("a steer moves sending → accepted → delivered only on the matching user message", () => {
  let entries = run([{ type: "submit", id: 1, kind: "steer", text: "테스트 먼저 돌려" }]);
  assert.deepEqual(stages(entries), ["steer:sending"]);

  entries = run([queue(["테스트 먼저 돌려"])], entries);
  assert.deepEqual(stages(entries), ["steer:accepted"]);

  // 다른 글의 user 메시지는 전달 근거가 아니다.
  entries = run([{ type: "user-message", text: "다른 글" }], entries);
  assert.deepEqual(stages(entries), ["steer:accepted"]);

  entries = run([{ type: "user-message", text: "테스트 먼저 돌려\n" }, queue()], entries);
  assert.deepEqual(stages(entries), ["steer:delivered"]);
});

test("a queued input that leaves the queue without its user message ends as unconfirmed, then clears when idle", () => {
  let entries = run([
    { type: "submit", id: 1, kind: "followUp", text: "끝나면 요약해 줘" },
    { type: "ack", id: 1 },
    queue([], ["끝나면 요약해 줘"]),
  ]);
  assert.deepEqual(stages(entries), ["followUp:accepted"]);

  // 첨부·이미지로 기록된 글이 달라 같은 user message_end를 끝내 못 찾은 경우: 전달됨으로 추정하지 않는다.
  entries = run([queue()], entries);
  assert.deepEqual(stages(entries), ["followUp:unconfirmed"]);
  assert.deepEqual(buildDeliveryRows(entries, { steering: [], followUp: [] }).map((row) => [row.stage, row.removable]), [["unconfirmed", false]]);

  // 턴이 끝나 idle이 되면 유령 행으로 남지 않는다.
  assert.deepEqual(run([{ type: "idle" }], entries), []);
});

test("an unconfirmed input is promoted when its user message arrives after the queue update", () => {
  const entries = run([
    { type: "submit", id: 1, kind: "steer", text: "로그도 봐" },
    queue(["로그도 봐"]),
    queue(),
    { type: "user-message", text: "로그도 봐" },
  ]);
  assert.deepEqual(stages(entries), ["steer:delivered"]);
});

test("a failed send is shown as failed and idle keeps only what is still in the server queue", () => {
  const entries = run([
    { type: "submit", id: 1, kind: "steer", text: "a" },
    { type: "fail", id: 1 },
    { type: "submit", id: 2, kind: "followUp", text: "b" },
    queue([], ["b"]),
  ]);
  assert.deepEqual(stages(entries), ["steer:failed", "followUp:accepted"]);
  assert.deepEqual(stages(run([{ type: "idle" }], entries)), ["followUp:accepted"]);
});

test("rows keep steer and follow-up apart and show queue items this tab did not send as received", () => {
  const entries = run([{ type: "submit", id: 1, kind: "steer", text: "같은 글" }, queue(["같은 글"], ["같은 글"])]);
  const rows = buildDeliveryRows(entries, { steering: ["같은 글"], followUp: ["같은 글"] });
  assert.deepEqual(rows.map((row) => [row.kind, row.stage, row.removable]), [
    ["followUp", "accepted", true],
    ["steer", "accepted", true],
  ]);
});

test("withdrawing removes the input from the rows, recall removes every pending one", () => {
  const entries = run([
    { type: "submit", id: 1, kind: "steer", text: "x" },
    { type: "submit", id: 2, kind: "followUp", text: "y" },
    queue(["x"], ["y"]),
  ]);
  assert.deepEqual(stages(run([{ type: "withdraw", kind: "steer", text: "x" }], entries)), ["followUp:accepted"]);
  assert.deepEqual(run([{ type: "withdraw" }], entries), []);
});

test("user message text joins text blocks and ignores images", () => {
  assert.equal(userMessageText({ role: "user", content: [{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }] }), "a\nb");
});
