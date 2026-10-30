import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export interface CiRun {
  status?: string;
  conclusion?: string;
  headSha?: string;
  createdAt?: string;
  workflowName?: string;
}

export interface DeployState {
  deployed: string | null;
  head: string | null;
  ci: CiRun | null;
  warnings: string[];
}

export async function inspectDeploy(agentDir: string, repo: string | null): Promise<DeployState> {
  const warnings: string[] = [];
  let deployed: string | null = null, head: string | null = null;
  try {
    const dir = join(agentDir, "..", "wsl-update");
    const names = (await readdir(dir)).filter(x => x.endsWith(".log")).sort().reverse();
    for (const name of names) { const matches = [...(await readFile(join(dir, name), "utf8")).matchAll(/\bREADY\s+([a-f0-9]{7,40})\b/gi)]; if (matches.length) { deployed = matches.at(-1)![1]; break; } }
    if (!deployed) warnings.push("배포 READY 기록을 찾지 못했습니다.");
  } catch { warnings.push("배포 로그를 읽지 못했습니다."); }
  if (repo) { try { head = (await exec("git", ["-C", repo, "log", "-1", "--format=%H"], { timeout: 10000 })).stdout.trim(); } catch { /* reported below */ } }
  if (!head) warnings.push("저장소 HEAD를 확인하지 못했습니다.");
  let ci: CiRun | null = null;
  try { const result = await exec("gh", ["run", "list", "--repo", "gim47656-ship-it/CUELO", "--limit", "1", "--json", "status,conclusion,headSha,createdAt,workflowName"], { timeout: 10000 }); ci = JSON.parse(result.stdout)[0] ?? null; } catch { /* reported below */ }
  if (!ci) warnings.push("공개 CI 상태를 확인하지 못했습니다.");
  return { deployed, head, ci, warnings };
}
