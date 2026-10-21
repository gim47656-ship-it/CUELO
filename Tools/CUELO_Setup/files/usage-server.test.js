'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createControlFacade, matchCredential, startServer, startExpirySweep, claimResetAttempt, usageEntry, MANUAL_UNTIL_MS, shapeStats, modelCatalog } = require('./usage-server');

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

const HOUR = 3_600_000;
const T0 = Date.parse('2099-01-01T00:00:00Z');
const iso = ms => new Date(ms).toISOString();
// bun에서는 실제 SDK 프로세스 간 잠금을 쓴다. node는 SDK .ts를 읽지 못하므로 같은 프로세스 안의 직렬 실행만 쓴다.
const SDK_UTILS = path.join(__dirname, '../../../node_modules/@oh-my-pi/pi-utils/src/index.ts');
const sdkLock = async () => (process.versions.bun ? (await import(SDK_UTILS)).withFileLock : (file, fn) => fn());
const ledgerFile = dir => path.join(dir, 'cuelo-reset-expiry-attempts.json');
const ledgerOf = dir => JSON.parse(fs.readFileSync(ledgerFile(dir), 'utf8')).attempts;

function tempProfile(t, policy) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-expiry-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    if (policy != null) fs.writeFileSync(path.join(dir, 'cuelo-reset-expiry.json'), policy);
    return dir;
}

// 계정 하나에 권리 하나. accounts[i]가 credential id i+1이다. 실제 provider·SDK·자격 증명은 쓰지 않는다.
async function expiryFixture(t, accounts, policy = '{"enabled":true}') {
    const agentDir = tempProfile(t, policy);
    const entries = accounts.map((account, index) => ({ id: index + 1, provider: account.provider ?? 'openai-codex',
        credential: { type: 'oauth', accountId: `acct-${index + 1}` } }));
    const statusOf = (entry, { expiresAt, creditId = `credit-${entry.id}`, credit, status }) => (entry.provider === 'anthropic'
        ? { provider: 'anthropic', credentialId: entry.id, availableCount: 1, redeemableCount: 1, eligible: true, nextCreditId: creditId,
            credits: [{ id: creditId, expiresAt, status: 'available', remainingCount: 1, usable: true, ...credit }], ...status }
        : { provider: entry.provider, credentialId: entry.id, availableCount: 1,
            credits: [{ id: creditId, expiresAt, status: 'available', ...credit }], ...status });
    const fx = { agentDir, calls: [], lists: [], blocks: [], clock: { now: T0 } };
    fx.setAccounts = next => { fx.statuses = next.map((account, index) => statusOf(entries[index], account)); };
    fx.setAccounts(accounts);
    fx.storage = {
        reload: async () => {},
        credentials: { snapshot: () => ({ credentials: entries }) },
        blocks: { list: ids => fx.blocks.filter(block => ids.includes(block.credentialId)), upsert() {}, delete() {} },
        usage: { providerFor: () => ({}) },
        resets: {
            list: async options => { fx.lists.push(options.provider); return fx.statuses.filter(value => value.provider === options.provider); },
            redeem: async options => { fx.calls.push(options.target); return { code: 'reset' }; },
        },
    };
    fx.control = { storage: fx.storage, agentDir, withFileLock: await sdkLock() };
    fx.make = () => createControlFacade(() => fx.control, () => {}, { now: () => fx.clock.now });
    fx.controls = fx.make();
    return fx;
}

test('expiry sweep without an explicit enabled policy reads nothing and redeems nothing; default-off manual reset writes no record', async t => {
    for (const policy of [null, '', 'not json', 'null', '[true]', '{"enabled":false}', '{"enabled":"true"}']) {
        const fx = await expiryFixture(t, [{ expiresAt: iso(T0 + 30 * 60_000) }], policy);
        assert.deepEqual(await fx.controls.sweepExpiring(), { enabled: false, outcomes: [] });
        assert.deepEqual([fx.lists, fx.calls], [[], []]);
        assert.equal(fs.existsSync(ledgerFile(fx.agentDir)), false);
    }
    const fx = await expiryFixture(t, [{ expiresAt: iso(T0 + 30 * 60_000) }], null);
    assert.equal((await fx.controls.redeem(1, { confirm: true, creditId: 'credit-1' })).code, 'reset');
    assert.equal(fs.existsSync(ledgerFile(fx.agentDir)), false);
});

test('enabled sweep redeems every due credit by exact target and skips outside, expired, unknown, unusable and OFF accounts', async t => {
    const fx = await expiryFixture(t, [
        { expiresAt: iso(T0 + 30 * 60_000) },
        { expiresAt: iso(T0 + HOUR) },
        { expiresAt: iso(T0 + HOUR + 1) },
        { expiresAt: iso(T0 - 1) },
        { expiresAt: undefined },
        { expiresAt: 'not-a-date' },
        { provider: 'anthropic', expiresAt: iso(T0 + 10 * 60_000) },
        { provider: 'anthropic', expiresAt: iso(T0 + 10 * 60_000), credit: { usable: false } },
        { expiresAt: iso(T0 + 5 * 60_000) },
    ]);
    // 9번은 수동 OFF, 1번은 한도 소진 쿨다운 중이다. 쿨다운은 대상에서 빼지 않는다.
    fx.blocks.push({ credentialId: 9, providerKey: 'openai-codex:oauth', blockScope: '', blockedUntilMs: MANUAL_UNTIL_MS },
        { credentialId: 1, providerKey: 'openai-codex:oauth', blockScope: 'chat', blockedUntilMs: Date.now() + HOUR });
    const summary = await fx.controls.sweepExpiring();
    assert.deepEqual(fx.calls, [
        { provider: 'openai-codex', credentialId: 1, creditId: 'credit-1' },
        { provider: 'openai-codex', credentialId: 2, creditId: 'credit-2' },
        { provider: 'anthropic', credentialId: 7, creditId: 'credit-7' },
    ]);
    assert.deepEqual(summary.outcomes.map(outcome => [outcome.credentialId, outcome.code]), [[1, 'reset'], [2, 'reset'], [7, 'reset']]);
    assert.deepEqual(ledgerOf(fx.agentDir).map(entry => [entry.credentialId, entry.origin, entry.state, entry.code]),
        [[1, 'auto', 'reset', 'reset'], [2, 'auto', 'reset', 'reset'], [7, 'auto', 'reset', 'reset']]);
    await fx.controls.sweepExpiring();
    assert.equal(fx.calls.length, 3);
    // 재시작해 보관 결과가 없고 목록이 아직 같은 권리를 보여도 자동으로 다시 보내지 않는다.
    await fx.make().sweepExpiring();
    assert.equal(fx.calls.length, 3);
});

test('point-of-send recheck refuses when the fresh expiry moved, the policy went off, or the sweep stopped', async t => {
    const due = [{ expiresAt: iso(T0 + 30 * 60_000) }];
    const cases = {
        moved: fx => fx.setAccounts([{ expiresAt: iso(T0 + 2 * HOUR) }]),
        policyOff: fx => fs.rmSync(path.join(fx.agentDir, 'cuelo-reset-expiry.json')),
        stopped: fx => { fx.stop = true; },
    };
    for (const [name, change] of Object.entries(cases)) {
        const fx = await expiryFixture(t, due);
        const list = fx.storage.resets.list;
        fx.storage.resets.list = async options => { if (fx.lists.length === 1) change(fx); return list(options); };
        const summary = await fx.controls.sweepExpiring(() => fx.stop === true);
        assert.deepEqual([name, summary.outcomes.map(outcome => outcome.code), fx.calls], [name, ['expiry_not_due'], []]);
        assert.equal(fs.existsSync(ledgerFile(fx.agentDir)), false, name);
    }
    // 기록을 잡은 뒤 정책이 꺼지면 보내지 않고 그 기록을 미전송으로 닫는다.
    const fx = await expiryFixture(t, due);
    const lock = fx.control.withFileLock;
    fx.control.withFileLock = async (file, fn) => {
        const value = await lock(file, fn);
        fs.rmSync(path.join(fx.agentDir, 'cuelo-reset-expiry.json'), { force: true });
        return value;
    };
    assert.deepEqual((await fx.controls.sweepExpiring()).outcomes.map(outcome => outcome.code), ['expiry_not_due']);
    assert.deepEqual(fx.calls, []);
    assert.deepEqual(ledgerOf(fx.agentDir).map(entry => [entry.state, entry.code]), [['refused', 'not_sent']]);
});

test('an unknown outcome blocks manual and automatic sends after restart and policy OFF, but not a renewed grant', async t => {
    const fx = await expiryFixture(t, [{ expiresAt: iso(T0 + 30 * 60_000) }]);
    fx.storage.resets.redeem = async options => { fx.calls.push(options.target); throw new Error('ACCESS_SECRET'); };
    assert.deepEqual((await fx.controls.sweepExpiring()).outcomes, [
        { provider: 'openai-codex', credentialId: 1, code: 'reset_outcome_unknown', outcomeUnknown: true }]);
    assert.deepEqual(ledgerOf(fx.agentDir).map(entry => [entry.origin, entry.state]), [['auto', 'unknown']]);
    assert.equal(fs.readFileSync(ledgerFile(fx.agentDir), 'utf8').includes('SECRET'), false);
    const restarted = fx.make();
    assert.deepEqual((await restarted.sweepExpiring()).outcomes, []);
    await assert.rejects(restarted.redeem(1, { confirm: true, creditId: 'credit-1' }), { code: 'attempt_unresolved' });
    fs.rmSync(path.join(fx.agentDir, 'cuelo-reset-expiry.json'));
    await assert.rejects(fx.make().redeem(1, { confirm: true, creditId: 'credit-1' }), { code: 'attempt_unresolved' });
    assert.equal(fx.calls.length, 1);
    fx.storage.resets.redeem = async options => { fx.calls.push(options.target); return { code: 'reset' }; };
    fx.setAccounts([{ expiresAt: iso(T0 + 7 * 24 * HOUR) }]);
    assert.equal((await fx.make().redeem(1, { confirm: true, creditId: 'credit-1' })).code, 'reset');
    assert.deepEqual(ledgerOf(fx.agentDir).map(entry => [entry.origin, entry.state]), [['auto', 'unknown'], ['manual', 'reset']]);
    const renewed = { provider: 'openai-codex', credentialId: 1, creditId: 'credit-1', expiresAt: iso(T0 + 7 * 24 * HOUR), remainingCount: null };
    await assert.rejects(claimResetAttempt(ledgerFile(fx.agentDir), fx.control.withFileLock, renewed, 'auto', T0), { code: 'already_reset' });
});

test('a retained result answers only the same grant: a renewed juniper week and the next cedar unit are really sent', async t => {
    const fx = await expiryFixture(t, [{ provider: 'anthropic', creditId: 'juniper_tide', expiresAt: iso(T0 + 30 * 60_000) }]);
    const redeem = () => fx.controls.redeem(1, { confirm: true, creditId: fx.statuses[0].nextCreditId });
    assert.equal((await redeem()).code, 'reset');
    assert.equal((await redeem()).code, 'reset');
    assert.equal(fx.calls.length, 1);
    fx.setAccounts([{ provider: 'anthropic', creditId: 'juniper_tide', expiresAt: iso(T0 + 7 * 24 * HOUR) }]);
    assert.equal((await redeem()).code, 'reset');
    assert.equal(fx.calls.length, 2);
    fx.setAccounts([{ provider: 'anthropic', creditId: 'cedar-1', expiresAt: iso(T0 + 30 * 60_000), credit: { remainingCount: 2 } }]);
    await redeem();
    fx.setAccounts([{ provider: 'anthropic', creditId: 'cedar-1', expiresAt: iso(T0 + 30 * 60_000), credit: { remainingCount: 1 } }]);
    await redeem();
    assert.equal(fx.calls.length, 4);
});

test('concurrent manual and automatic requests share one send, and a second facade on the profile is refused', async t => {
    const fx = await expiryFixture(t, [{ expiresAt: iso(T0 + 30 * 60_000) }]);
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    fx.storage.resets.redeem = async options => { fx.calls.push(options.target); entered(); await hold; return { code: 'reset' }; };
    const sweeping = fx.controls.sweepExpiring();
    await started;
    const manual = fx.controls.redeem(1, { confirm: true, creditId: 'credit-1' });
    const other = fx.make();
    assert.deepEqual((await other.sweepExpiring()).outcomes, []);
    await assert.rejects(other.redeem(1, { confirm: true, creditId: 'credit-1' }), { code: 'attempt_unresolved' });
    release();
    assert.equal((await manual).code, 'reset');
    assert.deepEqual((await sweeping).outcomes.map(outcome => outcome.code), ['reset']);
    assert.equal(fx.calls.length, 1);
    assert.deepEqual(ledgerOf(fx.agentDir).map(entry => [entry.origin, entry.state]), [['auto', 'reset']]);
});

test('definite non-consumption, including rate limits, is re-evaluated on the next sweep; auth refusals never resend', async t => {
    const due = { expiresAt: iso(T0 + 30 * 60_000) };
    // 같은 프로세스 경로: 1 nothing_to_reset, 2 auth_error(Anthropic 401/403), 3 rate_limited(Anthropic 429), 4 http_429(본문 없는 Codex 429), 5 http_403(Codex).
    const fx = await expiryFixture(t, [due, due, due, due, due]);
    const first = { 1: 'nothing_to_reset', 2: 'auth_error', 3: 'rate_limited', 4: 'http_429', 5: 'http_403' };
    const refuseOnce = target => {
        fx.calls.push(target);
        return fx.calls.filter(call => call.credentialId === target.credentialId).length === 1 ? first[target.credentialId] : 'reset';
    };
    fx.storage.resets.redeem = async options => ({ code: refuseOnce(options.target) });
    await fx.controls.sweepExpiring();
    assert.deepEqual(fx.calls.map(call => call.credentialId), [1, 2, 3, 4, 5]);
    fx.clock.now += 60_000;
    assert.deepEqual((await fx.controls.sweepExpiring()).outcomes.map(outcome => [outcome.credentialId, outcome.code]),
        [[1, 'reset'], [3, 'reset'], [4, 'reset']]);
    await fx.make().sweepExpiring();
    assert.deepEqual(fx.calls.map(call => call.credentialId), [1, 2, 3, 4, 5, 1, 3, 4]);
    // 수동은 예전처럼 같은 권리의 보관 결과를 받는다.
    assert.equal((await fx.controls.redeem(2, { confirm: true, creditId: 'credit-2' })).code, 'auth_error');
    assert.equal(fx.calls.length, 8);
});

test('after restart a recorded rate-limit refusal is re-evaluated on the next sweep while an auth refusal stays blocked', async t => {
    const due = { expiresAt: iso(T0 + 30 * 60_000) };
    // 한도 거절 기록만 남은 profile을 새 프로세스가 다음 점검에서 다시 판단한다. 인증 거절 기록은 계속 막는다.
    const restart = await expiryFixture(t, [due, due, due]);
    const firstRestart = { 1: 'rate_limited', 2: 'http_429', 3: 'auth_error' };
    restart.storage.resets.redeem = async options => {
        restart.calls.push(options.target);
        const tries = restart.calls.filter(call => call.credentialId === options.target.credentialId).length;
        return { code: tries === 1 ? firstRestart[options.target.credentialId] : 'reset' };
    };
    await restart.controls.sweepExpiring();
    restart.clock.now += 60_000;
    assert.deepEqual((await restart.make().sweepExpiring()).outcomes.map(outcome => [outcome.credentialId, outcome.code]),
        [[1, 'reset'], [2, 'reset']]);
    assert.deepEqual(ledgerOf(restart.agentDir).map(entry => [entry.credentialId, entry.state, entry.code]), [
        [1, 'refused', 'rate_limited'], [2, 'refused', 'http_429'], [3, 'refused', 'auth_error'],
        [1, 'reset', 'reset'], [2, 'reset', 'reset'],
    ]);
});

test('a credit that becomes usable with under ten minutes left is sent on the next sweep', async t => {
    const expiresAt = iso(T0 + 8 * 60_000);
    const fx = await expiryFixture(t, [{ provider: 'anthropic', expiresAt, credit: { usable: false } }]);
    assert.deepEqual((await fx.controls.sweepExpiring()).outcomes, []);
    fx.setAccounts([{ provider: 'anthropic', expiresAt }]);
    fx.clock.now += 60_000;
    assert.deepEqual((await fx.controls.sweepExpiring()).outcomes.map(outcome => outcome.code), ['reset']);
});

test('a ledger row with a malformed identity or state fails closed for manual and automatic sends and is kept', async t => {
    const valid = { id: 'a1', provider: 'openai-codex', credentialId: 1, creditId: 'credit-1', expiresAt: iso(T0 + 30 * 60_000),
        remainingCount: null, origin: 'auto', state: 'unknown', code: 'reset_outcome_unknown', claimedAt: iso(T0) };
    for (const row of [{ state: 'sending ' }, { credentialId: undefined }, { creditId: 7 }, { origin: 'cli' }]) {
        const fx = await expiryFixture(t, [{ expiresAt: valid.expiresAt }]);
        const text = JSON.stringify({ version: 1, attempts: [{ ...valid, ...row }] });
        fs.writeFileSync(ledgerFile(fx.agentDir), text);
        await assert.rejects(fx.controls.sweepExpiring(), { code: 'attempt_record_unavailable' });
        await assert.rejects(fx.controls.redeem(1, { confirm: true, creditId: 'credit-1' }), { code: 'attempt_record_unavailable' });
        assert.deepEqual(fx.calls, []);
        assert.equal(fs.readFileSync(ledgerFile(fx.agentDir), 'utf8'), text);
    }
});

test('a transient policy read failure at any point of an automatic send never lets a send out without a durable claim', async t => {
    const realRead = fs.readFileSync;
    t.after(() => { fs.readFileSync = realRead; });
    for (let failAt = 1; failAt <= 4; failAt += 1) {
        const fx = await expiryFixture(t, [{ expiresAt: iso(T0 + 30 * 60_000) }]);
        const policy = path.join(fx.agentDir, 'cuelo-reset-expiry.json');
        let armed = false;
        let reads = 0;
        fs.readFileSync = function (file, ...rest) {
            if (armed && file === policy && ++reads === failAt) throw Object.assign(new Error('EIO'), { code: 'EIO' });
            return realRead.call(this, file, ...rest);
        };
        // 점검의 목록 조회 다음, 전송 직전 fresh 조회부터 정책 읽기 하나를 실패시킨다.
        const list = fx.storage.resets.list;
        fx.storage.resets.list = async options => { if (fx.lists.length === 1) armed = true; return list(options); };
        let unclaimed = 0;
        fx.storage.resets.redeem = async options => {
            fx.calls.push(options.target);
            if (!fs.existsSync(ledgerFile(fx.agentDir)) || !ledgerOf(fx.agentDir).some(entry => entry.state === 'sending')) unclaimed += 1;
            return { code: 'reset' };
        };
        await fx.controls.sweepExpiring();
        fs.readFileSync = realRead;
        assert.equal(unclaimed, 0, `failAt=${failAt}`);
    }
});

(process.versions.bun ? test : test.skip)('simultaneous claims from separate processes on one profile admit exactly one', async t => {
    const dir = tempProfile(t);
    const script = path.join(dir, 'claim.js');
    fs.writeFileSync(script, `const { claimResetAttempt } = require(${JSON.stringify(path.join(__dirname, 'usage-server.js'))});
(async () => {
    const { withFileLock } = await import(${JSON.stringify(SDK_UTILS)});
    await Bun.sleep(Math.max(0, Number(process.argv[3]) - Date.now()));
    const grant = { provider: 'openai-codex', credentialId: 1, creditId: 'credit-1', expiresAt: null, remainingCount: null };
    try { await claimResetAttempt(process.argv[2], withFileLock, grant, 'auto', Date.now()); console.log('claimed'); }
    catch (error) { console.log(error.code); }
})();
`);
    const startAt = String(Date.now() + 2000);
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ledgerFile(dir), startAt], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', chunk => { out += chunk; });
        child.on('error', reject);
        child.on('exit', () => resolve(out.trim()));
    })));
    assert.deepEqual(results.sort(), [...Array(7).fill('attempt_unresolved'), 'claimed']);
    assert.equal(ledgerOf(dir).length, 1);
});

test('the expiry sweep runs at once, never overlaps, and stops when the server closes', async () => {
    let runs = 0;
    let active = 0;
    let peak = 0;
    const controls = { sweepExpiring: async () => {
        runs += 1;
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active -= 1;
        return { enabled: true, outcomes: [] };
    } };
    const server = startServer(0, controls);
    await once(server, 'listening');
    const sweep = startExpirySweep(server, controls, 5);
    assert.equal(runs, 1);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(runs >= 3, `runs=${runs}`);
    assert.equal(peak, 1);
    await new Promise(resolve => server.close(resolve));
    await sweep.settled();
    const stoppedAt = runs;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(runs, stoppedAt);
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
