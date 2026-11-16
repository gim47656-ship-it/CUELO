"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Volume2, Square } from "lucide-react";
import { READING_LANGUAGES } from "@/lib/translator-context";
import { loadReading, type ShowCardContent } from "./ShowCard";
import { useTranslatorText } from "./i18n";
import type { Speech } from "./useSpeech";
import type { BubbleText, ConversationTurn } from "./conversation-display";

function Translation({ line, renderText, load }: { line: BubbleText; renderText: (text: string) => ReactNode; load: boolean }) {
  const [fetched, setFetched] = useState<{ text: string; reading: string } | null>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const language = line.language;
  useEffect(() => {
    if (!load || !line.loadReading || !line.final || !language || !READING_LANGUAGES.includes(language.code) || typeof IntersectionObserver === "undefined") return;
    let current = true;
    const element = textRef.current;
    if (!element) return;
    // A restored history can have 200 segments. A fling past a line must not launch model work.
    let timer: number | undefined;
    const observer = new IntersectionObserver((entries) => {
      window.clearTimeout(timer);
      if (!entries.at(-1)?.isIntersecting) return;
      timer = window.setTimeout(() => {
        observer.disconnect();
        void loadReading(`${language.code}\u0000${line.text}`, line.text, language, "background").then((reading) => {
          if (current && reading) setFetched({ text: line.text, reading });
        });
      }, 400);
    });
    observer.observe(element);
    return () => { current = false; observer.disconnect(); window.clearTimeout(timer); };
  }, [language, line.final, line.loadReading, line.text, load]);
  const reading = line.reading ?? (fetched?.text === line.text ? fetched.reading : undefined);
  return <>
    <span ref={textRef} className="translator-translation" lang={language?.tag}>{renderText(line.text)}</span>
    {reading ? <span className="translator-reading" lang="ko">{reading}</span> : null}
  </>;
}

export function ConversationBubble({ turn, latest, visible, speech, onShow, renderText, children }: {
  turn: ConversationTurn; latest: boolean; visible: boolean; speech: Speech; onShow: (card: ShowCardContent) => void;
  renderText: (text: string) => ReactNode; children?: ReactNode;
}) {
  const { tt } = useTranslatorText();
  const translation = turn.translations.at(-1);
  const content = translation ?? turn.originals.at(-1);
  const language = content?.language ?? content?.fallbackLanguage;
  const card = content && language ? { text: content.text, language, reading: content.reading } : null;
  return <article className="translator-entry" data-side={turn.side} data-latest={latest ? "true" : undefined} data-speaker-start={turn.speakerStart ? "true" : undefined} aria-busy={turn.pending || undefined}>
    {turn.speakerStart ? <span className="translator-speaker">{tt(turn.side === "me" ? "translator.me" : "translator.them")}</span> : null}
    <button type="button" className="translator-bubble" title={tt("translator.cardTitle")} onClick={() => { if (card) onShow(card); }}>
      <span className="sr-only">{tt("translator.cardTitle")}</span>
      {turn.translations.map((line) => <Translation key={line.key} line={line} renderText={renderText} load={visible} />)}
      {turn.originals.map((line) => <span key={line.key} className="translator-original" data-only={!turn.translations.length ? "true" : undefined} lang={line.language?.tag}>{renderText(line.text)}</span>)}
    </button>
    {children}
    {latest && translation && card ? <div className="translator-bubble-controls">
      <div className="translator-bubble-actions">
        <button type="button" onClick={() => onShow(card)}><Maximize2 size={18} aria-hidden="true" />{tt("translator.cardTitle")}</button>
        <button type="button" disabled={!speech.supported} aria-pressed={speech.speaking} onClick={() => speech.speaking ? speech.cancel() : speech.speak(card.text, card.language)}>
          {speech.speaking ? <Square size={16} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}{tt(speech.speaking ? "translator.speakStop" : "translator.speak")}
        </button>
      </div>
      <p className="translator-volume-hint" aria-live="polite">{speech.speaking ? tt("translator.volumeHint") : "\u00a0"}</p>
      {speech.failed ? <p className="translator-card-notice" role="status">{tt("translator.speakFailed")}</p> : null}
    </div> : null}
  </article>;
}
