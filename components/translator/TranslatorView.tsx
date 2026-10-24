"use client";

import { ActionButton } from "@seed-design/react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  HISTORY_MAX_TURNS,
  SPEAKER_AGES,
  SPEAKER_GENDERS,
  TRANSLATOR_MOODS,
  parseInterpreterProfile,
  type InterpreterProfile,
  type InterpreterTurn,
} from "@/lib/translator-context";
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
 * 통역이다. 기록은 이 화면이 떠 있는 동안만 메모리에 두며 서버·세션에 저장하지 않는다. 통화를 새로
 * 열 때(재연결·언어 변경)만 최근 대화를 그 통화의 지시에 실어 앞 맥락을 잇는다.
 *
 * 「마주보기」는 화면을 위아래로 나눠 위쪽을 뒤집어 보인다. 폰을 탁자에 두면 맞은편 사람은 위쪽에서
 * 자기 언어로, 나는 아래쪽에서 내 언어로 대화를 읽는다.
 */

const SETTINGS_KEY = "cuelo-translator";

/** 대화 글자 배율 3단계. 폰을 사이에 두고 팔 길이에서 읽을 때 키운다. */
const TEXT_SCALES = [0.85, 1, 1.3] as const;
const DEFAULT_TEXT_SIZE = 1;

interface Settings {
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  profile: InterpreterProfile;
  face: boolean;
  /** `TEXT_SCALES`의 칸 번호. */
  size: number;
}

function readSettings(): Settings {
  const fallback: Settings = { mine: TRANSLATOR_LANGUAGES[0], theirs: TRANSLATOR_LANGUAGES[1], profile: {}, face: false, size: DEFAULT_TEXT_SIZE };
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null") as Record<string, unknown> | null;
    if (!saved || typeof saved !== "object") return fallback;
    const mine = findTranslatorLanguage(saved.mine) ?? fallback.mine;
    const theirs = findTranslatorLanguage(saved.theirs) ?? fallback.theirs;
    const pair = mine.code === theirs.code ? { mine: fallback.mine, theirs: fallback.theirs } : { mine, theirs };
    const size = typeof saved.size === "number" && Number.isInteger(saved.size) && saved.size >= 0 && saved.size < TEXT_SCALES.length
      ? saved.size
      : DEFAULT_TEXT_SIZE;
    return { ...pair, profile: parseInterpreterProfile(saved.profile), face: saved.face === true, size };
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

function StopIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

/** 마주보기: 화면을 위아래로 나누고 위쪽 글자가 거꾸로 선 모양. */
function FaceIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
      <path d="M5 12h14M9 7.5h6M9 16.5h6M12 5.5v2M12 16.5v2" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** 화면이 보이는 통역 단계. 색 점과 글로 함께 보인다. */
type Phase = "idle" | "connecting" | "reconnecting" | "listening" | "translating" | "error";

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

/**
 * 말풍선의 글을 그 언어로: 그 언어로 말했으면 원문, 그 언어로 통역됐으면 통역. 언어를 바꾸기 전의
 * 다른 짝으로 생겨 그 언어가 없는 말풍선은 `null`이다. 말한 언어를 모르면 있는 쪽을 쓴다.
 */
function entryTextIn(entry: TranscriptEntry, code: string): string | null {
  if (entry.mine.code !== code && entry.theirs.code !== code) return null;
  const spoken = spokenLanguage(entry);
  if (!spoken) return entry.translation || entry.original;
  return spoken.code === code ? entry.original : entry.translation;
}

/** 마주보기 화면에 한쪽마다 보이는 최근 말 수. */
const FACE_LINES = 3;

interface FacePaneProps {
  entries: TranscriptEntry[];
  /** 이 칸의 지금 언어. 그 언어가 든 말풍선만 보인다. */
  language: TranslatorLanguage;
  flipped?: boolean;
  /** 아직 말이 없을 때 이 칸에 보일 안내. 화면 언어로 쓰므로 내 쪽 칸에만 준다. */
  emptyHint?: string;
}

function FacePane({ entries, language, flipped, emptyHint }: FacePaneProps) {
  const lines = entries
    .map((entry) => ({ entry, text: entryTextIn(entry, language.code) }))
    .filter((line) => line.text !== null)
    .slice(-FACE_LINES);
  return (
    <div className="translator-face-pane" data-flipped={flipped ? "true" : undefined} lang={language.tag}>
      <p className="translator-face-label">{language.nativeName}</p>
      <div className="translator-face-lines">
        {lines.length === 0 && emptyHint ? <p className="translator-face-empty">{emptyHint}</p> : null}
        {lines.map(({ entry, text }, index) => (
          <p
            key={entry.id}
            className="translator-face-line"
            data-latest={index === lines.length - 1 ? "true" : undefined}
            data-side={spokenLanguage(entry)?.code === entry.mine.code ? "me" : "them"}
          >
            {text || "…"}
          </p>
        ))}
      </div>
    </div>
  );
}

interface TranslatorViewProps {
  visible?: boolean;
  onBack?: () => void;
}

export function TranslatorView({ visible = true, onBack }: TranslatorViewProps) {
  const { tt, locale } = useTranslatorText();
  const [settings, setSettings] = useState(readSettings);
  const { mine, theirs, profile, face, size } = settings;
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  /** 통역 중에 접어 둔 언어·상황 설정을 다시 펼쳤는지. 통역을 시작하면 접는다. */
  const [setupOpen, setSetupOpen] = useState(false);
  /** 말풍선 목록과 열린 차례. 전사가 올 때마다 고쳐 쓰고 목록만 화면 상태로 넘긴다. */
  const transcriptRef = useRef(emptyTranscriptLog());
  /** 지금 통화의 번호. 이 통화의 말풍선만 「통역 중…」을 보인다. */
  const [currentCall, setCurrentCall] = useState(0);
  /** 지금 통화를 연 언어 짝. 새 말풍선에 붙인다. */
  const pairRef = useRef<Settings>(settings);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mine: mine.code, theirs: theirs.code, profile, face, size }));
  }, [face, mine, profile, size, theirs]);

  const handleTranscript = useCallback((transcript: InterpreterTranscript) => {
    transcriptRef.current = addTranscript(transcriptRef.current, transcript, pairRef.current);
    setEntries(transcriptRef.current.entries);
  }, []);

  const getHistory = useCallback((): InterpreterTurn[] => transcriptRef.current.entries
    .filter((entry) => entry.original && entry.translation)
    .slice(-HISTORY_MAX_TURNS)
    .map((entry) => ({
      speaker: spokenLanguage(entry)?.code === entry.mine.code ? "me" : "them",
      original: entry.original,
      translation: entry.translation,
    })), []);

  const handleReconnect = useCallback(() => {
    transcriptRef.current = beginTranscriptCall(transcriptRef.current);
    setCurrentCall(transcriptRef.current.call);
  }, []);

  const call = useInterpreterCall({ onTranscript: handleTranscript, getHistory, onReconnect: handleReconnect });
  const active = call.state === "connecting" || call.state === "live" || call.state === "working";

  const startCall = (next: Settings) => {
    pairRef.current = next;
    transcriptRef.current = beginTranscriptCall(transcriptRef.current);
    setCurrentCall(transcriptRef.current.call);
    call.start(next.mine, next.theirs, next.profile);
  };

  /** 통화 중에 언어나 분위기·화자를 바꾸면 새 설정으로 다시 연결한다. 이미 열린 통화의 지시는 바꿀 수 없다. */
  const changeCallSettings = (next: Settings) => {
    if (next.mine.code === next.theirs.code) return;
    setSettings(next);
    if (active) startCall(next);
  };

  const changeProfile = (patch: Partial<InterpreterProfile>) => {
    changeCallSettings({ ...settings, profile: parseInterpreterProfile({ ...profile, ...patch }) });
  };

  // 대화 화면으로 돌아가면 통화(마이크)를 끝낸다. 화면이 사라질 때는 훅이 정리한다.
  const { prepare, stop, supported } = call;
  useEffect(() => {
    if (!visible) stop();
  }, [stop, visible]);

  // 화면이 열려 있고 통역 중이 아니면 고른 설정으로 통화를 미리 열어 둔다. 마이크는 열지 않고
  // (「통역 시작」에서야 켠다) 연결만 해 두어, 시작을 누르면 신호 교환을 기다리지 않는다.
  useEffect(() => {
    if (visible && !active && supported === true && window.isSecureContext) prepare(mine, theirs, profile);
  }, [active, mine, prepare, profile, supported, theirs, visible]);

  // 통역 중에는 화면이 꺼지지 않게 한다. 폰 화면이 꺼지면 홈 화면 앱은 마이크를 놓는다. 다른 앱에
  // 갔다 오면 브라우저가 잠금을 풀므로 화면이 다시 보일 때 다시 건다. 지원하지 않으면 그냥 넘어간다.
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      navigator.wakeLock.request("screen").then((sentinel) => {
        if (cancelled) void sentinel.release();
        else lock = sentinel;
      }).catch(() => {
        // Denied (battery saver, unsupported context): the screen may dim as usual.
      });
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
    };
  }, [active]);

  // 새 말이 오거나 글자 크기·보기가 바뀌면 맨 아래(방금 한 말)를 보인다.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [entries, face, size, setupOpen, active]);

  const unsupported = call.supported === false;
  const insecure = typeof window !== "undefined" && !window.isSecureContext;
  const notice = call.state === "error" && call.failure
    ? failureText(tt, call.failure, call.detail)
    : call.ended === "idle" && !active ? tt("translator.idleStopped")
    : insecure ? tt("translator.insecure") : unsupported ? tt("translator.unsupported") : null;

  // 지금 통화의 마지막 말풍선이 통역을 기다리면 「옮기는 중」이다.
  const latest = entries.length > 0 ? entries[entries.length - 1] : null;
  const awaitingTranslation = active && latest !== null && latest.call === currentCall && !latest.translation;
  const phase: Phase = call.state === "error"
    ? "error"
    : call.reconnecting ? "reconnecting"
    : call.state === "connecting" ? "connecting"
    : call.state === "live" || call.state === "working" ? (awaitingTranslation ? "translating" : "listening")
    : "idle";
  const status = phase === "reconnecting" ? tt("translator.reconnecting")
    : phase === "connecting" ? tt("translator.connecting")
    : phase === "translating" ? tt("translator.translating")
    : phase === "listening" ? tt("translator.live")
    : phase === "error" ? tt("translator.errorStatus")
    : "";

  const showSetup = !active || setupOpen;
  const scaleStyle = { "--translator-scale": String(TEXT_SCALES[size] ?? 1) } as CSSProperties;
  const sizeGlyph = locale === "ko" ? "가" : "A";
  const canStart = active || !(unsupported || insecure || call.supported === null);
  const toggleCall = () => {
    if (active) {
      call.stop();
      return;
    }
    setSetupOpen(false);
    startCall(settings);
  };

  const languageOptions = (other: TranslatorLanguage) => TRANSLATOR_LANGUAGES.map((language) => (
    <option key={language.code} value={language.code} disabled={language.code === other.code}>{language.nativeName}</option>
  ));

  const statusLine = (
    <p className="translator-status" data-phase={phase} role="status" aria-live="polite">
      {phase === "idle" ? null : <span className="translator-status-dot" aria-hidden="true" />}
      {status}
    </p>
  );

  const callButton = (compact: boolean) => (
    <button
      type="button"
      className="translator-call-button"
      data-compact={compact ? "true" : undefined}
      aria-pressed={active}
      disabled={!canStart}
      onClick={toggleCall}
    >
      {active ? <StopIcon /> : <MicIcon />}
      {active ? tt("translator.stop") : tt("translator.start")}
    </button>
  );

  if (face) {
    return (
      <section className="translator-view" data-face="true" aria-label={tt("translator.title")} hidden={!visible} style={scaleStyle}>
        <h2 className="sr-only">{tt("translator.title")}</h2>
        <div className="translator-face" role="log" aria-label={tt("translator.conversation")}>
          <FacePane entries={entries} language={theirs} flipped />
          <div className="translator-face-bar">
            {notice ? (
              <p className="translator-face-notice" data-tone={call.state === "error" ? "danger" : undefined} role={call.state === "error" ? "alert" : "status"}>{notice}</p>
            ) : null}
            {phase === "idle" ? null : statusLine}
            <div className="translator-face-controls">
              {callButton(true)}
              <button
                type="button"
                className="translator-face-exit"
                onClick={() => setSettings({ ...settings, face: false })}
              >
                <CloseIcon />
                {tt("translator.faceExit")}
              </button>
            </div>
          </div>
          <FacePane entries={entries} language={mine} emptyHint={active ? undefined : tt("translator.empty")} />
        </div>
      </section>
    );
  }

  return (
    <section className="translator-view" data-active={active ? "true" : undefined} aria-label={tt("translator.title")} hidden={!visible} style={scaleStyle}>
      <header className="translator-header">
        <div className="translator-bar">
          {onBack ? (
            <button type="button" className="translator-icon-button" aria-label={tt("translator.back")} title={tt("translator.back")} onClick={onBack}>
              <BackIcon />
            </button>
          ) : null}
          {active ? (
            <>
              <h2 className="sr-only">{tt("translator.title")}</h2>
              <button
                type="button"
                className="translator-pair"
                aria-expanded={setupOpen}
                aria-controls="translator-setup"
                aria-label={`${tt("translator.setup")}: ${mine.nativeName} ⇄ ${theirs.nativeName}`}
                onClick={() => setSetupOpen((open) => !open)}
              >
                <span className="translator-pair-text">
                  <span lang={mine.tag}>{mine.nativeName}</span>
                  <span aria-hidden="true"> ⇄ </span>
                  <span lang={theirs.tag}>{theirs.nativeName}</span>
                </span>
                <ChevronIcon />
              </button>
            </>
          ) : (
            <h2 className="translator-title">{tt("translator.title")}</h2>
          )}
          <div className="translator-tools">
            <button
              type="button"
              className="translator-icon-button translator-size-button"
              aria-label={tt("translator.sizeDown")}
              title={tt("translator.sizeDown")}
              disabled={size <= 0}
              onClick={() => setSettings({ ...settings, size: Math.max(0, size - 1) })}
            >
              <span aria-hidden="true" data-size="down">{sizeGlyph}</span>
            </button>
            <button
              type="button"
              className="translator-icon-button translator-size-button"
              aria-label={tt("translator.sizeUp")}
              title={tt("translator.sizeUp")}
              disabled={size >= TEXT_SCALES.length - 1}
              onClick={() => setSettings({ ...settings, size: Math.min(TEXT_SCALES.length - 1, size + 1) })}
            >
              <span aria-hidden="true" data-size="up">{sizeGlyph}</span>
            </button>
            <button
              type="button"
              className="translator-icon-button"
              aria-pressed={false}
              aria-label={tt("translator.face")}
              title={tt("translator.faceHint")}
              onClick={() => setSettings({ ...settings, face: true })}
            >
              <FaceIcon />
            </button>
          </div>
        </div>
        {showSetup ? (
          <div id="translator-setup" className="translator-setup">
            <div className="translator-languages">
              <label className="translator-language">
                <span>{tt("translator.me")}</span>
                <select
                  aria-label={tt("translator.myLanguage")}
                  value={mine.code}
                  onChange={(event) => {
                    const language = findTranslatorLanguage(event.target.value);
                    if (language) changeCallSettings({ ...settings, mine: language });
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
                onClick={() => changeCallSettings({ ...settings, mine: theirs, theirs: mine })}
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
                    if (language) changeCallSettings({ ...settings, theirs: language });
                  }}
                >
                  {languageOptions(mine)}
                </select>
              </label>
            </div>
            <div className="translator-context">
              <label className="translator-language">
                <span>{tt("translator.mood")}</span>
                <select
                  value={profile.mood ?? ""}
                  onChange={(event) => changeProfile({ mood: event.target.value as InterpreterProfile["mood"] })}
                >
                  <option value="">{tt("translator.notSet")}</option>
                  {TRANSLATOR_MOODS.map((mood) => (
                    <option key={mood} value={mood}>{tt(`translator.mood.${mood}`)}</option>
                  ))}
                </select>
              </label>
              <label className="translator-language">
                <span>{tt("translator.gender")}</span>
                <select
                  value={profile.gender ?? ""}
                  onChange={(event) => changeProfile({ gender: event.target.value as InterpreterProfile["gender"] })}
                >
                  <option value="">{tt("translator.notSet")}</option>
                  {SPEAKER_GENDERS.map((gender) => (
                    <option key={gender} value={gender}>{tt(`translator.gender.${gender}`)}</option>
                  ))}
                </select>
              </label>
              <label className="translator-language">
                <span>{tt("translator.age")}</span>
                <select
                  value={profile.age ?? ""}
                  onChange={(event) => changeProfile({ age: event.target.value as InterpreterProfile["age"] })}
                >
                  <option value="">{tt("translator.notSet")}</option>
                  {SPEAKER_AGES.map((age) => (
                    <option key={age} value={age}>{tt(`translator.age.${age}`)}</option>
                  ))}
                </select>
              </label>
            </div>
            {entries.length > 0 ? (
              <ActionButton
                variant="ghost"
                size="small"
                className="translator-clear"
                onClick={() => {
                  transcriptRef.current = clearTranscripts(transcriptRef.current);
                  setEntries([]);
                }}
              >
                {tt("translator.clear")}
              </ActionButton>
            ) : null}
          </div>
        ) : null}
      </header>
      {notice ? (
        <p className="translator-banner" data-tone={call.state === "error" ? "danger" : undefined} role={call.state === "error" ? "alert" : "status"}>{notice}</p>
      ) : null}
      <div ref={logRef} className="translator-log" role="log" aria-label={tt("translator.conversation")}>
        {entries.length === 0 && !active ? <p className="translator-empty">{tt("translator.empty")}</p> : null}
        {entries.map((entry, index) => {
          const spoken = spokenLanguage(entry);
          const target = spoken ? (spoken === entry.mine ? entry.theirs : entry.mine) : undefined;
          return (
            <div
              key={entry.id}
              className="translator-entry"
              data-side={spoken === entry.mine ? "me" : "them"}
              data-latest={index === entries.length - 1 ? "true" : undefined}
            >
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
        {statusLine}
        {callButton(active)}
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
