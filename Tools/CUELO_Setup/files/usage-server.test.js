'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const { createControlFacade, matchCredential, startServer, usageEntry, MANUAL_UNTIL_MS, shapeStats, modelCatalog } = require('./usage-server');

function fixture(provider = 'openai-codex') {
    const entries = [1, 2].map(id => ({
        id, provider,
        credential: { type: 'oauth', email: 'same@example.test', accountId: `workspace-${id}`,
            access: 'ACCESS_SECRET', refresh: 'REFRESH_SECRET', key: 'KEY_SECRET' },
    }));
    const now = Date.now();
    let blocks = [
        { credentialId: 1, providerKey: `${provider}:oauth`, blockScope: 'chat', blockedUntilMs: now + 60_000 },
        { credentialId: 1, providerKey: `${provider}:oauth`, blockScope: '', blockedUntilMs: now + 120_000 },
    ];
    let statuses = entries.map(entry => ({ provider, credentialId: entry.id, availableCount: 1,
        credits: [{ id: `credit-${entry.id}`, expiresAt: '2099-01-01T00:00:00Z', status: 'available' }] }));
    const calls = [];
    const queries = [];
    const storage = {
        reload: async () => {},
        credentials: { snapshot: () => ({ credentials: entries }) },
        blocks: {
            list: ids => blocks.filter(block => ids.includes(block.credentialId)),
            upsert: block => {
                const existing = blocks.find(value => value.credentialId === block.credentialId
                    && value.providerKey === block.providerKey && value.blockScope === block.blockScope);
                if (existing) existing.blockedUntilMs = Math.max(existing.blockedUntilMs, block.blockedUntilMs);
                else blocks.push({ ...block });
            },
            delete: (id, key, scope) => {
                blocks = blocks.filter(block => block.credentialId !== id || block.providerKey !== key || block.blockScope !== scope);
            },
        },
        usage: { providerFor: value => value === provider ? {} : undefined },
        resets: {
            list: async options => { queries.push(options.provider); return statuses; },
            redeem: async options => {
                calls.push(options);
                return { code: 'reset' };
            },
        },
    };
    const controls = createControlFacade(() => ({ storage }), () => {});
    return { controls, storage, calls, queries, entries, setStatuses: value => { statuses = value; } };
}

function report(id = 1, provider = 'openai-codex') {
    return { provider, fetchedAt: Date.now(),
        metadata: { email: 'same@example.test', accountId: `workspace-${id}` }, limits: [] };
}

test('identity join rejects ambiguous emails and conflicting single candidates', () => {
    const accounts = [1, 2].map(id => ({ provider: 'openai-codex', credentialId: id,
        email: 'same@example.test', accountId: `workspace-${id}`, projectId: 'project' }));
    assert.equal(matchCredential({ provider: 'openai-codex', metadata: { email: 'same@example.test' } }, accounts), null);
    assert.equal(matchCredential(report(2), [accounts[0]]), null);
    assert.equal(matchCredential({ ...report(), metadata: { ...report().metadata, projectId: 'other' } }, accounts), null);
    assert.equal(matchCredential({ provider: 'openai-codex' }, [accounts[0]]), null);
    assert.equal(matchCredential(report(2), accounts)?.credentialId, 2);
});

test('Anthropic reset redeems only the server-selected credit with an anthropic target', async () => {
    const { controls, calls, setStatuses } = fixture('anthropic');
    setStatuses([1, 2].map(id => ({ provider: 'anthropic', credentialId: id, availableCount: 1, nextCreditId: `credit-${id}`,
        credits: [{ id: `credit-${id}`, expiresAt: '2099-01-01T00:00:00Z', status: 'available', remainingCount: 1 }] })));
    await assert.rejects(controls.redeem(1, { confirm: true, creditId: 'credit-2' }), { code: 'credit_unavailable' });
    assert.equal((await controls.redeem(1, { confirm: true, creditId: 'credit-1' })).code, 'reset');
    assert.deepEqual(calls.map(call => call.target), [{ provider: 'anthropic', credentialId: 1, creditId: 'credit-1' }]);
});

test('a rate-limited reset lookup keeps the last successful status instead of unavailable', async () => {
    const { controls, setStatuses } = fixture('anthropic');
    const ok = [1, 2].map(id => ({ provider: 'anthropic', credentialId: id, availableCount: 1, nextCreditId: `credit-${id}`,
        credits: [{ id: `credit-${id}`, expiresAt: '2099-01-01T00:00:00Z', status: 'available', remainingCount: 1 }] }));
    setStatuses(ok);
    assert.equal((await controls.enrich({ reports: [report(1, 'anthropic')] })).reports[0].savedReset.state, 'available');
    setStatuses(ok.map(status => ({ ...status, availableCount: 0, credits: [], error: 'Failed to load saved resets' })));
    controls.invalidate();
    assert.equal((await controls.enrich({ reports: [report(1, 'anthropic')] })).reports[0].savedReset.state, 'available');
});
test('unmatched quota and local credential rows expose distinct non-joining roles', async () => {
    const { controls } = fixture('opencode-go');
    const result = await controls.enrich({
        reports: [{ provider: 'opencode-go', fetchedAt: Date.now(), metadata: { planType: 'OpenCode Go' }, limits: [] }],
    });
    assert.deepEqual(result.reports.map(value => ({
        accountRole: value.accountRole,
        credentialId: value.credentialId,
    })), [
        { accountRole: 'usage-only', credentialId: undefined },
        { accountRole: 'control-only', credentialId: 1 },
        { accountRole: 'control-only', credentialId: 2 },
    ]);
});

test('credential-attributed quota joins an OAuth row without stored email and never binds a sibling', async () => {
    const { controls, entries } = fixture('devin');
    for (const entry of entries) {
        delete entry.credential.email;
        delete entry.credential.accountId;
    }
    const quota = { provider: 'devin', fetchedAt: Date.now(),
        metadata: { localCredentialId: 2, email: 'second@example.test', accountId: 'second-account' },
        limits: [{ id: 'devin:quota:daily', scope: { provider: 'devin' }, amount: { usedFraction: 0.2 } }] };
    const result = await controls.enrich({ reports: [quota] });
    assert.equal(result.reports[0].credentialId, 2);
    assert.equal(result.reports[0].accountRole, undefined);
    assert.equal(result.reports[0].limits[0].amount.usedFraction, 0.2);
    assert.deepEqual(result.reports.slice(1).map(row => [row.credentialId, row.accountRole]), [[1, 'control-only']]);
    const accounts = [{ provider: 'devin', credentialId: 2, email: 'different@example.test' }];
    assert.equal(matchCredential(quota, accounts), null);
    assert.equal(matchCredential({ ...quota, provider: 'other' }, accounts), null);
    assert.equal(matchCredential({ ...quota, metadata: { localCredentialId: 99 } }, accounts), null);
});


test('OFF then ON preserves default and scoped quota blocks across a sidecar restart', async () => {
    const { controls, storage } = fixture();
    storage.blocks.upsert({ credentialId: 2, providerKey: 'openai-codex:oauth', blockScope: '', blockedUntilMs: MANUAL_UNTIL_MS });
    const normalized = () => storage.blocks.list([1, 2])
        .map(block => ({ ...block }))
        .sort((left, right) => left.credentialId - right.credentialId || left.blockScope.localeCompare(right.blockScope));
    const original = normalized();
    const expectedAutoUntil = Math.max(...original.filter(block => block.credentialId === 1)
        .map(block => block.blockedUntilMs));
    await controls.setDisabled(1, true);
    await controls.setDisabled(1, true);
    assert.equal((await controls.enrich({ reports: [report()] })).reports[0].disabled, true);
    const restarted = createControlFacade(() => ({ storage }), () => {});
    await restarted.setDisabled(1, false);
    await restarted.setDisabled(1, false);
    assert.deepEqual(normalized(), original);
    const readback = (await restarted.enrich({ reports: [report()] })).reports[0];
    assert.equal(readback.disabled, false);
    assert.equal(readback.autoBlockedUntilMs, expectedAutoUntil);
});

test('expired usage is served at once inside the stale window while one refresh runs; older or invalidated waits', async () => {
    const now = 1_000_000_000;
    const fresh = { at: now, body: 'next' };
    const calls = [];
    const refresh = () => { calls.push(1); return Promise.resolve(fresh); };
    const recent = { at: now - 30_000, body: 'recent' };
    assert.equal(await usageEntry(recent, refresh, now), recent);
    assert.equal(calls.length, 0);
    const expired = { at: now - 5 * 60_000, body: 'expired' };
    assert.equal(await usageEntry(expired, refresh, now), expired);
    assert.equal(calls.length, 1);
    assert.equal(await usageEntry({ at: now - 11 * 60_000, body: 'old' }, refresh, now), fresh);
    assert.equal(await usageEntry({ at: 0, body: 'invalidated' }, refresh, now), fresh);
    assert.equal(await usageEntry(null, refresh, now), fresh);
    assert.equal(calls.length, 4);
    // 뒤에서 도는 갱신의 실패는 직전 스냅샷 응답을 깨지 않는다.
    assert.equal(await usageEntry(expired, () => Promise.reject(new Error('offline')), now), expired);
});

test('quota and reset failures retain account rows without leaking raw credentials or errors', async t => {
    const { controls, setStatuses } = fixture();
    setStatuses([{ credentialId: 1, availableCount: 0, credits: [], error: 'REFRESH_SECRET' }]);
    const raw = report();
    raw.raw = { token: 'RAW_SECRET' };
    raw.metadata.accessToken = 'METADATA_SECRET';
    const server = startServer(0, controls, async () => ({ reports: [raw], credential: 'TOP_SECRET' }));
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/usage`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.reports.map(value => value.credentialId), [1, 2]);
    assert.equal(result.reports[0].savedReset.state, 'unavailable');
    assert.equal(result.reports[0].savedReset.availableCount, null);
    assert.deepEqual(result.reports[1].limits, []);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('an auth-failed account keeps its seat as a re-login row; the other account keeps its seat and manual OFF', async () => {
    const { controls, storage, entries } = fixture('anthropic');
    // 자격 1(자리 0)이 refresh 만료로 비활성화됐다. core의 활성 snapshot에는 자격 2만 남는다.
    entries.splice(0, 1);
    storage.credentials.oauthSeatIds = provider => (provider === 'anthropic' ? [1, 2] : []);
    storage.credentials.listDisabled = async () => [
        { id: 1, provider: 'anthropic', type: 'oauth', email: 'same@example.test', accountId: 'workspace-1',
            cause: 'oauth refresh failed: Error: 400 {"error":"invalid_grant","error_description":"Refresh token expired REFRESH_SECRET"}' },
        // 교체·로그아웃 tombstone은 자리가 없어 화면에 나오지 않는다.
        { id: 7, provider: 'anthropic', type: 'oauth', accountId: 'replaced', cause: 'replaced by newer credential' },
    ];
    storage.blocks.upsert({ credentialId: 2, providerKey: 'anthropic:oauth', blockScope: '', blockedUntilMs: MANUAL_UNTIL_MS });
    const result = await controls.enrich({ reports: [report(2, 'anthropic')] });
    const rows = result.reports.map(row => pick(row));
    assert.deepEqual(rows, [
        { credentialId: 2, accountRole: undefined, oauthPosition: 1, disabled: true, authError: undefined, accountKey: 'anthropic:2' },
        { credentialId: 1, accountRole: 'auth-error', oauthPosition: 0, disabled: undefined, accountKey: 'anthropic:1',
            authError: { code: 'refresh_expired', message: '로그인이 만료되었습니다. 다시 로그인하세요.', reloginRequired: true } },
    ]);
    assert.deepEqual(result.reports[1].limits, []);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.equal(JSON.stringify(result).includes('invalid_grant'), false);
    function pick(row) {
        return { credentialId: row.credentialId, accountRole: row.accountRole, oauthPosition: row.oauthPosition,
            disabled: row.disabled, authError: row.authError, accountKey: row.accountKey };
    }
});

test('foreign and missing Origin are rejected before any credential operation', async t => {
    const { controls, calls } = fixture();
    const server = startServer(0, controls);
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/credential/1/reset`;
    for (const origin of [undefined, 'https://attacker.test']) {
        const response = await fetch(url, { method: 'POST', headers: {
            'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}),
        }, body: JSON.stringify({ confirm: true, creditId: 'credit-1' }) });
        assert.equal(response.status, 403);
        assert.equal((await response.json()).code, 'untrusted_origin');
    }
    assert.equal(calls.length, 0);
});

test('reset requires explicit confirmation, an exact live credit, and an ON account', async () => {
    const { controls, calls } = fixture();
    await assert.rejects(controls.redeem(1, { creditId: 'credit-1' }), { code: 'confirmation_required' });
    await assert.rejects(controls.redeem(1, { confirm: true, creditId: 'credit-2' }), { code: 'credit_unavailable' });
    await controls.setDisabled(1, true);
    await assert.rejects(controls.redeem(1, { confirm: true, creditId: 'credit-1' }), { code: 'account_disabled' });
    assert.equal(calls.length, 0);
});

test('concurrent confirmed reset invokes core once and serializes the subsequent OFF', async () => {
    const { controls, storage } = fixture();
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const calls = [];
    storage.resets.redeem = async options => { calls.push(options); entered(); await wait; return { code: 'reset' }; };
    const first = controls.redeem(1, { confirm: true, creditId: 'credit-1' });
    const second = controls.redeem(1, { confirm: true, creditId: 'credit-1' });
    await started;
    const off = controls.setDisabled(1, true);
    assert.equal(storage.blocks.list([1]).some(block => block.blockedUntilMs === MANUAL_UNTIL_MS), false);
    release();
    assert.deepEqual(await first, { ok: true, credentialId: 1, creditId: 'credit-1', code: 'reset' });
    assert.deepEqual(await second, await first);
    await off;
    assert.equal(calls.length, 1);
    // 18.3.0 resets.redeem은 provider·creditId를 target에서만 읽는다(pi-ai auth/resets.ts:86-87).
    assert.deepEqual(calls[0].target, { provider: 'openai-codex', credentialId: 1, creditId: 'credit-1' });
    assert.equal(storage.blocks.list([1]).some(block => block.blockedUntilMs === MANUAL_UNTIL_MS), true);
});

test('uncertain consume outcome is retained without retry or secret exposure', async () => {
    const { controls, storage } = fixture();
    let calls = 0;
    storage.resets.redeem = async () => { calls += 1; throw new Error('ACCESS_SECRET'); };
    const confirmed = { confirm: true, creditId: 'credit-1' };
    await assert.rejects(controls.redeem(1, confirmed), { code: 'reset_outcome_unknown', outcomeUnknown: true });
    await assert.rejects(controls.redeem(1, confirmed), { message: 'reset_outcome_unknown', outcomeUnknown: true });
    assert.equal(calls, 1);
});

test('business non-success remains a typed result and refresh observes post-mutation credit state', async () => {
    const { controls, storage, setStatuses } = fixture();
    const before = await controls.enrich({ reports: [report()] });
    assert.equal(before.reports[0].savedReset.availableCount, 1);
    storage.resets.redeem = async () => {
        setStatuses([{ credentialId: 1, availableCount: 0, credits: [] }]);
        return { code: 'already_redeemed', raw: 'SECRET' };
    };
    assert.deepEqual(await controls.redeem(1, { confirm: true, creditId: 'credit-1' }), {
        ok: false, credentialId: 1, creditId: 'credit-1', code: 'already_redeemed',
    });
    assert.equal((await controls.enrich({ reports: [report()] })).reports[0].savedReset.state, 'empty');
});

test('expired or unavailable credit entries do not inflate the actionable saved reset count', async () => {
    const { controls, setStatuses } = fixture();
    setStatuses([{ credentialId: 1, availableCount: 2, credits: [
        { id: 'expired', expiresAt: '2000-01-01T00:00:00Z', status: 'available' },
        { id: 'used', expiresAt: '2099-01-01T00:00:00Z', status: 'used' },
    ] }]);
    const reset = (await controls.enrich({ reports: [report()] })).reports[0].savedReset;
    assert.equal(reset.state, 'empty');
    assert.equal(reset.availableCount, 0);
    assert.deepEqual(reset.credits, []);
});

test('a pre-toggle credit snapshot cannot restore an old ON response', async () => {
    const { controls, storage } = fixture();
    const list = storage.resets.list;
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    let first = true;
    storage.resets.list = async () => {
        if (first) {
            first = false;
            entered();
            await wait;
        }
        return list();
    };
    const pending = controls.enrich({ reports: [report()] });
    await started;
    await controls.setDisabled(1, true);
    release();
    assert.equal((await pending).reports[0].disabled, true);
});

test('Anthropic reset lookup is provider-specific and retains only reset-scope fields', async () => {
    const { controls, queries, setStatuses } = fixture('anthropic');
    setStatuses([1, 2].map(id => ({
        provider: 'anthropic', credentialId: id, availableCount: 2, redeemableCount: 1,
        nextCreditId: 'cedar-1', eligible: true, reason: 'cooldown', cooldownUntil: '2099-01-01T01:00:00Z',
        credits: [{ id: 'cedar-1', status: 'available', program: 'cedar_ember', remainingCount: 1,
            usable: true, requiresLimit: true, clears: ['anthropic:5h'], blocking: ['anthropic:5h'],
            usedFractions: { 'anthropic:5h': 1 }, title: 'private-unneeded', mystery: 'SECRET' }],
    })));
    const result = await controls.enrich({ reports: [report(1, 'anthropic')] });
    assert.deepEqual(queries.sort(), ['anthropic', 'openai-codex']);
    assert.equal(result.reports[0].savedReset.availableCount, 2);
    assert.equal(result.reports[0].savedReset.credits[0].program, 'cedar_ember');
    assert.deepEqual(result.reports[0].savedReset.credits[0].clears, ['anthropic:5h']);
    assert.equal(result.reports[0].savedReset.nextCreditId, 'cedar-1');
    assert.equal(result.reports[0].savedReset.credits[0].mystery, undefined);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('missing Anthropic reset API keeps account rows and reports only that reset status unavailable', async () => {
    const { controls, storage } = fixture('anthropic');
    storage.resets.list = async options => {
        if (options.provider === 'anthropic') throw new Error('reset API unavailable');
        return [];
    };
    const result = await controls.enrich({ reports: [report(1, 'anthropic')] });
    assert.equal(result.brokerOk, true);
    assert.equal(result.reports[0].credentialId, 1);
    assert.equal(result.reports[0].savedReset.state, 'unavailable');
    assert.equal(result.reports[0].savedReset.availableCount, null);
});

// `omp stats --json` 원본 한 줄. core 의 cacheRate 는 cacheWrite 를 분모에서 뺀 값이라 일부러 그 값을 싣는다.
function statRow(provider, model, { input = 0, output = 0, read = 0, write = 0, cost = 0, requests = 10, unpriced = 0 } = {}) {
    return {
        provider, model, totalRequests: requests, totalInputTokens: input, totalOutputTokens: output,
        totalCacheReadTokens: read, totalCacheWriteTokens: write, totalCost: cost, unpricedRequests: unpriced,
        cacheRate: input + read > 0 ? read / (input + read) : 0,
    };
}

function statsFixture(rows, costSeries = []) {
    const sum = key => rows.reduce((total, row) => total + row[key], 0);
    const overall = {
        totalRequests: sum('totalRequests'), totalInputTokens: sum('totalInputTokens'),
        totalOutputTokens: sum('totalOutputTokens'), totalCacheReadTokens: sum('totalCacheReadTokens'),
        totalCacheWriteTokens: sum('totalCacheWriteTokens'), totalCost: sum('totalCost'),
        unpricedRequests: sum('unpricedRequests'), cacheRate: 0.999, cacheSavings: 0.9,
    };
    return { overall, byModel: rows, byAgentType: [{ agentType: 'main', totalRequests: 1, totalCost: overall.totalCost }], costSeries };
}

// `omp models --json --kind all` 의 실제 모양. pricingStatus 는 core getModelPricingStatus 가 낸다.
const catalog = modelCatalog(JSON.stringify({ models: [
    { provider: 'anthropic', id: 'claude-opus-5-5', kind: 'chat', pricingStatus: 'fixed' },
    { provider: 'openai-codex', id: 'gpt-6-astra', kind: 'chat', pricingStatus: 'fixed' },
    { provider: 'b-ai', id: 'deepseek-v4.1-flash', kind: 'chat', pricingStatus: 'unknown' },
    { provider: 'openrouter', id: 'typesafe/jev-1.14', kind: 'judge', pricingStatus: 'fixed' },
    { provider: 'local', id: 'free-model', kind: 'chat', pricingStatus: 'free' },
] }));

test('cache rate counts cache writes as prompt input for every model and the overall row', () => {
    const stats = shapeStats(statsFixture([
        statRow('anthropic', 'claude-opus-5-5', { input: 600, read: 85_000, write: 14_400, cost: 30 }),
        statRow('openai-codex', 'gpt-6-astra', { input: 2_800, read: 97_200, cost: 20 }),
    ]), catalog);
    const opus = stats.models.find(model => model.model === 'claude-opus-5-5');
    const astra = stats.models.find(model => model.model === 'gpt-6-astra');
    assert.equal(opus.cacheRate, 0.85);
    assert.equal(opus.cacheStatus, 'reported');
    assert.equal(astra.cacheRate, 0.972);
    assert.equal(stats.overall.cacheRate, (85_000 + 97_200) / 200_000);
    assert.equal(stats.overall.cacheExcludedModels, 0);
});

test('a judge model whose wire cannot report cache shows no cache rate and leaves the overall rate', () => {
    const stats = shapeStats(statsFixture([
        statRow('openai-codex', 'gpt-6-astra', { input: 10, read: 90, cost: 1 }),
        statRow('openrouter', 'typesafe/jev-1.14', { input: 900, cost: 0.01 }),
    ]), catalog);
    const jev = stats.models.find(model => model.model === 'typesafe/jev-1.14');
    assert.equal(jev.cacheStatus, 'not-reported');
    assert.equal(jev.cacheRate, undefined);
    assert.equal(stats.overall.cacheRate, 0.9);
    assert.equal(stats.overall.cacheExcludedModels, 1);
});

test('a model without a rate card is unpriced, not free, and the totals say they are incomplete', () => {
    const stats = shapeStats(statsFixture([
        statRow('anthropic', 'claude-opus-5-5', { input: 10, read: 90, cost: 3 }),
        statRow('b-ai', 'deepseek-v4.1-flash', { input: 100, read: 900 }),
        statRow('local', 'free-model', { input: 50 }),
    ], [
        { timestamp: 2, provider: 'b-ai', model: 'deepseek-v4.1-flash', cost: 0, requests: 4, unpricedRequests: 0 },
        { timestamp: 2, provider: 'anthropic', model: 'claude-opus-5-5', cost: 3, requests: 1, unpricedRequests: 0 },
        { timestamp: 1, provider: 'local', model: 'free-model', cost: 0, requests: 2, unpricedRequests: 0 },
    ]), catalog);
    const bai = stats.models.find(model => model.provider === 'b-ai');
    const free = stats.models.find(model => model.provider === 'local');
    assert.equal(bai.pricing, 'unpriced');
    assert.equal(bai.costPerRequest, null);
    assert.equal(bai.cacheRate, 0.9, 'an unpriced model still reports its real cache hits');
    assert.equal(free.pricing, 'free');
    assert.equal(free.cost, 0);
    assert.equal(free.costPerRequest, 0);
    assert.equal(stats.overall.costComplete, false);
    assert.equal(stats.overall.unpricedModels, 1);
    assert.equal(stats.agents[0].costComplete, false);
    const [recent, older] = stats.daily;
    assert.equal(recent.costComplete, false);
    assert.equal(recent.models.find(model => model.provider === 'b-ai').pricing, 'unpriced');
    assert.equal(older.costComplete, true);
});

test('core-marked unpriced requests make a priced model a lower bound', () => {
    const stats = shapeStats(statsFixture([
        statRow('anthropic', 'claude-opus-5-5', { input: 10, read: 90, cost: 3, unpriced: 2 }),
    ]), catalog);
    assert.equal(stats.models[0].pricing, 'partial');
    assert.equal(stats.overall.costComplete, false);
    assert.equal(stats.overall.unpricedModels, 1);
});

test('rows the catalog does not know never turn into a measured zero', () => {
    const stats = shapeStats(statsFixture([
        statRow('a6api', 'kimi-k3', { input: 100 }),
        statRow('devin', 'swe-2', { input: 100, read: 900, cost: 4 }),
    ]), catalog);
    const kimi = stats.models.find(model => model.model === 'kimi-k3');
    const swe = stats.models.find(model => model.model === 'swe-2');
    assert.equal(kimi.pricing, 'unpriced');
    assert.equal(kimi.cacheStatus, 'unknown');
    assert.equal(kimi.cacheRate, undefined);
    assert.equal(swe.pricing, 'partial', 'a recorded cost without a current card is only a lower bound');
    assert.equal(stats.overall.costComplete, false);
    assert.equal(swe.cacheRate, 0.9);

    const blind = shapeStats(statsFixture([statRow('local', 'free-model', { input: 50 })]), null);
    assert.equal(blind.models[0].pricing, 'unpriced', 'without metadata a zero cost cannot be called free');
    assert.equal(blind.models[0].cacheStatus, 'unknown');
    assert.equal(blind.overall.costComplete, false);
});
