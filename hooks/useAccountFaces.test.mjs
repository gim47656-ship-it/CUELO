import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  requestSessionPin,
  resolveAccountFace,
  syncAccountFaces,
} = await jiti.import("./useAccountFaces.ts");

// 대화창 얼굴 저장소는 세션 pin 을 한 번 받으면 그 세션을 다시 묻지 않던 자리다. 세션 안에서
// 모델이나 계정을 갈아타면 런타임의 답이 달라지는데 웹은 그 사실을 통지받지 못하므로, 낡은
// pin 이 새 계정 조회를 막으면 새 계정의 얼굴이 영영 뜨지 않는다 — codex credential 8 로 pin
// 된 세션이 Anthropic 첫 계정으로 갈아탄 뒤 얼굴이 사라지는 경로가 그랬다. 이 테스트는 그
// 경로를 가짜 라우트로 그대로 밟는다.
//
// 얼굴 배정 자체(계정 순서)는 `lib/hanse-resource-client.test.mjs` 가 지킨다. 여기서는 그
// 배정이 pin 을 지나 대화창까지 오는 길과, 다시 묻는 하한선만 본다.

/** `/api/agent/<id>/account` 만 답하는 가짜 라우트. 답은 테스트가 갈아 끼운다. */
function stubSessionAccount() {
  const calls = [];
  const original = globalThis.fetch;
  let answer = { state: "not-running" };
  globalThis.fetch = async (url) => {
    const path = String(url);
    calls.push(path);
    const sessionId = decodeURIComponent(path.split("/api/agent/")[1]?.split("/")[0] ?? "");
    // `loadSessionAccount` 는 sessionId·observedAt·resetRecommendations 를 요구한다.
    const body = { sessionId, observedAt: Date.now(), resetRecommendations: [], ...answer };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    calls,
    answer(next) {
      answer = next;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** pin 조회는 fetch → json → then 사슬이라 한 틱으로 끝나지 않는다. 넉넉히 비워 준다. */
async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 이 PC 의 실제 목록과 같은 순서. Anthropic 두 계정의 credential id 는 PC 마다 다르다. */
const REPORTS = [
  { provider: "openai-codex", credentialId: 8, metadata: { email: "codex@example.com" } },
  { provider: "anthropic", credentialId: 9, metadata: { email: "first@example.com" } },
  { provider: "anthropic", credentialId: 11, metadata: { email: "second@example.com" } },
];

test("a session that switches provider re-asks instead of answering from the stale pin", async () => {
  const route = stubSessionAccount();
  try {
    syncAccountFaces(REPORTS);

    // 아직 아무것도 모른다. 후보가 여럿인 provider 에서 유일한 활성 계정을 고르지 않는다.
    assert.equal(resolveAccountFace("switch", "anthropic", undefined), null);

    route.answer({ state: "resolved", provider: "openai-codex", credentialId: 8 });
    requestSessionPin("switch", "openai-codex");
    await settle();
    assert.equal(resolveAccountFace("switch", "openai-codex", undefined)?.alias, "YUKI(유키)");
    assert.equal(resolveAccountFace("switch", "anthropic", undefined), null);

    // 세션이 Anthropic 첫 계정으로 갈아탄다. pin 의 provider 가 다르므로 하한선에 막히지 않고
    // 곧바로 다시 묻는다.
    route.answer({ state: "resolved", provider: "anthropic", credentialId: 9 });
    requestSessionPin("switch", "anthropic");
    await settle();
    assert.equal(route.calls.length, 2);
    assert.equal(resolveAccountFace("switch", "anthropic", undefined)?.alias, "RIN(린)");

    // 계정 순서는 그대로다 — 두 번째 Anthropic 계정은 MIO, 메시지가 기록한 credential 이
    // pin 보다 먼저다.
    assert.equal(resolveAccountFace("switch", "anthropic", 11)?.alias, "MIO(미오)");
    assert.equal(resolveAccountFace("switch", "openai-codex", 8)?.alias, "YUKI(유키)");
    // 자식 발화와 WEB6 상담이 지나는 길도 그대로다 — 예약 얼굴은 provider 만으로 나온다.
    assert.equal(resolveAccountFace("switch", "web6", undefined)?.alias, "SHION(시온)");
    assert.equal(resolveAccountFace("switch", "b-ai", undefined)?.alias, "ISANA(이사나)");
  } finally {
    route.restore();
  }
});

test("a pin past the retry window is re-asked, so an account switch inside one provider lands", async () => {
  const route = stubSessionAccount();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    syncAccountFaces(REPORTS);
    route.answer({ state: "resolved", provider: "anthropic", credentialId: 9 });
    requestSessionPin("account-switch", "anthropic");
    await settle();
    assert.equal(resolveAccountFace("account-switch", "anthropic", undefined)?.alias, "RIN(린)");

    // 방금 받은 pin 은 다시 묻지 않는다 — 한 세션의 메시지가 몇 개든 요청은 한 번이다.
    requestSessionPin("account-switch", "anthropic");
    await settle();
    assert.equal(route.calls.length, 1);

    // 하한선이 지나면 다시 묻는다. 세션 안에서 계정만 바뀐 경우를 이 경로로 따라간다.
    clock += 30_000;
    route.answer({ state: "resolved", provider: "anthropic", credentialId: 11 });
    requestSessionPin("account-switch", "anthropic");
    await settle();
    assert.equal(route.calls.length, 2);
    assert.equal(resolveAccountFace("account-switch", "anthropic", undefined)?.alias, "MIO(미오)");
  } finally {
    Date.now = realNow;
    route.restore();
  }
});
