"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { fillPromptTemplate, type SavedPrompt, type SavedPromptToken } from "@/lib/saved-prompts";

export interface SavedPromptMenuHandle {
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

interface Props {
  value: string;
  token: SavedPromptToken;
  cwd?: string | null;
  sessionTitle?: string | null;
  style: CSSProperties;
  maxHeight: number;
  onReplace: (expected: string, next: string, cursor: number, saved?: boolean) => void;
  onClose: () => void;
}

async function promptRequest(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export const SavedPromptMenu = forwardRef<SavedPromptMenuHandle, Props>(function SavedPromptMenu({
  value, token, cwd, sessionTitle, style, maxHeight, onReplace, onClose,
}, ref) {
  const { t } = useI18n();
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const query = token.query.toLowerCase();
  const matches = prompts.filter((prompt) => `${prompt.title}\n${prompt.body}`.toLowerCase().includes(query));
  const outside = value.slice(0, token.start) + value.slice(token.end);
  const canSave = Boolean(outside.trim());
  const rowCount = matches.length + (canSave ? 1 : 0);
  const load = useCallback(async () => {
    const data = await promptRequest("/api/saved-prompts");
    setPrompts(data.prompts);
  }, []);

  useEffect(() => {
    let disposed = false;
    promptRequest("/api/saved-prompts")
      .then((data) => { if (!disposed) setPrompts(data.prompts); })
      .catch((reason) => { if (!disposed) setError(String(reason.message ?? reason)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    // Saving must always be an explicit selection, never the fallback for Enter.
    setActiveIndex(matches.length > 0 ? 0 : -1);
    setConfirmId(null);
  }, [query, prompts, matches.length, canSave]);

  useEffect(() => {
    rowRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const insert = (prompt: SavedPrompt) => {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const body = fillPromptTemplate(prompt.body, {
      project_name: cwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop(),
      cwd, session_name: sessionTitle, date,
    });
    onReplace(value, value.slice(0, token.start) + body + value.slice(token.end), token.start + body.length);
  };

  const save = async () => {
    if (busy || !canSave) return;
    setBusy(true);
    setError(null);
    try {
      await promptRequest("/api/saved-prompts", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: outside }),
      });
      // Commit the successful mutation before refreshing the list: a GET error
      // must not leave the token in place and invite a duplicate POST.
      onReplace(value, outside, token.start, true);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (busy) return;
    if (confirmId !== id) { setConfirmId(id); return; }
    setBusy(true);
    setError(null);
    try {
      await promptRequest(`/api/saved-prompts/${encodeURIComponent(id)}`, { method: "DELETE" });
      setPrompts((current) => current.filter((prompt) => prompt.id !== id));
      setConfirmId(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  useImperativeHandle(ref, () => ({
    handleKeyDown(event) {
      if (event.key === "Escape") { onClose(); event.preventDefault(); return true; }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rowCount > 0) {
        event.preventDefault();
        setActiveIndex((index) => event.key === "ArrowDown"
          ? Math.min(rowCount - 1, index + 1) : (index < 0 ? rowCount - 1 : Math.max(0, index - 1)));
        return true;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        if (activeIndex >= 0 && activeIndex < rowCount) {
          event.preventDefault();
          if (!busy) {
            if (matches[activeIndex]) insert(matches[activeIndex]);
            else void save();
          }
          return true;
        }
        // No match: preserve ordinary send/follow-up, including pasted //code.
        if (event.key === "Enter") onClose();
      }
      return false;
    },
  }));

  const rowStyle = (active: boolean): CSSProperties => ({
    width: "100%", minWidth: 0, minHeight: 44, borderRadius: "var(--radius-control)",
    padding: "8px", background: active ? "var(--bg-selected)" : "none", color: "var(--text)",
    textAlign: "left", cursor: "pointer", fontSize: 12,
  });

  return (
    <div id="saved-prompt-menu" role="region" aria-label={t("savedPrompts.title")} data-saved-prompt-menu=""
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
      style={{ position: "absolute", left: 0, right: 0, zIndex: 120, background: "var(--bg)",
        borderRadius: "var(--radius-surface)", boxShadow: "var(--shadow-float)",
        display: "flex", flexDirection: "column", overflow: "hidden", maxHeight, ...style }}>
      <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
        {loading ? t("savedPrompts.loading") : t("savedPrompts.title")}
      </div>
      <div style={{ overflowY: "auto", minHeight: 0, padding: 4 }}>
        {!loading && matches.length === 0 && <div style={{ padding: 8, fontSize: 12, color: "var(--text-dim)" }}>{t("savedPrompts.empty")}</div>}
        {matches.map((prompt, index) => (
          <div key={prompt.id} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <button type="button" ref={(node) => { rowRefs.current[index] = node; }} disabled={busy}
              data-saved-prompt-id={prompt.id} onClick={() => insert(prompt)} onMouseEnter={() => setActiveIndex(index)}
              style={rowStyle(index === activeIndex)}>
              <span style={{ display: "block", overflowWrap: "anywhere" }}>{prompt.title}</span>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 11 }}>
                {prompt.body.replace(/\s+/g, " ")}
              </span>
            </button>
            <button type="button" disabled={busy} data-delete-prompt={prompt.id} aria-label={`${t("savedPrompts.delete")}: ${prompt.title}`}
              onClick={() => void remove(prompt.id)} style={{ ...rowStyle(false), width: "auto", flexShrink: 0, color: "var(--danger, var(--text))" }}>
              {t(confirmId === prompt.id ? "savedPrompts.confirmDelete" : "savedPrompts.delete")}
            </button>
            {confirmId === prompt.id && <button type="button" onClick={() => setConfirmId(null)} style={{ ...rowStyle(false), width: "auto", flexShrink: 0 }}>{t("savedPrompts.cancel")}</button>}
          </div>
        ))}
        {canSave && <button type="button" data-save-current-prompt="" disabled={busy || loading}
          ref={(node) => { rowRefs.current[matches.length] = node; }} onClick={() => void save()}
          onMouseEnter={() => setActiveIndex(matches.length)} style={rowStyle(activeIndex === matches.length)}>
          {t("savedPrompts.save")}
        </button>}
      </div>
      {error && <div role="alert" style={{ padding: "6px 10px", fontSize: 12, color: "var(--danger, var(--text))", overflowWrap: "anywhere" }}>{t("savedPrompts.error", { error })}</div>}
      <div style={{ padding: "6px 10px", fontSize: 10, color: "var(--text-dim)", overflowWrap: "anywhere", overflowY: "auto", flexShrink: 0, maxHeight: "40%" }}>
        {t("savedPrompts.hint")}
      </div>
    </div>
  );
});
