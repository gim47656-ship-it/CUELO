import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

/**
 * 보이는 산출물에서 사람이 읽는 글을 뽑는다. 형식별 규칙:
 * md·txt·csv·yaml·po는 글 그대로, html은 태그·script·style을 걷고 alt·title·placeholder·aria-label을 더하며,
 * i18n 묶음(json·ts)은 문자열 값만, pptx·docx·xlsx·pdf·hwpx는 관리 Python 환경의 라이브러리로 뽑는다.
 * html·md와 모든 추출 글에는 kill-ai-slop의 scan.mjs를 돌려 코드·문구 단서(lead)를 모은다. 단서는 판정이 아니다.
 */

export type ArtifactKind = "prose" | "markup" | "copy" | "office";
export interface ScanLead { id: string; name: string; fix: string; line: number; text: string }
/** source: 코드 수준 단서(CSS 그라데이션 등)를 볼 수 있게 싣는 html 원본. 다른 형식은 없다. */
export interface Extracted { text: string; kind: ArtifactKind; leads: ScanLead[]; source?: string }

const MAX_LEADS = 40;
const SKILLS_DIR = join(import.meta.dir, "..", "..", "skills");
const SCAN = join(SKILLS_DIR, "kill-ai-slop", "scripts", "scan.mjs");
const PY_SCRIPT = join(import.meta.dir, "extract.py");
const OFFICE = /\.(?:pptx|docx|xlsx|pdf|hwpx)$/i;

export function pythonPath(): string {
  const base = join(homedir(), ".omp", "python-env");
  return process.platform === "win32" ? join(base, "Scripts", "python.exe") : join(base, "bin", "python");
}

/** UTF-8로 읽고, 아니면 CP949(CSV·옛 문서)로 읽는다. BOM은 걷는다. */
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
  catch { return new TextDecoder("euc-kr").decode(bytes); }
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };

export function htmlText(html: string): string {
  // 속성 값은 큰따옴표·작은따옴표·따옴표 없는 값을 모두 읽는다.
  const attributes = [...html.matchAll(/\b(?:alt|title|placeholder|aria-label|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity))
    .filter((value) => value.trim().length >= 2);
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|section|article|header|footer|nav|table|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);
  const lines = body.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
  return [...lines, ...attributes.map((value) => `[attr] ${value}`)].join("\n");
}

/** JSON 안 문자열 값을 `경로: 값` 줄로 편다. */
export function jsonStrings(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [`${prefix}: ${value}`];
  if (Array.isArray(value)) return value.flatMap((item, index) => jsonStrings(item, `${prefix}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => jsonStrings(item, prefix ? `${prefix}.${key}` : key));
  return [];
}

/**
 * ts·js 언어 팩의 문자열 리터럴(백틱 템플릿은 여러 줄 포함). 문구가 아닌 것만 뺀다: import·require 경로, 객체 키(`{`·`,`·줄 시작 뒤
 * 바로 `:`가 오는 문자열), 모듈·파일 경로(`./a`, `@/x`, `a/b.json`, `/api/users`; 한 토막 `/help`는 문구), 글자·숫자가 없는 기호 문자열. 한 글자·한 단어 값(`'开'`, `'On/Off'`)은 문구라 남긴다.
 */
const MODULE_PATH = /^(?:\.{1,2}\/|@\/|~\/)\S*$|^\/?[\w.-]+\/[\w./-]*\.\w{1,5}$|^\/[\w.-]+\/\S*$/;
export function literalStrings(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^\\`])*)`/g)) {
    const value = (match[2] ?? match[3] ?? "").replace(/\\(["'`\\])/g, "$1");
    if (!/[\p{L}\p{N}]/u.test(value)) continue;
    const before = source.slice(Math.max(0, match.index - 40), match.index);
    const after = source.slice(match.index + match[0].length, match.index + match[0].length + 3);
    if (/\b(?:from|import|require\(|import\()\s*$/.test(before)) continue;
    if (/^\s*:/.test(after) && /(?:^|[{,\n])\s*$/.test(before)) continue;
    if (MODULE_PATH.test(value)) continue;
    out.push(value);
  }
  return out;
}

async function run(command: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } catch (error) { return { code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; }
}

async function officeText(abs: string): Promise<string> {
  const result = await run([pythonPath(), PY_SCRIPT, abs]);
  let parsed: { text?: string; error?: string } = {};
  try { parsed = JSON.parse(result.stdout) as typeof parsed; } catch { /* 아래에서 오류 */ }
  if (result.code !== 0 || typeof parsed.text !== "string") {
    throw new Error(`could not extract text from ${basename(abs)}: ${parsed.error ?? (result.stderr.trim().split("\n").at(-1) || `exit ${result.code}`)}`);
  }
  return parsed.text;
}

/** scan.mjs 단서. html은 원본 파일을, 나머지는 추출 글을 .md로 써서 돌린다. 스캐너가 실패해도 심사는 계속한다(단서가 없을 뿐). */
async function scanLeads(name: string, content: string | Uint8Array, markup: boolean): Promise<ScanLead[]> {
  const dir = mkdtempSync(join(tmpdir(), "slop-scan-"));
  try {
    writeFileSync(join(dir, markup ? name : "artifact.md"), content);
    const result = await run([process.execPath, SCAN, dir, "--json", "--no-color"]);
    if (result.code !== 0 && !result.stdout.trim()) return [];
    const parsed = JSON.parse(result.stdout) as { findings?: { id: string; name: string; fix: string; hits: { line: number; text: string }[] }[] };
    return (parsed.findings ?? []).flatMap((group) => group.hits.map((hit) => ({ id: group.id, name: group.name, fix: group.fix, line: hit.line, text: hit.text.slice(0, 160) }))).slice(0, MAX_LEADS);
  } catch { return []; } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function extractVisible(abs: string): Promise<Extracted> {
  const ext = extname(abs).toLowerCase();
  const name = basename(abs);
  if (OFFICE.test(abs)) {
    const text = await officeText(abs);
    return { text, kind: "office", leads: await scanLeads(name, text, false) };
  }
  const raw = readFileSync(abs);
  const source = decode(raw);
  if (ext === ".html" || ext === ".htm" || ext === ".xhtml") return { text: htmlText(source), kind: "markup", leads: await scanLeads(name, raw, true), source };
  if (ext === ".json") {
    const text = jsonStrings(JSON.parse(source)).join("\n");
    return { text, kind: "copy", leads: await scanLeads(name, text, false) };
  }
  if (ext === ".ts" || ext === ".js" || ext === ".mjs") {
    const text = literalStrings(source).join("\n");
    return { text, kind: "copy", leads: await scanLeads(name, text, false) };
  }
  return { text: source, kind: "prose", leads: ext === ".md" || ext === ".mdx" || ext === ".markdown" ? await scanLeads(name, raw, true) : await scanLeads(name, source, false) };
}
