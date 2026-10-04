"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  fetchAttachmentSettings,
  saveAttachmentSettings,
  type AttachmentSettings as AttachmentSettingsValue,
  type AttachmentSettingsPatch,
} from "@/lib/attachment-settings";
import styles from "./SettingsConfig.module.css";

/**
 * The settings-dialog section for chat attachments: the per-file upload limit and automatic
 * cleanup of attachments nothing uses any more. Each control saves on its own.
 */
export function AttachmentSettings() {
  const { t } = useI18n();
  const limitId = useId();
  const cleanupId = useId();
  const [settings, setSettings] = useState<AttachmentSettingsValue | null>(null);
  const [limitInput, setLimitInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchAttachmentSettings({ signal: controller.signal })
      .then((loaded) => {
        setSettings(loaded);
        setLimitInput(String(loaded.uploadLimitMb));
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    return () => controller.abort();
  }, []);

  const save = useCallback(async (patch: AttachmentSettingsPatch) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await saveAttachmentSettings(patch);
      setSettings(next);
      setLimitInput(String(next.uploadLimitMb));
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!settings) {
    return (
      <div className={styles.empty}>
        {error ? `${t("chat.attachmentSettingsLoadFailed")}: ${error}` : "…"}
      </div>
    );
  }

  const commitLimit = () => {
    const trimmed = limitInput.trim();
    if (trimmed === String(settings.uploadLimitMb)) return;
    const limit = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(limit) || limit < 1) {
      setSaved(false);
      setError(t("chat.attachmentUploadLimitInvalid"));
      return;
    }
    void save({ uploadLimitMb: limit });
  };

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>{t("chat.attachmentSettingsTitle")}</h2>
        <p className={styles.contentDescription}>{t("chat.attachmentSettingsDescription")}</p>
      </header>
      <div className={styles.settingsBody}>
        <section className={styles.group}>
          <div className={styles.settingRow}>
            <div>
              <label htmlFor={limitId} className={styles.settingLabel} style={{ display: "block" }}>
                {t("chat.attachmentUploadLimit")}
              </label>
              <div className={styles.settingDescription}>{t("chat.attachmentUploadLimitHelp")}</div>
            </div>
            <div className={styles.settingControl}>
              <input
                id={limitId}
                className={styles.numberInput}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={limitInput}
                disabled={busy}
                onChange={(event) => setLimitInput(event.target.value)}
                onBlur={commitLimit}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
            </div>
          </div>
          <div className={styles.settingRow}>
            <div>
              <div id={cleanupId} className={styles.settingLabel}>{t("chat.attachmentAutoCleanup")}</div>
              <div className={styles.settingDescription}>
                {t("chat.attachmentAutoCleanupHelp", { days: settings.orphanGraceDays })}
              </div>
            </div>
            <div className={styles.settingControl}>
              <button
                type="button"
                className={styles.switch}
                data-on={settings.autoCleanupEnabled}
                aria-pressed={settings.autoCleanupEnabled}
                aria-labelledby={cleanupId}
                disabled={busy}
                onClick={() => void save({ autoCleanupEnabled: !settings.autoCleanupEnabled })}
              />
            </div>
          </div>
          {error && <div className={styles.error} role="alert" style={{ overflowWrap: "anywhere" }}>{error}</div>}
          {saved && !error && <div className={styles.saveState} role="status">{t("chat.attachmentSettingsSaved")}</div>}
        </section>
      </div>
    </div>
  );
}
