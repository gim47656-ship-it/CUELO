import type { CustomTool, CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { currentBlobs, ledgerPath, resolveRepoTargets, runGate, spawnExec } from "../../extensions/lib/cross-review";
import { finalizeChecksNote, runFinalizeChecks, type FinalizeChecksResult } from "../../extensions/lib/finalize-checks";
import { mergeGateBlobs, runSlopGate, slopLedgerPath } from "../../extensions/lib/slop-gate";
import { integrateTool, reattachRetiredBranch } from "./integrate";
import { syncBehindUpstream } from "./sync-upstream";
import { hasPosixGitdirWorktree, isWindowsDrivePath, selectGitExecutor, usesWindowsDriveRepo, windowsPathToPosix } from "./wsl-git";

export { hasPosixGitdirWorktree };
/** 도구 로더가 넘기는 API. 한 factory가 git_finalize와 git_integrate를 함께 등록한다. */
export type ToolApi = Parameters<CustomToolFactory>[0];

interface FinalizerResult {
  ok: boolean;
  stage: string;
  error?: string;
  commitSha?: string;
  remote?: string;
  upstreamRef?: string;
  resumedPush?: boolean;
  outsideCwdReason?: string;
  leftoverScope?: string;
  leftoverTotal?: number;
  leftoverFiles?: string[];
  repositoryRoot?: string;
  repositoryFiles?: string[];
}

class FinalizerPathRefusal extends Error {}

const scriptPath = fileURLToPath(new URL("./finalizer.ps1", import.meta.url));
const syncCheckoutPath = fileURLToPath(new URL("./sync-checkout.ts", import.meta.url));
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
const shellArg = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

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
  // sync.ts reaches the mnemopi package through <checkout>/node_modules, which a new linked worktree lacks; the main
  // checkout's copy resolves it. The export argument stays root, so the transport lands in this worktree's commit.
  let scriptRoot = root;
  if (!(await exists(join(root, "node_modules")))) {
    const common = await exec("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root });
    const commonDir = common.code === 0 ? resolve(root, common.stdout.trim()) : "";
    const mainRoot = dirname(commonDir);
    if (basename(commonDir) === ".git" && await exists(join(mainRoot, "node_modules")) && await exists(join(mainRoot, ...memorySyncScript.split("/")))) {
      scriptRoot = mainRoot;
    }
  }
  const exported = await exec("bun", [join(scriptRoot, ...memorySyncScript.split("/")), "export", root], { cwd: root });
  if (exported.code !== 0) {
    // Bun ends a crash with a blank line and its version banner; the cause is the `error: …` (or `…Error: …`) line.
    const lines = (exported.stderr || exported.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const reason = lines.find((line) => /^(?:error|[A-Za-z]*Error)\b/.test(line))
      ?? lines.findLast((line) => !/^Bun v\d/.test(line)) ?? `exit ${exported.code}`;
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
 * 공개 미러(`.publicignore`와 `.github/workflows/publish-public.yml`)가 있는 저장소에서, 방금 push한 커밋이 미러에 닿는지와
 * 무엇을 기다려야 하는지 알려 준다. 2026-11-03: Main이 비공개 무결성 목록만 바꾼 커밋의 게시 실행을 10분 기다렸고(그런 커밋은
 * 게시·공개 CI가 생기지 않는다) 같은 내용의 10-21 기억이 있었지만 회상되지 않았다. 게시 워크플로처럼
 * `git ls-files -ci --exclude-from=.publicignore`로 비공개 파일을 가르되, 규칙과 경로는 작업 폴더가 아니라 push한
 * 커밋에서 읽는다: 그 커밋의 `.publicignore`, 그 커밋과 부모 커밋 트리(`--with-tree`, 지운 파일은 부모에만 있다). 게시 기준 파일
 * 자체는 워크플로가 건너뛰지 않으므로 늘 공개로 센다. 어느 조회든 실패하면 안내를 빼고 성공 응답은 그대로 둔다.
 */
export async function publicationNote(root: string, commitSha: string, resumedPush: boolean, exec: Exec): Promise<string | undefined> {
  const git = (args: string[]) => exec("git", ["-C", root, ...args], { cwd: root });
  if ((await git(["cat-file", "-e", `${commitSha}:.github/workflows/publish-public.yml`])).code !== 0) return undefined;
  const rules = await git(["show", `${commitSha}:.publicignore`]);
  if (rules.code !== 0) return undefined;
  const waitPublicCi = "게시 실행(Publish public mirror)과 웹 릴리스는 기다리지 않는다";
  if (resumedPush) return `공개 미러: 미전송 커밋을 함께 보내 이 커밋만으로는 판정하지 않았다. 공개 미러 CI를 run id로 찾아 그것만 기다리고, ${waitPublicCi}.`;
  const changed = await git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root", commitSha]);
  if (changed.code !== 0) return undefined;
  const files = changed.stdout.split("\0").filter(Boolean);
  if (files.length === 0) return undefined;
  // `rev-list --parents`는 커밋과 부모들을 한 줄로 낸다. 조회 실패와 첫 커밋(부모 없음)을 구분한다.
  const lineage = await git(["rev-list", "--parents", "-n", "1", commitSha]);
  if (lineage.code !== 0) return undefined;
  const trees = [commitSha, ...lineage.stdout.trim().split(/\s+/).slice(1, 2)];
  const dir = await mkdtemp(join(tmpdir(), "omp-publication-note-"));
  try {
    const rulesPath = join(dir, "publicignore");
    await writeFile(rulesPath, rules.stdout, "utf8");
    const privateFiles = new Set<string>();
    for (const tree of trees) {
      const ignored = await git(["ls-files", "-z", "-ci", `--exclude-from=${rulesPath}`, `--with-tree=${tree}`, "--", ...files]);
      if (ignored.code !== 0) return undefined;
      for (const file of ignored.stdout.split("\0")) if (file) privateFiles.add(file);
    }
    const publicationInputs = [".publicignore", ".publicdeny", ".github/workflows/publish-public.yml"];
    const publicFiles = files.filter((file) => publicationInputs.includes(file) || !privateFiles.has(file));
    if (publicFiles.length === 0) {
      return "공개 미러: 이 커밋은 비공개 파일만 바꿨다. 게시·공개 CI 실행이 생기지 않으니 기다리지 않는다(배포가 필요하면 앞 커밋의 공개 CI 결과를 그대로 쓴다).";
    }
    return `공개 미러: 공개 파일 ${publicFiles.length}개가 바뀌어 게시 뒤 공개 미러 CI가 돈다. 그 CI 하나만 run id로 찾아 기다리고, ${waitPublicCi}.`;
  } finally {
    await rm(dir, { recursive: true, force: true });
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
  return `HANDOFF 확인: ${shown}${more}에서 저장소 루트까지 HANDOFF.md가 없다. 같은 저장소의 다른 프로젝트가 HANDOFF.md와 doc/history를 쓰고 있고 바꿀 경로가 제한되지 않았으면 rule://docs-handoff대로 작업한 프로젝트 폴더에 HANDOFF.md·doc/README.md·doc/history 기록을 만들어 이어서 커밋한다. 그 관례가 없거나 경로가 정해진 과제면 새로 만들지 않는다(이번 커밋은 그대로 진행됐다).`;
}

function isSourcePath(path: string, packagedTools: string[]): boolean {
  if (path.split("/").some((segment) => generatedSourceSegments[segment] || segment.endsWith(".tsbuildinfo"))) return false;
  if (path === "doc" || path.startsWith("doc/") || excludedSourcePaths[path]) return false;
  if (path.startsWith("Tools/")) {
    return packagedTools.some((entry) => path === entry || path.startsWith(`${entry}/`));
  }
  return true;
}

class StaleManifestError extends Error {
  constructor(message: string, readonly root: string) {
    super(message);
  }
}

type ManifestExec = (command: string, args: string[], options: { cwd: string }) => Promise<{ code: number; stdout: string; stderr?: string }>;

/**
 * 매니페스트가 낡았으면 안내 문구의 두 명령을 같은 cwd·인자로 직접 실행해 다시 만들고, 매니페스트를 이번 커밋에 넣을 cwd 기준 경로를 돌려준다
 * (2026-11-19: 안내대로 두 명령을 돌리고 매니페스트를 더해 다시 호출하면 늘 통과했다). 명령이 하나라도 실패하면 이전 매니페스트 바이트를 되돌리고
 * 기존 오류에 명령 출력을 붙여 던진다. 헬퍼가 없는 저장소는 verifySourceManifest가 애초에 건너뛰므로 여기까지 오지 않는다.
 * 낡음이 아닌 오류(목록 누락 등)는 그대로 던진다. 요청 파일 일부가 cwd 밖인데 outsideCwdReason이 없으면 finalizer가 거절할 요청이므로
 * 저장소를 건드리지 않고 기존 오류를 그대로 던진다.
 */
async function checkSourceManifest(cwd: string, files: string[], exec: ManifestExec, outsideAuthorized: boolean): Promise<{ file: string; restoreIfUnchanged: () => string } | undefined> {
  try {
    await verifySourceManifest(cwd, files, exec);
    return undefined;
  } catch (error) {
    if (!(error instanceof StaleManifestError)) throw error;
    const insideCwd = files.every((file) => {
      const outside = relative(resolve(cwd), resolve(cwd, file));
      return outside !== ".." && !outside.startsWith(`..${sep}`) && !isAbsolute(outside);
    });
    if (!insideCwd && !outsideAuthorized) throw error;
    const helperCwd = join(error.root, "Tools", "CUELO_Setup");
    const manifestFile = join(error.root, ...manifestPath.split("/"));
    let previous: Buffer | undefined;
    try {
      previous = await readFile(manifestFile);
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`${error.message}\nThe current manifest could not be read, so it was not regenerated: ${readError instanceof Error ? readError.message : String(readError)}`);
      }
    }
    // 되돌리기가 실패해도 낡음 오류와 헬퍼 출력은 잃지 않도록 결과 문구만 돌려준다.
    const restore = async (): Promise<string> => {
      try {
        if (previous) await writeFile(manifestFile, previous);
        else await rm(manifestFile, { force: true });
        return "the previous manifest was restored";
      } catch (restoreError) {
        return `restoring the previous manifest FAILED (${restoreError instanceof Error ? restoreError.message : String(restoreError)}); inspect ${manifestPath}`;
      }
    };
    const steps = [
      ["files/source-build-helper.js", "create-manifest", "../..", "files/runtime-integrity.json", "--output", "files/source-integrity.json"],
      ["files/source-build-helper.js", "verify-source", "../..", "files/source-integrity.json", "files/runtime-integrity.json"],
    ];
    const earlierOutputs: string[] = [];
    for (const args of steps) {
      let failure: string | undefined;
      let text = "";
      try {
        const result = await exec("node", args, { cwd: helperCwd });
        text = [result.stdout, result.stderr].map((part) => (part ?? "").trim()).filter(Boolean).join("\n");
        if (result.code !== 0) failure = `exit ${result.code}: ${text}`;
      } catch (spawnError) {
        const attached = spawnError as { stdout?: unknown; stderr?: unknown };
        text = [attached?.stdout, attached?.stderr].map((part) => (typeof part === "string" ? part.trim() : "")).filter(Boolean).join("\n");
        failure = `${(spawnError instanceof Error ? spawnError.message : String(spawnError)) || "the command could not be started"}${text ? `: ${text}` : ""}`;
      }
      if (failure) {
        const restored = await restore();
        throw new Error(`${error.message}\nAutomatic regeneration failed at \`node ${args.slice(0, 2).join(" ")}\` (${failure}); ${restored}.${earlierOutputs.length ? `\nEarlier helper output: ${earlierOutputs.join(" | ")}` : ""}`);
      }
      if (text) earlierOutputs.push(text);
    }
    // 다시 만든 매니페스트로 한 번 더 대조한다. 그래도 어긋나면 되돌리고 원래 오류와 헬퍼 출력을 함께 보인다.
    try {
      await verifySourceManifest(cwd, files, exec);
    } catch (recheckError) {
      const restored = await restore();
      throw new Error(`${error.message}\nThe manifest was regenerated but still does not match (${restored}): ${recheckError instanceof Error ? recheckError.message : String(recheckError)}${earlierOutputs.length ? `\nHelper output: ${earlierOutputs.join(" | ")}` : ""}`);
    }
    const generated = await readFile(manifestFile);
    return {
      file: relative(cwd, manifestFile).split(sep).join("/"),
      restoreIfUnchanged: () => {
        try {
          if (!readFileSync(manifestFile).equals(generated)) return `The generated ${manifestPath} changed again and was left alone; include it in the retry.`;
          if (previous) writeFileSync(manifestFile, previous);
          else rmSync(manifestFile);
          return "The previous source manifest was restored.";
        } catch (error) {
          return `Could not restore ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    };
  }
}

async function verifySourceManifest(
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
  // 매니페스트를 함께 커밋해도 건너뛰지 않는다: 추적 전 새 파일이 빠진 매니페스트가 세 출시 연속 후속 커밋을 낳았다
  // (2026-11-04, doc/history/2026/11/04-nightly-manifest). 커밋하는 매니페스트는 작업 폴더의 그 파일이므로 같은 대조를 한다.

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
    // JSON 객체의 상속 속성(`constructor` 등)을 목록 항목으로 읽지 않는다.
    const recorded = manifest.files && Object.hasOwn(manifest.files, path) ? manifest.files[path] : undefined;
    // 지운 파일은 매니페스트에서도 빠져 있어야 한다.
    if (!bytes) {
      if (recorded === undefined) continue;
      throw new Error(`git_finalize: source manifest still lists deleted ${path}. ${manifestInstructions}`);
    }
    const content = !bytes.includes(0) && bytes.includes("\r\n")
      ? Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")
      : bytes;
    const hash = createHash("sha256").update(content).digest("hex");
    if (recorded === undefined) {
      throw new Error(`git_finalize: source manifest is missing ${path}. create-manifest reads only tracked files, so run \`git add -N ${path}\` first. ${manifestInstructions}`);
    }
    if (recorded !== hash) {
      throw new StaleManifestError(`git_finalize: source manifest is stale for ${path}. ${manifestInstructions}`, root);
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

export const finalizeTool = (pi: ToolApi): CustomTool<any, any> => ({
  name: "git_finalize",
  label: "Git Finalize",
  loadMode: "essential",
  description:
    "Main-only commit/push. Before calling: give exact cwd-relative files in one repo (no globs/directories) and message; crossReviewHighRisk uses paths from files. Resolve cross_review for gated code and slop_check for gated visible files at current content. Include the matching source manifest where required; stale hashes are regenerated and committed when possible. Fix known .finalize-checks.json failures; matching checks run after review/slop before publication." +
    " crossReviewWaiver: explicit user instruction OR standing exception when required review failed only on provider rate or usage limits (decision, reviewId, raw errors). slopGateWaiver and finalizeChecksWaiver: explicit user instruction only. outsideCwdReason: user's explicit instruction for files outside session cwd, except in its own linked worktree or for direct children of the cwd repo root. Result lists leftover files under the committed folder (advisory). Behind-only copies fast-forward/merge before gates; divergence/conflict stops. Never bypass locks/ancestry.",
  parameters: pi.zod.object({
    files: pi.zod.array(pi.zod.string()),
    message: pi.zod.string(),
    crossReviewHighRisk: pi.zod.array(pi.zod.string()).optional(),
    crossReviewWaiver: pi.zod.string().optional(),
    slopGateWaiver: pi.zod.string().optional(),
    finalizeChecksWaiver: pi.zod.string().optional(),
    outsideCwdReason: pi.zod.string().optional(),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    let requested: string[] = params.files.map((value: string) => value.trim()).filter(Boolean);
    const message = params.message.trim();
    if (requested.length === 0) {
      throw new Error("git_finalize requires at least one exact file path." + (message ? "" : "\ngit_finalize requires a non-empty commit message."));
    }
    if (!message) throw new Error("git_finalize requires a non-empty commit message.");

    const exec: Exec = (command, args, options) => pi.exec(command, args, { ...options, signal });
    const prepareFinalizer = async (tempDir: string, files: string[], generatedManifest: boolean) => {
      const requestPath = join(tempDir, "request.json");
      const windows = await windowsDrivePaths(pi.cwd, files, [pi.cwd, scriptPath, requestPath], exec);
      const shell = process.platform === "win32" || windows ? "powershell.exe" : "pwsh";
      const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windows?.[1] ?? scriptPath, "-Request", windows?.[2] ?? requestPath];
      const options = { cwd: pi.cwd, signal, timeout: 180_000 };
      const outsideCwdReason = params.outsideCwdReason?.trim();
      const request = { cwd: windows?.[0] ?? pi.cwd, files, message, outsideCwdReason, generatedFiles: generatedManifest ? [manifestPath] : undefined };
      return {
        requestPath, request, windows, shell, args, options,
        async checkPaths() {
          await writeFile(requestPath, JSON.stringify(request), "utf8");
          const result = await pi.exec(shell, [...args, "-PreflightOnly"], options);
          const parsed = parseResult(result.stdout);
          if (result.code !== 0 || !parsed?.ok || !parsed.repositoryRoot || !parsed.repositoryFiles?.length) {
            const detail = `git_finalize failed at ${parsed?.stage ?? "preflight"}: ${parsed?.error || result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`;
            if (parsed?.ok === false && parsed.stage === "repository") throw new FinalizerPathRefusal(detail);
            throw new Error(detail);
          }
          const root = windows ? windowsPathToPosix(parsed.repositoryRoot) : parsed.repositoryRoot;
          return { root, paths: parsed.repositoryFiles };
        },
      };
    };
    const preconditionError = async (error: unknown, stage?: "cross-review" | "slop-gate", generatedManifest = false) => {
      const primary = (stage ? `git_finalize failed at ${stage}: ` : "") + (error instanceof Error ? error.message : String(error));
      let pathNote = "";
      let dir: string | undefined;
      try {
        // Diagnose paths only on rejection. This stops before fetch, staging, or project commands.
        if (!signal?.aborted) {
          dir = await mkdtemp(join(tmpdir(), "omp-git-finalize-"));
          const prepared = await prepareFinalizer(dir, requested, generatedManifest);
          await prepared.checkPaths();
        }
      } catch (pathError) {
        const detail = pathError instanceof Error ? pathError.message : String(pathError);
        pathNote = pathError instanceof FinalizerPathRefusal
          ? `\nExact file-list preflight: ${detail}\nCorrect the reported path or repository issue before retrying.`
          : `\nCould not verify the exact file list: ${detail}\nResolve the preflight error before retrying.`;
      } finally {
        if (dir) {
          await rm(dir, { recursive: true, force: true }).catch((cleanupError: Error) => {
            pathNote += `\nCould not remove the temporary preflight request: ${cleanupError.message}`;
          });
        }
      }
      const next = [
        !stage && "a current cross_review pass for gated code",
        stage !== "slop-gate" && "a current slop_check pass for gated visible files",
        "passing matching .finalize-checks.json checks (git_finalize runs them after preflight)",
      ].filter(Boolean).join("; ");
      return new Error(`${primary}${pathNote}\nAfter fixing the above, this call also requires, where applicable: ${next}.`);
    };
    // 뒤처지기만 한 작업 사본은 원격 커밋을 먼저 받는다(사용자 결정 2026-11-05). 게이트가 받은 뒤의 내용(합친 파일 포함)을 보도록 맨 앞에서 한다.
    let upstreamNote = "";
    const repo = await resolveRepoTargets(pi.cwd, requested, exec).catch(() => undefined);
    if (repo && !("failure" in repo)) {
      // git_integrate가 게시 뒤 로컬 세션 브랜치를 지운 worktree(분리된 HEAD)에서 다시 커밋하면 같은 이름의 브랜치를 먼저 다시 붙인다.
      const reattached = isWindowsDrivePath(repo.root) ? { status: "none" as const } : await reattachRetiredBranch(repo.root, { signal });
      if (reattached.note) onUpdate?.({ content: [{ type: "text", text: reattached.note }], details: { phase: "branch-reattach" } });
      try {
        // 작업 사본을 바꾸는 단계는 취소 신호 없이 끝까지 돌려 반쯤 바뀐 채 남지 않게 한다(조회·fetch만 취소된다).
        upstreamNote = (await syncBehindUpstream(spawnExec(signal), (await selectGitExecutor(repo.root)).command, repo.root, spawnExec())).note ?? "";
      } catch (error) {
        throw new Error(`git_finalize failed at upstream-sync: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (upstreamNote) onUpdate?.({ content: [{ type: "text", text: upstreamNote }], details: { phase: "upstream-sync" } });
      if (reattached.note) upstreamNote = [reattached.note, upstreamNote].filter(Boolean).join(" ");
    }
    // 낡은 매니페스트는 여기서 다시 만들어 요청 파일에 더한다. 게이트 blob 수집(runGate)보다 앞이라 finalizer의 blob 대조와 어긋나지 않는다.
    const regeneratedManifest = await checkSourceManifest(pi.cwd, requested, exec, Boolean(params.outsideCwdReason?.trim()))
      .catch(async (error: unknown) => { throw await preconditionError(error); });
    if (regeneratedManifest && !requested.some((file) => resolve(pi.cwd, file) === resolve(pi.cwd, regeneratedManifest.file))) {
      requested = [...requested, regeneratedManifest.file];
    }
    // 계열 교차검증 게이트는 바뀐 줄에 marker가 있거나, crossReviewHighRisk로 선언했거나, 커밋의 게이트 대상 코드가
    // 크기 기준(3파일 또는 50줄 이상, 2026-11-23 사용자 결정)을 넘는 코드에 통과 기록을 요구한다(판정 정본: lib/cross-review.ts).
    // 기억 transport(memory.file)는 생성물이라 요청 파일에만 적용한다.
    let gateBlobs: Record<string, string> | undefined;
    try {
      gateBlobs = (await runGate({
        cwd: pi.cwd, files: requested, highRisk: params.crossReviewHighRisk, waiver: params.crossReviewWaiver,
        ledgerPath: ledgerPath(), exec: spawnExec(signal), gitFor: async (root) => (await selectGitExecutor(root)).command,
      })).gateBlobs;
    } catch (error) {
      // 게이트가 판정하지 못한 오류(git 실패 등)도 열어 두지 않는다: 확인하지 못한 채 커밋하지 않는다.
      throw await preconditionError(error, "cross-review", Boolean(regeneratedManifest));
    }
    // AI 슬롭 게이트: 보이는 산출물(문서·html·Office·pdf·보고 csv·UI 문구, .slop-gate.json이 더한 것)은 현재 내용의 slop_check 통과가 있어야 한다.
    // 게이트가 맞춘 바이트의 blob을 gateBlobs에 합쳐, 게이트 뒤에 파일이 바뀌면 finalizer가 잠금 안에서 거절한다.
    let rawDataNote = "";
    try {
      const slop = await runSlopGate({
        cwd: pi.cwd, files: requested, waiver: params.slopGateWaiver, ledgerPath: slopLedgerPath(),
        exec: spawnExec(signal), gitFor: async (root) => (await selectGitExecutor(root)).command,
      });
      gateBlobs = mergeGateBlobs(gateBlobs, slop);
      // 원자료 csv로 보고 통과를 요구하지 않은 파일도 결과에 남긴다(조용히 빠지지 않게).
      if (slop.rawData?.length) rawDataNote = `slop-gate가 원자료 csv로 보고 심사를 요구하지 않은 파일: ${slop.rawData.map((file) => `${file.path} (${file.reason})`).join("; ")}.`;
    } catch (error) {
      throw await preconditionError(error, "slop-gate", Boolean(regeneratedManifest));
    }
    const memory = await exportMemories(pi.cwd, requested, exec);
    const files = memory.file ? [...requested, memory.file] : requested;
    // 성공 문구 끝에 붙는 안내(HANDOFF 누락, 원자료 csv). 성공 문구 조립부는 그대로 두고 이 값에 합친다.
    const handoffNote = [await missingHandoffNote(pi.cwd, requested), rawDataNote].filter(Boolean).join(" ");
    if (gateBlobs && memory.file) {
      // 기억 transport는 게이트 뒤에 방금 만든 생성물(검토 대상 아님)이라 finalizer가 같은 기준으로 비교하도록 지금 blob을 넣는다.
      const transport = await resolveRepoTargets(pi.cwd, [memory.file], exec);
      if (!("failure" in transport)) {
        const blobs = await currentBlobs(spawnExec(signal), (await selectGitExecutor(transport.root)).command, transport.root, transport.targets.map((target) => target.path));
        for (const [path, blob] of blobs) gateBlobs[path] = blob;
      }
    }

    const tempDir = await mkdtemp(join(tmpdir(), "omp-git-finalize-"));
    try {
      const prepared = await prepareFinalizer(tempDir, files, Boolean(regeneratedManifest));
      const { requestPath, request, windows, shell, args, options } = prepared;
      let finalizeChecks: FinalizeChecksResult | undefined;
      const run = spawnExec(signal);
      let pathPreflight: { root: string; paths: string[] } | undefined;
      const verifyPaths = async () => pathPreflight ??= await prepared.checkPaths();
      const portableFiles = files.map((file) => file.replaceAll("\\", "/"));
      const targets = repo && !("failure" in repo) && files.length === repo.targets.length && portableFiles.every((file, index) => file === repo.targets[index].input)
        ? repo : await resolveRepoTargets(pi.cwd, portableFiles, run);
      const { root, paths } = "failure" in targets
        ? await verifyPaths()
        : { root: targets.root, paths: targets.targets.map((target) => target.path) };
      const git = (await selectGitExecutor(root)).command;
      try {
        finalizeChecks = await runFinalizeChecks({
          root, files: paths, git, exec: run, signal, waiver: params.finalizeChecksWaiver,
          sessionManager: ctx?.sessionManager, publicationCandidate: true,
          authorize: async () => {
            // Project commands may only run after the finalizer approves the same target/paths.
            const authoritative = await verifyPaths();
            if (pathKey(resolve(authoritative.root)) !== pathKey(resolve(root)) ||
              authoritative.paths.length !== paths.length ||
              authoritative.paths.some((path, index) => pathKey(path) !== pathKey(paths[index]))) {
              throw new Error("The publication paths changed during path preflight.");
            }
            const missing = paths.filter((path) => !gateBlobs || !Object.hasOwn(gateBlobs, path));
            const blobs = await currentBlobs(run, git, root, missing);
            gateBlobs = { ...Object.fromEntries(blobs), ...gateBlobs };
            onUpdate?.({ content: [{ type: "text", text: "Checking the repository's publication candidate." }], details: { phase: "finalize-checks" } });
          },
        });
      } catch (error) {
        const manifestNote = regeneratedManifest?.restoreIfUnchanged();
        throw new Error(`git_finalize failed at finalize-checks: ${error instanceof Error ? error.message : String(error)}${manifestNote ? `\n${manifestNote}` : ""}`);
      }
      onUpdate?.({
        content: [{ type: "text", text: "Repository finalizer lock을 획득하고 변경 경계를 확인하는 중입니다." }],
        details: { phase: "preflight", files },
      });
      // Gate blobs and HEAD bind the checked publication to the commit transaction under the lock.
      await writeFile(requestPath, JSON.stringify({
        ...request, finalizeChecksHead: finalizeChecks?.publicationHead, finalizeChecksTree: finalizeChecks?.candidateTree,
        gateBlobs: gateBlobs && Object.keys(gateBlobs).length ? gateBlobs : undefined,
      }), "utf8");
      const result = await pi.exec(shell, args, options);
      const parsed = parseResult(result.stdout);
      if (result.code !== 0 || !parsed?.ok) {
        const detail = parsed?.error || result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        throw new Error(`git_finalize failed${parsed?.stage ? ` at ${parsed.stage}` : ""}: ${detail}${upstreamNote ? ` (${upstreamNote})` : ""}${parsed?.stage === "push" ? " The local commit remains; after fixing the push failure, call git_finalize again with the same files to push it without a new commit." : ""}`);
      }
      // 게시 뒤 Windows 대응 사본 반영(deploy-ops)에 붙여 넣을 명령: 손으로 40자 리비전을 옮기던 일을 덜어 준다(10-25~27 54회).
      // 대응 사본은 PC·저장소마다 달라 정본이 없으므로 대상만 자리표시로 두고, 짝이 있는지는 Main이 운영 문서로 정한다.
      // Windows 드라이브 저장소는 그 자체가 Windows 사본이라 반영할 짝이 없다.
      // 커밋·push는 이미 끝났으므로 저장소 조회가 실패해도 힌트만 빼고 성공 응답은 그대로 둔다.
      let syncHint = "";
      let publication: string | undefined;
      if (parsed.commitSha) {
        const repo = await resolveRepoTargets(pi.cwd, requested, exec).catch(() => undefined);
        if (repo && !("failure" in repo)) {
          // 기다릴 대상 안내는 Windows 저장소에도 붙인다. 대응 사본 명령만 WSL·Linux 저장소 전용이다.
          publication = await publicationNote(repo.root, parsed.commitSha, Boolean(parsed.resumedPush), exec).catch(() => undefined);
          if (!windows && process.platform !== "win32") {
            syncHint = `\nWindows 대응 사본이 있으면: bun ${shellArg(syncCheckoutPath)} --source ${shellArg(repo.root)}`
              + ` --target ${shellArg("<대응 Windows 사본의 /mnt 경로>")} --revision ${parsed.commitSha}`;
          }
        }
      }
      const checksNote = finalizeChecksNote(finalizeChecks);
      return {
        content: [
          {
            type: "text",
            text: `Committed and pushed ${parsed.commitSha} to ${parsed.remote} ${parsed.upstreamRef}.`
              + (upstreamNote ? ` ${upstreamNote}` : "")
              + (regeneratedManifest ? ` 소스 매니페스트(${manifestPath})가 낡아 다시 만들어 이번 커밋에 포함했다.` : "")
              + (parsed.resumedPush ? " 이미 커밋돼 있던 미전송 커밋을 함께 다시 보냈다." : "")
              + (memory.file ? ` 기억 transport(${memory.file})를 함께 커밋했다.` : "")
              + (memory.note ? ` ${memory.note}` : "")
              + (handoffNote ? ` ${handoffNote}` : "")
              + (checksNote ? `\n${checksNote}` : "")
              + (parsed.outsideCwdReason ? `\n세션 cwd 밖 경로를 사용자 지시(outsideCwdReason)로 커밋했다: ${parsed.outsideCwdReason}` : "")
              + (parsed.leftoverTotal && parsed.leftoverFiles?.length
                ? `\n커밋하지 않고 남은 파일(${parsed.leftoverScope}/ 아래 ${parsed.leftoverTotal}개, 이번 커밋에 포함되지 않음):\n${parsed.leftoverFiles.join("\n")}`
                  + (parsed.leftoverTotal > parsed.leftoverFiles.length ? `\n... 외 ${parsed.leftoverTotal - parsed.leftoverFiles.length}개` : "")
                : "")
              + (publication ? `\n${publication}` : "")
              + syncHint
          },
        ],
        details: checksNote ? { ...parsed, finalizeChecks } : parsed,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
});

/**
 * 두 도구는 커밋·rebase·push를 한다. agent loop는 `concurrency`를 선언하지 않은 도구를 "shared"로 보고 같은 응답의
 * 다른 shared 호출(`bash`로 기록 덧붙이기, source manifest 재생성 등)과 동시에 돌린다(2026-10-20·10-29에 실제로 겹쳤다).
 * "exclusive"는 앞선 호출이 모두 끝난 뒤 시작하고 뒤 호출을 붙잡는다. `CustomTool` 타입에는 이 필드가 없지만
 * `CustomToolAdapter`가 도구 객체의 자체 키를 그대로 넘기므로 스케줄러가 여기서 읽는다.
 */
const runAlone = (tool: CustomTool<any, any>): CustomTool<any, any> => Object.assign(tool, { concurrency: "exclusive" as const });

const factory: CustomToolFactory = (pi) => [finalizeTool(pi), integrateTool(pi)].map(runAlone);

export default factory;
