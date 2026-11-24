"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi, getFileName, normalizeFilePathSlashes } from "@/lib/file-paths";
import type { GitSummaryResponse } from "@/lib/git-summary";
import type { GitFileStatus, GitStatusResponse } from "@/lib/git-types";
import { formatRelativeTime } from "@/lib/i18n/format";
import styles from "./ProjectOverview.module.css";

export interface ProjectOverviewProps {
  cwd: string;
  onOpenFile: (absolutePath: string) => void;
}

interface FileListEntry {
  name: string;
  isDir: boolean;
}

interface GitSnapshot {
  summary: GitSummaryResponse;
  status: GitStatusResponse;
}

/** 결과는 그것을 읽은 cwd와 함께 둔다. cwd가 바뀌면 이전 결과는 곧바로 '읽는 중'으로 보인다. */
type Loaded<T> = { cwd: string; value: T | "failed" };

/** 긴 목록이 아래 묶음을 밀어내지 않게 처음에는 앞부분만 보이고, +N을 누르면 나머지를 편다. */
const CHANGES_VISIBLE = 30;
const FILES_VISIBLE = 40;

const STATUS_TONE: Record<GitFileStatus["status"], string> = {
  modified: styles.toneModified,
  added: styles.toneAdded,
  untracked: styles.toneAdded,
  deleted: styles.toneDeleted,
  conflict: styles.toneDeleted,
  renamed: styles.toneRenamed,
};

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return await response.json();
}

/** 응답 모양이 다르면 그리다 깨지지 않고 '읽지 못함'으로 보이게 null을 돌려준다. */
function readGitSnapshot(summary: unknown, status: unknown): GitSnapshot | null {
  if (typeof summary !== "object" || summary === null) return null;
  if (!("isGitRepository" in summary) || typeof summary.isGitRepository !== "boolean") return null;
  if (!("commits" in summary) || !Array.isArray(summary.commits)) return null;
  if (typeof status !== "object" || status === null || !("files" in status) || !Array.isArray(status.files)) return null;
  // 위에서 이 화면이 읽는 필드의 모양을 확인했다. 나머지 필드는 같은 서버 경로의 계약을 믿는다.
  return { summary: summary as unknown as GitSummaryResponse, status: status as unknown as GitStatusResponse };
}

function readFileEntries(result: unknown): FileListEntry[] | null {
  if (typeof result !== "object" || result === null || !("entries" in result) || !Array.isArray(result.entries)) return null;
  return result.entries.flatMap((entry: unknown) => (
    typeof entry === "object" && entry !== null && "name" in entry && typeof entry.name === "string"
      ? [{ name: entry.name, isDir: "isDir" in entry && entry.isDir === true }]
      : []
  ));
}

function relativeToCwd(cwd: string, filePath: string): string {
  const base = normalizeFilePathSlashes(cwd).replace(/\/+$/, "");
  const target = normalizeFilePathSlashes(filePath);
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : target;
}

function childPath(cwd: string, name: string): string {
  return `${normalizeFilePathSlashes(cwd).replace(/\/+$/, "")}/${name}`;
}

/** 앞쪽을 줄여 파일 이름이 남게 한다(PanelHeader 경로 부제와 같은 방식). */
function PathText({ value, className }: { value: string; className?: string }) {
  return (
    <span className={`${styles.pathText}${className ? ` ${className}` : ""}`} dir="rtl" title={value}>
      <bdi dir="ltr">{value}</bdi>
    </span>
  );
}

function MoreCount({ hidden, onShowAll }: { hidden: number; onShowAll: () => void }) {
  if (hidden <= 0) return null;
  return (
    <li>
      <button type="button" className={`${styles.row} ${styles.rowButton} ${styles.more}`} aria-expanded={false} onClick={onShowAll}>
        +{hidden}
      </button>
    </li>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <ul className={styles.list} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className={styles.skeletonRow} />
      ))}
    </ul>
  );
}

/**
 * 새 세션 인스펙터의 프로젝트 개요: 이름과 경로, 브랜치와 원격 대비 앞섬·뒤처짐, 변경 파일, 최근 커밋, 맨 위 파일.
 * 스스로 읽어 오며 cwd가 바뀌거나 창이 다시 초점을 받으면 새로 읽는다. 지난 요청은 취소한다.
 */
export function ProjectOverview({ cwd, onOpenFile }: ProjectOverviewProps) {
  const { t, locale } = useI18n();
  const [git, setGit] = useState<Loaded<GitSnapshot> | null>(null);
  const [files, setFiles] = useState<Loaded<FileListEntry[]> | null>(null);
  // 펼침은 그 프로젝트에만 적용한다. 다른 cwd로 바뀌면 다시 앞부분만 보인다.
  const [showAllFilesFor, setShowAllFilesFor] = useState<string | null>(null);
  const showAllFiles = showAllFilesFor === cwd;

  useEffect(() => {
    let controller: AbortController | null = null;
    const encodedCwd = encodeURIComponent(cwd);
    const load = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const { signal } = current;
      void Promise.all([
        fetchJson(`/api/git/summary?cwd=${encodedCwd}`, signal),
        fetchJson(`/api/git/status?cwd=${encodedCwd}`, signal),
      ]).then(
        ([summary, status]) => { if (!signal.aborted) setGit({ cwd, value: readGitSnapshot(summary, status) ?? "failed" }); },
        () => { if (!signal.aborted) setGit({ cwd, value: "failed" }); },
      );
      void fetchJson(`/api/files/${encodeFilePathForApi(cwd)}?type=list`, signal).then(
        (result) => { if (!signal.aborted) setFiles({ cwd, value: readFileEntries(result) ?? "failed" }); },
        () => { if (!signal.aborted) setFiles({ cwd, value: "failed" }); },
      );
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("focus", load);
      controller?.abort();
    };
  }, [cwd]);

  const gitValue = git?.cwd === cwd ? git.value : null;
  const filesValue = files?.cwd === cwd ? files.value : null;
  const loading = gitValue === null || filesValue === null;

  return (
    <section className={styles.root} aria-label={t("projectOverview.title")} aria-busy={loading || undefined}>
      <header className={styles.identity}>
        <h2 className={styles.name}>{getFileName(cwd) || cwd}</h2>
        <PathText value={cwd} className={styles.cwd} />
      </header>

      {gitValue === null ? (
        <div className={styles.group}>
          <SkeletonRows count={3} />
        </div>
      ) : gitValue === "failed" ? (
        <p className={styles.note} role="status">{t("projectOverview.loadFailed")}</p>
      ) : !gitValue.summary.isGitRepository ? (
        <p className={styles.note}>{t("projectOverview.notGit")}</p>
      ) : (
        <>
          <BranchGroup summary={gitValue.summary} />
          <ChangesGroup key={cwd} cwd={cwd} files={gitValue.status.files} onOpenFile={onOpenFile} />
          {gitValue.summary.commits.length > 0 && (
            <div className={styles.group}>
              <h3 className={styles.heading}>{t("projectOverview.recentCommits")}</h3>
              <ul className={`${styles.list} ${styles.commitList}`}>
                {gitValue.summary.commits.map((commit) => (
                  <li key={commit.hash} className={styles.commitRow}>
                    <span className={styles.hash}>{commit.shortHash}</span>
                    <time className={styles.when} dateTime={commit.committedAt} title={new Date(commit.committedAt).toLocaleString(locale)}>
                      {formatRelativeTime(commit.committedAt, locale)}
                    </time>
                    <span className={styles.subject} title={commit.subject}>{commit.subject}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className={styles.group}>
        <h3 className={styles.heading}>{t("projectOverview.files")}</h3>
        {filesValue === null ? (
          <SkeletonRows count={4} />
        ) : filesValue === "failed" ? (
          <p className={styles.note} role="status">{t("projectOverview.loadFailed")}</p>
        ) : (
          <ul className={styles.list}>
            {(showAllFiles ? filesValue : filesValue.slice(0, FILES_VISIBLE)).map((entry) => (
              <li key={entry.name}>
                {entry.isDir ? (
                  <span className={`${styles.row} ${styles.dirRow}`}>
                    <span className={styles.entryName}>{entry.name}/</span>
                  </span>
                ) : (
                  <button type="button" className={`${styles.row} ${styles.rowButton}`} onClick={() => onOpenFile(childPath(cwd, entry.name))}>
                    <span className={styles.entryName}>{entry.name}</span>
                  </button>
                )}
              </li>
            ))}
            {!showAllFiles && <MoreCount hidden={filesValue.length - FILES_VISIBLE} onShowAll={() => setShowAllFilesFor(cwd)} />}
          </ul>
        )}
      </div>
    </section>
  );
}

function BranchGroup({ summary }: { summary: GitSummaryResponse }) {
  const { t } = useI18n();
  const sync: string[] = [];
  if (!summary.detached) {
    if (!summary.upstream) sync.push(t("projectOverview.noUpstream"));
    else if (summary.ahead === 0 && summary.behind === 0) sync.push(t("projectOverview.inSync"));
    else {
      if (summary.ahead) sync.push(t("projectOverview.ahead", { count: summary.ahead }));
      if (summary.behind) sync.push(t("projectOverview.behind", { count: summary.behind }));
    }
  }
  const outOfSync = Boolean(summary.ahead || summary.behind);

  return (
    <div className={styles.group}>
      <h3 className={styles.heading}>{t("projectOverview.branch")}</h3>
      <p className={styles.branchLine}>
        <span className={styles.branchName}>
          {summary.detached ? t("projectOverview.detachedHead") : summary.branch}
        </span>
        {summary.upstream && <span className={styles.upstream}>{summary.upstream}</span>}
      </p>
      {sync.length > 0 && (
        <p className={`${styles.sync}${outOfSync ? ` ${styles.syncPending}` : ""}`}>
          {sync.map((part) => <span key={part}>{part}</span>)}
        </p>
      )}
    </div>
  );
}

function ChangesGroup({ cwd, files, onOpenFile }: { cwd: string; files: GitFileStatus[]; onOpenFile: (absolutePath: string) => void }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  return (
    <div className={styles.group}>
      <h3 className={styles.heading}>
        {t("projectOverview.changes")}
        {files.length > 0 && <span className={styles.count}>{files.length}</span>}
      </h3>
      {files.length === 0 ? (
        <p className={styles.note}>{t("projectOverview.noChanges")}</p>
      ) : (
        <ul className={styles.list}>
          {(showAll ? files : files.slice(0, CHANGES_VISIBLE)).map((file) => {
            const relative = relativeToCwd(cwd, file.filePath);
            const content = (
              <>
                <span className={`${styles.code} ${STATUS_TONE[file.status]}`}>{file.code}</span>
                <PathText value={relative} />
              </>
            );
            return (
              <li key={file.filePath}>
                {file.status === "deleted" ? (
                  <span className={`${styles.row} ${styles.deletedRow}`}>{content}</span>
                ) : (
                  <button type="button" className={`${styles.row} ${styles.rowButton}`} onClick={() => onOpenFile(file.filePath)}>
                    {content}
                  </button>
                )}
              </li>
            );
          })}
          {!showAll && <MoreCount hidden={files.length - CHANGES_VISIBLE} onShowAll={() => setShowAll(true)} />}
        </ul>
      )}
    </div>
  );
}
