import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolveLiveCharacter } = await jiti.import("./live-character.ts");

/** Two stored Anthropic accounts; `pinned` is this session's sticky credential. */
function anthropicSession(pinned, { position = true } = {}) {
  const stored = [{ credentialId: 11 }, { credentialId: 22 }];
  const session = {
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    async listCurrentProviderOAuthAccounts() {
      return {
        provider: "anthropic",
        accounts: stored.map((account, index) => ({
          ...(position ? { position: index } : {}),
          credentialId: account.credentialId,
          active: account.credentialId === pinned,
        })),
      };
    },
  };
  return session;
}

test("같은 Anthropic 모델의 두 세션은 각자 pin된 계정으로 RIN과 MIO가 갈린다", async () => {
  const [rin, mio] = await Promise.all([
    resolveLiveCharacter(anthropicSession(11)),
    resolveLiveCharacter(anthropicSession(22)),
  ]);
  assert.equal(rin, "RIN(린)");
  assert.equal(mio, "MIO(미오)");
  assert.equal(await resolveLiveCharacter(anthropicSession(22, { position: false })), "MIO(미오)", "position이 없으면 저장 순서");
});

test("아직 pin이 없으면 다른 캐릭터로 추측하지 않는다", async () => {
  assert.equal(await resolveLiveCharacter(anthropicSession(undefined)), null);
  const listingFails = { model: { provider: "anthropic" }, async listCurrentProviderOAuthAccounts() { throw new Error("db"); } };
  assert.equal(await resolveLiveCharacter(listingFails), null);
});

test("첫 요청 전 통화는 이 세션의 계정을 먼저 정해 기본 음성으로 떨어지지 않는다", async () => {
  let pinned;
  let pins = 0;
  const session = anthropicSession(undefined);
  const unpinned = session.listCurrentProviderOAuthAccounts;
  session.listCurrentProviderOAuthAccounts = async () => {
    const listing = await unpinned();
    return { ...listing, accounts: listing.accounts.map((account) => ({ ...account, active: account.credentialId === pinned })) };
  };
  const pinCredential = async () => { pins += 1; pinned = 22; };
  assert.equal(await resolveLiveCharacter(session, { pinCredential }), "MIO(미오)");
  assert.equal(await resolveLiveCharacter(session, { pinCredential }), "MIO(미오)");
  assert.equal(pins, 1, "이미 pin된 세션은 다시 정하지 않는다");
  const failing = async () => { throw new Error("no credential"); };
  assert.equal(await resolveLiveCharacter(anthropicSession(undefined), { pinCredential: failing }), null);
});

test("조회 중 세션이 다른 provider로 갈아타면 옛 목록을 쓰지 않는다", async () => {
  const session = anthropicSession(11);
  const list = session.listCurrentProviderOAuthAccounts;
  session.listCurrentProviderOAuthAccounts = async () => {
    const listing = await list();
    session.model = { provider: "openai-codex", id: "gpt-6-astra" };
    return listing;
  };
  assert.equal(await resolveLiveCharacter(session), null);
});

test("계정이 하나뿐인 provider는 예약 얼굴, 모르는 provider는 없음", async () => {
  const plain = (provider) => ({ model: { provider }, listCurrentProviderOAuthAccounts: async () => undefined });
  assert.equal(await resolveLiveCharacter(plain("openai-codex")), "YUKI(유키)");
  assert.equal(await resolveLiveCharacter(plain("b-ai")), "ISANA(이사나)");
  assert.equal(await resolveLiveCharacter(plain("opencode-go")), "NOVA(노바)");
  assert.equal(await resolveLiveCharacter(plain("google-antigravity")), "HIKARI(히카리)");
  assert.equal(await resolveLiveCharacter(plain("devin")), null);
  assert.equal(await resolveLiveCharacter({ model: undefined }), null);
});
