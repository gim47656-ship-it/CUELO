"use client";

import type { InterpreterAssistResult } from "@/lib/translator-context";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import { useTranslatorText } from "./i18n";
import type { ShowCardContent } from "./ShowCard";
import styles from "./TypedInterpreter.module.css";

export function LineAssist({ result, showReplies, numericMismatch = false, meaning, mine, theirs, onShow }: {
  result?: InterpreterAssistResult;
  showReplies: boolean;
  numericMismatch?: boolean;
  meaning: boolean;
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  onShow: (card: ShowCardContent) => void;
}) {
  const { tt } = useTranslatorText();
  const warning = meaning ? result?.warning || (numericMismatch ? tt("translator.assistNumberWarning") : undefined) : undefined;
  const replies = showReplies ? result?.replies : undefined;
  const nuance = meaning ? result?.nuance : undefined;
  if (!warning && !replies?.length && !nuance) return null;
  return <div className={styles.assist} lang={mine.tag}>
    {nuance ? <p className={styles.nuance}><span>{tt("translator.assistNuance")}</span> {nuance}</p> : null}
    {warning ? <div className={styles.warning} role="status">
      <p><span>{tt("translator.assistWarning")}</span> {warning}</p>
      {result?.backTranslation ? <p className={styles.backTranslation}><span>{tt("translator.assistBackTranslation")}</span> {result.backTranslation}</p> : null}
    </div> : null}
    {replies?.length ? <div className={styles.replies} role="group" aria-label={tt("translator.assistReplies")}>
      {replies.map((reply) => <button type="button" key={reply.theirs} aria-haspopup="dialog" onClick={() => onShow({ text: reply.theirs, language: theirs, note: { text: reply.mine, language: mine } })}>{reply.mine}</button>)}
    </div> : null}
  </div>;
}
