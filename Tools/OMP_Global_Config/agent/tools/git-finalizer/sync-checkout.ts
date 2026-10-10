/**
 * 검증·게시가 끝난 커밋을 같은 프로젝트의 다른 체크아웃(예: WSL 작업본 → Windows 사본)에 fast-forward로 반영하는 CLI.
 *
 *   bun sync-checkout.ts --source <루트> --target <루트> --revision <40자 sha>
 *
 * 모델 도구가 아니다. 상시 동기화·스케줄러·훅 없이, 호출될 때 한 번만 일한다. 빌드·설치·배포는 하지 않는다.
 * 대상 사본의 변경(tracked·staged·무시되지 않는 untracked)이나 갈라진/앞선 이력이 있으면 아무것도 바꾸지 않고 멈춘다.
 * reset·stash·clean·force checkout·rebase·merge·잠금 삭제는 쓰지 않는다. 갱신은 `merge --ff-only <정확한 sha>` 하나다.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type GitExecutor, selectGitExecutor } from "./wsl-git";

export interface SyncCheckoutOptions {
  source: string;
  target: string;
  revision: string;
}

export type SyncCheckoutResult =
  | { ok: true; status: "updated" | "already-current"; revision: string; branch: string; previous: string }
  | { ok: false; status: "blocked"; reason: string };

interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

class Blocked extends Error {}

function blocked(reason: string): never {
  throw new Blocked(reason);
}

/**
 * git에 넘길 비대화형 환경. Windows git.exe는 interop에서 WSLENV에 이름이 든 변수만 받으므로(2026-10-11 실측: 이름이 없으면
 * 빈 값) 두 변수를 WSLENV에 더한다. 기존 WSLENV 항목은 보존한다. 전역 환경은 바꾸지 않고 자식 프로세스에만 적용한다.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const names = (process.env.WSLENV ?? "").split(":").filter((entry) => entry.length > 0);
  for (const name of ["GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE"]) {
    if (!names.some((entry) => entry.split("/")[0] === name)) names.push(name);
  }
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", WSLENV: names.join(":") };
}

function runGit(executor: GitExecutor, cwd: string, args: string[]): Promise<GitOutput> {
  const { promise, resolve, reject } = Promise.withResolvers<GitOutput>();
  execFile(
    executor.command,
    args,
    { cwd, env: gitEnv(), maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout: String(stdout), stderr: String(stderr) });
    },
  );
  return promise;
}

/** 성공해야 하는 git 호출. 실패하면 stderr를 이유로 멈춘다. */
async function git(executor: GitExecutor, cwd: string, args: string[], what: string): Promise<string> {
  const out = await runGit(executor, cwd, args);
  if (out.code !== 0) blocked(`${what} 실패(git ${args[0]}, 종료 ${out.code}): ${out.stderr.trim() || out.stdout.trim()}`);
  return out.stdout.trim();
}

interface Checkout {
  executor: GitExecutor;
  root: string;
  branch: string;
  origin: string;
  head: string;
}

async function inspect(label: string, path: string): Promise<Checkout> {
  const root = await realpath(resolve(path)).catch(() => blocked(`${label} 경로가 없다: ${path}`));
  const executor = await selectGitExecutor(root);
  const top = executor.toPosix(await git(executor, root, ["rev-parse", "--show-toplevel"], `${label} 루트 확인`));
  const topReal = await realpath(top).catch(() => blocked(`${label} git 루트를 해석하지 못했다: ${top}`));
  if (topReal !== root) blocked(`${label} 경로가 체크아웃 루트가 아니다: ${root} (루트 ${topReal})`);
  const branchOut = await runGit(executor, root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branchOut.code !== 0 || !branchOut.stdout.trim()) blocked(`${label}이 detached HEAD 상태다`);
  const origin = await git(executor, root, ["remote", "get-url", "origin"], `${label} origin 확인`);
  const head = await git(executor, root, ["rev-parse", "HEAD"], `${label} HEAD 확인`);
  return { executor, root, branch: branchOut.stdout.trim(), origin, head };
}

async function run({ source, target, revision }: SyncCheckoutOptions): Promise<SyncCheckoutResult> {
  if (!/^[0-9a-f]{40}$/.test(revision)) blocked("revision은 소문자 40자 전체 sha여야 한다");
  const src = await inspect("source", source);
  const dst = await inspect("target", target);
  if (src.root === dst.root || src.root.startsWith(dst.root + sep) || dst.root.startsWith(src.root + sep)) {
    blocked(`source와 target이 같거나 겹친다: ${src.root} / ${dst.root}`);
  }
  if (src.origin !== dst.origin) blocked("source와 target의 origin이 다르다");
  if (src.branch !== dst.branch) blocked(`브랜치가 다르다: source ${src.branch} / target ${dst.branch}`);
  if (src.head !== revision) blocked(`요청한 revision이 source HEAD(${src.head})와 다르다`);

  const { executor, root, branch } = dst;
  const dirty = await git(executor, root, ["status", "--porcelain", "--untracked-files=normal"], "target 상태 확인");
  if (dirty) blocked(`target에 반영되지 않은 변경이 있어 건드리지 않는다:\n${dirty}`);

  // target의 기존 origin 설정 그대로, 비대화형으로 그 브랜치 하나만 가져와 게시 여부를 확인한다.
  await git(executor, root, ["fetch", "--no-tags", "origin", `refs/heads/${branch}`], "origin fetch");
  const tip = await git(executor, root, ["rev-parse", "FETCH_HEAD"], "FETCH_HEAD 확인");
  const known = await runGit(executor, root, ["cat-file", "-e", `${revision}^{commit}`]);
  if (known.code !== 0) blocked(`origin/${branch}에서 ${revision} 커밋을 찾지 못했다(게시되지 않음)`);
  const published = await runGit(executor, root, ["merge-base", "--is-ancestor", revision, tip]);
  if (published.code !== 0) blocked(`${revision}은 origin/${branch}에 게시되지 않았다`);

  const previous = dst.head;
  if (previous === revision) return { ok: true, status: "already-current", revision, branch, previous };

  const ff = await runGit(executor, root, ["merge-base", "--is-ancestor", previous, revision]);
  if (ff.code !== 0) blocked(`target HEAD(${previous})가 ${revision}의 조상이 아니다(앞섰거나 갈라짐). 건드리지 않는다`);

  // fetch 동안 target이 바뀌지 않았는지 갱신 직전에 다시 본다. 바뀌었으면 되돌리지 않고 멈춘다.
  const nowHead = await git(executor, root, ["rev-parse", "HEAD"], "갱신 직전 HEAD 확인");
  const nowDirty = await git(executor, root, ["status", "--porcelain", "--untracked-files=normal"], "갱신 직전 상태 확인");
  if (nowHead !== previous || nowDirty) blocked("fetch 중 target이 바뀌어 갱신하지 않았다");
  // 무시된 로컬 파일이 새로 추적되는 경로와 겹쳐도 덮어쓰지 않는다(git merge 기본값은 덮어쓴다).
  await git(executor, root, ["merge", "--ff-only", "--no-overwrite-ignore", revision], "fast-forward");
  const after = await git(executor, root, ["rev-parse", "HEAD"], "갱신 후 HEAD 확인");
  if (after !== revision) blocked(`갱신 후 target HEAD(${after})가 요청 revision과 다르다`);
  const left = await git(executor, root, ["status", "--porcelain", "--untracked-files=normal"], "갱신 후 상태 확인");
  if (left) blocked(`갱신 후 target이 깨끗하지 않다:\n${left}`);
  return { ok: true, status: "updated", revision, branch, previous };
}

/** 막힘(Blocked)은 결과로 돌려주고, 예기치 못한 오류는 그대로 던진다. */
export async function syncCheckout(options: SyncCheckoutOptions): Promise<SyncCheckoutResult> {
  try {
    return await run(options);
  } catch (error) {
    if (error instanceof Blocked) return { ok: false, status: "blocked", reason: error.message };
    throw error;
  }
}

function parseArgs(argv: string[]): SyncCheckoutOptions {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!["--source", "--target", "--revision"].includes(key) || value === undefined) {
      throw new Error("usage: sync-checkout.ts --source <path> --target <path> --revision <sha>");
    }
    values[key.slice(2)] = value;
  }
  if (!values.source || !values.target || !values.revision) {
    throw new Error("usage: sync-checkout.ts --source <path> --target <path> --revision <sha>");
  }
  return { source: values.source, target: values.target, revision: values.revision };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await syncCheckout(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
