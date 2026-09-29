"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ProjectTrustAction, ProjectTrustEntry } from "@/lib/api-types";
import styles from "./SettingsConfig.module.css";

/**
 * Trust decisions per project, from the settings dialog.
 *
 * Each row keeps the stored approval (what new sessions load) apart from what
 * live sessions actually run, because a change made while a session works is
 * applied only when the project's sessions are idle. Granting and revoking both
 * go through an inline confirmation; there is no "trust everything" control.
 */

type Confirmation = { cwd: string; action: Exclude<ProjectTrustAction, "cancel">; again: boolean };

const PENDING_REFRESH_MS = 2_500;

function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

export function ProjectTrustSettings({ cwd }: { cwd?: string | null }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<ProjectTrustEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [busyCwd, setBusyCwd] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ cwd: string; text: string } | null>(null);
  // 확인 단계를 닫거나 요청이 끝나 버튼이 바뀐 뒤에도 키보드 위치가 그 행에 남게 한다.
  const [focusCwd, setFocusCwd] = useState<string | null>(null);
  const rowControls = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!focusCwd || busyCwd === focusCwd) return;
    rowControls.current.get(focusCwd)?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    setFocusCwd(null);
  }, [busyCwd, entries, focusCwd]);

  // 요청 세대: 새 조회·변경 요청이 시작되면 늘어나, 늦게 도착한 앞선 조회가 최신 결과를 덮지 못한다.
  const generation = useRef(0);
  const listRequest = useRef<AbortController | null>(null);
  const entriesRef = useRef<ProjectTrustEntry[] | null>(null);
  // 변경 요청은 한 번에 하나만 보내고 그 동안에는 조회도 시작하지 않는다.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState !== "visible") return;
    const mine = ++generation.current;
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    try {
      const query = cwd ? `?include=${encodeURIComponent(cwd)}` : "";
      const response = await fetch(`/api/project-trust${query}`, { cache: "no-store", signal: controller.signal });
      const data = await response.json() as { projects?: ProjectTrustEntry[]; error?: string };
      if (mine !== generation.current || controller.signal.aborted) return;
      if (!response.ok || !data.projects) throw new Error(data.error ?? `HTTP ${response.status}`);
      // 예약이 서버에서 적용된 행은 여기서 처음 알게 되므로 그 사실을 행에 알린다.
      const applied = data.projects.find((entry) => entry.pending === null && !entry.error
        && entriesRef.current?.some((before) => before.cwd === entry.cwd
          && (before.pending === "grant" ? entry.trusted : before.pending === "revoke" && !entry.trusted)));
      entriesRef.current = data.projects;
      setEntries(data.projects);
      setLoadError(null);
      if (applied) setNotice({ cwd: applied.cwd, text: t("trust.doneApplied") });
    } catch (caught) {
      if (mine !== generation.current || controller.signal.aborted) return;
      setLoadError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (listRequest.current === controller) listRequest.current = null;
    }
  }, [cwd, t]);

  useEffect(() => {
    void load();
    return () => {
      listRequest.current?.abort();
    };
  }, [load]);

  // 서버 적용은 타이머 없이 실행 상태 전이로 일어나지만 이 화면은 그 전이를 듣지 못한다.
  // 그래서 대기 항목이 있고 탭이 보이는 동안에만 다시 읽고, 대기가 끝나거나 숨겨지거나
  // 설정창이 닫히면 바로 멈춘다.
  const hasPending = entries?.some((entry) => entry.pending !== null) ?? false;
  useEffect(() => {
    if (!hasPending || busyCwd !== null || confirming !== null) return;
    // 조회가 끝나 entries가 바뀔 때마다 이 effect가 다시 걸려 다음 한 번만 예약한다.
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = document.visibilityState === "visible" ? window.setTimeout(() => void load(), PENDING_REFRESH_MS) : undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
      else {
        schedule();
        ++generation.current;
        listRequest.current?.abort();
      }
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [busyCwd, confirming, entries, hasPending, load]);


  const send = useCallback(async (target: string, action: ProjectTrustAction) => {
    if (inFlight.current) return;
    inFlight.current = true;
    ++generation.current;
    listRequest.current?.abort();
    setBusyCwd(target);
    setConfirming(null);
    setFocusCwd(target);
    setNotice(null);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[target];
      return next;
    });
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: target, action }),
      });
      const data = await response.json() as ProjectTrustEntry & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      const next = entriesRef.current?.map((entry) => (entry.cwd === target ? { ...data, cwd: target } : entry)) ?? null;
      entriesRef.current = next;
      setEntries(next);
      // 대기가 남으면 그 행의 대기 문구가 상태를 말한다. 완료처럼 들리는 알림은 적용됐을 때만 쓴다.
      if (action === "cancel") setNotice({ cwd: target, text: t("trust.doneCancelled") });
      else if (!data.error && data.pending === null) setNotice({ cwd: target, text: t("trust.doneApplied") });
    } catch (caught) {
      setRowErrors((current) => ({ ...current, [target]: caught instanceof Error ? caught.message : String(caught) }));
    } finally {
      inFlight.current = false;
      setBusyCwd(null);
    }
  }, [t]);

  if (!entries) {
    return (
      <div className={styles.empty}>
        {loadError ? t("trust.loadFailed", { error: loadError }) : "…"}
        {loadError && <button type="button" className={styles.linkButton} onClick={() => void load()}>{t("trust.refresh")}</button>}
      </div>
    );
  }

  const locked = busyCwd !== null;

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>{t("trust.settingsNav")}</h2>
        <p className={styles.contentDescription}>{t("trust.settingsDescription")}</p>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 12 }}>
          <button
            type="button"
            className={styles.linkButton}
            style={{ background: "transparent", cursor: "pointer" }}
            disabled={locked}
            onClick={() => void load()}
          >
            {t("trust.refresh")}
          </button>
          {loadError && <div className={styles.error} role="alert">{t("trust.loadFailed", { error: loadError })}</div>}
        </div>
      </header>
      <div className={styles.settingsBody}>
        <section className={styles.group}>
          {entries.length === 0 && <div className={styles.settingDescription}>{t("trust.settingsEmpty")}</div>}
          {entries.map((entry) => {
            const busy = busyCwd === entry.cwd;
            const confirm = confirming?.cwd === entry.cwd ? confirming : null;
            const stateLabel = !entry.requiresTrust
              ? t("trust.stateNotRequired")
              : entry.trusted ? t("trust.stateTrusted") : t("trust.stateRestricted");
            const error = rowErrors[entry.cwd] ?? (entry.error ? t("trust.applyFailed", { error: entry.error }) : null);
            return (
              <div key={entry.cwd} className={styles.settingRow}>
                <div style={{ minWidth: 0 }}>
                  <div className={styles.settingLabel} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span className={styles.statusDot} data-off={!entry.trusted || !entry.requiresTrust} aria-hidden="true" />
                    <span>{projectName(entry.cwd)}</span>
                    <span className={styles.settingDescription} style={{ fontWeight: 600 }}>{stateLabel}</span>
                  </div>
                  <code className={styles.settingDescription} style={{ display: "block", overflowWrap: "anywhere" }}>
                    {entry.cwd}
                  </code>
                  <div className={styles.saveState}>
                    {t("trust.runtime", {
                      sessions: entry.runtime.sessions,
                      running: entry.runtime.running,
                      loaded: entry.requiresTrust ? entry.runtime.projectCodeLoaded : 0,
                    })}
                  </div>
                  <div aria-live="polite">
                    {entry.pending === "grant" && <div className={styles.settingDescription}>{t("trust.pendingGrant")}</div>}
                    {entry.pending === "revoke" && (
                      <div className={styles.settingDescription}>
                        {t("trust.pendingRevoke", { count: entry.runtime.projectCodeLoaded })}
                      </div>
                    )}
                    {confirm && (
                      <div className={styles.settingDescription} style={{ color: "var(--text)" }}>
                        {confirm.action === "revoke"
                          ? t("trust.confirmRevoke")
                          : confirm.again ? t("trust.confirmTrustAgain") : t("trust.confirmGrant")}
                      </div>
                    )}
                    {notice?.cwd === entry.cwd && <div className={styles.saveState}>{notice.text}</div>}
                  </div>
                  {error && <div className={styles.error} role="alert">{error}</div>}
                </div>
                <div
                  ref={(node) => {
                    if (node) rowControls.current.set(entry.cwd, node);
                    else rowControls.current.delete(entry.cwd);
                  }}
                  className={styles.settingControl}
                  style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}
                >
                  {confirm ? (
                    <>
                      <button
                        type="button"
                        className={styles.linkButton}
                        style={{ background: "transparent", cursor: "pointer" }}
                        autoFocus
                        onClick={() => {
                          setConfirming(null);
                          setFocusCwd(entry.cwd);
                        }}
                      >
                        {t("trust.cancel")}
                      </button>
                      <button
                        type="button"
                        className={confirm.action === "revoke" ? styles.dangerButton : styles.primaryButton}
                        disabled={locked}
                        onClick={() => void send(entry.cwd, confirm.action)}
                      >
                        {confirm.action === "revoke" ? t("trust.revoke") : t("trust.confirm")}
                      </button>
                    </>
                  ) : busy ? (
                    <button type="button" className={styles.primaryButton} disabled>{t("trust.working")}</button>
                  ) : (
                    <>
                      {entry.pending === "grant" && (
                        <button
                          type="button"
                          className={styles.linkButton}
                          style={{ background: "transparent", cursor: "pointer" }}
                          disabled={locked}
                          onClick={() => void send(entry.cwd, "cancel")}
                        >
                          {t("trust.cancelSchedule")}
                        </button>
                      )}
                      {entry.requiresTrust && !entry.trusted && entry.pending !== "grant" && (
                        <button
                          type="button"
                          className={styles.primaryButton}
                          disabled={locked}
                          onClick={() => setConfirming({ cwd: entry.cwd, action: "grant", again: entry.pending === "revoke" })}
                        >
                          {entry.pending === "revoke" ? t("trust.trustAgain") : t("trust.trustProject")}
                        </button>
                      )}
                      {entry.trusted && (
                        <button
                          type="button"
                          className={styles.dangerButton}
                          disabled={locked}
                          onClick={() => setConfirming({ cwd: entry.cwd, action: "revoke", again: false })}
                        >
                          {t("trust.revoke")}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
