import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SidebarUsage } = await jiti.import("./SidebarUsage.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { accountIdentities } = await jiti.import("../lib/hanse-resource-client.ts");

const HOUR_MS = 3_600_000;

function renderStrip(reports) {
  const state = { status: "fresh", data: { reports }, error: null };
  return renderToStaticMarkup(createElement(I18nProvider, null, createElement(SidebarUsage, {
    usage: {
      state,
      loading: false,
      bai: { status: "unmeasured" },
      async refresh() {
        return state;
      },
      setPaused() {},
    },
    onOpen() {},
  })));
}

/** The limit rows the strip drew, in DOM order, with the account each one belongs to. */
function drawnRows(html) {
  return [...html.matchAll(
    /navigator-usage-label">([^<]*)<\/span><span class="navigator-usage-value"[^>]*>([^<]*)<\/span>[\s\S]*?<\/button>([^<]*)/g,
  )].map((match) => ({ label: match[1], percent: match[2], account: match[3] }));
}

/** The 상태 labels the strip drew, in DOM order. */
function drawnStates(html) {
  return [...html.matchAll(/class="navigator-usage-state">([^<]*)<\/span>/g)].map((match) => match[1]);
}

function anthropicAccount(email, limits, extra = {}) {
  return { provider: "anthropic", disabled: false, metadata: { email }, limits, ...extra };
}

/** 계정 전체가 함께 쓰는 창의 한도. 코어도 `scope.shared` 를 계정 단위 차단 기준으로 본다. */
function sharedLimit(id, label, windowId, status, usedFraction) {
  return { id, label, status, scope: { provider: "anthropic", windowId, shared: true }, amount: { usedFraction } };
}

test("가용 계정 한도가 자동차단·소진 계정보다 먼저 그려진다", () => {
  const now = Date.now();
  const reports = [
    anthropicAccount("cld1@hsps.co.kr", [
      { id: "anthropic:5h", label: "Claude 5 Hour", amount: { usedFraction: 0 } },
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 1 } },
    ], { credentialId: 6, autoBlockedUntilMs: now + HOUR_MS }),
    anthropicAccount("cld2@hsps.co.kr", [
      { id: "anthropic:5h", label: "Claude 5 Hour", amount: { usedFraction: 0.01 } },
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 0.27 } },
    ], { credentialId: 12 }),
  ];
  const aliases = accountIdentities(reports).map((identity) => identity.alias);

  const html = renderStrip(reports);
  const rows = drawnRows(html);

  assert.deepEqual(rows.map((row) => `${row.label} ${row.percent}`), ["Claude 5 Hour 1%", "Claude 7 Day 27%"]);
  assert.deepEqual(rows.map((row) => row.account), [aliases[1], aliases[1]]);
  // 차단 계정의 두 행은 사라지지 않고 개수에 남는다.
  assert.match(html, /Show 2 more/);
});

test("자동차단은 아니어도 소진된 한도는 가용한 한도 뒤로 간다", () => {
  const reports = [
    anthropicAccount("full@hsps.co.kr", [
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 1 } },
    ], { credentialId: 6 }),
    anthropicAccount("room@hsps.co.kr", [
      { id: "anthropic:5h", label: "Claude 5 Hour", amount: { usedFraction: 0.5 } },
    ], { credentialId: 12 }),
  ];
  const aliases = accountIdentities(reports).map((identity) => identity.alias);

  const rows = drawnRows(renderStrip(reports));

  assert.deepEqual(rows.map((row) => `${row.account} ${row.label} ${row.percent}`), [
    `${aliases[1]} Claude 5 Hour 50%`,
    `${aliases[0]} Claude 7 Day 100%`,
  ]);
  // 쓸 수 있는 계정에는 상태가 붙지 않고, 소진된 한도에만 이유가 붙는다.
  assert.deepEqual(drawnStates(renderStrip(reports)), ["limit used up"]);
});

test("공유 주간 한도가 소진된 계정은 5시간이 남아 있어도 가용 계정 뒤로 간다", () => {
  const reports = [
    anthropicAccount("weekly-spent@hsps.co.kr", [
      sharedLimit("anthropic:5h", "Claude 5 Hour", "5h", "ok", 0),
      sharedLimit("anthropic:7d", "Claude 7 Day", "7d", "exhausted", 1),
    ], { credentialId: 6 }),
    anthropicAccount("room@hsps.co.kr", [
      sharedLimit("anthropic:5h", "Claude 5 Hour", "5h", "ok", 0.1),
    ], { credentialId: 12 }),
  ];
  const aliases = accountIdentities(reports).map((identity) => identity.alias);

  const html = renderStrip(reports);
  const rows = drawnRows(html);

  assert.deepEqual(rows.map((row) => `${row.account} ${row.label} ${row.percent}`), [
    `${aliases[1]} Claude 5 Hour 10%`,
    `${aliases[0]} Claude 5 Hour 0%`,
  ]);
  // 계정 전체 창이 소진됐으므로 그 계정의 남은 5시간 행도 가용으로 취급하지 않는다.
  assert.deepEqual(drawnStates(html), ["account limit used up"]);
});

test("티어 전용 한도 소진은 계정 전체 차단과 구분한다", () => {
  const reports = [
    anthropicAccount("tier-spent@hsps.co.kr", [
      sharedLimit("anthropic:5h", "Claude 5 Hour", "5h", "ok", 0.1),
      { id: "anthropic:7d:fable", label: "Claude 7 Day (Fable)", status: "exhausted",
        scope: { provider: "anthropic", tier: "fable", windowId: "7d" },
        amount: { usedFraction: 1 } },
    ], { credentialId: 6 }),
  ];

  const html = renderStrip(reports);
  const rows = drawnRows(html);

  // 공유 창에 여유가 있으면 계정은 가용하다. 소진된 것은 그 티어 한도 행 하나뿐이다.
  assert.deepEqual(rows.map((row) => `${row.label} ${row.percent}`), ["Claude 5 Hour 10%", "Claude 7 Day (Fable) 100%"]);
  assert.deepEqual(drawnStates(html), ["limit used up"]);
});

test("모든 계정이 차단이면 스트립이 그 상태를 함께 보여 준다", () => {
  const now = Date.now();
  const reports = [
    anthropicAccount("cld1@hsps.co.kr", [
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 1 } },
    ], { credentialId: 6, autoBlockedUntilMs: now + HOUR_MS }),
  ];

  const html = renderStrip(reports);
  const rows = drawnRows(html);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Claude 7 Day");
  assert.deepEqual(drawnStates(html), ["auto-blocked"]);
  assert.match(html, /aria-label="[^"]*auto-blocked/);
});

test("남은 한도는 스트립 안에서 펼칠 수 있는 버튼으로 남는다", () => {
  const reports = [
    anthropicAccount("room@hsps.co.kr", [
      { id: "anthropic:5h", label: "Claude 5 Hour", amount: { usedFraction: 0.1 } },
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 0.2 } },
    ], { credentialId: 12 }),
    anthropicAccount("full@hsps.co.kr", [
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 1 } },
    ], { credentialId: 6 }),
  ];

  const html = renderStrip(reports);
  const toggle = html.match(/<button[^>]*class="navigator-usage-more"[^>]*>([^<]*)<\/button>/);

  assert.ok(toggle, "펼침 버튼이 있어야 한다");
  assert.match(toggle[0], /aria-expanded="false"/);
  assert.equal(toggle[1], "Show 1 more");
  // 스트립 자체는 여전히 「사용량 자세히 보기」를 여는 role="button" 이다.
  assert.match(html, /role="button"/);
});

test("꺼둔 계정은 그리지도, 남은 개수에 세지도 않는다", () => {
  const reports = [
    anthropicAccount("off@hsps.co.kr", [
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 1 } },
    ], { credentialId: 6, disabled: true }),
    anthropicAccount("room@hsps.co.kr", [
      { id: "anthropic:5h", label: "Claude 5 Hour", amount: { usedFraction: 0.5 } },
    ], { credentialId: 12 }),
  ];

  const html = renderStrip(reports);
  const rows = drawnRows(html);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Claude 5 Hour");
  assert.doesNotMatch(html, /Show \d+ more/);
});
