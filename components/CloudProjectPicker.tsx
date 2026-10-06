"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { GithubLogin, GithubProjectStatus, GithubRepository } from "@/lib/github-projects";
import { DirectoryPicker } from "./DirectoryPicker";
import styles from "./CloudProjectPicker.module.css";

interface Props { onCancel: () => void; onSelect: (path: string) => void; busy?: boolean; error?: string | null }
async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

export function CloudProjectPicker({ onCancel, onSelect, busy = false, error }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(false);
  const [folderMode, setFolderMode] = useState(false);
  const [status, setStatus] = useState<GithubProjectStatus | null>(null);
  const [repositories, setRepositories] = useState<GithubRepository[]>([]);
  const [search, setSearch] = useState("");
  const [repository, setRepository] = useState("");
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [limit, setLimit] = useState(50);
  const waiting = status?.device?.state === "pending";
  const working = busy || opening;
  const refresh = useCallback(async () => {
    setLoading(true); setLocalError(null);
    try {
      const next = await request<GithubProjectStatus>("/api/github/projects");
      setStatus(next);
      if (next.connected) setRepositories((await request<{ repositories: GithubRepository[] }>("/api/github/projects?view=repositories")).repositories);
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { setMounted(true); void refresh(); }, [refresh]);
  useEffect(() => {
    if (!mounted || folderMode) return;
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, [mounted, folderMode]);
  useEffect(() => {
    if (!waiting || folderMode) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      try {
        const next = await request<GithubProjectStatus>("/api/github/projects");
        if (cancelled) return;
        setStatus(next);
        if (next.connected) { await refresh(); return; }
        if (next.device?.state !== "pending") return;
      } catch (cause) {
        if (!cancelled) setLocalError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      if (!cancelled) timer = window.setTimeout(poll, 3000);
    };
    timer = window.setTimeout(poll, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [waiting, folderMode, refresh]);

  async function connect() {
    setConnecting(true); setLocalError(null);
    try {
      const { device } = await request<{ device: GithubLogin }>("/api/github/projects", { action: "login" });
      setStatus({ connected: false, login: null, device });
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setConnecting(false); }
  }
  async function open(event: FormEvent) {
    event.preventDefault();
    if (!repository.trim() || working) return;
    setOpening(true); setLocalError(null);
    try {
      const { cwd } = await request<{ cwd: string }>("/api/github/projects", { action: "open", repository });
      onSelect(cwd);
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setOpening(false); }
  }
  if (!mounted) return null;
  if (folderMode) return <DirectoryPicker onCancel={() => setFolderMode(false)} onSelect={onSelect} busy={busy} error={error} />;
  const filtered = repositories.filter((repo) => `${repo.fullName} ${repo.description ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const message = localError ?? error ?? status?.device?.error;

  return createPortal(
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="cloud-project-title" onCancel={(event) => { event.preventDefault(); if (!working) onCancel(); }}>
      <form onSubmit={open} className={styles.form}>
        <header className={styles.header}>
          <h2 id="cloud-project-title">{t("cloudProjects.title")}</h2>
          <p>{t("cloudProjects.description")}</p>
        </header>
        <div className={styles.sources}>
          <span className={styles.activeSource}>{t("cloudProjects.github")}</span>
          <button type="button" onClick={() => setFolderMode(true)} disabled={working}>{t("cloudProjects.serverFolder")}</button>
        </div>
        <div className={styles.body}>
          <section className={styles.account} aria-label={t("cloudProjects.account")}>
            <div>
              <strong>{status?.connected ? status.login : t("cloudProjects.connectTitle")}</strong>
              <p>{status?.connected ? t("cloudProjects.connected") : t("cloudProjects.connectHelp")}</p>
            </div>
            {status?.connected
              ? <button type="button" className={styles.secondary} onClick={() => void refresh()} disabled={loading || working}>{t("cloudProjects.refresh")}</button>
              : <button type="button" className={styles.secondary} onClick={() => void connect()} disabled={loading || connecting || waiting || working}>{connecting || waiting ? t("cloudProjects.waiting") : t("cloudProjects.connect")}</button>}
          </section>
          {waiting && <div className={styles.login} role="status">
            <p>{t("cloudProjects.deviceHelp")}</p>
            {status.device?.code ? <>
              <div className={styles.codeRow}><code>{status.device.code}</code><button type="button" className={styles.secondary} onClick={() => {
                void navigator.clipboard.writeText(status.device!.code!).then(() => setCopied(true)).catch(() => setLocalError(t("cloudProjects.copyFailure")));
              }}>{copied ? t("cloudProjects.copied") : t("cloudProjects.copyCode")}</button></div>
              <a href="https://github.com/login/device" target="_blank" rel="noreferrer" className={styles.loginLink}>{t("cloudProjects.openLogin")}</a>
              <small>{t("cloudProjects.permissionHelp")}</small>
            </> : <p>{t("cloudProjects.preparingCode")}</p>}
          </div>}
          {status?.connected && <section className={styles.repositories} aria-label={t("cloudProjects.repositories")}>
            <label htmlFor="cloud-repo-search">{t("cloudProjects.search")}</label>
            <input id="cloud-repo-search" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(50); }} placeholder={t("cloudProjects.searchPlaceholder")} type="search" disabled={working} />
            {loading ? <p role="status">{t("cloudProjects.loading")}</p> : <>
              <ul className={styles.list}>{filtered.slice(0, limit).map((repo) => <li key={repo.fullName}>
                <button type="button" className={styles.repo} aria-pressed={repository === repo.fullName} disabled={working} onClick={() => setRepository(repo.fullName)}>
                  <span className={styles.repoHeading}><strong>{repo.fullName}</strong><small>{repo.private ? t("cloudProjects.private") : t("cloudProjects.public")}</small></span>
                  {repo.description && <span className={styles.repoDescription}>{repo.description}</span>}
                </button>
              </li>)}</ul>
              {!filtered.length && <p>{t("cloudProjects.empty")}</p>}
              {filtered.length > limit && <button type="button" className={styles.secondary} onClick={() => setLimit((count) => count + 50)}>{t("cloudProjects.more")}</button>}
            </>}
          </section>}
          <div className={styles.repositoryInput}>
            <label htmlFor="cloud-repository">{t("cloudProjects.urlLabel")}</label>
            <input id="cloud-repository" value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="owner/repository" autoComplete="off" spellCheck={false} disabled={working} aria-describedby="cloud-repo-help" />
            <small id="cloud-repo-help">{t("cloudProjects.publicHelp")}</small>
          </div>
          {message && <div className={styles.error} role="alert"><strong>{t("cloudProjects.error")}</strong><p>{message}</p><button type="button" className={styles.secondary} onClick={() => void refresh()} disabled={working}>{t("cloudProjects.refresh")}</button></div>}
          {opening && <p role="status" className={styles.progress}>{t("cloudProjects.openingHelp")}</p>}
        </div>
        <footer className={styles.footer}>
          <button type="button" className={styles.secondary} onClick={onCancel} disabled={working}>{t("i18n.cancel")}</button>
          <button type="submit" className={styles.primary} disabled={working || !repository.trim()}>{working ? t("cloudProjects.opening") : t("cloudProjects.open")}</button>
        </footer>
      </form>
    </dialog>, document.body,
  );
}
