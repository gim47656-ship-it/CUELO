"use client";

import { useEffect, useState, type ReactNode } from "react";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** One line in the composer dock, shaped like the goal bar: a label and a sentence. */
function DockLine({ label, tone, children }: { label: string; tone: "accent"; children: ReactNode }) {
  return (
    <div className="run-status-line" data-tone={tone} role="status" aria-live="polite">
      <span className="run-status-label">{label}</span>
      <span className="run-status-text">{children}</span>
    </div>
  );
}

/** Triggers the SDK names on `auto_compaction_start`, plus the user's own `/compact`. */
const COMPACTION_REASONS: Record<string, true> = { manual: true, threshold: true, overflow: true, idle: true, incomplete: true };

/** Live compaction progress with the elapsed time and, when the event named it, the trigger. */
export function CompactionBanner({ compaction, t }: { compaction: { startedAt: number; reason: string | null } | null; t: Translate }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!compaction) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [compaction]);
  if (!compaction) return null;
  const seconds = Math.max(0, Math.floor((now - compaction.startedAt) / 1000));
  const reason = compaction.reason && COMPACTION_REASONS[compaction.reason] === true ? t(`chat.compactionReason.${compaction.reason}`) : null;
  return (
    <DockLine label={t("chat.compactionLabel")} tone="accent">
      {t("chat.compactionProgress", { seconds })}
      {reason ? ` · ${reason}` : ""}
    </DockLine>
  );
}

/** Shown under the last message of a session whose saved transcript stops mid-run. */
export function InterruptedRunNotice({ onDismiss, t }: { onDismiss: () => void; t: Translate }) {
  return (
    <div className="interrupted-run-notice" role="status">
      <span className="interrupted-run-mark" aria-hidden="true" />
      <span className="interrupted-run-text">
        <strong>{t("chat.interruptedTitle")}</strong>
        <span>{t("chat.interruptedDetail")}</span>
      </span>
      <button type="button" onClick={onDismiss} aria-label={t("chat.interruptedDismiss")} title={t("chat.interruptedDismiss")}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>
  );
}
