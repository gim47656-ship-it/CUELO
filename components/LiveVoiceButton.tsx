"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useLiveVoice, type LiveFailure } from "@/hooks/useLiveVoice";
import type { LiveCharacterVoiceSettings, LiveCharacterVoiceState, LiveVoiceMode } from "@/lib/live-types";

/**
 * Composer control for a Codex live voice call.
 *
 * The call speaks with the same assistant the transcript belongs to: anything
 * the voice model cannot answer on its own is delegated to this session, and
 * the agent's answer is read back. Status is shown as text, not as a pulsing
 * dot, so it stays legible at a glance and to a screen reader.
 *
 * With a Cartesia key and prepared voices, the current Main character speaks in
 * its own private voice; the settings panel next to the call button is where
 * the key, the consent, and the one explicit preparation step live.
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
  voice: "chat.liveVoiceFailed",
  failed: "chat.liveFailed",
};

const STATE_KEYS: Record<LiveCharacterVoiceState, string> = {
  ready: "chat.liveVoiceStateReady",
  "not-prepared": "chat.liveVoiceStateNotPrepared",
  preparing: "chat.liveVoiceStatePreparing",
  "needs-check": "chat.liveVoiceStateNeedsCheck",
  failed: "chat.liveVoiceStateFailed",
  "missing-asset": "chat.liveVoiceStateMissingAsset",
};

const SETTINGS_URL = "/api/live/character-voice";
const LICENSE_URL = "/audio/live/ACML-1.0.txt";
const PREPARE_POLL_MS = 2_000;

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

const VOICE_SETTINGS_ICON = (
  <>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="17" x2="20" y2="17" />
    <circle cx="10" cy="7" r="2.2" />
    <circle cx="16" cy="17" r="2.2" />
  </>
);

function voiceLabel(voice: LiveVoiceMode | null, t: (key: string, values?: Record<string, string>) => string): string | null {
  if (!voice) return null;
  if (voice.mode === "character") {
    const name = t("chat.liveVoiceCharacter", { name: voice.alias });
    return voice.tuning === "provisional" ? `${name} · ${t("chat.liveVoiceProvisional")}` : name;
  }
  if (voice.reason === "voice-not-ready" && voice.alias) return t("chat.liveVoiceNativeNotReady", { name: voice.alias });
  if (voice.reason === "character-unknown") return t("chat.liveVoiceNativeUnknown");
  return null;
}

async function readSettings(response: Response): Promise<LiveCharacterVoiceSettings> {
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok || !body || typeof body !== "object" || !("characters" in body)) {
    const message = body && typeof body === "object" && "message" in body && typeof body.message === "string"
      ? body.message
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as LiveCharacterVoiceSettings;
}

function CharacterVoicePanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const keyId = useId();
  const consentId = useId();
  const [settings, setSettings] = useState<LiveCharacterVoiceSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await readSettings(await fetch(SETTINGS_URL, { cache: "no-store" })));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("chat.liveVoiceLoadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 준비는 서버에서 계속 돈다. 진행 중일 때만 로컬 상태를 다시 읽는다(provider 호출 없음).
  const preparing = settings?.preparing === true;
  useEffect(() => {
    if (!preparing) return;
    const timer = setTimeout(() => void load(), PREPARE_POLL_MS);
    return () => clearTimeout(timer);
  }, [preparing, settings, load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = useCallback(async (init: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await readSettings(await fetch(SETTINGS_URL, init)));
      return true;
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const saveKey = async () => {
    const apiKey = keyInput.trim();
    if (!apiKey) return;
    if (await send({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }) })) {
      setKeyInput("");
    }
  };

  const prepare = () => send({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prepare: true, acknowledged: true }),
  });

  const configured = settings?.configured === true;
  const lastError = error ?? settings?.lastError ?? null;

  return (
    <div
      role="dialog"
      aria-label={t("chat.liveVoiceSettingsTitle")}
      style={{
        position: "absolute",
        bottom: "calc(100% + 6px)",
        right: 0,
        zIndex: 100,
        width: "min(360px, calc(100vw - 32px))",
        maxHeight: "min(70vh, 560px)",
        overflowY: "auto",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-surface)",
        boxShadow: "var(--seed-shadow-s2)",
        color: "var(--text)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{t("chat.liveVoiceSettingsTitle")}</strong>
        <button type="button" className="composer-chip" onClick={onClose} style={{ padding: "4px 8px", fontSize: 12 }}>
          {t("chat.liveVoiceClose")}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor={keyId} style={{ fontWeight: 500 }}>{t("chat.liveVoiceKeyLabel")}</label>
        {configured && settings?.keyHint && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}>
              {t("chat.liveVoiceKeySaved", { hint: settings.keyHint })}
            </span>
            <button
              type="button"
              className="composer-chip"
              disabled={busy || preparing}
              onClick={() => void send({ method: "DELETE" })}
              style={{ padding: "4px 8px", fontSize: 12, whiteSpace: "nowrap" }}
            >
              {t("chat.liveVoiceKeyRemove")}
            </button>
          </div>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          <input
            id={keyId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveKey();
            }}
            placeholder="sk_car_…"
            style={{
              flex: 1,
              minWidth: 0,
              height: 32,
              padding: "0 8px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              background: "var(--bg-panel)",
              color: "var(--text)",
              fontSize: 12,
            }}
          />
          <button
            type="button"
            className="composer-chip"
            disabled={busy || !keyInput.trim()}
            onClick={() => void saveKey()}
            style={{ padding: "0 10px", height: 32, fontSize: 12, whiteSpace: "nowrap" }}
          >
            {t("chat.liveVoiceKeySave")}
          </button>
        </div>
        <span style={{ color: "var(--text-muted)" }}>{t("chat.liveVoiceKeyHelp")}</span>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input
          id={consentId}
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          style={{ marginTop: 3, flex: "none" }}
        />
        <label htmlFor={consentId}>
          {t("chat.liveVoiceConsent")}{" "}
          <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
            {t("chat.liveVoiceLicense")}
          </a>
        </label>
      </div>
      <span style={{ color: "var(--text-muted)" }}>{t("chat.liveVoicePlanNote")}</span>

      <button
        type="button"
        className="composer-chip"
        disabled={busy || preparing || !configured || !consent}
        onClick={() => void prepare()}
        aria-busy={preparing}
        style={{ height: 32, fontSize: 12, fontWeight: 600 }}
      >
        {preparing ? t("chat.liveVoicePreparing") : t("chat.liveVoicePrepare")}
      </button>

      {lastError && (
        <span role="alert" style={{ color: "var(--danger)", overflowWrap: "anywhere" }}>{lastError}</span>
      )}

      {settings && (
        <ul aria-live="polite" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {settings.characters.map((character) => (
            <li
              key={character.id}
              title={character.error}
              style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
            >
              <span>
                {character.alias}
                {character.tuning === "provisional" && (
                  <span style={{ color: "var(--text-muted)" }}> · {t("chat.liveVoiceProvisional")}</span>
                )}
              </span>
              <span
                style={{
                  color: character.state === "failed" || character.state === "needs-check" || character.state === "missing-asset"
                    ? "var(--danger)"
                    : character.state === "ready" ? "var(--text)" : "var(--text-muted)",
                  whiteSpace: "nowrap",
                }}
              >
                {t(STATE_KEYS[character.state])}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LiveVoiceButton({ sessionId, onEnsureSession, onTranscriptPersisted }: LiveVoiceButtonProps) {
  const { t } = useI18n();
  const live = useLiveVoice(sessionId, onEnsureSession, onTranscriptPersisted);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsButtonRef.current?.focus();
  }, []);

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
  const speaker = active ? voiceLabel(live.voice, t) : null;

  return (
    <div role="group" aria-label={t("chat.liveVoice")} style={{ display: "flex", alignItems: "center", gap: 6, position: "relative" }}>
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
      {speaker && (
        <span
          style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={speaker}
        >
          {speaker}
        </span>
      )}
      <button
        ref={settingsButtonRef}
        type="button"
        className={`composer-icon-button${settingsOpen ? " is-active" : ""}`}
        onClick={() => setSettingsOpen((open) => !open)}
        aria-expanded={settingsOpen}
        aria-haspopup="dialog"
        title={t("chat.liveVoiceSettings")}
        aria-label={t("chat.liveVoiceSettings")}
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
          {VOICE_SETTINGS_ICON}
        </svg>
      </button>
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
      {settingsOpen && <CharacterVoicePanel onClose={closeSettings} />}
    </div>
  );
}
