// 프로젝트 문서 지도(doc/README.md)·하위 지도와 작업 기록의 `RECORD:` 헤더만으로 요청마다 BM25를 만들고 버린다.
// 2026-10-16 실측(doc/history/2026/10/16-rag-reinvestigation): 격리 표본 12건에서 에이전트는 지도를 0/12 열었고,
// 하위 지도에만 있던 정답 기록 2건을 놓쳤다. 본문까지 색인하면 무관 질문 점수가 같이 올라 헤더 전용이 낫다
// (hit@3 37/45 대 31/45). 상시 색인·캐시·LLM 호출은 두지 않는다. 읽기 실패는 호출부가 조용히 버린다.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * 턴 단위 하한. 2026-10-16 질문 세트의 홀수 문항(보정)에서 무관 질문 최고점 9.52 바로 위 0.5 단위로 정했고,
 * 짝수 문항(평가)에는 손대지 않았다. BM25 점수는 기록 수에 따라 커지므로 기록이 적은 프로젝트에서는 더 보수적이다.
 * 근거: doc/history/2026/10/16-rag-reinvestigation/maker-DocmapRoute.md.
 */
export const DOCMAP_MIN_SCORE = 10;
/**
 * 길이에 강한 두 번째 조건. BM25 1위 점수는 질의 낱말 점수의 합이라 긴 prompt에서 하한을 거의 늘 넘는다
 * (2026-10-17 실제 prompt 재생: 300자 초과 120건 중 119건 주입). 그래서 질의 낱말 중 기록 말뭉치에 있는 것의
 * IDF 합 대비, 1위 기록이 실제로 담은 낱말의 IDF 합 비율을 본다. 질문 하나를 겨냥한 prompt는 이 비율이 높고,
 * 여러 주제를 섞은 긴 지시는 낮다. 0.25는 보정 세트(홀수 문항)에서 기존 하한으로 전달되던 답을 하나도 잃지 않는
 * 가장 큰 0.05 단위 값이다.
 */
export const DOCMAP_MIN_COVERAGE = 0.25;
export const DOCMAP_MAX_CANDIDATES = 3;
export const DOCMAP_MAX_CHARS = 1500;
const QUERY_MAX_CHARS = 1000;
const HEAD_BYTES = 8192;
const BODY_MAX_BYTES = 262_144;
const EXCERPT_CHARS = 160;
const SUPERSEDE_HOPS = 3;
const HEADER_LINE = /^(?:#\s|RECORD:|SCOPE:|PATHS:|DATE:|STATUS:)/;
/** 1위 대비 이 비율 미만인 뒤 후보는 공통 낱말("기록" 등)로만 걸린 잡음이라 넣지 않는다. */
export const DOCMAP_CANDIDATE_RATIO = 0.5;

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
}

export interface DocmapCorpus {
  readonly root: string;
  readonly maps: readonly string[];
  readonly units: readonly DocmapUnit[];
  readonly tokens: ReadonlyMap<DocmapUnit, readonly string[]>;
  readonly termCounts: ReadonlyMap<DocmapUnit, ReadonlyMap<string, number>>;
  readonly df: ReadonlyMap<string, number>;
  readonly avgLen: number;
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
  readonly coverage: number;
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
        const { title, fields } = parseHead(readHead(file, HEAD_BYTES));
        units.push({ file, files, key: path, title, fields, mapLines: [] });
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
  return { root, maps, units, tokens, termCounts, df, avgLen: total / (units.length || 1) || 1 };
}

function docmapIdf(corpus: DocmapCorpus, term: string): number {
  const d = corpus.df.get(term) ?? 0;
  return Math.log(1 + (corpus.units.length - d + 0.5) / (d + 0.5));
}

function queryTerms(query: string): string[] {
  return [...new Set(docmapTokens(query.slice(0, QUERY_MAX_CHARS)))];
}

export function rankDocmap(corpus: DocmapCorpus, query: string): DocmapCandidate[] {
  if (corpus.units.length === 0) return [];
  const q = queryTerms(query).filter((w) => corpus.df.has(w));
  const out: DocmapCandidate[] = [];
  for (const unit of corpus.units) {
    const counts = corpus.termCounts.get(unit)!;
    const len = corpus.tokens.get(unit)!.length;
    let score = 0;
    for (const w of q) {
      const f = counts.get(w);
      if (!f) continue;
      score += (docmapIdf(corpus, w) * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * len) / corpus.avgLen));
    }
    if (score > 0) out.push({ unit, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 질의 낱말 중 말뭉치에 있는 것의 IDF 합 대비, `unit`이 담은 낱말의 IDF 합. 0~1. */
export function docmapCoverage(corpus: DocmapCorpus, query: string, unit: DocmapUnit): number {
  const counts = corpus.termCounts.get(unit);
  if (!counts) return 0;
  let all = 0;
  let hit = 0;
  for (const w of queryTerms(query)) {
    if (!corpus.df.has(w)) continue;
    const idf = docmapIdf(corpus, w);
    all += idf;
    if (counts.has(w)) hit += idf;
  }
  return all > 0 ? hit / all : 0;
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

/** 상위 후보를 고르고 superseded-by를 최대 3번 따라간다. 같은 단위는 한 번만 남긴다. */
export function pickDocmapCandidates(corpus: DocmapCorpus, ranked: readonly DocmapCandidate[], limit = DOCMAP_MAX_CANDIDATES, ratio = DOCMAP_CANDIDATE_RATIO): DocmapCandidate[] {
  const picked: DocmapCandidate[] = [];
  const floor = (ranked[0]?.score ?? 0) * ratio;
  for (const c of ranked) {
    if (picked.length >= limit || c.score < floor) break;
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

/** 요청 하나에 대한 전 과정. 하한 미만이거나 지도·기록이 없으면 undefined. 예외는 호출부가 삼킨다. */
export function routeDocmap(cwd: string, prompt: string, minScore = DOCMAP_MIN_SCORE, minCoverage = DOCMAP_MIN_COVERAGE): DocmapRoute | undefined {
  const found = findDocmapProject(cwd);
  if (!found) return undefined;
  const maps = findDocmapMaps(found.root, found.project);
  if (maps.length === 0) return undefined;
  const corpus = buildDocmapCorpus(found.root, maps);
  const ranked = rankDocmap(corpus, prompt);
  const top = ranked[0];
  if (!top || top.score < minScore) return undefined;
  const coverage = docmapCoverage(corpus, prompt, top.unit);
  if (coverage < minCoverage) return undefined;
  const candidates = pickDocmapCandidates(corpus, ranked);
  const sections = bestDocmapSections(candidates.map((c) => c.unit.file), prompt);
  return { topScore: top.score, coverage, candidates, text: renderDocmapRoute(corpus, candidates, sections) };
}
