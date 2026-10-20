"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useOfficeCharacters } from "@/hooks/useAccountFaces";
import { useI18n } from "@/hooks/useI18n";
import { applyOfficeCharacters, loadOfficeCharacters, type OfficeCharactersState } from "@/lib/hanse-resource-client";
import styles from "./SettingsConfig.module.css";

type Mode = OfficeCharactersState["mode"];

/**
 * The settings-dialog section for the character set. The mode is server-wide (one file in the
 * PC profile), not an omp setting, so it goes through `/api/character-mode`. The response also
 * carries the office seats; applying it re-renders every face, name, sticker and cue at once.
 */
export function CharacterModeSettings() {
  const { t } = useI18n();
  const labelId = useId();
  const office = useOfficeCharacters();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadOfficeCharacters().then(() => setLoaded(true));
  }, []);

  const choose = useCallback(async (mode: Mode) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/character-mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof body === "object" && body !== null && "error" in body ? String(body.error) : `HTTP ${response.status}`);
      }
      applyOfficeCharacters(body as OfficeCharactersState);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!loaded) return <div className={styles.empty}>…</div>;

  const options: Array<{ mode: Mode; label: string }> = [
    { mode: "default", label: t("characterMode.default") },
    { mode: "office", label: t("characterMode.office") },
  ];

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>{t("characterMode.title")}</h2>
        <p className={styles.contentDescription}>{t("characterMode.description")}</p>
      </header>
      <div className={styles.settingsBody}>
        <section className={styles.group}>
          <div className={styles.settingRow}>
            <div>
              <div id={labelId} className={styles.settingLabel}>{t("characterMode.label")}</div>
              <div className={styles.settingDescription}>{t("characterMode.help")}</div>
            </div>
            <div className={styles.settingControl}>
              <div className={styles.multiSelect} role="radiogroup" aria-labelledby={labelId}>
                {options.map((option) => (
                  <span key={option.mode} className={styles.choice} data-selected={office.mode === option.mode}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={office.mode === option.mode}
                      className={styles.choiceToggle}
                      disabled={busy}
                      onClick={() => { if (office.mode !== option.mode) void choose(option.mode); }}
                    >
                      {option.label}
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </div>
          {office.mode === "office" && !office.rosterAvailable && (
            <div className={styles.settingDescription} role="status">{t("characterMode.noRoster")}</div>
          )}
          {error && <div className={styles.error} role="alert" style={{ overflowWrap: "anywhere" }}>{error}</div>}
          {saved && !error && <div className={styles.saveState} role="status">{t("characterMode.saved")}</div>}
        </section>
      </div>
    </div>
  );
}
