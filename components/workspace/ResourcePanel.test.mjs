import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ApiCreditsCards,
  CharacterRosterView,
  ModelsView,
  ResetConfirmation,
  ResourcePanel,
  UsageAccount,
  UsageView,
  focusResetTrigger,
} = await jiti.import("./ResourcePanel.tsx");
const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");
const { translateMessage } = await jiti.import("../../lib/i18n/format.ts");
const { getLocalePlugin } = await jiti.import("../../lib/i18n/registry.ts");

function render(props = {}) {
  return renderToStaticMarkup(createElement(I18nProvider, null, createElement(ResourcePanel, {
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
  })));
}

test("캐릭터가 기본 선택되고 일곱 얼굴·한글 이름·말투·호출 의미가 보인다", () => {
  const html = render();
  assert.match(html, /class="[^"]*resource-panel/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>캐릭터</);
  assert.match(html, /role="tab"[^>]*tabindex="-1"[^>]*>계정 한도</);
  assert.match(html, /role="tab"[^>]*tabindex="-1"[^>]*>모델 통계</);
  for (const alias of ["YUKI(유키)", "ISANA(이사나)", "RIN(린)", "MIO(미오)", "MITSU(미츠)", "HIKARI(히카리)", "SHION(시온)"]) {
    assert.match(html, new RegExp(alias.replace(/[()]/g, "\\$&")));
  }
  assert.equal(html.match(/class="account-avatar"/g)?.length, 7);
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
    providerConnections: new Map([["hive", false], ["openai-codex", true]]),
  }));
  // hive 하나가 ISANA(DeepSeek)와 MITSU(GLM)를 모두 돌리므로 둘 다 미연결로 표시된다.
  const mitsu = html.match(/<article[^>]*aria-labelledby="character-roster-2"[\s\S]*?<\/article>/)?.[0];
  assert.ok(mitsu, "MITSU 카드가 남아 있어야 한다");
  assert.match(mitsu, /is-unavailable/);
  assert.match(mitsu, /aria-describedby="character-roster-2-status"/);
  assert.match(mitsu, /연결 안 됨/);
  assert.equal(html.match(/is-unavailable/g)?.length, 2);
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
  assert.match(stats, />추정 비용</);
  assert.match(stats, /금액은 토큰 단가로 계산한 추정치이며 실제 청구액이나 구독 사용량이 아닙니다/, "the estimate disclaimer is visible even when every cost is priced");
  assert.doesNotMatch(stats, /≥|최솟값|\(일부\)/, "a complete snapshot shows no lower-bound marks");
  assert.match(stats, />캐시율</);
  assert.match(stats, />평균 TTFT</);
  assert.match(stats, /claude-opus-5/);
  assert.match(stats, /\$4\.56/);
  assert.match(stats, /34\.5%/);
  assert.match(stats, /1\.2s/);
});

const incompleteStats = {
  generatedAt: 1,
  range: {},
  overall: {
    requests: 40,
    failedRequests: 0,
    cost: 4.56,
    costComplete: false,
    unpricedModels: 1,
    tokens: 50_000,
    cacheRate: 0.9,
    cacheExcludedModels: 2,
    cacheSavings: 0.5,
  },
  models: [
    { model: "claude-opus-5", provider: "anthropic", requests: 10, cost: 4.56, pricing: "priced", costShare: 1, costPerRequest: 0.456,
      tokens: 10_000, tokensPerRequest: 1_000, outputPerRequest: 100, cacheRate: 0.9, cacheStatus: "reported" },
    { model: "deepseek-v4.1-flash", provider: "b-ai", requests: 10, cost: 0, pricing: "unpriced", costShare: 0, costPerRequest: null,
      tokens: 10_000, tokensPerRequest: 1_000, outputPerRequest: 100, cacheRate: 0.96, cacheStatus: "reported" },
    { model: "typesafe/jev-1.14", provider: "openrouter", requests: 10, cost: 0.01, pricing: "priced", costShare: 0, costPerRequest: 0.001,
      tokens: 10_000, tokensPerRequest: 1_000, outputPerRequest: 0, cacheStatus: "not-reported" },
    { model: "kimi-k3", provider: "a6api", requests: 5, cost: 0, pricing: "unpriced", costShare: 0, costPerRequest: null,
      tokens: 5_000, tokensPerRequest: 1_000, outputPerRequest: 0, cacheStatus: "unknown" },
    { model: "free-model", provider: "local", requests: 5, cost: 0, pricing: "free", costShare: 0, costPerRequest: 0,
      tokens: 5_000, tokensPerRequest: 1_000, outputPerRequest: 0, cacheRate: 0, cacheStatus: "reported" },
  ],
  agents: [{ agentType: "main", requests: 40, cost: 4.56, costComplete: false, costShare: 1, costPerRequest: 0.114, tokensPerRequest: 1_250 }],
  daily: [{ timestamp: Date.parse("2026-10-17T03:00:00Z"), cost: 1.5, costComplete: false,
    models: [{ model: "deepseek-v4.1-flash", provider: "b-ai", cost: 0, pricing: "unpriced" }] }],
};

function section(html, heading) {
  return html.match(new RegExp(`<section aria-labelledby="${heading}"[\\s\\S]*?</section>(?=<section|<p)`))?.[0] ?? "";
}

function modelRow(html, name) {
  return html.split("<section").find((part) => part.includes(`title="${name}"`)) ?? "";
}

test("가격표가 없거나 캐시를 보고하지 못하는 값은 실제 0으로 보이지 않고 합계는 최소값으로 표시한다", () => {
  const html = renderToStaticMarkup(createElement(ModelsView, { state: { status: "fresh", error: null, data: incompleteStats }, loading: false }));
  const overall = section(html, "resource-overall-heading");
  assert.match(overall, />추정 비용<\/dt><dd[^>]*>≥\$4\.56</);
  assert.match(overall, />캐시율\(일부\)<\/dt><dd[^>]*>90\.0%</);
  assert.match(overall, />캐시 절감\(일부\)</);

  const bai = modelRow(html, "deepseek-v4.1-flash");
  assert.match(bai, />가격 미상</);
  assert.doesNotMatch(bai, /\$0/);
  assert.match(bai, />96\.0%</, "unpriced usage still shows its real cache hits");
  assert.match(modelRow(html, "typesafe/jev-1.14"), />캐시율<\/dt><dd[^>]*>미보고</);
  assert.match(modelRow(html, "kimi-k3"), />캐시율<\/dt><dd[^>]*>알 수 없음</);
  const free = modelRow(html, "free-model");
  assert.match(free, />\$0 · 0%</, "an explicitly free model keeps its real $0");
  assert.match(free, />캐시율<\/dt><dd[^>]*>0\.0%</);

  assert.match(section(html, "resource-agents-heading"), />≥\$4\.56 · 100%</);
  assert.match(section(html, "resource-daily-heading"), />일별 추정 비용<[\s\S]*>≥\$1\.50</);
  assert.match(html, /가격을 다 매기지 못한 모델이 1개/);
  assert.match(html, /≥가 붙은 금액은 추정 비용의 최솟값입니다/);
  assert.match(html, /모델 2개는 캐시율 계산에서 뺐습니다/);
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

// 2026-09-28: RIN(5h 5%·7d 1%) was blocked 5 minutes after a token refresh hit
// `database is locked`, and the card said the quota was spent.
test("an auto-block only blames the quota when a limit is actually exhausted", () => {
  const blocked = (usedFraction) => renderAccount({
    provider: "anthropic",
    credentialId: 6,
    disabled: false,
    autoBlockedUntilMs: Date.parse("2026-09-10T00:05:00Z"),
    metadata: { email: "rin@example.com" },
    limits: [{ id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction } }],
  });
  const transient = blocked(0.05);
  assert.match(transient, /data-account-state="auto-blocked"/);
  assert.match(transient, /한도는 남아 있지만/);
  assert.doesNotMatch(transient, /한도를 다 써서/);
  assert.match(blocked(1), /한도를 다 써서 코어가 자동으로 차단했습니다/);
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

const koMessages = { ko: getLocalePlugin("ko").messages, en: getLocalePlugin("en").messages };
const tKo = (key, params) => translateMessage("ko", key, koMessages, params);

function creditSnapshot({ hiveSetting = null, hiveExtra = {} } = {}) {
  const totals = (spentUsd, setting, complete = true) => ({
    spentUsd, spentComplete: complete, totalUsd: setting?.totalUsd ?? null,
    remainingUsd: setting ? setting.totalUsd - spentUsd : null, remainingUpperBound: Boolean(setting) && !complete, upperBoundRows: false,
  });
  return {
    generatedAt: 1, settingsError: null, priceCheckedAt: "2026-10-26",
    settings: { hive: hiveSetting },
    hive: {
      wallet: "hive", scope: "this-pc", source: "session-logs", since: hiveSetting?.startDate ?? "2026-09-26",
      sinceSource: hiveSetting ? "start-date" : "default", status: "ok", error: null, observedAt: 1, priceSources: [],
      rows: [
        { model: "deepseek-ai/deepseek-v4.1-flash-1017", requests: 953, inputTokens: 19_106_309, outputTokens: 1_480_831, cacheReadTokens: 59_417_600, cacheWriteTokens: 0, costUsd: 2.6072, pricing: "exact",
          purposes: [{ purpose: "session", requests: 500, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.7757 },
            { purpose: "skim", requests: 67, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.705 }] },
        { model: "zai-org/glm-5.3-flash", requests: 1, inputTokens: 40_964, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002, pricing: "exact",
          purposes: [{ purpose: "session", requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002 }] },
      ],
      ...totals(2.6092, hiveSetting), ...hiveExtra,
    },
  };
}

function renderCredits(data) {
  return renderToStaticMarkup(createElement(ApiCreditsCards, {
    state: { status: "fresh", data, error: null }, loading: false, onSave: async () => {}, t: tKo,
  }));
}

test("API 크레딧은 Hive 카드 하나에 캐릭터 얼굴·범위·추정 잔액을 보여 주고 Google Cloud 칸은 없다", () => {
  const html = renderCredits(creditSnapshot({ hiveSetting: { totalUsd: 25, startDate: "2026-10-18" } }));
  assert.match(html, /API 크레딧/);
  assert.match(html, /추정치입니다\. 청구서 금액이 아닙니다\./);
  assert.equal(html.match(/<section[^>]*data-credit-wallet=/g)?.length, 1);
  const hive = html.match(/<section[^>]*data-credit-wallet="hive"[\s\S]*?<\/section>/)?.[0];
  assert.ok(hive);
  assert.doesNotMatch(html, /Google Cloud|Cloud Monitoring/);
  assert.match(hive, /이 PC 기록 · 2026-10-18부터/);
  assert.match(hive, /ISANA\(이사나\)/);
  assert.match(hive, /MITSU\(미츠\)/);
  assert.match(hive, /대화·에이전트 \$1\.78 · skim \$0\.705/);
  assert.match(hive, /\$22\.39/);
  assert.match(hive, />사용 10%</, "the bar fills with spent share, so its caption says used, not remaining");
  assert.doesNotMatch(html, /총액과 시작일을 넣으면/);
  assert.doesNotMatch(html, /만료일/, "the editor has no expiry field");
});

test("크레딧을 넣기 전에는 사용량만 보이고 입력 안내가 나온다; 미상은 하한·상한으로, 조회 실패는 오류로 표시한다", () => {
  const empty = renderCredits(creditSnapshot());
  assert.equal(empty.match(/총액과 시작일을 넣으면 추정 잔액을 계산합니다\./g)?.length, 1);
  assert.doesNotMatch(empty, /role="progressbar"/);
  assert.match(empty, /최근 30일/);
  assert.equal(empty.match(/>크레딧 입력</g)?.length, 1);
  assert.match(empty, /추정 사용[\s\S]*?\$2\.61/);

  const partial = renderCredits(creditSnapshot({
    hiveSetting: { totalUsd: 300, startDate: "2026-08-01" },
    hiveExtra: {
      spentComplete: false, remainingUpperBound: true, remainingUsd: 299, spentUsd: 1,
      rows: [{ model: "acme/new-model", requests: 1, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, pricing: "unknown", purposes: [] }],
    },
  }));
  assert.match(partial, /≤\$299/);
  assert.match(partial, /≥\$1\.00/);
  assert.match(partial, /단가 미상/);

  const failed = renderCredits(creditSnapshot({
    hiveSetting: { totalUsd: 300, startDate: "2026-10-01" },
    hiveExtra: { status: "error", error: "session_scan_failed", rows: [], spentUsd: 0, spentComplete: false, remainingUsd: null },
  }));
  assert.match(failed, /사용량을 읽지 못했습니다: 세션 기록을 읽지 못했습니다/);
  assert.doesNotMatch(failed, /role="progressbar"/, "잔액을 모르면 0% 막대를 그리지 않는다");
  assert.doesNotMatch(failed, /추정 잔액/);
});

function anthropicWallet(extra = {}) {
  return {
    wallet: "anthropic", scope: "this-pc", source: "session-logs", since: "2026-09-29", sinceSource: "default",
    status: "ok", error: null, observedAt: 1, coverageSince: Date.parse("2026-10-21T12:00:00Z"), oauthRequests: 12, unattributedRequests: 0,
    rows: [], spentUsd: 0, spentComplete: true, ...extra,
  };
}

function anthropicSection(extra) {
  const html = renderCredits({ ...creditSnapshot(), anthropic: anthropicWallet(extra) });
  assert.match(html, /data-credit-wallet="hive"/, "the Hive card stays");
  return html.match(/<section[^>]*data-credit-wallet="anthropic"[\s\S]*?<\/section>/)?.[0];
}

test("Anthropic API 카드는 API 키 요청만 보이고 OAuth·미기록 요청은 제외 수로만, 캐시 읽기·쓰기는 따로 보인다", () => {
  const card = anthropicSection({
    unattributedRequests: 3, spentUsd: 1.97, spentComplete: false,
    rows: [{
      model: "claude-opus-5-5", requests: 2, inputTokens: 2_004, outputTokens: 20_100, cacheReadTokens: 400_000, cacheWriteTokens: 201_000,
      costUsd: 1.97, unpricedRequests: 1, costs: { input: 0.01, output: 0.5, cacheRead: 0.2, cacheWrite: null },
      purposes: [{ purpose: "session", requests: 2, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.97, unpricedRequests: 1 }],
    }],
  });
  assert.ok(card);
  assert.match(card, /Anthropic API/);
  assert.match(card, /구독\(OAuth\) 요청과 토큰 없는 실패는 제외/);
  assert.match(card, /인증 방식 최초 기록: 2026-10-21/);
  assert.match(card, /구독\(OAuth\) 제외[\s\S]*?12회/);
  assert.match(card, /인증 미기록 제외[\s\S]*?3회/);
  assert.match(card, /추정 사용[\s\S]*?≥\$1\.97/, "an unpriced paid request makes the spend a lower bound");
  assert.match(card, /캐시 읽기 400K \$0\.200 · 캐시 쓰기 201K 단가 미상/);
  assert.match(card, /대화·에이전트 ≥\$1\.97/);
  assert.doesNotMatch(card, /role="progressbar"|크레딧 입력|추정 잔액/, "no balance or credit editor for Anthropic");
});

test("두 크레딧 카드는 추정과 따로 각 공급자 결제 화면으로 가는 새 탭 링크를 단다", () => {
  const html = renderCredits({ ...creditSnapshot(), anthropic: anthropicWallet() });
  const link = (wallet) => html.match(new RegExp(`<section[^>]*data-credit-wallet="${wallet}"[\\s\\S]*?<a ([^>]*data-billing-link="${wallet}"[^>]*)>`))?.[1];
  const hive = link("hive");
  const anthropic = link("anthropic");
  assert.match(hive ?? "", /href="https:\/\/portal\.deploy\.com\/"/);
  assert.match(anthropic ?? "", /href="https:\/\/platform\.claude\.com\/settings\/billing"/);
  for (const attrs of [hive, anthropic]) {
    assert.match(attrs, /target="_blank"/);
    assert.match(attrs, /rel="noopener noreferrer"/);
  }
  assert.match(anthropic, /aria-label="Anthropic API 결제 화면에서 실제 잔액 보기\(새 탭\)"/);
});

test("Anthropic API 카드는 기록 없음·요청 없음·조회 실패를 서로 다르게 보인다", () => {
  const none = anthropicSection({ coverageSince: null, unattributedRequests: 5 });
  assert.match(none, /data-anthropic-coverage="none"/);
  assert.match(none, /API 키 사용량을 알 수 없습니다/);
  assert.doesNotMatch(none, /추정 사용/, "unknown coverage is not a measured $0");

  const quiet = anthropicSection();
  assert.match(quiet, /data-anthropic-coverage="recorded"/);
  assert.match(quiet, /이 기간에 기록된 API 키 요청이 없습니다/);
  assert.match(quiet, /추정 사용[\s\S]*?\$0</);
  assert.doesNotMatch(quiet, /인증 미기록 제외/);

  const failed = anthropicSection({ status: "error", error: "session_scan_failed", coverageSince: null, spentComplete: false });
  assert.match(failed, /사용량을 읽지 못했습니다: 세션 기록을 읽지 못했습니다/);
  assert.doesNotMatch(failed, /data-anthropic-coverage|추정 사용/);

  const partial = anthropicSection({ status: "error", error: "session_scan_partial", spentComplete: false });
  assert.match(partial, /일부 세션 기록을 읽지 못해/);
  assert.match(partial, /추정 사용[\s\S]*?≥\$0</);

  const unpricedOnly = anthropicSection({ spentUsd: null, spentComplete: false, rows: [{
    model: "claude-x", requests: 1, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, unpricedRequests: 1,
    costs: { input: null, output: 0, cacheRead: 0, cacheWrite: 0 }, purposes: [],
  }] });
  assert.match(unpricedOnly, /추정 사용[\s\S]*?단가 미상/, "paid requests with no known price are unknown, not ≥$0");
  assert.doesNotMatch(unpricedOnly, /≥\$0/);
});

test("계정 한도 탭은 구독 계정 아래에 API 크레딧 구역을 단다", () => {
  const panel = render({ activeTab: "usage" });
  assert.match(panel, /<h2 class="resource-group-heading">계정 한도<\/h2>[\s\S]*<h2 class="resource-group-heading">API credits<\/h2>/);
});
