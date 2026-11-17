"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { READING_LANGUAGES } from "@/lib/translator-context";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import { useTranslatorText } from "./i18n";
import type { Speech } from "./useSpeech";

export interface ShowCardContent {
  text: string;
  language: TranslatorLanguage;
  /** 일본어·태국어·베트남어 줄의 한글 발음. 없으면 카드가 한 번 받아 온다. 읽어 주기에는 쓰지 않는다. */
  reading?: string;
  /** 카드가 받아 온 발음을 넘겨받는 곳(자주 쓰는 문장의 저장소). */
  onReading?: (reading: string) => void;
  /** 카드 아래에 작게 보일 원문(자주 쓰는 문장). 통역 줄은 원문과 짝을 모르므로 없다. */
  note?: { text: string; language: TranslatorLanguage };
  /** 마주보기 위 칸(상대 쪽)에서 열었으면 상대가 읽게 뒤집는다. */
  flipped?: boolean;
}

interface ShowCardProps {
  card: ShowCardContent;
  speech: Speech;
  onClose: () => void;
  /** 숫자·단위를 강조해 그리는 함수. 통역 줄과 같은 강조를 쓴다. */
  renderText: (text: string) => ReactNode;
}

/** 이번 페이지에서 받아 온 발음(`null`은 물었지만 못 받음). 같은 줄을 다시 열면 다시 묻지 않는다. */
const readingCache = new Map<string, string | null>();
/** An opened card, then the user's own interpretations, then heard originals. */
export type ReadingPriority = "foreground" | "background" | "later";
const READING_RANK: Record<ReadingPriority, number> = { foreground: 0, background: 1, later: 2 };
interface ReadingJob {
  key: string;
  priority: ReadingPriority;
  promise: Promise<string | null>;
  resolve: (reading: string | null) => void;
  load: () => Promise<string | null>;
}
const readingRequests = new Map<string, ReadingJob>();
const readingQueue: ReadingJob[] = [];
let readingActive = false;

/** One model request at a time; the highest priority goes first, in arrival order within a priority. */
function nextReading() {
  if (readingActive || !readingQueue.length) return;
  const next = readingQueue.reduce((best, job, index) => READING_RANK[job.priority] < READING_RANK[readingQueue[best].priority] ? index : best, 0);
  const [job] = readingQueue.splice(next, 1);
  readingActive = true;
  void job.load().then((reading) => {
    readingCache.set(job.key, reading);
    readingRequests.delete(job.key);
    readingActive = false;
    job.resolve(reading);
    nextReading();
  });
}

/** A pending or completed reading is shared; a failed optional reading never blocks the next one. */
export function loadReading(key: string, text: string, language: TranslatorLanguage, priority: ReadingPriority = "foreground"): Promise<string | null> {
  if (readingCache.has(key)) return Promise.resolve(readingCache.get(key) ?? null);
  const running = readingRequests.get(key);
  if (running) {
    if (READING_RANK[priority] < READING_RANK[running.priority]) running.priority = priority;
    return running.promise;
  }
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const load = async () => {
    try {
      const response = await fetch("/api/live/interpret/reading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, language: language.code }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return body && typeof body === "object" && "reading" in body && typeof body.reading === "string" && body.reading.trim() ? body.reading : null;
    } catch { return null; }
  };
  const job: ReadingJob = { key, priority, promise, resolve, load };
  readingRequests.set(key, job);
  readingQueue.push(job);
  nextReading();
  return promise;
}

const FIT_MIN = 20;
const FIT_MAX = 160;

function SpeakerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  );
}

/**
 * 보여주기 카드: 통역 한 줄을 화면 가득 큰 글씨로 띄운다. 시끄러운 곳에서 가게 직원이나 택시
 * 기사에게 화면을 그대로 보여 줄 때 쓴다. 글자 크기는 화면에 꼭 맞을 때까지 키운다.
 */
export function ShowCard({ card, speech, onClose, renderText }: ShowCardProps) {
  const { tt } = useTranslatorText();
  const dialogRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  // 발음: 받은 것이 있으면 그것, 없으면 이번 페이지에서 받아 둔 것, 그래도 없으면 한 번 받아 온다.
  const readingKey = `${card.language.code}\u0000${card.text}`;
  const wantsReading = READING_LANGUAGES.includes(card.language.code);
  const [fetched, setFetched] = useState<{ key: string; reading: string } | null>(null);
  const reading = wantsReading
    ? card.reading ?? (fetched?.key === readingKey ? fetched.reading : readingCache.get(readingKey) ?? undefined)
    : undefined;
  const cardRef = useRef(card);
  cardRef.current = card;
  useEffect(() => {
    const { text, language, reading: given } = cardRef.current;
    if (!READING_LANGUAGES.includes(language.code) || given) return;
    const known = readingCache.get(readingKey);
    if (known !== undefined) {
      // Already asked on this page: reuse it (and let an old phrase keep it), never ask again after a miss.
      if (known) cardRef.current.onReading?.(known);
      return;
    }
    // A failed or empty answer leaves the card as it is; the result (miss included) is remembered for this page.
    let active = true;
    const { onReading } = cardRef.current;
    void loadReading(readingKey, text, language).then((value) => {
      if (!value) return;
      // Save it for the phrase that asked even if the card closed meanwhile; only the display needs the card.
      onReading?.(value);
      if (active) setFetched({ key: readingKey, reading: value });
    });
    return () => {
      active = false;
    };
  }, [readingKey]);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // 열 때 카드로 초점을 옮기고, 닫을 때 연 자리로 돌려준다. 읽던 소리도 끊는다.
  const { cancel } = speech;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    // 앞 단계에서 받아 멈춘다. 카드 아래 덮개(자주 쓰는 문장)가 같은 Escape로 함께 닫히지 않는다.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      cancel();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [cancel]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const text = textRef.current;
    if (!box || !text) return;
    const fit = () => {
      // 앞 맞춤이 켠 낱말 쪼개기를 끄고 재야 긴 낱말이 다시 가로로 넘치는 것을 본다.
      delete box.dataset.overflow;
      let low = FIT_MIN;
      let high = FIT_MAX;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        text.style.fontSize = `${mid}px`;
        if (text.scrollHeight <= box.clientHeight && text.scrollWidth <= box.clientWidth) low = mid;
        else high = mid;
      }
      text.style.fontSize = `${low}px`;
      // 가장 작은 글자로도 넘치는 긴 줄(쪼갤 수 없는 긴 낱말 포함)은 잘라 숨기지 않고 쪼개서 카드 안에서 위에서부터 스크롤한다.
      const overflow = text.scrollHeight > box.clientHeight || text.scrollWidth > box.clientWidth;
      if (overflow) box.dataset.overflow = "true";
      else delete box.dataset.overflow;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [card.text, reading]);

  // 카드 안에서만 Tab이 돈다.
  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (buttons.length === 0) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      className="translator-card"
      role="dialog"
      aria-modal="true"
      aria-label={tt("translator.cardTitle")}
      tabIndex={-1}
      data-flipped={card.flipped ? "true" : undefined}
      onKeyDown={trapTab}
    >
      <div ref={boxRef} className="translator-card-box">
        <div ref={textRef} className="translator-card-content">
          <p className="translator-card-text" lang={card.language.tag}>
            {renderText(card.text)}
          </p>
          {reading ? <p className="translator-card-reading" lang="ko">{reading}</p> : null}
        </div>
      </div>
      {card.note ? (
        <p className="translator-card-note" lang={card.note.language.tag}>{card.note.text}</p>
      ) : null}
      {speech.failed ? <p className="translator-card-notice" role="status">{tt("translator.speakFailed")}</p> : null}
      <div className="translator-card-actions">
        <button
          type="button"
          className="translator-card-speak"
          data-focus-halo
          aria-pressed={speech.speaking}
          disabled={!speech.supported}
          onClick={() => (speech.speaking ? speech.cancel() : speech.speak(card.text, card.language))}
        >
          <SpeakerIcon />
          {tt(speech.speaking ? "translator.speakStop" : "translator.speak")}
        </button>
        <button type="button" className="translator-card-close" onClick={onClose}>
          {tt("translator.cardClose")}
        </button>
      </div>
      <p className="translator-volume-hint" aria-live="polite">{speech.speaking ? tt("translator.volumeHint") : "\u00a0"}</p>
    </div>
  );
}
