// 프로젝트 문서 지도(doc/README.md)·하위 지도와 작업 기록의 `RECORD:` 헤더만으로 요청마다 BM25를 만들고 버린다.
// 2026-10-16 실측(doc/history/2026/10/16-rag-reinvestigation): 격리 표본 12건에서 에이전트는 지도를 0/12 열었고,
// 하위 지도에만 있던 정답 기록 2건을 놓쳤다. 본문까지 색인하면 무관 질문 점수가 같이 올라 헤더 전용이 낫다
// (hit@3 37/45 대 31/45). 상시 색인·캐시·LLM 호출은 두지 않는다. 읽기 실패는 호출부가 조용히 버린다.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// 근거: doc/history/2026/10/16-rag-reinvestigation/maker-DocmapRoute.md(처음 보정),
// doc/history/2026/10/17-rag-fixes/maker-DocmapFloor.md(기록 수·질의 길이에 묶이지 않는 두 조건으로 재보정).
/**
 * 점수 조건. 1위 BM25 점수를 「기록 하나에만 있는 낱말 하나의 IDF」로 나눈 값이다. 그래서 기록 수가 달라도 대략
 * 「드문 낱말 몇 개가 맞았나」로 읽힌다. 옛 절대 하한 10(2026-10-16 보정, 기록 212단위)은 이 값으로 2.02였다.
 * 절대 하한은 기록 1개일 때 정답 4.07로 떨어지고, 무관 기록 15개를 더하면 같은 정답이 22.39로 붙었다.
 */
export const DOCMAP_MIN_SCORE = 2;
/**
 * 점수 조건과 함께 보는 포괄률. 질의 낱말 중 기록 말뭉치에 있는 것의 헤더 IDF 합 대비, 1위 기록이 담은 낱말의
 * IDF 합이다. 기록 본문 절반 이상에 나오는 흔한 낱말은 분모·분자에서 뺀다. 긴 지시는 1위가 일부만 설명해 낮다.
 * 0.3은 보정 세트(홀수 문항)에서 점수 조건으로 전달되던 답의 최솟값(d29 0.34)을 잃지 않는 가장 큰 0.05 단위다.
 */
export const DOCMAP_MIN_COVERAGE = 0.3;
/**
 * 짧은 질문 조건. 「RAG에서 안된것좀찾아바」처럼 낱말 하나만 기록과 맞는 질문은 점수가 낮지만, 그 낱말이 기록
 * 본문에서도 드물고 질의를 거의 다 설명하면 붙인다. 근거는 1위가 맞힌 낱말마다 본문 IDF ÷ 최대 IDF의 합이다.
 * 0.8·0.6은 65문항 전체를 보고 정했다(held-out 없음): 포괄률 0.8 이상 무관 질문의 근거 최고 0.46(u06),
 * 근거 0.5 이상 무관 질문의 포괄률 최고 0.60(u18). 짧은 정답 질문 d17 0.78은 붙고 d14 0.54는 안 붙는다. RAG 질문 0.68.
 */
export const DOCMAP_FOCUSED_COVERAGE = 0.8;
export const DOCMAP_FOCUSED_EVIDENCE = 0.6;
/** 기록 본문의 이 비율 이상에 나오는 낱말은 포괄률에서 뺀다(조사·일반어). 기록이 적으면 판단하지 않는다. */
const GENERIC_SHARE = 0.5;
/** 이 비율 이상이면 순위에서도 뺀다(「에서」「으로」). 0.5로 순위까지 빼면 평가 hit@3이 21/22에서 20/22로 떨어졌다. */
const PARTICLE_SHARE = 0.9;
const GENERIC_MIN_RECORDS = 10;
export const DOCMAP_MAX_CANDIDATES = 3;
export const DOCMAP_MAX_CHARS = 1500;
/** 긴 prompt는 앞과 뒤를 함께 본다. 경로·날짜·마지막 요청은 보통 끝에 있다. */
const QUERY_HEAD_CHARS = 1000;
const QUERY_TAIL_CHARS = 1000;
const HEAD_BYTES = 8192;
const BODY_MAX_BYTES = 262_144;
const EXCERPT_CHARS = 160;
const SUPERSEDE_HOPS = 3;
const HEADER_LINE = /^(?:#\s|RECORD:|SCOPE:|PATHS:|DATE:|STATUS:)/;
/** 1위 대비 이 비율 미만인 뒤 후보는 공통 낱말("기록" 등)로만 걸린 잡음이라 넣지 않는다. */
export const DOCMAP_CANDIDATE_RATIO = 0.5;
/** 시점 낱말은 주제 근거가 아니라 날짜 의도로만 쓴다. */
const TEMPORAL_TERMS: Record<string, true> = {
  오늘: true, 어제: true, 그제: true, 그저: true, 저께: true, 최근: true, 요즘: true, 최신: true, 방금: true,
  today: true, yesterday: true, recent: true, recently: true, latest: true,
};
const RECENT_INTENT = /최근|요즘|최신|방금|\brecent(?:ly)?\b|\blatest\b/i;
const ENGLISH_STOP: Record<string, true> = Object.fromEntries(
  "an the and or of to in on at for from by with is are was were be been do did does what why how which who when where that this it its as into after before about can could should would will"
    .split(" ")
    .map((w) => [w, true] as const),
);

export const DOCMAP_INSTRUCTION =
  "아래는 질문과 맞을 수 있는 작업 기록 후보다. 답하기 전에 그 구간을 read로 열어 확인하고 맞지 않으면 버려라. 회상된 기억은 단서이지 근거가 아니다.";

export interface DocmapUnit {
  /** 대표 파일 절대 경로(main.md, 없으면 그 폴더의 다른 기록, 또는 월별 스냅샷 파일). */
  readonly file: string;
  /** 단위에 속한 기록 파일. 폴더 단위면 그 폴더 바로 아래 .md, 스냅샷이면 자기 자신. */
  readonly files: readonly string[];
  readonly key: string;
  readonly title: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly mapLines: string[];
  /** 대표 파일 앞 8KB를 소문자로. 낱말이 기록 본문에서 흔한지 셀 때만 쓴다(점수는 헤더만). */
  readonly body: string;
  /** RECORD `DATE:`, 없으면 경로의 YYYY/MM/DD. `YYYY-MM-DD` 또는 빈 문자열. */
  readonly date: string;
}

export interface DocmapCorpus {
  readonly root: string;
  readonly maps: readonly string[];
  readonly units: readonly DocmapUnit[];
  readonly tokens: ReadonlyMap<DocmapUnit, readonly string[]>;
  readonly termCounts: ReadonlyMap<DocmapUnit, ReadonlyMap<string, number>>;
  readonly df: ReadonlyMap<string, number>;
  readonly avgLen: number;
  /** 요청 하나 동안만 쓰는 낱말별 본문 문서 빈도 메모. */
  readonly bodyDf: Map<string, number>;
}

export interface DocmapCandidate {
  readonly unit: DocmapUnit;
  readonly score: number;
  /** superseded-by를 따라왔으면 원래 후보의 대표 파일. */
  readonly supersededFrom?: string;
}

export interface DocmapSection {
  readonly heading: string;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
}

export interface DocmapRoute {
  readonly topScore: number;
  readonly signals: DocmapSignals;
  readonly candidates: readonly DocmapCandidate[];
  readonly text: string;
}

/** 소문자 ASCII 낱말(2자 이상)과 한글 연속 구간의 2글자 조각. */
export function docmapTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = lower.match(/[a-z0-9_]{2,}/g) ?? [];
  for (const run of lower.match(/[가-힣]+/g) ?? []) {
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function readHead(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** cwd에서 위로 올라가 저장소 루트(.git)와 가장 가까운 HANDOFF.md 폴더를 찾는다. */
export function findDocmapProject(cwd: string): { root: string; project: string } | undefined {
  let dir = resolve(cwd);
  let project: string | undefined;
  for (;;) {
    if (!project && isFile(join(dir, "HANDOFF.md"))) project = dir;
    if (existsSync(join(dir, ".git"))) return { root: dir, project: project ?? dir };
    const parent = dirname(dir);
    if (parent === dir) return project ? { root: project, project } : undefined;
    dir = parent;
  }
}

function mapLinks(line: string, base: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/\]\(([^)#\s]+)/g)) {
    const href = m[1]!;
    if (/^[a-z]+:/i.test(href)) continue;
    out.push(resolve(base, decodeURI(href)));
  }
  return out;
}

/** 루트·프로젝트 지도, 그 지도가 링크한 하위 지도, 루트 아래 1~2단 `*\/doc/README.md`(옆에 history가 있는 것). */
export function findDocmapMaps(root: string, project: string): string[] {
  const maps = new Set<string>();
  const add = (path: string) => { if (isFile(path)) maps.add(path); };
  add(join(root, "doc", "README.md"));
  add(join(project, "doc", "README.md"));
  for (const map of [...maps]) {
    for (const line of readFileSync(map, "utf8").split("\n")) {
      for (const target of mapLinks(line, dirname(map))) {
        if (target.endsWith(`${sep}doc${sep}README.md`) && target.startsWith(root + sep)) add(target);
      }
    }
  }
  const skip = (name: string) => name.startsWith(".") || name === "node_modules";
  for (const a of readdirSync(root, { withFileTypes: true })) {
    if (!a.isDirectory() || skip(a.name)) continue;
    const first = join(root, a.name);
    if (isDir(join(first, "doc", "history"))) add(join(first, "doc", "README.md"));
    for (const b of readdirSync(first, { withFileTypes: true })) {
      if (!b.isDirectory() || skip(b.name)) continue;
      const second = join(first, b.name);
      if (isDir(join(second, "doc", "history"))) add(join(second, "doc", "README.md"));
    }
  }
  return [...maps];
}

function parseHead(text: string): { title: string; fields: Record<string, string> } {
  const head = text.split(/\n## /, 1)[0]!;
  const title = /^#\s+(.+)$/m.exec(head)?.[1]?.trim() ?? "";
  const fields: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const m = /^(SCOPE|PATHS|DATE|STATUS):\s*(.*)$/.exec(line.trim());
    if (m && !(m[1]! in fields)) fields[m[1]!] = m[2]!.trim();
  }
  return { title, fields };
}

function representative(files: string[]): string {
  const names = files.map((f) => f.slice(f.lastIndexOf(sep) + 1));
  const pick = names.indexOf("main.md") >= 0 ? names.indexOf("main.md") : names.findIndex((n) => n.startsWith("main"));
  return files[pick >= 0 ? pick : 0]!;
}

function collectUnits(historyDir: string): DocmapUnit[] {
  const units: DocmapUnit[] = [];
  for (const year of readdirSync(historyDir)) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearDir = join(historyDir, year);
    if (!isDir(yearDir)) continue;
    for (const month of readdirSync(yearDir)) {
      if (!/^\d{2}$/.test(month)) continue;
      const monthDir = join(yearDir, month);
      if (!isDir(monthDir)) continue;
      for (const entry of readdirSync(monthDir, { withFileTypes: true })) {
        if (!/^\d{2}-/.test(entry.name)) continue;
        const path = join(monthDir, entry.name);
        let files: string[];
        if (entry.isDirectory()) {
          files = readdirSync(path, { withFileTypes: true })
            .filter((f) => f.isFile() && f.name.endsWith(".md"))
            .map((f) => join(path, f.name))
            .sort();
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          files = [path];
        } else continue;
        if (files.length === 0) continue;
        const file = representative(files);
        // 같은 폴더의 maker 기록 제목·헤더까지 넣으면 hit@3이 36/45에서 33/45로 떨어졌다(2026-10-16 보정 세트).
        const head = readHead(file, HEAD_BYTES);
        const { title, fields } = parseHead(head);
        const date = /^\d{4}-\d{2}-\d{2}/.exec(fields.DATE ?? "")?.[0] ?? `${year}-${month}-${entry.name.slice(0, 2)}`;
        units.push({ file, files, key: path, title, fields, mapLines: [], body: head.toLowerCase(), date });
      }
    }
  }
  return units;
}

function unitText(unit: DocmapUnit): string {
  const f = unit.fields;
  return [...unit.mapLines, unit.title, f.SCOPE, f.PATHS, f.DATE, f.STATUS].filter(Boolean).join(" ");
}

export function buildDocmapCorpus(root: string, maps: readonly string[]): DocmapCorpus {
  const units: DocmapUnit[] = [];
  const seen = new Set<string>();
  for (const map of maps) {
    const historyDir = join(dirname(map), "history");
    if (seen.has(historyDir) || !isDir(historyDir)) continue;
    seen.add(historyDir);
    units.push(...collectUnits(historyDir));
  }
  const byKey = new Map(units.map((u) => [u.key, u] as const));
  for (const map of maps) {
    const base = dirname(map);
    for (const line of readFileSync(map, "utf8").split("\n")) {
      for (const target of mapLinks(line, base)) {
        const unit = byKey.get(target) ?? byKey.get(dirname(target));
        if (unit && !unit.mapLines.includes(line)) unit.mapLines.push(line);
      }
    }
  }
  return docmapCorpusFrom(root, maps, units);
}

/** 단위 목록에서 토큰·문서 빈도를 만든다. 평가 스크립트가 단위 부분집합으로도 부른다. */
export function docmapCorpusFrom(root: string, maps: readonly string[], units: readonly DocmapUnit[]): DocmapCorpus {
  const tokens = new Map<DocmapUnit, readonly string[]>();
  const termCounts = new Map<DocmapUnit, Map<string, number>>();
  const df = new Map<string, number>();
  let total = 0;
  for (const unit of units) {
    const toks = docmapTokens(unitText(unit));
    tokens.set(unit, toks);
    total += toks.length;
    const counts = new Map<string, number>();
    for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
    termCounts.set(unit, counts);
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { root, maps, units, tokens, termCounts, df, avgLen: total / (units.length || 1) || 1, bodyDf: new Map() };
}

function idfFor(records: number, df: number): number {
  return Math.log(1 + (records - df + 0.5) / (df + 0.5));
}

function docmapIdf(corpus: DocmapCorpus, term: string): number {
  return idfFor(corpus.units.length, corpus.df.get(term) ?? 0);
}

/**
 * 헤더나 본문 앞 8KB에 `term`이 있는 기록 수. `stopAt`에 닿거나 닿을 수 없게 되면 일찍 멈추고, 그 부분 값은
 * 메모하지 않는다. 한글 2글자 조각은 부분 문자열, ASCII 낱말은 낱말 경계로 센다(토큰화와 같은 뜻).
 */
function countRecords(corpus: DocmapCorpus, term: string, stopAt = Number.POSITIVE_INFINITY): number {
  const memo = corpus.bodyDf.get(term);
  if (memo !== undefined) return memo;
  const word = /^[a-z0-9_]+$/.test(term) ? new RegExp(`(?<![a-z0-9_])${term}(?![a-z0-9_])`) : undefined;
  const units = corpus.units;
  let n = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if ((word ? word.test(u.body) : u.body.includes(term)) || corpus.termCounts.get(u)!.has(term)) n++;
    if (Number.isFinite(stopAt) && (n >= stopAt || n + (units.length - 1 - i) < stopAt)) return n;
  }
  corpus.bodyDf.set(term, n);
  return n;
}

/** 기록 `share` 이상(최소 10개)에 나오는 낱말. 기록이 적으면 흔한지 판단할 수 없어 아무것도 빼지 않는다. */
function commonIn(corpus: DocmapCorpus, term: string, share: number): boolean {
  const need = Math.max(GENERIC_MIN_RECORDS, share * corpus.units.length);
  return countRecords(corpus, term, need) >= need;
}

/** 긴 prompt는 앞 1000자와 뒤 1000자를 본다. */
function queryText(query: string): string {
  return query.length <= QUERY_HEAD_CHARS + QUERY_TAIL_CHARS ? query : `${query.slice(0, QUERY_HEAD_CHARS)}\n${query.slice(-QUERY_TAIL_CHARS)}`;
}

/** 질의 낱말에서 한 글자 한글(조사·관형사), 시점 낱말, 영어 기능어를 뺀다. */
function queryTerms(query: string): string[] {
  return [...new Set(docmapTokens(queryText(query)))].filter(
    (w) => !/^[가-힣]$/.test(w) && !Object.hasOwn(TEMPORAL_TERMS, w) && !Object.hasOwn(ENGLISH_STOP, w),
  );
}

/** 순위·조건에 쓰는 질의 낱말: 말뭉치에 있고, 거의 모든 기록 본문에 나오는 조사(「에서」「으로」)가 아닌 것. */
export function docmapQueryTerms(corpus: DocmapCorpus, query: string): string[] {
  return queryTerms(query).filter((w) => corpus.df.has(w) && !commonIn(corpus, w, PARTICLE_SHARE));
}

/** 점수가 같으면 RECORD 날짜가 새로운 기록을 앞에 둔다. */
export function rankDocmap(corpus: DocmapCorpus, query: string, terms = docmapQueryTerms(corpus, query)): DocmapCandidate[] {
  if (corpus.units.length === 0) return [];
  const out: DocmapCandidate[] = [];
  for (const unit of corpus.units) {
    const counts = corpus.termCounts.get(unit)!;
    const len = corpus.tokens.get(unit)!.length;
    let score = 0;
    for (const w of terms) {
      const f = counts.get(w);
      if (!f) continue;
      score += (docmapIdf(corpus, w) * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * len) / corpus.avgLen));
    }
    if (score > 0) out.push({ unit, score });
  }
  return out.sort((a, b) => b.score - a.score || (a.unit.date < b.unit.date ? 1 : a.unit.date > b.unit.date ? -1 : 0));
}

export interface DocmapSignals {
  /** 1위 점수 ÷ 최대 IDF. */
  readonly score: number;
  /** 흔한 낱말을 뺀 질의 낱말의 헤더 IDF 합 대비 1위가 담은 몫. 0~1. */
  readonly coverage: number;
  /** 1위가 담은 질의 낱말마다 본문 IDF ÷ 최대 IDF의 합. 기록 본문에서도 드문 낱말일수록 크다. */
  readonly evidence: number;
}

export function docmapSignals(corpus: DocmapCorpus, top: DocmapCandidate, terms: readonly string[]): DocmapSignals {
  const counts = corpus.termCounts.get(top.unit)!;
  const records = corpus.units.length;
  // 기록 하나에만 있는 낱말의 IDF. 점수·근거를 이것으로 나눠 기록 수와 무관한 단위로 맞춘다.
  const unit = idfFor(records, 1);
  let all = 0;
  let hit = 0;
  let evidence = 0;
  for (const w of terms) {
    if (counts.has(w)) evidence += idfFor(records, countRecords(corpus, w)) / unit;
    if (commonIn(corpus, w, GENERIC_SHARE)) continue;
    const idf = docmapIdf(corpus, w);
    all += idf;
    if (counts.has(w)) hit += idf;
  }
  return { score: top.score / unit, coverage: all > 0 ? hit / all : 0, evidence };
}

/** 드문 낱말이 여럿 맞고 1위가 질의의 일정 몫을 설명하거나, 짧은 질문을 1위가 거의 다 설명하면 붙인다. */
export function docmapPasses(s: DocmapSignals): boolean {
  return (s.score >= DOCMAP_MIN_SCORE && s.coverage >= DOCMAP_MIN_COVERAGE) || (s.coverage >= DOCMAP_FOCUSED_COVERAGE && s.evidence >= DOCMAP_FOCUSED_EVIDENCE);
}

function supersededTarget(corpus: DocmapCorpus, unit: DocmapUnit): DocmapUnit | undefined {
  const m = /^superseded-by\s+(\S+)/i.exec(unit.fields.STATUS ?? "");
  if (!m) return undefined;
  const ref = m[1]!.replace(/[`'"]/g, "");
  for (const base of [corpus.root, dirname(unit.file)]) {
    const target = resolve(base, ref);
    const found = corpus.units.find((u) => u.key === target || u.files.includes(target) || u.key === dirname(target));
    if (found && found !== unit) return found;
  }
  return undefined;
}

/** 질문이 가리키는 날짜(`days`, YYYY-MM-DD) 또는 「최근」 의도. 오늘·어제·그제, 2026-10-16, 10월 16일, 10-16, 10/16. */
export type DocmapDateIntent = { readonly days: readonly string[] } | { readonly recent: true };

export function docmapDateIntent(query: string, now = new Date()): DocmapDateIntent | undefined {
  const text = queryText(query);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = ymd(now);
  const days = new Set<string>();
  const back = (n: number) => days.add(ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n)));
  if (/오늘|\btoday\b/i.test(text)) back(0);
  if (/어제|\byesterday\b/i.test(text)) back(1);
  if (/그제|그저께/.test(text)) back(2);
  const add = (y: number | undefined, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    let year = y ?? now.getFullYear();
    // 연도 없이 쓴 날짜가 오늘 뒤면 작년을 가리킨 것으로 본다.
    if (y === undefined && `${year}-${pad(m)}-${pad(d)}` > today) year--;
    days.add(`${year}-${pad(m)}-${pad(d)}`);
  };
  for (const m of text.matchAll(/(?<!\d)(20\d{2})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/g)) add(Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) add(undefined, Number(m[1]), Number(m[2]));
  for (const m of text.matchAll(/(?<![\d./-])(\d{1,2})[-/](\d{2})(?![\d./-])/g)) add(undefined, Number(m[1]), Number(m[2]));
  if (days.size > 0) return { days: [...days] };
  return RECENT_INTENT.test(text) ? { recent: true } : undefined;
}

/**
 * 상위 후보를 고르고 superseded-by를 최대 3번 따라간다. 같은 단위는 한 번만 남긴다.
 * 날짜를 물으면 그 날짜 기록을 1위 대비 비율의 절반까지 넓혀 앞에 둔다. 「최근」을 물으면 비율을 넘은 후보 중
 * 새로운 기록부터 고르되 1위는 남긴다. 같은 주제 기록이 여럿이면 가장 새 기록이 빠지지 않게 하려는 것이다.
 */
export function pickDocmapCandidates(
  corpus: DocmapCorpus,
  ranked: readonly DocmapCandidate[],
  limit = DOCMAP_MAX_CANDIDATES,
  ratio = DOCMAP_CANDIDATE_RATIO,
  intent?: DocmapDateIntent,
): DocmapCandidate[] {
  const top = ranked[0];
  if (!top) return [];
  let order = ranked.filter((c) => c.score >= top.score * ratio);
  if (intent && "days" in intent) {
    const dated = ranked.filter((c) => intent.days.includes(c.unit.date) && c.score >= (top.score * ratio) / 2);
    order = [...dated, ...order.filter((c) => !dated.includes(c))];
  } else if (intent) {
    order = [...order].sort((a, b) => (a.unit.date < b.unit.date ? 1 : a.unit.date > b.unit.date ? -1 : 0));
    const at = order.indexOf(top);
    if (at >= limit) order.splice(limit - 1, 0, ...order.splice(at, 1));
  }
  const picked: DocmapCandidate[] = [];
  for (const c of order) {
    if (picked.length >= limit) break;
    let unit = c.unit;
    for (let hop = 0; hop < SUPERSEDE_HOPS; hop++) {
      const next = supersededTarget(corpus, unit);
      if (!next) break;
      unit = next;
    }
    if (picked.some((p) => p.unit === unit)) continue;
    picked.push(unit === c.unit ? c : { unit, score: c.score, supersededFrom: c.unit.file });
  }
  return picked;
}

/** 후보 파일들의 `## ` 절을 한 말뭉치로 BM25해 질문과 가장 맞는 절과 그 안의 가장 맞는 줄을 고른다. */
export function bestDocmapSections(files: readonly string[], query: string): Map<string, DocmapSection> {
  type Sec = { file: string; heading: string; start: number; end: number; lines: string[]; toks: string[] };
  const secs: Sec[] = [];
  for (const file of files) {
    const lines = readHead(file, BODY_MAX_BYTES).split("\n");
    let cur: Sec = { file, heading: "", start: 1, end: 1, lines: [], toks: [] };
    lines.forEach((line, i) => {
      if (/^##\s/.test(line) && cur.lines.length > 0) {
        cur.end = i;
        secs.push(cur);
        cur = { file, heading: line.replace(/^#+\s*/, "").trim(), start: i + 1, end: i + 1, lines: [], toks: [] };
      } else if (/^##\s/.test(line)) {
        cur.heading = line.replace(/^#+\s*/, "").trim();
      }
      cur.lines.push(line);
    });
    cur.end = lines.length;
    secs.push(cur);
  }
  // 제목·RECORD 헤더는 SCOPE로 이미 보여 주므로 구간 고르기에서 뺀다. 넣으면 머리말이 늘 이긴다.
  for (const s of secs) s.toks = docmapTokens(s.lines.filter((l) => !HEADER_LINE.test(l.trim())).join("\n"));
  const n = secs.length;
  const df = new Map<string, number>();
  for (const s of secs) for (const t of new Set(s.toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = secs.reduce((a, s) => a + s.toks.length, 0) / (n || 1) || 1;
  const q = queryTerms(query);
  const idf = (w: string) => { const d = df.get(w) ?? 0; return Math.log(1 + (n - d + 0.5) / (d + 0.5)); };
  const best = new Map<string, { score: number; sec: Sec }>();
  for (const s of secs) {
    const counts = new Map<string, number>();
    for (const t of s.toks) counts.set(t, (counts.get(t) ?? 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = counts.get(w);
      if (f) score += (idf(w) * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * s.toks.length) / avg));
    }
    const prev = best.get(s.file);
    if (!prev || score > prev.score) best.set(s.file, { score, sec: s });
  }
  const out = new Map<string, DocmapSection>();
  for (const [file, { sec }] of best) {
    let bestLine = "";
    let bestLineScore = -1;
    for (const line of sec.lines) {
      const text = line.trim();
      if (!text || /^#/.test(text) || HEADER_LINE.test(text)) continue;
      const toks = new Set(docmapTokens(text));
      let s = 0;
      for (const w of q) if (toks.has(w)) s += idf(w);
      if (s > bestLineScore) { bestLineScore = s; bestLine = text; }
    }
    const plain = bestLine.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").replace(/^[-|>\d.)\s]+/, "").trim();
    const excerpt = plain.length > EXCERPT_CHARS ? `${plain.slice(0, EXCERPT_CHARS - 1)}…` : plain;
    out.set(file, { heading: sec.heading || "(머리말)", start: sec.start, end: sec.end, excerpt });
  }
  return out;
}

function rel(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function renderDocmapRoute(corpus: DocmapCorpus, candidates: readonly DocmapCandidate[], sections: ReadonlyMap<string, DocmapSection>, maxChars = DOCMAP_MAX_CHARS): string {
  const blocks = candidates.map((c, i) => {
    const u = c.unit;
    const lines = [`${i + 1}. ${rel(corpus.root, u.file)}${u.fields.STATUS ? ` (STATUS: ${clip(u.fields.STATUS, 60)})` : ""}`];
    if (c.supersededFrom) lines.push(`   대체 전: ${rel(corpus.root, c.supersededFrom)}`);
    if (u.mapLines[0]) lines.push(`   지도: ${clip(u.mapLines[0].replace(/\]\([^)]*\)/g, "]").replace(/^[-*]\s*/, "").replace(/\s*\|\s*/g, " "), 200)}`);
    else if (u.title) lines.push(`   제목: ${clip(u.title, 160)}`);
    if (u.fields.SCOPE) lines.push(`   SCOPE: ${clip(u.fields.SCOPE, 160)}`);
    const sec = sections.get(u.file);
    if (sec) lines.push(`   구간: ## ${clip(sec.heading, 60)} (L${sec.start}-${sec.end})${sec.excerpt ? ` — ${sec.excerpt}` : ""}`);
    return lines;
  });
  const head = `[문서 지도 후보] ${DOCMAP_INSTRUCTION}`;
  const join2 = () => [head, ...blocks.map((b) => b.join("\n"))].join("\n");
  let text = join2();
  // 넘치면 뒤 후보부터 줄을 덜어 낸다: 발췌 → SCOPE → 지도 줄 순서.
  for (const drop of [/^ {3}구간: /, /^ {3}SCOPE: /, /^ {3}(지도|제목): /]) {
    for (let i = blocks.length - 1; i >= 0 && text.length > maxChars; i--) {
      const idx = blocks[i]!.findIndex((l) => drop.test(l));
      if (idx < 0) continue;
      if (drop.source.includes("구간")) blocks[i]![idx] = blocks[i]![idx]!.replace(/ — .*$/, "");
      else blocks[i]!.splice(idx, 1);
      text = join2();
    }
  }
  return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
}

/** 요청 하나에 대한 전 과정. 조건 미달이거나 지도·기록이 없으면 undefined. 예외는 호출부가 삼킨다. */
export function routeDocmap(cwd: string, prompt: string, now = new Date()): DocmapRoute | undefined {
  const found = findDocmapProject(cwd);
  if (!found) return undefined;
  const maps = findDocmapMaps(found.root, found.project);
  if (maps.length === 0) return undefined;
  const corpus = buildDocmapCorpus(found.root, maps);
  const terms = docmapQueryTerms(corpus, prompt);
  const ranked = rankDocmap(corpus, prompt, terms);
  const top = ranked[0];
  if (!top) return undefined;
  const signals = docmapSignals(corpus, top, terms);
  if (!docmapPasses(signals)) return undefined;
  const candidates = pickDocmapCandidates(corpus, ranked, DOCMAP_MAX_CANDIDATES, DOCMAP_CANDIDATE_RATIO, docmapDateIntent(prompt, now));
  const sections = bestDocmapSections(candidates.map((c) => c.unit.file), prompt);
  return { topScore: top.score, signals, candidates, text: renderDocmapRoute(corpus, candidates, sections) };
}
