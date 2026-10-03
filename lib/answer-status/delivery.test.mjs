import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DELIVERY_VISIBLE_ROWS, buildDeliveryRows, deliveryReducer, userMessageDeliveryKind, userMessageImageCount, userMessageText, visibleDeliveryRows } = await jiti.import("./delivery.ts");

const run = (actions, initial = []) => actions.reduce(deliveryReducer, initial);
const queue = (steering = [], followUp = []) => ({ type: "queue", steering, followUp });
const user = (kind, text, images = 0) => ({ type: "user-message", kind, text, images });
const stages = (entries) => entries.map((entry) => `${entry.kind}:${entry.stage}`);

test("a steer moves sending → accepted → delivered only on the matching user message", () => {
  let entries = run([{ type: "submit", id: 1, kind: "steer", text: "테스트 먼저 돌려" }]);
  assert.deepEqual(stages(entries), ["steer:sending"]);

  entries = run([queue(["테스트 먼저 돌려"])], entries);
  assert.deepEqual(stages(entries), ["steer:accepted"]);

  // 다른 글의 user 메시지는 전달 근거가 아니다.
  entries = run([user("steer", "다른 글")], entries);
  assert.deepEqual(stages(entries), ["steer:accepted"]);

  entries = run([user("steer", "테스트 먼저 돌려\n"), queue()], entries);
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
    user("steer", "로그도 봐"),
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

// omp는 글 없이 이미지만 보낸 입력을 큐에 "[Image]"로 보고한다(queued-messages.ts queueChipText).
test("a screenshot-only steer pairs with its queue chip and is delivered only by an image user message", () => {
  let entries = run([
    { type: "submit", id: 1, kind: "steer", text: "", images: 1 },
    { type: "ack", id: 1 },
    queue(["[Image]"]),
  ]);
  assert.deepEqual(stages(entries), ["steer:accepted"]);
  // 큐의 "[Image]"는 이 탭이 보낸 행이 덮는다: 빈 행 하나와 이름 없는 큐 행이 따로 생기지 않는다.
  assert.deepEqual(buildDeliveryRows(entries, { steering: ["[Image]"], followUp: [] }).map((row) => [row.text, row.images, row.removable]), [
    ["", 1, true],
  ]);

  // 글도 이미지도 없는 user 메시지, 이미지 개수가 다른 메시지는 전달 근거가 아니다.
  entries = run([user("steer", "", 0), user("steer", " ", 2)], entries);
  assert.deepEqual(stages(entries), ["steer:accepted"]);

  entries = run([user("steer", "", 1), queue()], entries);
  assert.deepEqual(stages(entries), ["steer:delivered"]);
});

test("text with an image needs both the text and the image count to match", () => {
  let entries = run([
    { type: "submit", id: 1, kind: "followUp", text: "이 화면 봐", images: 1 },
    { type: "submit", id: 2, kind: "followUp", text: "이 화면 봐" },
    queue([], ["이 화면 봐", "이 화면 봐"]),
  ]);
  // 글만 같은 두 번째 입력이 먼저 기록돼도 이미지가 붙은 첫 입력을 전달됨으로 올리지 않는다.
  entries = run([user("followUp", "이 화면 봐", 0)], entries);
  assert.deepEqual(stages(entries), ["followUp:accepted", "followUp:delivered"]);
  entries = run([user("followUp", "이 화면 봐", 1)], entries);
  assert.deepEqual(stages(entries), ["followUp:delivered", "followUp:delivered"]);
});

test("consecutive screenshot-only inputs settle in order and only the latest settled ones stay", () => {
  const sent = [];
  for (let id = 1; id <= 6; id += 1) sent.push({ type: "submit", id, kind: "steer", text: "", images: 1 }, { type: "ack", id });
  let entries = run([...sent, queue(Array(6).fill("[Image]"))]);
  assert.deepEqual(entries.map((entry) => entry.stage), Array(6).fill("accepted"));

  for (let left = 5; left >= 0; left -= 1) {
    entries = run([user("steer", "", 1), queue(Array(left).fill("[Image]"))], entries);
  }
  assert.deepEqual(entries.map((entry) => [entry.id, entry.stage]), [[3, "delivered"], [4, "delivered"], [5, "delivered"], [6, "delivered"]]);
});

test("a screenshot steer delivered first never settles an earlier screenshot follow-up", () => {
  let entries = run([
    { type: "submit", id: 1, kind: "followUp", text: "", images: 1 },
    { type: "ack", id: 1 },
    { type: "submit", id: 2, kind: "steer", text: "", images: 1 },
    { type: "ack", id: 2 },
    queue(["[Image]"], ["[Image]"]),
  ]);
  // steer는 omp가 `steering: true`를 단 user 메시지로 먼저 기록된다. 먼저 보낸 follow-up을 대신 끝내지 않는다.
  entries = run([user("steer", "", 1), queue([], ["[Image]"])], entries);
  assert.deepEqual(stages(entries), ["followUp:accepted", "steer:delivered"]);
  entries = run([user("followUp", "", 1), queue()], entries);
  assert.deepEqual(stages(entries), ["followUp:delivered", "steer:delivered"]);
});

test("a user message of the other kind leaves a queued steer unconfirmed instead of delivered", () => {
  const entries = run([
    { type: "submit", id: 1, kind: "steer", text: "", images: 1 },
    queue(["[Image]"]),
    user("followUp", "", 1),
    queue(),
  ]);
  assert.deepEqual(stages(entries), ["steer:unconfirmed"]);
});

test("a screenshot-only input can be withdrawn by its raw text", () => {
  const entries = run([
    { type: "submit", id: 1, kind: "steer", text: "", images: 2 },
    { type: "submit", id: 2, kind: "steer", text: "글" },
    queue(["[Image]", "글"]),
  ]);
  assert.deepEqual(run([{ type: "withdraw", kind: "steer", text: "" }], entries).map((entry) => entry.id), [2]);
});

test("the panel shows the latest rows by default and keeps older pending rows reachable", () => {
  const steering = ["a", "b", "c", "d", "e", "f"];
  const rows = buildDeliveryRows([], { steering, followUp: [] });
  assert.equal(DELIVERY_VISIBLE_ROWS, 4);
  const collapsed = visibleDeliveryRows(rows, false);
  assert.equal(collapsed.hidden, 2);
  assert.deepEqual(collapsed.rows.map((row) => row.text), ["c", "d", "e", "f"]);
  const expanded = visibleDeliveryRows(rows, true);
  assert.deepEqual(expanded.rows.map((row) => [row.text, row.removable]), steering.map((text) => [text, true]));
  assert.equal(visibleDeliveryRows(rows.slice(0, 4), false).hidden, 0);
});

test("user message image count counts image blocks only", () => {
  assert.equal(userMessageImageCount({ role: "user", content: [{ type: "text", text: "" }, { type: "image", data: "AQID", mimeType: "image/png" }, { type: "image", data: "AQID", mimeType: "image/png" }] }), 2);
  assert.equal(userMessageImageCount({ role: "user", content: "글" }), 0);
});

test("only messages omp queued as steers count as steer deliveries", () => {
  assert.equal(userMessageDeliveryKind({ role: "user", content: "a", steering: true }), "steer");
  assert.equal(userMessageDeliveryKind({ role: "user", content: "a" }), "followUp");
});
