/**
 * Linux 정본 저장소 → Windows VM 사본 단방향 소스 동기화.
 *
 * - commit: Linux 브랜치 HEAD 커밋을 VM 사본의 같은 브랜치에 fast-forward로 올린다.
 * - snapshot: Linux 작업 트리(미커밋·무시되지 않는 untracked 포함)를 임시 커밋 객체로 만들어 VM에서 detached checkout한다.
 *   Linux의 index·ref·작업 트리는 바꾸지 않는다(인덱스 사본을 쓰고 객체만 더한다). VM에는 `refs/cuelo-vm/snapshot`을 남겨
 *   다음 동기화가 이 도구가 만든 detached 상태인지 알아본다.
 *
 * 전송은 VM에 없는 객체만 담은 thin pack(scp)과 VM `git index-pack --stdin --fix-thin`이다. VM에 GitHub 자격 증명이
 * 필요 없고 Linux 저장소에 임시 ref도 만들지 않는다. VM 쪽 갱신은 `merge --ff-only --no-overwrite-ignore`와
 * `checkout --no-overwrite-ignore`뿐이다. reset·clean·stash·force checkout·/MIR은 쓰지 않으므로 무시된 빌드 산출물은
 * 그대로 남고, Linux에서 지우거나 옮긴 추적 파일만 VM에서도 지워지거나 옮겨진다.
 * VM 사본이 dirty이거나 Linux에 없는 커밋을 갖고 있으면(이력 분기) 아무것도 바꾸지 않고 멈춘다.
 */
import { copyFile, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cancelled, lowPriority, runRemote, type RunResult, type Runner } from "./remote";

export interface RepoMapping { linux: string; vm: string }
export interface VmBuildConfig { host: string; repos: RepoMapping[] }
export type SyncMode = "commit" | "snapshot";

export class Blocked extends Error {}

export function blocked(reason: string): never {
  throw new Blocked(reason);
}

/** VM 사본에서 읽은 상태. 문자열이 비어 있으면 없음이다. */
export interface VmState {
  head: string;
  branch: string;
  branchTip: string;
  snapshotRef: string;
  status: string;
  statusCode: number;
  has: string[];
  temp: string;
  localAppData: string;
}

/** VM 브랜치 끝과 Linux HEAD의 관계. Linux git으로 판정한다. */
export type Ancestry = "equal" | "ancestor" | "unknown-commit" | "diverged";

export type SyncDecision =
  | { kind: "blocked"; reason: string }
  | { kind: "current" }
  | { kind: "apply"; leaveSnapshot: boolean; clearSnapshotRef: boolean; needPack: boolean };

/** VM 상태와 Linux 쪽 사실로 무엇을 할지 정한다. 아무것도 바꾸지 않는 순수 판정이다. */
export function decideSync(input: {
  branch: string;
  commit: string;
  snapshot?: string;
  vm: VmState;
  ancestry?: Ancestry;
}): SyncDecision {
  const { branch, commit, snapshot, vm } = input;
  if (vm.statusCode !== 0) return { kind: "blocked", reason: `VM 사본의 git status가 실패했다(exit ${vm.statusCode}): ${vm.status}` };
  if (vm.status) return { kind: "blocked", reason: `VM 사본에 Linux에 없는 변경이 있어 건드리지 않는다:\n${vm.status}` };
  if (!vm.branch) {
    if (!vm.snapshotRef || vm.head !== vm.snapshotRef) {
      return { kind: "blocked", reason: `VM 사본이 detached HEAD(${vm.head || "없음"})이고 이 도구가 만든 스냅샷이 아니다` };
    }
  } else if (vm.branch !== branch) {
    return { kind: "blocked", reason: `브랜치가 다르다: Linux ${branch} / VM ${vm.branch}` };
  }
  if (!vm.branchTip) return { kind: "blocked", reason: `VM 사본에 ${branch} 브랜치가 없다` };
  if (input.ancestry === "unknown-commit") {
    return { kind: "blocked", reason: `VM ${branch}(${vm.branchTip})에 Linux에 없는 커밋이 있다(이력 분기). 건드리지 않는다` };
  }
  if (input.ancestry === "diverged") {
    return { kind: "blocked", reason: `VM ${branch}(${vm.branchTip})가 Linux HEAD(${commit})의 조상이 아니다(앞섰거나 갈라짐). 건드리지 않는다` };
  }
  const tip = snapshot ?? commit;
  const onTarget = snapshot ? !vm.branch && vm.head === snapshot : vm.branch === branch && vm.head === commit;
  if (onTarget) return { kind: "current" };
  return { kind: "apply", leaveSnapshot: !vm.branch, clearSnapshotRef: !snapshot && Boolean(vm.snapshotRef), needPack: !vm.has.includes(tip) };
}

export interface SyncDeps {
  /** 취소 신호가 붙은 runner(`cancellable`). 로컬 git·scp·ssh가 모두 이것으로 돈다. */
  run: Runner;
  host: string;
  now: () => number;
}

export interface SyncResult {
  status: "synced" | "already-current";
  mode: SyncMode;
  repo: string;
  vmPath: string;
  branch: string;
  commit: string;
  /** snapshot 모드에서 Linux 작업 트리에 변경이 있을 때만 있다. */
  snapshot?: string;
  /** VM에 반영된 HEAD. */
  vmHead: string;
  previous: string;
  /** 커밋에 들어가지 않은 Linux 변경(commit 모드) 또는 스냅샷에 담긴 변경(snapshot 모드). `git status --porcelain` 줄. */
  linuxChanges: string[];
  packBytes: number;
  steps: string[];
  localAppData: string;
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

export async function linuxGit(run: Runner, root: string, args: string[], what: string, options: { low?: boolean; env?: NodeJS.ProcessEnv; input?: string; stdoutFile?: string } = {}): Promise<string> {
  const [command, argv] = options.low ? lowPriority("git", args) : ["git", args];
  const out: RunResult = await run(command, argv, {
    cwd: root, env: { ...process.env, ...GIT_ENV, ...options.env }, input: options.input, stdoutFile: options.stdoutFile, timeoutMs: 30 * 60 * 1000,
  });
  if (out.code !== 0) blocked(`${what} 실패(git ${args[0]}, exit ${out.code}): ${out.stderr.trim() || out.stdout.trim()}`);
  return out.stdout.trim();
}

/** `C:\a\b`를 scp 대상 `C:/a/b`로 바꾼다. 공백·따옴표처럼 scp 원격 경로에서 해석될 문자가 있으면 거부한다. */
export function scpRemotePath(windowsPath: string): string {
  if (!/^[A-Za-z]:\\[\w.\\-]+$/.test(windowsPath)) blocked(`VM 임시 폴더 경로를 scp로 쓸 수 없다: ${windowsPath}`);
  return windowsPath.replace(/\\/g, "/");
}

export function vmSafeDirectory(vmPath: string): string {
  return vmPath.replace(/\\/g, "/");
}

const INSPECT = String.raw`
if (-not (Test-Path -LiteralPath (Join-Path $P.repo '.git'))) { Emit @{ fatal = "VM path is not a git repository: $($P.repo)" } }
$r = @{ temp = $env:TEMP; localAppData = $env:LOCALAPPDATA; has = @() }
$r.head = (G @('rev-parse','--verify','-q','HEAD')).out
$b = G @('symbolic-ref','--short','-q','HEAD'); $r.branch = if ($b.code -eq 0) { $b.out } else { '' }
$t = G @('rev-parse','--verify','-q',"refs/heads/$($P.branch)"); $r.branchTip = if ($t.code -eq 0) { $t.out } else { '' }
$s = G @('rev-parse','--verify','-q','refs/cuelo-vm/snapshot'); $r.snapshotRef = if ($s.code -eq 0) { $s.out } else { '' }
$st = G @('status','--porcelain','--untracked-files=normal'); $r.statusCode = $st.code; $r.status = $st.out
foreach ($c in @($P.want)) { if ($c -and (G @('cat-file','-e',"$c^{commit}")).code -eq 0) { $r.has += $c } }
Emit $r
`;

const APPLY = String.raw`
$h = G @('rev-parse','--verify','-q','HEAD'); $st = G @('status','--porcelain','--untracked-files=normal')
$hb = G @('symbolic-ref','--short','-q','HEAD'); $nowBranch = if ($hb.code -eq 0) { $hb.out } else { '' }
$hs = G @('rev-parse','--verify','-q','refs/cuelo-vm/snapshot'); $nowSnap = if ($hs.code -eq 0) { $hs.out } else { '' }
# -cne: PowerShell -ne ignores case, and a branch renamed main -> MAIN is a different branch.
$changed = $h.out -cne $P.expectHead -or $st.code -ne 0 -or $st.out -or $nowBranch -cne $P.expectBranch -or $nowSnap -cne $P.expectSnapshotRef
if ($changed) {
  if ($P.pack) { Remove-Item -LiteralPath $P.pack -Force -ErrorAction SilentlyContinue }
  Emit @{ blocked = "VM copy changed after inspection; nothing applied (HEAD $($h.out), branch '$nowBranch')"; head = $h.out; status = $st.out }
}
$steps = @()
if ($P.pack) {
  try {
    $o = & cmd.exe /d /c "git -c ""safe.directory=$($P.safe)"" -C ""$($P.repo)"" index-pack --stdin --fix-thin < ""$($P.pack)"" 2>&1" | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  } finally { Remove-Item -LiteralPath $P.pack -Force -ErrorAction SilentlyContinue }
  if ($code -ne 0) { Emit @{ failed = "index-pack failed (exit $code): " + (@($o) -join "` + "`n" + String.raw`") } }
  $steps += 'index-pack'
}
foreach ($c in @($P.commit, $P.snapshot)) { if ($c -and (G @('cat-file','-e',"$c^{commit}")).code -ne 0) { Emit @{ failed = "commit $c is still missing in the VM after transfer"; steps = $steps } } }
if ($P.leaveSnapshot) {
  $x = G @('checkout','-q','--no-overwrite-ignore',$P.branch)
  if ($x.code -ne 0) { Emit @{ failed = "could not return from the snapshot to $($P.branch): $($x.out)"; steps = $steps } }
  $steps += "checkout $($P.branch)"
}
if ((G @('rev-parse','HEAD')).out -cne $P.commit) {
  $x = G @('merge','-q','--ff-only','--no-overwrite-ignore',$P.commit)
  if ($x.code -ne 0) { Emit @{ failed = "fast-forward failed: $($x.out)"; steps = $steps } }
  $steps += "merge --ff-only $($P.commit)"
}
if ($P.snapshot) {
  $x = G @('checkout','-q','--no-overwrite-ignore','--detach',$P.snapshot)
  if ($x.code -ne 0) { Emit @{ failed = "snapshot checkout failed: $($x.out)"; steps = $steps } }
  $x = G @('update-ref','-m','cuelo vm_build snapshot','refs/cuelo-vm/snapshot',$P.snapshot)
  if ($x.code -ne 0) { Emit @{ failed = "checked out the snapshot but could not record refs/cuelo-vm/snapshot: $($x.out)"; steps = $steps } }
  $steps += "checkout --detach $($P.snapshot)"
} elseif ($P.clearSnapshotRef) {
  $x = G @('update-ref','-d','refs/cuelo-vm/snapshot')
  if ($x.code -ne 0) { Emit @{ failed = "could not delete refs/cuelo-vm/snapshot: $($x.out)"; steps = $steps } }
  $steps += 'update-ref -d refs/cuelo-vm/snapshot'
}
$b = G @('symbolic-ref','--short','-q','HEAD')
Emit @{ head = (G @('rev-parse','HEAD')).out; branch = $(if ($b.code -eq 0) { $b.out } else { '' }); status = (G @('status','--porcelain','--untracked-files=normal')).out; steps = $steps }
`;

interface ApplyResult { head?: string; branch?: string; status?: string; steps?: string[]; blocked?: string; failed?: string; fatal?: string }

/** Linux 작업 트리를 인덱스 사본으로 묶어 HEAD를 부모로 하는 커밋 객체를 만든다. 트리가 HEAD와 같으면 undefined. */
async function createSnapshot(run: Runner, root: string, head: string, branch: string, now: number): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "cuelo-vm-snapshot-"));
  try {
    const realIndex = resolve(root, await linuxGit(run, root, ["rev-parse", "--git-path", "index"], "인덱스 경로 확인"));
    const index = join(dir, "index");
    await copyFile(realIndex, index).catch(() => undefined);
    const env = { GIT_INDEX_FILE: index };
    await linuxGit(run, root, ["add", "-A"], "스냅샷 인덱스 작성", { low: true, env });
    const tree = await linuxGit(run, root, ["write-tree"], "스냅샷 트리 작성", { env });
    if (tree === await linuxGit(run, root, ["rev-parse", "HEAD^{tree}"], "HEAD 트리 확인")) return undefined;
    const stamp = `${Math.floor(now / 1000)} +0000`;
    return await linuxGit(run, root, ["commit-tree", tree, "-p", head, "-m", `CUELO vm_build snapshot of ${branch}@${head}`], "스냅샷 커밋 작성", {
      env: {
        GIT_AUTHOR_NAME: "CUELO vm_build", GIT_AUTHOR_EMAIL: "vm-build@cuelo.invalid", GIT_AUTHOR_DATE: stamp,
        GIT_COMMITTER_NAME: "CUELO vm_build", GIT_COMMITTER_EMAIL: "vm-build@cuelo.invalid", GIT_COMMITTER_DATE: stamp,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ancestryOf(run: Runner, root: string, vmTip: string, head: string): Promise<Ancestry> {
  if (vmTip === head) return "equal";
  const known = await run("git", ["cat-file", "-e", `${vmTip}^{commit}`], { cwd: root, env: { ...process.env, ...GIT_ENV } });
  if (known.code !== 0) return "unknown-commit";
  const ancestor = await run("git", ["merge-base", "--is-ancestor", vmTip, head], { cwd: root, env: { ...process.env, ...GIT_ENV } });
  return ancestor.code === 0 ? "ancestor" : "diverged";
}

export async function resolveLinuxRoot(run: Runner, repo: string): Promise<string> {
  const start = await realpath(resolve(repo)).catch(() => blocked(`Linux 저장소 경로가 없다: ${repo}`));
  const top = await linuxGit(run, start, ["rev-parse", "--show-toplevel"], "Linux 저장소 루트 확인");
  return realpath(top);
}

export async function findMapping(config: VmBuildConfig, root: string): Promise<RepoMapping> {
  for (const item of config.repos) {
    if (await realpath(item.linux).catch(() => undefined) === root) return item;
  }
  return blocked(`VM 사본 매핑이 없는 저장소다: ${root}. 설정 파일 repos에 {linux, vm}을 더해야 한다`);
}

/** Linux 정본을 VM 사본에 한 방향으로 반영한다. 막히면 Blocked를 던진다. */
export async function syncToVm(deps: SyncDeps, root: string, mapping: RepoMapping, mode: SyncMode): Promise<SyncResult> {
  const { run, host } = deps;
  const branch = await linuxGit(run, root, ["symbolic-ref", "--short", "-q", "HEAD"], "Linux 브랜치 확인").catch((error) => {
    if (error instanceof Blocked) blocked("Linux 저장소가 detached HEAD다");
    throw error;
  });
  const commit = await linuxGit(run, root, ["rev-parse", "HEAD"], "Linux HEAD 확인");
  const statusText = await linuxGit(run, root, ["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=normal"], "Linux 상태 확인", { low: true });
  const linuxChanges = statusText.split("\n").filter((line) => line.trim());
  const snapshot = mode === "snapshot" && linuxChanges.length > 0 ? await createSnapshot(run, root, commit, branch, deps.now()) : undefined;

  const base = { repo: mapping.vm, safe: vmSafeDirectory(mapping.vm) };
  const vm = await runRemote<VmState & { fatal?: string }>(run, host, INSPECT, { ...base, branch, want: [commit, snapshot].filter(Boolean) }, 5 * 60 * 1000);
  if (vm.fatal) blocked(`VM 상태 확인 실패: ${vm.fatal}`);
  vm.has = Array.isArray(vm.has) ? vm.has : vm.has ? [String(vm.has)] : [];
  const ancestry = vm.branchTip ? await ancestryOf(run, root, vm.branchTip, commit) : undefined;
  const decision = decideSync({ branch, commit, snapshot, vm, ancestry });
  const common = { mode, repo: root, vmPath: mapping.vm, branch, commit, ...(snapshot ? { snapshot } : {}), previous: vm.head, linuxChanges, localAppData: vm.localAppData };
  if (decision.kind === "blocked") blocked(decision.reason);
  if (decision.kind === "current") return { status: "already-current", ...common, vmHead: vm.head, packBytes: 0, steps: [] };

  let packBytes = 0;
  let remotePack: string | undefined;
  if (decision.needPack) {
    const dir = await mkdtemp(join(tmpdir(), "cuelo-vm-pack-"));
    try {
      const local = join(dir, "sync.pack");
      const revs = `${snapshot ?? commit}\n^${vm.branchTip}\n`;
      await linuxGit(run, root, ["pack-objects", "--revs", "--thin", "--stdout", "-q"], "pack 작성", { low: true, input: revs, stdoutFile: local });
      packBytes = (await stat(local)).size;
      const name = `cuelo-vm-${deps.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.pack`;
      remotePack = `${vm.temp.replace(/\\+$/, "")}\\${name}`;
      const [command, argv] = lowPriority("scp", ["-q", "-o", "BatchMode=yes", local, `${host}:${scpRemotePath(remotePack)}`]);
      const copied = await run(command, argv, { timeoutMs: 30 * 60 * 1000 });
      if (copied.code !== 0) blocked(`pack 전송 실패(scp exit ${copied.code}): ${copied.stderr.trim()}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const applied = await runRemote<ApplyResult>(run, host, APPLY, {
    ...base, branch, expectHead: vm.head, expectBranch: vm.branch, expectSnapshotRef: vm.snapshotRef, commit, snapshot: snapshot ?? "", pack: remotePack ?? "",
    leaveSnapshot: decision.leaveSnapshot, clearSnapshotRef: decision.clearSnapshotRef,
  }, 30 * 60 * 1000).catch((error) => {
    if (error instanceof Cancelled && error.started) throw new Cancelled(true, true);
    throw error;
  });
  const steps = Array.isArray(applied.steps) ? applied.steps : applied.steps ? [String(applied.steps)] : [];
  if (applied.fatal || applied.failed || applied.blocked) {
    blocked(`VM 반영 중단: ${applied.blocked ?? applied.failed ?? applied.fatal}${steps.length ? ` (끝낸 단계: ${steps.join(", ")})` : ""}`);
  }
  const expected = snapshot ?? commit;
  if (applied.head !== expected) blocked(`반영 후 VM HEAD(${applied.head})가 기대값(${expected})과 다르다`);
  const expectedBranch = snapshot ? "" : branch;
  if ((applied.branch ?? "") !== expectedBranch) blocked(`반영 후 VM 브랜치('${applied.branch ?? ""}')가 기대값('${expectedBranch}')과 다르다`);
  if (applied.status) blocked(`반영 후 VM 사본이 깨끗하지 않다:\n${applied.status}`);
  return { status: "synced", ...common, vmHead: applied.head, packBytes, steps };
}
