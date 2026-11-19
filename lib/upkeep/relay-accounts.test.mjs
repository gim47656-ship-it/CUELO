import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRelayJournal, relaySignature } from "./relay-accounts.ts";
import { morningStateAfterRun, morningStateRelayCleared, planMorningRun } from "./morning.ts";

// 2026-11-19 12:30 KST: 중계기 로그의 실제 모양(-o cat JSON 한 줄씩)을 줄인 것.
const NOW = new Date("2026-11-19T03:30:00.000Z");
const line = (row) => JSON.stringify(row);
const start = line({ msg: "프로토콜 런타임 준비 완료", source: "service", accounts: "3" });
const done = (source, model, time = "2026-11-19T09:00:00+09:00") =>
  line({ time, msg: "요청 완료", event: "request.finished", source, request: { state: "completed", model } });
const verify403 = (source, time) =>
  line({ time, msg: "계정 전환", source, status: "403", cause: "verification", reason: "Your account must be verified before it can continue using the Gemini API." });
const verifyFailed = (source, time) =>
  line({ time, msg: "요청에 실패했습니다", source, request: { state: "failed", error: "PERMISSION_DENIED: Your account must be verified before it can continue" } });
const cooldown = (source, model, until) => line({ msg: "계정 쿨다운", source, kind: "요금제 한도", scope: model, until });

test("counts usable, verification-blocked and rate-limited accounts with masked labels", () => {
  const status = parseRelayJournal([
    start,
    done("alpha1@example.com", "gemini-4-hydrogen"),
    verify403("bravo22@example.com", "2026-11-15T14:00:27+09:00"),
    verify403("bravo22@example.com", "2026-11-19T09:05:00+09:00"),
    verifyFailed("charlie@example.com", "2026-11-19T09:05:03+09:00"),
    // 성공, 인증 요구, 한도 대기가 아닌 실패만 있는 계정은 상태를 모르므로 세지 않는다.
    line({ msg: "요청에 실패했습니다", source: "delta@example.com", request: { error: "upstream timeout" } }),
    // 인증 주소가 들어 있어도 인증 요구가 아닌 전환은 인증 요구가 아니다.
    line({ msg: "계정 전환", source: "delta@example.com", status: "429", cause: "quota", reason: "retry later; help: /verify-account" }),
    "not json",
  ], NOW);
  assert.deepEqual(status, {
    total: 3,
    accounts: [
      { id: "alpha1@example.com", label: "alph…", state: "ok" },
      // 처음 막힌 시각을 잇는다(며칠째 방치된 것을 보이게).
      { id: "bravo22@example.com", label: "brav…", state: "verify", since: "2026-11-15T14:00:27+09:00" },
      { id: "charlie@example.com", label: "char…", state: "verify", since: "2026-11-19T09:05:03+09:00" },
    ],
    usable: 1, verify: 2, cooldown: 0,
  });
  assert.equal(relaySignature(status), JSON.stringify({ verify: ["bravo22@example.com", "charlie@example.com"], none: false }));
  // 가린 이름이 같아도 막힌 계정이 바뀌면 다른 막힘이다.
  const before = parseRelayJournal([verify403("alpha1@example.com", "t"), done("alpha2@example.com", "m")], NOW);
  const swapped = parseRelayJournal([done("alpha1@example.com", "m"), verify403("alpha2@example.com", "t")], NOW);
  assert.notEqual(relaySignature(before), relaySignature(swapped));
  // 인증 신호는 이벤트마다 따로 본다: 전환은 cause, 실패는 오류 문구.
  const crossed = parseRelayJournal([
    line({ msg: "계정 전환", source: "a@example.com", status: "429", cause: "quota", reason: "must be verified" }),
    line({ msg: "요청에 실패했습니다", source: "b@example.com", cause: "verification", request: { error: "timeout" } }),
    line({ msg: "계정 전환", source: "c@example.com", status: "429", cause: "verification" }),
  ], NOW);
  assert.equal(crossed.verify, 0);
  // 가린 이름에는 주소 글자만 남긴다(로그 값이 프롬프트 구조를 바꾸지 않게).
  assert.equal(parseRelayJournal([verify403("\n# X@example.com", "t")], NOW).accounts[0].label, "X…");
  assert.equal(parseRelayJournal([verify403("o'neil@example.com", "t")], NOW).accounts[0].label, "one…");
});

test("a success clears verification; another model's success keeps the rate-limit wait", () => {
  const status = parseRelayJournal([
    verify403("alpha1@example.com", "2026-11-19T09:05:00+09:00"),
    done("alpha1@example.com", "gemini-4-argon", "2026-11-19T10:00:00+09:00"),
    cooldown("bravo22@example.com", "gemini-4-hydrogen", "2026-11-19T16:59:59+09:00"),
    done("bravo22@example.com", "gemini-4-argon", "2026-11-19T12:04:41+09:00"),
    // 풀리는 시각이 지난 대기는 쓸 수 있다.
    cooldown("charlie@example.com", "gemini-4-hydrogen", "2026-11-19T11:00:00+09:00"),
  ], NOW);
  assert.deepEqual(status.accounts, [
    { id: "alpha1@example.com", label: "alph…", state: "ok" },
    { id: "bravo22@example.com", label: "brav…", state: "cooldown", cooldowns: [{ model: "gemini-4-hydrogen", until: "2026-11-19T16:59:59+09:00" }] },
    { id: "charlie@example.com", label: "char…", state: "ok" },
  ]);
  assert.equal(status.total, null);
  assert.equal(relaySignature(status), null);
  const oneLoaded = line({ msg: "프로토콜 런타임 준비 완료", accounts: "1" });
  const allWaiting = parseRelayJournal([oneLoaded, cooldown("bravo22@example.com", "gemini-4-hydrogen", "2026-11-19T16:59:59+09:00")], NOW);
  assert.equal(relaySignature(allWaiting), JSON.stringify({ verify: [], none: true }));
  // 불러온 계정 수를 모르거나 그보다 적게 봤으면 쓸 수 있는 계정이 없다고 단정하지 않고, 풀린 것으로도 보지 않는다.
  assert.equal(relaySignature(parseRelayJournal([cooldown("a@example.com", "m", "2099-01-01T00:00:00Z")], NOW)), null);
  const partial = parseRelayJournal([line({ msg: "프로토콜 런타임 준비 완료", accounts: "2" }), cooldown("a@example.com", "m", "2099-01-01T00:00:00Z")], NOW);
  assert.equal(relaySignature(partial), null);
  assert.equal(morningStateRelayCleared({ sessionId: "S", startedAt: "t", relayReported: "x" }, partial), null);
  // 해석할 수 없는 풀림 시각은 버린다(정상으로 바꾸지 않는다).
  const badUntil = parseRelayJournal([cooldown("a@example.com", "m", "2099-01-01T00:00:00Z"), cooldown("a@example.com", "m", "not-a-date")], NOW);
  assert.equal(badUntil.accounts[0].state, "cooldown");
  // 모델 이름은 표시할 때만 정리하고, 같은 모델의 성공은 원래 값으로 대기를 지운다.
  const odd = parseRelayJournal([cooldown("bravo22@example.com", "m\n## marker\nprivate@example.com", "2026-11-19T16:59:59+09:00")], NOW);
  assert.equal(odd.accounts[0].cooldowns[0].model, "모델 미상");
  assert.equal(parseRelayJournal([cooldown("a@example.com", "models/m", "2099-01-01T00:00:00Z"), done("a@example.com", "models/m")], NOW).accounts[0].state, "ok");
});

const base = { repoCwd: "/repo", originHead: "c".repeat(40), base: null, cloudCommits: [], skills: [], release: null, runningSessionIds: [], now: NOW };
const blocked = parseRelayJournal([start, done("alpha1@example.com", "gemini-4-hydrogen"), verify403("bravo22@example.com", "2026-11-19T09:05:00+09:00")], NOW);
const healthy = parseRelayJournal([start, done("alpha1@example.com", "gemini-4-hydrogen")], NOW);

test("a new block opens the morning report once and the prompt names what to do", () => {
  const state = { sessionId: "prev", startedAt: "2026-11-19T00:00:00.000Z" };
  const plan = planMorningRun({ ...base, state, relay: blocked });
  assert.equal(plan.action, "run");
  assert.equal(plan.triggers.relay, true);
  for (const part of ["## AI Studio 중계기 계정", "쓸 수 있는 계정: 1/3", "인증 요구(HTTP 403) 1개: brav… (11-19 09:05부터)", "https://aistudio.google.com/verify-account", "한도 대기(HTTP 429) 0개", "기록 없음 1개"]) {
    assert.ok(plan.prompt.includes(part), part);
  }
  assert.ok(!plan.prompt.includes("bravo22@example.com"));
  const after = morningStateAfterRun(plan, state, "S1", "t");
  assert.equal(after.relayReported, JSON.stringify({ verify: ["bravo22@example.com"], none: false }));
  // 같은 막힘은 2시간마다 다시 열지 않는다.
  assert.deepEqual(planMorningRun({ ...base, state: after, relay: blocked }), { action: "skip", reason: "nothing-new" });
  // 막힘이 풀리면 기록을 지워 다음에 다시 막히면 또 알린다. 상태를 모르면 지우지 않는다.
  assert.deepEqual(morningStateRelayCleared(after, healthy), { sessionId: "S1", startedAt: "t", reportedSha: "c".repeat(40) });
  assert.equal(morningStateRelayCleared(after, null), null);
  assert.equal(morningStateRelayCleared(after, blocked), null);
  // 이미 알린 막힘은 다른 계기로 열린 보고에 다시 싣지 않고, 막힘이 없어도 싣지 않는다.
  assert.ok(!planMorningRun({ ...base, skills: ["s"], state: after, relay: blocked }).prompt.includes("## AI Studio 중계기 계정"));
  assert.ok(!planMorningRun({ ...base, skills: ["s"], state, relay: healthy }).prompt.includes("## AI Studio 중계기 계정"));
});
