"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { LiveCharacterVoiceSettings, LiveCharacterVoiceState, LiveSpeaker, LiveVoices } from "@/lib/live-types";
import { SearchableSelect } from "./SearchableSelect";
import styles from "./SettingsConfig.module.css";

/**
 * Call voices, from the settings dialog.
 *
 * The first group picks who speaks a call (the character's Cartesia voice or
 * the Codex voice) and which Codex voice that is; both save on change and
 * apply from the next call. Opening this section only reads local state: the
 * masked key and each character's readiness. Saving or removing the key and
 * the one explicit preparation step (which uploads the reference voices and
 * uses Cartesia credits) each happen only on their own button, and
 * preparation needs the consent box first. The composer keeps just the call
 * start/end control.
 */

const SETTINGS_URL = "/api/live/character-voice";
const VOICES_URL = "/api/live/voices";
const LICENSE_URL = "/audio/live/ACML-1.0.txt";
const PREPARE_POLL_MS = 2_000;

const STATE_KEYS: Record<LiveCharacterVoiceState, string> = {
  ready: "chat.liveVoiceStateReady",
  "not-prepared": "chat.liveVoiceStateNotPrepared",
  preparing: "chat.liveVoiceStatePreparing",
  "needs-check": "chat.liveVoiceStateNeedsCheck",
  failed: "chat.liveVoiceStateFailed",
  "missing-asset": "chat.liveVoiceStateMissingAsset",
};

const PROBLEM_STATES: Partial<Record<LiveCharacterVoiceState, true>> = {
  failed: true,
  "needs-check": true,
  "missing-asset": true,
};

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

export function LiveVoiceConfig() {
  const { t } = useI18n();
  const keyId = useId();
  const consentId = useId();
  const [settings, setSettings] = useState<LiveCharacterVoiceSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voices, setVoices] = useState<LiveVoices | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [speakerError, setSpeakerError] = useState<string | null>(null);

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

  const loadVoices = useCallback(async () => {
    try {
      const response = await fetch(VOICES_URL, { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as Partial<LiveVoices>;
      if (!response.ok || !Array.isArray(body.voices) || typeof body.defaultVoice !== "string") {
        throw new Error(`HTTP ${response.status}`);
      }
      setVoices({ voices: body.voices, defaultVoice: body.defaultVoice });
    } catch (loadError) {
      setVoiceError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void loadVoices();
  }, [loadVoices]);

  // 준비는 서버에서 계속 돈다. 진행 중일 때만 로컬 상태를 다시 읽는다(provider 호출 없음).
  const preparing = settings?.preparing === true;
  useEffect(() => {
    if (!preparing) return;
    const timer = setTimeout(() => void load(), PREPARE_POLL_MS);
    return () => clearTimeout(timer);
  }, [preparing, settings, load]);

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

  // 화자 선택은 키·준비 버튼과 따로 저장하고 오류도 그 줄에 보인다.
  const chooseSpeaker = async (speaker: LiveSpeaker) => {
    setBusy(true);
    setSpeakerError(null);
    try {
      setSettings(await readSettings(await fetch(SETTINGS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speaker }),
      })));
    } catch (saveError) {
      setSpeakerError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  // `live.voice`는 core 설정이라 다른 설정과 같은 경로(`/api/settings`)로 저장한다.
  const chooseVoice = async (value: string) => {
    setVoiceBusy(true);
    setVoiceError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "live.voice", value }),
      });
      const result = await response.json().catch(() => ({})) as { value?: unknown; error?: string };
      if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
      const saved = typeof result.value === "string" ? result.value : value;
      setVoices((current) => current ? { ...current, defaultVoice: saved } : current);
    } catch (saveError) {
      setVoiceError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setVoiceBusy(false);
    }
  };

  if (!settings) {
    return (
      <div className={styles.empty}>
        {error ? `${t("chat.liveVoiceLoadFailed")}: ${error}` : "…"}
      </div>
    );
  }

  const configured = settings.configured;
  const lastError = error ?? settings.lastError ?? null;

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>{t("chat.liveVoiceSettingsTitle")}</h2>
        <p className={styles.contentDescription}>{t("chat.liveVoiceSettingsDescription")}</p>
      </header>

      <div className={styles.settingsBody}>
        <section className={styles.group}>
          <h3 className={styles.groupTitle}>{t("chat.liveVoiceSpeakerGroup")}</h3>
          <div className={styles.settingRow}>
            <div style={{ minWidth: 0 }}>
              <div className={styles.settingLabel}>{t("chat.liveVoiceSpeakerLabel")}</div>
              <div className={styles.settingDescription}>{t("chat.liveVoiceSpeakerHelp")}</div>
              {speakerError && <div className={styles.error} role="alert" style={{ overflowWrap: "anywhere" }}>{speakerError}</div>}
            </div>
            <div className={styles.settingControl}>
              <SearchableSelect
                value={settings.speaker}
                disabled={busy}
                ariaLabel={t("chat.liveVoiceSpeakerLabel")}
                options={[
                  { value: "character", label: t("chat.liveVoiceSpeakerCharacter") },
                  { value: "native", label: t("chat.liveVoiceSpeakerNative") },
                ]}
                onChange={(value) => {
                  if ((value === "character" || value === "native") && value !== settings.speaker) void chooseSpeaker(value);
                }}
              />
            </div>
          </div>
          <div className={styles.settingRow}>
            <div style={{ minWidth: 0 }}>
              <div className={styles.settingLabel}>{t("chat.liveVoiceCodexLabel")}</div>
              <div className={styles.settingDescription}>{t("chat.liveVoiceCodexHelp")}</div>
              {voiceError && <div className={styles.error} role="alert" style={{ overflowWrap: "anywhere" }}>{voiceError}</div>}
            </div>
            <div className={styles.settingControl}>
              <SearchableSelect
                value={voices?.defaultVoice ?? ""}
                disabled={!voices || voiceBusy}
                ariaLabel={t("chat.liveVoiceCodexLabel")}
                options={voices?.voices ?? []}
                onChange={(value) => {
                  if (value !== voices?.defaultVoice) void chooseVoice(value);
                }}
              />
            </div>
          </div>
        </section>

        <section className={styles.group}>
          <h3 className={styles.groupTitle}>{t("chat.liveVoiceKeyLabel")}</h3>
          <div className={styles.settingRow}>
            <div style={{ minWidth: 0 }}>
              <label htmlFor={keyId} className={styles.settingLabel} style={{ display: "block" }}>
                {t("chat.liveVoiceKeyLabel")}
              </label>
              <div className={styles.settingDescription}>{t("chat.liveVoiceKeyHelp")}</div>
              {configured && settings.keyHint && (
                <div className={styles.saveState} style={{ overflowWrap: "anywhere" }}>
                  {t("chat.liveVoiceKeySaved", { hint: settings.keyHint })}
                </div>
              )}
            </div>
            <div className={styles.settingControl}>
              <input
                id={keyId}
                className={styles.textInput}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={keyInput}
                disabled={busy}
                onChange={(event) => setKeyInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveKey();
                }}
                placeholder="sk_car_…"
              />
            </div>
          </div>
          <div className={styles.editorActions}>
            <div />
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
              {configured && (
                <button
                  type="button"
                  className={styles.dangerButton}
                  disabled={busy || preparing}
                  onClick={() => void send({ method: "DELETE" })}
                >
                  {t("chat.liveVoiceKeyRemove")}
                </button>
              )}
              <button
                type="button"
                className={styles.primaryButton}
                disabled={busy || !keyInput.trim()}
                onClick={() => void saveKey()}
              >
                {t("chat.liveVoiceKeySave")}
              </button>
            </div>
          </div>
        </section>

        <section className={styles.group}>
          <h3 className={styles.groupTitle}>{t("chat.liveVoicePrepare")}</h3>
          <div className={styles.settingRow}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 }}>
              <input
                id={consentId}
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                style={{ marginTop: 3, flex: "none" }}
              />
              <div style={{ minWidth: 0 }}>
                <label htmlFor={consentId} className={styles.settingDescription} style={{ display: "block", color: "var(--text)" }}>
                  {t("chat.liveVoiceConsent")}
                </label>
                <div className={styles.settingDescription} style={{ marginTop: 4 }}>
                  {t("chat.liveVoicePlanNote")}{" "}
                  <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                    {t("chat.liveVoiceLicense")}
                  </a>
                </div>
              </div>
            </div>
            <div className={styles.settingControl} style={{ alignItems: "center" }}>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={busy || preparing || !configured || !consent}
                onClick={() => void prepare()}
                aria-busy={preparing}
              >
                {preparing ? t("chat.liveVoicePreparing") : t("chat.liveVoicePrepare")}
              </button>
            </div>
          </div>
          {lastError && <div className={styles.error} role="alert" style={{ overflowWrap: "anywhere" }}>{lastError}</div>}
        </section>

        <section className={styles.group}>
          <h3 className={styles.groupTitle}>{t("chat.liveVoiceCharacters")}</h3>
          <ul aria-live="polite" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {settings.characters.map((character) => (
              <li key={character.id} className={styles.settingRow} style={{ minHeight: 44 }} title={character.error}>
                <div className={styles.settingLabel} style={{ marginBottom: 0 }}>
                  {character.alias}
                  {character.tuning === "provisional" && (
                    <span className={styles.settingDescription} style={{ fontWeight: 400 }}> · {t("chat.liveVoiceProvisional")}</span>
                  )}
                </div>
                <div
                  className={styles.settingControl}
                  style={{
                    fontSize: 12,
                    color: PROBLEM_STATES[character.state]
                      ? "var(--danger)"
                      : character.state === "ready" ? "var(--text)" : "var(--text-muted)",
                  }}
                >
                  {t(STATE_KEYS[character.state])}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
