#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const normalize = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
export const decisionId = (file, quote) => createHash('sha256').update(`${file}\n${normalize(quote)}`).digest('hex');

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function addDays(date, days = 90) {
  if (!validDate(date)) throw new Error(`Invalid date: ${date}`);
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// A paragraph, list item, heading or table row is the local provenance context.
function blocks(text) {
  const result = [];
  let current;
  let fence;
  let frontmatter = false;
  const flush = () => { if (current) result.push(current); current = undefined; };
  for (const [index, line] of text.replace(/^\uFEFF/u, '').split(/\r?\n/).entries()) {
    if (index === 0 && line === '---') { frontmatter = true; continue; }
    if (frontmatter) { if (line === '---') frontmatter = false; continue; }
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    const closes = fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim();
    const opens = !fence && marker && (marker[1][0] !== '`' || !marker[2].includes('`'));
    if (opens || closes) {
      flush();
      fence = opens ? marker[1] : undefined;
      continue;
    }
    if (fence) continue;
    if (!line.trim()) { flush(); continue; }
    if (/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/.test(line)) flush();
    if (!current) current = { text: '', line: index + 1, endLine: index + 1 };
    current.text += `${current.text ? '\n' : ''}${line}`;
    current.endLine = index + 1;
  }
  flush();
  return result;
}

function dateMentions(text, fallbackYear) {
  const excluded = [];
  // Paths, URLs and literal date/schema examples are not dated provenance.
  for (const match of text.matchAll(/`([^`]+)`|https?:\/\/[^\s)]+|(?:[\w.-]+\/)+[^\s`]+/gu)) {
    if (/[\/\\]|YYYY|DD|MM/.test(match[0])) excluded.push([match.index, match.index + match[0].length]);
  }
  const result = [];
  const recordYears = [...new Set([...text.matchAll(/doc\/history\/(20\d{2})(?:\/|-)/gu)].map((match) => match[1]))];
  let year = recordYears.length ? (recordYears.length === 1 ? recordYears[0] : undefined) : fallbackYear;
  let lastDate;
  for (const match of text.matchAll(/\b(?:(20\d{2})-)?(\d{2})-(\d{2})\b|같은 날(?=\s*사용자\s*(?:결정|정정|지시|승인|요청|지적))/gu)) {
    const index = match.index;
    if (excluded.some(([start, end]) => index >= start && index < end)) continue;
    if (/^(?:판|\s*(?:version|release)\b)/iu.test(text.slice(index + match[0].length))) continue;
    if (match[0] !== '같은 날' && !validDate(`2000-${match[2]}-${match[3]}`)) continue;
    if (!match[1] && /^(?:분|초|시간|회|건|명|개|%|ms\b|minutes?\b|seconds?\b)/iu.test(text.slice(index + match[0].length))) continue;
    let date;
    if (match[0] === '같은 날') date = lastDate;
    else {
      if (match[1]) year = match[1];
      date = year ? `${year}-${match[2]}-${match[3]}` : null;
    }
    if (date && !validDate(date)) continue;
    if (!date && match[1]) continue;
    lastDate = date;
    result.push({ index, length: match[0].length, date });
  }
  return result;
}

function mentionContext(text, mentions, index) {
  const linked = (left, right) => /^[\s·~,、]*$/u.test(text.slice(left.index + left.length, right.index));
  let first = index;
  let last = index;
  while (first && linked(mentions[first - 1], mentions[first])) first--;
  while (last + 1 < mentions.length && linked(mentions[last], mentions[last + 1])) last++;
  const start = mentions[first].index;
  const end = mentions[last].index + mentions[last].length;
  const previous = first ? mentions[first - 1].index + mentions[first - 1].length : 0;
  const next = mentions[last + 1]?.index ?? text.length;
  const rawPrefix = text.slice(previous, start);
  const rawSuffix = text.slice(end, next);
  let prefix = rawPrefix.split(/(?<=[.!?。])\s+|\|/u).at(-1);
  let suffix = rawSuffix.split(/(?<=[.!?。])\s+|\|/u)[0];
  if (first && prefix === rawPrefix) prefix = prefix.replace(/^\s*(?:에는|에서|부터|에|자|의)?\s*사용자\s*(?:명시\s*)?(?:결정|정정|지시|승인|요청|지적)(?:으로|로|에 따라)?/u, '');
  // A trailing attribution directly before the next date belongs to that date.
  const nextAttribution = /사용자\s*(?:명시\s*)?(?:결정|정정|지시|승인|요청|지적)(?:으로|로|에 따라)?\s*$/u.exec(suffix);
  const beforeAttribution = nextAttribution ? suffix.slice(0, nextAttribution.index).trim().replace(/^(?:에는|에서|부터|에|자|의)$/u, '') : '';
  if (mentions[last + 1] && suffix === rawSuffix && nextAttribution && beforeAttribution) suffix = suffix.slice(0, nextAttribution.index);
  return { local: prefix + text.slice(start, end) + suffix, prefix, suffix };
}

function metadata(block, mention, file, context) {
  const text = normalize(block.text);
  const { local, suffix } = context;
  const explicit = /사용자\s*(?:명시\s*)?(?:결정|정정|지시|승인|요청|지적)|user\s+(?:decision|correction|instruction|approval|request)|사용자\s*,|사용자가[^.!?]{0,150}(?:바로잡|알려|정정|지적|결정|요청)/iu;
  const incident = /^[^|.!?]{0,80}(?:감사|실측|사례|사고|오탐|지적|정정|실패|관찰|측정|이탈|누락)(?=[\s:：().,!?]|$|에서|으로|로|에|을|를|이|가|은|는|의)/u.test(suffix)
    || /^\s*확인(?=[\s:：().,!?]|$)/u.test(suffix);
  const entryType = explicit.test(local) ? 'decision' : incident ? 'incident' : 'other';
  const table = text.startsWith('|') ? text.split('|').map((cell) => cell.trim()) : null;
  const documentOnly = (table && /^문서/.test(table[3] ?? '')) || /문서\s*(?:수준|로|[.(])/u.test(local);
  const evidence = table ? table[4] ?? '' : local;
  const enforcers = documentOnly ? [] : [...evidence.matchAll(/`((?:extensions|tools|patches|cuelo-plugins)\/[^\s`]+)(?:[^`]*)`/gu)].map((match) => match[1]);
  const enforcement = [...new Set(enforcers)].map((name) => ({ name, source: `${file}:${block.line}-${block.endLine}` }));
  // Concrete paths in the same source block can name evidence, but globs cannot.
  const failure = [...text.matchAll(/(?:[\w.-]+\/)*doc\/history\/[^\s`<>|)]+/gu)]
    .map((match) => match[0]).find((path) => !/YYYY|…|\.\.\.|[<>*?[\]{}]/u.test(path));
  const recordedModels = [...new Set([...block.text.matchAll(/(?:modelAtDecision|당시 모델)\s*[:=]\s*`?([^`\n,;)]+)/gu)].map((match) => match[1].trim()))];
  const recordedModel = recordedModels.length === 1 ? recordedModels[0] : undefined;
  return { entryType, kind: enforcement.length ? 'mechanical' : 'prose', enforcement,
    motivatingFailure: failure ?? '미상', modelAtDecision: recordedModel ?? '미상' };
}

export function extractDecisions(file, source, unresolved = []) {
  const decisions = new Map();
  const sourceBlocks = blocks(source);
  const years = [...new Set(sourceBlocks.flatMap((block) => {
    const text = normalize(block.text);
    return dateMentions(text).filter((mention) => mention.date && /^20\d{2}-/u.test(text.slice(mention.index)))
      .map((mention) => mention.date.slice(0, 4));
  }))];
  const fallbackYear = years.length === 1 ? years[0] : undefined;
  for (const block of sourceBlocks) {
    const text = normalize(block.text);
    const mentions = dateMentions(text, fallbackYear);
    for (const [index, mention] of mentions.entries()) {
      // Bound each quote by adjacent date mentions; distinct dates cannot share an ID.
      const start = Math.max(index ? mentions[index - 1].index + mentions[index - 1].length : 0, mention.index - 100);
      const end = Math.min(mentions[index + 1]?.index ?? text.length, mention.index + mention.length + 120);
      const quote = text.slice(start, end).trim();
      const id = decisionId(file, quote);
      // Locate the mention's physical line, not just the start of its paragraph.
      let offset = 0;
      let line = block.line;
      for (const rawLine of block.text.split(/\r?\n/)) {
        const length = normalize(rawLine).length;
        if (offset + length > mention.index) break;
        offset += length + 1;
        line++;
      }
      if (!mention.date) {
        const reason = text.slice(mention.index, mention.index + mention.length) === '같은 날'
          ? 'Same-day attribution has no preceding dated mention in its block'
          : 'No unambiguous year in local context, record path or source file';
        unresolved.push({ id, file, line, quote, reason });
        continue;
      }
      decisions.set(id, { id, file, line, endLine: block.endLine, quote,
        decisionDate: mention.date, ...metadata(block, mention, file, mentionContext(text, mentions, index)),
        retestAfter: addDays(mention.date), status: 'active' });
    }
  }
  return [...decisions.values()];
}

export function readSources(agentRoot = resolve(HERE, '..')) {
  const files = ['AGENTS.md', 'RULES.md', ...readdirSync(join(agentRoot, 'rules'))
    .filter((file) => file.endsWith('.md')).sort().map((file) => `rules/${file}`)];
  return new Map(files.map((file) => [file, readFileSync(join(agentRoot, file), 'utf8')]));
}

export function checkLedger(sources, ledger, today = new Date().toISOString().slice(0, 10)) {
  if (!validDate(today)) throw new Error(`Invalid today: ${today}`);
  if (!Array.isArray(ledger)) throw new Error('Ledger must be an array');
  const ids = new Set();
  for (const entry of ledger) {
    if (!entry || typeof entry.file !== 'string' || !entry.quote || entry.id !== decisionId(entry.file, entry.quote)
      || !validDate(entry.decisionDate) || !validDate(entry.retestAfter)
      || !['active', 'retired'].includes(entry.status) || !['decision', 'incident', 'other'].includes(entry.entryType)
      || !['prose', 'mechanical'].includes(entry.kind) || ids.has(entry.id)) {
      throw new Error(`Invalid or duplicate ledger entry: ${entry?.id ?? '(missing id)'}`);
    }
    ids.add(entry.id);
  }
  const unresolved = [];
  const decisions = [...sources].flatMap(([file, text]) => extractDecisions(file, text, unresolved));
  const unledgered = decisions.filter((entry) => !ids.has(entry.id));
  const currentIds = new Set(decisions.map((entry) => entry.id));
  const stale = ledger.filter((entry) => !currentIds.has(entry.id));
  const due = ledger.filter((entry) => entry.status === 'active' && entry.retestAfter < today);
  return { today, counts: { sources: sources.size, totalDecisions: decisions.length, ledger: ledger.length,
    due: due.length, unledgered: unledgered.length, stale: stale.length, unresolved: unresolved.length }, due, unledgered, stale, unresolved };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.some((arg) => !['--strict', '--json'].includes(arg))) throw new Error('Usage: node check.mjs [--strict] [--json]');
  const sources = readSources();
  const ledger = JSON.parse(readFileSync(join(HERE, 'ledger.json'), 'utf8'));
  const report = checkLedger(sources, ledger);
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    const c = report.counts;
    console.log(`Rule ledger (${report.today}): total decisions=${c.totalDecisions}, due=${c.due}, unledgered=${c.unledgered}, stale=${c.stale}, unresolved=${c.unresolved}; sources=${c.sources}, ledger=${c.ledger}`);
    for (const category of ['due', 'unledgered', 'stale', 'unresolved']) {
      for (const entry of report[category]) console.log(`${category}: ${entry.file}:${entry.line} [${entry.entryType ?? 'unresolved'}] ${entry.id} ${entry.quote}${entry.reason ? ` (${entry.reason})` : ''}`);
    }
  }
  return argv.includes('--strict') && (report.counts.unledgered || report.counts.stale) ? 1 : 0;
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
