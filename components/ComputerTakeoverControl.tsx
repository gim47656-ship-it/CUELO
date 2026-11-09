"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton } from "@seed-design/react";
import { useI18n } from "@/hooks/useI18n";
import styles from "./ComputerTakeoverControl.module.css";

interface TakeoverState {
  enabled: boolean;
  available: boolean;
}

interface TakeoverStateResponse {
  running?: boolean;
  state?: { computerTakeover?: { enabled?: boolean; available?: boolean } | null };
}

/**
 * Lets the user allow screen takeover for this one session (server: lib/computer-takeover.ts).
 * Offered only while the configured value is `refuse`; while allowed it stays visible in the session
 * header and one click turns it off. `refreshKey` changes whenever the session may have started or
 * stopped, so a session that just came up (or was unloaded) is read again.
 */
export function ComputerTakeoverControl({
  sessionId,
  refreshKey,
  compact,
}: {
  sessionId: string | null;
  refreshKey: string;
  compact: boolean;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState<{ sessionId: string; state: TakeoverState } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentRef = useRef(sessionId);
  currentRef.current = sessionId;
  // Bumped by every state read and when a toggle answers: a read that started before the toggle's answer
  // arrived is discarded, and the toggle's answer (the server state it just set) is always shown.
  const generationRef = useRef(0);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const generation = ++generationRef.current;
    void fetch(`/api/agent/${encodeURIComponent(sessionId)}`)
      .then((res) => res.json() as Promise<TakeoverStateResponse>)
      .then((body) => {
        if (cancelled || generation !== generationRef.current) return;
        const takeover = body.running ? body.state?.computerTakeover : null;
        setShown(
          takeover
            ? { sessionId, state: { enabled: takeover.enabled === true, available: takeover.available === true } }
            : null,
        );
        setError(null);
      })
      .catch(() => {
        // The next refresh reads it again; an unknown state shows nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  const toggle = useCallback(async (enabled: boolean) => {
    const target = currentRef.current;
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(target)}/computer-takeover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = await res.json() as { enabled?: boolean; error?: string; code?: string };
      if (!res.ok) {
        throw new Error(body.code === "shared_settings" ? t("computerTakeover.shared") : body.error ?? res.statusText);
      }
      if (currentRef.current === target) {
        // Invalidate this session's reads still in flight: they may predate this change. A toggle for a
        // session the user already left must not discard the current session's read.
        generationRef.current += 1;
        setShown({ sessionId: target, state: { enabled: body.enabled === true, available: body.enabled !== true } });
      }
    } catch (e) {
      if (currentRef.current === target) {
        setError(t("computerTakeover.failed", { error: e instanceof Error ? e.message : String(e) }));
      }
    } finally {
      setBusy(false);
    }
  }, [t]);

  const state = shown && shown.sessionId === sessionId ? shown.state : null;
  if (!state || (!state.enabled && !state.available)) return null;

  const active = state.enabled;
  const label = active ? t("computerTakeover.active") : t("computerTakeover.allow");
  const hint = error ?? (active ? t("computerTakeover.activeHint") : t("computerTakeover.allowHint"));
  return (
    <ActionButton
      className={`workspace-header-action workspace-takeover${active ? ` ${styles.active}` : ""}`}
      variant={active ? "neutralWeak" : "ghost"}
      size="small"
      type="button"
      disabled={busy}
      aria-pressed={active}
      aria-label={label}
      title={hint}
      onClick={() => void toggle(!active)}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 3l14 7-6 2-2 6-6-15Z" />
      </svg>
      {(active || !compact) && <span>{label}</span>}
    </ActionButton>
  );
}
