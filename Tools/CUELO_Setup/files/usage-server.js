// 사이드카: omp-web USAGE 패널용 백엔드. http://127.0.0.1:30142
//
//   GET  /usage                        CLI 사용량 + 로컬 계정 제어/저장 리셋
//   GET  /models                       CLI 모델 집계 (기존 fallback 유지)
//   POST /credential/<id>/{enable,disable,reset}
// 추론 discovery/config는 건드리지 않는다. 관리 초기화 장애는 이 sidecar에만 국한한다.
'use strict';
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

// 포트는 고정 30142 다. 환경변수는 두 번째 인스턴스를 띄워 새 라우트를 시험할 때만 쓴다
// (돌고 있는 사이드카를 죽이지 않아도 된다). OMP_EXE 와 같은 성격의 탈출구다.
const PORT = Number(process.env.OMP_USAGE_PORT || 30142);
// omp 실행 파일. setup 은 PATH 에 있는 omp 도 허용하므로 기본 위치에만 의존하면
// 설치는 통과하고 USAGE 만 조용히 실패한다. 기본 위치 -> 환경변수 -> PATH 순으로 쓴다.
const OMP = (() => {
    const fixed = path.join(process.env.LOCALAPPDATA || '', 'omp', 'omp.exe');
    if (process.env.OMP_EXE) return process.env.OMP_EXE;
    if (fixed && require('node:fs').existsSync(fixed)) return fixed;
    return 'omp.exe'; // Windows 는 실행 시 PATH 를 뒤진다
})();
const ORIGIN = 'http://127.0.0.1:' + (Number(process.env.PORT) || 30141);
const CACHE_MS = 60_000;
const CLI_TIMEOUT_MS = 30_000;

let cache = null; // { at, body }. 무효화는 at=0 으로 한다(오류 시 stale 응답을 살려 두려고).
let inflight = null;

function omp(args) {
    return new Promise((resolve, reject) => {
        execFile(
            OMP,
            args,
            { maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: CLI_TIMEOUT_MS },
            (err, stdout) => {
                if (err) return reject(err);
                resolve(String(stdout));
            },
        );
    });
}

function fetchUsage() {
    if (inflight) return inflight;
    inflight = (async () => {
        const epoch = usageEpoch;
        try {
            let stdout;
            if (localControl) {
                const { storage, baseUrlResolver } = localControl;
                await storage.reload();
                const reports = await storage.usage.reports({
                    baseUrlResolver, signal: AbortSignal.timeout(CLI_TIMEOUT_MS),
                });
                if (!reports) throw controlError(502, 'usage_unavailable');
                stdout = JSON.stringify({ generatedAt: Date.now(), reports });
            } else {
                stdout = await omp(['usage', '--json']);
                JSON.parse(stdout);
            }
            const entry = { at: epoch === usageEpoch ? Date.now() : 0, body: stdout };
            cache = entry;
            return entry;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

let usageEpoch = 0;
function invalidateUsage() {
    usageEpoch += 1;
    if (cache) cache.at = 0;
}

const MANUAL_UNTIL_MS = 4102444800000;
const PRIOR_DEFAULT_BLOCK_SCOPE = 'ompweb:manual-off:prior-default';
const IDENTITY_KEYS = ['email', 'accountId', 'orgId', 'projectId'];
const CONTROL_TIMEOUT_MS = 15_000;
const RESET_PROVIDERS = ['openai-codex', 'anthropic'];

function pick(source, keys) {
    return Object.fromEntries(keys.filter(key => source?.[key] !== undefined).map(key => [key, source[key]]));
}

// 단일 후보도 모순된 identity이면 결합하지 않는다. 증거 없는 결합 역시 금지한다.
function matchCredential(report, credentials) {
    const localId = report.metadata?.localCredentialId;
    const hasLocalId = Number.isSafeInteger(localId) && localId > 0;
    const candidates = credentials.filter(credential => {
        if (credential.provider !== report.provider) return false;
        if (hasLocalId && credential.credentialId !== localId) return false;
        let compared = hasLocalId;
        for (const key of IDENTITY_KEYS) {
            if (!report.metadata?.[key] || !credential[key]) continue;
            if (report.metadata[key] !== credential[key]) return false;
            compared = true;
        }
        return compared;
    });
    return candidates.length === 1 ? candidates[0] : null;
}

function safeReport(report) {
    return {
        ...pick(report, ['provider', 'fetchedAt', 'notes']),
        metadata: pick(report.metadata, [...IDENTITY_KEYS, 'orgName', 'planType', 'limitReached', 'localCredentialId']),
        limits: (report.limits || []).map(limit => ({
            ...pick(limit, ['id', 'label', 'status', 'notes']),
            scope: pick(limit.scope, ['provider', 'accountId', 'projectId', 'orgId', 'modelId', 'tier', 'windowId', 'shared']),
            amount: pick(limit.amount, ['used', 'limit', 'remaining', 'usedFraction', 'remainingFraction', 'unit']),
            ...(limit.window ? { window: pick(limit.window, ['id', 'label', 'durationMs', 'resetsAt', 'resetLabel']) } : {}),
        })),
        ...(report.resetCredits ? { resetCredits: {
            availableCount: report.resetCredits.availableCount,
            credits: (report.resetCredits.credits || []).map(credit => pick(credit, ['grantedAt', 'expiresAt', 'status'])),
        } } : {}),
    };
}

function savedReset(status, checkedAt = Date.now(), provider = 'openai-codex') {
    if (!status || status.error) return {
        state: 'unavailable', availableCount: null, checkedAt, credits: [], error: 'saved_reset_unavailable',
    };
    const credits = (status.credits || []).filter(credit => {
        const unexpired = !credit.expiresAt || !Number.isFinite(Date.parse(credit.expiresAt))
            || Date.parse(credit.expiresAt) > checkedAt;
        if (!unexpired) return false;
        return provider === 'anthropic'
            ? (credit.status ?? 'available') !== 'expired' && (credit.status ?? 'available') !== 'redeemed'
                && (credit.remainingCount ?? 0) > 0
            : (credit.status ?? 'available') === 'available';
    }).map(credit => ({
        ...pick(credit, ['program', 'remainingCount', 'usable', 'requiresLimit', 'clears', 'blocking', 'usedFractions', 'status']),
        id: credit.id, expiresAt: credit.expiresAt || null,
    }));
    const availableCount = provider === 'anthropic' && Number.isSafeInteger(status.availableCount)
        ? status.availableCount
        : credits.length;
    return {
        state: availableCount > 0 ? 'available' : 'empty',
        availableCount,
        checkedAt,
        credits,
        ...(provider === 'anthropic' ? pick(status, ['redeemableCount', 'nextCreditId', 'eligible', 'reason', 'cooldownUntil']) : {}),
    };
}

function controlError(status, code, outcomeUnknown = false) {
    return Object.assign(new Error(code), { status, code, outcomeUnknown });
}

// 동일 storage의 reload/cache도 함께 직렬화한다. 외부 CLI의 mutation까지 잠그지는 않는다.
function createControlFacade(getControl, invalidate = invalidateUsage) {
    let tail = Promise.resolve();
    let epoch = 0;
    let snapshot;
    let resets = new Map();
    const lastGoodResets = new Map();
    const resetRequests = new Map();
    const invalidateAll = () => {
        epoch += 1;
        snapshot = undefined;
        resets = new Map();
        invalidate();
    };
    const serialize = work => {
        invalidateAll();
        const result = tail.then(work);
        tail = result.catch(() => {}).finally(invalidateAll);
        return result;
    };
    const control = () => {
        const value = getControl();
        if (!value) throw controlError(503, 'management_unavailable');
        return value;
    };
    async function credentials(force = false) {
        await tail;
        if (!force && snapshot && Date.now() - snapshot.at < 5_000) return snapshot.credentials;
        const currentEpoch = epoch;
        const { storage } = control();
        await storage.reload();
        const entries = storage.credentials.snapshot().credentials;
        const blocks = storage.blocks.list(entries.map(entry => entry.id));
        const result = entries.map(entry => {
            const providerKey = `${entry.provider}:${entry.credential.type}`;
            const own = blocks.filter(block => block.credentialId === entry.id);
            const manual = own.find(block => block.providerKey === providerKey
                && block.blockScope === '' && block.blockedUntilMs === MANUAL_UNTIL_MS);
            const auto = own.filter(block => block !== manual && block.blockScope !== PRIOR_DEFAULT_BLOCK_SCOPE
                && block.blockedUntilMs > Date.now());
            return {
                credentialId: entry.id, provider: entry.provider, credentialType: entry.credential.type,
                ...pick(entry.credential, IDENTITY_KEYS),
                disabled: !!manual,
                autoBlockedUntilMs: auto.length ? Math.max(...auto.map(block => block.blockedUntilMs)) : null,
            };
        });
        if (currentEpoch !== epoch) return credentials(true);
        snapshot = { at: Date.now(), credentials: result };
        return result;
    }
    async function creditStatuses(provider, force = false, signal) {
        const cached = resets.get(provider);
        if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached;
        const currentEpoch = epoch;
        const { storage, baseUrlResolver } = control();
        const fetched = await storage.resets.list({
            provider, baseUrlResolver, signal: signal ?? AbortSignal.timeout(CONTROL_TIMEOUT_MS),
        });
        // 조회 한도(429 등)로 한 계정이 실패하면 30분 안의 직전 성공값을 표시에 유지한다. "확인 불가"로 깜빡이지 않게 한다.
        // 무효화와 무관한 별도 map이며, 리딤(force) 판정에는 쓰지 않는다.
        const now = Date.now();
        const statuses = fetched.map(status => {
            const key = `${provider}:${status.credentialId}`;
            if (!status.error) { lastGoodResets.set(key, { at: now, status }); return status; }
            const prior = lastGoodResets.get(key);
            return !force && prior && now - prior.at < 30 * 60_000 ? prior.status : status;
        });
        const result = { at: Date.now(), statuses };
        if (currentEpoch === epoch) resets.set(provider, result);
        return result;
    }
    // mutation 내부에서는 tail을 기다리는 조회 helper를 호출하지 않는다.
    async function mutationCredential(id) {
        const { storage } = control();
        await storage.reload();
        const entry = storage.credentials.snapshot().credentials.find(value => value.id === id);
        if (!entry) throw controlError(404, 'credential_not_found');
        const providerKey = `${entry.provider}:${entry.credential.type}`;
        const blocks = storage.blocks.list([id]).filter(block => block.providerKey === providerKey);
        const manual = blocks.find(block => block.blockScope === '' && block.blockedUntilMs === MANUAL_UNTIL_MS);
        const priorDefault = blocks.find(block => block.blockScope === PRIOR_DEFAULT_BLOCK_SCOPE);
        const defaultAuto = blocks.find(block => block.blockScope === ''
            && block.blockedUntilMs !== MANUAL_UNTIL_MS && block.blockedUntilMs > Date.now());
        return { storage, entry, providerKey, manual, priorDefault, defaultAuto };
    }
    async function enrich(raw) {
        const usage = {
            ...pick(raw, ['generatedAt', 'notes']),
            reports: (raw.reports || []).map(safeReport),
            ...(raw.accountsWithoutUsage ? { accountsWithoutUsage: raw.accountsWithoutUsage.map(account =>
                pick(account, ['provider', 'type', ...IDENTITY_KEYS, 'orgName', 'enterpriseUrl', 'authorizedAt'])) } : {}),
            ...(raw.disabledCredentials ? { disabledCredentials: raw.disabledCredentials.map(account => ({
                ...pick(account, ['id', 'provider', 'type', ...IDENTITY_KEYS, 'orgName', 'disabledAtMs']),
                cause: 'credential_disabled',
            })) } : {}),
            ...(raw.capacity ? { capacity: Object.fromEntries(Object.entries(raw.capacity).map(([provider, stats]) => [
                provider, stats.map(stat => pick(stat, ['window', 'durationMs', 'meter', 'accounts', 'usedAccounts', 'remainingAccounts'])),
            ])) } : {}),
        };
        try {
            const startEpoch = epoch;
            const all = await credentials();
            usage.brokerOk = true;
            const creditsByProvider = new Map();
            for (const provider of RESET_PROVIDERS) {
                try { creditsByProvider.set(provider, await creditStatuses(provider)); } catch {
                    // Unsupported Anthropic reset APIs leave only Anthropic reset data unavailable.
                }
            }
            if (startEpoch !== epoch) return enrich(raw);
            const joined = new Set();
            for (const report of usage.reports) {
                const credential = matchCredential(report, all);
                if (!credential) {
                    report.accountRole = 'usage-only';
                    if (RESET_PROVIDERS.includes(report.provider)) report.savedReset = savedReset(undefined, Date.now(), report.provider);
                    continue;
                }
                Object.assign(report, pick(credential, ['credentialId', 'disabled', 'autoBlockedUntilMs']));
                joined.add(credential.credentialId);
                if (RESET_PROVIDERS.includes(report.provider)) {
                    const credits = creditsByProvider.get(report.provider);
                    report.savedReset = savedReset(
                        credits?.statuses.find(status => status.credentialId === credential.credentialId),
                        credits?.at, report.provider);
                }
            }
            for (const credential of all) {
                if (joined.has(credential.credentialId) || !control().storage.usage.providerFor(credential.provider)) continue;
                usage.reports.push({
                    provider: credential.provider, fetchedAt: 0, limits: [],
                    accountRole: 'control-only',
                    metadata: pick(credential, IDENTITY_KEYS),
                    ...pick(credential, ['credentialId', 'disabled', 'autoBlockedUntilMs']),
                    ...(RESET_PROVIDERS.includes(credential.provider) ? { savedReset: savedReset(
                        creditsByProvider.get(credential.provider)?.statuses.find(status => status.credentialId === credential.credentialId),
                        creditsByProvider.get(credential.provider)?.at, credential.provider) } : {}),
                });
            }
        } catch {
            usage.brokerOk = false;
            usage.brokerError = 'management_unavailable';
            for (const report of usage.reports) {
                delete report.credentialId;
                delete report.disabled;
                delete report.autoBlockedUntilMs;
                if (RESET_PROVIDERS.includes(report.provider)) report.savedReset = savedReset(undefined, Date.now(), report.provider);
            }
        }
        return usage;
    }
    function setDisabled(id, disabled) {
        return serialize(async () => {
            const { storage, providerKey, manual, priorDefault, defaultAuto } = await mutationCredential(id);
            if (disabled && !manual) {
                if (defaultAuto) storage.blocks.upsert({
                    credentialId: id, providerKey, blockScope: PRIOR_DEFAULT_BLOCK_SCOPE,
                    blockedUntilMs: defaultAuto.blockedUntilMs,
                });
                storage.blocks.upsert({
                    credentialId: id, providerKey, blockScope: '', blockedUntilMs: MANUAL_UNTIL_MS,
                });
            }
            if (!disabled) {
                if (manual) storage.blocks.delete(id, providerKey, '');
                if (priorDefault?.blockedUntilMs > Date.now()) storage.blocks.upsert({
                    credentialId: id, providerKey, blockScope: '', blockedUntilMs: priorDefault.blockedUntilMs,
                });
                if (priorDefault) storage.blocks.delete(id, providerKey, PRIOR_DEFAULT_BLOCK_SCOPE);
            }
            const actual = storage.blocks.list([id]).some(block => block.providerKey === providerKey
                && block.blockScope === '' && block.blockedUntilMs === MANUAL_UNTIL_MS);
            if (actual !== disabled) throw controlError(502, 'credential_update_failed');
            return { ok: true, credentialId: id, disabled: actual };
        });
    }
    function redeem(id, body) {
        if (body?.confirm !== true || typeof body.creditId !== 'string' || !body.creditId.trim()
            || body.creditId.length > 512 || Object.keys(body).some(key => key !== 'confirm' && key !== 'creditId')) {
            return Promise.reject(controlError(400, 'confirmation_required'));
        }
        const creditId = body.creditId;
        const key = `${id}:${creditId}`;
        if (resetRequests.has(key)) return resetRequests.get(key);
        let invoked = false;
        const request = serialize(async () => {
            const { storage, entry, manual } = await mutationCredential(id);
            if (!RESET_PROVIDERS.includes(entry.provider) || entry.credential.type !== 'oauth') {
                throw controlError(400, 'unsupported_provider');
            }
            if (manual) throw controlError(409, 'account_disabled');
            const signal = AbortSignal.timeout(CONTROL_TIMEOUT_MS);
            const live = await creditStatuses(entry.provider, true, signal);
            const status = live.statuses.find(value => value.credentialId === id);
            if (!status || status.error) throw controlError(502, 'credit_list_failed');
            if (!savedReset(status, live.at, entry.provider).credits.some(credit => credit.id === creditId)
                || (entry.provider === 'anthropic' && status.nextCreditId !== creditId)) {
                throw controlError(409, 'credit_unavailable');
            }
            invoked = true;
            try {
                const result = await storage.resets.redeem({
                    target: { provider: entry.provider, credentialId: id, creditId },
                    baseUrlResolver: control().baseUrlResolver,
                    signal,
                });
                const known = ['reset', 'already_redeemed', 'no_credit', 'nothing_to_reset',
                    'no_account', 'account_unavailable', 'credit_list_failed',
                    'ineligible', 'offer_changed', 'reset_unconfirmed', 'cooldown', 'rate_limited', 'auth_error', 'unavailable'];
                const code = known.includes(result.code) || /^http_[1-5]\d\d$/.test(result.code)
                    ? result.code : 'unknown_outcome';
                return { ok: code === 'reset', credentialId: id, creditId, code,
                    ...(code === 'unknown_outcome' || /^http_5/.test(code) ? { outcomeUnknown: true } : {}) };
            } catch {
                throw controlError(502, 'reset_outcome_unknown', true);
            }
        });
        resetRequests.set(key, request);
        // 전송 이후 결과는 보관한다. 같은 credit의 불확실한 결과를 자동 재시도하지 않는다.
        void request.catch(() => { if (!invoked) resetRequests.delete(key); });
        return request;
    }
    return { enrich, setDisabled, redeem, invalidate: invalidateAll };
}

let localControl;
const facade = createControlFacade(() => localControl);
async function initializeControl() {
    let storage;
    try {
        // 공식 fallback 설치본은 upstream 이름(omp-web)으로 들어간다.
        const names = ['cuelo', 'omp-web'];
        const hasSdk = dir => dir && fs.existsSync(path.join(dir, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'src', 'index.ts'));
        const candidates = [process.env.CUELO_DIR, ...names.map(name => path.join(process.env.APPDATA || '', 'npm', 'node_modules', name))];
        let root = candidates.find(hasSdk);
        if (!root) {
            const npmRoot = require('node:child_process').execSync('npm root -g', {
                encoding: 'utf8', windowsHide: true, timeout: CLI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            root = names.map(name => path.join(npmRoot, name)).find(hasSdk) ?? path.join(npmRoot, names[0]);
        }
        const load = (pkg, file) => import(pathToFileURL(path.join(root, 'node_modules', '@oh-my-pi', pkg, 'src', file)).href);
        const [sdk, utils] = await Promise.all([
            load('pi-coding-agent', 'index.ts'), load('pi-utils', 'index.ts'),
        ]);
        storage = await sdk.AuthStorage.create(utils.getAgentDbPath());
        await storage.reload();
        const registry = new sdk.ModelRegistry(storage);
        localControl = {
            storage, baseUrlResolver: provider => registry.getProviderBaseUrl(provider),
        };
    } catch {
        storage?.close?.();
        // SDK/storage 문제는 관리만 끈다. raw 오류/credential은 로그에 싣지 않는다.
        console.warn('usage account management unavailable; CLI usage/models remain available');
    }
}

// ---------------------------------------------------------------------------
// 구간(24시간 슬롯) 실측.
//
// `omp usage --json` 은 계정→한도 축의 현재 스냅샷만 주고 시계열이 없다. 그래서 패널의
// "하루 몫"은 창 길이를 날짜 수로 나눈 정적 상수였고(7일 창이면 계정이 무엇을 하든 항상
// 14.3%), 사용자가 계정을 바꿀 근거가 되지 못했다. 여기서 폴링마다 표본을 남겨 리셋 시각
// 기준 24시간 구간의 실제 소비량을 낸다.
//
// 기록은 최소다. 표본은 (관측 시각, 사용률) 두 값뿐이고, 계열 키는 이메일이 아니라
// provider + credentialId(없으면 accountId/orgId) + limit.id 다. 파일이 없거나 깨졌으면
// quality 를 unknown 으로 낮출 뿐이고, 어떤 경우에도 사이드카를 죽이지 않는다
// (2026-09-16: 처리되지 않은 rejection 하나가 프로세스를 끝내 모든 페이지가 502 를 받았다).
const DAY_MS = 86_400_000;
const SAMPLE_FILE = process.env.OMP_USAGE_SAMPLE_FILE
    || path.join(os.homedir(), '.omp', 'ompweb-usage-samples.json');
// 표본은 "구간 경계 직전의 마지막 표본"을 찾을 때만 쓴다. 경계가 지난 첫 폴링에서 기준선을
// 고정하므로 그 뒤로는 오래된 표본이 필요 없다. 고정은 항상 정리보다 먼저 일어난다.
const SAMPLE_RETENTION_MS = 3 * 3_600_000;
const MAX_SAMPLES = 400; // 3시간 × 60초 폴링 = 180. 이상 폴링까지 감안한 상한이다
const MAX_SERIES = 64; // 계정×한도. 실제는 한 자릿수다
const SERIES_TTL_MS = 30 * DAY_MS;
// 경계 표본이 이 안에 있으면 실측(exact), 더 오래됐으면 추정(approx)이다.
const SLOT_EXACT_GAP_MS = CACHE_MS;
// resetsAt 이 이만큼 움직이면 다른 창이다(실제로는 창 길이만큼 움직인다). 초 단위 흔들림으로
// 창 identity 가 깨져 기록이 매번 버려지는 것을 막는 여유값이다.
const SAME_WINDOW_MS = 600_000;
// 이보다 작은 하락은 provider 반올림 잡음으로 본다. 기록을 버리지 않고 0 으로 바닥만 잡는다.
const DROP_EPSILON_PCT = 0.5;

function createSampleStore(file = SAMPLE_FILE) {
    let state;
    function load() {
        if (state) return state;
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (parsed?.version === 1 && parsed.series && typeof parsed.series === 'object') {
                state = { version: 1, series: parsed.series };
                return state;
            }
        } catch { /* 없거나 깨진 파일은 빈 기록과 같다. 그 결과는 quality: unknown 이다 */ }
        state = { version: 1, series: {} };
        return state;
    }
    return {
        series(key) {
            const all = load().series;
            const record = all[key];
            if (record && Array.isArray(record.samples)) return record;
            all[key] = { resetsAt: 0, samples: [], baseline: null, dropAt: null, at: 0 };
            return all[key];
        },
        flush(now = Date.now()) {
            if (!state) return;
            const all = state.series;
            for (const [key, record] of Object.entries(all)) {
                if (!(now - record.at < SERIES_TTL_MS)) delete all[key];
            }
            const keys = Object.keys(all);
            if (keys.length > MAX_SERIES) {
                for (const key of keys.sort((left, right) => all[right].at - all[left].at).slice(MAX_SERIES)) {
                    delete all[key];
                }
            }
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                const temp = `${file}.tmp`;
                fs.writeFileSync(temp, JSON.stringify(state));
                fs.renameSync(temp, file); // 교체는 원자적이다. 반쯤 쓰인 파일을 읽는 일이 없다
            } catch { /* 기록은 편의 기능이다. 쓰지 못해도 응답은 그대로 나간다 */ }
        },
    };
}

// 구간은 리셋 시각에서 24시간씩 거꾸로 센다. 자정 기준이 아니다. 하루 이하 창(5시간 등)은
// 창 자체가 구간이라 나눌 것이 없으므로 구간을 내지 않는다.
function slotBounds(window, now) {
    const resetsAt = Number(window?.resetsAt);
    const durationMs = Number(window?.durationMs);
    if (!Number.isFinite(resetsAt) || !Number.isFinite(durationMs) || durationMs <= DAY_MS) return null;
    const remainingMs = resetsAt - now;
    if (remainingMs <= 0) return null;
    const slotCount = Math.max(1, Math.ceil(durationMs / DAY_MS));
    const slotsLeft = Math.min(slotCount, Math.max(1, Math.ceil(remainingMs / DAY_MS)));
    const slotEnd = resetsAt - (slotsLeft - 1) * DAY_MS;
    return {
        slotStart: slotEnd - DAY_MS,
        slotEnd,
        slotIndex: slotCount - slotsLeft,
        slotCount,
        slotsLeft,
        windowStart: resetsAt - durationMs,
        quotaPct: 100 / slotCount,
    };
}

// 표본 하나를 반영하고 현재 구간의 실측을 낸다. 기준선은 네 경로로만 정해진다.
//   1) 같은 창에서 사용률이 떨어진 지점이 현재 구간 안이면 시작값을 알 수 없다 → unknown
//   2) 구간 시작이 창 시작보다 앞이면(창의 첫 구간) 기준선은 정의상 0 이다 → exact, 표본 불필요
//   3) 그 구간에 대해 이미 고정해 둔 기준선
//   4) 같은 창의 표본 중 구간 시작 이하의 최신 것. 이때 고정한다
function trackSlot(record, bounds, resetsAt, pct, observedAt) {
    // 창 identity. resetsAt 이 다르면 다른 창의 표본이고 비교 대상이 아니다.
    if (!(Math.abs(record.resetsAt - resetsAt) <= SAME_WINDOW_MS)) {
        Object.assign(record, { resetsAt, samples: [], baseline: null, dropAt: null });
    }
    const last = record.samples[record.samples.length - 1];
    if (last && pct < last[1] - DROP_EPSILON_PCT) {
        // 같은 창에서 사용률이 줄었다(저장된 리셋 사용, provider 보정). 이전 표본과 기준선은
        // 다른 척도의 값이라 전부 버린다. 하락 지점 이후로만 다시 센다.
        Object.assign(record, { samples: [], baseline: null, dropAt: observedAt });
    }
    let baseline = null;
    if (record.dropAt != null && record.dropAt >= bounds.slotStart) {
        baseline = null;
    } else if (bounds.slotStart <= bounds.windowStart) {
        baseline = { i: bounds.slotIndex, p: 0, t: bounds.slotStart };
    } else if (record.baseline && record.baseline.i === bounds.slotIndex) {
        baseline = record.baseline;
    } else {
        const candidate = record.samples.filter(([at]) => at <= bounds.slotStart).pop();
        if (candidate) {
            baseline = { i: bounds.slotIndex, p: candidate[1], t: candidate[0] };
            record.baseline = baseline;
        }
    }
    const appended = !last || last[0] !== observedAt;
    if (appended) {
        record.samples.push([observedAt, pct]);
        record.at = observedAt;
        const cutoff = observedAt - SAMPLE_RETENTION_MS;
        if (record.samples[0][0] <= cutoff) record.samples = record.samples.filter(([at]) => at > cutoff);
        if (record.samples.length > MAX_SAMPLES) record.samples = record.samples.slice(-MAX_SAMPLES);
    }
    const gapMs = baseline ? Math.max(0, bounds.slotStart - baseline.t) : null;
    return {
        appended,
        daySlot: {
            slotStart: bounds.slotStart,
            slotEnd: bounds.slotEnd,
            slotIndex: bounds.slotIndex,
            slotCount: bounds.slotCount,
            slotsLeft: bounds.slotsLeft,
            baselinePct: baseline ? baseline.p : null,
            usedPct: baseline ? Math.max(0, pct - baseline.p) : null,
            quotaPct: bounds.quotaPct,
            quality: !baseline ? 'unknown' : gapMs <= SLOT_EXACT_GAP_MS ? 'exact' : 'approx',
            gapMs,
        },
    };
}

// 계열 키. 안정 식별자가 없으면 기록하지 않는다 — 이메일은 키로 쓰지 않는다.
function seriesKey(report, limit) {
    const identity = Number.isSafeInteger(report.credentialId) && report.credentialId > 0
        ? `c${report.credentialId}`
        : report.metadata?.accountId ? `a${report.metadata.accountId}`
            : report.metadata?.orgId ? `g${report.metadata.orgId}` : null;
    return identity && limit.id ? `${report.provider}|${identity}|${limit.id}` : null;
}

function applyDaySlots(usage, store, now = Date.now()) {
    let appended = false;
    for (const report of usage.reports || []) {
        // 관측 시각은 provider 가 답한 시점이다. 60초 캐시를 두 번 서빙해도 표본은 하나다.
        const fetchedAt = Number(report.fetchedAt);
        const observedAt = Number.isFinite(fetchedAt) && fetchedAt > 0 ? Math.min(fetchedAt, now) : now;
        for (const limit of report.limits || []) {
            const usedFraction = limit.amount?.usedFraction;
            if (typeof usedFraction !== 'number' || !Number.isFinite(usedFraction)) continue;
            const bounds = slotBounds(limit.window, now);
            const key = bounds && seriesKey(report, limit);
            if (!key) continue;
            const tracked = trackSlot(store.series(key), bounds, Number(limit.window.resetsAt),
                usedFraction * 100, observedAt);
            limit.daySlot = tracked.daySlot;
            appended = appended || tracked.appended;
        }
    }
    if (appended) store.flush(now);
    return usage;
}

const sampleStore = createSampleStore();

async function buildUsageBody(controls = facade, readUsage) {
    // 주입된 readUsage는 테스트 경로다. 표본은 실제 provider 스냅샷만 남긴다.
    if (readUsage) return JSON.stringify(await controls.enrich(await readUsage()));
    let entry = cache;
    try {
        if (!entry || Date.now() - entry.at > CACHE_MS) entry = await fetchUsage();
    } catch {
        if (!entry) {
            if (!localControl) throw controlError(502, 'usage_unavailable');
            entry = { body: '{"reports":[]}' };
        }
    }
    const usage = await controls.enrich(JSON.parse(entry.body));
    // 구간 실측은 편의 기능이다. 실패해도 사용량 응답 자체는 그대로 나가야 한다.
    try { applyDaySlots(usage, sampleStore); } catch { /* daySlot 없이 내보낸다 = 기록 부족 */ }
    return JSON.stringify(usage);
}


// ---------------------------------------------------------------------------
// 모델별 집계. `omp usage` 는 계정·한도 축만 있어서 "이번 주 토큰을 어느 모델이 먹었나"를
// 답하지 못한다. 그 데이터는 `omp stats` 쪽에 있다.
//
// `omp stats --json` 은 호출할 때마다 세션 JSONL 을 stats.db 로 재인덱싱한다(그래서 DB 를
// 직접 읽지 않는다 — 직접 읽으면 마지막 동기화 시점의 낡은 스냅샷이 나온다). 대신 stdout
// 앞에 "Syncing session files..." 같은 진행 문구가 붙으므로 첫 '{' 부터 잘라 쓴다.
//
// 재인덱싱이 있어 /usage 보다 무겁다. 캐시를 길게 잡고 패널이 자동 폴링하지 않게 한다.
const STATS_CACHE_MS = 120_000;
// 콜드 실행 실측이 133s(세션 파일 동기화 포함)라 90s 는 항상 죽었다. 실측의 2배 남짓으로 둔다.
const STATS_TIMEOUT_MS = 300_000;
const DAILY_DAYS = 14; // 일별 표는 최근 구간만 낸다. 전체를 내면 payload 가 계속 커진다.
let statsCache = null; // { at, body }
let statsInflight = null;

function ompStats() {
    return new Promise((resolve, reject) => {
        execFile(
            OMP,
            ['stats', '--json'],
            { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: STATS_TIMEOUT_MS },
            (err, stdout) => {
                if (err) return reject(err);
                const text = String(stdout);
                const at = text.indexOf('{');
                if (at < 0) return reject(new Error('omp stats --json 에 JSON 이 없다'));
                try {
                    resolve(JSON.parse(text.slice(at)));
                } catch (e) {
                    reject(new Error(`omp stats --json 파싱 실패: ${e.message}`));
                }
            },
        );
    });
}

// 0 나눗셈을 피하면서 비율을 낸다. 분모가 0 이면 값 자체를 만들지 않는다(null).
function per(total, count) {
    return count > 0 ? total / count : null;
}

// stats 원본은 크고(모델×시간 시계열 두 개) 패널이 쓰지 않는 필드가 많다. 필요한 축만
// 남겨 보낸다. 축은 세 개다: 모델 / agent 종류 / 최근 일별 모델 비용.
function shapeStats(raw) {
    const overall = raw.overall || {};
    const totalCost = overall.totalCost || 0;

    const models = (raw.byModel || []).map(m => {
        const tokens = (m.totalInputTokens || 0) + (m.totalOutputTokens || 0)
            + (m.totalCacheReadTokens || 0) + (m.totalCacheWriteTokens || 0);
        return {
            model: m.model,
            provider: m.provider,
            requests: m.totalRequests || 0,
            cost: m.totalCost || 0,
            costShare: totalCost > 0 ? (m.totalCost || 0) / totalCost : 0,
            costPerRequest: per(m.totalCost || 0, m.totalRequests || 0),
            tokens,
            tokensPerRequest: per(tokens, m.totalRequests || 0),
            outputPerRequest: per(m.totalOutputTokens || 0, m.totalRequests || 0),
            cacheRate: m.cacheRate,
            avgTtft: m.avgTtft,
            avgTokensPerSecond: m.avgTokensPerSecond,
            errorRate: m.errorRate,
        };
    }).sort((a, b) => b.cost - a.cost);

    const agents = (raw.byAgentType || []).map(a => {
        const tokens = (a.totalInputTokens || 0) + (a.totalOutputTokens || 0)
            + (a.totalCacheReadTokens || 0) + (a.totalCacheWriteTokens || 0);
        return {
            agentType: a.agentType,
            requests: a.totalRequests || 0,
            cost: a.totalCost || 0,
            costShare: totalCost > 0 ? (a.totalCost || 0) / totalCost : 0,
            costPerRequest: per(a.totalCost || 0, a.totalRequests || 0),
            tokensPerRequest: per(tokens, a.totalRequests || 0),
        };
    }).sort((a, b) => b.cost - a.cost);

    // costSeries 는 (일자, 모델) 단위 비용이다. 날짜로 묶어 최근 것부터 낸다.
    const byDay = new Map();
    for (const point of raw.costSeries || []) {
        if (!point || typeof point.timestamp !== 'number') continue;
        let day = byDay.get(point.timestamp);
        if (!day) byDay.set(point.timestamp, (day = { timestamp: point.timestamp, cost: 0, models: [] }));
        day.cost += point.cost || 0;
        day.models.push({ model: point.model, provider: point.provider, cost: point.cost || 0 });
    }
    const daily = [...byDay.values()]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, DAILY_DAYS)
        .map(day => ({
            timestamp: day.timestamp,
            cost: day.cost,
            models: day.models.sort((a, b) => b.cost - a.cost),
        }));

    return {
        generatedAt: Date.now(),
        range: { from: overall.firstTimestamp, to: overall.lastTimestamp },
        overall: {
            requests: overall.totalRequests || 0,
            failedRequests: overall.failedRequests || 0,
            errorRate: overall.errorRate,
            cost: totalCost,
            tokens: (overall.totalInputTokens || 0) + (overall.totalOutputTokens || 0)
                + (overall.totalCacheReadTokens || 0) + (overall.totalCacheWriteTokens || 0),
            cacheRate: overall.cacheRate,
            cacheSavings: overall.cacheSavings,
            avgTtft: overall.avgTtft,
            avgDuration: overall.avgDuration,
        },
        models,
        agents,
        daily,
    };
}

function fetchStats() {
    if (statsInflight) return statsInflight;
    statsInflight = (async () => {
        try {
            const body = JSON.stringify(shapeStats(await ompStats()));
            statsCache = { at: Date.now(), body };
            return statsCache;
        } finally {
            statsInflight = null;
        }
    })();
    return statsInflight;
}

async function buildStatsBody() {
    let entry = statsCache;
    if (!entry || Date.now() - entry.at > STATS_CACHE_MS) entry = await fetchStats();
    return entry.body;
}

function corsHeaders(extra) {
    return {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'no-store',
        ...extra,
    };
}

async function handleRequest(req, res, controls = facade, readUsage) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`) {
        res.writeHead(403, corsHeaders());
        return res.end('{"error":"untrusted_host","code":"untrusted_host"}');
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/usage') {
        try {
            if (url.searchParams.get('refresh') === '1') controls.invalidate();
            const body = await buildUsageBody(controls, readUsage);
            res.writeHead(200, corsHeaders());
            return res.end(body);
        } catch {
            res.writeHead(500, corsHeaders());
            return res.end('{"error":"usage_unavailable","code":"usage_unavailable"}');
        }
    }

    // 모델별 집계. /usage 와 같은 규칙을 쓴다: refresh=1 이면 캐시를 만료시키고, 실패하면
    // 오류보다 오래된 본문을 낸다.
    if (req.method === 'GET' && url.pathname === '/models') {
        try {
            if (url.searchParams.get('refresh') === '1' && statsCache) {
                statsCache = { at: 0, body: statsCache.body };
            }
            // 본문을 먼저 만든 뒤 헤더를 쓴다. 순서를 뒤집으면 콜드 캐시 실패가 catch 에서
            // 두 번째 writeHead 로 이어져 ERR_HTTP_HEADERS_SENT 가 프로세스를 죽였다
            // (2026-09-16 실측: sidecar 사망 -> 모든 페이지가 502).
            const body = await buildStatsBody();
            res.writeHead(200, corsHeaders());
            return res.end(body);
        } catch (e) {
            // 원인을 삼키지 않는다. 캐시가 있으면 오류보다 오래된 본문을 낸다.
            console.error(`[models] ${e && e.message ? e.message : e}`);
            if (statsCache) {
                res.writeHead(200, corsHeaders());
                return res.end(statsCache.body);
            }
            res.writeHead(500, corsHeaders());
            return res.end('{"error":"models_unavailable","code":"models_unavailable"}');
        }
    }

    const mutation = url.pathname.match(/^\/credential\/([1-9]\d*)\/(disable|enable|reset)$/);
    if (req.method === 'POST' && mutation) {
        if (req.headers.origin !== ORIGIN) {
            res.writeHead(403, corsHeaders());
            return res.end('{"error":"untrusted_origin","code":"untrusted_origin"}');
        }
        try {
            const id = Number(mutation[1]);
            if (!Number.isSafeInteger(id)) throw controlError(400, 'invalid_credential_id');
            if (mutation[2] === 'reset' && req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
                throw controlError(415, 'json_required');
            }
            let body = '';
            for await (const chunk of req) {
                body += chunk;
                if (Buffer.byteLength(body) > 4096) throw controlError(413, 'body_too_large');
            }
            let result;
            if (mutation[2] === 'reset') {
                let parsed;
                try { parsed = JSON.parse(body); } catch { throw controlError(400, 'invalid_json'); }
                result = await controls.redeem(id, parsed);
            } else {
                if (body) throw controlError(400, 'body_not_allowed');
                result = await controls.setDisabled(id, mutation[2] === 'disable');
            }
            res.writeHead(200, corsHeaders());
            return res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(error.status || 502, corsHeaders());
            return res.end(JSON.stringify({
                error: error.code || 'management_unavailable', code: error.code || 'management_unavailable',
                ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}),
            }));
        }
    }

    res.writeHead(404, corsHeaders());
    res.end('{"error":"not found"}');
}

function startServer(port = PORT, controls = facade, readUsage) {
    // 핸들러 rejection 은 요청 하나의 실패로 끝내야 한다. 콜백이 promise 를 놓아두면
    // Bun 이 unhandled rejection 으로 프로세스를 끝내고, sidecar 가 사라진 뒤 모든 페이지가
    // 502 를 받는다(2026-09-16 실측).
    const server = http.createServer((req, res) => {
        handleRequest(req, res, controls, readUsage).catch((error) => {
            console.error(`[request] ${req.method} ${req.url} ${error && error.message ? error.message : error}`);
            if (!res.headersSent) res.writeHead(500, corsHeaders());
            if (!res.writableEnded) res.end('{"error":"internal","code":"internal"}');
        });
    });
    server.listen(port, '127.0.0.1', () => {
        console.log(`usage sidecar on http://127.0.0.1:${port}/usage`);
    });
    return server;
}

if (require.main === module) {
    startServer();
    void initializeControl();
    // `omp stats --json` 은 세션 파일 동기화 때문에 콜드 실행이 2분을 넘는다(실측 133s).
    // 패널이 처음 열릴 때 그 비용을 물면 클라이언트(120s)가 먼저 끊긴다. 기동 시 한 번
    // 데워 두고, 실패는 로그로만 남긴다.
    void fetchStats().catch((error) => {
        console.error(`[models warm] ${error && error.message ? error.message : error}`);
    });
}

module.exports = {
    startServer,
    createControlFacade,
    matchCredential,
    MANUAL_UNTIL_MS,
    createSampleStore,
    applyDaySlots,
};
