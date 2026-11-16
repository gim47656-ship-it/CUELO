"use client";

import type { InterpreterAssistResult } from "@/lib/translator-context";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import { useTranslatorText } from "./i18n";
import styles from "./TypedInterpreter.module.css";

export function LineAssist({ result, numericMismatch = false, meaning, mine }: {
  result?: InterpreterAssistResult;
  numericMismatch?: boolean;
  meaning: boolean;
  mine: TranslatorLanguage;
}) {
  const { tt } = useTranslatorText();
  const warning = meaning ? result?.warning || (numericMismatch ? tt("translator.assistNumberWarning") : undefined) : undefined;
  const nuance = meaning ? result?.nuance : undefined;
  if (!warning && !nuance) return null;
  return <div className={styles.assist} lang={mine.tag}>
    {nuance ? <p className={styles.nuance}><span>{tt("translator.assistNuance")}</span> {nuance}</p> : null}
    {warning ? <div className={styles.warning} role="status">
      <p><span>{tt("translator.assistWarning")}</span> {warning}</p>
      {result?.backTranslation ? <p className={styles.backTranslation}><span>{tt("translator.assistBackTranslation")}</span> {result.backTranslation}</p> : null}
    </div> : null}
  </div>;
}
