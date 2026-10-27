import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { collectChanges, currentBlobs, hashBytes, resolveRepoTargets, spawnExec, type Exec } from "./cross-review";

/**
 * 밖에 보이는 산출물의 AI 슬롭 게이트(사용자 결정 2026-10-26: "소스코드 안에 내장된 내부 말고 바깥에 보이는 모든 것은
 * AI슬롭 게이트를 통과해야 한다"). 이 파일은 세 곳이 함께 쓰는 결정론 부분이다: 무엇이 보이는 산출물인가(classify),
 * 어떤 내용이 통과했는가(원장·sha256), 커밋을 막는 게이트(runSlopGate)와 한 턴에서 쓴 산출물을 찾는 일(턴 끝 추적).
 * 모델 심사는 extensions/slop-gate/review.ts가 한다. 통과 키는 파일 바이트의 sha256이라 한 바이트만 바뀌어도 통과가 없다.
 */

// ── 분류 ─────────────────────────────────────────────────────────────────────

/**
 * 프로젝트가 더하는 보이는 산출물. 저장소(또는 cwd) 루트의 `.slop-gate.json`: `{ "visible": ["glob"] }`.
 * 보이는 산출물을 빼는 설정은 없다: 유일한 면제는 사용자가 지시한 slopGateWaiver(기록됨)다.
 */
export interface SlopConfig { visible?: string[] }
export const CONFIG_FILE = ".slop-gate.json";

export interface Classification { visible: boolean; reason: string }

const norm = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "");

const GENERATED_SEGMENT: Record<string, true> = {
  ".git": true, node_modules: true, ".next": true, dist: true, build: true, coverage: true, ".omp": true, ".claude": true,
  ".cache": true, __pycache__: true, vendor: true, out: true, ".turbo": true,
};
// 하네스·프롬프트·스킬·내부 기록 폴더. 사람이 읽는 산출물이 아니라 에이전트와 개발자가 읽는 내부 자료다.
const INTERNAL_SEGMENT: Record<string, true> = {
  rules: true, "prompt-copies": true, sop: true, skills: true, agents: true, commands: true,
};
const TEST_SEGMENT: Record<string, true> = { test: true, tests: true, __tests__: true, fixtures: true, fixture: true, __fixtures__: true, testdata: true };
const TEST_FILE = /[.\-_](?:test|spec)\.[^/]+$/i;
const INTERNAL_NAME = /^(?:HANDOFF|AGENTS|RULES|CLAUDE|SKILL|APPEND_SYSTEM|TITLE_SYSTEM|WATCHDOG)(?:\.[a-z]{2}(?:-[A-Za-z]+)?)?\.md$/i;
const GENERATED_FILE = /(?:^|\/)(?:source-integrity\.json|runtime-integrity\.json|package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|memories\.jsonl)$/i;

const MARKDOWN = /\.(?:md|mdx|markdown)$/i;
const MARKUP = /\.(?:html?|xhtml)$/i;
// 텍스트를 뽑을 수 있는 문서 형식만 본다. 옛 .doc·.xls·.ppt·.hwp는 읽을 수 없어 대상이 아니다.
const OFFICE = /\.(?:pptx|docx|xlsx|pdf|hwpx)$/i;
const CSV = /\.csv$/i;
const REPORT_CSV = /report|reports|보고|리포트|결과|통계|summary/i;
// 언어 팩 뿌리 폴더(어느 깊이든, 저장소 안팎 모두). `messages`는 이 아래에 있을 때만 언어 팩이다.
const LOCALE_ROOT: Record<string, true> = { i18n: true, locale: true, locales: true, translations: true, lang: true, l10n: true };
const COPY_EXT = /\.(?:json|ts|js|mjs|ya?ml|po)$/i;

/** 내부 기록만 면제: doc/history/**, doc/README.md. HANDOFF.md는 INTERNAL_NAME이 맡는다. 그 밖의 doc 폴더 파일은 형식으로 분류한다. */
function internalRecord(segments: readonly string[]): boolean {
  const at = segments.indexOf("doc");
  return at >= 0 && ((segments[at + 1] === "history" && segments.length > at + 2) || (segments[at + 1] === "README.md" && segments.length === at + 2));
}

/** 저장소 밖 절대 경로 중 보지 않는 곳: 임시·에이전트 내부·캐시·생성물·의존성. 이유를 돌려주고, 대상이면 undefined. */
function externalExcluded(p: string): string | undefined {
  const tmp = norm(tmpdir());
  const home = norm(homedir());
  if (p.startsWith(`${tmp}/`) || p.startsWith("/tmp/") || p.startsWith(`${home}/.omp/`) || p.startsWith(`${home}/.cache/`)) return "scratch or agent internals";
  if (p.split("/").some((segment) => GENERATED_SEGMENT[segment])) return "generated";
  return undefined;
}

function matches(patterns: readonly string[] | undefined, path: string): boolean {
  return (patterns ?? []).some((pattern) => { try { return new Bun.Glob(pattern).match(path); } catch { return false; } });
}

/**
 * 한 줄 분류. path는 저장소·cwd 기준 상대 경로이거나 절대 경로다. 절대 경로(저장소 밖 산출물, 예: Windows 문서 폴더)는
 * 폴더 규칙 없이 확장자만 본다. 우선순위: 내부·생성물·테스트(선언으로도 못 바꾼다) → 프로젝트 visible → 보이는 형식.
 */
export function classify(path: string, config: SlopConfig = {}): Classification {
  const p = norm(path);
  const external = isAbsolute(path) || /^[A-Za-z]:\//.test(p);
  const segments = p.split("/");
  const name = segments.at(-1) ?? "";
  if (internalRecord(segments)) return { visible: false, reason: "internal record" };
  if (external) {
    const excluded = externalExcluded(p);
    if (excluded) return { visible: false, reason: excluded };
  }
  // 폴더 규칙은 절대 경로에도 적용한다: 내부·테스트·생성물 판정은 어떤 공개 선언보다 먼저다(저장소 밖 생성물 폴더는 externalExcluded가 본다).
  const dirs = segments.slice(0, -1);
  if (!external && dirs.some((segment) => GENERATED_SEGMENT[segment])) return { visible: false, reason: "generated or vendored" };
  if (dirs.some((segment) => INTERNAL_SEGMENT[segment])) return { visible: false, reason: "internal record, rule, prompt or skill" };
  if (dirs.some((segment) => TEST_SEGMENT[segment]) || TEST_FILE.test(p)) return { visible: false, reason: "test or fixture" };
  if (GENERATED_FILE.test(p)) return { visible: false, reason: "generated" };
  if (INTERNAL_NAME.test(name)) return { visible: false, reason: "internal prompt or rule file" };
  if (matches(config.visible, p)) return { visible: true, reason: "project declared" };
  if (MARKDOWN.test(name)) return { visible: true, reason: "public markdown" };
  if (MARKUP.test(name)) return { visible: true, reason: "html page" };
  if (OFFICE.test(name)) return { visible: true, reason: "office or pdf document" };
  if (CSV.test(name)) {
    if (external) return { visible: true, reason: "csv deliverable" };
    return REPORT_CSV.test(p) ? { visible: true, reason: "csv report" } : { visible: false, reason: "csv data" };
  }
  if (COPY_EXT.test(name) && !/\.d\.ts$/.test(name)) {
    const dirs = segments.slice(0, -1);
    const at = dirs.findIndex((segment) => LOCALE_ROOT[segment]);
    // 언어 팩 뿌리 아래의 json·yaml·po·ts·js는 모두 대상이다. 이름으로 코드와 사전을 가르지 않는다: 사람에게 보이는 문구가 없는 파일은 심사에서 모델 없이 통과한다.
    if (at >= 0) return { visible: true, reason: "UI copy pack" };
  }
  return { visible: false, reason: "not a visible format" };
}

/** `<root>/.slop-gate.json`. 없거나 깨졌으면 빈 설정이다(예외를 열어 두지 않는 쪽이 기본값이다). */
export function loadSlopConfig(root: string): SlopConfig {
  try {
    const parsed = JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")) as SlopConfig;
    const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
    return { visible: list(parsed.visible) };
  } catch { return {}; }
}

// ── 대상 판정 ────────────────────────────────────────────────────────────────

/**
 * 슬롭 게이트 대상은 classify()가 보이는 산출물로 본 것 전부다(사용자 결정 2026-10-27: "밖으로 나오는 산출물 중 소스코드 내부에 있는 것 말고 다").
 * 공개 미러 선언(.publicignore)이나 public 선언은 대상을 정하지 않는다. `.slop-gate.json` visible glob은 대상을 더하기만 한다.
 * 세 곳(slop_check·커밋 게이트·턴 끝)이 모두 바이트를 읽기 전에 이 판정을 쓴다.
 */

/** 저장소 밖 산출물의 `.slop-gate.json`을 읽는 곳: cwd에서 가장 가까운 git 저장소 루트, 없으면 cwd. */
export function configRootOf(cwd: string): string {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

/**
 * git 밖 파일(실제 절대 경로)의 분류. cwd 안이면 cwd 상대 경로로(폴더 규칙 적용, cwd가 /tmp 아래여도 산출물로 본다), 밖이면 절대 경로로 본다.
 * 기본 형식이 아니어도 설정 루트의 visible glob이 설정 루트 상대 경로나 절대 경로로 더한 파일은 대상이다(내부·테스트·생성물 판정은 그대로 먼저다).
 */
export function classifyExternal(abs: string, cwd: string, root: string, config: SlopConfig): Classification {
  const within = (base: string) => { const inside = relative(base, abs); return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : undefined; };
  const local = within(cwd) ?? abs;
  const kind = classify(local, config);
  if (kind.visible) return kind;
  for (const other of [within(root), abs]) {
    if (other === undefined || other === local) continue;
    const added = classify(other, config);
    if (added.visible && added.reason === "project declared") return added;
  }
  return kind;
}

/**
 * slop_check 대상(실제 절대 경로)의 분류. git 안이면 그 저장소 루트 상대 경로와 그 저장소의 `.slop-gate.json`으로, 밖이면 classifyExternal로 본다.
 */
export function visibilityOf(paths: readonly string[], cwd: string): Map<string, Classification> {
  const out = new Map<string, Classification>();
  const root = configRootOf(cwd);
  const config = loadSlopConfig(root);
  let base = cwd;
  try { base = realpathSync(cwd); } catch { /* cwd를 읽지 못하면 적힌 대로 */ }
  for (const abs of paths) {
    const repo = gitRootOf(abs);
    out.set(abs, repo ? classify(relative(repo, abs).split(sep).join("/"), loadSlopConfig(repo)) : classifyExternal(abs, base, root, config));
  }
  return out;
}

/** 조상 중 `.git`(폴더 또는 worktree·submodule 파일)이 있는 가장 가까운 폴더. 없으면 undefined(git 밖). */
export function gitRootOf(path: string): string | undefined {
  let current = dirname(path);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/**
 * 이 바이트를 넘는 csv는 사람이 읽는 보고 표가 아니라 원자료(센서·장비 로그 등)로 보고 슬롭 검사에서 뺀다(2026-10-28 사용자 결정: 59 MB 센서 로그가
 * 턴 끝 게이트를 띄우고 slop_check 오류를 냈다). 한 번에 심사할 수 있는 글(MAX_FILE_CHARS 100,000자)의 네 배라 통째로 보일 수도 없다. csv만이다.
 */
export const MAX_REPORT_CSV_BYTES = 400_000;

/** 원자료 csv로 볼 때의 이유. slop_check·커밋 게이트는 이 이유를 결과에 남기고(조용히 빠지지 않는다), 턴 끝 게이트는 건너뛴다. */
export function rawDataReason(path: string, bytes: number): string | undefined {
  return /\.csv$/i.test(path) && bytes > MAX_REPORT_CSV_BYTES
    ? `raw data file: a csv of ${bytes} bytes (above ${MAX_REPORT_CSV_BYTES}) is treated as data, not a report table; it was not read, not reviewed and has no pass`
    : undefined;
}

// ── 원장 ─────────────────────────────────────────────────────────────────────

export interface SlopFindingRecord { id: string; quote: string; rule: string; fix: string; quoteFound?: boolean; reviewer?: string }
export interface SlopReviewRecord {
  type: "slop-review"; reviewId: string; ts: string; model: string;
  reviewers?: { family: string; model?: string; status: string; error?: string; raw?: string; advisory?: true }[];
  /** relaxed: 2026-10-28 결정으로 finding에서 뺀 humanizer 패턴 3(연결어미 뒤 쉼표)만 든 지적 수. */
  files: { path: string; sha256: string; scope?: string; findings: SlopFindingRecord[]; relaxed?: number }[];
  /** 필수 reviewer 실패·누락으로 심사하지 못한 파일과 그 진단. resolve는 files만 보므로 여기 든 파일은 통과가 될 수 없다. */
  failed?: { path: string; sha256: string; error: string; reviewer?: { family: string; model?: string; status: string; error?: string; raw?: string }; diagnostics?: SlopFindingRecord[] }[];
  /** 모든 묶음의 실패한 reviewer 호출(자문 포함). */
  failedAttempts?: { family: string; model?: string; status: string; error?: string; raw?: string; advisory?: true }[];
}
export interface SlopResolveRecord { type: "slop-resolve"; reviewId: string; ts: string; resolutions: { id: string; status: string; evidence: string }[] }
export interface SlopPassRecord {
  type: "slop-pass"; path: string; sha256: string; reviewedAt: string; model: string; reviewId: string;
  findings: { id: string; status: string; evidence?: string }[];
}
export interface SlopWaiverRecord { type: "slop-waiver"; ts: string; root: string; reason: string; files: { path: string; sha256: string }[] }
export type SlopRecord = SlopReviewRecord | SlopResolveRecord | SlopPassRecord | SlopWaiverRecord;

export const DEFAULT_SLOP_LEDGER = join(import.meta.dir, "..", "..", "slop-gate-ledger.jsonl");
/** OMP_SLOP_GATE_LEDGER는 테스트·검증용 재지정이며 운영에서는 쓰지 않는다. */
export function slopLedgerPath(): string { return process.env.OMP_SLOP_GATE_LEDGER || DEFAULT_SLOP_LEDGER; }

/** 깨진 줄은 건너뛰고, 파일이 없으면 빈 목록이다. */
export function readSlopRecords(path: string): SlopRecord[] {
  if (!existsSync(path)) return [];
  const out: SlopRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.startsWith("{\"type\":\"slop-")) continue;
    try { out.push(JSON.parse(line) as SlopRecord); } catch { /* 깨진 줄 */ }
  }
  return out;
}

/** 한 줄을 O_APPEND 한 번으로 쓰고 0600을 보장한다. 실패는 던진다(기록 없이 통과시키지 않는다). */
export function appendSlopRecord(path: string, record: SlopRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "a" });
  chmodSync(path, 0o600);
}

export function passFor(records: readonly SlopRecord[], hash: string): SlopPassRecord | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]!;
    if (record.type === "slop-pass" && record.sha256 === hash) return record;
  }
  return undefined;
}

// ── 커밋 게이트 ──────────────────────────────────────────────────────────────

export class SlopGateRefusal extends Error {}

export interface SlopGateOptions {
  cwd: string;
  /** git_finalize에 넘긴 cwd 기준 파일 목록. */
  files: string[];
  waiver?: string;
  ledgerPath: string;
  exec?: Exec;
  gitFor?: (root: string) => Promise<string>;
  now?: () => Date;
}

export interface SlopGateOutcome {
  checked: boolean;
  waived?: boolean;
  /** 게이트가 본 보이는 산출물(저장소 상대 경로)과 그 sha256. */
  artifacts: { path: string; sha256: string }[];
  /** 보이는 형식이지만 원자료 csv(rawDataReason)로 보고 통과를 요구하지 않은 파일과 이유. finalizer가 성공 문구에 남긴다. */
  rawData?: { path: string; reason: string }[];
  /** 요청한 모든 경로의 blob(보이는 산출물은 통과를 맞춘 바로 그 바이트의 blob). finalizer가 잠금 안에서 stage된 내용과 대조한다. */
  gateBlobs?: Record<string, string>;
}

/**
 * git_finalize가 cross-review 다음에 부르는 게이트. 새로 커밋할 변경이 없는 파일(resume-push)과 삭제는 대상이 아니고, 보이는 산출물(classify)이
 * 아닌 파일은 바이트를 읽지 않는다. 보이는 산출물에 통과 기록이 없으면 SlopGateRefusal. waiver는 기록을 남기고 통과시킨다.
 * 입력 모양이 잘못된 경우(절대 경로 등)만 finalizer.ps1의 판정에 맡기고, 저장소 상태를 읽지 못하면 열어 두지 않는다.
 */
export async function runSlopGate(options: SlopGateOptions): Promise<SlopGateOutcome> {
  const exec = options.exec ?? spawnExec();
  const resolved = await resolveRepoTargets(options.cwd, options.files, exec);
  if ("failure" in resolved) {
    if (resolved.failure === "git") throw new SlopGateRefusal(`the repository state could not be read, so the slop-gate requirement cannot be checked: ${resolved.detail}`);
    return { checked: false, artifacts: [] };
  }
  const git = (await options.gitFor?.(resolved.root)) ?? "git";
  const config = loadSlopConfig(resolved.root);
  const { changed, unchanged } = await collectChanges(exec, git, resolved.root, resolved.targets.map((target) => target.path));
  const gated = changed.filter((change) => change.status !== "deleted" && classify(change.path, config).visible);
  if (gated.length === 0) return { checked: true, artifacts: [] };

  const inputOf = new Map(resolved.targets.map((target) => [target.path, target.input]));

  const records = readSlopRecords(options.ledgerPath);
  const artifacts: { path: string; sha256: string }[] = [];
  const rawData: { path: string; reason: string }[] = [];
  const blobs: Record<string, string> = {};
  const uncovered: { input: string; sha256: string; note?: string }[] = [];
  for (const change of gated) {
    const abs = join(resolved.root, ...change.path.split("/"));
    let bytes: Buffer;
    try {
      // 원자료 csv는 바이트를 읽지 않는다(크기만 본다). 그 blob은 collectChanges가 본 값으로 gateBlobs에 남는다.
      const data = rawDataReason(change.path, statSync(abs).size);
      if (data) { rawData.push({ path: inputOf.get(change.path) ?? change.path, reason: data }); continue; }
      bytes = readFileSync(abs);
    } catch (error) {
      throw new SlopGateRefusal(`could not read ${inputOf.get(change.path) ?? change.path} to check its slop-gate pass: ${error instanceof Error ? error.message : String(error)}`);
    }
    const hash = sha256(bytes);
    artifacts.push({ path: change.path, sha256: hash });
    blobs[change.path] = await hashBytes(exec, git, resolved.root, change.path, bytes);
    if (!passFor(records, hash)) {
      const stale = records.some((record) => record.type === "slop-pass" && record.path === abs);
      uncovered.push({ input: inputOf.get(change.path) ?? change.path, sha256: hash, note: stale ? "a pass exists for an older version of this file; the content changed after the pass" : undefined });
    }
  }
  const dataNote = rawData.length > 0 ? { rawData } : {};
  // 요청한 모든 경로의 기준 blob. 바뀐 파일은 게이트가 본 blob, 바뀌지 않은 파일은 지금 blob이다.
  const clean = await currentBlobs(exec, git, resolved.root, unchanged);
  const gateBlobs: Record<string, string> = {
    ...Object.fromEntries([...changed.map((change) => [change.path, change.blob] as const), ...unchanged.map((path) => [path, clean.get(path)!] as const)]),
    ...blobs,
  };

  if (uncovered.length > 0) {
    const reason = options.waiver?.trim();
    if (!reason) {
      const names = JSON.stringify(uncovered.map((file) => file.input));
      throw new SlopGateRefusal([
        `slop-gate: ${uncovered.length} visible artifact(s) have no AI-slop check pass for their current content:`,
        ...uncovered.map((file) => `- ${file.input}${file.note ? ` [${file.note}]` : ""}`),
        ...rawData.map((file) => `(not gated) ${file.path}: ${file.reason}`),
        `Next: run slop_check {files:${names}, authors:[<the model selectors that wrote the text, or "main">]} (reviewers follow the same author-family rule as cross_review; only text changed since HEAD is reviewed for tracked files), fix or refute every finding (a clean review records the pass by itself; refuted findings are closed with slop_check {action:"resolve"}), then call git_finalize again with the same files. Do not edit these files after the pass: it is tied to their exact content (sha256).`,
        "A waiver (slopGateWaiver) is allowed only on the user's explicit instruction and is recorded in the slop-gate ledger.",
      ].join("\n"));
    }
    try {
      appendSlopRecord(options.ledgerPath, {
        type: "slop-waiver", ts: (options.now?.() ?? new Date()).toISOString(), root: resolved.root, reason,
        files: artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
      });
    } catch { throw new SlopGateRefusal("slop-gate waiver could not be recorded in the slop-gate ledger; refusing to commit without a record."); }
    return { checked: true, waived: true, artifacts, ...dataNote, gateBlobs };
  }
  return { checked: true, artifacts, ...dataNote, gateBlobs };
}

/**
 * cross-review가 만든 gateBlobs에 slop-gate의 blob을 합친다. cross-review가 본 항목은 절대 덮어쓰지 않는다(코드 파일의 검토 blob이
 * 기준이다). slop-gate는 cross-review 기준이 없는 경로를 채우기만 하고, 두 게이트가 모두 본 보이는 산출물(언어 팩 ts 등)의 blob이
 * 다르면 두 게이트 사이에 파일이 바뀐 것이므로 거절한다.
 */
export function mergeGateBlobs(crossReview: Record<string, string> | undefined, slop: SlopGateOutcome): Record<string, string> | undefined {
  if (!slop.gateBlobs) return crossReview;
  for (const artifact of slop.artifacts) {
    const reviewed = crossReview?.[artifact.path];
    if (reviewed !== undefined && reviewed !== slop.gateBlobs[artifact.path]) {
      throw new SlopGateRefusal(`${artifact.path} changed between the cross-review check and the slop-gate check; run git_finalize again so both gates see the same content.`);
    }
  }
  return { ...slop.gateBlobs, ...crossReview };
}

// ── 턴 끝 추적(저장소 밖 산출물) ─────────────────────────────────────────────

const TRACK_EXT = "md|mdx|html?|pptx|docx|xlsx|csv|pdf|hwpx";
// 시스템 영역(실행 파일·라이브러리·장치·로그): 산출물을 내보내는 곳이 아니다. 그 밖의 절대 경로(홈·/mnt·/srv·/opt·/data·/var/www·/usr/share 등)는 cwd 밖이어도 받는다.
const SYSTEM_ROOT = /^\/(?:proc|sys|dev|run|etc|bin|sbin|lib|lib32|lib64|boot|snap|usr\/(?:bin|sbin|lib|lib32|lib64|libexec|include)|var\/(?:log|lib|cache|run))(?:\/|$)/;
// 따옴표 안 경로(공백 포함 가능) 또는 공백·따옴표·셸 기호 없는 토큰 중 보이는 확장자로 끝나는 것.
const PATH_TOKEN = new RegExp(`"([^"\\n]+?\\.(?:${TRACK_EXT}))"|'([^'\\n]+?\\.(?:${TRACK_EXT}))'|([^\\s"'\`<>|;&()=,]+\\.(?:${TRACK_EXT}))(?![\\w.])`, "gi");
const TRACK_FILE = new RegExp(`\\.(?:${TRACK_EXT})$`, "i");
const DIR_TOKEN = /(?:\/mnt\/[a-z]\/Users\/|[A-Za-z]:[\\/]Users[\\/])[^\s"'`<>|;&()=,]*/g;

/** `C:\Users\x\a.pptx`처럼 쓴 Windows 경로를 WSL 경로로 바꾼다. 다른 경로는 그대로다. */
export function wslPath(path: string): string {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return drive ? `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll("\\", "/")}` : path;
}

/**
 * 이 경로를 점검 대상으로 받는가: cwd 안이거나, cwd 밖이어도 시스템 영역이 아닌 절대 경로(홈·/mnt·/media·/srv·/opt·/data 등).
 * 시스템 영역과 임시(/tmp)·~/.omp·~/.cache·node_modules·.git 같은 곳은 cwd 밖이면 받지 않는다.
 */
export function trackable(abs: string, cwd: string): boolean {
  const rel = relative(cwd, abs);
  if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return true;
  const p = norm(abs);
  return p.startsWith("/") && !SYSTEM_ROOT.test(p) && externalExcluded(p) === undefined;
}

function expand(token: string, cwd: string): string {
  const path = wslPath(token.trim());
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/**
 * 한 도구 호출이 쓴 것으로 보이는 후보. write·edit·draft는 인자에서, bash·eval은 명령·코드에 적힌 경로와 폴더에서 읽는다.
 * 후보는 단서일 뿐이다: 턴 끝에서 존재와 mtime(턴 시작 이후)을 확인해 실제로 쓴 것만 남긴다.
 */
export function candidatesOf(toolName: string, input: Record<string, unknown>, cwd: string): { files: string[]; dirs: string[] } {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const add = (token: string) => {
    const abs = expand(token, cwd);
    if (trackable(abs, cwd)) files.add(abs);
  };
  if (toolName === "write" && typeof input.path === "string") add(input.path);
  else if (toolName === "draft" && typeof input.output === "string") add(input.output);
  else if (toolName === "edit") {
    if (typeof input.path === "string") add(input.path);
    const body = typeof input.input === "string" ? input.input : "";
    for (const match of body.matchAll(/^\[(.+?)#[0-9A-F]{4}\]/gm)) add(match[1]!);
  } else if (toolName === "bash" || toolName === "eval") {
    const text = typeof input.command === "string" ? input.command : typeof input.code === "string" ? input.code : "";
    for (const match of text.matchAll(PATH_TOKEN)) add(match[1] ?? match[2] ?? match[3]!);
    for (const match of text.matchAll(DIR_TOKEN)) {
      const abs = expand(match[0].replace(/[\\/]+$/, ""), cwd);
      if (trackable(abs, cwd)) dirs.add(abs);
    }
  }
  return { files: [...files], dirs: [...dirs] };
}

const SKIP_WALK: Record<string, true> = { ...GENERATED_SEGMENT };

/** dir 아래(깊이·개수 제한)에서 since 이후 바뀐 보이는 형식 파일. */
export function recentVisibleFiles(dir: string, since: number, limit = 2_000, depth = 3): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (current: string, level: number) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen >= limit) return;
      seen += 1;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) { if (level < depth && !SKIP_WALK[entry.name] && !entry.name.startsWith(".")) walk(abs, level + 1); continue; }
      if (!entry.isFile() || !TRACK_FILE.test(entry.name)) continue;
      try { if (statSync(abs).mtimeMs >= since) out.push(abs); } catch { /* 사라진 파일 */ }
    }
  };
  walk(dir, 0);
  return out;
}

/** 조상 폴더에 `.git`(폴더 또는 worktree 파일)이 있으면 git 저장소 안이다. 이 경우 커밋 게이트가 맡는다. */
export function insideGit(path: string): boolean {
  let current = dirname(path);
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export interface PendingArtifact { path: string; sha256: string; reason: string }

/**
 * 턴 끝 판정. 후보 중 존재하고, 턴 시작 이후 바뀌었고, git 밖이고, 보이는 산출물(classifyExternal)이며, 현재 내용의 통과가 없는 것.
 * 공개 선언은 필요 없다. since는 mtime 시계 차이(Windows 드라이브)를 감안해 2초 일찍 잡는다.
 */
export function pendingArtifacts(
  tracked: { files: Iterable<string>; dirs: Iterable<string> }, cwd: string, since: number, records: readonly SlopRecord[],
): PendingArtifact[] {
  const found = new Set<string>(tracked.files);
  const floor = since - 2_000;
  for (const dir of tracked.dirs) {
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const file of recentVisibleFiles(dir, floor)) found.add(file);
  }
  if (!insideGit(cwd) && !cwd.startsWith("/mnt/")) for (const file of recentVisibleFiles(cwd, floor)) found.add(file);
  const root = configRootOf(cwd);
  const config = loadSlopConfig(root);
  let base = cwd;
  try { base = realpathSync(cwd); } catch { /* cwd를 읽지 못하면 적힌 대로 */ }
  const out: PendingArtifact[] = [];
  for (const path of [...found].sort()) {
    // 링크는 실제 경로로만 판정하고 읽는다: 별칭 이름이 산출물처럼 보여도 대상의 저장소·분류를 따른다.
    let real: string;
    try { real = realpathSync(path); } catch { continue; }
    if (insideGit(real)) continue;
    const kind = classifyExternal(real, base, root, config);
    if (!kind.visible) continue;
    let bytes: Buffer;
    try {
      const stat = statSync(real);
      // 원자료 csv(rawDataReason)는 턴 끝에 묻지 않는다: 10-27 에이전트는 읽기만 하고 로거가 계속 쓰던 59 MB 센서 로그가 이어 가기를 띄웠다. slop_check와 커밋 게이트는 이유를 남긴다.
      if (!stat.isFile() || stat.mtimeMs < floor || rawDataReason(real, stat.size)) continue;
      bytes = readFileSync(real);
    } catch { continue; }
    const hash = sha256(bytes);
    if (!passFor(records, hash)) out.push({ path, sha256: hash, reason: kind.reason });
  }
  return out;
}
