#!/usr/bin/env node
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const groups = ['extensions', 'tools', 'cuelo-plugins'];
const extensionSupport = new Set(['lib', 'tests']);
const kinds = new Set(['guard', 'hint', 'tool', 'infra']);
const strengths = new Set(['S1', 'S2', 'S3', 'S4']);

function inventory(agentRoot) {
  return groups.flatMap((group) => {
    const directory = join(agentRoot, group);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (group !== 'extensions' && error.code === 'ENOENT') return [];
      throw error;
    }
    return entries.filter((entry) => {
      if (group === 'extensions' && extensionSupport.has(entry.name)) return false;
      const type = entry.isSymbolicLink() ? statSync(join(directory, entry.name), { throwIfNoEntry: false }) : entry;
      return !!type && (type.isDirectory()
        || (group !== 'cuelo-plugins' && type.isFile() && entry.name.endsWith('.ts')));
    }).map((entry) => `${group}/${entry.name}`).sort();
  });
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validId(id) {
  if (typeof id !== 'string') return false;
  const [group, name, ...rest] = id.split('/');
  return groups.includes(group) && rest.length === 0 && !!name && name !== '.' && name !== '..'
    && !/[\\\x00-\x1f]/.test(name) && (group !== 'extensions' || !extensionSupport.has(name));
}

function checkLedger(agentRoot, ledger, today = new Date().toISOString().slice(0, 10)) {
  if (!Array.isArray(ledger)) throw new Error('Ledger must be an array');
  const ids = new Set();
  for (const entry of ledger) {
    if (!entry || !validId(entry.id) || ids.has(entry.id) || !kinds.has(entry.kind)
      || !Array.isArray(entry.strengths) || entry.strengths.some((value) => !strengths.has(value))
      || new Set(entry.strengths).size !== entry.strengths.length
      || ![entry.purpose, entry.decision, entry.effectMetric, entry.retireWhen].every((text) =>
        typeof text === 'string' && text.trim() && !/[\r\n]/.test(text))
      || !validDate(entry.introduced) || !validDate(entry.reviewBy)
      || !['active', 'retired'].includes(entry.status)) {
      throw new Error(`Invalid or duplicate ledger entry: ${entry?.id ?? '(missing id)'}`);
    }
    ids.add(entry.id);
  }

  const current = new Set(inventory(agentRoot));
  const unledgered = [...current].filter((id) => !ids.has(id));
  const stale = ledger.filter(({ id }) => !current.has(id));
  const due = ledger.filter(({ status, reviewBy }) => status === 'active' && reviewBy <= today);
  const noStrength = ledger.filter(({ status, kind, strengths }) => status === 'active' && kind !== 'infra' && !strengths.length);
  const noMetric = ledger.filter(({ effectMetric }) => effectMetric === '미정');
  return { today, counts: { inventory: current.size, ledger: ledger.length, unledgered: unledgered.length,
    stale: stale.length, due: due.length, noStrength: noStrength.length, noMetric: noMetric.length },
  unledgered, stale, due, noStrength, noMetric };
}

function main(argv) {
  if (argv.some((arg) => !['--strict', '--json'].includes(arg))) throw new Error('Usage: node check.mjs [--strict] [--json]');
  const ledger = JSON.parse(readFileSync(join(HERE, 'ledger.json'), 'utf8'));
  const report = checkLedger(resolve(HERE, '..'), ledger);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const counts = Object.entries(report.counts).map(([key, value]) => `${key}=${value}`).join(', ');
    console.log(`Extension ledger (${report.today}): ${counts}`);
    for (const category of ['unledgered', 'stale', 'due', 'noStrength', 'noMetric']) {
      for (const entry of report[category]) {
        const detail = category === 'due' ? ` (reviewBy=${entry.reviewBy})` : '';
        console.log(`${category}: ${typeof entry === 'string' ? entry : entry.id}${detail}`);
      }
    }
  }
  return argv.includes('--strict') && (report.unledgered.length || report.stale.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
