import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { currentBlobs, ledgerPath, resolveRepoTargets, runGate, spawnExec } from "../../extensions/lib/cross-review";
import { hasPosixGitdirWorktree, selectGitExecutor, usesWindowsDriveRepo } from "./wsl-git";

export { hasPosixGitdirWorktree };

interface FinalizerResult {
  ok: boolean;
  stage: string;
  error?: string;
  commitSha?: string;
  remote?: string;
  upstreamRef?: string;
  resumedPush?: boolean;
}

const scriptPath = fileURLToPath(new URL("./finalizer.ps1", import.meta.url));
const helperPath = "Tools/CUELO_Setup/files/source-build-helper.js";
const manifestPath = "Tools/CUELO_Setup/files/source-integrity.json";
const excludedSourcePaths: Record<string, true> = {
  "HANDOFF.md": true, "PC-SETUP.md": true, ".publicignore": true, ".publicdeny": true,
  ".github/workflows/publish-public.yml": true,
};
const generatedSourceSegments: Record<string, true> = { ".git": true, ".next": true, ".omp": true, node_modules: true };
// helper.buildFileMap()은 전체 트리를 검사하므로 무관한 writer의 변경까지 읽는다.
// 여기서는 helper의 source 경계와 LF 해시 규칙을 선택된 파일에만 적용한다.
const manifestInstructions = `From cwd Tools/CUELO_Setup, run:
node files/source-build-helper.js create-manifest ../.. files/runtime-integrity.json --output files/source-integrity.json
node files/source-build-helper.js verify-source ../.. files/source-integrity.json files/runtime-integrity.json
Then include Tools/CUELO_Setup/files/source-integrity.json in the same commit.`;
const memorySyncScript = "Tools/OMP_Global_Config/memory-sync/sync.ts";
const memoryTransport = "Tools/OMP_Global_Config/memory-sync/memories.jsonl";
const pathKey = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;

type Exec = (command: string, args: string[], options: { cwd: string }) => Promise<{ code: number; stdout: string; stderr?: string }>;

/**
 * 기억 PC 간 동기화의 export를 커밋 경로에 붙인다. 원래 hook은 손으로 돌리는 export.ps1 끝뿐이라
 * 평소 커밋·배포로는 한 번도 내보내지지 않았다(2026-10-02). 같은 저장소 커밋이면 먼저 export하고,
 * 바뀐 transport 파일을 커밋 목록에 더한다. 실패는 커밋을 막지 않고 결과 문구로 알린다.
 */
async function exportMemories(cwd: string, files: string[], exec: Exec): Promise<{ file?: string; note?: string }> {
  const top = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { cwd });
  if (top.code !== 0) return {};
  const root = resolve(top.stdout.trim());
  try {
    await access(join(root, ...memorySyncScript.split("/")));
  } catch {
    return {};
  }
  const inRoot = (path: string) => {
    const rel = relative(root, resolve(cwd, path));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!files.every(inRoot)) return {};
  const transport = relative(cwd, join(root, ...memoryTransport.split("/"))).split(sep).join("/");
  if (transport.startsWith("../")) return { note: "기억 export 생략: 현재 cwd 밖의 파일이라 이 커밋에 넣을 수 없다." };
  if (files.some((file) => pathKey(file.replace(/\\/g, "/")) === pathKey(transport))) return {};
  const exported = await exec("bun", [join(root, ...memorySyncScript.split("/")), "export", root], { cwd: root });
  if (exported.code !== 0) {
    const reason = (exported.stderr || exported.stdout).trim().split(/\r?\n/).at(-1) || `exit ${exported.code}`;
    return { note: `기억 export 실패(커밋은 진행): ${reason}` };
  }
  const status = await exec("git", ["-C", root, "status", "--porcelain", "--", memoryTransport], { cwd: root });
  return status.code === 0 && status.stdout.trim() ? { file: transport } : {};
}

function isSourcePath(path: string, packagedTools: string[]): boolean {
  if (path.split("/").some((segment) => generatedSourceSegments[segment] || segment.endsWith(".tsbuildinfo"))) return false;
  if (path === "doc" || path.startsWith("doc/") || excludedSourcePaths[path]) return false;
  if (path.startsWith("Tools/")) {
    return packagedTools.some((entry) => path === entry || path.startsWith(`${entry}/`));
  }
  return true;
}

async function checkSourceManifest(
  cwd: string,
  files: string[],
  exec: (command: string, args: string[], options: { cwd: string }) => Promise<{ code: number; stdout: string }>,
): Promise<void> {
  const resolved = await resolveRepoTargets(cwd, files, exec);
  if ("failure" in resolved) return; // 잘못된 경로·저장소 밖·여러 저장소의 최종 판정은 finalizer.ps1에 둔다.
  const { root, targets } = resolved;
  try {
    await stat(join(root, ...helperPath.split("/")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (targets.some(({ path }) => pathKey(path) === pathKey(manifestPath))) return;

  let packagedTools: string[] = [];
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { files?: unknown };
    if (Array.isArray(pkg.files)) {
      packagedTools = pkg.files
        .filter((entry): entry is string => typeof entry === "string" && entry.startsWith("Tools/"))
        .map((entry) => entry.replace(/\/+$/, ""));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sourcePaths = targets.map(({ path }) => path).filter((path) => isSourcePath(path, packagedTools));
  if (!sourcePaths.length) return;

  let manifest: { files?: Record<string, string> } = {};
  try {
    manifest = JSON.parse(await readFile(join(root, ...manifestPath.split("/")), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const path of sourcePaths) {
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(join(root, ...path.split("/")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const content = bytes && !bytes.includes(0) && bytes.includes("\r\n")
      ? Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")
      : bytes;
    const hash = content && createHash("sha256").update(content).digest("hex");
    if (!hash || manifest.files?.[path] !== hash) {
      throw new Error(`git_finalize: source manifest is stale for ${path}. ${manifestInstructions}`);
    }
  }
}

function parseResult(stdout: string): FinalizerResult | undefined {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]) as FinalizerResult;
      if (value && typeof value.ok === "boolean" && typeof value.stage === "string") return value;
    } catch {
      // PowerShell or Git may emit a non-JSON diagnostic before the final result.
    }
  }
  return undefined;
}

/**
 * WSL에서 Windows 드라이브(`/mnt/<드라이브>/`) 위 저장소는 Linux git이 9p로 파일마다 stat해 매우 느리다.
 * 2026-10-08 V: 아카이브(추적 파일 21만여 개)에서 Linux `git status`는 300초를 넘겼고 finalizer 제한 시간(180초)에
 * 걸려 `exit -1`로 끊겼다. 같은 저장소의 Windows `git.exe status`는 2.5초다. 그런 저장소는 Windows PowerShell과
 * Windows git으로 같은 finalizer를 돌리고, 넘기는 경로는 `wslpath -w`로 바꾼다. 해당하지 않으면 undefined다.
 * 판정(`usesWindowsDriveRepo`: `/mnt/<드라이브>/` + POSIX gitdir worktree 제외)은 command-guard·앱의 git 실행기와 같다.
 */
async function windowsDrivePaths(cwd: string, files: string[], paths: string[], exec: Exec): Promise<string[] | undefined> {
  if (!(await usesWindowsDriveRepo(cwd, files))) return undefined;
  const converted: string[] = [];
  for (const path of paths) {
    const result = await exec("wslpath", ["-w", path], { cwd });
    if (result.code !== 0 || !result.stdout.trim()) throw new Error(`git_finalize: wslpath -w ${path} 변환 실패: ${(result.stderr || result.stdout).trim()}`);
    converted.push(result.stdout.trim());
  }
  return converted;
}

const factory: CustomToolFactory = (pi) => ({
  name: "git_finalize",
  label: "Git Finalize",
  loadMode: "essential",
  description:
    "Atomically finalize relative exact files in one repository. Resolve every target from its nearest existing parent. Treat matching git common-dir values as the same repository: restrict those targets to paths inside cwd or an exact direct child file of the cwd repository root, while allowing one distinct repository; reject mixed repositories before staging. Serialize by repository/upstream, verify exact paths and ancestry, commit, then push the created SHA. If an earlier run committed but its push failed, call again with the same files: unchanged files found in unpushed upstream..HEAD commits are accepted and HEAD is pushed without a new commit. Cross-family review gate (stage `cross-review`): when there is something new to commit, a code file (docs, tests and generated files excluded) needs a passed cross_review resolve for its exact current content if crossReviewHighRisk is true, a high-risk marker hits its changed lines, or the deterministic 10% sample selects the commit; otherwise the call is refused with the files, the reason and the next step. crossReviewWaiver is allowed only on the user's explicit instruction and is recorded. Main only.",
  parameters: pi.zod.object({
    files: pi.zod.array(pi.zod.string()),
    message: pi.zod.string(),
    crossReviewHighRisk: pi.zod.boolean().optional(),
    crossReviewWaiver: pi.zod.string().optional(),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const requested = params.files.map((value) => value.trim()).filter(Boolean);
    const message = params.message.trim();
    if (requested.length === 0) throw new Error("git_finalize requires at least one exact file path.");
    if (!message) throw new Error("git_finalize requires a non-empty commit message.");

    const exec: Exec = (command, args, options) => pi.exec(command, args, { ...options, signal });
    await checkSourceManifest(pi.cwd, requested, exec);
    // 계열 교차검증 게이트: 새로 커밋할 코드가 trigger·표본에 걸리면 통과한 검토 기록이 있어야 한다.
    // 기억 transport(memory.file)는 생성물이라 요청 파일에만 적용한다.
    let gateBlobs: Record<string, string> | undefined;
    try {
      gateBlobs = (await runGate({
        cwd: pi.cwd, files: requested, highRisk: params.crossReviewHighRisk, waiver: params.crossReviewWaiver,
        ledgerPath: ledgerPath(), exec: spawnExec(signal), gitFor: async (root) => (await selectGitExecutor(root)).command,
      })).gateBlobs;
    } catch (error) {
      // 게이트가 판정하지 못한 오류(git 실패 등)도 열어 두지 않는다: 확인하지 못한 채 커밋하지 않는다.
      throw new Error(`git_finalize failed at cross-review: ${error instanceof Error ? error.message : String(error)}`);
    }
    const memory = await exportMemories(pi.cwd, requested, exec);
    const files = memory.file ? [...requested, memory.file] : requested;
    if (gateBlobs && memory.file) {
      // 기억 transport는 게이트 뒤에 방금 만든 생성물(검토 대상 아님)이라 finalizer가 같은 기준으로 비교하도록 지금 blob을 넣는다.
      const transport = await resolveRepoTargets(pi.cwd, [memory.file], exec);
      if (!("failure" in transport)) {
        const blobs = await currentBlobs(spawnExec(signal), (await selectGitExecutor(transport.root)).command, transport.root, transport.targets.map((target) => target.path));
        for (const [path, blob] of blobs) gateBlobs[path] = blob;
      }
    }

    onUpdate?.({
      content: [{ type: "text", text: "Repository finalizer lock을 획득하고 변경 경계를 확인하는 중입니다." }],
      details: { phase: "preflight", files },
    });

    const tempDir = await mkdtemp(join(tmpdir(), "omp-git-finalize-"));
    const requestPath = join(tempDir, "request.json");
    try {
      const windows = await windowsDrivePaths(pi.cwd, files, [pi.cwd, scriptPath, requestPath], exec);
      // gateBlobs: 게이트가 본 코드 파일의 blob. finalizer.ps1이 잠금 안에서 stage된 내용과 대조해, 게이트 뒤에 파일이 바뀌었으면 커밋하지 않는다.
      await writeFile(requestPath, JSON.stringify({ cwd: windows?.[0] ?? pi.cwd, files, message, ...(gateBlobs && Object.keys(gateBlobs).length > 0 ? { gateBlobs } : {}) }), "utf8");
      const result = await pi.exec(
        process.platform === "win32" || windows ? "powershell.exe" : "pwsh",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windows?.[1] ?? scriptPath, "-Request", windows?.[2] ?? requestPath],
        { cwd: pi.cwd, signal, timeout: 180_000 },
      );
      const parsed = parseResult(result.stdout);
      if (result.code !== 0 || !parsed?.ok) {
        const detail = parsed?.error || result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        throw new Error(`git_finalize failed${parsed?.stage ? ` at ${parsed.stage}` : ""}: ${detail}`);
      }
      return {
        content: [
          {
            type: "text",
            text: `Committed and pushed ${parsed.commitSha} to ${parsed.remote} ${parsed.upstreamRef}.`
              + (parsed.resumedPush ? " 이미 커밋돼 있던 미전송 커밋을 함께 다시 보냈다." : "")
              + (memory.file ? ` 기억 transport(${memory.file})를 함께 커밋했다.` : "")
              + (memory.note ? ` ${memory.note}` : ""),
          },
        ],
        details: parsed,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
});

export default factory;
