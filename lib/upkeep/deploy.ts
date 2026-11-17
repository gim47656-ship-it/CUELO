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
  /** 같은 구간에서 PC 서버에 배포되지 않는 폰 전용 경로만 바뀐 파일 수. */
  offPc: number;
  ci: CiRun | null;
  warnings: string[];
}

/** PC의 update.sh·앱·하네스 프로필이 읽지 않고 폰에만 설치되는 프로젝트(11-01 사용자 결정으로 분리). */
const OFF_PC_PREFIXES = ["Tools/CUELO_Phone_Bridge/"];

/**
 * 배포 리비전 뒤 HEAD까지 바뀐 파일을 배포가 필요한 것, 기록, PC 배포 밖 경로로 나눈다. 기록은 작업 기록(`doc/`), HANDOFF,
 * 기억 동기화 파일이다. 기억 동기화 파일은 update.sh가 배포 리비전이 아니라 개발 사본에서 바로 읽는다. 배포 뒤에는
 * 늘 이런 기록 커밋이 따라와서, 해시만 비교하면 이 지표가 거의 항상 「주의」였다(10-30 59dc49f6 → 4832bf87).
 * 폰 브리지 커밋도 PC 배포 없이 폰에 설치되는데 배포 필요로 세어 「주의」가 났다(11-01 f6f957a0 → 0c5ccfb0).
 * 비교는 공통 조상에서 HEAD까지(`배포...HEAD`)다. 두 점 비교는 HEAD가 배포보다 뒤처진 몇 초(배포 직후 개발 사본이 따라오기 전)에
 * 배포 쪽에만 있는 변경을 배포 필요로 셌다(11-14 HEAD cd63268f / 배포 cdd39f70, 22개).
 */
export async function pendingDeployFiles(repo: string, deployed: string, head: string): Promise<{ pending: string[]; records: number; offPc: number } | null> {
  try {
    // -z는 한글 등 특수 문자 경로를 따옴표 없이 주고, --no-renames는 lib→doc 이동이 삭제를 숨기지 않게 양쪽 경로를 다 준다.
    const { stdout } = await exec("git", ["-C", repo, "diff", "-z", "--no-renames", "--name-only", `${deployed}...${head}`], { timeout: 10000 });
    const files = stdout.split("\0").filter(Boolean);
    const nonRecords = files.filter((file) => !/(^|\/)doc\//.test(file) && !/(^|\/)HANDOFF\.md$/.test(file) && file !== "Tools/OMP_Global_Config/memory-sync/memories.jsonl");
    const pending = nonRecords.filter((file) => !OFF_PC_PREFIXES.some((prefix) => file.startsWith(prefix)));
    return { pending, records: files.length - nonRecords.length, offPc: nonRecords.length - pending.length };
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

/** 배포가 서버를 바꾼 구간. `from`은 세션을 내린 시각(`DRAINED`, 없으면 `START`), `to`는 새 서버가 뜬 시각(`READY` 또는 `ROLLED_BACK`). */
export interface DeployCutover { from: number; to: number }

const CUTOVER_LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) (START|DRAINED|READY|ROLLED_BACK)\b/gm;

/**
 * `~/.omp/wsl-update/<UTC>.log`(update.sh)에서 서버 교체 구간을 읽는다. 서버가 바뀌지 않은 실행(READY·ROLLED_BACK이 없는
 * 실패)은 뺀다. `coveredFrom`은 남은 로그 중 가장 이른 시작 시각이며, 그 전 배포는 로그가 지워져 알 수 없다.
 */
export async function deployCutovers(agentDir: string): Promise<{ cutovers: DeployCutover[]; coveredFrom: number | null }> {
  const dir = join(agentDir, "..", "wsl-update");
  const cutovers: DeployCutover[] = [];
  let coveredFrom: number | null = null;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => /^\d{8}T\d{6}Z\.log$/.test(name));
  } catch {
    return { cutovers, coveredFrom };
  }
  for (const name of names) {
    let text: string;
    try { text = await readFile(join(dir, name), "utf8"); } catch { continue; }
    let start: number | null = null, drained: number | null = null, end: number | null = null;
    for (const [, at, stage] of text.matchAll(CUTOVER_LINE_RE)) {
      const time = Date.parse(at);
      if (stage === "START") start ??= time;
      else if (stage === "DRAINED") drained ??= time;
      else end = time;
    }
    if (start !== null) coveredFrom = coveredFrom === null ? start : Math.min(coveredFrom, start);
    const from = drained ?? start;
    if (from !== null && end !== null) cutovers.push({ from, to: end });
  }
  cutovers.sort((a, b) => a.from - b.from);
  return { cutovers, coveredFrom };
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
  let pending: string[] | null = null, records = 0, offPc = 0;
  if (repo && head && deployed) {
    const diff = head.toLowerCase().startsWith(deployed.toLowerCase()) ? { pending: [], records: 0, offPc: 0 } : await pendingDeployFiles(repo, deployed, head);
    if (diff) ({ pending, records, offPc } = diff);
    else warnings.push((await hasCommit(repo, deployed))
      ? `배포 리비전 ${deployed.slice(0, 12)}을 저장소 HEAD와 비교하지 못했습니다.`
      : `개발 사본에 배포 리비전 ${deployed.slice(0, 12)}이 없어 HEAD와 비교하지 못했습니다. 다른 곳에서 게시·배포한 커밋을 아직 받지 않았을 수 있습니다(git fetch).`);
  }
  let ci: CiRun | null = null;
  try { const result = await exec("gh", ["run", "list", "--repo", "gim47656-ship-it/CUELO", "--limit", "1", "--json", "status,conclusion,headSha,createdAt,workflowName"], { timeout: 10000 }); ci = JSON.parse(result.stdout)[0] ?? null; } catch { /* reported below */ }
  if (!ci) warnings.push("공개 CI 상태를 확인하지 못했습니다.");
  return { deployed, head, pending, records, offPc, ci, warnings };
}
