"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { LiveVoices } from "@/lib/live-types";
import { SearchableSelect } from "./SearchableSelect";
import styles from "./SettingsConfig.module.css";

/**
 * Call voice, from the settings dialog.
 *
 * Picks which Codex voice speaks live and interpreter calls. The choice is the
 * core `live.voice` setting, saved on change and applied from the next call.
 */

const VOICES_URL = "/api/live/voices";

export function LiveVoiceConfig() {
  const { t } = useI18n();
  const [voices, setVoices] = useState<LiveVoices | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

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

  if (!voices) {
    return (
      <div className={styles.empty}>
        {voiceError ? `${t("chat.liveVoiceLoadFailed")}: ${voiceError}` : "…"}
      </div>
    );
  }

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
              <div className={styles.settingLabel}>{t("chat.liveVoiceCodexLabel")}</div>
              <div className={styles.settingDescription}>{t("chat.liveVoiceCodexHelp")}</div>
              {voiceError && <div className={styles.error} role="alert" style={{ overflowWrap: "anywhere" }}>{voiceError}</div>}
            </div>
            <div className={styles.settingControl}>
              <SearchableSelect
                value={voices.defaultVoice}
                disabled={voiceBusy}
                ariaLabel={t("chat.liveVoiceCodexLabel")}
                options={voices.voices}
                onChange={(value) => {
                  if (value !== voices.defaultVoice) void chooseVoice(value);
                }}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
