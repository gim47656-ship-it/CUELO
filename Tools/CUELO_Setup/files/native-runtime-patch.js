'use strict';

const fs = require('fs');
const path = require('path');

const DISPLAY_RE = /function (\w+)\((\w+)\)\{let (\w+)=\2\.default;if\(!\3\)return null;/;
const DISPLAY_DONE = /function \w+\((\w+)\)\{let \w+=\1\.fallback\?\?\1\.default;if\(!\w+\)return null;/;
const MEMORY_RE = /(const phase1Model = await resolveMemoryModel\(\{[^}]*?fallbackRole: ")default(")/;
const MEMORY_DONE = /const phase1Model = await resolveMemoryModel\(\{[^}]*?fallbackRole: "smol"/;
const EXPECTED = {
    name: 'cuelo',
    version: '0.5.0',
    distribution: 'cuelo',
    coreVersion: '18.3.2',
};

// OMP core 18.3.2 `src/sdk.ts`: session-scoped AsyncJobManager for a process
// that hosts several top-level sessions (CUELO opens one per browser session).
// Upstream lets only the first top-level session construct a manager; every
// later one got `asyncJobManager: undefined`, so its `task` calls logged
// "no AsyncJobManager registered; falling back to sync execution" and blocked
// the prompt until the subagent finished. Sharing the first manager is not a
// fix: it is disposed with its owning session (CUELO idle-shuts sessions
// after 10 minutes) and would cancel every other session's jobs, and a
// disposed manager throws on the next register(). Each edit is an exact text
// anchor of the pristine 18.3.2 source (also present after core patch #191) and fails closed when it drifts.
// `insertBefore` edits keep their anchor (the helper is inserted in front of
// it), so their anchor count stays 1 after patching.
const SDK_FILE = path.join('node_modules', '@oh-my-pi', 'pi-coding-agent', 'src', 'sdk.ts');
const SDK_HELPER = [
    '/**',
    ' * CUELO: session-scoped async job managers for a host that keeps several',
    ' * top-level sessions in one process (CUELO opens one per browser session).',
    ' *',
    ' * Upstream lets only the first top-level session construct a manager and',
    ' * leaves every later top-level session without one, so their `task` calls fell',
    ' * back to blocking execution ("no AsyncJobManager registered"). Sharing the',
    ' * first manager is not an option either: it is disposed with its owning session',
    ' * and would cancel every other session\'s jobs. Instead every top-level session',
    ' * owns a manager that its own dispose tears down; the first one is adopted as',
    ' * the process singleton atomically here and never re-installed by a later',
    ' * session, so the fallback below stays stable. Subagents inherit the manager of',
    ' * the parent that spawned them, resolved through the agent registry by',
    ' * `parentAgentId`, so a child\'s jobs live and die with its own root session;',
    ' * orphaned or revived children without a live parent keep the singleton',
    ' * fallback.',
    ' */',
    'export function resolveSessionAsyncJobManager(',
    '\toptions: Pick<CreateAgentSessionOptions, "parentTaskPrefix" | "parentAgentId">,',
    '\tagentRegistry: AgentRegistry,',
    '\tmaxRunningJobs: number | (() => number),',
    '): { owned: AsyncJobManager | undefined; scoped: AsyncJobManager | undefined } {',
    '\tif (options.parentTaskPrefix) {',
    '\t\tconst parentManager = options.parentAgentId',
    '\t\t\t? agentRegistry.get(options.parentAgentId)?.session?.asyncJobManager',
    '\t\t\t: undefined;',
    '\t\treturn { owned: undefined, scoped: parentManager ?? AsyncJobManager.instance() };',
    '\t}',
    '\tconst owned = new AsyncJobManager({ maxRunningJobs });',
    '\tif (!AsyncJobManager.instance()) AsyncJobManager.setInstance(owned);',
    '\treturn { owned, scoped: owned };',
    '}',
    '',
].join('\n');
const SDK_EDITS = [
    {
        key: 'sessionAsyncHelper',
        label: 'sdk.ts resolveSessionAsyncJobManager helper',
        insertBefore: true,
        anchor: '/**\n * Create an AgentSession with the specified options.\n',
        marker: 'export function resolveSessionAsyncJobManager(',
        patched: SDK_HELPER + '/**\n * Create an AgentSession with the specified options.\n',
    },
    {
        key: 'sessionAsyncOwnership',
        label: 'sdk.ts per-session AsyncJobManager ownership',
        anchor: [
            '\t// Only the first top-level session in a process owns an AsyncJobManager.',
            '\t// Subagents inherit the parent\'s manager via `AsyncJobManager.instance()`',
            '\t// (set below), and any additional top-level session spun up in-process',
            '\t// (e.g. the agent-creation architect in `agents-hub-deps.ts`) must share',
            '\t// the live singleton \u2014 otherwise its dispose path would clobber the',
            '\t// owning session\'s manager and break the `task`/`bash` async paths',
            '\t// (issue #1923). The `instance()` guard means later sessions also skip',
            '\t// constructing an orphaned manager that nothing would ever route to.',
            '\t// Delivery is owner-routed: every AgentSession registers its own sink',
            '\t// (see session/async-job-delivery.ts), so the manager takes no default',
            '\t// onJobComplete here.',
            '\tconst asyncJobManager =',
            '\t\t!options.parentTaskPrefix && !AsyncJobManager.instance()',
            '\t\t\t? new AsyncJobManager({',
            '\t\t\t\t\t// Re-read per capacity check so `async.maxJobs` resizes the cap live.',
            '\t\t\t\t\tmaxRunningJobs: () => Math.min(100, cfgAsyncMaxJobs.get(settings)),',
            '\t\t\t\t})',
            '\t\t\t: undefined;',
            '',
            '\tconst scopedAsyncJobManager = asyncJobManager ?? (options.parentTaskPrefix ? AsyncJobManager.instance() : undefined);',
            '',
            '\tconst agentRegistry = options.agentRegistry ?? AgentRegistry.global();',
            '',
        ].join('\n'),
        marker: '} = resolveSessionAsyncJobManager(',
        patched: [
            '\t// Delivery is owner-routed: every AgentSession registers its own sink',
            '\t// (see session/async-job-delivery.ts), so the manager takes no default',
            '\t// onJobComplete here. Ownership and inheritance: resolveSessionAsyncJobManager.',
            '\tconst agentRegistry = options.agentRegistry ?? AgentRegistry.global();',
            '\tconst { owned: asyncJobManager, scoped: scopedAsyncJobManager } = resolveSessionAsyncJobManager(',
            '\t\toptions,',
            '\t\tagentRegistry,',
            '\t\t// Re-read per capacity check so `async.maxJobs` resizes the cap live.',
            '\t\t() => Math.min(100, cfgAsyncMaxJobs.get(settings)),',
            '\t);',
            '',
        ].join('\n'),
    },
    {
        key: 'sessionAsyncToolSession',
        label: 'sdk.ts ToolSession asyncJobManager comment',
        anchor: [
            '\t\t\t// Subagents inherit the singleton (the parent\'s manager) so their bash/task',
            '\t\t\t// completions still flow into the spawning conversation\'s yieldQueue.',
            '\t\t\t// Secondary in-process top-level sessions (no parentTaskPrefix, no',
            '\t\t\t// constructed manager because the singleton was already installed) leave',
            '\t\t\t// this undefined so tools and session job snapshots refuse async work',
            '\t\t\t// instead of silently routing into the owning session (issue #1923).',
            '\t\t\tasyncJobManager: scopedAsyncJobManager,',
            '',
        ].join('\n'),
        marker: '// Session-scoped: a top-level session\'s own manager',
        patched: [
            '\t\t\t// Session-scoped: a top-level session\'s own manager, or for subagents the',
            '\t\t\t// manager of the root session that spawned them (see',
            '\t\t\t// resolveSessionAsyncJobManager), so bash/task completions flow into their',
            '\t\t\t// own conversation and never into another session\'s.',
            '\t\t\tasyncJobManager: scopedAsyncJobManager,',
            '',
        ].join('\n'),
    },
    {
        key: 'sessionAsyncSingleton',
        label: 'sdk.ts first-top-level-only singleton adoption',
        anchor: '\t\t\tif (asyncJobManager) AsyncJobManager.setInstance(asyncJobManager);\n',
        marker: '// Process singleton adoption happened in resolveSessionAsyncJobManager',
        patched: '\t\t\t// Process singleton adoption happened in resolveSessionAsyncJobManager (first top-level only).\n',
    },
];

function parseArgs(argv) {
    let target = null;
    let output = null;
    let check = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--check') check = true;
        else if (arg === '--target' && i + 1 < argv.length) target = argv[++i];
        else if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
        else if (arg === '--output' && i + 1 < argv.length) output = argv[++i];
        else if (arg.startsWith('--output=')) output = arg.slice('--output='.length);
        else throw new Error('unknown or incomplete argument: ' + arg);
    }
    if (!target) throw new Error('--target requires a native CUELO package directory');
    return { target: path.resolve(target), output: output && path.resolve(output), check };
}

function count(text, re) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    return (text.match(new RegExp(re.source, flags)) || []).length;
}

function readNativePackage(target) {
    const packageFile = path.join(target, 'package.json');
    if (!fs.existsSync(packageFile)) throw new Error('native CUELO package not found: ' + target);
    const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8').replace(/^\uFEFF/, ''));
    const build = packageJson.cueloBuild;
    if (packageJson.name !== EXPECTED.name || packageJson.version !== EXPECTED.version) {
        throw new Error(`unexpected native package ${packageJson.name}@${packageJson.version}`);
    }
    if (!build || build.distribution !== EXPECTED.distribution || build.coreVersion !== EXPECTED.coreVersion) {
        throw new Error('native cueloBuild metadata does not match cuelo / core 18.3.2');
    }
    return packageJson;
}

function inspect(target, expectPatched) {
    const errors = [];
    const writes = [];
    const chunkDirectory = path.join(target, '.next', 'server', 'chunks');
    const displayHits = [];
    if (!fs.existsSync(chunkDirectory)) {
        errors.push('MISSING native server chunks: ' + chunkDirectory);
    } else {
        for (const name of fs.readdirSync(chunkDirectory).sort()) {
            if (!name.endsWith('.js')) continue;
            const file = path.join(chunkDirectory, name);
            const text = fs.readFileSync(file, 'utf8');
            const patched = count(text, DISPLAY_DONE);
            const raw = count(text, DISPLAY_RE);
            if (patched || raw) displayHits.push({ file, name, text, patched, raw });
        }
    }
    const displayPatched = displayHits.reduce((total, hit) => total + hit.patched, 0);
    const displayRaw = displayHits.reduce((total, hit) => total + hit.raw, 0);
    if (expectPatched) {
        if (displayPatched !== 1 || displayRaw !== 0) {
            errors.push(`FALLBACK DISPLAY patched/raw count ${displayPatched}/${displayRaw}, expected 1/0`);
        }
    } else if (displayPatched + displayRaw !== 1) {
        errors.push(`FALLBACK DISPLAY anchor count ${displayPatched + displayRaw}, expected exactly 1`);
    } else if (displayRaw === 1) {
        const hit = displayHits.find(candidate => candidate.raw === 1);
        writes.push({
            file: hit.file,
            text: hit.text.replace(DISPLAY_RE, 'function $1($2){let $3=$2.fallback??$2.default;if(!$3)return null;'),
            label: 'fallback model display (' + hit.name + ')',
        });
    }

    const memoryFile = path.join(target, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'src', 'memories', 'index.ts');
    let memoryPatched = 0;
    let memoryRaw = 0;
    if (!fs.existsSync(memoryFile)) {
        errors.push('MISSING memory phase1 source: ' + memoryFile);
    } else {
        const text = fs.readFileSync(memoryFile, 'utf8');
        memoryPatched = count(text, MEMORY_DONE);
        memoryRaw = count(text, MEMORY_RE);
        if (expectPatched) {
            if (memoryPatched !== 1 || memoryRaw !== 0) {
                errors.push(`MEMORY PHASE1 patched/raw count ${memoryPatched}/${memoryRaw}, expected 1/0`);
            }
        } else if (memoryPatched + memoryRaw !== 1) {
            errors.push(`MEMORY PHASE1 anchor count ${memoryPatched + memoryRaw}, expected exactly 1`);
        } else if (memoryRaw === 1) {
            writes.push({
                file: memoryFile,
                text: text.replace(MEMORY_RE, '$1smol$2'),
                label: 'memory phase1 fallbackRole=smol',
            });
        }
    }

    const sdkChecks = inspectSdk(target, expectPatched, errors, writes);

    return {
        errors,
        writes,
        checks: {
            fallbackModelDisplay: { patched: displayPatched, raw: displayRaw, expectedPatched: 1, expectedRaw: 0 },
            memoryPhase1Smol: { patched: memoryPatched, raw: memoryRaw, expectedPatched: 1, expectedRaw: 0 },
            ...sdkChecks,
        },
    };
}

function occurrences(text, needle) {
    return text.split(needle).length - 1;
}

// All sdk.ts edits are applied to one text in sequence and written once. Each edit
// must find its anchor exactly once (pristine) or its marker exactly once
// (patched); any other count is a drift of the pinned core and fails closed.
function inspectSdk(target, expectPatched, errors, writes) {
    const sdkFile = path.join(target, SDK_FILE);
    const checks = {};
    if (!fs.existsSync(sdkFile)) {
        errors.push('MISSING core sdk source: ' + sdkFile);
        for (const edit of SDK_EDITS) {
            checks[edit.key] = { patched: 0, raw: 0, expectedPatched: 1, expectedRaw: edit.insertBefore ? 1 : 0 };
        }
        return checks;
    }
    const original = fs.readFileSync(sdkFile, 'utf8');
    let text = original;
    for (const edit of SDK_EDITS) {
        const patched = occurrences(text, edit.marker);
        const raw = occurrences(text, edit.anchor);
        const expectedRaw = edit.insertBefore ? 1 : 0;
        checks[edit.key] = { patched, raw, expectedPatched: 1, expectedRaw };
        if (expectPatched) {
            if (patched !== 1 || raw !== expectedRaw) {
                errors.push(`SDK ${edit.key} patched/raw count ${patched}/${raw}, expected 1/${expectedRaw}`);
            }
            continue;
        }
        if (patched === 1 && raw === expectedRaw) continue;
        if (patched !== 0 || raw !== 1) {
            errors.push(`SDK ${edit.key} anchor/marker count ${raw}/${patched}, expected exactly 1/0`);
            continue;
        }
        text = text.replace(edit.anchor, () => edit.patched);
    }
    if (!expectPatched && text !== original) {
        writes.push({ file: sdkFile, text, label: 'sdk.ts session-scoped AsyncJobManager' });
    }
    return checks;
}

function reportErrors(errors) {
    for (const error of errors) console.error(error);
}

function evidence(target, checks, ok) {
    return {
        schemaVersion: 1,
        checkedAt: new Date().toISOString(),
        target,
        mode: 'native-runtime',
        checks,
        ok,
    };
}

function writeEvidence(file, value) {
    if (file) fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function run(argv) {
    const options = parseArgs(argv);
    readNativePackage(options.target);
    if (options.check) {
        const result = inspect(options.target, true);
        writeEvidence(options.output, evidence(options.target, result.checks, result.errors.length === 0));
        reportErrors(result.errors);
        if (result.errors.length) throw new Error('native runtime compatibility check failed');
        console.log('CHECK OK: native fallback display, memory phase1 smol and sdk session async scope counts are exact at ' + options.target);
        return;
    }

    const plan = inspect(options.target, false);
    reportErrors(plan.errors);
    if (plan.errors.length) throw new Error('native runtime compatibility anchors are not exact');
    for (const write of plan.writes) {
        fs.writeFileSync(write.file, write.text);
        console.log('patched: ' + write.label);
    }
    const checked = inspect(options.target, true);
    writeEvidence(options.output, evidence(options.target, checked.checks, checked.errors.length === 0));
    reportErrors(checked.errors);
    if (checked.errors.length) throw new Error('native runtime compatibility verification failed after apply');
    console.log('done: native runtime compatibility transformations verified at ' + options.target);
}

try {
    run(process.argv.slice(2));
} catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
}
