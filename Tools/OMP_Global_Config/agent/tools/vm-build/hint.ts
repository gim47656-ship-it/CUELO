import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { configPath, parseConfig } from "./index";
import { cancellable, runProcess, runRemote, type Runner } from "./remote";
import { findMapping, type RepoMapping, type VmBuildConfig } from "./sync";

/**
 * git_finalize / git_integrate가 게시한 저장소가 vm-build.json에 매핑돼 있으면, 어느 VM 사본이 어느 리비전에 있고
 * 무슨 명령으로 맞추는지 결과 한 줄로 알려 준다. 안내일 뿐이므로 설정 없음·매핑 없음·VM 응답 없음은 모두 조용히
 * 처리하고 게시 성공을 막지 않는다(ssh는 짧은 시간 제한을 둔다). 설정을 읽는 길과 매핑 판정은 vm_build 것을 쓴다.
 */

const VM_HEAD = String.raw`
if (-not (Test-Path -LiteralPath (Join-Path $P.repo '.git'))) { Emit @{ fatal = "not a git repository" } }
$h = G @('rev-parse','--verify','-q','HEAD')
$s = G @('rev-parse','--verify','-q','refs/cuelo-vm/snapshot')
Emit @{ head = $h.out; snapshot = $(if ($s.code -eq 0) { $s.out } else { '' }) }
`;

const VM_PROBE_TIMEOUT_MS = 12_000;
const vmBuildCli = fileURLToPath(new URL("./index.ts", import.meta.url));

export interface VmHintDeps {
  run?: Runner;
  readConfig?: () => Promise<VmBuildConfig>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const GIT_RUN_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

async function defaultReadConfig(): Promise<VmBuildConfig> {
  return parseConfig(await readFile(configPath(), "utf8"), configPath());
}

async function mapped(config: VmBuildConfig, roots: string[]): Promise<{ mapping: RepoMapping; root: string } | undefined> {
  for (const candidate of roots) {
    const root = await realpath(candidate).catch(() => undefined);
    if (!root) continue;
    const mapping = await findMapping(config, root).catch(() => undefined);
    if (mapping) return { mapping, root };
  }
  return undefined;
}

/** 게시한 커밋 `commit`에 대한 VM 사본 안내 한 줄. 매핑이 없거나 설정을 못 읽으면 undefined다. */
export async function vmCopyHint(roots: string[], commit: string, deps: VmHintDeps = {}): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    const config = await (deps.readConfig ?? defaultReadConfig)();
    const found = await mapped(config, roots);
    if (!found) return undefined;
    const { mapping, root } = found;
    const run = cancellable(deps.run ?? runProcess, deps.signal);
    const quoted = `'${root.replace(/'/g, "'\\''")}'`;
    const command = `vm_build --repo ${quoted} --mode commit (CLI: bun '${vmBuildCli.replace(/'/g, "'\\''")}' --repo ${quoted} --mode commit)`;
    // vm_build commit 모드는 매핑된 체크아웃의 현재 HEAD를 보낸다. 그 HEAD가 게시한 커밋이 아니면 명령만으로는 맞춰지지 않는다.
    const sourceHead = await run("git", ["rev-parse", "HEAD"], { cwd: root, env: GIT_RUN_ENV });
    const stale = sourceHead.code === 0 && sourceHead.stdout.trim() !== commit
      ? ` 단, ${root}의 HEAD가 ${sourceHead.stdout.trim()}이라 이 명령은 게시한 커밋이 아니라 그 HEAD를 보낸다. 먼저 그 체크아웃이 ${commit}을 받아야 한다.`
      : "";
    const state = await runRemote<{ head?: unknown; snapshot?: unknown; fatal?: unknown }>(
      run, config.host, VM_HEAD, { repo: mapping.vm, safe: mapping.vm.replace(/\\/g, "/") }, deps.timeoutMs ?? VM_PROBE_TIMEOUT_MS,
    ).catch(() => undefined);
    const head = !state?.fatal && typeof state?.head === "string" && /^[0-9a-f]{40,64}$/.test(state.head.trim()) ? state.head.trim() : undefined;
    const prefix = `VM 사본 ${mapping.vm}(${config.host})`;
    if (!head) return `${prefix}의 현재 리비전을 읽지 못했다(알 수 없음). 게시한 ${commit}에 맞추려면: ${command}${stale}`;
    if (head === commit) return `${prefix}가 이미 게시한 ${commit}과 같다.`;
    const known = await run("git", ["cat-file", "-e", `${head}^{commit}`], { cwd: root, env: GIT_RUN_ENV });
    const ancestry = known.code === 0 ? (await run("git", ["merge-base", "--is-ancestor", head, commit], { cwd: root, env: GIT_RUN_ENV })).code : -1;
    const relation = ancestry === 0 ? "게시한 커밋보다 뒤처졌다" : ancestry === 1 ? "게시한 커밋의 조상이 아니다" : "게시한 커밋과의 관계를 판정하지 못했다";
    const snapshot = state?.snapshot === head ? " (임시 스냅샷)" : "";
    return `${prefix}가 아직 ${head}${snapshot}이다 — ${relation}(게시: ${commit}). 맞추려면: ${command}${stale}`;
  } catch {
    return undefined;
  }
}
