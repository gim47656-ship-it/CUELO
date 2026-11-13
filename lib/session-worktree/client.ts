export interface SessionWorktreeNotice { branch: string; base: string; fallback: boolean; missingSubdirectory?: string }
export const worktreeText = {
  en: { issueLabel: "GitHub issue (optional)", issuePlaceholder: "#123 or GitHub issue URL", issueStart: "Start issue session", issueBusy: "Starting…", fallbackBase: "Fetch failed; started from local {branch}" },
  ko: { issueLabel: "GitHub 이슈 (선택)", issuePlaceholder: "#123 또는 GitHub 이슈 URL", issueStart: "이슈 세션 시작", issueBusy: "시작 중…", fallbackBase: "가져오기 실패; 로컬 {branch}에서 시작됨" },
  zh: { issueLabel: "GitHub Issue（可选）", issuePlaceholder: "#123 或 GitHub Issue URL", issueStart: "开始 Issue 会话", issueBusy: "正在启动…", fallbackBase: "拉取失败；已从本地 {branch} 启动" },
};
export const missingSubdirectoryText = {
  en: "The subdirectory {path} is not in this worktree; opened its root instead",
  ko: "이 워크트리에 하위 디렉터리 {path}이(가) 없어 루트 디렉터리를 대신 열었습니다",
  zh: "此工作树中不存在子目录 {path}，已改为打开其根目录",
};
export function rememberWorktreeNotice(cwd: string, notice?: SessionWorktreeNotice): void {
  if (!notice) return;
  try { sessionStorage.setItem(`cuelo:worktree:${cwd}`, JSON.stringify(notice)); } catch { /* Storage can be disabled. */ }
}
export function readWorktreeNotice(cwd: string | null): SessionWorktreeNotice | undefined {
  if (!cwd || typeof sessionStorage === "undefined") return undefined;
  try { return JSON.parse(sessionStorage.getItem(`cuelo:worktree:${cwd}`) ?? "null") ?? undefined; }
  catch { return undefined; }
}
