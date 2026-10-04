import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SidebarUsage, createReloginCheck, mergeStripOrder, orderStripAccounts, reloginOutcome } = await jiti.import("./SidebarUsage.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { accountIdentities } = await jiti.import("../lib/hanse-resource-client.ts");

const HOUR_MS = 3_600_000;

function renderStrip(reports, onRelogin = () => {}) {
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
    onRelogin,
  })));
}

/** The account groups the strip drew, in DOM order: the alias and that account's chunk of markup. */
function drawnGroups(html) {
  return html.split('class="navigator-usage-group"').slice(1).map((chunk) => ({
    account: chunk.match(/navigator-usage-alias">([^<]*)</)?.[1],
    html: chunk,
  }));
}

/** The limit rows the strip drew, in DOM order, with the account each one belongs to. */
function drawnRows(html) {
  return drawnGroups(html).flatMap((group) => [...group.html.matchAll(
    /navigator-usage-label">([^<]*)<\/span>(?:<span class="navigator-usage-state">[^<]*<\/span>)?<span class="navigator-usage-value"[^>]*>([^<]*)<\/span>/g,
  )].filter((match) => match[1] !== "B.AI tokens").map((match) => ({ label: match[1], percent: match[2], account: group.account })));
}

/** The 상태 labels the strip drew, in DOM order. */
function drawnStates(html) {
  return [...html.matchAll(/class="navigator-usage-state"(?: data-tone="danger")?>([^<]*)<\/span>/g)].map((match) => match[1]);
}

function anthropicAccount(email, limits, extra = {}) {
  return { provider: "anthropic", disabled: false, metadata: { email }, limits, ...extra };
}

/** 계정 전체가 함께 쓰는 창의 한도. 코어도 `scope.shared` 를 계정 단위 차단 기준으로 본다. */
function sharedLimit(id, label, windowId, status, usedFraction) {
  return { id, label, status, scope: { provider: "anthropic", windowId, shared: true }, amount: { usedFraction } };
}

test("가용 계정의 주간 한도가 차단 계정보다 먼저 그려지고, 여유 있는 5시간 창은 접힌다", () => {
  const now = Date.now();
  const reports = [
    anthropicAccount("cld1@example.test", [
      { id: "anthropic:5h", label: "Claude 5 Hour", amount: { usedFraction: 0 } },
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 1 } },
    ], { credentialId: 6, autoBlockedUntilMs: now + HOUR_MS }),
    anthropicAccount("cld2@example.test", [
      { id: "anthropic:5h", label: "Claude 5 Hour", amount: { usedFraction: 0.01 } },
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 0.27 } },
    ], { credentialId: 12 }),
  ];
  const aliases = accountIdentities(reports).map((identity) => identity.alias);

  const html = renderStrip(reports);
  const rows = drawnRows(html);

  assert.deepEqual(rows.map((row) => `${row.account} ${row.label} ${row.percent}`), [
    `${aliases[1]} Claude 7 Day 27%`,
    `${aliases[0]} Claude 7 Day 100%`,
  ]);
  assert.deepEqual(drawnStates(html), ["auto-blocked"]);
  // 접힌 5시간 창은 「더 보기」로 세지 않는다. 자세한 창은 사용량 보기가 그대로 보여 준다.
  assert.doesNotMatch(html, /Show \d+ more/);
});

test("주간이 있어도 90% 이상이거나 소진된 5시간 창은 접지 않는다", () => {
  const reports = [
    anthropicAccount("hot@example.test", [
      { id: "anthropic:5h", label: "Claude 5 Hour", amount: { usedFraction: 0.93 } },
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 0.4 } },
    ], { credentialId: 12 }),
    anthropicAccount("spent@example.test", [
      sharedLimit("anthropic:5h", "Claude 5 Hour", "5h", "exhausted", 1),
      sharedLimit("anthropic:7d", "Claude 7 Day", "7d", "ok", 0.3),
    ], { credentialId: 6 }),
  ];
  const aliases = accountIdentities(reports).map((identity) => identity.alias);

  const html = renderStrip(reports);
  const rows = drawnRows(html);

  assert.deepEqual(rows.map((row) => `${row.account} ${row.label} ${row.percent}`), [
    `${aliases[0]} Claude 5 Hour 93%`,
    `${aliases[0]} Claude 7 Day 40%`,
  ]);
  // 소진된 공유 5시간 창을 가진 계정은 뒤로 가되 개수로 남는다.
  assert.match(html, /Show 2 more/);
});

test("자동차단은 아니어도 소진된 한도는 가용한 한도 뒤로 간다", () => {
  const reports = [
    anthropicAccount("full@example.test", [
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 1 } },
    ], { credentialId: 6 }),
    anthropicAccount("room@example.test", [
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

test("공유 주간 한도가 소진된 계정은 가용 계정 뒤로 가고, 여유 있는 5시간 창은 접힌다", () => {
  const reports = [
    anthropicAccount("weekly-spent@example.test", [
      sharedLimit("anthropic:5h", "Claude 5 Hour", "5h", "ok", 0),
      sharedLimit("anthropic:7d", "Claude 7 Day", "7d", "exhausted", 1),
    ], { credentialId: 6 }),
    anthropicAccount("room@example.test", [
      sharedLimit("anthropic:5h", "Claude 5 Hour", "5h", "ok", 0.1),
    ], { credentialId: 12 }),
  ];
  const aliases = accountIdentities(reports).map((identity) => identity.alias);

  const html = renderStrip(reports);
  const rows = drawnRows(html);

  // 5시간 창만 보고한 계정은 그 창을 그대로 보여 준다.
  assert.deepEqual(rows.map((row) => `${row.account} ${row.label} ${row.percent}`), [
    `${aliases[1]} Claude 5 Hour 10%`,
    `${aliases[0]} Claude 7 Day 100%`,
  ]);
  assert.deepEqual(drawnStates(html), ["account limit used up"]);
});

test("티어 전용 한도 소진은 계정 전체 차단과 구분한다", () => {
  const reports = [
    anthropicAccount("tier-spent@example.test", [
      sharedLimit("anthropic:5h", "Claude 5 Hour", "5h", "ok", 0.1),
      { id: "anthropic:7d:fable", label: "Claude 7 Day (Fable)", status: "exhausted",
        scope: { provider: "anthropic", tier: "fable", windowId: "7d" },
        amount: { usedFraction: 1 } },
    ], { credentialId: 6 }),
  ];

  const html = renderStrip(reports);
  const rows = drawnRows(html);

  // 공유 창에 여유가 있어 계정은 가용하다. 소진된 것은 그 티어 한도 행 하나뿐이고, 계정 전체
  // 소진으로 표시하지 않는다.
  assert.deepEqual(rows.map((row) => `${row.label} ${row.percent}`), ["Claude 7 Day (Fable) 100%"]);
  assert.deepEqual(drawnStates(html), ["limit used up"]);
});

test("모든 계정이 차단이면 스트립이 그 상태를 함께 보여 준다", () => {
  const now = Date.now();
  const reports = [
    anthropicAccount("cld1@example.test", [
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
    anthropicAccount("room@example.test", [
      { id: "anthropic:5h", label: "Claude 5 Hour", amount: { usedFraction: 0.1 } },
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 0.2 } },
    ], { credentialId: 12 }),
    anthropicAccount("half@example.test", [
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 0.5 } },
    ], { credentialId: 13 }),
    anthropicAccount("full@example.test", [
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 1 } },
    ], { credentialId: 6 }),
  ];

  const html = renderStrip(reports);
  const toggle = html.match(/<button[^>]*class="navigator-usage-more"[^>]*>([^<]*)<\/button>/);

  assert.ok(toggle, "펼침 버튼이 있어야 한다");
  assert.match(toggle[0], /aria-expanded="false"/);
  assert.equal(toggle[1], "Show 1 more");
  // 스트립을 여는 것은 이름 있는 실제 버튼이다. 외곽이 버튼이면 안쪽 버튼들이 중첩된다.
  assert.match(html, /<button type="button" class="navigator-usage-open" aria-label="Open usage details: [^"]+">Usage<\/button>/);
  assert.doesNotMatch(html, /role="button"/);
});

test("꺼둔 계정은 그리지도, 남은 개수에 세지도 않는다", () => {
  const reports = [
    anthropicAccount("off@example.test", [
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 1 } },
    ], { credentialId: 6, disabled: true }),
    anthropicAccount("room@example.test", [
      { id: "anthropic:5h", label: "Claude 5 Hour", amount: { usedFraction: 0.5 } },
    ], { credentialId: 12 }),
  ];

  const html = renderStrip(reports);
  const rows = drawnRows(html);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Claude 5 Hour");
  assert.doesNotMatch(html, /Show \d+ more/);
});

test("인증이 만료된 계정은 숨기지 않고 사유와 재로그인을 보이며, 막대를 그리지 않는다", () => {
  const reports = [
    anthropicAccount("expired@example.test", [], {
      credentialId: 9,
      accountKey: "acct-expired",
      disabled: true,
      authError: { code: "oauth_refresh_expired", message: "Sign-in expired. Sign in again.", reloginRequired: true },
    }),
    anthropicAccount("live@example.test", [
      { id: "anthropic:7d", label: "Claude 7 Day", amount: { usedFraction: 0.3 } },
    ], { credentialId: 11, accountKey: "acct-live" }),
  ];
  const aliases = accountIdentities(reports).map((identity) => identity.alias);
  const targets = [];

  const html = renderStrip(reports, (target) => targets.push(target));
  const groups = drawnGroups(html);

  // 쓸 수 있는 계정이 먼저, 만료된 계정은 뒤지만 같은 접힌 화면 안에 남는다. 얼굴은 정렬 전 목록 그대로다.
  assert.deepEqual(groups.map((group) => group.account), [aliases[1], aliases[0]]);
  const expired = groups[1].html;
  assert.match(expired, /navigator-usage-reason">Sign-in expired\. Sign in again\.</);
  assert.match(expired, new RegExp(`class="navigator-usage-relogin" aria-label="Sign in again as ${aliases[0].replace(/[()]/g, "\\$&")}"`));
  assert.doesNotMatch(expired, /navigator-usage-track/);
  assert.deepEqual(drawnStates(html), ["sign-in expired"]);
  // 접힌 요약에도 오류 계정 수가 남는다.
  assert.match(html, /navigator-usage-alert">Account issues: 1</);
});

test("재로그인으로 풀리지 않는 오류에는 재로그인 버튼을 두지 않는다", () => {
  const html = renderStrip([
    anthropicAccount("broken@example.test", [], {
      credentialId: 9,
      accountKey: "acct-broken",
      authError: { code: "usage_unavailable", message: "Usage could not be read.", reloginRequired: false },
    }),
  ]);

  assert.match(html, /navigator-usage-reason">Usage could not be read\.</);
  assert.deepEqual(drawnStates(html), ["unavailable"]);
  assert.doesNotMatch(html, /navigator-usage-relogin/);
});

test("저장된 순서는 처음 보는 계정을 뒤에 붙이고, 잠시 빠진 계정의 자리를 지킨다", () => {
  const accounts = ["a:2", "a:3", "a:new"].map((orderKey) => ({ orderKey }));
  // a:1 은 지금 보고서에 없다.
  const saved = ["a:3", "a:1", "a:2"];

  assert.deepEqual(orderStripAccounts(accounts, saved).map((account) => account.orderKey), ["a:3", "a:2", "a:new"]);
  // 화면에서 a:new 를 맨 위로 올렸다. a:1 은 두 번째 칸에 그대로 남는다.
  assert.deepEqual(mergeStripOrder(saved, ["a:new", "a:3", "a:2"]), ["a:new", "a:1", "a:3", "a:2"]);
});

test("재로그인 뒤 대상 계정이 사라진 것은 복구가 아니다", () => {
  const target = { provider: "anthropic", accountKey: "acct-expired" };
  const expired = { provider: "anthropic", accountKey: "acct-expired", disabled: true,
    authError: { code: "x", message: "m", reloginRequired: true } };
  const other = { provider: "anthropic", accountKey: "acct-other" };

  assert.equal(reloginOutcome([other], target), "unknown");
  // 다른 계정으로 로그인해 새 계정만 늘고 대상은 여전히 깨져 있다.
  assert.equal(reloginOutcome([expired, other], target), "still-failing");
  assert.equal(reloginOutcome([expired, { provider: "anthropic", accountKey: "acct-expired" }], target), "recovered");
  assert.equal(reloginOutcome([{ provider: "anthropic" }], { provider: "anthropic" }), "unknown");
});

test("늦게 끝난 이전 대상의 확인은 지금 연 다른 대상에 결과를 찍지 않는다", async () => {
  const statuses = [];
  const check = createReloginCheck((status) => statuses.push(status));
  let finishA;
  const refreshA = () => new Promise((resolve) => { finishA = resolve; });
  const a = { provider: "anthropic", accountKey: "acct-a" };
  const b = { provider: "anthropic", accountKey: "acct-b" };

  check.reset();
  check.check(refreshA, a);
  // A 확인이 끝나기 전에 대화상자를 닫고 B를 연다.
  check.reset();
  check.reset();
  finishA({ status: "fresh", data: { reports: [{ provider: "anthropic", accountKey: "acct-a" }] }, error: null });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(statuses, [null, "checking", null, null]);

  // B 자신의 확인은 그대로 반영된다.
  check.check(async () => ({ status: "fresh", data: { reports: [{ provider: "anthropic", accountKey: "acct-b" }] }, error: null }), b);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(statuses.slice(-2), ["checking", "recovered"]);
});
