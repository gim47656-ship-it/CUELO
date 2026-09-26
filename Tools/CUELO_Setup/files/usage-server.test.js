'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const { createControlFacade, matchCredential, startServer, MANUAL_UNTIL_MS } = require('./usage-server');

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
