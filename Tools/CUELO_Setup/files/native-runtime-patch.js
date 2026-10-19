'use strict';

const fs = require('fs');
const path = require('path');

const DISPLAY_RE = /function (\w+)\((\w+)\)\{let (\w+)=\2\.default;if\(!\3\)return null;/;
const DISPLAY_DONE = /function \w+\((\w+)\)\{let \w+=\1\.fallback\?\?\1\.default;if\(!\w+\)return null;/;
const MEMORY_RE = /(const phase1Model = await resolveMemoryModel\(\{[^}]*?fallbackRole: ")default(")/;
const MEMORY_DONE = /const phase1Model = await resolveMemoryModel\(\{[^}]*?fallbackRole: "smol"/;
const EXPECTED = {
    name: 'cuelo',
    version: '0.10.36',
    distribution: 'cuelo',
    coreVersion: '18.12.2',
};

// OMP core `src/sdk.ts`: session-scoped AsyncJobManager for a process that hosts
// several top-level sessions (CUELO opens one per browser session). Up to core
// 18.8.9 this script rewrote sdk.ts so every top-level session owned a manager and
// children inherited their parent's. Core 18.9.0 (#15229) ships that contract
// itself: every root builds its own manager, children receive the parent's exact
// manager through `options.asyncJobManager`, and only the first root is adopted as
// the process singleton (its owner clears it on dispose). The script no longer
// edits sdk.ts; it verifies that each upstream line below is present exactly once
// and fails closed when the pinned core drifts. native-runtime-behavior-test.ts
// covers the behaviour itself.
const SDK_FILE = path.join('node_modules', '@oh-my-pi', 'pi-coding-agent', 'src', 'sdk.ts');
const SDK_UPSTREAM = [
    {
        key: 'sessionAsyncChildOption',
        text: [
            '\t/** Parent\'s async jobs and delivery sinks; child sessions never resolve a process-global manager. */',
            '\tasyncJobManager?: AsyncJobManager;',
            '',
        ].join('\n'),
    },
    {
        key: 'sessionAsyncOwnership',
        text: [
            '\tconst asyncJobManager = !options.parentTaskPrefix',
            '\t\t? new AsyncJobManager({',
            '\t\t\t\tmaxRunningJobs: () => Math.min(100, cfgAsyncMaxJobs.get(settings)),',
            '\t\t\t})',
            '\t\t: undefined;',
            '\tconst scopedAsyncJobManager = asyncJobManager ?? options.asyncJobManager;',
            '',
        ].join('\n'),
    },
    {
        key: 'sessionAsyncSingleton',
        text: '\t\t\tif (asyncJobManager && !AsyncJobManager.instance()) AsyncJobManager.setInstance(asyncJobManager);\n',
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
        throw new Error('native cueloBuild metadata does not match cuelo / core 18.12.2');
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

    const sdkChecks = inspectSdk(target, errors);

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

// sdk.ts is verified, never written: each upstream line must appear exactly once in
// both apply and check mode; any other count is a drift of the pinned core.
function inspectSdk(target, errors) {
    const sdkFile = path.join(target, SDK_FILE);
    const checks = {};
    const text = fs.existsSync(sdkFile) ? fs.readFileSync(sdkFile, 'utf8') : undefined;
    if (text === undefined) errors.push('MISSING core sdk source: ' + sdkFile);
    for (const line of SDK_UPSTREAM) {
        const present = text === undefined ? 0 : occurrences(text, line.text);
        checks[line.key] = { present, expected: 1 };
        if (text !== undefined && present !== 1) {
            errors.push(`SDK ${line.key} upstream count ${present}, expected exactly 1`);
        }
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
