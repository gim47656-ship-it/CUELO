/**
 * 문서 지도 진단. 요청할 때 돌리는 결정론적 점검이며 파일을 쓰지 않고, 모델을 부르지 않고, 항상 exit 0이다.
 *
 *   bun docmap-lint.ts [cwd] [--json] [--limit N]
 *
 * 1. 지도에 링크가 없는 기록(탐색·완결성 문제다. 검색은 지도 링크와 무관하게 모든 기록을 색인한다)과, 검색이 제목만으로
 *    보게 되는 헤더 누락(`RECORD:`·`SCOPE:` 없음).
 * 2. 지도·HANDOFF·기록의 상대 링크 중 대상이 없는 것(`*-handoff-closure.md` 사본은 개수만).
 * 3. `superseded-by`의 대상 없음·사슬 길이 초과·순환.
 * 4. 종합 절 후보: 여러 기록의 SCOPE에 되풀이되고 본문에서도 SCOPE에 적힌 만큼 집중되지만 어떤 정본 문서의 제목·절 제목에도 없는 낱말.
 *
 * 발상은 Karpathy의 LLM-wiki gist 「Lint」 단계와 그 구현체(고아·깨진 링크·빠진 개념 점검)에서 가져왔고 코드는 쓰지 않았다.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { buildDocmapCorpus, docmapTokens, findDocmapMaps, findDocmapProject, type DocmapUnit } from "./docmap-search";

/** docmap-search의 SUPERSEDE_HOPS와 같다. 그보다 긴 사슬은 검색이 끝까지 따라가지 않는다. */
const MAX_SUPERSEDE_HOPS = 3;
const SYNTHESIS_MIN_RECORDS = 3;
/** SCOPE에 이 비율을 넘는 기록이 적은 낱말은 너무 흔해서 한 주제로 보지 않는다. */
const GENERIC_SHARE = 0.15;
/** 후보 낱말의 (SCOPE에 적은 기록 수) ÷ (본문 앞 8KB에 나오는 기록 수) 하한. 실제 저장소에서 주제 .2~.5, 호스트·과정어 .03~.16. */
const MIN_SCOPE_FOCUS = 0.2;
const HEAD_BYTES = 8192;
const DEFAULT_LIMIT = 15;
const SNAPSHOT_NAME = /-handoff-closure\.md$/;

export interface LinkRef { readonly source: string; readonly line: number; readonly href: string; readonly target: string }
export interface SupersedeProblem { readonly record: string; readonly ref: string; readonly chain: readonly string[] }
export interface SynthesisCandidate { readonly term: string; readonly records: number; readonly samples: readonly string[] }

export interface DocmapLintReport {
  readonly root: string;
  readonly maps: readonly string[];
  readonly recordCount: number;
  readonly unmapped: {
    /** 지도에는 없지만 다른 문서(기록·규칙·HANDOFF)가 링크하는 기록. */
    readonly linkedElsewhere: readonly string[];
    /** 어디에서도 링크하지 않는 기록. */
    readonly noInboundLink: readonly string[];
  };
  readonly headerGaps: {
    /** 대표 파일 머리에 `RECORD:` 줄이 없는 기록. */
    readonly noRecordHeader: readonly string[];
    /** 대표 파일 머리에 `SCOPE:`가 없는 기록. 검색은 이런 기록을 제목·지도 줄로만 본다. */
    readonly noScope: readonly string[];
  };
  readonly missingTargets: {
    readonly real: readonly LinkRef[];
    /** `*-handoff-closure.md` 사본 안의 끊어진 링크 수. 사본이 HANDOFF의 루트 기준 링크를 그대로 옮겨서 생긴다. */
    readonly snapshotCount: number;
    /** 저장소 밖을 가리켜 점검에서 뺀 링크 수. */
    readonly outsideRoot: number;
  };
  readonly superseded: {
    readonly missingTarget: readonly SupersedeProblem[];
    readonly tooLong: readonly SupersedeProblem[];
    readonly cycles: readonly SupersedeProblem[];
  };
  readonly synthesis: readonly SynthesisCandidate[];
  /** 읽지 못해 점검에서 빠진 .md 파일과 폴더(저장소 상대 경로). 비어 있지 않으면 위 결과는 그만큼 불완전하다. */
  readonly unreadable: { readonly files: readonly string[]; readonly dirs: readonly string[] };
}

function rel(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

interface Unreadable { readonly files: Set<string>; readonly dirs: Set<string> }

function readText(path: string, bad: Unreadable): string {
  try { return readFileSync(path, "utf8"); } catch { bad.files.add(path); return ""; }
}

function walkMarkdown(root: string, bad: Unreadable): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { bad.dirs.add(dir); return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) visit(path);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(path);
    }
  };
  visit(root);
  return out;
}

/** 코드 블록·인라인 코드 밖의 상대 링크. 줄 번호는 1부터. docmap-search의 mapLinks와 같은 뜻이되 깨진 퍼센트 부호화에서 던지지 않는다. */
export function extractRelativeLinks(text: string): Array<{ line: number; href: string }> {
  const out: Array<{ line: number; href: string }> = [];
  let fence: { mark: string; len: number } | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const fenceLine = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
    // 여는 ``` 줄의 정보 문자열에 백틱이 있으면 펜스가 아니라 인라인 코드다.
    if (fenceLine && (fence || fenceLine[1]![0] !== "`" || !fenceLine[2]!.includes("`"))) {
      const run = fenceLine[1]!;
      if (!fence) fence = { mark: run[0]!, len: run.length };
      // 닫는 펜스는 같은 문자로 여는 쪽 이상 길고 뒤에 글이 없어야 한다. 짧은 ```는 ```` 안의 글이다.
      else if (run[0] === fence.mark && run.length >= fence.len && fenceLine[2]!.trim() === "") fence = undefined;
      continue;
    }
    if (fence) continue;
    const plain = lines[i]!.replace(/`[^`]*`/g, "");
    // CommonMark: 목적지(공백 없는 글 또는 <…>) 뒤에는 공백과 따옴표·괄호 제목, 그리고 `)`만 올 수 있다. `[x](읽은 줄)`은 링크가 아니다.
    for (const m of plain.matchAll(/\]\(\s*(<[^<>\n]+>|[^<)\s][^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) {
      let href = m[1]!;
      if (href.startsWith("<")) href = href.slice(1, -1);
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) continue;
      href = href.replace(/[#?].*$/, "");
      if (!href) continue;
      out.push({ line: i + 1, href });
    }
  }
  return out;
}

function resolveHref(base: string, href: string): string {
  try { return resolve(base, decodeURI(href)); } catch { return resolve(base, href); }
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}


function headText(file: string, bad: Unreadable): string {
  return readText(file, bad).slice(0, HEAD_BYTES).split(/\n## /, 1)[0]!;
}

/** 이 기록들이 가리키는 `superseded-by` 참조. docmap-search의 supersededTarget과 같은 해석(root 기준, 그다음 대표 파일 폴더 기준). */
function supersedeRef(unit: DocmapUnit): string | undefined {
  const m = /^superseded-by\s+(\S+)/i.exec(unit.fields.STATUS ?? "");
  return m ? m[1]!.replace(/[`'"]/g, "") : undefined;
}

function findSupersedeTarget(root: string, units: readonly DocmapUnit[], unit: DocmapUnit, ref: string): { exists: boolean; unit?: DocmapUnit; path?: string } {
  let path: string | undefined;
  for (const base of [root, dirname(unit.file)]) {
    const target = resolve(base, ref);
    // 기록 폴더 안의 파일을 가리키면 그 파일이 실제로 있어야 한다. 폴더 이름만 맞는 것은 대상이 있는 것이 아니다.
    const found = units.find((u) => u.key === target || u.files.includes(target) || (u.key === dirname(target) && existsSync(target)));
    if (found) return { exists: true, unit: found };
    if (!path && existsSync(target)) path = target;
  }
  return { exists: path !== undefined, path };
}

function headings(text: string): string {
  return text.split("\n").filter((l) => /^#{1,6}\s/.test(l)).join(" ");
}

export function lintDocmap(cwd: string): DocmapLintReport | undefined {
  const found = findDocmapProject(cwd);
  if (!found) return undefined;
  const { root, project } = found;
  const maps = findDocmapMaps(root, project);
  const corpus = buildDocmapCorpus(root, maps);
  const historyDirs = [...new Set(maps.map((m) => join(dirname(m), "history")))];
  const isRecord = (u: DocmapUnit) => historyDirs.some((d) => u.key.startsWith(d + sep));
  const records = corpus.units.filter(isRecord);
  const canonical = corpus.units.filter((u) => !isRecord(u));
  const recordFiles = new Set(records.flatMap((r) => r.files));

  // 모든 .md의 링크를 한 번 읽는다. 지도·인계·기록은 대상 점검에도 쓴다. 읽지 못한 파일·폴더는 빼지 않고 센다.
  const bad: Unreadable = { files: new Set(), dirs: new Set() };
  const allMarkdown = walkMarkdown(root, bad);
  const linksBySource = new Map<string, Array<{ line: number; href: string; target: string }>>();
  for (const file of allMarkdown) {
    const base = dirname(file);
    linksBySource.set(file, extractRelativeLinks(readText(file, bad)).map((l) => ({ ...l, target: resolveHref(base, l.href) })));
  }

  // 1. 지도에 없는 기록
  // 기록 폴더 자체나 그 폴더의 .md 기록 파일로 가는 링크만 센다. evidence/ 파일로만 가는 링크는 기록을 가리키지 않는다.
  const linksTo = (r: DocmapUnit, sources: Iterable<string>) => {
    for (const s of sources) for (const l of linksBySource.get(s) ?? []) if (l.target === r.key || r.files.includes(l.target)) return true;
    return false;
  };
  const linkedElsewhere: string[] = [];
  const noInbound: string[] = [];
  for (const r of records) {
    if (linksTo(r, maps)) continue;
    const others = allMarkdown.filter((f) => f !== r.key && !f.startsWith(r.key + sep) && !SNAPSHOT_NAME.test(basename(f)));
    (linksTo(r, others) ? linkedElsewhere : noInbound).push(rel(root, r.key));
  }
  const noRecordHeader: string[] = [];
  const noScope: string[] = [];
  for (const r of records) {
    const head = headText(r.file, bad);
    if (!/^RECORD:/m.test(head)) noRecordHeader.push(rel(root, r.key));
    if (!r.fields.SCOPE) noScope.push(rel(root, r.key));
  }

  // 2. 끊어진 상대 링크
  const handoffs = new Set<string>([join(root, "HANDOFF.md"), join(project, "HANDOFF.md")]);
  for (const m of maps) handoffs.add(join(dirname(dirname(m)), "HANDOFF.md"));
  const sources = new Set<string>([...maps, ...[...handoffs].filter((f) => existsSync(f)), ...recordFiles]);
  const real: LinkRef[] = [];
  let snapshotCount = 0;
  let outsideRoot = 0;
  for (const source of [...sources].sort()) {
    const seen = new Set<string>();
    for (const l of linksBySource.get(source) ?? []) {
      if (!inside(root, l.target)) { outsideRoot++; continue; }
      if (existsSync(l.target)) continue;
      const dedupe = `${l.line}\t${l.href}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      if (SNAPSHOT_NAME.test(basename(source))) snapshotCount++;
      else real.push({ source: rel(root, source), line: l.line, href: l.href, target: rel(root, l.target) });
    }
  }

  // 3. superseded-by
  const missingTarget: SupersedeProblem[] = [];
  const tooLong: SupersedeProblem[] = [];
  const cycles: SupersedeProblem[] = [];
  // terminal: 기록이 아닌 곳(정본 문서 등)에 실제로 있는 마지막 대상. 사슬 길이에 한 단으로 센다.
  const next = new Map<DocmapUnit, { unit?: DocmapUnit; terminal?: string }>();
  const pointedAt = new Set<DocmapUnit>();
  for (const r of records) {
    const ref = supersedeRef(r);
    if (!ref) continue;
    const hit = findSupersedeTarget(root, records, r, ref);
    if (!hit.exists) missingTarget.push({ record: rel(root, r.key), ref, chain: [rel(root, r.key)] });
    next.set(r, { unit: hit.unit, terminal: hit.unit ? undefined : hit.path });
    if (hit.unit) pointedAt.add(hit.unit);
  }
  const seenCycles = new Set<string>();
  for (const [start] of next) {
    const path: DocmapUnit[] = [start];
    let cur = next.get(start)?.unit;
    while (cur && !path.includes(cur)) { path.push(cur); cur = next.get(cur)?.unit; }
    const terminal = cur ? undefined : next.get(path[path.length - 1]!)?.terminal;
    const chain = [...path.map((u) => rel(root, u.key)), ...(terminal ? [rel(root, terminal)] : [])];
    if (cur) {
      const members = path.slice(path.indexOf(cur));
      const id = members.map((u) => u.key).sort().join("|");
      if (!seenCycles.has(id)) {
        seenCycles.add(id);
        cycles.push({ record: rel(root, members[0]!.key), ref: supersedeRef(members[0]!) ?? "", chain: [...members.map((u) => rel(root, u.key)), rel(root, cur.key)] });
      }
    } else if (chain.length - 1 > MAX_SUPERSEDE_HOPS && !pointedAt.has(start)) {
      tooLong.push({ record: rel(root, start.key), ref: supersedeRef(start) ?? "", chain });
    }
  }

  // 4. 종합 절 후보
  const coverText = canonical.map((u) => [u.title, ...u.mapLines.map(stripLinks), headings(readText(u.file, bad))].join(" "));
  for (const f of allMarkdown) {
    if (recordFiles.has(f) || f.includes(`${sep}history${sep}`)) continue;
    const text = readText(f, bad);
    coverText.push([/^#\s+(.+)$/m.exec(text)?.[1] ?? "", headings(text)].join(" "));
  }
  const synthesis = synthesisCandidates(root, records, new Set(coverText.flatMap(docmapTokens)));

  return {
    root,
    maps: maps.map((m) => rel(root, m)),
    recordCount: records.length,
    unmapped: { linkedElsewhere: linkedElsewhere.sort(), noInboundLink: noInbound.sort() },
    headerGaps: { noRecordHeader: noRecordHeader.sort(), noScope: noScope.sort() },
    missingTargets: { real, snapshotCount, outsideRoot },
    superseded: { missingTarget, tooLong, cycles },
    synthesis,
    unreadable: { files: [...bad.files].map((f) => rel(root, f)).sort(), dirs: [...bad.dirs].map((d) => rel(root, d)).sort() },
  };
}

function stripLinks(line: string): string {
  return line.replace(/\]\([^)]*\)/g, "]");
}

function containsTerm(body: string, term: string): boolean {
  if (!/^[a-z0-9_]+$/.test(term)) return body.includes(term);
  return new RegExp(`(?<![a-z0-9_])${term}(?![a-z0-9_])`).test(body);
}

/**
 * 여러 기록의 SCOPE에 되풀이되지만 `covered`(정본 문서 제목·절 제목 낱말)에 없는 주제.
 * 낱말은 docmapTokens로 나눈다. 한글 2글자 조각은 읽기 어려우므로 조각이 나온 실제 낱말 중 가장 흔한 것으로 보여 주고,
 * 같은 낱말에서 나온 조각은 한 후보로 합친다. 일반어는 SCOPE 기록 비율 상한과 본문 대비 SCOPE 집중도 하한으로 뺀다.
 */
function synthesisCandidates(root: string, records: readonly DocmapUnit[], covered: ReadonlySet<string>): SynthesisCandidate[] {
  const headerCut = Math.max(SYNTHESIS_MIN_RECORDS, GENERIC_SHARE * records.length);
  const texts = new Map<DocmapUnit, string>();
  const recordsByTerm = new Map<string, Set<DocmapUnit>>();
  for (const r of records) {
    // 제목·지도 줄에는 「후속」「개선」 같은 과정 낱말이 섞이지만 SCOPE는 작성자가 주제로 적은 목록이다.
    const text = (r.fields.SCOPE ?? "").toLowerCase();
    texts.set(r, text);
    for (const tok of new Set(docmapTokens(text))) {
      if (tok.length < 2 || /^\d/.test(tok)) continue;
      const set = recordsByTerm.get(tok);
      if (set) set.add(r); else recordsByTerm.set(tok, new Set([r]));
    }
  }
  const eligible = new Set<string>();
  for (const [term, set] of recordsByTerm) {
    if (set.size < SYNTHESIS_MIN_RECORDS || set.size > headerCut || covered.has(term)) continue;
    // 집중도: 본문에서 그 낱말을 말하는 기록 중 SCOPE에도 적은 기록의 몫. 주제는 그것을 다루는 기록이 SCOPE에 적고,
    // 과정·상태·호스트 이름 같은 낱말은 본문 곳곳에 나오지만 SCOPE에는 드물게만 적힌다.
    const mentions = records.filter((r) => containsTerm(r.body, term)).length;
    if (set.size < MIN_SCOPE_FOCUS * mentions) continue;
    eligible.add(term);
  }
  // 조각 → 실제 낱말 → 그 낱말이 나온 기록
  const wordRecords = new Map<string, Set<DocmapUnit>>();
  const wordsOfTerm = new Map<string, Set<string>>();
  for (const [r, text] of texts) {
    for (const word of new Set(text.match(/[가-힣]+|[a-z0-9_]+/g) ?? [])) {
      const toks = docmapTokens(word).filter((t) => eligible.has(t));
      if (toks.length === 0) continue;
      const set = wordRecords.get(word);
      if (set) set.add(r); else wordRecords.set(word, new Set([r]));
      for (const t of toks) {
        const words = wordsOfTerm.get(t);
        if (words) words.add(word); else wordsOfTerm.set(t, new Set([word]));
      }
    }
  }
  const groups = new Map<string, Set<DocmapUnit>>();
  for (const term of eligible) {
    const words = [...(wordsOfTerm.get(term) ?? [])];
    const best = words.sort((a, b) => wordRecords.get(b)!.size - wordRecords.get(a)!.size || a.length - b.length)[0] ?? term;
    const group = groups.get(best) ?? new Set<DocmapUnit>();
    for (const r of wordRecords.get(best) ?? recordsByTerm.get(term)!) group.add(r);
    groups.set(best, group);
  }
  const out: SynthesisCandidate[] = [];
  for (const [term, set] of groups) {
    if (set.size < SYNTHESIS_MIN_RECORDS) continue;
    const samples = [...set].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3).map((u) => rel(root, u.file));
    out.push({ term, records: set.size, samples });
  }
  return out.sort((a, b) => b.records - a.records || a.term.localeCompare(b.term));
}

function section(title: string, count: number, items: readonly string[], limit: number, note?: string): string[] {
  const out = [`${title}: ${count}`];
  if (note) out.push(`  ${note}`);
  for (const item of items.slice(0, limit)) out.push(`  - ${item}`);
  if (items.length > limit) out.push(`  … ${items.length - limit}건 더 (--limit N 또는 --json)`);
  return out;
}

export function renderDocmapLint(r: DocmapLintReport, limit = DEFAULT_LIMIT): string {
  const chain = (p: SupersedeProblem) => `${p.chain.join(" → ")}${p.ref ? `  (superseded-by ${p.ref})` : ""}`;
  const lines: string[] = [`문서 지도 진단 (기록 ${r.recordCount}건, 지도 ${r.maps.length}개, 읽기 전용)`, ""];
  lines.push("1. 지도에 링크가 없는 기록 (탐색·완결성 문제. 검색은 지도 링크와 무관하게 모든 기록을 색인한다)");
  lines.push(...section("  다른 문서가 링크함", r.unmapped.linkedElsewhere.length, r.unmapped.linkedElsewhere, limit));
  lines.push(...section("  어디에서도 링크하지 않음", r.unmapped.noInboundLink.length, r.unmapped.noInboundLink, limit));
  lines.push(...section("  대표 파일에 RECORD: 헤더 없음", r.headerGaps.noRecordHeader.length, r.headerGaps.noRecordHeader, limit));
  lines.push(...section("  대표 파일에 SCOPE: 없음 (검색이 제목·지도 줄로만 봄)", r.headerGaps.noScope.length, r.headerGaps.noScope, limit));
  lines.push("", "2. 대상이 없는 상대 링크 (지도·HANDOFF·기록)");
  lines.push(...section("  실제로 끊어진 링크", r.missingTargets.real.length, r.missingTargets.real.map((l) => `${l.source}:${l.line} → ${l.href}`), limit));
  lines.push(`  handoff-closure 사본 안의 끊어진 링크: ${r.missingTargets.snapshotCount}건 (개별 표시 안 함)`);
  lines.push(`  저장소 밖을 가리켜 뺀 링크: ${r.missingTargets.outsideRoot}건`);
  lines.push("", "3. superseded-by 문제");
  lines.push(...section("  대상 없음", r.superseded.missingTarget.length, r.superseded.missingTarget.map((p) => `${p.record} → ${p.ref}`), limit));
  lines.push(...section(`  사슬 ${MAX_SUPERSEDE_HOPS}단 초과`, r.superseded.tooLong.length, r.superseded.tooLong.map(chain), limit));
  lines.push(...section("  순환", r.superseded.cycles.length, r.superseded.cycles.map(chain), limit));
  lines.push("", `4. 종합 절 후보 (기록 ${SYNTHESIS_MIN_RECORDS}건 이상의 SCOPE에 나오지만 정본 문서 제목·절 제목에 없는 낱말)`);
  lines.push(...section("  후보", r.synthesis.length, r.synthesis.map((c) => `${c.term} (${c.records}건): ${c.samples.join(", ")}`), limit));
  const bad = [...r.unreadable.dirs.map((d) => `폴더 ${d}`), ...r.unreadable.files.map((f) => `파일 ${f}`)];
  lines.push("", ...section("읽지 못해 점검에서 빠진 경로", bad.length, bad, limit));
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const li = args.indexOf("--limit");
  const limit = li >= 0 && Number.isInteger(Number(args[li + 1])) && Number(args[li + 1]) > 0 ? Number(args[li + 1]) : DEFAULT_LIMIT;
  const cwd = args.find((a, i) => !a.startsWith("--") && !(li >= 0 && i === li + 1)) ?? process.cwd();
  const fail = (message: string) => console.log(json ? JSON.stringify({ error: message }, null, 2) : message);
  try {
    const report = lintDocmap(cwd);
    if (!report) fail("문서 지도를 찾지 못했다: HANDOFF.md나 .git이 있는 위치에서 실행한다.");
    else console.log(json ? JSON.stringify(report, null, 2) : renderDocmapLint(report, limit));
  } catch (err) {
    fail(`문서 지도 진단 중 오류: ${err instanceof Error ? err.message : String(err)}`);
  }
}
