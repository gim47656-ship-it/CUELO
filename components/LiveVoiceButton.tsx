"use client";

import { useI18n } from "@/hooks/useI18n";
import { useLiveVoice, type LiveFailure } from "@/hooks/useLiveVoice";

/**
 * Composer control for a Codex live voice call.
 *
 * The call speaks with the same assistant the transcript belongs to: anything
 * the voice model cannot answer on its own is delegated to this session, and
 * the agent's answer is read back. Status is shown as text, not as a pulsing
 * dot, so it stays legible at a glance and to a screen reader.
 */

interface LiveVoiceButtonProps {
  sessionId: string | undefined;
  /**
   * Creates the session when the conversation has not been sent yet. Absent
   * when no session can be created at all, which is the only state that leaves
   * the control disabled.
   */
  onEnsureSession?: () => Promise<string | null>;
  onTranscriptPersisted?: (sessionId: string) => void | Promise<void>;
}

const FAILURE_KEYS: Record<LiveFailure, string> = {
  unsupported: "chat.liveUnsupported",
  "mic-denied": "chat.liveMicDenied",
  "mic-unavailable": "chat.liveMicUnavailable",
  auth: "chat.liveAuthRequired",
  upstream: "chat.liveUpstreamFailed",
  failed: "chat.liveFailed",
};

const MIC_ICON = (
  <>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </>
);

const HANGUP_ICON = (
  <>
    <rect x="4" y="4" width="16" height="16" rx="3" />
  </>
);

export function LiveVoiceButton({ sessionId, onEnsureSession, onTranscriptPersisted }: LiveVoiceButtonProps) {
  const { t } = useI18n();
  const live = useLiveVoice(sessionId, onEnsureSession, onTranscriptPersisted);

  const active = live.state === "connecting" || live.state === "live" || live.state === "working";
  const statusKey = live.state === "connecting"
    ? "chat.liveConnecting"
    : live.state === "working"
      ? "chat.liveWorking"
      : live.state === "live"
        ? "chat.liveOn"
        : null;
  const label = active ? t("chat.liveStop") : t("chat.liveStart");
  // `supported` is null until the browser check runs, and claiming the browser
  // cannot call before knowing would flash a red error on every first paint.
  const failureKey = live.supported === false
    ? FAILURE_KEYS.unsupported
    : live.failure ? FAILURE_KEYS[live.failure] : null;
  // A call speaks as one session's agent, so an unsent conversation gets its
  // session created on click. Only a surface that cannot create one — no open
  // session and no folder chosen yet — leaves the control disabled, and then it
  // says why instead of vanishing from the composer.
  const canCall = Boolean(sessionId || onEnsureSession);
  const hintKey = canCall ? null : "chat.liveNeedsSession";

  return (
    <div role="group" aria-label={t("chat.liveVoice")} style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {failureKey && (
        <span
          role="status"
          style={{
            fontSize: 11,
            color: "var(--danger)",
            maxWidth: 220,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={live.detail ?? undefined}
        >
          {t(failureKey)}
        </span>
      )}
      {statusKey && (
        <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
          {t(statusKey)}
        </span>
      )}
      <button
        type="button"
        className={`composer-icon-button${active ? " is-active" : ""}`}
        onClick={live.toggle}
        disabled={!live.supported || !canCall}
        aria-pressed={active}
        title={hintKey ? t(hintKey) : label}
        aria-label={hintKey ? t(hintKey) : label}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {active ? HANGUP_ICON : MIC_ICON}
        </svg>
      </button>
    </div>
  );
}
