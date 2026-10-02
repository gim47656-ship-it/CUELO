import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildOfficeRoster, observeMakerAccount, officeMakerKey, resolveOfficeSelection, OFFICE_MAIN_KEY } =
  await jiti.import("./office-roster.ts");
const { resolveAccountFace, syncAccountFaces } = await jiti.import("../../hooks/useAccountFaces.ts");

// 오피스 자리는 대화 기록·사용량 탭과 같은 얼굴 배정을 거친 값만 받는다. 아래 테스트는 실제
// 얼굴 저장소를 쓴다 — Anthropic 두 계정(RIN·MIO 자리)을 사용량 보고서로 흘려 넣고, Maker 의
// 기록에 박힌 credential 이 그 배정을 지나 어느 자리로 가는지 본다.
syncAccountFaces([
  { provider: "anthropic", credentialId: 11, metadata: { email: "first@example.com" } },
  { provider: "anthropic", credentialId: 12, metadata: { email: "second@example.com" } },
]);
const resolveFace = (provider, credentialId) => resolveAccountFace(undefined, provider, credentialId);

function snapshot(id, overrides = {}) {
  return { id, index: 0, agent: "maker", agentSource: "bundled", status: "running", lastUpdate: 1, ...overrides };
}

function assistant(provider, credentialId) {
  return { role: "assistant", content: [], model: "m", provider, ...(credentialId === undefined ? {} : { credentialId }), timestamp: 1 };
}

const MAIN_RIN = { provider: "anthropic", modelId: "claude-opus-5-5", face: { seed: 0, alias: "RIN(린)" }, state: "working" };

function seatOf(roster, key) {
  const seat = roster.seats.find((entry) => entry.participants.some((participant) => participant.key === key));
  return seat ? seat.alias : null;
}

test("Main sits at the seat of the face the chat window observed, Makers at the seat their recorded account resolves to", () => {
  const subagents = [
    snapshot("CodexMaker", { index: 1, progress: { resolvedModel: "openai-codex/gpt-6-astra" } }),
    snapshot("MioMaker", { index: 2 }),
  ];
  const accounts = new Map([["MioMaker", observeMakerAccount(subagents[1], [assistant("anthropic", 11), assistant("anthropic", 12)])]]);
  const roster = buildOfficeRoster({ main: MAIN_RIN, subagents, accounts, resolveFace });

  assert.equal(seatOf(roster, OFFICE_MAIN_KEY), "RIN(린)");
  // codex 는 provider 예약 얼굴이라 credential 없이도 하나로 정해진다.
  assert.equal(seatOf(roster, officeMakerKey("CodexMaker")), "YUKI(유키)");
  // 마지막 assistant 메시지의 credential(12)이 근거다 — 두 번째 Anthropic 계정 = MIO.
  assert.equal(seatOf(roster, officeMakerKey("MioMaker")), "MIO(미오)");
  assert.deepEqual(roster.unnamed, []);
  assert.deepEqual(roster.participants.map((participant) => participant.key), ["main", "maker:CodexMaker", "maker:MioMaker"]);
  assert.equal(roster.seats.length, 7);
});

test("a Maker without account evidence stays an unnamed participant instead of borrowing a similar character", () => {
  const subagents = [
    // Anthropic 은 계정이 여럿이라 credential 을 보기 전에는 RIN 인지 MIO 인지 모른다.
    snapshot("AnthropicNoCredential", { index: 1, progress: { resolvedModel: "anthropic/claude-opus-5-5" } }),
    // 얼굴 예약이 없는 provider.
    snapshot("OtherProvider", { index: 2, progress: { resolvedModel: "openrouter/some-model" } }),
    // 기록된 모델도 메시지도 없다. 세션 provider 로 메우지 않는다.
    snapshot("NoRecord", { index: 3 }),
  ];
  const accounts = new Map([["NoRecord", observeMakerAccount(subagents[2], [])]]);
  const roster = buildOfficeRoster({ main: MAIN_RIN, subagents, accounts, resolveFace });

  assert.deepEqual(roster.unnamed.map((participant) => participant.key), [
    "maker:AnthropicNoCredential",
    "maker:OtherProvider",
    "maker:NoRecord",
  ]);
  assert.equal(roster.seats.find((seat) => seat.alias === "RIN(린)").participants.length, 1, "only Main sits at RIN");
  assert.equal(accounts.get("NoRecord").provider, null);
});

test("status is the runtime value as observed; a completed Maker is not reported as accepted", () => {
  const subagents = [
    snapshot("Done", { index: 1, status: "completed", progress: { resolvedModel: "openai-codex/gpt-6-astra" } }),
    snapshot("Retrying", { index: 2, status: "running", progress: { resolvedModel: "opencode-go/muse", retryState: { attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "x", startedAtMs: 1 } } }),
  ];
  const roster = buildOfficeRoster({ main: { ...MAIN_RIN, state: "idle" }, subagents, accounts: new Map(), resolveFace });
  const done = roster.participants.find((participant) => participant.key === "maker:Done");
  const retrying = roster.participants.find((participant) => participant.key === "maker:Retrying");
  assert.equal(done.status, "completed");
  assert.equal(done.retrying, false);
  assert.equal(retrying.retrying, true);
  assert.equal(seatOf(roster, "maker:Retrying"), "NOVA(노바)");
  assert.equal(roster.participants[0].state, "idle");
});

test("Main without an observed face is unnamed, and its recipient seat is not guessed from a preset", () => {
  const roster = buildOfficeRoster({
    main: { provider: "anthropic", modelId: "claude-opus-5-5", face: null, state: "idle" },
    subagents: [],
    accounts: new Map(),
    resolveFace,
  });
  assert.equal(seatOf(roster, OFFICE_MAIN_KEY), null);
  assert.deepEqual(roster.unnamed.map((participant) => participant.key), [OFFICE_MAIN_KEY]);
  assert.equal(roster.participants[0].model, "anthropic/claude-opus-5-5");
});

test("a selection whose Maker left the roster falls back to Main instead of pointing at another participant", () => {
  const roster = buildOfficeRoster({ main: MAIN_RIN, subagents: [snapshot("Kept")], accounts: new Map(), resolveFace });
  assert.equal(resolveOfficeSelection(roster, officeMakerKey("Kept")), "maker:Kept");
  assert.equal(resolveOfficeSelection(roster, officeMakerKey("Gone")), OFFICE_MAIN_KEY);
});
