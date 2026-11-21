import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function entry(id, overrides = {}) {
  return { id, kind: 'guard', strengths: ['S3'], purpose: '검사', introduced: '2026-01-01',
    decision: '미상', effectMetric: 'events.count', reviewBy: '9999-01-01', retireWhen: '대체 확인 뒤',
    status: 'active', ...overrides };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'extension-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, 'agent');
  const folder = join(agent, 'extension-ledger');
  const ledger = join(folder, 'ledger.json');
  const checker = join(folder, 'check.mjs');
  function dir(path) { mkdirSync(join(agent, path), { recursive: true }); }
  function file(path) { writeFileSync(join(agent, path), ''); }
  dir('extension-ledger');
  dir('extensions');
  copyFileSync(new URL('./check.mjs', import.meta.url), checker);
  return { agent, dir, file, ledger, set(entries) { writeFileSync(ledger, JSON.stringify(entries)); },
    run(...args) { return spawnSync(process.execPath, [checker, ...args], { cwd: root, encoding: 'utf8' }); } };
}

function report(result, status = 0) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('default mode and JSON list all findings without rewriting the ledger', (t) => {
  const f = fixture(t);
  for (const dir of ['extensions/lib', 'extensions/tests', 'extensions/hook', 'tools/registered', 'cuelo-plugins/live']) f.dir(dir);
  for (const file of ['extensions/lib/helper.ts', 'extensions/tests/hook.test.ts', 'extensions/new.ts',
    'extensions/hook/internal.ts', 'extensions/retired.ts', 'tools/loose.ts', 'cuelo-plugins/README.md']) f.file(file);
  const today = new Date().toISOString().slice(0, 10);
  f.set([
    entry('extensions/hook', { reviewBy: today, strengths: [], effectMetric: '미정' }),
    entry('extensions/retired.ts', { reviewBy: '2000-01-01', strengths: [], effectMetric: '미정', status: 'retired' }),
    entry('tools/registered', { kind: 'infra', strengths: [] }),
    entry('cuelo-plugins/removed'),
  ]);
  const before = readFileSync(f.ledger, 'utf8');
  const result = report(f.run('--json'));
  assert.deepEqual(result.counts, { inventory: 6, ledger: 4, unledgered: 3, stale: 1, due: 1, noStrength: 1, noMetric: 2 });
  assert.deepEqual(result.unledgered, ['extensions/new.ts', 'tools/loose.ts', 'cuelo-plugins/live']);
  assert.deepEqual(result.stale.map(({ id }) => id), ['cuelo-plugins/removed']);
  assert.deepEqual(result.due.map(({ id }) => id), ['extensions/hook']);
  assert.deepEqual(result.noStrength.map(({ id }) => id), ['extensions/hook']);
  assert.deepEqual(result.noMetric.map(({ id }) => id), ['extensions/hook', 'extensions/retired.ts']);
  const text = f.run();
  assert.equal(text.status, 0, text.stderr);
  for (const [category, id] of [['unledgered', 'extensions/new.ts'], ['stale', 'cuelo-plugins/removed'],
    ['due', 'extensions/hook'], ['noStrength', 'extensions/hook'], ['noMetric', 'extensions/retired.ts']]) {
    assert.ok(text.stdout.split('\n').some((line) => line.startsWith(`${category}: ${id}`)), text.stdout);
  }
  assert.equal(readFileSync(f.ledger, 'utf8'), before);
});

test('strict mode fails on either inventory mismatch, not advisory findings', (t) => {
  const f = fixture(t);
  f.file('extensions/live.ts');
  const live = entry('extensions/live.ts', { reviewBy: '2000-01-01', strengths: [], effectMetric: '미정' });
  f.set([live]);
  assert.deepEqual(report(f.run('--strict', '--json')).counts,
    { inventory: 1, ledger: 1, unledgered: 0, stale: 0, due: 1, noStrength: 1, noMetric: 1 });
  f.set([live, entry('tools/removed', { status: 'retired' })]);
  assert.deepEqual(report(f.run('--strict', '--json'), 1).stale.map(({ id }) => id), ['tools/removed']);
  f.set([]);
  assert.equal(report(f.run('--strict', '--json'), 1).counts.unledgered, 1);
});

test('a linked plugin directory is inventoried by its own path', (t) => {
  const f = fixture(t);
  f.dir('cuelo-plugins');
  f.dir('linked-source');
  symlinkSync(join(f.agent, 'linked-source'), join(f.agent, 'cuelo-plugins/linked'), 'junction');
  f.set([]);
  assert.deepEqual(report(f.run('--strict', '--json'), 1).unledgered, ['cuelo-plugins/linked']);
  f.set([entry('cuelo-plugins/linked')]);
  assert.equal(report(f.run('--strict', '--json')).counts.stale, 0);
});

test('invalid input exits 2 with a diagnostic and no report', (t) => {
  const f = fixture(t);
  function invalid(result, pattern) {
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, pattern);
  }
  invalid(f.run('--unknown'), /Usage:/);
  invalid(f.run('--json'), /ledger\.json/);
  writeFileSync(f.ledger, '{');
  invalid(f.run('--json'), /JSON|property name/);
  const live = entry('extensions/live.ts');
  for (const entries of [[live, live], [entry('extensions/live.ts', { reviewBy: '2026-02-30' })],
    [entry('tools/../elsewhere')], [entry('tools/maybe', { strengths: ['S5'] })]]) {
    f.set(entries);
    invalid(f.run('--strict'), /Invalid or duplicate ledger entry/);
  }
});
