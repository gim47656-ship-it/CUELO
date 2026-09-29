"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * Confirms trusting the open project. When sessions in the project are still
 * working the server holds the approval instead of applying it, so the dialog
 * stays open in a `scheduled` state that says the project is still restricted
 * and offers to withdraw the held approval.
 */
export function ProjectTrustDialog({
  cwd,
  busy,
  scheduled,
  error,
  onCancel,
  onConfirm,
  onCancelSchedule,
}: {
  cwd: string;
  busy: boolean;
  scheduled: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onCancelSchedule: () => void;
}) {
  const { t } = useI18n();
  // The safe choice takes focus: closing, never confirming, is what Enter does first.
  const dismissRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    dismissRef.current?.focus();
  }, [scheduled]);

  const buttonStyle = {
    height: 32,
    padding: "0 12px",
    borderRadius: 5,
    cursor: busy ? "not-allowed" : "pointer",
    fontSize: 12,
  } as const;

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,0.4)",
      }}
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-trust-title"
        aria-describedby="project-trust-body"
        style={{
          width: 440,
          maxWidth: "100%",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-panel)",
          boxShadow: "0 12px 36px rgba(0,0,0,0.24)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", gap: 12, padding: "18px 18px 14px" }}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#f59e0b"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0, marginTop: 1 }}
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            {scheduled ? <path d="M12 8v4l2 2" /> : <path d="m9 12 2 2 4-4" />}
          </svg>
          <div style={{ minWidth: 0 }}>
            <div id="project-trust-title" style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              {scheduled ? t("trust.scheduledTitle") : t("trust.dialogTitle")}
            </div>
            <div
              id="project-trust-body"
              aria-live="polite"
              style={{ marginTop: 7, fontSize: 12, lineHeight: 1.6, color: "var(--text-muted)" }}
            >
              {scheduled ? t("trust.scheduledBody") : t("trust.dialogBody")}
            </div>
            <code
              style={{
                display: "block",
                marginTop: 10,
                padding: "8px 10px",
                border: "1px solid var(--border)",
                borderRadius: 5,
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                overflowWrap: "anywhere",
              }}
            >
              {cwd}
            </code>
            {error && (
              <div role="alert" style={{ marginTop: 10, color: "#ef4444", fontSize: 12, lineHeight: 1.5 }}>
                {error}
              </div>
            )}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
          }}
        >
          {scheduled && (
            <button
              type="button"
              onClick={onCancelSchedule}
              disabled={busy}
              style={{ ...buttonStyle, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)" }}
            >
              {t("trust.cancelSchedule")}
            </button>
          )}
          <button
            ref={dismissRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{ ...buttonStyle, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)" }}
          >
            {scheduled ? t("trust.close") : t("trust.cancel")}
          </button>
          {!scheduled && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              style={{
                ...buttonStyle,
                border: "1px solid transparent",
                background: "var(--seed-color-bg-neutral-inverted)",
                color: "var(--seed-color-fg-neutral-inverted)",
                cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.7 : 1,
                fontWeight: 600,
              }}
            >
              {busy ? t("trust.trusting") : t("trust.trustProject")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
