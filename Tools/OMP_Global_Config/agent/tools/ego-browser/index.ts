import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type EgoProfile = "user" | "verify";
/** windows: Windows ego lite의 `ego-browser nodejs`. linux: Electron ego 앱의 Agent Space에 붙는 SDK(앱이 꺼져 있으면 띄운다, 앱 런처가 없는 PC만 ego Chromium 격리 창). */
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

export interface ExecOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * `false`면 이 호출은 꺼진 ego 앱을 새로 띄우지 않는다. 세션 종료 정리처럼 사용자가 끝낸 앱을 다시 켜면 안 되는 호출이 준다.
   * 생략(undefined)하면 일반 실행과 같다. 붙을 앱이 없으면 그 브라우저로 대신하지 않고 최선 노력 실패를 돌려준다.
   */
  allowLaunch?: boolean;
}

/** `ego-browser <args>`를 실행하고 `input`을 stdin으로 넘긴다. 실행 파일이 없으면 code ENOENT로 throw한다. */
export type Exec = (args: string[], input: string, options: ExecOptions) => Promise<ExecResult>;

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
  "ego_browser: 이 Linux PC에는 검증 프로필이 없다(ego TaskSpace가 사용자 쿠키를 복사한다). CUELO 화면 검증도 profile \"user\"로 하고, 로그아웃 상태가 필요한 확인만 미확인으로 남긴다.";

/** 세션·프로필마다 고정된 TaskSpace 이름. 같은 이름은 ego가 새로 만들지 않고 이어 쓴다. 세션 id를 자르지 않아 다른 세션이 공간을 공유하지 않는다. */
export function spaceName(sessionId: string, profile: EgoProfile): string {
  return `cuelo-${sessionId}-${profile}`;
}

/** 이미 있는 공간에 profileId를 주면 ego가 거절한다. 그 거절만 profileId 없이 이어 쓰기로 바꾼다(그 밖의 오류는 그대로 던진다). */
export const RESUME_ERROR_MARKER = "only applies when creating";

const LINUX_MANAGED_API = 'typeof taskSpace === "function" && typeof ego !== "undefined" && typeof ego.taskPages === "function"';

// Electron removes a Space record when its final tab closes. The Linux SDK can
// then report a failed registry commit despite having closed every managed tab.
const LINUX_FINISH_MANAGED = `const __egoFinishManaged = async (managed, keep, id) => {
  try {
    const result = await managed.finish({ keep });
    return { ...result, done: result.finished };
  } catch (error) {
    const missing = "task space not found: " + id;
    if (keep.length !== 0 || error?.message !== "taskPages.finish: " + missing) throw error;
    // The legacy list can still be stale. Native tab inventory rechecks the bound ID and cannot create, activate or claim anything.
    try { await managed.tabs(); }
    catch (check) {
      if (check?.error_code === "EGO_TASK_SPACE_NOT_FOUND" && check.message === "taskPages.list: " + missing) {
        return { done: true, finished: true, kept: [] };
      }
    }
    throw error;
  }
};
`;

/**
 * 모델 스크립트 앞에 붙이는 머리말. `task`와 `page`(p1)를 묶는다. profileId는 공간을 처음 만들 때만 적용된다.
 * verify는 ego `profiles()`에서 이름이 VERIFY_PROFILE_NAME인 프로필의 id를 쓴다. 없으면 공간을 만들지 않고 던진다.
 */
export function buildPrelude(name: string, profile: EgoProfile, host: EgoHost = "windows"): string {
  const quoted = JSON.stringify(name);
  if (host === "linux") {
    // Keep the Linux current-tab facade for existing scripts; only the SDK can bind a named managed page.
    return `const __egoSpace = await taskSpaces.useOrCreate(${quoted});
const __egoNativeSpace = ${LINUX_MANAGED_API} ? taskSpace : undefined;
let __egoManaged;
let __egoBinding;
const __egoBindManaged = async () => {
  if (!__egoNativeSpace) throw new Error("Managed pages require the ego TaskSpace/Page SDK.");
  return __egoManaged ??= await (__egoBinding ??= __egoNativeSpace(__egoSpace.id));
};
${LINUX_FINISH_MANAGED}
const __egoWait = (ms) => {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
};
const __egoAddWait = (p) => {
  try { if (p && typeof p.waitForTimeout !== "function") p.waitForTimeout = __egoWait; } catch {}
  return p;
};
const __egoFindBound = async () => (await taskSpaces.list()).find((space) => space.id === __egoSpace.id);
let __egoFinished;
const task = {
  id: __egoSpace.id,
  spaceId: __egoSpace.id,
  name: __egoSpace.name,
  page: (label = "p1") => {
    if (label === "p1") return page;
    if (!__egoManaged) throw new Error("Call await task.pages() before looking up a managed Page by label.");
    return __egoAddWait(__egoManaged.page(label));
  },
  newPage: async () => __egoAddWait(await (await __egoBindManaged()).newPage()),
  pages: async () => (await __egoBindManaged()).pages(),
  tabs: async () => (await __egoBindManaged()).tabs(),
  handOff: () => taskSpaces.handOff(__egoSpace.id),
  takeOver: async () => {
    const resumed = await taskSpaces.takeOver(__egoSpace.id);
    __egoManaged = __egoBinding = undefined;
    return resumed;
  },
  finish: (options = {}) => (__egoFinished ??= (async () => {
    const current = await __egoFindBound();
    if (!current) return { done: true, finished: true, kept: [] };
    if (current.createdBy !== "agent" || current.ownership !== "agent") {
      throw new Error("TaskSpace cleanup refused: the bound space is under user control or was not created by the agent. It was left open; do not replay the script.");
    }
    // Native finish does not reclaim user-owned Spaces or close unmanaged tabs.
    const managed = await __egoBindManaged();
    const keep = options.keep === true ? (await managed.pages()).map(({label}) => label) : options.keep === false ? [] : options.keep ?? [];
    return __egoFinishManaged(managed, keep, __egoSpace.id);
  })()),
};
const __egoPage = __egoAddWait(globalThis.page);
if (__egoPage && typeof __egoPage.locator === "function") {
  for (const method of ["click", "fill", "press", "setInputFiles"]) {
    try { if (typeof __egoPage[method] !== "function") __egoPage[method] = (selector, ...args) => __egoPage.locator(selector)[method](...args); } catch {}
  }
}
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

/**
 * 본문은 머리말과 다른 블록에서 돈다. 11-14~11-19 Linux 9세션이 ego 가이드 예제대로 첫 호출에
 * `const task = await taskSpace(...)`·`const page = task.page("p1")`를 써서 머리말과 겹쳐
 * `SyntaxError: Identifier 'task' has already been declared`로 한 턴씩 버렸다. 블록이면 본문 선언은 가리기만 한다.
 * 이름(문자열)만 준 `taskSpace`는 이 세션 공간을 돌려준다. 그대로 SDK에 넘기면 세션 정리가 모르는 공간이 남는다.
 * 숫자 id(사용자가 넘긴 공간 재개 등)나 값이 있는 옵션(profileId 등)이 붙은 호출은 명시한 요청이라 SDK에 그대로 넘긴다.
 * 본문은 `taskSpace`를 매개변수로 받는 안쪽 함수의 블록에서 돈다. 본문의 `const`·`let`·`var` 선언(`task`, `page`, `taskSpace` 포함)이
 * 머리말과 겹치지 않고, 대체 함수는 머리말 범위에 묶여 본문 선언에 흔들리지 않는다. 본문의 `return` 값은 그대로 돌려준다.
 * finish가 true면 스크립트가 던져도 공간을 정리한다.
 */
export function buildScript(name: string, profile: EgoProfile, body: string, finish: boolean, host: EgoHost = "windows"): string {
  const prelude = `${buildPrelude(name, profile, host)}const __egoTask = task;
const __egoTaskSpace = typeof taskSpace === "function" ? taskSpace : undefined;
const __egoNamedTaskSpace = (nameOrId, ...rest) => typeof nameOrId === "string" && rest.every((value) => value === undefined || (typeof value === "object" && value !== null && Object.values(value).every((option) => option === undefined)))
  ? Promise.resolve(__egoTask)
  : __egoTaskSpace(nameOrId, ...rest);
`;
  const run = `return await (async (taskSpace) => {\n{\n${body}\n}\n})(__egoNamedTaskSpace);`;
  if (!finish) return `${prelude}${run}\n`;
  if (host === "windows") return `${prelude}try {\n${run}\n} finally {\n  await task.finish({ keep: [] });\n}\n`;
  return `${prelude}let __egoBodyFailed = false;
try {
  ${run}
} catch (error) {
  __egoBodyFailed = true;
  throw error;
} finally {
  try { await task.finish({ keep: [] }); }
  catch (error) {
    if (!__egoBodyFailed) throw error;
    console.error("TaskSpace cleanup failed:", error);
  }
}
`;
}

/**
 * 세션 종료 때 쓰는 정리 스크립트. 공간을 새로 만들지 않고 ego의 목록(listTaskSpaces)에서 이름으로 찾는다.
 * `task.handOff()` 뒤에는 ownership이 "agentDelegatedToUser"로 바뀌고(0.6.0.16 실측), 사용자 소유 공간도 "agent"가 아니다.
 * 에이전트가 만들고 아직 에이전트가 쥔 공간만 닫고, 나머지는 사용자 몫이라 그대로 둔다.
 */
export function buildCleanup(name: string, host: EgoHost = "windows"): string {
  const quoted = JSON.stringify(name);
  const list = host === "linux" ? "taskSpaces.list()" : "listTaskSpaces()";
  const finish = host === "linux"
    ? `if (!(${LINUX_MANAGED_API})) { console.log("skipped: managed TaskSpace API unavailable"); return; }
  ${LINUX_FINISH_MANAGED}
  await __egoFinishManaged(await taskSpace(found.id), [], found.id);`
    : "await (await taskSpace(found.id)).finish({ keep: [] });";
  return `const found = (await ${list}).find((space) => space.name === ${quoted});
if (found && found.createdBy === "agent" && found.ownership === "agent") {
  ${finish}
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

/**
 * 10-27~11-02 ego_browser 실패 중 스크립트 API 오용이 반복됐다(Node 본문에서 `location` 사용, 없는 `page.fill`·`page.on` 호출).
 * SDK 가이드에 답이 있지만 실패한 자리에서는 보이지 않으므로, 오류 원문이 그 모양일 때만 바른 호출을 붙인다.
 */
export function misuseHint(raw: string, host: EgoHost = "windows"): string {
  const hints: string[] = [];
  const global = /ReferenceError: (document|window|location|navigator|localStorage|sessionStorage) is not defined/.exec(raw)?.[1];
  if (global) hints.push(`스크립트 본문은 Node에서 돈다. 페이지의 \`${global}\`는 \`page.evaluate(...)\` 안에서만 쓴다(주소는 \`await page.evaluate('location.href')\`).`);
  const missing = /TypeError: page\.([\w$]+) is not a function/.exec(raw)?.[1];
  if (missing === "cdp" && host === "linux") hints.push("Linux ego의 `page`에는 `cdp`가 없다. raw CDP는 전역 `cdp(method, params)`로 부른다(TaskSpace 탭에 적용된다). Linux ego 앱에는 `Page.printToPDF`가 없다.");
  else if (missing) hints.push(`\`page\`에는 \`${missing}\`가 없다. 요소 입력·클릭은 \`page.locator('@N' 또는 CSS 선택자)\`의 \`click\`·\`fill\`·\`press\`로 하고, 다른 API는 도구 설명의 ego-browser 가이드에서 이름을 확인한 뒤 쓴다.`);
  if (host === "linux" && raw.includes("SyntaxError: Cannot use import statement outside a module")) {
    hints.push('Linux scripts run in a Node async function, not a module. Use `const fs = await import("node:fs")` instead of a static import. Do not replay side effects from earlier calls.');
  }
  if (/^Error: Object reference chain is too long\s*$/m.test(raw)) {
    hints.push("In `page.evaluate`, return strings, numbers or shallow plain objects, not DOM nodes, windows or event objects. For a page action with no result, use a function block without `return`. Verify any earlier action before retrying.");
  }
  if (host === "linux" && /^Error: task space not found:/m.test(raw)) {
    hints.push("A guide example's name is not the actual TaskSpace name. Log `task.spaceId` before handoff, and use that same numeric ID only after the user confirms continue. Check `taskSpaces.list()` if the saved ID is missing; never take over a different space.");
  }
  return hints.length ? `\n${hints.join("\n")}` : "";
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
    const raw = `${result.stdout}\n${result.stderr}`;
    const hint = /permission prompt for .+ has appeared/i.test(raw)
      ? "\n권한 팝업은 사용자가 허용·거부해야 한다. 같은 스크립트를 다시 보내거나 우회하지 않는다. `await task.handOff()`로 넘기고 사용자에게 무엇을 눌러야 하는지 알린 뒤, 사용자가 계속하라고 하면 이어 간다."
      : "";
    throw new Error(`ego_browser: exit ${result.code}. ${label}${body ? `\n${body}` : ""}${hint}${misuseHint(raw, host)}`);
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

/** Electron판 ego 앱의 프로필 루트(`~/.local/bin/ego-lite` 런처와 같은 값). `EGO_LITE_APP_PROFILE_ROOT`로 바꿀 수 있다. */
export function linuxAppProfileRoot(): string {
  return process.env.EGO_LITE_APP_PROFILE_ROOT || join(homedir(), ".local", "share", "ego-lite-gui");
}

/** `/json/version`이 답하면 브라우저 엔드포인트 경로를, 아니면 오류를 돌려준다. */
async function cdpBrowserPath(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3_000) });
  const version: unknown = await response.json();
  const endpoint = version && typeof version === "object" && "webSocketDebuggerUrl" in version ? version.webSocketDebuggerUrl : undefined;
  if (typeof endpoint !== "string") throw new Error("/json/version에 webSocketDebuggerUrl이 없다");
  return new URL(endpoint).pathname;
}

/** Electron 앱이 떠 있으면(브리지 파일과 살아 있는 DevToolsActivePort) 그 프로필 폴더를 돌려준다. */
async function runningAppProfileDir(): Promise<string | undefined> {
  const profileDir = join(linuxAppProfileRoot(), "chromium-profile");
  if (!existsSync(join(profileDir, "ego-lite-bridge.json"))) return undefined;
  try {
    const [portText, browserPath] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split(/\r?\n/);
    const port = Number(portText);
    if (!Number.isInteger(port) || port <= 0 || !browserPath?.trim()) return undefined;
    if (await cdpBrowserPath(port) !== browserPath) return undefined;
    return profileDir;
  } catch {
    return undefined;
  }
}

/** Electron판 ego 앱 런처. `EGO_LITE_APP_LAUNCHER`로 바꿀 수 있다. 이 파일이 없는 PC만 ego Chromium 경로를 쓴다. */
export function linuxAppLauncher(): string {
  return process.env.EGO_LITE_APP_LAUNCHER || join(homedir(), ".local", "bin", "ego-lite");
}

/**
 * ego 앱을 자기 systemd 사용자 유닛으로 띄운다. CUELO 서버 유닛(KillMode=control-group)의 자식으로 띄우면
 * 서버를 다시 시작할 때 사용자 브라우저도 함께 꺼진다.
 */
export async function launchLinuxApp(launcher: string): Promise<void> {
  const setenv = ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY"].flatMap((key) => (process.env[key] ? [`--setenv=${key}=${process.env[key]}`] : []));
  const unit = `ego-lite-gui-${Date.now()}-${process.pid}`;
  const result = await spawnScript("systemd-run", ["--user", "--collect", `--unit=${unit}`, ...setenv, launcher, "--launch"], "", { timeoutMs: 10_000 });
  if (result.code !== 0) throw new Error(`systemd-run exit ${result.code}: ${result.stderr.trim()}`);
}

export interface LinuxExecDeps {
  launchApp: (launcher: string) => Promise<void>;
  appStartTimeoutMs: number;
}

/**
 * Linux 실행기. SDK 호스트 모듈을 node로 직접 돌린다.
 * Electron판 ego 앱에 붙는다. 공간은 앱 안의 Agent Space로 열리고 사용자 탭은 앞에 그대로 남는다(사용자 결정 2026-11-07).
 * 앱이 꺼져 있으면 띄우고 연결될 때까지 기다린다. 띄우지 못하면 다른 브라우저로 넘어가지 않고 실패한다(사용자 결정 2026-11-08).
 * 앱 런처가 없는 PC만 사용자 ego Chromium(CDP)에 붙는다. 호스트가 읽는 `DevToolsActivePort`를 그 CDP로 써 두고,
 * 공간은 Target.createBrowserContext로 격리된 새 창에 열린다(사용자 결정 2026-11-02).
 * 어느 쪽이든 연결 직전에 브라우저가 꺼지면 호스트가 빈 Chromium을 새로 띄우려 한다. `/bin/false`로 그 실행을 막는다.
 */
export function createLinuxExec(deps: LinuxExecDeps = { launchApp: launchLinuxApp, appStartTimeoutMs: 30_000 }): Exec {
  return async (_args, input, options) => {
    const host = linuxHostPath();
    const fail = (stderr: string, code = 127): ExecResult => ({ code, stdout: "", stderr, killed: false });
    if (!existsSync(host)) return fail(`ego-browser SDK 호스트가 없다: ${host} (EGO_LITE_HOST로 지정할 수 있다)`);
    let appProfileDir = await runningAppProfileDir();
    const launcher = linuxAppLauncher();
    if (!appProfileDir && existsSync(launcher)) {
      // A call cancelled before it starts must not leave a new app behind.
      if (options.signal?.aborted) return { code: -1, stdout: "", stderr: "", killed: true };
      // 세션 종료 정리는 사용자가 끝낸 앱을 다시 켜지 않는다(이슈 #75). 앱이 없으면 최선 노력으로 끝내고 Chromium으로도 넘어가지 않는다.
      if (options.allowLaunch === false) return fail(`ego 앱이 꺼져 있다. 정리 전용 호출이라 앱을 띄우지 않는다: ${launcher}`);
      try {
        await deps.launchApp(launcher);
      } catch (error) {
        return fail(`ego 앱(${launcher})을 띄우지 못했다: ${error instanceof Error ? error.message : String(error)}. 다른 브라우저로 대신하지 않는다.`, 1);
      }
      const deadline = Date.now() + deps.appStartTimeoutMs;
      while (!appProfileDir && Date.now() < deadline) {
        if (options.signal?.aborted) return { code: -1, stdout: "", stderr: "", killed: true };
        await new Promise((resolve) => setTimeout(resolve, 300));
        appProfileDir = await runningAppProfileDir();
      }
      if (!appProfileDir) {
        return fail(`ego 앱(${launcher})을 띄웠지만 ${Math.round(deps.appStartTimeoutMs / 1000)}초 안에 연결되지 않았다. 다른 브라우저로 대신하지 않는다.`, 1);
      }
    }
    if (appProfileDir) {
      // 앱 자신의 프로필·Space 기록을 쓰게, 상속된 개별 경로 지정은 넘기지 않는다.
      const { EGO_LITE_PROFILE_DIR: _profileDir, EGO_LITE_STATE_PATH: _statePath, ...inherited } = process.env;
      return spawnScript("node", [host], input, options, {
        ...inherited,
        EGO_LITE_PROFILE_ROOT: linuxAppProfileRoot(),
        EGO_BROWSER_EXECUTABLE: "/bin/false",
        EGO_LITE_LAUNCH_TIMEOUT_MS: "1000",
      });
    }
    // 앱이 없는 PC: 사용자의 ego Chromium(`ego-profile-browser`)이 여는 CDP 포트. opencue도 여기에 붙는다.
    const configuredPort = Number(process.env.EGO_LITE_CDP_PORT || 32899);
    const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 32899;
    let browserPath: string;
    try {
      browserPath = await cdpBrowserPath(port);
    } catch (error) {
      return fail(`ego 브라우저 CDP 127.0.0.1:${port}에 연결할 수 없다(ego 앱 런처도 ego-profile-browser도 없다): ${error instanceof Error ? error.message : String(error)}`);
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
}

export const linuxExec: Exec = createLinuxExec();

function toolDescription(host: EgoHost): string {
  if (host === "linux") {
    const guide = join(dirname(linuxHostPath()), "..", "..", "skills", "ego-browser", "SKILL.md");
    return "Isolated ego TaskSpace; never user's Space/tabs/PWA or substitute browser after failure. "
      + `Read \`${guide}\` first; recipes: skill://ego-browser-verify-recipes. `
      + 'script: Node async body with await (use `await import("node:fs")`, not static imports); task/page bound; global cdp(), not page.cdp; no Page.printToPDF. '
      + "Use task.newPage()/pages()/tabs() for managed Pages; list with await task.pages() before looking up a saved label. page and task.page('p1') use the selected tab. Space persists, variables do not. "
      + "profile:user only; logged-out checks unverified. Never clear cookies/cache/storage. Login/permission/CAPTCHA: record task.spaceId, await task.handOff(), end script, tell user; takeOver() only after continue. Do not finish when handing off. Run one call at a time; last call finish:true.";
  }
  return "Isolated ego lite TaskSpaces. Read API with `ego-browser skill` before first use. script: Windows Node ESM/top-level await; task/page(p1) bound; use page.evaluate for page JS and UNC/file URLs for WSL files. Space persists per session/profile, variables do not. Use profile:verify for CUELO UI checks; missing verify profile is a failure, never fall back to user. Never clear cookies/cache/storage. Login/permission/CAPTCHA: task.handOff() and tell user; resume only after continue. Last call finish:true. Relay browser.open only for an already-open user-named tab.";
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
        script: pi.zod.string(),
        profile: pi.zod.enum(host === "linux" ? ["user"] : ["user", "verify"]).optional(),
        finish: pi.zod.boolean().optional(),
        timeoutMs: pi.zod.number().optional().describe(`ms; default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}`),
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
            // 종료 정리는 attach-only다. 앱이 이미 꺼졌으면 띄우지 않고 최선 노력으로 끝난다(이슈 #75).
            await exec(["nodejs"], buildCleanup(spaceName(sessionId, profile), host), { timeoutMs: 30_000, allowLaunch: false });
          } catch {
            // 종료 중 정리는 최선 노력이다. ego가 없거나 이미 닫혔으면 할 일이 없다.
          }
        }
      },
    };
  };
}

export default isNativeLinux() ? createFactory(linuxExec, "linux") : createFactory(defaultExec);
