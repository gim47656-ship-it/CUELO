"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import { useTranslatorText } from "./i18n";
import type { Speech } from "./useSpeech";

export interface ShowCardContent {
  text: string;
  language: TranslatorLanguage;
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
  const textRef = useRef<HTMLParagraphElement>(null);
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
      let low = FIT_MIN;
      let high = FIT_MAX;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        text.style.fontSize = `${mid}px`;
        if (text.scrollHeight <= box.clientHeight && text.scrollWidth <= box.clientWidth) low = mid;
        else high = mid;
      }
      text.style.fontSize = `${low}px`;
      // 가장 작은 글자로도 넘치는 긴 줄은 잘라 숨기지 않고 카드 안에서 위에서부터 스크롤한다.
      const overflow = text.scrollHeight > box.clientHeight;
      if (overflow) box.dataset.overflow = "true";
      else delete box.dataset.overflow;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [card.text]);

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
        <p ref={textRef} className="translator-card-text" lang={card.language.tag}>
          {renderText(card.text)}
        </p>
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
    </div>
  );
}
