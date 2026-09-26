// 사이드카: CUELO SUBAGENT 보관 기록 패널용 읽기 전용 백엔드. http://127.0.0.1:30144
//
//   GET /health
//   GET /archive?session=<uuid>
//   GET /transcript?session=<uuid>&name=<subagent>&limit=400
//
// CUELO은 하위 에이전트 스냅샷을 실행 중인 manager 메모리에만 두고, 10분간 유휴 상태가
// 이어지면 manager와 함께 버린다. 끝난 하위 에이전트는 그 뒤 HTTP로 다시 열 수 없지만 JSONL
// 기록은 디스크에 남으므로, 이 서버가 그 파일만 읽어 별도 패널에 제공한다.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.OMP_SUBAGENT_PORT) || 30144;
const ORIGIN = 'http://127.0.0.1:' + (Number(process.env.PORT) || 30141);
const AGENT_DIR_OVERRIDE = String(process.env.PI_CODING_AGENT_DIR || '').trim();
// 상대 경로 override는 launch.ps1의 실행 cwd에 따라 전혀 다른 트리를 조용히 읽을 수 있다.
// omp core와 같은 절대 경로만 받아 resolve하고, 누락·빈 값·상대 경로는 홈 기본값으로 돌린다.
const AGENT_DIR = AGENT_DIR_OVERRIDE && path.isAbsolute(AGENT_DIR_OVERRIDE)
    ? path.resolve(AGENT_DIR_OVERRIDE)
    : path.join(os.homedir(), '.omp', 'agent');
const SESSIONS_DIR = path.join(AGENT_DIR, 'sessions');
const SCAN_CACHE_MS = 5_000;
const ARCHIVE_SCAN_LIMIT = 8 * 1024 * 1024;
const ARCHIVE_LIST_MAX = 60;
const INSPECT_CACHE_MAX = 512;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z0-9._-]{1,120}$/;
const SESSION_DIR_RE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

let scanCache = { at: 0, map: new Map() };
let scanInflight = null;
// 패널이 3초마다 목록을 polling하므로 캐시가 없으면 매번 모든 JSONL을 다시 파싱한다.
const inspectCache = new Map();

function headers() {
    return {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': ORIGIN,
        Vary: 'Origin',
        'Cache-Control': 'no-store',
    };
}

function sendJson(res, status, body) {
    if (res.writableEnded) return;
    res.writeHead(status, headers());
    res.end(JSON.stringify(body));
}

// sessions 바로 아래의 workspace slug와 그 자식만 본다. 부모 transcript JSONL까지 재귀로
// 훑으면 패널 polling 때마다 큰 파일을 다시 만나므로, `<slug>/<stamp>_<id>` 깊이에서 멈춘다.
async function scanSessionDirs() {
    if (Date.now() - scanCache.at < SCAN_CACHE_MS) return scanCache.map;
    if (scanInflight) return scanInflight;
    scanInflight = (async function () {
        const map = new Map();
        let slugs;
        try {
            slugs = await fs.promises.readdir(SESSIONS_DIR, { withFileTypes: true });
        } catch (e) {
            if (e && e.code === 'ENOENT') {
                scanCache = { at: Date.now(), map: map };
                return map;
            }
            throw e;
        }
        await Promise.all(slugs.filter(function (entry) {
            return entry.isDirectory();
        }).map(async function (slug) {
            const slugDir = path.join(SESSIONS_DIR, slug.name);
            let children;
            try {
                children = await fs.promises.readdir(slugDir, { withFileTypes: true });
            } catch (e) {
                if (e && e.code === 'ENOENT') return;
                throw e;
            }
            children.forEach(function (entry) {
                if (!entry.isDirectory()) return;
                const match = entry.name.match(SESSION_DIR_RE);
                if (match) map.set(match[1].toLowerCase(), path.resolve(slugDir, entry.name));
            });
        }));
        scanCache = { at: Date.now(), map: map };
        return map;
    })();
    try {
        return await scanInflight;
    } finally {
        scanInflight = null;
    }
}

async function resolveSessionDir(sessionId) {
    const map = await scanSessionDirs();
    return map.get(sessionId.toLowerCase()) || null;
}

// readline 모듈 없이 stream chunk의 끝 조각만 보관한다. 깨진 한 줄은 건너뛰고 나머지
// 레코드를 계속 읽어, 쓰다 중단된 JSONL 하나 때문에 전체 보관 목록이 사라지지 않게 한다.
function streamRecords(file, onRecord) {
    return new Promise(function (resolve, reject) {
        const input = fs.createReadStream(file, { encoding: 'utf8' });
        let carry = '';
        function consume(line) {
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (!line) return;
            try {
                onRecord(JSON.parse(line));
            } catch (_) {
                // 부분 기록 또는 예전 형식 한 줄만 버린다.
            }
        }
        input.on('data', function (chunk) {
            carry += chunk;
            let newline = carry.indexOf('\n');
            while (newline !== -1) {
                consume(carry.slice(0, newline));
                carry = carry.slice(newline + 1);
                newline = carry.indexOf('\n');
            }
        });
        input.on('end', function () {
            consume(carry);
            resolve();
        });
        input.on('error', reject);
    });
}

function partPlaceholder(part) {
    const rawType = String(part && part.type || 'part');
    const type = rawType.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (type.indexOf('image') !== -1) return '[image]';
    if (type === 'toolcall' || type === 'tool_call' || type === 'tooluse' || type === 'tool_use') {
        const name = part && (part.name || part.toolName);
        return name ? '[tool_use: ' + name + ']' : '[tool_use]';
    }
    if (type === 'toolresult' || type === 'tool_result') return '[tool_result]';
    if (type === 'thinking' || type === 'reasoning') return '[' + type + ']';
    return '[' + type + ']';
}

function flattenContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(function (part) {
        if (typeof part === 'string') return part;
        if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
        return partPlaceholder(part);
    }).join('\n');
}

function messageBody(record) {
    return record && record.message && typeof record.message === 'object' ? record.message : record;
}

function recordText(record) {
    if (record.type === 'message') {
        const body = messageBody(record);
        if (body && body.content !== undefined) return flattenContent(body.content);
        if (body && typeof body.text === 'string') return body.text;
        return '';
    }
    const data = record.data || {};
    if (record.customType === 'tool_execution_start') {
        return data.toolName ? '[tool_use: ' + data.toolName + ']' : '[tool_use]';
    }
    if (record.customType === 'tool_execution_end') return '[tool_result]';
    if (record.content !== undefined) return flattenContent(record.content);
    if (typeof record.text === 'string') return record.text;
    return record.customType ? '[' + record.customType + ']' : '[custom]';
}

function normalizeRole(record) {
    const body = messageBody(record) || {};
    const raw = String(body.role || record.role || 'system').toLowerCase();
    if (raw === 'user' || raw === 'assistant' || raw === 'system') return raw;
    if (raw === 'tool' || raw === 'toolresult' || raw === 'tool_result') return 'tool';
    return 'system';
}

function recordTime(record) {
    // 실측 JSONL의 레코드 시각 필드는 `timestamp`이며 ISO 문자열이다.
    if (record.timestamp === undefined || record.timestamp === null) return null;
    const value = typeof record.timestamp === 'number' ? record.timestamp : Date.parse(record.timestamp);
    return Number.isFinite(value) ? Math.trunc(value) : null;
}

function capText(text) {
    text = String(text || '').trim();
    return text.length > 4000 ? text.slice(0, 3999) + '…' : text;
}

function archiveTask(record) {
    if (!record || record.type !== 'message' || normalizeRole(record) !== 'user') return null;
    return recordText(record).replace(/\s+/g, ' ').trim().slice(0, 200);
}

var TASK_GUARD_FIELD_LINE = /^[\t ]*(?:WORK_CLASS|PURPOSE|BLOCKS_PRIMARY|PRIMARY_DELIVERABLE|OWNED_PATHS|FINDING_ID)[\t ]*:[^\r\n]*$/i;

function archiveTaskTitle(record) {
    if (!record || record.type !== 'message' || normalizeRole(record) !== 'user') return null;
    var text = recordText(record);
    var marker = /^\s*TASK_GUARD\s*:\s*$/im.exec(text);
    if (marker) {
        var cursor = marker.index + marker[0].length;
        if (text[cursor] === '\r') cursor += 1;
        if (text[cursor] === '\n') cursor += 1;
        var blockEnd = cursor;
        while (cursor < text.length) {
            var newline = text.indexOf('\n', cursor);
            var physicalEnd = newline === -1 ? text.length : newline;
            var contentEnd = physicalEnd > cursor && text[physicalEnd - 1] === '\r'
                ? physicalEnd - 1
                : physicalEnd;
            if (!TASK_GUARD_FIELD_LINE.test(text.slice(cursor, contentEnd))) break;
            blockEnd = contentEnd;
            cursor = newline === -1 ? text.length : newline + 1;
        }
        var lead = marker[0].length - marker[0].trimStart().length;
        text = text.slice(0, marker.index + lead) + text.slice(blockEnd);
    }
    var values = Array.from(text.matchAll(/^\s*TASK_TITLE\s*:\s*(.*?)\s*$/gim), function (match) {
        return match[1] || '';
    });
    return values.length === 1 && values[0] && values[0] === values[0].trim() && /[가-힣]/u.test(values[0])
        ? values[0]
        : null;
}

// 관측된 기록만 그대로 올린다. child JSONL 의 실측 형태는
//   {"type":"model_change","model":"anthropic/claude-opus-5","resolvedModelIsFallback":false}
//   {"type":"thinking_level_change","thinkingLevel":"medium","configured":null}
// 이며 `thinkingLevel` 이 실제 적용값, `configured` 는 요청값이라 표시에 쓰지 않는다.
// 예전 형식의 `provider`/`modelId` 쌍도 같은 의미이므로 함께 읽는다.
function recordModel(record) {
    if (typeof record.model === 'string' && record.model.trim()) return record.model.trim();
    const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
    const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';
    if (modelId) return provider ? provider + '/' + modelId : modelId;
    return null;
}

async function inspectArchiveFile(file, stat) {
    let messages = 0;
    let firstTask = '';
    let taskTitle = '';
    let foundTask = false;
    let model = null;
    let modelIsFallback = null;
    let thinkingLevel = null;
    // 종료 상태는 마지막 실행 세대의 기록된 사실만으로 복원한다. 새 user 메시지나
    // irc 수신이 오면 새 실행이 시작된 것이므로 이전 세대의 exit·error·yield 표시를
    // 지운다 - 재개 뒤 중단된 실행이 옛 session_exit 때문에 completed로 둥글리지 않게.
    // 어느 근거도 없으면 status는 null(미확인)이며 completed/aborted로 추정하지 않는다.
    let lastStopReason = null;
    let lastErrorMessage = null;
    let sawSessionExit = false;
    let sawYieldResult = false;
    let sawAbnormalExit = false;
    // 패널은 polling하므로 거대한 transcript를 매번 세면 디스크와 CPU를 계속 점유한다.
    // 8MB 초과 파일도 존재와 크기는 보이되, 상세 통계는 사용자가 열 때만 읽게 한다.
    if (stat.size <= ARCHIVE_SCAN_LIMIT) {
        await streamRecords(file, function (record) {
            if (!record) return;
            if (record.type === 'message') {
                messages += 1;
                const body = messageBody(record);
                if (body && body.role === 'user') {
                    // 새 user 입력은 새 실행 세대의 시작이다 - 이전 세대의 종료 표시를 지운다.
                    lastStopReason = null;
                    lastErrorMessage = null;
                    sawSessionExit = false;
                    sawYieldResult = false;
                    sawAbnormalExit = false;
                }
                if (body && body.role === 'assistant') {
                    // 마지막 assistant의 값이 이 세대의 결론이다 - 성공 뒤에 옛 errorMessage가
                    // 남지 않게 매번 덮어쓴다.
                    lastStopReason = typeof body.stopReason === 'string' && body.stopReason ? body.stopReason : null;
                    lastErrorMessage = typeof body.errorMessage === 'string' && body.errorMessage ? body.errorMessage : null;
                }
                // yield 결과가 실패(isError)면 성공 근거로 세지 않는다.
                if (body && body.role === 'toolResult' && body.toolName === 'yield' && body.isError !== true) {
                    sawYieldResult = true;
                }
            }
            if (record.type === 'custom_message' && record.customType === 'irc:incoming') {
                // 부모의 새 지시가 도착한 것도 새 실행 세대다.
                lastStopReason = null;
                lastErrorMessage = null;
                sawSessionExit = false;
                sawYieldResult = false;
                sawAbnormalExit = false;
            }
            if (record.type === 'custom' && record.customType === 'session_exit') {
                const kind = record.data && record.data.kind;
                if (kind === 'normal') sawSessionExit = true;
                else sawAbnormalExit = true;
            }
            if (record.type === 'model_change') {
                const next = recordModel(record);
                // 마지막 전환이 실제로 쓰인 모델이다.
                if (next) {
                    model = next;
                    modelIsFallback = record.resolvedModelIsFallback === true;
                }
            }
            if (record.type === 'thinking_level_change' && typeof record.thinkingLevel === 'string' && record.thinkingLevel.trim()) {
                thinkingLevel = record.thinkingLevel.trim();
            }
            if (!foundTask) {
                const task = archiveTask(record);
                if (task !== null) {
                    taskTitle = archiveTaskTitle(record) || '';
                    firstTask = task;
                    foundTask = true;
                }
            }
        });
    } else {
        messages = null;
    }
    let status = null;
    if (messages !== null) {
        // 실제로 기록된 실패·중단이 성공 표시보다 우선한다.
        if (lastStopReason === 'error') status = 'failed';
        else if (lastStopReason === 'aborted' || sawAbnormalExit) status = 'aborted';
        else if (sawSessionExit || sawYieldResult) status = 'completed';
        // 그 외는 미확인(null) - 추정으로 completed/aborted를 만들지 않는다.
    }
    return {
        messages: messages,
        firstTask: firstTask,
        taskTitle: taskTitle,
        model: model,
        modelIsFallback: modelIsFallback,
        thinkingLevel: thinkingLevel,
        status: status,
        stopReason: lastStopReason,
        errorMessage: lastErrorMessage,
    };
}

// `__advisor` 처럼 basename 이 `__` 로 시작하는 JSONL 은 코어가 만드는 내부 감시 기록이고
// CUELO 의 실시간 Subagent 목록에도 없다. 사용자 목록과 어긋나지 않게 여기서도 뺀다.
function isInternalChild(name) {
    return name.indexOf('__') === 0;
}

async function buildArchive(sessionId, dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue;
        if (isInternalChild(entry.name)) continue;
        const file = path.resolve(dir, entry.name);
        const stat = await fs.promises.stat(file);
        files.push({ file: file, stat: stat });
    }
    files.sort(function (a, b) { return b.stat.mtimeMs - a.stat.mtimeMs; });

    const listTruncated = files.length > ARCHIVE_LIST_MAX;
    const subagents = [];
    for (const candidate of files.slice(0, ARCHIVE_LIST_MAX)) {
        const file = candidate.file;
        const stat = candidate.stat;
        let inspected = inspectCache.get(file);
        if (!inspected || inspected.size !== stat.size || inspected.mtimeMs !== stat.mtimeMs) {
            const result = await inspectArchiveFile(file, stat);
            inspected = {
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                messages: result.messages,
                firstTask: result.firstTask,
                taskTitle: result.taskTitle,
                model: result.model,
                modelIsFallback: result.modelIsFallback,
                thinkingLevel: result.thinkingLevel,
                status: result.status,
                stopReason: result.stopReason,
                errorMessage: result.errorMessage,
            };
            inspectCache.delete(file);
            inspectCache.set(file, inspected);
            while (inspectCache.size > INSPECT_CACHE_MAX) {
                inspectCache.delete(inspectCache.keys().next().value);
            }
        }
        subagents.push({
            name: path.basename(file).replace(/\.jsonl$/i, ''),
            bytes: stat.size,
            modified: Math.trunc(stat.mtimeMs),
            messages: inspected.messages,
            firstTask: inspected.firstTask,
            ...(inspected.taskTitle ? { taskTitle: inspected.taskTitle } : {}),
            model: inspected.model,
            modelIsFallback: inspected.modelIsFallback,
            thinkingLevel: inspected.thinkingLevel,
            status: inspected.status,
            stopReason: inspected.stopReason,
            errorMessage: inspected.errorMessage,
        });
    }
    const archive = { sessionId: sessionId, dir: dir, found: true, subagents: subagents };
    if (listTruncated) archive.listTruncated = true;
    return archive;
}

function childFile(dir, name) {
    const root = path.resolve(dir) + path.sep;
    const file = path.resolve(dir, name + '.jsonl');
    // Windows 경로는 대소문자를 구분하지 않으므로 비교도 같은 규칙으로 한다.
    if (!file.toLowerCase().startsWith(root.toLowerCase())) return null;
    return file;
}

// 발화 복원에 필요한 assistant 본문만 남긴다 - text 블록과 최종 보고를 싣는 yield 호출.
// thinking·이미지·다른 도구 호출은 대화창 발화의 근거가 아니므로 payload에서 뺀다.
// JSONL의 toolCall 블록은 {id, name, arguments} 형태이고 웹은 {toolName, input}을 읽으므로
// 여기서 그 모양으로 옮긴다.
function archiveAssistantMessage(body) {
    const parts = [];
    const content = Array.isArray(body.content) ? body.content : [];
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
            parts.push({ type: 'text', text: capText(part.text) });
        } else if (part.type === 'toolCall' && part.name === 'yield') {
            // 소비자는 input.data(문자열 또는 {report})만 읽는다 - 나머지 구조 payload는
            // 크기 제약을 우회하므로 보내지 않고, 문자열도 기존 cap에 맞춘다.
            const args = part.arguments && typeof part.arguments === 'object' ? part.arguments : {};
            const data = typeof args.data === 'string'
                ? capText(args.data)
                : (args.data && typeof args.data === 'object' && typeof args.data.report === 'string'
                    ? { report: capText(args.data.report) }
                    : args.data);
            parts.push({
                type: 'toolCall',
                toolCallId: typeof part.id === 'string' ? part.id : '',
                toolName: 'yield',
                input: { data: data },
            });
        }
    }
    const message = {
        role: 'assistant',
        content: parts,
        model: typeof body.model === 'string' ? body.model : '',
        provider: typeof body.provider === 'string' ? body.provider : '',
    };
    if (typeof body.credentialId === 'number') message.credentialId = body.credentialId;
    if (typeof body.stopReason === 'string' && body.stopReason) message.stopReason = body.stopReason;
    if (typeof body.errorMessage === 'string' && body.errorMessage) message.errorMessage = capText(body.errorMessage);
    return message;
}

async function buildTranscript(sessionId, dir, name, limit) {
    if (isInternalChild(name)) {
        const internal = new Error('내부 기록은 제공하지 않는다');
        internal.statusCode = 400;
        throw internal;
    }
    const file = childFile(dir, name);
    if (!file) {
        const error = new Error('subagent 경로가 session 디렉터리 밖이다');
        error.statusCode = 400;
        throw error;
    }
    let stat;
    try {
        stat = await fs.promises.stat(file);
        if (!stat.isFile()) throw Object.assign(new Error('child file not found'), { code: 'ENOENT' });
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            const missing = new Error('subagent transcript를 찾을 수 없다');
            missing.statusCode = 404;
            throw missing;
        }
        throw e;
    }

    const kept = [];
    let start = 0;
    let total = 0;
    await streamRecords(file, function (record) {
        if (!record || (record.type !== 'message' && record.type !== 'custom' && record.type !== 'custom_message')) return;
        total += 1;
        const entry = {
            role: normalizeRole(record),
            kind: record.type === 'message' ? 'message' : 'custom',
            text: capText(recordText(record)),
            at: recordTime(record),
        };
        // 발화 복원은 text 자리표시자가 아니라 실제 본문이 필요하다. assistant 는
        // text/yield 만 남긴 메시지를, irc:incoming 은 발신자와 본문을 함께 실어 보낸다.
        if (record.type === 'message' && normalizeRole(record) === 'assistant') {
            entry.message = archiveAssistantMessage(messageBody(record));
        }
        if (record.type === 'custom_message' && record.customType === 'irc:incoming' && record.details && typeof record.details === 'object') {
            const details = record.details;
            const rawFrom = typeof details.from === 'string' ? details.from : '';
            const rawMessage = typeof details.message === 'string' ? details.message : '';
            // 본문이 cap을 넘어 잘리면 부모 send와의 정확한 매칭이 불가하다 - 잘렸음을
            // 표시해 소비자가 잘린 본문으로 잘못 잇지 않게 한다.
            entry.irc = {
                from: capText(rawFrom),
                message: capText(rawMessage),
            };
            if (rawMessage.trim().length > 4000) entry.irc.truncated = true;
        }
        kept.push(entry);
        if (kept.length - start > limit) start += 1;
        // 기본 limit 400에서 오래된 배열 칸을 무한히 붙들지 않도록 가끔 압축한다.
        if (start > limit && start > 1024) {
            kept.splice(0, start);
            start = 0;
        }
    });
    const entries = kept.slice(start);
    return {
        sessionId: sessionId,
        name: name,
        bytes: stat.size,
        truncated: total > entries.length,
        entries: entries,
    };
}

function badSession(url) {
    const sessionId = url.searchParams.get('session');
    return sessionId && SESSION_RE.test(sessionId) ? null : 'session UUID가 올바르지 않다';
}

async function handleRequest(req, res) {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== ORIGIN) {
        return sendJson(res, 403, { error: 'origin 이 허용되지 않는다' });
    }
    if (req.method !== 'GET') return sendJson(res, 404, { error: 'not found' });

    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, port: PORT });

    if (url.pathname === '/archive' || url.pathname === '/transcript') {
        const sessionError = badSession(url);
        if (sessionError) return sendJson(res, 400, { error: sessionError });
        const sessionId = url.searchParams.get('session');
        let name = null;
        let limit = 400;
        if (url.pathname === '/transcript') {
            name = url.searchParams.get('name');
            if (!name || !NAME_RE.test(name)) {
                return sendJson(res, 400, { error: 'subagent name이 올바르지 않다' });
            }
            const rawLimit = url.searchParams.get('limit');
            limit = rawLimit === null ? 400 : Number(rawLimit);
            if (!Number.isSafeInteger(limit) || limit < 1) {
                return sendJson(res, 400, { error: 'limit가 올바르지 않다' });
            }
        }

        const dir = await resolveSessionDir(sessionId);
        if (!dir) return sendJson(res, 404, { error: 'session 디렉터리를 찾을 수 없다' });
        if (url.pathname === '/archive') {
            return sendJson(res, 200, await buildArchive(sessionId, dir));
        }
        return sendJson(res, 200, await buildTranscript(sessionId, dir, name, limit));
    }

    return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(function (req, res) {
    handleRequest(req, res).catch(function (e) {
        const status = e && e.statusCode || (e && e.code === 'ENOENT' ? 404 : 500);
        sendJson(res, status, { error: String(e && e.message || e) });
    });
});

server.listen(PORT, '127.0.0.1', function () {
    console.log('subagent sidecar on http://127.0.0.1:' + PORT + '/archive');
});
