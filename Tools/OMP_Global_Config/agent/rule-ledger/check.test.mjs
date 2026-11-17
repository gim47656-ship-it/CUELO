import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addDays, decisionId, extractDecisions, checkLedger, readSources } from './check.mjs';

const extract = (text) => extractDecisions('RULES.md', text);
const sample = '- Keep the boundary (user decision, 2026-01-01).';

test('extracts attribution orders, corrections, continuation lines and separate dates', () => {
  const source = '- Use the guard (user decision, 2026-01-01).\n'
    + '  Preserve the timeout (2026-01-02 사용자 정정).\n'
    + '- 사용자 결정 2026-01-03\n'
    + '- Approved (사용자, 2026-01-04).\n'
    + '- (2026-01-05 사용자 지시,\n  2026-01-06 범위 축소).';
  const entries = extract(source);
  assert.deepEqual(entries.map((entry) => entry.decisionDate),
    ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06']);
  assert.equal(entries[1].line, 2);
  assert.equal(entries.at(-1).line, 6);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 6);
  assert.equal(entries[0].entryType, 'decision');
  assert.equal(entries[0].motivatingFailure, '미상');
  assert.equal(entries[0].modelAtDecision, '미상');
});

test('resolves local shortened dates, same-day attribution and unique source-file years', () => {
  const entries = extract('- 사용자 결정, 2026-09-26~10-11, 2026-11-07·11-08. 같은 날 사용자 결정: retain scope.\n\n10-12 alone.');
  assert.deepEqual(entries.map((entry) => entry.decisionDate),
    ['2026-09-26', '2026-10-11', '2026-11-07', '2026-11-08', '2026-11-08', '2026-10-12']);
  assert.equal(extract('같은 날 사용자 결정: unknown.').length, 0);
});

test('ignores fenced examples, frontmatter, paths, URLs, external versions and invalid dates', () => {
  const source = '---\ndescription: 2026-01-01\n---\n'
    + '```json\n{"decisionDate":"2026-01-02"}\n```\n'
    + 'See `doc/history/2026-01-03/main.md` and https://example.com/2026-01-04.\n'
    + '| 2026-01-05 | upstream (MIT, 2026-01-06판) | accepted |\n'
    + '2026-02-30 사용자 결정.\n';
  assert.deepEqual(extract(source).map((entry) => entry.decisionDate), ['2026-01-05']);
});

test('distinguishes incident and other provenance without inventing attribution', () => {
  assert.equal(extract('2026-01-01 감사: observed failure.')[0].entryType, 'incident');
  assert.equal(extract('## Revised (2026-01-01)')[0].entryType, 'other');
});

test('stable identity tolerates line shifts, whitespace, CRLF and Unicode normalization', () => {
  const a = extract('- Rule boundary remains intact (2026-01-01 사용자 결정).')[0];
  const b = extract('\r\n- Rule boundary\r\n  remains intact (2026-01-01 사용자 결정).')[0];
  assert.equal(a.id, b.id);
  assert.equal(decisionId('RULES.md', 'é'), decisionId('RULES.md', 'e\u0301'));
  assert.notEqual(a.id, decisionId('AGENTS.md', a.quote));
});

test('cites named enforcers and concrete motivating records, not target model names', () => {
  const source = '| R1 | rule | 차단(부분) | `extensions/guard.ts` | 2026-01-01 사용자 결정. `doc/history/2026/01/01-bug/main.md` |';
  const entry = extract(source)[0];
  assert.equal(entry.kind, 'mechanical');
  assert.deepEqual(entry.enforcement, [{ name: 'extensions/guard.ts', source: 'RULES.md:1-1' }]);
  assert.equal(entry.motivatingFailure, 'doc/history/2026/01/01-bug/main.md');
  assert.equal(extract('| R1 | rule | 문서 | `extensions/guard.test.ts` | 2026-01-01 사용자 결정 |')[0].kind, 'prose');
  assert.equal(extract('2026-01-01 사용자 결정: use Opus. `doc/history/YYYY/MM/DD-topic/main.md`')[0].motivatingFailure, '미상');
  assert.equal(extract('2026-01-01 사용자 결정. `doc/history/**/*.md`')[0].motivatingFailure, '미상');
  assert.equal(extract('2026-01-01 사용자 결정. 당시 모델: `recorded-model`')[0].modelAtDecision, 'recorded-model');
});

test('adds ninety UTC calendar days across years and leap days', () => {
  assert.equal(addDays('2026-11-17'), '2027-02-15');
  assert.equal(addDays('2024-02-29'), '2024-05-29');
  assert.throws(() => addDays('2026-02-30'), /Invalid date/);
});

test('reports due, unledgered and stale; retirement suppresses due but not coverage', () => {
  const ledger = extract(sample);
  const source = new Map([['RULES.md', `${sample}\n\n- New (2026-05-01 사용자 결정).`]]);
  const report = checkLedger(source, ledger, '2026-04-02');
  assert.equal(report.counts.due, 1);
  assert.equal(report.counts.unledgered, 1);
  assert.equal(report.counts.stale, 0);
  assert.equal(checkLedger(source, ledger, '2026-04-01').counts.due, 0);
  assert.equal(checkLedger(source, [{ ...ledger[0], status: 'retired' }], '2026-04-02').counts.due, 0);
  assert.equal(checkLedger(new Map([['RULES.md', 'removed']]), ledger, '2026-04-02').counts.stale, 1);
  assert.equal(checkLedger(new Map(), ledger, '2026-04-02').counts.stale, 1);
  assert.equal(checkLedger(new Map([['RULES.md', `\n${sample}`]]), ledger, '2026-04-02').counts.stale, 0);
});

test('rejects malformed ledgers rather than silently losing re-test coverage', () => {
  const sources = new Map([['RULES.md', sample]]);
  const ledger = extract(sample);
  for (const patch of [{ id: 'wrong' }, { retestAfter: 'tomorrow' }, { decisionDate: '2026-02-30' }, { status: 'unknown' }]) {
    assert.throws(() => checkLedger(sources, [{ ...ledger[0], ...patch }]), /Invalid/);
  }
  assert.throws(() => checkLedger(sources, [...ledger, ...ledger]), /duplicate/);
  assert.throws(() => checkLedger(sources, {}), /array/);
});

test('CLI remains read-only, defaults to exit zero, strict only fails coverage drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'cuelo-rule-ledger-'));
  try {
    const directory = join(root, 'rule-ledger');
    mkdirSync(directory);
    mkdirSync(join(root, 'rules'));
    writeFileSync(join(root, 'AGENTS.md'), '');
    writeFileSync(join(root, 'RULES.md'), sample);
    writeFileSync(join(root, 'rules', 'new.md'), '');
    copyFileSync(new URL('./check.mjs', import.meta.url), join(directory, 'check.mjs'));
    const ledgerPath = join(directory, 'ledger.json');
    writeFileSync(ledgerPath, JSON.stringify(extract(sample)));
    const run = (...args) => spawnSync(process.execPath, [join(directory, 'check.mjs'), ...args], { encoding: 'utf8', cwd: tmpdir() });
    const strict = run('--strict', '--json');
    assert.equal(strict.status, 0, strict.stderr);
    assert.equal(JSON.parse(strict.stdout).counts.due, 1);
    assert.equal(readSources(root).size, 3);
    const link = join(root, 'linked-check.mjs');
    symlinkSync(join(directory, 'check.mjs'), link);
    const linked = spawnSync(process.execPath, [link, '--unknown'], { encoding: 'utf8' });
    assert.equal(linked.status, 2, linked.stderr);
    assert.match(linked.stderr, /Usage:/);
    writeFileSync(ledgerPath, '[]');
    const advisory = run('--json');
    assert.equal(advisory.status, 0, advisory.stderr);
    assert.equal(JSON.parse(advisory.stdout).counts.unledgered, 1);
    assert.equal(run('--strict').status, 1);
    writeFileSync(ledgerPath, JSON.stringify(extract(sample)));
    writeFileSync(join(root, 'RULES.md'), '');
    assert.equal(run('--strict').status, 1);
    assert.equal(run('--unknown').status, 2);
    writeFileSync(ledgerPath, '{');
    assert.equal(run('--json').status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review: standalone dates use record year first and expose unresolved ambiguity', () => {
  const source = '2026-01-01 사용자 결정.\n\n| R45 | correction | 문서 | — | 11-08 정정 |\n\n'
    + '| A37 | rule | 문서 | — | 11-05 조사 `../../doc/history/2025/11/05-case/main.md` |';
  const entries = extract(source);
  assert.deepEqual(entries.map((entry) => entry.decisionDate), ['2026-01-01', '2026-11-08', '2025-11-05']);
  assert.equal(entries[2].motivatingFailure, '../../doc/history/2025/11/05-case/main.md');
  const sources = new Map([['RULES.md', '2025-01-01 audit.\n\n2026-01-01 audit.\n\n11-08 정정']]);
  const report = checkLedger(sources, [], '2026-11-17');
  assert.equal(report.counts.unresolved, 1);
  assert.match(report.unresolved[0].quote, /11-08/);
  assert.equal(extract('11-08 정정').length, 0);
});

test('review: attribution does not leak into adjacent audits or unrelated prose', () => {
  assert.deepEqual(extract('- A(2026-01-01 사용자 결정). B(2026-01-02 감사: 3건 관찰).').map((e) => e.entryType), ['decision', 'incident']);
  assert.deepEqual(extract('2026-10-06 지적(버그). 2026-11-03 사용자 결정: 유지.').map((e) => e.entryType), ['incident', 'decision']);
  assert.equal(extract('Android 공식 스킬은 2026-10-22에 들였다. 공장 측정기에도 쓴다.')[0].entryType, 'other');
  assert.equal(extract('문서 누락과 실패를 막는다(RULES.md, 2026-11-11).')[0].entryType, 'other');
  assert.equal(extract('면제는 사용자 명시 지시만 허용하며 한도 예외(2026-11-09 「걍넘기자」)도 포함한다.')[0].entryType, 'decision');
  assert.equal(extract('2026-11-03에는 사용자가 문서 누락을 알려 마감 시점을 바꿨다.')[0].entryType, 'decision');
  assert.equal(extract('(2026-10-27: 공개 선언이 없다는 이유로 고객용 덱이 빠진 사례를 사용자가 바로잡았다).')[0].entryType, 'decision');
});

test('review: mechanical evidence stays scoped to the dated rule', () => {
  assert.equal(extract('`extensions/auto-effort.ts`로 강도를 고른다. Main 프론티어는 Opus다(2026-11-11 사용자 결정).')[0].kind, 'prose');
  assert.equal(extract('| R1 | rule | 차단(부분) | `extensions/g.ts` | 사본 비교 규칙은 문서 수준이다(2026-01-01 사례) |')[0].kind, 'prose');
  assert.equal(extract('| A | rule | 차단 | `patches/check.mjs --check` | 2026-01-01 사용자 결정 |')[0].enforcement[0].name, 'patches/check.mjs');
});

test('review: stale follows extracted identity, not examples or substring remnants', () => {
  const ledger = extract(sample);
  assert.equal(checkLedger(new Map([['RULES.md', '```\n' + sample + '\n```']]), ledger).counts.stale, 1);
  const old = extract('- First (2026-01-01 사용자 결정), second (2026-01-02 사용자 결정).');
  const source = new Map([['RULES.md', '- First (2026-01-01 사용자 결정), second removed.']]);
  assert.equal(checkLedger(source, old).counts.stale, 2);
});

test('review: BOM frontmatter and inline backticks do not corrupt block extraction', () => {
  assert.equal(extract('```foo``` inline\n2026-01-01 사용자 결정.').length, 1);
  assert.equal(extract('\uFEFF---\ndate: 2026-01-01\n---\n').length, 0);
  assert.equal(extract('```js\n```not-a-closing-fence\n2026-01-01 사용자 결정.\n```').length, 0);
});

test('linked provenance date lists share explicit attribution, not adjacent unrelated dates', () => {
  assert.deepEqual(extract('배포(사용자, 2026-09-26·2026-09-29·2026-09-30)').map((e) => e.entryType), ['decision', 'decision', 'decision']);
  assert.deepEqual(extract('집과 사무실의 2026-11-07·11-08 사용자 결정').map((e) => e.entryType), ['decision', 'decision']);
});

test('review round two: incident descriptions and table cells retain their own meaning', () => {
  for (const source of ['2026-10-10 집계 감시 사고', '(2026-11-16 원장 감사: 24건 중 5건 누락)', '(2026-11-16 공유 변경 임시 제거 사례)', '(2026-10-29: 측정 7일에 누락)']) {
    assert.equal(extract(source)[0].entryType, 'incident', source);
  }
  assert.equal(extract('| R5 | 사용자 승인 없이 배포 금지 | 문서 | — | 2026-01-01 도입 |')[0].entryType, 'other');
  assert.equal(extract('| R9 | 기록은 문서로 남긴다 | 차단 | `extensions/x.ts` | 2026-01-01 도입 |')[0].kind, 'mechanical');
  assert.deepEqual(extract('2026-01-01 배포가 깨졌고 사용자 결정으로 2026-01-02에 되돌렸다.').map((e) => e.entryType), ['other', 'decision']);
});

test('review round two: numeric ranges are not unresolved or invented calendar dates', () => {
  const source = '2026-01-01 사용자 결정.\n\n대기는 10-15분으로 둔다.\n\nrange 50-90.';
  assert.deepEqual(extract(source).map((e) => e.decisionDate), ['2026-01-01']);
  assert.equal(checkLedger(new Map([['RULES.md', '2025-01-01 a.\n\n2026-01-01 b.\n\nrange 15-20.']]), []).counts.unresolved, 0);
});

test('review round two: import accepts non-file argv and unresolved text includes the reason', () => {
  const moduleUrl = new URL('./check.mjs', import.meta.url).href;
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)}); console.log('ok')`, 'not-a-file'], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), 'ok');
  const root = mkdtempSync(join(tmpdir(), 'cuelo-rule-ledger-unresolved-'));
  try {
    mkdirSync(join(root, 'rule-ledger'));
    mkdirSync(join(root, 'rules'));
    writeFileSync(join(root, 'AGENTS.md'), '');
    writeFileSync(join(root, 'RULES.md'), '11-08 정정');
    writeFileSync(join(root, 'rule-ledger', 'ledger.json'), '[]');
    copyFileSync(new URL('./check.mjs', import.meta.url), join(root, 'rule-ledger', 'check.mjs'));
    const result = spawnSync(process.execPath, [join(root, 'rule-ledger', 'check.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[unresolved\]/);
    assert.match(result.stdout, /No unambiguous year/);
    assert.doesNotMatch(result.stdout, /undefined/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review round three: incident labels accept punctuation and Korean particles', () => {
  for (const suffix of ['지적.', '감사에서 17건이 빠졌다.', '측정으로 462토큰이었다.', '실측에 맞췄다.', '정정으로 바꿨다.', '지적으로 복원했다.']) {
    assert.equal(extract(`2026-10-19 ${suffix}`)[0].entryType, 'incident', suffix);
  }
  assert.equal(extract('2026-10-10 측정기 설치')[0].entryType, 'other');
  assert.equal(extract('2026-11-03 문서 개정 때 게시 확인 안내를 더했다.')[0].entryType, 'other');
});

test('review round three: a date keeps its own direct attribution across dates and cells', () => {
  assert.deepEqual(extract('| R1 | rule | 2026-01-01 사용자 결정 | 2026-01-05 개정 |').map((e) => e.entryType), ['decision', 'other']);
  assert.deepEqual(extract('2026-11-03 사용자 결정으로 2026-10-06 규칙을 되돌렸다.').map((e) => e.entryType), ['decision', 'other']);
});

test('review round four: date particles and clause punctuation preserve attribution ownership', () => {
  for (const particle of ['에', '에는', '자', '에서', '부터', '의']) {
    assert.deepEqual(extract(`2026-11-03${particle} 사용자 결정으로 2026-10-06 규칙을 되돌렸다.`).map((e) => e.entryType), ['decision', 'other'], particle);
  }
  for (const punctuation of [',', ':', ')']) {
    assert.deepEqual(extract(`A(2026-01-01 사용자 결정)${punctuation} B(2026-01-02 감사: 3건 관찰).`).map((e) => e.entryType), ['decision', 'incident'], punctuation);
  }
});
