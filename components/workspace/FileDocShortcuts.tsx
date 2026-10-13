"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ProjectDocEntry, ProjectDocShortcuts } from "@/lib/project-docs";

type LoadState =
  | { kind: "ready"; cwd: string; docs: ProjectDocShortcuts }
  | { kind: "denied"; cwd: string }
  | { kind: "error"; cwd: string; message: string };

interface FileDocShortcutsProps {
  /** Work folder of the selected session or project; null when nothing is selected. */
  cwd: string | null;
  onOpenFile: (filePath: string) => void;
}

/**
 * Files empty state: shortcuts to the project's current state (HANDOFF.md), document map
 * (doc/README.md) and recent records, opened through the regular file tab flow.
 */
export function FileDocShortcuts({ cwd, onOpenFile }: FileDocShortcutsProps) {
  const { t } = useI18n();
  const [load, setLoad] = useState<LoadState | null>(null);

  useEffect(() => {
    if (!cwd) return;
    const controller = new AbortController();
    // No reset here: a result for another cwd is ignored below and reads as loading.
    fetch(`/api/project-docs?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as ProjectDocShortcuts & { error?: string };
        if (controller.signal.aborted) return;
        if (response.status === 403) setLoad({ kind: "denied", cwd });
        else if (!response.ok) setLoad({ kind: "error", cwd, message: data.error ?? `HTTP ${response.status}` });
        else setLoad({ kind: "ready", cwd, docs: data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: "error", cwd, message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [cwd]);

  // A response for a previous project never renders under the current one.
  const current = cwd && load?.cwd === cwd ? load : null;

  const renderEntry = (label: string, fileName: string, entry: ProjectDocEntry) => (
    <li className="file-doc-shortcuts-item">
      {entry.state === "found" && entry.path ? (
        <button
          type="button"
          className="file-doc-shortcuts-link"
          title={entry.path}
          aria-label={`${label} — ${entry.path}`}
          onClick={() => onOpenFile(entry.path as string)}
        >
          <span className="file-doc-shortcuts-label">{label}</span>
          <span className="file-doc-shortcuts-file">{fileName}</span>
        </button>
      ) : (
        <div className="file-doc-shortcuts-unavailable" title={entry.path ?? undefined}>
          <span className="file-doc-shortcuts-label">{label}</span>
          <span className="file-doc-shortcuts-file">
            {entry.state === "denied" ? t("files.docs.denied", { file: fileName }) : t("files.docs.missing", { file: fileName })}
          </span>
        </div>
      )}
    </li>
  );

  let body: React.ReactNode;
  if (!cwd) {
    body = <p className="file-doc-shortcuts-status">{t("files.docs.noProject")}</p>;
  } else if (!current) {
    body = <p className="file-doc-shortcuts-status" role="status">{t("files.docs.loading")}</p>;
  } else if (current.kind === "denied") {
    body = <p className="file-doc-shortcuts-status">{t("files.docs.projectDenied")}</p>;
  } else if (current.kind === "error") {
    body = <p className="file-doc-shortcuts-status" role="alert">{t("files.docs.loadFailed", { error: current.message })}</p>;
  } else {
    const { docs } = current;
    const nothingFound = docs.handoff.state === "missing"
      && docs.docMap.state === "missing"
      && docs.history.state === "missing";
    body = (
      <>
        <p className="file-doc-shortcuts-project" title={docs.projectDir}>
          {t("files.docs.projectDir", { path: docs.projectDir })}
        </p>
        {nothingFound ? (
          <p className="file-doc-shortcuts-status">{t("files.docs.noneFound")}</p>
        ) : (
          <>
            <ul className="file-doc-shortcuts-list">
              {renderEntry(t("files.docs.current"), "HANDOFF.md", docs.handoff)}
              {renderEntry(t("files.docs.map"), "doc/README.md", docs.docMap)}
            </ul>
            <h3 className="file-doc-shortcuts-heading" id="file-doc-shortcuts-records">{t("files.docs.records")}</h3>
            {docs.history.records.length > 0 ? (
              <ul className="file-doc-shortcuts-list" aria-labelledby="file-doc-shortcuts-records">
                {docs.history.records.map((record) => (
                  <li key={record.path} className="file-doc-shortcuts-item">
                    <button
                      type="button"
                      className="file-doc-shortcuts-link"
                      title={record.path}
                      aria-label={`${t("files.docs.records")} ${record.date} ${record.topic} — ${record.fileName}`}
                      onClick={() => onOpenFile(record.path)}
                    >
                      <span className="file-doc-shortcuts-date">{record.date}</span>
                      <span className="file-doc-shortcuts-file">
                        {record.topic}{record.fileName === "main.md" ? "" : ` · ${record.fileName}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="file-doc-shortcuts-status">
                {docs.history.state === "denied"
                  ? t("files.docs.denied", { file: "doc/history" })
                  : t("files.docs.missing", { file: "doc/history" })}
              </p>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <section className="file-doc-shortcuts" aria-labelledby="file-doc-shortcuts-title">
      <h2 className="file-doc-shortcuts-title" id="file-doc-shortcuts-title">{t("files.noneOpen")}</h2>
      {body}
    </section>
  );
}
