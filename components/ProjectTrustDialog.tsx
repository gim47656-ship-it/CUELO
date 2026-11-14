"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import shared from "./SettingsConfig.module.css";

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

  const buttonStyle = { height: 32, padding: "0 12px" } as const;

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
        background: "var(--scrim)",
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
        className={shared.panel}
        style={{
          width: 440,
          maxWidth: "100%",
          boxShadow: "var(--shadow-float)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", gap: 12, padding: "18px 18px 14px" }}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--warning)"
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
                borderRadius: "var(--radius-control)",
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
              <div role="alert" style={{ marginTop: 10, color: "var(--danger)", fontSize: 12, lineHeight: 1.5 }}>
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
            padding: "10px 18px 14px",
          }}
        >
          {scheduled && (
            <button
              type="button"
              onClick={onCancelSchedule}
              disabled={busy}
              className={shared.btn}
              style={buttonStyle}
            >
              {t("trust.cancelSchedule")}
            </button>
          )}
          <button
            ref={dismissRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className={shared.btn}
            style={buttonStyle}
          >
            {scheduled ? t("trust.close") : t("trust.cancel")}
          </button>
          {!scheduled && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className={shared.btnPrimary}
              style={{ ...buttonStyle, cursor: busy ? "wait" : "pointer" }}
            >
              {busy ? t("trust.trusting") : t("trust.trustProject")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
