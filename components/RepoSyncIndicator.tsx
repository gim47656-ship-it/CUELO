"use client";

import { useCallback, useEffect, useState } from "react";
import type { Repo, SyncState, Reason } from "@/lib/repo-sync/service";
import styles from "./RepoSyncIndicator.module.css";

type State = SyncState & { uncloned: Repo[] };
const reasons: Record<Reason, string> = {
  dirty: "작업 트리에 변경 사항 있음", diverged: "브랜치 이력 분기됨", ahead: "로컬 커밋이 원격보다 앞서 있음",
  detached: "분리된 HEAD 상태", "other-branch": "기본 브랜치가 아님", untracked: "origin 브랜치를 추적하지 않음",
  busy: "세션 사용 중", "unknown-idle": "유휴 상태 확인 불가", "git-lock": "Git 잠금 파일 존재",
  "fetch-error": "가져오기(fetch) 오류", "ff-error": "빨리 감기(fast-forward) 병합 오류",
  "server-auth": "서버 비밀번호 잠금으로 세션 확인 불가",
};
export function RepoSyncIndicator() {
  const [state, setState] = useState<State | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/repo-sync", { cache: "no-store" });
      if (res.ok) setState(await res.json());
    } catch { /* Keep the last notice while the server restarts. */ }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function act(name: string, action: "clone" | "decline" | "undecline") {
    setPending(name); setError(false);
    try {
      const res = await fetch("/api/repo-sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, action }) });
      if (!res.ok) throw new Error("Request failed");
      setState(await res.json());
    } catch { setError(true); }
    finally { setPending(null); await refresh(); }
  }
  if (!state) return null;
  const asks = state.uncloned.filter((r) => state.decisions[r.name] !== "decline");
  const declined = state.uncloned.filter((r) => state.decisions[r.name] === "decline");
  const skips = state.results.filter((r) => r.outcome === "skipped");
  const failed = Object.entries(state.clones).filter(([, c]) => c.status === "failed");
  const running = Object.entries(state.clones).filter(([, c]) => c.status === "running");
  const warning = state.accountStatus === "auth" || state.accountStatus === "error";
  if (!asks.length && !declined.length && !skips.length && !warning && !failed.length && !running.length) return null;
  return <details className={styles.notice} data-repo-sync>
    <summary>저장소 동기화{asks.length ? ` (${asks.length})` : ""}</summary>
    <div className={styles.body}>
      {state.accountStatus === "auth" && <p role="status">이 PC에서 로그인 필요 (gh auth login)</p>}
      {state.accountStatus === "error" && <p role="status">계정 목록 조회 실패로 이전 목록 사용</p>}
      {error && <p role="alert">API 요청 실패</p>}
      {asks.map((repo) => <div className={styles.repo} key={repo.name} data-repo-name={repo.name}>
        <span>{repo.name}{repo.isFork ? " (포크)" : ""}</span>
        <div className={styles.actions}>
          <button type="button" disabled={!!pending || state.clones[repo.name]?.status === "running"} onClick={() => void act(repo.name, "clone")}>받기</button>
          <button type="button" disabled={!!pending || state.clones[repo.name]?.status === "running"} onClick={() => void act(repo.name, "decline")}>이 PC에선 안 받기</button>
        </div>
      </div>)}
      {running.map(([name]) => <p key={name} role="status">{name}: 복제 진행 중</p>)}
      {failed.map(([name, attempt]) => <p key={name} role="status">{name}: {attempt.error === "auth" ? "이 PC에서 로그인 필요 (gh auth login)" : "복제 실패"}</p>)}
      {skips.map((repo) => <p key={repo.path} title={repo.path}>
        {repo.name}: {repo.reason ? reasons[repo.reason] : ""}
        {repo.skipCount > 1 && <small>{repo.lastSuccess
          ? `마지막 성공 동기화: ${Math.max(0, Math.floor((Date.now() - Date.parse(repo.lastSuccess)) / 3_600_000))}시간 전`
          : "성공한 동기화 기록 없음"}</small>}
      </p>)}
      {!!declined.length && <details><summary>이 PC에서 받지 않을 저장소 ({declined.length})</summary>
        {declined.map((repo) => <div className={styles.repo} key={repo.name} data-repo-name={repo.name}>
          <span>{repo.name}</span><button type="button" disabled={!!pending} onClick={() => void act(repo.name, "undecline")}>다시 묻기</button>
        </div>)}
      </details>}
    </div>
  </details>;
}
