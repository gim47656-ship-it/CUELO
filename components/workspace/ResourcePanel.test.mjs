import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CharacterRosterView,
  ModelsView,
  ResetConfirmation,
  ResourcePanel,
  UsageAccount,
  UsageView,
  focusResetTrigger,
} = await jiti.import("./ResourcePanel.tsx");

function render(props = {}) {
  return renderToStaticMarkup(createElement(ResourcePanel, {
    open: true,
    sessionId: null,
    activeTab: "characters",
    onTabChange() {},
    usage: {
      state: { status: "idle", data: null, error: null },
      loading: false,
      async refresh() {
        return { status: "idle", data: null, error: null };
      },
      setPaused() {},
    },
    ...props,
  }));
}

test("캐릭터가 기본 선택되고 여섯 얼굴·한글 이름·말투·호출 의미가 보인다", () => {
  const html = render();
  assert.match(html, /class="[^"]*resource-panel/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>캐릭터</);
  assert.match(html, /role="tab"[^>]*tabindex="-1"[^>]*>계정 한도</);
  assert.match(html, /role="tab"[^>]*tabindex="-1"[^>]*>모델 통계</);
  for (const alias of ["YUKI(유키)", "ISANA(이사나)", "RIN(린)", "MIO(미오)", "NOVA(노바)", "SHION(시온)"]) {
    assert.match(html, new RegExp(alias.replace(/[()]/g, "\\$&")));
  }
  assert.equal(html.match(/class="account-avatar"/g)?.length, 6);
  assert.match(html, /호출·불러·소환/);
  assert.match(html, /SubAgent로 이 대화에 부릅니다/);
  assert.match(html, /미오 불러와/);
  assert.match(html, /미오로 교체해/);
  assert.match(html, /WEB6 상담으로 호출합니다/);
  assert.match(html, /SHION은 WEB6 상담 전용이라 Main으로 교체할 수 없습니다/);
});

test("연결 해제로 사용량 행이 없어져도 미연결 캐릭터 상태를 표시한다", () => {
  const html = renderToStaticMarkup(createElement(CharacterRosterView, {
    reports: [{ provider: "openai-codex", credentialId: 8, disabled: false }],
    providerConnections: new Map([["opencode-go", false], ["openai-codex", true], ["b-ai", true]]),
  }));
  const nova = html.match(/<article[^>]*aria-labelledby="character-roster-2"[\s\S]*?<\/article>/)?.[0];
  assert.ok(nova, "NOVA 카드가 남아 있어야 한다");
  assert.match(nova, /is-unavailable/);
  assert.match(nova, /aria-describedby="character-roster-2-status"/);
  assert.match(nova, /연결 안 됨/);
  assert.equal(html.match(/is-unavailable/g)?.length, 1);
});

test("패널은 자체 레이어를 만들지 않고 셸의 배치와 닫기 동작을 따른다", () => {
  const html = render();
  assert.doesNotMatch(html, /position:\s*fixed|position:\s*absolute/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, />닫기</);
});

test("계정 한도와 모델 통계는 별도 탭으로 열고 기존 통계는 보존한다", () => {
  const panel = render({ activeTab: "usage" });
  assert.match(panel, /role="tab"[^>]*aria-selected="true"[^>]*>계정 한도</);
  assert.doesNotMatch(panel, /resource-models-heading|모델 집계/);
  const modelsPanel = render({ activeTab: "models" });
  assert.match(modelsPanel, /role="tab"[^>]*aria-selected="true"[^>]*>모델 통계</);
  assert.match(panel, />새로고침</);
  assert.doesNotMatch(panel, /자동 새로고침/);

  const stats = renderToStaticMarkup(createElement(ModelsView, {
    state: {
      status: "fresh",
      error: null,
      data: {
        generatedAt: 1,
        range: {},
        overall: {
          requests: 12,
          failedRequests: 1,
          cost: 4.56,
          tokens: 12_000,
          cacheRate: 0.345,
          cacheSavings: 0.25,
          avgTtft: 1_200,
        },
        models: [{
          model: "claude-opus-5",
          provider: "anthropic",
          requests: 12,
          cost: 4.56,
          costShare: 1,
          costPerRequest: 0.38,
          tokens: 12_000,
          tokensPerRequest: 1_000,
          outputPerRequest: 300,
          cacheRate: 0.345,
          avgTtft: 1_200,
        }],
        agents: [],
        daily: [],
      },
    },
    loading: false,
  }));
  assert.match(stats, />요청</);
  assert.match(stats, />토큰</);
  assert.match(stats, />비용</);
  assert.match(stats, />캐시율</);
  assert.match(stats, />평균 TTFT</);
  assert.match(stats, /claude-opus-5/);
  assert.match(stats, /\$4\.56/);
  assert.match(stats, /34\.5%/);
  assert.match(stats, /1\.2s/);
});

test("closed panels render no surface or local open-state control", () => {
  assert.equal(render({ open: false }), "");
});

const noop = () => {};
const noopReset = async () => {};

function renderUsage(reports, accountState) {
  return renderToStaticMarkup(createElement(UsageView, {
    state: {
      status: "fresh",
      data: { brokerOk: true, generatedAt: 1, reports },
      error: null,
    },
    loading: false,
    accountState,
    pendingActions: new Map(),
    feedbackByCredential: new Map(),
    onToggle: noop,
    onReset: noopReset,
  }));
}

function renderAccount(report, props = {}) {
  return renderToStaticMarkup(createElement(UsageAccount, {
    report,
    brokerOk: true,
    now: Date.parse("2026-09-10T00:00:00Z"),
    active: false,
    pendingAction: null,
    onToggle: noop,
    onReset: noopReset,
    ...props,
  }));
}
test("separates unmatched quota data from local login controls without implying an identity match", () => {
  const html = renderUsage([
    {
      provider: "opencode-go",
      accountRole: "usage-only",
      metadata: { planType: "OpenCode Go" },
      limits: [],
    },
    {
      provider: "opencode-go",
      accountRole: "control-only",
      credentialId: 12,
      disabled: false,
      metadata: {},
      limits: [],
    },
  ], null);
  assert.match(html, /OpenCode Go · 사용량/);
  assert.match(html, /할당량 정보 · 계정 연결 없음/);
  assert.match(html, /OpenCode Go · 계정 제어/);
  assert.match(html, /로그인 계정 · ON\/OFF 제어/);
  assert.equal(html.match(/role="switch"/g)?.length, 1);
  assert.doesNotMatch(html, /제어 불가 · credential id 없음/);
});


test("marks only the first exact live session credential and never infers activity from usage history", () => {
  const reports = [
    { provider: "openai-codex", credentialId: 7, lastUsedAtMs: Date.now(), metadata: { email: "old@example.com" } },
    { provider: "openai-codex", credentialId: 9, metadata: { email: "current@example.com" } },
    { provider: "openai-codex", credentialId: 9, metadata: { email: "duplicate@example.com" } },
  ];
  const resolved = renderUsage(reports, {
    sessionId: "session-a",
    observedAt: 1,
    state: "resolved",
    credentialId: 9,
    source: "session-pin",
    resetRecommendations: [],
  });
  assert.equal(resolved.match(/aria-current="true"/g)?.length, 1);
  assert.equal(resolved.match(/현재 사용 · 이 세션/g)?.length, 1);
  assert.doesNotMatch(resolved, /최근 5분/);

  const unresolved = renderUsage(reports, {
    sessionId: "session-a",
    observedAt: 2,
    state: "unresolved",
    resetRecommendations: [],
  });
  assert.doesNotMatch(unresolved, /aria-current|현재 사용/);
});

test("renders an accessible fixed-width ON/OFF switch without dimming the account row", () => {
  const html = renderAccount({
    provider: "openai-codex",
    credentialId: 7,
    disabled: true,
    metadata: { email: "account@example.com" },
  });
  assert.match(html, /data-account-state="off"/);
  assert.match(html, /role="switch"[^>]*aria-checked="false"/);
  assert.match(html, /resource-account-switch/);
  assert.match(html, />OFF</);
  assert.match(html, /다른 계정이 있으면 이 계정을 사용하지 않습니다/);
  assert.doesNotMatch(html, /opacity-70/);
});

test("distinguishes empty and unavailable saved resets and exposes no redeem action", () => {
  const empty = renderAccount({
    provider: "openai-codex",
    credentialId: 7,
    savedReset: { state: "empty", availableCount: 0, checkedAt: 1, credits: [] },
  });
  assert.match(empty, /data-reset-state="empty"/);
  assert.match(empty, /저장된 리셋/);
  assert.match(empty, />없음</);
  assert.doesNotMatch(empty, />리셋 사용</);

  const unavailable = renderAccount({
    provider: "openai-codex",
    credentialId: 7,
    savedReset: { state: "unavailable", availableCount: null, checkedAt: 1, credits: [], error: "offline" },
  });
  assert.match(unavailable, /data-reset-state="unavailable"/);
  assert.match(unavailable, />확인 불가</);
  assert.doesNotMatch(unavailable, />리셋 사용</);
});

test("shows the available count, earliest expiry, and only the core-provided recommendation", () => {
  const html = renderAccount({
    provider: "openai-codex",
    credentialId: 7,
    savedReset: {
      state: "available",
      availableCount: 2,
      checkedAt: 1,
      credits: [
        { id: "later", expiresAt: "2026-09-11T00:00:00Z" },
        { id: "earlier", expiresAt: "2026-09-10T06:00:00Z" },
      ],
    },
  }, {
    recommendation: {
      credentialId: 7,
      reason: "expiring-credit",
      expiresAt: "2026-09-10T06:00:00Z",
      usedFraction: 0.25,
      window: "5h",
    },
  });
  assert.match(html, /data-reset-state="ready"/);
  assert.match(html, /2개 · 6h 0m 후 만료/);
  assert.match(html, /권고 — 리셋 1개가 6h 0m 후 만료됩니다/);
  assert.match(html, />리셋 사용</);
});

test("renders Anthropic Cedar reset count, earliest expiry, and covered window on both account cards", () => {
  const reports = [7, 8].map((credentialId) => ({
    provider: "anthropic",
    credentialId,
    disabled: false,
    metadata: { email: `claude-${credentialId}@example.test`, accountId: `workspace-${credentialId}` },
    savedReset: {
      state: "available",
      availableCount: 2,
      redeemableCount: 1,
      nextCreditId: `cedar-${credentialId}`,
      eligible: true,
      checkedAt: 1,
      credits: [{
        id: `cedar-${credentialId}`,
        expiresAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
        program: "cedar_ember",
        remainingCount: 1,
        usable: true,
        requiresLimit: true,
        clears: ["anthropic:5h"],
        blocking: ["anthropic:5h"],
      }],
    },
  }));
  const html = renderUsage(reports, null);
  assert.match(html, /린/);
  assert.match(html, /미오/);
  assert.equal(html.match(/2개 · \d+h \d+m 후 만료/g)?.length, 2);
  assert.equal(html.match(/5시간 한도만/g)?.length, 2);
  assert.equal(html.match(/>리셋 사용</g)?.length, 2);

  const unavailable = renderAccount({
    provider: "anthropic",
    credentialId: 7,
    savedReset: { state: "unavailable", availableCount: null, checkedAt: 1, credits: [] },
  });
  assert.match(unavailable, /data-reset-state="unavailable"/);
  assert.match(unavailable, />확인 불가</);
  assert.doesNotMatch(unavailable, />리셋 사용</);
});

test("confirmation has explicit irreversible copy, two actions, and a focus-return seam", () => {
  const html = renderToStaticMarkup(createElement(ResetConfirmation, {
    confirmId: "confirm-reset",
    pending: false,
    primaryRef: { current: null },
    summary: "2개 · 3h 0m 후 만료",
    onConfirm: noop,
    onCancel: noop,
  }));
  assert.match(html, /role="group" aria-label="리셋 사용 확인"/);
  assert.match(html, /리셋 1개를 지금 사용합니다\. 되돌릴 수 없습니다\./);
  assert.match(html, /aria-describedby="confirm-reset"[^>]*>리셋 사용</);
  assert.match(html, />취소</);

  let focused = 0;
  focusResetTrigger({ focus() { focused += 1; } });
  assert.equal(focused, 1);
});
