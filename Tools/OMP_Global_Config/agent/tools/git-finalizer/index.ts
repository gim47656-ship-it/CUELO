import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
  const targets: { root: string; path: string }[] = [];
  for (const input of files) {
    if (isAbsolute(input) || /[\0\r\n]/.test(input)) return; // 잘못된 경로의 최종 판정은 finalizer.ps1에 둔다.
    const absolute = resolve(cwd, input);
    let directory = dirname(absolute);
    while (true) {
      try {
        if ((await stat(directory)).isDirectory()) break;
      } catch { /* finalizer.ps1과 같이 가장 가까운 기존 부모를 찾는다. */ }
      const parent = dirname(directory);
      if (parent === directory) return;
      directory = parent;
    }
    const result = await exec("git", ["-C", directory, "rev-parse", "--show-prefix"], { cwd });
    if (result.code !== 0) return; // 저장소 밖·잘못된 대상은 finalizer.ps1이 판정한다.
    const prefix = result.stdout.trim().split("/").filter(Boolean);
    const root = resolve(directory, ...prefix.map(() => ".."));
    const path = relative(root, absolute).split(sep).join("/");
    if (!path || path === ".." || path.startsWith("../")) return;
    targets.push({ root, path });
  }
  if (!targets.length || targets.some(({ root }) => pathKey(root) !== pathKey(targets[0].root))) return;

  const root = targets[0].root;
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

const factory: CustomToolFactory = (pi) => ({
  name: "git_finalize",
  label: "Git Finalize",
  loadMode: "essential",
  description:
    "Atomically finalize relative exact files in one repository. Resolve every target from its nearest existing parent. Treat matching git common-dir values as the same repository: restrict those targets to paths inside cwd or an exact direct child file of the cwd repository root, while allowing one distinct repository; reject mixed repositories before staging. Serialize by repository/upstream, verify exact paths and ancestry, commit, then push the created SHA. If an earlier run committed but its push failed, call again with the same files: unchanged files found in unpushed upstream..HEAD commits are accepted and HEAD is pushed without a new commit. Main only.",
  parameters: pi.zod.object({
    files: pi.zod.array(pi.zod.string()),
    message: pi.zod.string(),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const requested = params.files.map((value) => value.trim()).filter(Boolean);
    const message = params.message.trim();
    if (requested.length === 0) throw new Error("git_finalize requires at least one exact file path.");
    if (!message) throw new Error("git_finalize requires a non-empty commit message.");

    const exec: Exec = (command, args, options) => pi.exec(command, args, { ...options, signal });
    await checkSourceManifest(pi.cwd, requested, exec);
    const memory = await exportMemories(pi.cwd, requested, exec);
    const files = memory.file ? [...requested, memory.file] : requested;

    onUpdate?.({
      content: [{ type: "text", text: "Repository finalizer lock을 획득하고 변경 경계를 확인하는 중입니다." }],
      details: { phase: "preflight", files },
    });

    const tempDir = await mkdtemp(join(tmpdir(), "omp-git-finalize-"));
    const requestPath = join(tempDir, "request.json");
    try {
      await writeFile(requestPath, JSON.stringify({ cwd: pi.cwd, files, message }), "utf8");
      const result = await pi.exec(
        process.platform === "win32" ? "powershell.exe" : "pwsh",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Request", requestPath],
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
