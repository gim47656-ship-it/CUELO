// Sidecar: /btw-style ephemeral side chat for CUELO at http://127.0.0.1:30143/ask.
// MUST run under Bun (the omp SDK is TS sources importing bun: builtins); launch.ps1
// starts it with ~\.bun\bin\bun.exe. The UI lives in components/workspace/SideChatPanel.tsx.
//
// How it works: the panel POSTs { sessionPath, question, history? }. This server
// copies the session .jsonl to a temp file (SessionManager.open takes a single-writer
// lock, so the live file CUELO owns is never opened), builds an AgentSession over
// the copy, and calls session.runEphemeralTurn() — the same primitive the TUI's /btw
// uses: full session context, no tools, nothing persisted. Deltas stream back as
// NDJSON lines: {t:'d',v:delta} | {t:'done',v:full} | {t:'err',v:message}.
'use strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.OMP_BTW_PORT) || 30143;
const ALLOW_ORIGIN = 'http://127.0.0.1:' + (Number(process.env.PORT) || 30141);
const IDLE_DISPOSE_MS = 15 * 60_000;
const SESSIONS_ROOT = path.join(os.homedir(), '.omp', 'agent', 'sessions');
const TMP_DIR = path.join(os.tmpdir(), 'omp-btw');

// omp SDK out of CUELO's own node_modules, so both always share one SDK version.
// npm global prefix 를 바꿔 쓰는 PC 도 있으므로 기본 위치가 없으면 `npm root -g` 로 찾는다.
function resolveCueloDir() {
    const candidates = [];
    if (process.env.CUELO_DIR) candidates.push(process.env.CUELO_DIR);
    // 공식 fallback 설치본은 upstream 이름(omp-web)으로 들어간다.
    for (const name of ['cuelo', 'omp-web']) candidates.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules', name));
    try {
        // 명령이 고정 문자열이라 주입 여지가 없다. execFileSync + shell:true 는
        // Node 가 deprecation 경고를 내므로 execSync 를 쓴다.
        const root = require('node:child_process')
            .execSync('npm root -g', { encoding: 'utf8', windowsHide: true })
            .trim();
        if (root) for (const name of ['cuelo', 'omp-web']) candidates.push(path.join(root, name));
    } catch { /* npm 이 없으면 기본 후보만 쓴다 */ }
    const hit = candidates.find(dir => dir && fs.existsSync(path.join(dir, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'src', 'index.ts')));
    return hit || candidates[candidates.length - 1];
}
const cueloDir = resolveCueloDir();
const sdkEntry = path.join(cueloDir, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'src', 'index.ts');
if (!fs.existsSync(sdkEntry)) {
    console.error('omp SDK not found: ' + sdkEntry + '\nSet CUELO_DIR to the CUELO folder (the one with node_modules/@oh-my-pi), for example by starting it with `node install.mjs start`.');
    process.exit(1);
}
const { createAgentSession, SessionManager, AgentRegistry } = await import(pathToFileURL(sdkEntry).href);

fs.mkdirSync(TMP_DIR, { recursive: true });

// sessionPath -> { mtimeMs, size, lastUsed, session, copyPath }
const cache = new Map();

function headerCwd(jsonlPath) {
    try {
        const firstLine = fs.readFileSync(jsonlPath, 'utf8').split('\n', 1)[0];
        const cwd = JSON.parse(firstLine).cwd;
        if (typeof cwd === 'string' && fs.existsSync(cwd)) return cwd;
    } catch {}
    return undefined;
}

/** 세션 파일에서 sessionId 를 얻는다. 헤더 항목이 우선, 없으면 파일명에서 뽑는다. */
function sessionIdOf(jsonlPath) {
    try {
        for (const line of fs.readFileSync(jsonlPath, 'utf8').slice(0, 16384).split('\n')) {
            if (!line.trim()) continue;
            const entry = JSON.parse(line);
            if (entry.type === 'session' && typeof entry.id === 'string') return entry.id;
        }
    } catch {}
    const m = /_([0-9a-f]{8}-[0-9a-f-]+)\.jsonl$/i.exec(path.basename(jsonlPath));
    return m ? m[1] : undefined;
}

/**
 * 사본 위에 새로 만든 AgentSession 은 설정된 default 모델로 복원된다. 메인 세션이 자동
 * 폴백으로 다른 모델에서 돌고 있으면(주 모델 한도 소진 등) 사본은 소진된 모델을 그대로
 * 다시 호출하고, runEphemeralTurn 은 TurnRecovery 를 거치지 않으므로 429 가 그대로
 * 사용자에게 노출된다. 그래서 매 질문 전에 메인의 live state.model 로 맞춘다.
 * 조회나 적용이 실패하면 조용히 기존 모델을 유지한다.
 */
async function syncModelFromMain(session, jsonlPath) {
    const sessionId = sessionIdOf(jsonlPath);
    if (!sessionId) return;
    let live;
    try {
        const res = await fetch(ALLOW_ORIGIN + '/api/agent/' + sessionId, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return;
        live = (await res.json())?.state?.model;
    } catch { return; }
    if (!live || typeof live.provider !== 'string' || typeof live.id !== 'string') return;
    const current = session.model;
    if (current && current.provider === live.provider && current.id === live.id) return;
    const target = session.modelRegistry.find(live.provider, live.id);
    if (!target) return;
    try {
        await session.setModel(target);
    } catch {}
}

// --- 모델 폴백 --------------------------------------------------------------
// runEphemeralTurn 은 TurnRecovery 를 거치지 않으므로 retry.fallbackChains 가 적용되지
// 않는다(TUI /btw 와 같은 한계). 그래서 주 모델 한도가 소진되면 메인 세션은 폴백으로
// 멀쩡히 돌아가는데 사이드채팅만 429 를 그대로 뱉었다. 같은 설정을 직접 읽어 체인을 밟는다.

const CONFIG_PATH = path.join(os.homedir(), '.omp', 'agent', 'config.yml');
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// config.yml 은 omp 재시작 없이 바뀔 수 있으므로 mtime 이 달라질 때만 다시 읽는다.
let chainCache = { mtimeMs: -1, chains: {} };
function fallbackChains() {
    let st;
    try { st = fs.statSync(CONFIG_PATH); } catch { return {}; }
    if (st.mtimeMs !== chainCache.mtimeMs) {
        const chains = {};
        try {
            const raw = Bun.YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))?.retry?.fallbackChains;
            for (const key of Object.keys(raw || {})) {
                if (Array.isArray(raw[key])) chains[key] = raw[key].filter(s => typeof s === 'string');
            }
        } catch {}
        chainCache = { mtimeMs: st.mtimeMs, chains };
    }
    return chainCache.chains;
}

/** omp 와 같은 우선순위: 정확한 모델 키 > provider/* > default. 역할 키는 여기 해당 없음. */
function chainFor(model) {
    if (!model) return [];
    const chains = fallbackChains();
    return chains[model.provider + '/' + model.id] ?? chains[model.provider + '/*'] ?? chains.default ?? [];
}

/**
 * "provider/id" 또는 "provider/id:thinking" 을 나눈다. provider 는 첫 구간이고 나머지가
 * id 다(openrouter/google/x 처럼 id 에 슬래시가 있을 수 있다). thinking 접미사는 레지스트리
 * 조회에 방해되므로 떼어내기만 하고 적용하지는 않는다 — 여기서 필요한 건 모델 교체다.
 */
function parseSelector(selector) {
    let base = selector;
    const colon = selector.lastIndexOf(':');
    // 모델 id 자체에 콜론이 있을 수 있어 알려진 thinking 값일 때만 접미사로 본다.
    if (colon > 0 && THINKING_LEVELS.has(selector.slice(colon + 1))) base = selector.slice(0, colon);
    const slash = base.indexOf('/');
    if (slash < 1 || slash === base.length - 1) return null;
    return { provider: base.slice(0, slash), id: base.slice(slash + 1) };
}

// 모델 교체로 풀릴 만한 실패를 넓게 잡는다. 사이드채팅에서 다른 모델로 한 번 더 시도하는
// 비용은 낮고, 놓치면 사용자에게 429 가 그대로 보인다.
const SWITCH_WORTHY =
    /\b(?:429|402)\b|rate.?limit|usage.?limit|quota|insufficient_quota|resource_exhausted|overloaded|over capacity|too many requests|service unavailable|bad gateway|gateway timeout|internal server error/i;
function isSwitchWorthy(err) {
    const status = err?.status ?? err?.statusCode;
    if (typeof status === 'number' && (status === 429 || status === 402 || status >= 500)) return true;
    return SWITCH_WORTHY.test(String(err?.message || err));
}

/**
 * 현재 모델로 먼저 시도하고, 모델 교체로 풀릴 실패면 체인을 순서대로 밟는다.
 * 이미 화면에 글자가 나간 뒤에는 교체하지 않는다 — 다른 모델로 다시 스트리밍하면 앞서 보낸
 * 내용과 뒤섞인다. TurnRecovery 의 replay-safety 와 같은 판단이다.
 */
async function runTurnWithFallback(session, args, onSwitch) {
    const chain = chainFor(session.model);
    const tried = new Set(session.model ? [session.model.provider + '/' + session.model.id] : []);
    let streamed = false;
    const turnArgs = { ...args, onTextDelta: d => { streamed = true; args.onTextDelta?.(d); } };
    let next = 0;
    for (;;) {
        try {
            return await session.runEphemeralTurn(turnArgs);
        } catch (err) {
            if (args.signal?.aborted || streamed || !isSwitchWorthy(err)) throw err;
            let switched;
            while (next < chain.length && !switched) {
                const parsed = parseSelector(chain[next++]);
                if (!parsed) continue;
                const key = parsed.provider + '/' + parsed.id;
                if (tried.has(key)) continue;
                tried.add(key);
                const model = session.modelRegistry.find(parsed.provider, parsed.id);
                if (!model) continue;
                try {
                    await session.setModel(model);
                    switched = model;
                } catch {}
            }
            if (!switched) throw err;
            onSwitch?.(switched);
        }
    }
}

async function disposeEntry(key, entry) {
    cache.delete(key);
    try { await entry.session.dispose(); } catch {}
    fs.rmSync(entry.copyPath, { force: true });
}

/** Session over a temp copy of the .jsonl; rebuilt when the original changes. */
async function getSession(sessionPath) {
    const st = fs.statSync(sessionPath);
    const hit = cache.get(sessionPath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        hit.lastUsed = Date.now();
        return hit.session;
    }
    if (hit) await disposeEntry(sessionPath, hit);

    const copyPath = path.join(
        TMP_DIR,
        createHash('sha1').update(sessionPath).digest('hex').slice(0, 16) + '.jsonl',
    );
    fs.copyFileSync(sessionPath, copyPath);
    const sessionManager = await SessionManager.open(copyPath, undefined, undefined, {
        suppressBreadcrumb: true,
    });
    const { session } = await createAgentSession({
        cwd: headerCwd(copyPath),
        sessionManager,
        enableMCP: false,
        enableLsp: false,
        enableIrc: false,
        disableExtensionDiscovery: true,
        // Private registry: several cached sessions may coexist in this process.
        agentRegistry: new AgentRegistry(),
    });
    cache.set(sessionPath, { mtimeMs: st.mtimeMs, size: st.size, lastUsed: Date.now(), session, copyPath });
    return session;
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now - entry.lastUsed > IDLE_DISPOSE_MS) void disposeEntry(key, entry);
    }
}, 60_000).unref?.();

/**
 * 사이드챗은 도구가 없고 메인 세션 파일의 사본만 본다. 안내가 없으면 메인인 것처럼 진행 상태를
 * 단정하거나 메인 대신 작업을 약속한다. 그래서 매 질문 앞에 사본 시점과 자기 위치를 알린다.
 */
function buildPromptText(question, history, snapshotAt) {
    const lines = [
        '[사이드챗 안내] 너는 메인 세션의 사본(마지막 기록 ' + snapshotAt.toLocaleString('ko-KR', { hour12: false }) + ')을 읽는 사이드챗이다. '
            + '도구가 없고, 이 시각 이후 메인이 한 일이나 지금 진행 중인 턴은 모른다. '
            + '진행·완료 상태를 말할 때는 "사본 기준"이라고 밝히고 이후 바뀌었을 수 있다고 알린다. '
            + '메인 대신 작업을 약속하거나 한 것처럼 말하지 않는다. 메인이 해야 할 일이면 사용자에게 이 답의 "메인에 보내기"를 권한다.',
        '',
    ];
    if (Array.isArray(history) && history.length > 0) {
        lines.push('(참고: 이 사이드채팅의 이전 문답. 메인 대화 기록에는 없는 내용이다.)');
        for (const turn of history.slice(-6)) {
            if (turn && typeof turn.q === 'string' && typeof turn.a === 'string') {
                lines.push('Q: ' + turn.q, 'A: ' + turn.a, '');
            }
        }
    }
    lines.push(question);
    return lines.join('\n');
}

const CORS = {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
};

function json(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    });
}

async function handleAsk(req) {
    let body;
    try { body = await req.json(); } catch { return json(400, { error: 'invalid JSON body' }); }
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return json(400, { error: 'question required' });
    const resolved = path.resolve(String(body.sessionPath || ''));
    // Only session files under the default agent dir; this is a context loader, not a file reader.
    if (!resolved.toLowerCase().startsWith(SESSIONS_ROOT.toLowerCase() + path.sep) ||
        !resolved.endsWith('.jsonl') || !fs.existsSync(resolved)) {
        return json(400, { error: 'sessionPath must be an existing .jsonl under ' + SESSIONS_ROOT });
    }

    let session;
    try { session = await getSession(resolved); } catch (e) {
        return json(500, { error: 'session load failed: ' + String(e?.message || e) });
    }

    // 메인이 폴백으로 다른 모델에 있으면 사본도 그 모델로 맞춘다(소진된 모델 재호출 방지).
    await syncModelFromMain(session, resolved);

    const promptText = buildPromptText(question, body.history, fs.statSync(resolved).mtime);
    const enc = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const send = obj => { try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\n')); } catch {} };
            try {
                const { replyText } = await runTurnWithFallback(
                    session,
                    {
                        promptText,
                        onTextDelta: d => send({ t: 'd', v: d }),
                        signal: req.signal,
                    },
                    model => send({ t: 'm', v: model.provider + '/' + model.id }),
                );
                send({ t: 'done', v: replyText });
            } catch (e) {
                if (!req.signal.aborted) send({ t: 'err', v: String(e?.message || e) });
            } finally {
                try { controller.close(); } catch {}
            }
        },
    });
    return new Response(stream, {
        headers: { ...CORS, 'Content-Type': 'application/x-ndjson; charset=utf-8' },
    });
}

Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    idleTimeout: 0, // ephemeral turns on big contexts can exceed the 10 s default
    async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        if (url.pathname === '/health') return json(200, { ok: true, cached: cache.size });
        if (url.pathname === '/ask' && req.method === 'POST') return handleAsk(req);
        return json(404, { error: 'not found' });
    },
});
console.log('btw sidecar on http://127.0.0.1:' + PORT + '/ask');
