"use client";

import { ActionButton } from "@seed-design/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  HISTORY_MAX_LINES,
  PARTNER_AGES,
  SPEAKER_AGES,
  SPEAKER_GENDERS,
  TRANSLATOR_MOODS,
  parseInterpreterProfile,
  type InterpreterProfile,
} from "@/lib/translator-context";
import {
  TRANSLATOR_LANGUAGES,
  findTranslatorLanguage,
  type TranslatorLanguage,
} from "@/lib/translator-languages";
import { splitNumberSpans } from "@/lib/translator-numbers";
import { useTranslatorText, type TranslatorTranslate } from "./i18n";
import {
  addTranscript,
  beginTranscriptCall,
  clearTranscripts,
  emptyTranscriptLog,
  segmentLanguage,
  segmentSpeaker,
  transcriptHistory,
  type HistoryLine,
  type TranscriptSegment,
} from "./transcript-log";
import { useInterpreterCall, type InterpreterTranscript } from "./useInterpreterCall";

/**
 * 통역 모드. 사이드바 「통역」 보기가 켜지면 작업 대화 칸 위에 덮인다. 「통역 시작」은 세션 없는
 * Codex 라이브 통화(`/api/live/interpret`)를 열고, 두 사람이 번갈아 말하면 통화 모델이 상대 언어로
 * 바로 소리 내어 옮긴다. 화면은 그 통화의 전사를 들은 말(원문)과 모델이 말한 것(통역)의 두 흐름으로
 * 따로 보인다. 통화는 어느 통역이 어느 원문의 것인지 알려 주지 않으므로 둘을 짝짓지 않는다. 기록은
 * 이 화면이 떠 있는 동안만 메모리에 두며 서버·세션에 저장하지 않는다. 통화를 새로 열 때(재연결·언어
 * 변경)만 최근 줄을 그 통화의 지시에 실어 앞 맥락을 잇는다.
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
  /** 통역 음성이 나오는 동안 마이크를 막는다(`lib/interpreter-echo-gate.ts`). 폰 스피커로 쓰는 것이 보통이라 처음 값은 켬이다. */
  echoGuard: boolean;
}

function readSettings(): Settings {
  const fallback: Settings = {
    mine: TRANSLATOR_LANGUAGES[0],
    theirs: TRANSLATOR_LANGUAGES[1],
    profile: {},
    face: false,
    size: DEFAULT_TEXT_SIZE,
    echoGuard: true,
  };
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null") as Record<string, unknown> | null;
    if (!saved || typeof saved !== "object") return fallback;
    const mine = findTranslatorLanguage(saved.mine) ?? fallback.mine;
    const theirs = findTranslatorLanguage(saved.theirs) ?? fallback.theirs;
    const pair = mine.code === theirs.code ? { mine: fallback.mine, theirs: fallback.theirs } : { mine, theirs };
    const size = typeof saved.size === "number" && Number.isInteger(saved.size) && saved.size >= 0 && saved.size < TEXT_SCALES.length
      ? saved.size
      : DEFAULT_TEXT_SIZE;
    return {
      ...pair,
      profile: parseInterpreterProfile(saved.profile),
      face: saved.face === true,
      size,
      echoGuard: saved.echoGuard !== false,
    };
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

/** 마주보기 화면에 한쪽마다 보이는 최근 말 수. */
const FACE_LINES = 3;

interface FacePaneProps {
  segments: TranscriptSegment[];
  /** 이 칸의 지금 언어. 그 언어로 된 조각과 언어를 가를 수 없는 조각만 보인다. */
  language: TranslatorLanguage;
  /** 언어를 가를 수 없는 조각(숫자·이름만 있는 말)에 붙이는 표시. */
  unknownLabel: string;
  flipped?: boolean;
  /** 아직 말이 없을 때 이 칸에 보일 안내. 화면 언어로 쓰므로 내 쪽 칸에만 준다. */
  emptyHint?: string;
}

/**
 * 마주보기 한쪽: 들은 말이든 통역이든 이 칸 언어로 된 조각을 생긴 차례대로 보인다. 조각의 언어는 그
 * 조각의 글자로만 가르고, 가를 수 없으면 두 칸 모두에 「언어 모름」을 붙여 보인다.
 */
function FacePane({ segments, language, unknownLabel, flipped, emptyHint }: FacePaneProps) {
  // 언어를 가를 수 없는 조각은 그 조각의 언어 짝과 상관없이 두 칸 모두에 보인다.
  const lines = segments
    .map((segment) => ({ segment, known: segmentLanguage(segment) }))
    .filter(({ known }) => known === undefined || known.code === language.code)
    .slice(-FACE_LINES);
  return (
    <div className="translator-face-pane" data-flipped={flipped ? "true" : undefined} lang={language.tag}>
      <p className="translator-face-label">{language.nativeName}</p>
      <div className="translator-face-lines">
        {lines.length === 0 && emptyHint ? <p className="translator-face-empty">{emptyHint}</p> : null}
        {lines.map(({ segment, known }, index) => (
          <p
            key={segment.id}
            className="translator-face-line"
            data-latest={index === lines.length - 1 ? "true" : undefined}
            data-side={segmentSpeaker(segment) ?? "them"}
            data-language={known ? undefined : "unknown"}
            lang={known ? undefined : ""}
          >
            {known ? null : <span className="translator-face-unknown">{unknownLabel}</span>}
            <NumberMarked text={segment.text} />
          </p>
        ))}
      </div>
    </div>
  );
}

/** 숫자와 붙은 단위를 강조해 받아쓰기가 틀린 숫자를 바로 알아보게 한다. 값은 바꾸지 않는다. */
function NumberMarked({ text }: { text: string }) {
  return (
    <>
      {splitNumberSpans(text).map((span, index) =>
        span.number ? (
          <span key={index} className="translator-number">
            {span.text}
          </span>
        ) : (
          span.text
        ),
      )}
    </>
  );
}

/** 맨 아래에서 이만큼(px) 안이면 맨 아래를 보고 있는 것으로 친다. */
const STICK_THRESHOLD = 32;

interface StreamLogProps {
  role: TranscriptSegment["role"];
  label: string;
  segments: TranscriptSegment[];
  /** 이 흐름 맨 끝에 보일 진행 표시. */
  pending: string | null;
  jumpLabel: string;
  /** 글자 크기·설정 칸처럼 칸 높이를 바꾸는 값. 바뀌면 맨 아래를 보던 칸은 다시 맨 아래로 간다. */
  layoutKey: string;
}

/**
 * 한 역할의 흐름(통역 또는 원문). 새 글이 오면 맨 아래를 보고 있을 때만 따라 내려가고, 위로 올려 읽는
 * 중이면 자리를 지키고 「최근 말로」 단추를 보인다.
 */
function StreamLog({ role, label, segments, pending, jumpLabel, layoutKey }: StreamLogProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [behind, setBehind] = useState(false);

  useEffect(() => {
    const log = logRef.current;
    if (log && stickRef.current) log.scrollTop = log.scrollHeight;
  }, [segments, pending, layoutKey]);

  const onScroll = () => {
    const log = logRef.current;
    if (!log) return;
    stickRef.current = log.scrollHeight - log.scrollTop - log.clientHeight <= STICK_THRESHOLD;
    setBehind(!stickRef.current);
  };

  return (
    <section className="translator-stream" data-role={role} aria-label={label}>
      <h3 className="translator-stream-label">{label}</h3>
      <div ref={logRef} className="translator-log" role="log" aria-label={label} onScroll={onScroll}>
        {segments.map((segment, index) => {
          const language = segmentLanguage(segment);
          return (
            <div
              key={segment.id}
              className="translator-entry"
              data-side={segmentSpeaker(segment) ?? "them"}
              data-latest={index === segments.length - 1 ? "true" : undefined}
            >
              <div className="translator-bubble">
                <p className={role === "assistant" ? "translator-translation" : "translator-original"} lang={language?.tag}>
                  <NumberMarked text={segment.text} />
                </p>
              </div>
            </div>
          );
        })}
        {pending ? <p className="translator-pending">{pending}</p> : null}
      </div>
      {behind ? (
        <button
          type="button"
          className="translator-jump"
          onClick={() => {
            const log = logRef.current;
            if (log) log.scrollTop = log.scrollHeight;
          }}
        >
          {jumpLabel}
        </button>
      ) : null}
    </section>
  );
}

interface TranslatorViewProps {
  visible?: boolean;
  onBack?: () => void;
}

export function TranslatorView({ visible = true, onBack }: TranslatorViewProps) {
  const { tt, locale } = useTranslatorText();
  const [settings, setSettings] = useState(readSettings);
  const { mine, theirs, profile, face, size, echoGuard } = settings;
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  /** 통역 중에 접어 둔 언어·상황 설정을 다시 펼쳤는지. 통역을 시작하면 접는다. */
  const [setupOpen, setSetupOpen] = useState(false);
  /** 두 흐름의 조각과 역할별 열린 턴. 전사가 올 때마다 고쳐 쓰고 조각 목록만 화면 상태로 넘긴다. */
  const transcriptRef = useRef(emptyTranscriptLog());
  /** 지금 통화의 번호. 이 통화에서 들은 말이 통역을 기다릴 때만 「옮기는 중」이다. */
  const [currentCall, setCurrentCall] = useState(0);
  /** 지금 통화를 연 언어 짝. 새 조각에 붙인다. */
  const pairRef = useRef<Settings>(settings);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      mine: mine.code,
      theirs: theirs.code,
      profile,
      face,
      size,
      echoGuard,
    }));
  }, [echoGuard, face, mine, profile, size, theirs]);

  const handleTranscript = useCallback((transcript: InterpreterTranscript) => {
    transcriptRef.current = addTranscript(transcriptRef.current, transcript, pairRef.current);
    setSegments(transcriptRef.current.segments);
  }, []);

  const getHistory = useCallback((): HistoryLine[] => transcriptHistory(transcriptRef.current, HISTORY_MAX_LINES), []);

  const handleReconnect = useCallback(() => {
    transcriptRef.current = beginTranscriptCall(transcriptRef.current);
    setCurrentCall(transcriptRef.current.call);
  }, []);

  const call = useInterpreterCall({ onTranscript: handleTranscript, getHistory, onReconnect: handleReconnect, muteMicWhilePlaying: echoGuard });
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

  const { prepare, supported, stop } = call;
  // 끊기는 값이 바뀔 때만 일어나야 한다. 훅이 새 `stop`을 돌려줄 때마다 돌면 진행 중인 통화를 끊는다.
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  });

  // 대화 화면으로 돌아가면 통화(마이크)를 끝낸다. 화면이 사라질 때는 훅이 정리한다.
  useEffect(() => {
    if (!visible) stopRef.current();
  }, [visible]);

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

  const unsupported = call.supported === false;
  const insecure = typeof window !== "undefined" && !window.isSecureContext;
  const notice = call.state === "error" && call.failure
    ? failureText(tt, call.failure, call.detail)
    : call.skipped && active ? tt("translator.generationSkipped")
    : call.ended === "idle" && !active ? tt("translator.idleStopped")
    : insecure ? tt("translator.insecure") : unsupported ? tt("translator.unsupported") : null;

  // 지금 통화에서 가장 나중에 생긴 조각이 들은 말이면 아직 그 뒤 통역이 오지 않은 것이다.
  const latest = segments.at(-1);
  const awaitingTranslation = active && latest !== undefined && latest.call === currentCall && latest.role === "user";
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
  const translations = useMemo(() => segments.filter((segment) => segment.role === "assistant"), [segments]);
  const originals = useMemo(() => segments.filter((segment) => segment.role === "user"), [segments]);
  const layoutKey = `${size}|${showSetup ? "setup" : ""}|${active ? "active" : ""}`;
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
          <FacePane segments={segments} language={theirs} unknownLabel={tt("translator.unknownLanguage")} flipped />
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
          <FacePane
            segments={segments}
            language={mine}
            unknownLabel={tt("translator.unknownLanguage")}
            emptyHint={active ? undefined : tt("translator.empty")}
          />
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
            <div className="translator-context">
              <label className="translator-language">
                <span>{tt("translator.partnerGender")}</span>
                <select
                  value={profile.partnerGender ?? ""}
                  onChange={(event) => changeProfile({ partnerGender: event.target.value as InterpreterProfile["partnerGender"] })}
                >
                  <option value="">{tt("translator.notSet")}</option>
                  {SPEAKER_GENDERS.map((gender) => (
                    <option key={gender} value={gender}>{tt(`translator.gender.${gender}`)}</option>
                  ))}
                </select>
              </label>
              <label className="translator-language">
                <span>{tt("translator.partnerAge")}</span>
                <select
                  value={profile.partnerAge ?? ""}
                  onChange={(event) => changeProfile({ partnerAge: event.target.value as InterpreterProfile["partnerAge"] })}
                >
                  <option value="">{tt("translator.notSet")}</option>
                  {PARTNER_AGES.map((age) => (
                    <option key={age} value={age}>{tt(`translator.partnerAge.${age}`)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="translator-options">
              <label className="translator-toggle">
                <input
                  type="checkbox"
                  checked={echoGuard}
                  aria-describedby="translator-echo-guard-hint"
                  onChange={(event) => setSettings({ ...settings, echoGuard: event.target.checked })}
                />
                <span>{tt("translator.echoGuard")}</span>
              </label>
              <p id="translator-echo-guard-hint" className="translator-options-note">{tt("translator.echoGuardHint")}</p>
            </div>
            {segments.length > 0 ? (
              <ActionButton
                variant="ghost"
                size="small"
                className="translator-clear"
                onClick={() => {
                  transcriptRef.current = clearTranscripts(transcriptRef.current);
                  setSegments([]);
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
      {segments.length === 0 && !active ? (
        <div className="translator-log">
          <p className="translator-empty">{tt("translator.empty")}</p>
        </div>
      ) : (
        <div className="translator-streams" aria-label={tt("translator.conversation")}>
          <StreamLog
            role="assistant"
            label={tt("translator.translation")}
            segments={translations}
            pending={phase === "translating" ? tt("translator.translationPending") : null}
            jumpLabel={tt("translator.jumpLatest")}
            layoutKey={layoutKey}
          />
          <StreamLog
            role="user"
            label={tt("translator.original")}
            segments={originals}
            pending={null}
            jumpLabel={tt("translator.jumpLatest")}
            layoutKey={layoutKey}
          />
        </div>
      )}
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
