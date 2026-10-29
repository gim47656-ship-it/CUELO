import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { htmlText } from "../slop-gate/extract";

/**
 * draft-first 범위 확인(RULES 「Gemini writes every piece of text content first」; 2026-10-27 사용자 보고: HTML 앞 네 문단만 draft하고
 * 나머지 문단은 직접 썼다). 판단 단위는 draft 호출 수가 아니라 새로 쓴 글 덩어리다.
 * write·edit가 더하는 덩어리마다 문자 4-gram이 그 파일의 바뀌기 전 내용이나 쓸 수 있는 draft 결과에 절반 이상 있으면 덮인 것으로 본다.
 * 사실·오타·슬롭을 고친 문장과 마크업·배치만 바꾼 글은 대부분의 4-gram이 남아 덮이고, 새 예시·설명·결론은 남지 않는다.
 * 유사도는 출처의 증명이 아니라 단서다: 그래서 같은 덩어리에 한 번만 멈추고, 그대로 다시 보내면 통과시킨다.
 */

// 아래 값은 개입을 언제 띄울지 정하는 경험적 자문 기준이지 출처의 판정 기준이 아니다. 근거와 놓치는 경우는
// doc/history/2026/10/27-draft-coverage/maker-DraftCoverage.md에 측정한 예와 함께 남긴다(한국어 문단 하나는 약 45~55자).
export const MIN_BLOCK_LETTERS = 20;
export const COVERED_RATIO = 0.5;
export const MIN_UNCOVERED_LETTERS = 100;
const GRAM = 4;

const PROSE_FILE = /\.(?:md|mdx|markdown|html?|xhtml)$/i;
const MARKUP_FILE = /\.(?:html?|xhtml)$/i;
// 태그 없는 markup 조각에서 CSS로 보는 줄: 선택자 여는 줄, 닫는 줄, 한 줄에 선언 여러 개, 한 줄 규칙. 속성 이름은 CSS처럼 소문자(또는
// `--` 사용자 속성)만 받고, 세미콜론 없는 마지막 선언은 `}` 바로 앞일 때만 인정한다(`Summary: …;` 같은 산문 줄을 빼지 않게).
const CSS_DECL = String.raw`(?:--[\w-]+|-?[a-z][a-z-]*)\s*:\s*[^;{}]+`;
const CSS_LINE = new RegExp(String.raw`^\s*(?:[^{}]*\{|\}[\s;]*|(?:[^{}]*\{\s*)?(?:${CSS_DECL};\s*)+\}?|[^{}]*\{\s*(?:${CSS_DECL};\s*)*${CSS_DECL};?\s*\})\s*$`);
// 규칙·프롬프트·스킬은 draft 대상이 아니다(RULES: code, configuration, rule files 제외). 슬롭 게이트가 면제하는 내부 기록
// (HANDOFF.md, doc/history/**, doc/README.md)도 이 확인에서 뺀다: 2026-10-28 감사에서 26회 차단 중 20회가 내부 기록이었고
// 12회는 예외 사유를 적고 같은 호출을 다시 보냈다(doc/history/2026/10/28-guard-audit). 사용자 승인 2026-10-28.
const RULE_NAME = /^(?:AGENTS|RULES|CLAUDE|SKILL|APPEND_SYSTEM|TITLE_SYSTEM|WATCHDOG|HANDOFF)(?:\.[a-z]{2}(?:-[A-Za-z]+)?)?\.md$/i;
const SKIP_SEGMENT: Record<string, true> = {
  rules: true, "prompt-copies": true, prompts: true, sop: true, skills: true, agents: true, commands: true, generated: true,
  test: true, tests: true, __tests__: true, fixtures: true, fixture: true, __fixtures__: true, testdata: true,
  ".git": true, node_modules: true, ".next": true, dist: true, build: true, coverage: true, ".omp": true, ".claude": true, ".cache": true, vendor: true,
};
const TEST_FILE = /[.\-_](?:test|spec)\.[^/]+$/i;

const slash = (path: string) => path.replaceAll("\\", "/");
const letterCount = (text: string) => text.match(/\p{L}/gu)?.length ?? 0;

/** draft-first 확인 대상인 글 파일인가. cwd 안이면 cwd 상대 경로로 보고(cwd가 /tmp 아래여도 대상), 밖이면 임시·에이전트 내부를 뺀다. */
export function inScope(abs: string, cwd: string): boolean {
  const rel = relative(cwd, abs);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const p = slash(inside ? rel : abs);
  if (!PROSE_FILE.test(p) || TEST_FILE.test(p)) return false;
  if (!inside && (p.startsWith(`${slash(tmpdir())}/`) || p.startsWith("/tmp/") || p.startsWith(`${slash(homedir())}/.omp/`))) return false;
  const segments = p.split("/");
  if (RULE_NAME.test(segments.at(-1) ?? "")) return false;
  // slop-gate internalRecord와 같은 기준: `doc` 바로 아래 history 폴더 안, 또는 `doc/README.md`.
  const doc = segments.indexOf("doc");
  if (doc >= 0 && ((segments[doc + 1] === "history" && segments.length > doc + 2) || (segments[doc + 1] === "README.md" && segments.length === doc + 2))) return false;
  return !segments.slice(0, -1).some((segment) => SKIP_SEGMENT[segment]);
}

export interface ProseChange { path: string; added: string }

/**
 * write·edit 호출이 글 파일에 더하는 글. write는 새 내용 전체(바뀌기 전 내용은 기준선으로 따로 덮는다), edit는 hashline 본문의 `+` 줄이다.
 * edit 본문의 파일 머리 `[path#TAG]` 아래 줄은 그 파일 몫이다.
 */
export function proseChanges(toolName: string, input: Record<string, unknown>, cwd: string): ProseChange[] {
  const abs = (path: string) => /^[a-z][a-z\d+.-]*:\/\//i.test(path) ? undefined : (isAbsolute(path) ? path : resolve(cwd, path));
  if (toolName === "write") {
    if (typeof input.path !== "string" || typeof input.content !== "string") return [];
    const path = abs(input.path);
    return path && inScope(path, cwd) ? [{ path, added: input.content }] : [];
  }
  if (toolName !== "edit" || typeof input.input !== "string") return [];
  const added = new Map<string, string[]>();
  let current = typeof input.path === "string" ? abs(input.path) : undefined;
  for (const line of input.input.split(/\r?\n/)) {
    const header = /^\[(.+?)#[0-9A-F]{4}\]/.exec(line);
    if (header) { current = abs(header[1]!); continue; }
    if (current && inScope(current, cwd) && line.startsWith("+")) {
      const lines = added.get(current) ?? [];
      lines.push(line.slice(1));
      added.set(current, lines);
    }
  }
  return [...added].map(([path, lines]) => ({ path, added: lines.join("\n") }));
}

/** 비교용 정규화: 글자·숫자만 남기고 소문자로. 띄어쓰기·문장부호·마크업 차이는 비교에 들어가지 않는다. */
export function shingles(text: string, into = new Set<string>()): Set<string> {
  const s = text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  for (let i = 0; i + GRAM <= s.length; i++) into.add(s.slice(i, i + GRAM));
  return into;
}

/** 글 덩어리로 나눈다. HTML은 블록 태그로(한 줄로 압축한 HTML도), Markdown은 빈 줄·목록·제목·표 행으로. 코드·경로·주소는 덜어 낸다. */
export function proseBlocks(source: string, path: string): string[] {
  let lines: string[];
  if (MARKUP_FILE.test(path)) {
    const fragment = /<[a-z!/][^>]*>/i.test(source) ? source : source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .filter((line) => !CSS_LINE.test(line))
      .join("\n");
    lines = htmlText(fragment.replace(/<(pre|code)\b[\s\S]*?<\/\1>/gi, " ")).split("\n").map((line) => line.replace(/^\[attr\] /, ""));
  } else {
    lines = [];
    let paragraph: string[] = [];
    const flush = () => { if (paragraph.length) lines.push(paragraph.join(" ")); paragraph = []; };
    for (const raw of source.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "\n").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^<!--.*-->$/.test(line)) { flush(); continue; }
      if (/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>)/.test(line)) { flush(); lines.push(line); continue; }
      paragraph.push(line);
    }
    flush();
  }
  return lines
    .map((line) => line.replace(/`[^`\n]*`/g, " ").replace(/\]\([^)\s]*\)/g, "]").replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim())
    .filter((line) => letterCount(line) >= MIN_BLOCK_LETTERS);
}

/** 덩어리의 4-gram 중 sources 어딘가에 있는 비율. */
export function coverage(block: string, sources: readonly Set<string>[]): number {
  const grams = shingles(block);
  if (grams.size === 0) return 1;
  let hit = 0;
  for (const gram of grams) if (sources.some((source) => source.has(gram))) hit++;
  return hit / grams.size;
}

/** 더한 글 중 sources로 덮이지 않는 덩어리. */
export function uncoveredBlocks(added: string, path: string, sources: readonly Set<string>[]): string[] {
  return proseBlocks(added, path).filter((block) => coverage(block, sources) < COVERED_RATIO);
}

export function lettersOf(blocks: readonly string[]): number {
  return blocks.reduce((sum, block) => sum + letterCount(block), 0);
}

export function denyText(path: string, blocks: readonly string[]): string {
  const shown = blocks.slice(0, 5).map((block) => `  · "${block.length > 60 ? `${block.slice(0, 60)}…` : block}"`).join("\n");
  return `[draft-coverage] 아직 쓰지 않았다. ${path}에 새로 더하는 글 ${blocks.length}덩어리(${lettersOf(blocks)}자)가 이 파일의 바뀌기 전 내용에도, 이 세션이 쓴 draft 결과에도(직접 read한 다른 세션의 draft 결과 포함) 없다:\n${shown}${blocks.length > 5 ? `\n  · …외 ${blocks.length - 5}덩어리` : ""}
앞부분 draft는 뒤에 새로 쓴 글을 덮지 않는다. 고치는 법(기본): 위 덩어리를 draft {instruction, output: "<이름>.md"}로 쓰게 하고(사실·수치·경로는 instruction에 넘긴다) 그 결과를 사실·슬롭만 고쳐 다시 적용한다. 다른 세션(Maker 등)이 이 글을 이미 draft했다면 그 draft 결과 파일을 read한 뒤 다시 보낸다.
예외일 때만: 위 덩어리가 정확한 사실·오타·슬롭 교정, 배치·코드만 옮긴 기존 글, 사용자·원문 인용처럼 draft 대상이 아니면, 다시 보내기 전에 응답 본문에 덩어리마다 어떤 예외인지와 그 근거(원문 위치 등)를 먼저 적고 같은 호출을 바꾸지 않고 다시 보낸다. 그 다시 보내기는 한 번 통과할 뿐 draft를 거친 것으로 기록되지 않으며, 새 예시·설명·결론은 예외가 아니다. 이 판단은 글자 유사도에 기댄 단서이며 저자 증명이 아니다.`;
}

export function reminderText(paths: readonly string[]): string {
  return `[draft-coverage] 이 명령이 글 파일을 바꿨다: ${paths.join(", ")}. bash·eval로 쓴 글은 draft 범위를 확인하지 못한다. 새 문단·설명·예시를 넣었다면 그 부분을 draft로 쓰게 한 뒤 적용하라(사실·오타·슬롭 교정과 배치 변경은 예외).`;
}
