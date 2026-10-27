import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { currentBlobs, ledgerPath, resolveRepoTargets, runGate, spawnExec } from "../../extensions/lib/cross-review";
import { mergeGateBlobs, runSlopGate, slopLedgerPath } from "../../extensions/lib/slop-gate";
import { hasPosixGitdirWorktree, isWindowsDrivePath, selectGitExecutor, usesWindowsDriveRepo } from "./wsl-git";

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

// 문서·그림은 HANDOFF 의무의 대상인 소스·설정 변경이 아니다. 목록 밖의 자산(예: 오디오)은 소스로 보고 알림이 날 수 있다(advisory).
const nonSourceFile = /\.(md|markdown|rst|adoc|txt|rtf|pdf|docx?|xlsx?|pptx?|odt|ods|odp|hwpx?|png|jpe?g|gif|svg|webp|ico|bmp|tiff?|avif|heic)$/i;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 프로젝트가 여럿인 저장소에서, HANDOFF가 없던 프로젝트의 첫 코드 커밋이 기록 없이 올라간 일이 두 번 있었다(2026-10-13 확인, rule://docs-handoff).
 * 바꾼 코드 파일에서 저장소 루트(`.git`이 있는 폴더)까지 `HANDOFF.md`가 하나도 없을 때만 결과 문구로 알린다. 커밋은 막지 않는다.
 */
async function missingHandoffNote(cwd: string, files: string[]): Promise<string | undefined> {
  // 폴더 → 그 폴더의 저장소 루트(`.git`이 있는 폴더)와, 그 폴더에서 루트까지 HANDOFF.md가 있는지. 저장소 밖이면 undefined.
  const memo = new Map<string, Promise<{ root: string; handoff: boolean } | undefined>>();
  const scan = (dir: string): Promise<{ root: string; handoff: boolean } | undefined> => {
    let found = memo.get(dir);
    if (!found) {
      found = (async () => {
        const handoff = await exists(join(dir, "HANDOFF.md"));
        if (await exists(join(dir, ".git"))) return { root: dir, handoff };
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        const above = await scan(parent);
        return above && { root: above.root, handoff: handoff || above.handoff };
      })();
      memo.set(dir, found);
    }
    return found;
  };
  const folders = new Set<string>();
  for (const file of files) {
    const path = resolve(cwd, file);
    if (nonSourceFile.test(path)) continue;
    const repo = await scan(dirname(path));
    // `doc/`는 cwd나 요청 문자열이 아니라 대상 저장소 루트 기준 경로로 가린다.
    if (!repo || repo.handoff || relative(repo.root, path).split(sep).includes("doc")) continue;
    folders.add(relative(cwd, dirname(path)).split(sep).join("/") || ".");
  }
  if (folders.size === 0) return undefined;
  const shown = [...folders].slice(0, 3).map((folder) => `\`${folder}\``).join(", ");
  const more = folders.size > 3 ? ` 외 ${folders.size - 3}곳` : "";
  return `HANDOFF 확인: ${shown}${more}에서 저장소 루트까지 HANDOFF.md가 없다. 소스·설정을 바꾼 첫 커밋이면 rule://docs-handoff대로 작업한 프로젝트 폴더에 HANDOFF.md·doc/README.md·doc/history 기록을 만들어 이어서 커밋한다(이번 커밋은 그대로 진행됐다).`;
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
 * 단 cwd만 보지 않고 대상 파일 위치도 본다. cwd가 드라이브 위여도 대상이 ext4(`~/src/...`) 같은 드라이브 밖이면 Windows git은
 * 그 저장소를 열지 못한다. 2026-10-13 cwd `/mnt/f/CUELO`에서 `~/src/CUELO-private` 파일을 넘기자 `fatal: not a git repository`로 끝났다.
 */
export async function windowsDrivePaths(cwd: string, files: string[], paths: string[], exec: Exec): Promise<string[] | undefined> {
  if (!files.every((file) => isWindowsDrivePath(resolve(cwd, file)))) return undefined;
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
    "Atomically finalize relative exact files in one repository. Resolve every target from its nearest existing parent. Treat matching git common-dir values as the same repository: restrict those targets to paths inside cwd or an exact direct child file of the cwd repository root, while allowing one distinct repository; reject mixed repositories before staging. Serialize by repository/upstream, verify exact paths and ancestry, commit, then push the created SHA. If an earlier run committed but its push failed, call again with the same files: unchanged files found in unpushed upstream..HEAD commits are accepted and HEAD is pushed without a new commit. Cross-family review gate (stage `cross-review`): when there is something new to commit, a code file needs a passed cross_review resolve for its exact current content if it is listed in crossReviewHighRisk (paths from files), a high-risk marker hits its changed lines, or the deterministic 10% sample selects the commit (then at most the 5 code files with the most changed lines, project/style/designer files excluded); otherwise the call is refused with the files, the reason and the next step. Docs, tests, generated files, binary media/office/font assets, TS/JS edits the TypeScript parser proves comment-only and edits that only change version strings (against HEAD or the last passed content) are not targets. crossReviewWaiver is allowed only on the user's explicit instruction and is recorded. AI-slop gate (stage `slop-gate`, after cross-review): every visible artifact among the files that has something new to commit (README/CHANGELOG/docs and other markdown, html, pptx/docx/xlsx/pdf/hwpx, report csv, UI copy packs, plus .slop-gate.json visible globs; no publication declaration is needed, and .publicignore does not exempt anything) needs a slop_check pass for its exact current content (sha256); otherwise the call is refused with the files and the next step. Source code, comments, logs, tests, fixtures, generated files and internal records (rules, prompts, skills, HANDOFF.md, doc/history, doc/README.md) are not slop targets. slopGateWaiver is allowed only on the user's explicit instruction and is recorded. Main only.",
  parameters: pi.zod.object({
    files: pi.zod.array(pi.zod.string()),
    message: pi.zod.string(),
    crossReviewHighRisk: pi.zod.array(pi.zod.string()).optional(),
    crossReviewWaiver: pi.zod.string().optional(),
    slopGateWaiver: pi.zod.string().optional(),
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
    // AI 슬롭 게이트: 보이는 산출물(문서·html·Office·pdf·보고 csv·UI 문구, .slop-gate.json이 더한 것)은 현재 내용의 slop_check 통과가 있어야 한다.
    // 게이트가 맞춘 바이트의 blob을 gateBlobs에 합쳐, 게이트 뒤에 파일이 바뀌면 finalizer가 잠금 안에서 거절한다.
    try {
      const slop = await runSlopGate({
        cwd: pi.cwd, files: requested, waiver: params.slopGateWaiver, ledgerPath: slopLedgerPath(),
        exec: spawnExec(signal), gitFor: async (root) => (await selectGitExecutor(root)).command,
      });
      gateBlobs = mergeGateBlobs(gateBlobs, slop);
    } catch (error) {
      throw new Error(`git_finalize failed at slop-gate: ${error instanceof Error ? error.message : String(error)}`);
    }
    const memory = await exportMemories(pi.cwd, requested, exec);
    const files = memory.file ? [...requested, memory.file] : requested;
    const handoffNote = await missingHandoffNote(pi.cwd, requested);
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
              + (memory.note ? ` ${memory.note}` : "")
              + (handoffNote ? ` ${handoffNote}` : "")
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
