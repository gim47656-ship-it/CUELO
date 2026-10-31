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
  /** 배포 리비전 뒤 HEAD까지 바뀐 파일 중 배포가 필요한 것. 두 리비전이 같으면 [], git이 비교하지 못하면 null. */
  pending: string[] | null;
  /** 같은 구간에서 기록만 바뀐 파일 수. */
  records: number;
  ci: CiRun | null;
  warnings: string[];
}

/**
 * 배포 리비전 뒤 HEAD까지 바뀐 파일을 배포가 필요한 것과 기록으로 나눈다. 기록은 작업 기록(`doc/`), HANDOFF,
 * 기억 동기화 파일이다. 기억 동기화 파일은 update.sh가 배포 리비전이 아니라 개발 사본에서 바로 읽는다. 배포 뒤에는
 * 늘 이런 기록 커밋이 따라와서, 해시만 비교하면 이 지표가 거의 항상 「주의」였다(10-30 59dc49f6 → 4832bf87).
 */
export async function pendingDeployFiles(repo: string, deployed: string, head: string): Promise<{ pending: string[]; records: number } | null> {
  try {
    // -z는 한글 등 특수 문자 경로를 따옴표 없이 주고, --no-renames는 lib→doc 이동이 삭제를 숨기지 않게 양쪽 경로를 다 준다.
    const { stdout } = await exec("git", ["-C", repo, "diff", "-z", "--no-renames", "--name-only", deployed, head], { timeout: 10000 });
    const files = stdout.split("\0").filter(Boolean);
    const pending = files.filter((file) => !/(^|\/)doc\//.test(file) && !/(^|\/)HANDOFF\.md$/.test(file) && file !== "Tools/OMP_Global_Config/memory-sync/memories.jsonl");
    return { pending, records: files.length - pending.length };
  } catch {
    return null;
  }
}

async function hasCommit(repo: string, rev: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repo, "cat-file", "-e", `${rev}^{commit}`], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
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
  let pending: string[] | null = null, records = 0;
  if (repo && head && deployed) {
    const diff = head.toLowerCase().startsWith(deployed.toLowerCase()) ? { pending: [], records: 0 } : await pendingDeployFiles(repo, deployed, head);
    if (diff) ({ pending, records } = diff);
    else warnings.push((await hasCommit(repo, deployed))
      ? `배포 리비전 ${deployed.slice(0, 12)}을 저장소 HEAD와 비교하지 못했습니다.`
      : `개발 사본에 배포 리비전 ${deployed.slice(0, 12)}이 없어 HEAD와 비교하지 못했습니다. 다른 곳에서 게시·배포한 커밋을 아직 받지 않았을 수 있습니다(git fetch).`);
  }
  let ci: CiRun | null = null;
  try { const result = await exec("gh", ["run", "list", "--repo", "gim47656-ship-it/CUELO", "--limit", "1", "--json", "status,conclusion,headSha,createdAt,workflowName"], { timeout: 10000 }); ci = JSON.parse(result.stdout)[0] ?? null; } catch { /* reported below */ }
  if (!ci) warnings.push("공개 CI 상태를 확인하지 못했습니다.");
  return { deployed, head, pending, records, ci, warnings };
}
