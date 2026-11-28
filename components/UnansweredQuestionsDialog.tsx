"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AskFormModel } from "@/lib/ask-form/types";
import type { UnansweredQuestion } from "@/lib/unanswered-questions";
import { AskForm } from "./AskForm";
import styles from "./UnansweredQuestionsDialog.module.css";

type Item = Omit<UnansweredQuestion, "html"> & { title: string };
const endpoint = "/api/agent/unanswered";

export function UnansweredQuestionsDialog({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<Item[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selected, select] = useState<string | null>(null);
  const [model, setModel] = useState<AskFormModel | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    void (async () => {
      try {
        const r = await fetch(selected ? `${endpoint}?id=${encodeURIComponent(selected)}` : endpoint, { signal: abort.signal, cache: "no-store" });
        if (!r.ok) {
          if (selected && r.status === 404) { select(null); return; }
          throw new Error();
        }
        const data = await r.json();
        if (!abort.signal.aborted) { if (selected) setModel(data); else setRows(data); }
      } catch { if (!abort.signal.aborted) setError("unanswered.error"); }
    })();
    return () => abort.abort();
  }, [selected, refresh]);

  async function submit(id: string, action: "reply" | "delete", data?: unknown) {
    if (busy) return;
    setBusy(id); setError(""); setNotice("");
    try {
      const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action, data }) });
      const result = await r.json();
      if (!r.ok && result.error !== "gone") {
        setError(result.error === "missing-session" ? "unanswered.missing" : result.error === "empty-answer" ? "chat.formError.required" : "unanswered.error");
        return;
      }
      setRows(previous => previous?.filter(q => q.id !== id) ?? null);
      setModel(null); select(null); setConfirmDelete(null);
      if (r.ok) setNotice(action === "reply" ? "unanswered.sent" : "unanswered.removed");
    } catch { setError("unanswered.error"); }
    finally { setBusy(null); }
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="unanswered-title" onCancel={onClose}>
    <header><h2 id="unanswered-title">{t("unanswered.title")}</h2><button type="button" onClick={onClose}>{t("chat.close")}</button></header>
    <p className={styles.hint}>{t("unanswered.hint")}</p>
    {error && <div role="alert">{t(error)} {error === "unanswered.error" && <button onClick={() => setRefresh(n => n + 1)}>{t("chat.transcribeRetry")}</button>}</div>}
    {notice && <p role="status">{t(notice)}</p>}
    {!rows && !error && <p role="status">{t("sidebar.loading")}</p>}
    {rows?.length === 0 && <p>{t("unanswered.empty")}</p>}
    <ul>{rows?.map(q => <li key={q.id}>
      <div className={styles.row}>
        <button type="button" className={styles.question} disabled={!!busy} aria-expanded={selected === q.id} onClick={() => {
          setModel(null); select(selected === q.id ? null : q.id); setConfirmDelete(null); setNotice("");
        }}>
          <strong>{q.title}</strong>
          <small title={q.cwd}>{q.cwd.split(/[\\/]/).filter(Boolean).at(-1)} / {new Date(q.createdAt).toLocaleString(locale)} / {t(`unanswered.${q.reason}`)}</small>
        </button>
        <button type="button" disabled={!!busy} onClick={() => confirmDelete === q.id ? void submit(q.id, "delete") : setConfirmDelete(q.id)}>{t(confirmDelete === q.id ? "savedPrompts.confirmDelete" : "sidebar.delete")}</button>
      </div>
      {selected === q.id && (model ? <AskForm key={q.id} request={{ type: "extension_ui_request", method: "form", id: q.id, form: model, background: true }} delivery={busy === q.id ? { id: q.id, status: "sending" } : null} onRespond={(_, response) => {
        if (busy) return;
        if ("value" in response) void submit(q.id, "reply", JSON.parse(response.value));
        else select(null);
      }} /> : !error && <p role="status">{t("sidebar.loading")}</p>)}
    </li>)}</ul>
  </dialog>;
}
