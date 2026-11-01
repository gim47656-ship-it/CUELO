import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type EgoProfile = "user" | "verify";
/** windows: WSL에서 Windows ego lite의 `ego-browser nodejs`. linux: 네이티브 Linux에서 ego Chromium(CDP)에 붙는 오픈소스 ego-browser SDK. 두 SDK의 TaskSpace API가 다르다. */
export type EgoHost = "windows" | "linux";

export interface EgoBrowserParams {
  script: string;
  profile?: EgoProfile;
  finish?: boolean;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

/** `ego-browser <args>`를 실행하고 `input`을 stdin으로 넘긴다. 실행 파일이 없으면 code ENOENT로 throw한다. */
export type Exec = (args: string[], input: string, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<ExecResult>;

export interface EgoDeps {
  exec: Exec;
  sessionId: string;
  host?: EgoHost;
}

/**
 * 프로필 정본: "user"는 ego 기본 프로필(사용자 로그인), "verify"는 사용자가 CUELO 화면 검증 전용으로 만든, 어디에도 로그인하지 않은 프로필.
 * 디렉터리 id(`Profile 2` 등)는 PC마다 다르다(10-22 집은 `Profile 2`가 사용자 프로필이었다). 그래서 표시 이름으로 찾는다.
 */
export const VERIFY_PROFILE_NAME = "CUELO 검증";
/** 검증 프로필이 없을 때의 오류 표지. 다른 프로필로 넘어가지 않는다(사용자 로그인이 든 프로필로 검증하지 않는다). */
export const VERIFY_PROFILE_MISSING = "ego_browser: 검증 프로필이 없다";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
const MAX_HEAD = 20_000;
const MAX_TAIL = 8_000;

const UNAVAILABLE =
  "ego_browser: 이 PC에는 ego lite가 없다(ego-browser 래퍼가 127로 끝났다). 이 PC에서는 ego_browser를 쓸 수 없으니 기존 `browser` 도구(OMP Relay)를 쓴다.";
const LINUX_UNAVAILABLE =
  "ego_browser: 이 PC의 ego 브라우저에 붙지 못했다. `browser.open`으로 대신한다(사용자 브라우저는 `app: { cdp_url: \"http://127.0.0.1:32899\" }`, 검증은 `app: { relay: false }` headless).";
/**
 * Linux SDK는 TaskSpace마다 기본 프로필의 쿠키를 복사한다(ego-browser.mjs copyDefaultCookies). 로그아웃 검증 프로필을 보장할 수 없어 verify는 실행 전에 거절한다.
 */
export const LINUX_VERIFY_UNSUPPORTED =
  "ego_browser: 이 Linux PC에는 검증 프로필이 없다(ego TaskSpace가 사용자 쿠키를 복사한다). 화면 검증은 `browser.open`에 `app: { relay: false }`를 준 headless로 한다.";

/** 세션·프로필마다 고정된 TaskSpace 이름. 같은 이름은 ego가 새로 만들지 않고 이어 쓴다. 세션 id를 자르지 않아 다른 세션이 공간을 공유하지 않는다. */
export function spaceName(sessionId: string, profile: EgoProfile): string {
  return `cuelo-${sessionId}-${profile}`;
}

/** 이미 있는 공간에 profileId를 주면 ego가 거절한다. 그 거절만 profileId 없이 이어 쓰기로 바꾼다(그 밖의 오류는 그대로 던진다). */
export const RESUME_ERROR_MARKER = "only applies when creating";

/**
 * 모델 스크립트 앞에 붙이는 머리말. `task`와 `page`(p1)를 묶는다. profileId는 공간을 처음 만들 때만 적용된다.
 * verify는 ego `profiles()`에서 이름이 VERIFY_PROFILE_NAME인 프로필의 id를 쓴다. 없으면 공간을 만들지 않고 던진다.
 */
export function buildPrelude(name: string, profile: EgoProfile, host: EgoHost = "windows"): string {
  const quoted = JSON.stringify(name);
  if (host === "linux") {
    // `page`는 SDK가 미리 넣은 전역(선택된 공간의 현재 탭)이라 다시 선언하지 않는다. Windows의 task 모양(handOff·finish·page)을 맞춘다.
    return `const __egoSpace = await taskSpaces.useOrCreate(${quoted});
const task = {
  id: __egoSpace.id,
  name: __egoSpace.name,
  page: () => page,
  handOff: () => taskSpaces.handOff(__egoSpace.id),
  takeOver: () => taskSpaces.takeOver(__egoSpace.id),
  finish: (options = {}) => taskSpaces.complete(__egoSpace.id, { keep: Array.isArray(options.keep) ? options.keep.length > 0 : Boolean(options.keep) }),
};
`;
  }
  if (profile !== "verify") return `const task = await taskSpace(${quoted});\nconst page = task.page("p1");\n`;
  const wanted = JSON.stringify(VERIFY_PROFILE_NAME);
  const missing = JSON.stringify(`${VERIFY_PROFILE_MISSING}(이름 「${VERIFY_PROFILE_NAME}」). ego lite에서 로그인하지 않은 새 프로필을 이 이름으로 만들어야 한다. 사용자 프로필로 대신 검증하지 않는다.`);
  return `const verifyProfile = (await profiles()).find((item) => item.name === ${wanted});
if (!verifyProfile) throw new Error(${missing});
const task = await taskSpace(${quoted}, { profileId: verifyProfile.id }).catch((error) => {
  if (String(error?.message).includes(${JSON.stringify(RESUME_ERROR_MARKER)})) return taskSpace(${quoted});
  throw error;
});
const page = task.page("p1");
`;
}

/** finish가 true면 스크립트가 던져도 공간을 정리한다. 본문은 블록 안에서 돈다. */
export function buildScript(name: string, profile: EgoProfile, body: string, finish: boolean, host: EgoHost = "windows"): string {
  const prelude = buildPrelude(name, profile, host);
  if (!finish) return `${prelude}${body}\n`;
  return `${prelude}try {\n${body}\n} finally {\n  await task.finish({ keep: [] });\n}\n`;
}

/**
 * 세션 종료 때 쓰는 정리 스크립트. 공간을 새로 만들지 않고 ego의 목록(listTaskSpaces)에서 이름으로 찾는다.
 * `task.handOff()` 뒤에는 ownership이 "agentDelegatedToUser"로 바뀌고(0.6.0.16 실측), 사용자 소유 공간도 "agent"가 아니다.
 * 에이전트가 만들고 아직 에이전트가 쥔 공간만 닫고, 나머지는 사용자 몫이라 그대로 둔다.
 */
export function buildCleanup(name: string, host: EgoHost = "windows"): string {
  const quoted = JSON.stringify(name);
  const list = host === "linux" ? "taskSpaces.list()" : "listTaskSpaces()";
  const close = host === "linux" ? "await taskSpaces.complete(found.id, { keep: false });" : "await (await taskSpace(found.id)).finish({ keep: [] });";
  return `const found = (await ${list}).find((space) => space.name === ${quoted});
if (found && found.createdBy === "agent" && found.ownership === "agent") {
  ${close}
  console.log("closed", found.id);
} else {
  console.log("skipped", found ? found.ownership : "not found");
}
`;
}

function clip(text: string): string {
  if (text.length <= MAX_HEAD + MAX_TAIL) return text;
  return `${text.slice(0, MAX_HEAD)}\n… ${text.length - MAX_HEAD - MAX_TAIL}자 생략 …\n${text.slice(-MAX_TAIL)}`;
}

export function isUnavailable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export interface EgoRun {
  text: string;
  spaceName: string;
  profile: EgoProfile;
  finished: boolean;
  result: ExecResult;
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

export async function runEgoBrowser(params: EgoBrowserParams, deps: EgoDeps, signal?: AbortSignal): Promise<EgoRun> {
  if (!params.script || !params.script.trim()) throw new Error("ego_browser: script가 비어 있다.");
  const profile: EgoProfile = params.profile ?? "user";
  if (profile !== "user" && profile !== "verify") throw new Error(`ego_browser: profile은 "user" 또는 "verify"다: ${String(profile)}`);
  const host: EgoHost = deps.host ?? "windows";
  if (host === "linux" && profile === "verify") throw new Error(LINUX_VERIFY_UNSUPPORTED);
  const unavailable = host === "linux" ? LINUX_UNAVAILABLE : UNAVAILABLE;
  const finish = params.finish === true;
  const name = spaceName(deps.sessionId, profile);
  const input = buildScript(name, profile, params.script, finish, host);
  const timeoutMs = clampTimeout(params.timeoutMs);
  let result: ExecResult;
  try {
    result = await deps.exec(["nodejs"], input, { timeoutMs, signal });
  } catch (error) {
    if (isUnavailable(error)) throw new Error(unavailable);
    throw error;
  }
  if (result.code === 127) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`${unavailable}${detail ? `\n${detail}` : ""}`);
  }
  const label = `TaskSpace ${name} (${profile === "verify" ? `${VERIFY_PROFILE_NAME}, 검증 전용` : "사용자 기본 프로필"})`;
  // ego-browser nodejs는 console.log를 stderr로 보낸다. 성공 때는 두 스트림이 모두 스크립트 출력이다.
  const clean = (text: string) => clip(text.trim());
  const failed = result.killed || result.code !== 0;
  const body = failed
    ? [result.stdout.trim() && clean(result.stdout), result.stderr.trim() && `[stderr]\n${clean(result.stderr)}`].filter(Boolean).join("\n")
    : [result.stdout.trim() && clean(result.stdout), result.stderr.trim() && clean(result.stderr)].filter(Boolean).join("\n");
  if (result.killed) {
    throw new Error(`ego_browser: ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 중단했다(또는 취소됨). ${label}은 남아 있을 수 있다. 같은 공간에서 다시 시도하거나 finish: true로 정리한다.${body ? `\n${body}` : ""}`);
  }
  if (result.code !== 0) {
    // 권한 팝업은 브라우저가 띄운 것이라 사용자만 처리할 수 있다(ego-browser skill 「User control and completion」).
    // 10-30 감사: 같은 스크립트 4회 재전송과 takeOverTaskSpace 우회 3회가 모두 실패했다.
    // 표시용 body는 앞뒤만 남기므로 가운데 묻힌 문구를 놓치지 않게 원문 두 스트림에서 찾는다.
    const hint = /permission prompt for .+ has appeared/i.test(`${result.stdout}\n${result.stderr}`)
      ? "\n권한 팝업은 사용자가 허용·거부해야 한다. 같은 스크립트를 다시 보내거나 우회하지 않는다. `await task.handOff()`로 넘기고 사용자에게 무엇을 눌러야 하는지 알린 뒤, 사용자가 계속하라고 하면 이어 간다."
      : "";
    throw new Error(`ego_browser: exit ${result.code}. ${label}${body ? `\n${body}` : ""}${hint}`);
  }
  const text = `${label}${finish ? " — 정리됨" : ""}\n${body || "(출력 없음)"}`;
  return { text, spaceName: name, profile, finished: finish, result };
}

/**
 * `command args`를 띄우고 스크립트를 stdin으로 보낸다(pi.exec는 stdin이 없다).
 * 시간 초과·취소 때는 자식 프로세스 그룹 전체를 죽이고 close를 기다리지 않고 바로 끝낸다. 래퍼가 만든 하위 프로세스가
 * 파이프를 쥐고 있으면 close가 한참 늦게 오기 때문이다.
 */
function spawnScript(
  command: string,
  args: string[],
  input: string,
  options: { timeoutMs: number; signal?: AbortSignal },
  env?: NodeJS.ProcessEnv,
): Promise<ExecResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (code: number, killed: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    resolve({ code, stdout, stderr, killed });
  };
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: true, env });
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    finish(-1, true);
  };
  const abort = () => kill();
  const timer = setTimeout(kill, options.timeoutMs);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", (error: NodeJS.ErrnoException) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    reject(error);
  });
  child.on("close", (code) => finish(code ?? -1, code === null));
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  return promise;
}

/** 기본 실행기(WSL): PATH의 `ego-browser nodejs`(wsl/bin 래퍼 → Windows ego lite). */
export const defaultExec: Exec = (args, input, options) => spawnScript("ego-browser", args, input, options);

/** WSL이 아닌 Linux인지. WSL 커널의 /proc/version에는 microsoft가 들어 있다. */
export function isNativeLinux(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return !/microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return true;
  }
}

/** 오픈소스 ego-browser SDK의 Linux 호스트 모듈. `EGO_LITE_HOST`로 바꿀 수 있다. */
export function linuxHostPath(): string {
  return process.env.EGO_LITE_HOST || join(homedir(), "Applications", "ego-lite-linux-source", "platform", "linux", "ego-browser.mjs");
}

/**
 * Linux 실행기. `~/.local/bin/ego-browser`(Electron `--cli`)는 Electron 자신을 브라우저로 따로 띄워 사용자 창에 붙지 않는다.
 * 그래서 SDK 호스트 모듈을 node로 직접 돌리고, 호스트가 읽는 `DevToolsActivePort`를 사용자 ego Chromium의 CDP로 써 둔다.
 * 공간은 Target.createBrowserContext로 격리된 새 창에 열린다(사용자 창·PWA에 탭을 붙이지 않는다, 사용자 결정 2026-11-02).
 * 그 브라우저가 연결 직전에 꺼지면 호스트가 이 폴더로 빈 Chromium을 새로 띄우려 한다. `/bin/false`로 그 실행을 막는다.
 */
export const linuxExec: Exec = async (_args, input, options) => {
  const host = linuxHostPath();
  const fail = (stderr: string): ExecResult => ({ code: 127, stdout: "", stderr, killed: false });
  if (!existsSync(host)) return fail(`ego-browser SDK 호스트가 없다: ${host} (EGO_LITE_HOST로 지정할 수 있다)`);
  // 사용자의 ego Chromium(`ego-profile-browser`)이 여는 CDP 포트. opencue도 여기에 붙는다.
  const configuredPort = Number(process.env.EGO_LITE_CDP_PORT || 32899);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 32899;
  let browserPath: string;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3_000) });
    const version: unknown = await response.json();
    const endpoint = version && typeof version === "object" && "webSocketDebuggerUrl" in version ? version.webSocketDebuggerUrl : undefined;
    if (typeof endpoint !== "string") throw new Error("/json/version에 webSocketDebuggerUrl이 없다");
    browserPath = new URL(endpoint).pathname;
  } catch (error) {
    return fail(`ego 브라우저 CDP 127.0.0.1:${port}에 연결할 수 없다(ego-profile-browser가 떠 있지 않다): ${error instanceof Error ? error.message : String(error)}`);
  }
  const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cuelo-ego-browser");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "DevToolsActivePort"), `${port}\n${browserPath}\n`);
  return spawnScript("node", [host], input, options, {
    ...process.env,
    EGO_LITE_PROFILE_DIR: stateDir,
    EGO_LITE_STATE_PATH: join(stateDir, "state.json"),
    EGO_BROWSER_EXECUTABLE: "/bin/false",
    EGO_LITE_LAUNCH_TIMEOUT_MS: "1000",
  });
};

function toolDescription(host: EgoHost): string {
  if (host === "linux") {
    const guide = join(dirname(linuxHostPath()), "..", "..", "skills", "ego-browser", "SKILL.md");
    return "Drive ego TaskSpaces in the user's ego Chromium on this Linux PC without a bash heredoc. Each space opens in its own new window with an isolated context that copies the user's logins; it never adds tabs to the user's windows or the CUELO PWA. "
      + "`script` runs in Linux Node.js (ESM, top-level await, not the page): the tool has already run `taskSpaces.useOrCreate(<name>)` and bound `task` (`id`, `handOff()`, `takeOver()`, `finish({ keep })`); `page` is the space's current tab (`page.goto`, `page.snapshot`, `page.evaluate`, locators), and `browser.openOrReuseTab(url, { wait: true })` opens more tabs. "
      + `Read the API guide at \`${guide}\` before first use. `
      + "One TaskSpace is kept per session and resumed on every call (variables do not persist between calls, tabs do). "
      + "Only `profile: \"user\"` exists here; `verify` fails because spaces copy the user's cookies, so CUELO screen verification uses `browser.open` with `app: { relay: false }` (headless). "
      + "Never clear cookies, cache or storage. For login, permission or CAPTCHA steps call `await task.handOff()`, end the script and tell the user; after the user says continue, start the next script with `await task.takeOver()`. "
      + "Set `finish: true` on the last call to close the space; spaces still open when the session ends are closed automatically unless they were handed off to the user. "
      + "If the ego browser is not running the tool says so; then use `browser.open`.";
  }
  return "Drive ego lite TaskSpaces (the `ego-browser` runtime) without a bash heredoc. Only on PCs where ego lite is installed (the tool says so and exits when it is not; then use the normal `browser` tool). "
    + "`script` is the body of an `ego-browser nodejs` script (ESM, top-level await, Node.js, not the page): the tool has already run `const task = await taskSpace(<name>)` and `const page = task.page(\"p1\")`, so use `task`/`page` directly. Browser-side JS goes inside `page.evaluate()`. "
    + "Run `ego-browser skill` once in bash to read the API guide. "
    + "The script's Node.js runs on Windows, so WSL paths such as `/tmp` or `/home` do not exist there: read or write files through `\\\\wsl.localhost\\<distro>\\…` and import local modules as `file://wsl.localhost/<distro>/…`. "
    + "One TaskSpace is kept per session and profile and resumed on every call (variables do not persist between calls, tabs and pages do). "
    + `\`profile: "user"\` (default) is the user's own ego profile with their logins; \`profile: "verify"\` is the dedicated verification profile (the ego profile named "${VERIFY_PROFILE_NAME}", logged out everywhere) and MUST be used for CUELO screen/UI verification. If that profile does not exist the call fails; do not fall back to the user profile, tell the user to create it. `
    + "Never clear cookies, cache or storage (it hits the whole profile). For login, permission or CAPTCHA steps call `task.handOff()` and tell the user (it stops the script; do not retry or take control back until the user says continue). "
    + "Set `finish: true` on the last call to close the space (`task.finish({ keep: [] })`, also on error); spaces still open when the session ends are closed automatically unless they were handed off to the user. "
    + "Do not use relay (`browser.open`) for this unless the user names a tab that is already open.";
}

/** 세션마다 한 번 불리는 팩토리. 상태는 클로저에 두고, ego 실행기와 host는 주입할 수 있다. */
export function createFactory(exec: Exec, host: EgoHost = "windows"): CustomToolFactory {
  return (pi) => {
    // 이 세션이 시작했을 수 있는 공간의 프로필. 호출이 중간에 실패해도 공간은 이미 생겼을 수 있어 실행 전에 넣는다.
    const open = new Set<EgoProfile>();
    let sessionId = "";
    return {
      name: "ego_browser",
      label: "ego Browser",
      loadMode: "essential",
      description: toolDescription(host),
      parameters: pi.zod.object({
        script: pi.zod.string().describe(host === "linux" ? "Script body; `task` and `page` are already defined" : "Script body; `task` and `page` (p1) are already defined"),
        profile: pi.zod.enum(["user", "verify"]).optional().describe(`user = the user's default ego profile (default); verify = the ego profile named "${VERIFY_PROFILE_NAME}", verification only${host === "linux" ? " (not available on this Linux PC)" : ""}`),
        finish: pi.zod.boolean().optional().describe("Close the TaskSpace after this script, even if it throws"),
        timeoutMs: pi.zod.number().optional().describe(`Kill the script after this many ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`),
      }),

      async execute(_toolCallId, params, _onUpdate, ctx, signal) {
        const p = params as EgoBrowserParams;
        sessionId = ctx.sessionManager.getSessionId();
        const profile: EgoProfile = p.profile ?? "user";
        if (!(host === "linux" && profile === "verify")) open.add(profile);
        const run = await runEgoBrowser(p, { exec, sessionId, host }, signal);
        if (run.finished) open.delete(profile);
        return { content: [{ type: "text", text: run.text }], details: { spaceName: run.spaceName, profile: run.profile, finished: run.finished } };
      },

      async onSession(event) {
        if (event.reason !== "shutdown" || open.size === 0) return;
        for (const profile of [...open]) {
          open.delete(profile);
          try {
            await exec(["nodejs"], buildCleanup(spaceName(sessionId, profile), host), { timeoutMs: 30_000 });
          } catch {
            // 종료 중 정리는 최선 노력이다. ego가 없거나 이미 닫혔으면 할 일이 없다.
          }
        }
      },
    };
  };
}

export default isNativeLinux() ? createFactory(linuxExec, "linux") : createFactory(defaultExec);
