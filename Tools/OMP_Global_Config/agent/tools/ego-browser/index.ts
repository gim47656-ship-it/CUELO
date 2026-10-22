import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";

export type EgoProfile = "user" | "verify";

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
export function buildPrelude(name: string, profile: EgoProfile): string {
  const quoted = JSON.stringify(name);
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
export function buildScript(name: string, profile: EgoProfile, body: string, finish: boolean): string {
  const prelude = buildPrelude(name, profile);
  if (!finish) return `${prelude}${body}\n`;
  return `${prelude}try {\n${body}\n} finally {\n  await task.finish({ keep: [] });\n}\n`;
}

/**
 * 세션 종료 때 쓰는 정리 스크립트. 공간을 새로 만들지 않고 ego의 목록(listTaskSpaces)에서 이름으로 찾는다.
 * `task.handOff()` 뒤에는 ownership이 "agentDelegatedToUser"로 바뀌고(0.6.0.16 실측), 사용자 소유 공간도 "agent"가 아니다.
 * 에이전트가 만들고 아직 에이전트가 쥔 공간만 닫고, 나머지는 사용자 몫이라 그대로 둔다.
 */
export function buildCleanup(name: string): string {
  return `const found = (await listTaskSpaces()).find((space) => space.name === ${JSON.stringify(name)});
if (found && found.createdBy === "agent" && found.ownership === "agent") {
  await (await taskSpace(found.id)).finish({ keep: [] });
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

function isUnavailable(error: unknown): boolean {
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
  const finish = params.finish === true;
  const name = spaceName(deps.sessionId, profile);
  const input = buildScript(name, profile, params.script, finish);
  const timeoutMs = clampTimeout(params.timeoutMs);
  let result: ExecResult;
  try {
    result = await deps.exec(["nodejs"], input, { timeoutMs, signal });
  } catch (error) {
    if (isUnavailable(error)) throw new Error(UNAVAILABLE);
    throw error;
  }
  if (result.code === 127) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`${UNAVAILABLE}${detail ? `\n${detail}` : ""}`);
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
    throw new Error(`ego_browser: exit ${result.code}. ${label}${body ? `\n${body}` : ""}`);
  }
  const text = `${label}${finish ? " — 정리됨" : ""}\n${body || "(출력 없음)"}`;
  return { text, spaceName: name, profile, finished: finish, result };
}

/**
 * 기본 실행기: `ego-browser nodejs`를 띄우고 스크립트를 stdin으로 보낸다(pi.exec는 stdin이 없다).
 * 시간 초과·취소 때는 자식 프로세스 그룹 전체를 죽이고 close를 기다리지 않고 바로 끝낸다. 래퍼가 만든 하위 프로세스가
 * 파이프를 쥐고 있으면 close가 한참 늦게 오기 때문이다.
 */
export const defaultExec: Exec = (args, input, options) => {
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
  const child = spawn("ego-browser", args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
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
};

/** 세션마다 한 번 불리는 팩토리. 상태는 클로저에 두고, ego 실행기는 주입할 수 있다(기본은 defaultExec). */
export function createFactory(exec: Exec): CustomToolFactory {
  return (pi) => {
    // 이 세션이 시작했을 수 있는 공간의 프로필. 호출이 중간에 실패해도 공간은 이미 생겼을 수 있어 실행 전에 넣는다.
    const open = new Set<EgoProfile>();
    let sessionId = "";
    return {
      name: "ego_browser",
      label: "ego Browser",
      loadMode: "essential",
      description:
        "Drive ego lite TaskSpaces (the `ego-browser` runtime) without a bash heredoc. Only on PCs where ego lite is installed (the tool says so and exits when it is not; then use the normal `browser` tool). "
        + "`script` is the body of an `ego-browser nodejs` script (ESM, top-level await, Node.js, not the page): the tool has already run `const task = await taskSpace(<name>)` and `const page = task.page(\"p1\")`, so use `task`/`page` directly. Browser-side JS goes inside `page.evaluate()`. "
        + "Run `ego-browser skill` once in bash to read the API guide. "
        + "One TaskSpace is kept per session and profile and resumed on every call (variables do not persist between calls, tabs and pages do). "
        + `\`profile: "user"\` (default) is the user's own ego profile with their logins; \`profile: "verify"\` is the dedicated verification profile (the ego profile named "${VERIFY_PROFILE_NAME}", logged out everywhere) and MUST be used for CUELO screen/UI verification. If that profile does not exist the call fails; do not fall back to the user profile, tell the user to create it. `
        + "Never clear cookies, cache or storage (it hits the whole profile). For login, permission or CAPTCHA steps call `task.handOff()` and tell the user (it stops the script; do not retry or take control back until the user says continue). "
        + "Set `finish: true` on the last call to close the space (`task.finish({ keep: [] })`, also on error); spaces still open when the session ends are closed automatically unless they were handed off to the user. "
        + "Do not use relay (`browser.open`) for this unless the user names a tab that is already open.",
      parameters: pi.zod.object({
        script: pi.zod.string().describe("Script body; `task` and `page` (p1) are already defined"),
        profile: pi.zod.enum(["user", "verify"]).optional().describe(`user = the user's default ego profile (default); verify = the ego profile named "${VERIFY_PROFILE_NAME}", verification only`),
        finish: pi.zod.boolean().optional().describe("Close the TaskSpace after this script, even if it throws"),
        timeoutMs: pi.zod.number().optional().describe(`Kill the script after this many ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`),
      }),

      async execute(_toolCallId, params, _onUpdate, ctx, signal) {
        const p = params as EgoBrowserParams;
        sessionId = ctx.sessionManager.getSessionId();
        const profile: EgoProfile = p.profile ?? "user";
        open.add(profile);
        const run = await runEgoBrowser(p, { exec, sessionId }, signal);
        if (run.finished) open.delete(profile);
        return { content: [{ type: "text", text: run.text }], details: { spaceName: run.spaceName, profile: run.profile, finished: run.finished } };
      },

      async onSession(event) {
        if (event.reason !== "shutdown" || open.size === 0) return;
        for (const profile of [...open]) {
          open.delete(profile);
          try {
            await exec(["nodejs"], buildCleanup(spaceName(sessionId, profile)), { timeoutMs: 30_000 });
          } catch {
            // 종료 중 정리는 최선 노력이다. ego가 없거나 이미 닫혔으면 할 일이 없다.
          }
        }
      },
    };
  };
}

export default createFactory(defaultExec);
