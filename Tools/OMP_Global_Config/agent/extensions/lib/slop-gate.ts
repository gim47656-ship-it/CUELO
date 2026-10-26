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

// ── 공개 여부 ────────────────────────────────────────────────────────────────

/**
 * 공개·공유되는 산출물만 슬롭 점검 대상이다(사용자 결정 2026-10-26). 비공개·내부 문서는 사용자에게 건네도 대상이 아니다.
 * 정본은 저장소 루트의 `.publicignore`다: publish-public.yml이 `git ls-files -ci --exclude-from=.publicignore`로 미러에서 지우는 것이 비공개다.
 * 그 밖의 선언은 `.slop-gate.json` visible glob과 slop_check `public:true`(선언 없는 일회성 산출물)뿐이다. 선언이 없으면 모르는 파일이라
 * 공개가 아니다: 모델에 보내지 않고 게이트도 없다. 세 곳(slop_check·커밋 게이트·턴 끝)이 모두 바이트를 읽기 전에 이 판정을 쓴다.
 */
export const PUBLIC_IGNORE = ".publicignore";
export interface Publication {
  public: boolean;
  reason: string;
  /** 아무 선언도 없다. public:true 선언만 이것을 공개로 바꿀 수 있다. */
  unknown?: true;
  /** 저장소 상태를 읽지 못해 판정하지 못했다(공개로 보지 않는다). */
  error?: true;
}

const DECLARED: Publication = { public: true, reason: `declared public in ${CONFIG_FILE}` };
const UNDECLARED: Publication = { public: false, unknown: true, reason: `no publication declaration (${PUBLIC_IGNORE} or ${CONFIG_FILE}), so it is not a public artifact` };

/**
 * 저장소 안 경로(저장소 상대)의 공개 여부. 요청한 경로에만 git ls-files를 돌린다(저장소 전체를 훑지 않는다). `.publicignore`가 있으면 그것이
 * 지운 것(부정 규칙 반영, 추적하지 않는 새 파일 포함)은 비공개이고, 남은 것 중 추적 중이거나 git이 무시하지 않는 새 파일이 공개다.
 * `.publicignore`가 없으면 `.slop-gate.json`이 선언한 경로만 공개다. git이 실패하면 던진다(공개 여부를 모른 채 열어 두지 않는다).
 */
export async function repoPublication(exec: Exec, git: string, root: string, paths: readonly string[], config: SlopConfig): Promise<Map<string, Publication>> {
  const out = new Map<string, Publication>();
  if (paths.length === 0) return out;
  if (!existsSync(join(root, PUBLIC_IGNORE))) {
    for (const path of paths) out.set(path, matches(config.visible, path) ? DECLARED : UNDECLARED);
    return out;
  }
  const list = async (args: string[]) => {
    const result = await exec(git, ["--literal-pathspecs", "ls-files", "-z", ...args, "--", ...paths], { cwd: root });
    if (result.code !== 0) throw new Error(`git ls-files failed while applying ${PUBLIC_IGNORE}: ${(result.stderr || result.stdout).trim()}`);
    return new Set(result.stdout.split("\0").filter(Boolean));
  };
  const excluded = await list(["--cached", "--others", "--ignored", `--exclude-from=${PUBLIC_IGNORE}`]);
  const published = await list(["--cached", "--others", "--exclude-standard"]);
  for (const path of paths) {
    out.set(path, excluded.has(path) ? { public: false, reason: `excluded from the public mirror by ${PUBLIC_IGNORE} (private)` }
      : published.has(path) ? { public: true, reason: `published by the ${PUBLIC_IGNORE} mirror` }
        : { public: false, reason: "ignored by git, so never published" });
  }
  return out;
}

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

/** git 밖 파일의 공개 여부: `.slop-gate.json` visible glob이 설정 루트 기준 상대 경로나 절대 경로로 선언하면 공개, 아니면 모르는 파일이다. */
export function externalPublication(abs: string, root: string, config: SlopConfig): Publication {
  const inside = relative(root, abs);
  const local = inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? norm(inside) : undefined;
  return matches(config.visible, norm(abs)) || (local !== undefined && matches(config.visible, local)) ? DECLARED : UNDECLARED;
}

/**
 * 호출자의 명시 선언(slop_check public:true). 선언 없는(unknown) 파일 중 보이는 산출물 형식인 것만 공개로 바꾸고, `.publicignore`가 지운
 * 비공개 파일·git이 무시한 파일·내부 기록·코드는 바꾸지 않는다. path는 classify에 넘길 경로(저장소·cwd 상대 또는 절대)다.
 */
export function withDeclaration(publication: Publication, path: string): Publication {
  if (publication.public || !publication.unknown) return publication;
  const kind = classify(path);
  return kind.visible ? { public: true, reason: "declared public by the caller (public:true)" } : { public: false, reason: `${kind.reason}; a public:true declaration cannot make it public` };
}

/**
 * slop_check 대상(실제 절대 경로)의 공개 여부. git 안이면 그 저장소의 repoPublication(선언은 .publicignore·.slop-gate.json뿐), 밖이면
 * externalPublication이고, declared(public:true 또는 이번 입력에서 그렇게 선언한 파일)는 git 밖의 모르는 파일만 바꾼다.
 * 저장소 상태를 읽지 못한 파일은 error로 돌려준다.
 */
export async function publicationOf(paths: readonly string[], cwd: string, declared: (abs: string) => boolean, exec: Exec = spawnExec(), gitFor?: (root: string) => Promise<string>): Promise<Map<string, Publication>> {
  const out = new Map<string, Publication>();
  const root = configRootOf(cwd);
  const config = loadSlopConfig(root);
  // 공개여도 내부·생성물·테스트로 분류되는 파일은 대상이 아니다(게이트들과 같은 분류가 먼저다).
  const veto = (found: Publication, path: string, cfg: SlopConfig): Publication => {
    if (!found.public) return found;
    const kind = classify(path, cfg);
    return kind.visible ? found : { public: false, reason: `${kind.reason}, not a gated artifact` };
  };
  const repos = new Map<string, { abs: string; rel: string }[]>();
  for (const abs of paths) {
    const repo = gitRootOf(abs);
    if (!repo) {
      const inside = relative(cwd, abs);
      const local = inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : abs;
      const found = externalPublication(abs, root, config);
      out.set(abs, veto(declared(abs) ? withDeclaration(found, local) : found, local, config));
      continue;
    }
    const group = repos.get(repo) ?? [];
    group.push({ abs, rel: relative(repo, abs).split(sep).join("/") });
    repos.set(repo, group);
  }
  for (const [repo, files] of repos) {
    let found: Map<string, Publication>;
    const repoConfig = loadSlopConfig(repo);
    try { found = await repoPublication(exec, (await gitFor?.(repo)) ?? "git", repo, files.map((file) => file.rel), repoConfig); } catch (error) {
      for (const file of files) out.set(file.abs, { public: false, error: true, reason: `could not decide whether it is public: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    for (const file of files) out.set(file.abs, veto(found.get(file.rel)!, file.rel, repoConfig));
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

// ── 원장 ─────────────────────────────────────────────────────────────────────

export interface SlopFindingRecord { id: string; quote: string; rule: string; fix: string; quoteFound?: boolean; reviewer?: string }
export interface SlopReviewRecord {
  type: "slop-review"; reviewId: string; ts: string; model: string;
  reviewers?: { family: string; model?: string; status: string; error?: string; raw?: string; advisory?: true }[];
  files: { path: string; sha256: string; scope?: string; findings: SlopFindingRecord[] }[];
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
  /** 요청한 모든 경로의 blob(보이는 산출물은 통과를 맞춘 바로 그 바이트의 blob). finalizer가 잠금 안에서 stage된 내용과 대조한다. */
  gateBlobs?: Record<string, string>;
  /** 보이는 형식이지만 공개 산출물이 아니라 게이트가 보지 않은 파일(요청한 경로)과 그 이유. 통과가 아니다. */
  notPublic?: { path: string; reason: string }[];
}

/**
 * git_finalize가 cross-review 다음에 부르는 게이트. 새로 커밋할 변경이 없는 파일(resume-push)과 삭제는 대상이 아니고, 공개 산출물이 아닌
 * 파일(repoPublication)은 바이트를 읽지 않고 notPublic으로 알린다. 통과 기록이 없으면 SlopGateRefusal. waiver는 기록을 남기고 통과시킨다.
 * 입력 모양이 잘못된 경우(절대 경로 등)만 finalizer.ps1의 판정에 맡기고, 저장소 상태나 공개 여부를 읽지 못하면 열어 두지 않는다.
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
  const visible = changed.filter((change) => change.status !== "deleted" && classify(change.path, config).visible);
  if (visible.length === 0) return { checked: true, artifacts: [], notPublic: [] };

  const inputOf = new Map(resolved.targets.map((target) => [target.path, target.input]));
  let publication: Map<string, Publication>;
  try { publication = await repoPublication(exec, git, resolved.root, visible.map((change) => change.path), config); } catch (error) {
    throw new SlopGateRefusal(`could not decide which files are public, so the slop-gate requirement cannot be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
  const notPublic = visible.filter((change) => !publication.get(change.path)!.public)
    .map((change) => ({ path: inputOf.get(change.path) ?? change.path, reason: publication.get(change.path)!.reason }));
  const gated = visible.filter((change) => publication.get(change.path)!.public);
  if (gated.length === 0) return { checked: true, artifacts: [], notPublic };

  const records = readSlopRecords(options.ledgerPath);
  const artifacts: { path: string; sha256: string }[] = [];
  const blobs: Record<string, string> = {};
  const uncovered: { input: string; sha256: string; note?: string }[] = [];
  for (const change of gated) {
    const abs = join(resolved.root, ...change.path.split("/"));
    let bytes: Buffer;
    try { bytes = readFileSync(abs); } catch (error) {
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
        `Next: run slop_check {files:${names}, authors:[<the model selectors that wrote the text, or "main">]} (reviewers follow the same author-family rule as cross_review; only text changed since HEAD is reviewed for tracked files), fix or refute every finding (a clean review records the pass by itself; refuted findings are closed with slop_check {action:"resolve"}), then call git_finalize again with the same files. Do not edit these files after the pass: it is tied to their exact content (sha256).`,
        "A waiver (slopGateWaiver) is allowed only on the user's explicit instruction and is recorded in the slop-gate ledger.",
        ...(notPublic.length > 0 ? [`Not gated because they are not public artifacts (no pass either): ${notPublic.map((file) => `${file.path} (${file.reason})`).join("; ")}.`] : []),
      ].join("\n"));
    }
    try {
      appendSlopRecord(options.ledgerPath, {
        type: "slop-waiver", ts: (options.now?.() ?? new Date()).toISOString(), root: resolved.root, reason,
        files: gated.map((change) => ({ path: change.path, sha256: artifacts.find((artifact) => artifact.path === change.path)!.sha256 })),
      });
    } catch { throw new SlopGateRefusal("slop-gate waiver could not be recorded in the slop-gate ledger; refusing to commit without a record."); }
    return { checked: true, waived: true, artifacts, gateBlobs, notPublic };
  }
  return { checked: true, artifacts, gateBlobs, notPublic };
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

/** slop_check {public:true}가 선언한 파일(적힌 경로와 실제 경로). 턴 끝 게이트는 이번 입력 동안 이 파일을 공개로 본다. */
export function declaredPublic(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
  if (toolName !== "slop_check" || input.public !== true || !Array.isArray(input.files)) return [];
  const out: string[] = [];
  for (const file of input.files) {
    if (typeof file !== "string" || !file.trim()) continue;
    const spelled = wslPath(file.trim());
    const lexical = isAbsolute(spelled) ? resolve(spelled) : resolve(cwd, spelled);
    out.push(lexical);
    try { out.push(realpathSync(lexical)); } catch { /* 아직 없는 파일은 적힌 경로만 */ }
  }
  return out;
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
 * 턴 끝 판정. 후보 중 존재하고, 턴 시작 이후 바뀌었고, git 밖이고, 보이는 산출물이며, 공개 선언(`.slop-gate.json` glob 또는 이번 입력의
 * slop_check public:true, declared)이 있고, 현재 내용의 통과가 없는 것. 선언 없는 저장소 밖 문서는 모르는 파일이라 깨우지 않는다.
 * since는 mtime 시계 차이(Windows 드라이브)를 감안해 2초 일찍 잡는다.
 */
export function pendingArtifacts(
  tracked: { files: Iterable<string>; dirs: Iterable<string> }, cwd: string, since: number, records: readonly SlopRecord[], declared: ReadonlySet<string> = new Set(),
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
    // 링크는 실제 경로로만 판정하고 읽는다: 별칭 이름이 산출물처럼 보여도 대상의 저장소·분류·공개 선언을 따른다.
    let real: string;
    try { real = realpathSync(path); } catch { continue; }
    if (insideGit(real)) continue;
    // cwd 안 파일은 상대 경로로 분류한다(폴더 규칙이 적용되고, cwd가 /tmp 아래여도 산출물로 본다).
    const inside = relative(base, real);
    const kind = classify(inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : real, config);
    if (!kind.visible) continue;
    if (!externalPublication(real, root, config).public && !declared.has(real)) continue;
    let bytes: Buffer;
    try {
      const stat = statSync(real);
      if (!stat.isFile() || stat.mtimeMs < floor) continue;
      bytes = readFileSync(real);
    } catch { continue; }
    const hash = sha256(bytes);
    if (!passFor(records, hash)) out.push({ path, sha256: hash, reason: kind.reason });
  }
  return out;
}
