import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";

/**
 * WSL 배포 완료를 읽기 전용으로 검증한다(deploy-ops.md WSL 배포 항목의 완료 기준 네 가지).
 *  1) 가장 최근 `~/.omp/wsl-update/<UTC시각>.log`의 `READY <revision> ...` 줄이 요청한 revision과 같은가
 *  2) `launch.ps1 -Status`(Windows PowerShell)가 `matched:true`인가
 *  3) `node ~/cuelo-run/install.mjs health`가 서비스 4개 모두 OK인가
 *  4) `GET /api/models?cwd=<cwd>`의 `roles`(배열)가 WSL `~/.omp/agent/config.yml` `modelRoles`와 같은가
 * 서버를 띄우거나 내리거나 되돌리거나 배포하지 않는다. 실행하는 외부 명령은 정확히 세 가지다:
 *  - `wslpath -w <launch.ps1>`
 *  - `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <launch.ps1> -Status [-Distribution <배포판>]`  (`-Status` 없이 `-Run`/무인자 금지)
 *  - `node <~/cuelo-run>/install.mjs health`
 * 나머지는 파일 읽기와 로컬 GET 한 번이다. 각 구간은 던지지 않고 자기 실패를 `error`로 보고한다.
 */

export interface DeployVerifyParams {
  revision: string;
  cwd?: string;
  distro?: string;
}

export interface ExecResult { code: number; stdout: string; stderr?: string; killed?: boolean }
export type Exec = (command: string, args: string[], options: { cwd: string; timeout?: number }) => Promise<ExecResult>;

export interface FetchResult { status: number; text: string }

export interface VerifyDeps {
  exec: Exec;
  /** 파일 읽기. 없거나 읽을 수 없으면 undefined. */
  readText: (path: string) => Promise<string | undefined>;
  /** 디렉터리의 파일 이름 목록. 읽을 수 없으면 undefined. */
  listDir: (path: string) => Promise<string[] | undefined>;
  /** 로컬 GET. 연결 실패는 던진다. */
  get: (url: string) => Promise<FetchResult>;
  home: string;
  /** 현재 WSL 배포판 이름(WSL_DISTRO_NAME). 없으면 undefined. */
  envDistro?: string;
  portBase: number;
}

export interface UpdateLogSection {
  file?: string;
  readyRevision: string | null;
  matches: boolean;
  error?: string;
}

export interface LaunchStatusSection {
  matched: boolean;
  raw?: unknown;
  error?: string;
}

export interface HealthSection {
  ok: number;
  total: number;
  lines?: string[];
  error?: string;
}

export interface RoleMismatch { role: string; config: string; live: string | null }
export type RolesSection = { configured: number; mismatches: RoleMismatch[] } | { error: string };

export interface VerifyResult {
  updateLog: UpdateLogSection;
  launchStatus: LaunchStatusSection;
  health: HealthSection;
  roles: RolesSection;
  /** 네 구간이 모두 통과했을 때만 true. 통과 판정은 Main이 한다. */
  pass: boolean;
  verdict: string;
}

const REVISION = /^[0-9a-f]{7,40}$/i;
const UPDATE_LOG_NAME = /^\d{8}T\d{6}Z\.log$/;
// `WSL_CUELO_READY http://...` 같은 줄과 섞이지 않게 READY가 단어 단독인 줄만 본다.
const READY_LINE = /(?:^|\s)READY\s+([0-9a-f]{7,40})(?=\s|$)/i;
const HEALTH_LINE = /^(OK|FAIL)\s+(\S+)\s+/;
const EXEC_TIMEOUT_MS = 60_000;
const GET_TIMEOUT_MS = 15_000;
export const DEFAULT_PORT_BASE = 30141;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeFailure(label: string, result: ExecResult): string {
  const detail = (result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-3).join(" | ");
  return `${label} (exit ${result.code}${result.killed ? ", timed out/killed" : ""}): ${detail || "출력 없음"}`;
}

/** 로그에서 마지막 `READY <sha>` 줄의 sha를 뽑는다. 없으면 null. */
export function parseReadyRevision(logText: string): string | null {
  let found: string | null = null;
  for (const line of logText.split(/\r?\n/)) {
    const match = READY_LINE.exec(line);
    if (match) found = match[1].toLowerCase();
  }
  return found;
}

/** 요청 revision(전체 또는 7자 이상 접두어)이 READY revision과 같은 커밋을 가리키는지 본다. */
export function revisionMatches(requested: string, ready: string): boolean {
  const a = requested.toLowerCase();
  const b = ready.toLowerCase();
  return REVISION.test(a) && REVISION.test(b) && (b.startsWith(a) || a.startsWith(b));
}

/** 이름이 `<YYYYMMDD>T<HHMMSS>Z.log`인 파일 중 가장 최근(이름 사전순 최대) 것. `update.lock` 등은 거른다. */
export function newestUpdateLog(names: string[]): string | undefined {
  return names.filter((name) => UPDATE_LOG_NAME.test(name)).sort().at(-1);
}

/** 객체가 아니거나 키가 없으면 undefined. 외부 JSON을 캐스트 없이 읽는 데 쓴다. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

/** `launch.ps1 -Status` 출력에서 JSON 객체를 찾는다. 종료 코드 3(불일치)도 JSON을 함께 낸다. */
export function parseLaunchStatus(stdout: string): LaunchStatusSection {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) return { matched: false, error: `JSON 출력이 없습니다: ${stdout.trim().slice(0, 200) || "출력 없음"}` };
  try {
    const raw: unknown = JSON.parse(stdout.slice(start, end + 1));
    return { matched: field(raw, "matched") === true, raw };
  } catch (error) {
    return { matched: false, error: `JSON 해석 실패: ${message(error)}` };
  }
}

/** `install.mjs health` 출력(`OK   name ...` / `FAIL name ...`)에서 정상 서비스 수와 전체 수를 센다. */
export function parseHealth(stdout: string): HealthSection {
  const lines = stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => HEALTH_LINE.test(line));
  return { ok: lines.filter((line) => line.startsWith("OK")).length, total: lines.length, lines };
}

/**
 * config.yml의 최상위 `modelRoles`를 role→selector로 읽는다. 시스템 python/yaml 대신 Bun 내장 YAML 파서를 쓴다(engines bun>=1.4.2).
 * 문자열이 아닌 값은 조용히 빼지 않고 던진다: 빠진 역할이 "불일치 0"으로 보이면 안 된다.
 */
export function parseModelRoles(yamlText: string): Record<string, string> {
  const modelRoles = field(Bun.YAML.parse(yamlText), "modelRoles");
  if (modelRoles === undefined || modelRoles === null) return {};
  if (typeof modelRoles !== "object" || Array.isArray(modelRoles)) throw new Error("modelRoles가 매핑이 아닙니다.");
  const roles: Record<string, string> = {};
  for (const [role, selector] of Object.entries(modelRoles)) {
    if (typeof selector !== "string" || !selector.trim()) throw new Error(`modelRoles.${role} 값이 selector 문자열이 아닙니다.`);
    roles[role] = selector.trim();
  }
  return roles;
}

/** `/api/models` 응답에서 `roles`(배열 `{role, selector, ...}`)를 role→selector 맵으로 바꾼다. 모양이 다르면 던진다. */
export function liveRoleSelectors(body: unknown): Record<string, string> {
  const roles = field(body, "roles");
  if (!Array.isArray(roles)) throw new Error("응답의 roles가 배열이 아닙니다.");
  const map: Record<string, string> = {};
  for (const entry of roles) {
    const role = field(entry, "role");
    const selector = field(entry, "selector");
    if (typeof role === "string" && typeof selector === "string") map[role] = selector;
  }
  return map;
}

/** config의 각 role을 live와 대조한다. live에 없는 role(위젯 등)은 config에 없으니 비교 대상이 아니다. */
export function compareRoles(config: Record<string, string>, live: Record<string, string>): { configured: number; mismatches: RoleMismatch[] } {
  const mismatches: RoleMismatch[] = [];
  for (const [role, selector] of Object.entries(config)) {
    if (live[role] !== selector) mismatches.push({ role, config: selector, live: live[role] ?? null });
  }
  return { configured: Object.keys(config).length, mismatches };
}

const CWD_REQUIRED = "cwd가 필요합니다: /api/models는 cwd 없이 호출하면 403(Access denied)으로 답합니다. 세션 cwd를 cwd 인자로 넘기세요.";

export async function checkUpdateLog(revision: string, deps: VerifyDeps): Promise<UpdateLogSection> {
  if (!REVISION.test(revision)) return { readyRevision: null, matches: false, error: "revision은 7~40자 16진 SHA(접두어 가능)여야 합니다." };
  const dir = `${deps.home}/.omp/wsl-update`;
  const names = await deps.listDir(dir);
  if (!names) return { readyRevision: null, matches: false, error: `업데이트 로그 폴더를 읽을 수 없습니다: ${dir}` };
  const name = newestUpdateLog(names);
  if (!name) return { readyRevision: null, matches: false, error: `${dir}에 <UTC시각>.log 파일이 없습니다.` };
  const file = `${dir}/${name}`;
  const text = await deps.readText(file);
  if (text === undefined) return { file, readyRevision: null, matches: false, error: `로그를 읽을 수 없습니다: ${file}` };
  const ready = parseReadyRevision(text);
  if (!ready) return { file, readyRevision: null, matches: false, error: "로그에 READY <revision> 줄이 없습니다(갱신이 끝나지 않았거나 실패)." };
  return { file, readyRevision: ready, matches: revisionMatches(revision, ready) };
}

export async function checkLaunchStatus(deps: VerifyDeps, distro: string | undefined): Promise<LaunchStatusSection> {
  const script = `${deps.home}/cuelo-run/Tools/CUELO_Setup/wsl/launch.ps1`;
  try {
    const conv = await deps.exec("wslpath", ["-w", script], { cwd: deps.home, timeout: EXEC_TIMEOUT_MS });
    const windowsPath = conv.stdout.trim();
    if (conv.code !== 0 || !windowsPath) return { matched: false, error: describeFailure("wslpath -w", conv) };
    // 반드시 -Status. 이것이 없으면 런처가 서버를 띄우거나 재시작한다. 이 호출은 자식 프로세스를 남기지 않아 파이프가 물리지 않는다.
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowsPath, "-Status"];
    if (distro) args.push("-Distribution", distro);
    const result = await deps.exec("powershell.exe", args, { cwd: deps.home, timeout: EXEC_TIMEOUT_MS });
    const parsed = parseLaunchStatus(result.stdout);
    if (parsed.error) return result.code === 0 ? parsed : { ...parsed, error: `${describeFailure("launch.ps1 -Status", result)}; ${parsed.error}` };
    // launch.ps1 -Status는 일치면 exit 0, 불일치면 exit 3이다. kill·다른 종료 코드·코드와 JSON이 엇갈리면 실행이 끝났다고 보지 않는다.
    const expectedCode = parsed.matched ? 0 : 3;
    if (result.killed || result.code !== expectedCode) {
      return { matched: false, raw: parsed.raw, error: `${describeFailure("launch.ps1 -Status", result)}; JSON matched:${parsed.matched}인데 exit ${expectedCode}가 아닙니다.` };
    }
    return parsed;
  } catch (error) {
    return { matched: false, error: `launch.ps1 -Status 실행 실패: ${message(error)}` };
  }
}

export async function checkHealth(deps: VerifyDeps): Promise<HealthSection> {
  const root = `${deps.home}/cuelo-run`;
  try {
    const result = await deps.exec("node", [`${root}/install.mjs`, "health"], { cwd: root, timeout: EXEC_TIMEOUT_MS });
    const parsed = parseHealth(result.stdout);
    if (parsed.total === 0) return { ok: 0, total: 0, error: describeFailure("install.mjs health", result) };
    // install.mjs health는 전부 OK면 exit 0, FAIL이 하나라도 있으면 exit 1이다. kill되었거나 종료 코드가 FAIL 줄과 맞지 않으면 목록이 끝까지 나온 게 아니다.
    const hasFail = parsed.ok !== parsed.total;
    if (result.killed || (result.code === 0) === hasFail || (result.code !== 0 && result.code !== 1)) {
      return { ...parsed, error: describeFailure("install.mjs health", result) };
    }
    return parsed;
  } catch (error) {
    return { ok: 0, total: 0, error: `install.mjs health 실행 실패: ${message(error)}` };
  }
}

export async function checkRoles(cwd: string | undefined, deps: VerifyDeps): Promise<RolesSection> {
  if (!cwd?.trim()) return { error: CWD_REQUIRED };
  const configPath = `${deps.home}/.omp/agent/config.yml`;
  const configText = await deps.readText(configPath);
  if (configText === undefined) return { error: `config를 읽을 수 없습니다: ${configPath}` };
  let config: Record<string, string>;
  try {
    config = parseModelRoles(configText);
  } catch (error) {
    return { error: `${configPath}의 modelRoles를 읽지 못했습니다: ${message(error)}` };
  }
  if (Object.keys(config).length === 0) return { error: `${configPath}에서 modelRoles를 찾지 못했습니다.` };
  const url = `http://127.0.0.1:${deps.portBase}/api/models?cwd=${encodeURIComponent(cwd)}`;
  let response: FetchResult;
  try {
    response = await deps.get(url);
  } catch (error) {
    return { error: `GET ${url} 실패: ${message(error)}` };
  }
  if (response.status === 403) return { error: `GET /api/models 403 Access denied: cwd(${cwd})가 서버에 허용된 세션 cwd가 아닙니다.` };
  if (response.status !== 200) return { error: `GET /api/models -> HTTP ${response.status}: ${response.text.slice(0, 200)}` };
  try {
    return compareRoles(config, liveRoleSelectors(JSON.parse(response.text)));
  } catch (error) {
    return { error: `/api/models 응답을 해석하지 못했습니다: ${message(error)}` };
  }
}

export function buildVerdict(result: Omit<VerifyResult, "pass" | "verdict">): { pass: boolean; verdict: string } {
  const problems: string[] = [];
  const { updateLog, launchStatus, health, roles } = result;
  if (!updateLog.matches) problems.push(`updateLog: ${updateLog.error ?? `READY ${updateLog.readyRevision}이(가) 요청 revision과 다름`}`);
  if (!launchStatus.matched || launchStatus.error) problems.push(`launchStatus: ${launchStatus.error ?? "matched:false"}`);
  if (health.error || health.total === 0 || health.ok !== health.total) problems.push(`health: ${health.error ?? `${health.ok}/${health.total}`}`);
  if ("error" in roles) problems.push(`roles: ${roles.error}`);
  else if (roles.mismatches.length > 0) problems.push(`roles: ${roles.mismatches.length}/${roles.configured} 불일치(${roles.mismatches.map((m) => m.role).join(", ")})`);
  if (problems.length === 0 && !("error" in roles)) {
    return { pass: true, verdict: `PASS: READY ${updateLog.readyRevision?.slice(0, 12)}, launcher matched, health ${health.ok}/${health.total}, roles ${roles.configured}개 일치` };
  }
  return { pass: false, verdict: `NOT VERIFIED: ${problems.join("; ")}` };
}

export async function runDeployVerify(params: DeployVerifyParams, deps: VerifyDeps): Promise<VerifyResult> {
  const distro = params.distro?.trim() || deps.envDistro;
  const [updateLog, launchStatus, health, roles] = await Promise.all([
    checkUpdateLog(params.revision.trim(), deps),
    checkLaunchStatus(deps, distro),
    checkHealth(deps),
    checkRoles(params.cwd, deps),
  ]);
  const parts = { updateLog, launchStatus, health, roles };
  return { ...parts, ...buildVerdict(parts) };
}

export function formatVerifyResult(result: VerifyResult): string {
  const { verdict, pass: _pass, ...sections } = result;
  return `${verdict}\n${JSON.stringify(sections, null, 2)}`;
}

const defaultDeps = (exec: Exec): VerifyDeps => ({
  exec,
  readText: (path) => readFile(path, "utf8").then((text) => text, () => undefined),
  listDir: (path) => readdir(path).then((names) => names, () => undefined),
  get: async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
    return { status: response.status, text: await response.text() };
  },
  home: homedir(),
  envDistro: process.env.WSL_DISTRO_NAME || undefined,
  portBase: DEFAULT_PORT_BASE,
});

const factory: CustomToolFactory = (pi) => ({
  name: "deploy_verify",
  label: "Deploy Verify",
  loadMode: "essential",
  description:
    "Read-only verification that a WSL CUELO deploy finished: (1) newest ~/.omp/wsl-update/*.log has `READY <revision>` matching the given revision (prefix ok), "
    + "(2) `launch.ps1 -Status` reports matched:true, (3) `node ~/cuelo-run/install.mjs health` shows all services OK, "
    + "(4) GET /api/models?cwd=<cwd> `roles` equal `modelRoles` in ~/.omp/agent/config.yml (cwd required; without it the route answers 403). "
    + "Returns JSON per section plus a one-line verdict; each section reports its own failure. "
    + "Never starts, stops, restarts, rolls back or deploys anything: launch.ps1 is only ever called with -Status.",
  parameters: pi.zod.object({
    revision: pi.zod.string().describe("Deployed revision to expect: full or prefix (>=7 hex) commit SHA"),
    cwd: pi.zod.string().optional().describe("A session cwd the CUELO server accepts (required for the roles check; e.g. ~/src/CUELO-private)"),
    distro: pi.zod.string().optional().describe("WSL distribution for launch.ps1 -Distribution (default: current WSL_DISTRO_NAME; office PC: Ubuntu)"),
  }),

  async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
    const exec: Exec = (command, args, options) => pi.exec(command, args, { ...options, signal });
    const result = await runDeployVerify(params as DeployVerifyParams, defaultDeps(exec));
    return { content: [{ type: "text", text: formatVerifyResult(result) }], details: result };
  },
});

export default factory;
