/**
 * 작업이 끝난 뒤 남은 작업 공간(2026-10-31 사용자 결정): 세션 기록이 끊긴 worktree, origin/main에 이미 들어간 원격
 * `wt/*` 브랜치, worktree용 기억 bank(`wt-*`). 지금 상태를 보는 값이라 기간 비교도 고침 표시도 하지 않는다.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { listWorktrees } from "../worktree";
import { STALE_WORKTREE_MS } from "./criteria";

const exec = promisify(execFile);

export type WorkspaceLeftovers = {
  /** 세션 기록이 STALE_WORKTREE_MS 넘게 없는 worktree. `lastActive`는 마지막 기록 시각(ms), 14일 안에 없으면 null */
  worktrees: { path: string; branch: string | null; lastActive: number | null }[] | null;
  /** origin/main에 병합된 원격 `wt/*` 브랜치 */
  branches: string[] | null;
  /** `wt-`로 시작하는 기억 bank 이름 */
  banks: string[] | null;
  warnings: string[];
};

/**
 * `cwdActivity`는 세션 스캔이 모은 세션 cwd별 마지막 기록 시각이다. 그 worktree나 하위 폴더에서 연 세션을 사용으로 본다.
 * 세션 기록을 다 읽지 못했으면 null을 받아 worktree는 확인하지 않는다(쓰이는 worktree를 남은 것으로 세지 않게).
 * 원격 브랜치는 받아 둔 origin 참조로만 본다(fetch 안 함).
 */
export async function inspectWorkspace(repo: string | null, agentDir: string, cwdActivity: Record<string, number> | null, now: number): Promise<WorkspaceLeftovers> {
  const warnings: string[] = [];
  let worktrees: WorkspaceLeftovers["worktrees"] = null, branches: WorkspaceLeftovers["branches"] = null, banks: WorkspaceLeftovers["banks"] = null;
  if (repo) {
    if (!cwdActivity) warnings.push("세션 기록을 다 읽지 못해 worktree가 쓰이는지 확인하지 못했습니다.");
    else {
      try {
        const activity = Object.entries(cwdActivity);
        const lastActive = (path: string) => activity.reduce<number | null>((last, [cwd, at]) =>
          (cwd === path || cwd.startsWith(`${path}/`)) && at > (last ?? -Infinity) ? at : last, null);
        worktrees = (await listWorktrees(repo))
          .filter((w) => !w.isMain)
          .map((w) => ({ path: w.path, branch: w.branch, lastActive: lastActive(w.path) }))
          .filter((w) => w.lastActive === null || now - w.lastActive > STALE_WORKTREE_MS);
      } catch {
        warnings.push("worktree 목록을 읽지 못했습니다.");
      }
    }
    try {
      const { stdout } = await exec("git", ["-C", repo, "branch", "-r", "--merged", "origin/main", "--format=%(refname:short)"], { timeout: 10000 });
      branches = stdout.split("\n").map((x) => x.trim()).filter((x) => x.startsWith("origin/wt/"));
    } catch {
      warnings.push("origin/main에 병합된 원격 브랜치를 확인하지 못했습니다.");
    }
  } else warnings.push("저장소를 찾지 못해 worktree와 원격 브랜치를 확인하지 못했습니다.");
  try {
    banks = (await readdir(join(agentDir, "memories", "mnemopi", "banks"))).filter((name) => name.startsWith("wt-"));
  } catch (error) {
    // bank 디렉터리가 없으면 남은 bank도 없다.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") banks = [];
    else warnings.push("기억 bank 목록을 읽지 못했습니다.");
  }
  return { worktrees, branches, banks, warnings };
}
