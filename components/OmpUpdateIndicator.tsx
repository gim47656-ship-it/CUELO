"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { copyText } from "@/lib/clipboard";
import type { CueloUpdateResponse } from "@/lib/api-types";
import { computePopupPlacement, preferredPopupHeight } from "@/lib/popup-placement";
import { MarkdownBody } from "./MarkdownBody";

type LoadState = "idle" | "loading" | "ready";

/** 소스 체크아웃에서 수동으로 갱신할 때 안내하는 명령. */
const SOURCE_UPDATE_COMMAND = "git pull && bun install && bun run build && node Tools/CUELO_Setup/files/native-runtime-patch.js --target .";

function displayVersion(version: string): string {
  return version === "unknown" ? version : `v${version}`;
}

export function OmpUpdateIndicator() {
  const { locale, t } = useI18n();
  const isMobile = useIsMobile();
  const [status, setStatus] = useState<CueloUpdateResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [panelPosition, setPanelPosition] = useState<{ left: number; width: number; maxHeight: number; top?: number; bottom?: number } | null>(null);

  const updatePanelPosition = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const { side, maxHeight } = computePopupPlacement(
      rect.top,
      rect.bottom,
      viewportHeight,
      preferredPopupHeight(viewportHeight, 0.72, 620),
      { margin: 12, minHeight: 0 },
    );
    const width = Math.min(430, window.innerWidth - 24);
    const maxLeft = Math.max(12, window.innerWidth - width - 12);
    setPanelPosition({
      left: Math.min(rect.right + 8, maxLeft),
      width,
      maxHeight,
      ...(side === "above"
        ? { bottom: viewportHeight - rect.top + 8 }
        : { top: rect.bottom + 8 }),
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setPanelPosition(null);
      return;
    }
    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    window.visualViewport?.addEventListener("resize", updatePanelPosition);
    window.visualViewport?.addEventListener("scroll", updatePanelPosition);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
      window.visualViewport?.removeEventListener("resize", updatePanelPosition);
      window.visualViewport?.removeEventListener("scroll", updatePanelPosition);
    };
  }, [open, updatePanelPosition]);


  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    try {
      const response = await fetch("/api/updates", { cache: "no-store", signal });
      if (!response.ok) return;
      const next = await response.json() as CueloUpdateResponse;
      setStatus(next);
      setLoadState("ready");
    } catch {
      if (!signal?.aborted) setLoadState("ready");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus]);

  useEffect(() => () => {
    clearTimeout(copiedTimerRef.current ?? undefined);
    copiedTimerRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (loadState !== "ready" || !status?.updateAvailable || !status.latestRelease) return null;

  const release = status.latestRelease;
  const releaseDate = release.publishedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(release.publishedAt))
    : null;
  const changelog = release.body.trim() || release.name;
  const copyCommand = async (command: string) => {
    try {
      await copyText(command);
      clearTimeout(copiedTimerRef.current ?? undefined);
      setCopiedCommand(command);
      copiedTimerRef.current = setTimeout(() => setCopiedCommand(null), 1600);
    } catch {
      setMessage(t("updates.copyFailed"));
    }
  };

  return (
    <div ref={rootRef} data-dismissible-layer={open ? "" : undefined} style={{ position: "relative", width: "100%" }}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((value) => !value);
          setMessage(null);
        }}
        title={t("updates.availableTitle", { version: displayVersion(release.version) })}
        style={{
          width: "100%",
          minHeight: isMobile ? 44 : 34,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "7px 10px",
          border: "1px solid color-mix(in srgb, var(--warning) 54%, var(--border))",
          borderRadius: 9,
          background: "color-mix(in srgb, var(--warning) 8%, transparent)",
          color: "var(--warning)",
          cursor: "pointer",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          transition: "background 0.12s, border-color 0.12s, color 0.12s",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = "color-mix(in srgb, var(--warning) 14%, var(--bg-hover))";
          event.currentTarget.style.borderColor = "var(--warning)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = "color-mix(in srgb, var(--warning) 8%, transparent)";
          event.currentTarget.style.borderColor = "color-mix(in srgb, var(--warning) 54%, var(--border))";
        }}
      >
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warning)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--warning) 14%, transparent)" }} />
        <span>{t("updates.available")}</span>
        <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{displayVersion(release.version)}</span>
      </button>

      {open && panelPosition && createPortal(
        <div
          ref={panelRef}
          data-dismissible-layer=""
          role="dialog"
          aria-label={t("updates.dialogTitle")}
          style={{
            position: "fixed",
            left: panelPosition.left,
            top: panelPosition.top,
            bottom: panelPosition.bottom,
            zIndex: 700,
            width: panelPosition.width,
            maxHeight: panelPosition.maxHeight,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg-panel)",
            boxShadow: "0 18px 46px rgba(0,0,0,0.28)",
          }}
        >
          <div style={{ padding: "13px 14px 11px", borderBottom: "1px solid var(--border)", background: "linear-gradient(135deg, color-mix(in srgb, var(--warning) 10%, var(--bg-panel)), var(--bg-panel) 65%)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ color: "var(--text-dim)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>{t("updates.dialogEyebrow")}</div>
                <div style={{ marginTop: 3, color: "var(--text)", fontSize: 15, fontWeight: 650 }}>{t("updates.dialogTitle")}</div>
              </div>
              <div style={{ color: "var(--warning)", fontFamily: "var(--font-mono)", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{displayVersion(release.version)}</div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 9, color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              <span>{t("updates.current", { version: displayVersion(status.currentAppVersion) })}</span>
              {releaseDate && <span>{releaseDate}</span>}
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "11px 14px 14px" }}>
            <div style={{ marginBottom: 7, color: "var(--text-dim)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>{t("updates.changelog")}</div>
            <div className="update-changelog" style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 }}>
              <MarkdownBody>{changelog}</MarkdownBody>
            </div>

          </div>

          <div style={{ flexShrink: 0, padding: "10px 14px 12px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
              <a
                href={release.htmlUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)", fontSize: 11, textDecoration: "underline", textUnderlineOffset: 3 }}
              >
                {t("updates.viewRelease")}
              </a>
            </div>

            <div style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
              <div style={{ marginBottom: 7, color: "var(--text-dim)" }}>{t("updates.manual")}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, marginTop: 6, padding: "6px 7px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", fontFamily: "var(--font-mono)" }}>
                <code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", color: "var(--text)" }}>{SOURCE_UPDATE_COMMAND}</code>
                <button
                  type="button"
                  onClick={() => void copyCommand(SOURCE_UPDATE_COMMAND)}
                  title={copiedCommand === SOURCE_UPDATE_COMMAND ? t("updates.commandCopied") : t("updates.copyCommand")}
                  aria-label={copiedCommand === SOURCE_UPDATE_COMMAND ? t("updates.commandCopied") : t("updates.copyCommand")}
                  style={{ flex: "0 0 auto", width: isMobile ? 44 : 24, height: isMobile ? 44 : 24, padding: 0, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", color: copiedCommand === SOURCE_UPDATE_COMMAND ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
                >
                  {copiedCommand === SOURCE_UPDATE_COMMAND ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            {message && (
              <div role="alert" style={{ marginTop: 9, color: "var(--danger)", fontSize: 11, lineHeight: 1.45 }}>
                {message}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
