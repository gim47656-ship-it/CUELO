import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface FinalizerResult {
  ok: boolean;
  stage: string;
  error?: string;
  commitSha?: string;
  remote?: string;
  upstreamRef?: string;
}

const scriptPath = fileURLToPath(new URL("./finalizer.ps1", import.meta.url));

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
    "Atomically finalize relative exact files in one repository. Resolve every target from its nearest existing parent. Treat matching git common-dir values as the same repository: restrict those targets to paths inside cwd or an exact direct child file of the cwd repository root, while allowing one distinct repository; reject mixed repositories before staging. Serialize by repository/upstream, verify exact paths and ancestry, commit, then push the created SHA. Main only.",
  parameters: pi.zod.object({
    files: pi.zod.array(pi.zod.string()),
    message: pi.zod.string(),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const files = params.files.map((value) => value.trim()).filter(Boolean);
    const message = params.message.trim();
    if (files.length === 0) throw new Error("git_finalize requires at least one exact file path.");
    if (!message) throw new Error("git_finalize requires a non-empty commit message.");
    if (process.platform !== "win32") throw new Error("git_finalize currently requires Windows PowerShell.");

    onUpdate?.({
      content: [{ type: "text", text: "Repository finalizer lock을 획득하고 변경 경계를 확인하는 중입니다." }],
      details: { phase: "preflight", files },
    });

    const tempDir = await mkdtemp(join(tmpdir(), "omp-git-finalize-"));
    const requestPath = join(tempDir, "request.json");
    try {
      await writeFile(requestPath, JSON.stringify({ cwd: pi.cwd, files, message }), "utf8");
      const result = await pi.exec(
        "powershell.exe",
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
            text: `Committed and pushed ${parsed.commitSha} to ${parsed.remote} ${parsed.upstreamRef}.`,
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
