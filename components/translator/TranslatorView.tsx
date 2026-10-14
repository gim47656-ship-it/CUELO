"use client";

import { ActionButton } from "@seed-design/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  TRANSLATOR_LANGUAGES,
  findTranslatorLanguage,
  type TranslatorLanguage,
} from "@/lib/translator-languages";
import { useTranslatorText, type TranslatorTranslate } from "./i18n";
import {
  addTranscript,
  beginTranscriptCall,
  clearTranscripts,
  emptyTranscriptLog,
  spokenLanguage,
  type TranscriptEntry,
} from "./transcript-log";
import { useInterpreterCall, type InterpreterTranscript } from "./useInterpreterCall";

/**
 * 통역 모드. 사이드바 「통역」 보기가 켜지면 작업 대화 칸 위에 덮인다. 「통역 시작」은 세션 없는
 * Codex 라이브 통화(`/api/live/interpret`)를 열고, 두 사람이 번갈아 말하면 통화 모델이 상대 언어로
 * 바로 소리 내어 옮긴다. 화면은 그 통화의 전사로 말풍선을 만든다: 들은 말이 원문, 모델이 말한 것이
 * 통역이다. 기록은 이 화면이 떠 있는 동안만 메모리에 두며 서버·세션에 저장하지 않는다.
 */

const SETTINGS_KEY = "cuelo-translator";

interface Settings {
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
}

function readSettings(): Settings {
  const fallback: Settings = { mine: TRANSLATOR_LANGUAGES[0], theirs: TRANSLATOR_LANGUAGES[1] };
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null") as Record<string, unknown> | null;
    if (!saved || typeof saved !== "object") return fallback;
    const mine = findTranslatorLanguage(saved.mine) ?? fallback.mine;
    const theirs = findTranslatorLanguage(saved.theirs) ?? fallback.theirs;
    return mine.code === theirs.code ? fallback : { mine, theirs };
  } catch {
    return fallback;
  }
}

function MicIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function failureText(tt: TranslatorTranslate, failure: string, detail: string | null): string {
  switch (failure) {
    case "mic-denied":
      return tt("translator.micDenied");
    case "mic-unavailable":
      return tt("translator.micUnavailable");
    case "auth":
      return tt("translator.auth");
    case "upstream":
      return tt("translator.upstream", { error: detail ?? "" });
    default:
      return tt("translator.failed", { error: detail ?? "" });
  }
}

interface TranslatorViewProps {
  visible?: boolean;
  onBack?: () => void;
}

export function TranslatorView({ visible = true, onBack }: TranslatorViewProps) {
  const { tt } = useTranslatorText();
  const [settings, setSettings] = useState(readSettings);
  const { mine, theirs } = settings;
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  /** 말풍선 목록과 열린 차례. 전사가 올 때마다 고쳐 쓰고 목록만 화면 상태로 넘긴다. */
  const transcriptRef = useRef(emptyTranscriptLog());
  /** 지금 통화의 번호. 이 통화의 말풍선만 「통역 중…」을 보인다. */
  const [currentCall, setCurrentCall] = useState(0);
  /** 지금 통화를 연 언어 짝. 새 말풍선에 붙인다. */
  const pairRef = useRef<Settings>(settings);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mine: mine.code, theirs: theirs.code }));
  }, [mine, theirs]);

  const handleTranscript = useCallback((transcript: InterpreterTranscript) => {
    transcriptRef.current = addTranscript(transcriptRef.current, transcript, pairRef.current);
    setEntries(transcriptRef.current.entries);
  }, []);

  const call = useInterpreterCall(handleTranscript);
  const active = call.state === "connecting" || call.state === "live" || call.state === "working";

  const startCall = (pair: Settings) => {
    pairRef.current = pair;
    transcriptRef.current = beginTranscriptCall(transcriptRef.current);
    setCurrentCall(transcriptRef.current.call);
    call.start(pair.mine, pair.theirs);
  };

  /** 통화 중에 언어를 바꾸면 새 짝으로 다시 연결한다. 이미 열린 통화의 지시는 바꿀 수 없다. */
  const changePair = (next: Settings) => {
    if (next.mine.code === next.theirs.code) return;
    setSettings(next);
    if (active) startCall(next);
  };

  // 대화 화면으로 돌아가면 통화(마이크)를 끝낸다. 화면이 사라질 때는 훅이 정리한다.
  const { stop } = call;
  useEffect(() => {
    if (!visible) stop();
  }, [stop, visible]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [entries]);

  const unsupported = call.supported === false;
  const insecure = typeof window !== "undefined" && !window.isSecureContext;
  const notice = call.state === "error" && call.failure
    ? failureText(tt, call.failure, call.detail)
    : insecure ? tt("translator.insecure") : unsupported ? tt("translator.unsupported") : null;
  const status = call.state === "connecting"
    ? tt("translator.connecting")
    : call.state === "live" || call.state === "working" ? tt("translator.live") : "";

  const languageOptions = (other: TranslatorLanguage) => TRANSLATOR_LANGUAGES.map((language) => (
    <option key={language.code} value={language.code} disabled={language.code === other.code}>{language.nativeName}</option>
  ));

  return (
    <section className="translator-view" aria-label={tt("translator.title")} hidden={!visible}>
      <header className="translator-header">
        {onBack ? (
          <ActionButton variant="ghost" size="small" onClick={onBack}>
            {tt("translator.back")}
          </ActionButton>
        ) : null}
        <h2 className="translator-title">{tt("translator.title")}</h2>
        <div className="translator-languages">
          <label className="translator-language">
            <span>{tt("translator.me")}</span>
            <select
              aria-label={tt("translator.myLanguage")}
              value={mine.code}
              onChange={(event) => {
                const language = findTranslatorLanguage(event.target.value);
                if (language) changePair({ mine: language, theirs });
              }}
            >
              {languageOptions(theirs)}
            </select>
          </label>
          <button
            type="button"
            className="translator-swap"
            aria-label={tt("translator.swap")}
            title={tt("translator.swap")}
            onClick={() => changePair({ mine: theirs, theirs: mine })}
          >
            ⇄
          </button>
          <label className="translator-language">
            <span>{tt("translator.them")}</span>
            <select
              aria-label={tt("translator.theirLanguage")}
              value={theirs.code}
              onChange={(event) => {
                const language = findTranslatorLanguage(event.target.value);
                if (language) changePair({ mine, theirs: language });
              }}
            >
              {languageOptions(mine)}
            </select>
          </label>
        </div>
        <div className="translator-actions">
          <ActionButton
            variant="ghost"
            size="small"
            disabled={entries.length === 0}
            onClick={() => {
              transcriptRef.current = clearTranscripts(transcriptRef.current);
              setEntries([]);
            }}
          >
            {tt("translator.clear")}
          </ActionButton>
        </div>
      </header>
      {notice ? (
        <p className="translator-banner" data-tone={call.state === "error" ? "danger" : undefined} role={call.state === "error" ? "alert" : "status"}>{notice}</p>
      ) : null}
      <div ref={logRef} className="translator-log" role="log" aria-label={tt("translator.conversation")}>
        {entries.length === 0 ? <p className="translator-empty">{tt("translator.empty")}</p> : null}
        {entries.map((entry) => {
          const spoken = spokenLanguage(entry);
          const target = spoken ? (spoken === entry.mine ? entry.theirs : entry.mine) : undefined;
          return (
            <div key={entry.id} className="translator-entry" data-side={spoken === entry.mine ? "me" : "them"}>
              <div className="translator-bubble">
                {entry.translation ? (
                  <p className="translator-translation" lang={target?.tag}>{entry.translation}</p>
                ) : active && entry.call === currentCall ? (
                  <p className="translator-pending">{tt("translator.translationPending")}</p>
                ) : null}
                {entry.original ? (
                  <p className="translator-original" lang={spoken?.tag}>
                    <span className="sr-only">{tt("translator.original")}: </span>
                    {entry.original}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="translator-dock">
        <p className="translator-status" role="status" aria-live="polite">{status}</p>
        <button
          type="button"
          className="translator-call-button"
          aria-pressed={active}
          disabled={!active && (unsupported || insecure || call.supported === null)}
          onClick={() => (active ? call.stop() : startCall(settings))}
        >
          <MicIcon />
          {active ? tt("translator.stop") : tt("translator.start")}
        </button>
      </div>
    </section>
  );
}

interface TranslatorPanelProps {
  /** 좁은 화면 드로어에서만 준다. 드로어를 닫고 뒤의 통역 화면을 보여 준다. */
  onOpen?: () => void;
}

/** 사이드바 「통역」 보기의 내용. 조작은 모두 가운데 통역 화면에 있고 여기는 안내만 한다. */
export function TranslatorPanel({ onOpen }: TranslatorPanelProps) {
  const { tt } = useTranslatorText();
  return (
    <div id="navigator-translator-panel" className="translator-panel">
      <p className="translator-panel-hint">{tt("translator.panelHint")}</p>
      {onOpen ? (
        <button type="button" className="translator-panel-open" onClick={onOpen}>
          {tt("translator.open")}
        </button>
      ) : null}
    </div>
  );
}
