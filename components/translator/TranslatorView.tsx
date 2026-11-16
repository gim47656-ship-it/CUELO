"use client";

import { ActionButton } from "@seed-design/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
  partnerHint,
  type TranslatorLanguage,
} from "@/lib/translator-languages";
import { hasNumericMismatch, splitNumberSpans } from "@/lib/translator-numbers";
import { mergeDisplay, type DisplayLine } from "@/lib/translator-draft";
import { Keyboard, MoreVertical, Settings2, Trash2 } from "lucide-react";
import { useTranslatorText, type TranslatorTranslate } from "./i18n";
import {
  addTranscript,
  beginTranscriptCall,
  clearTranscripts,
  type TranscriptLog,
  segmentLanguage,
  speakerOf,
  segmentSpeaker,
  transcriptHistory,
  type HistoryLine,
  type TranscriptSegment,
} from "./transcript-log";
import { useInterpreterCall, type InterpreterTranscript } from "./useInterpreterCall";
import { useDraftCaptions } from "./useDraftCaptions";
import { useTypedInterpreter } from "./TypedInterpreter";
import { ConversationBubble } from "./ConversationBubble";
import { conversationTurns, type ConversationTurn } from "./conversation-display";
import type { Speech } from "./useSpeech";
import { CONVERSATION_KEY, formatConversation, restoreConversation, serializeConversation } from "./conversation-store";
import type { OverlayMarker } from "./overlay-history";
import { useOverlayHistory } from "./useOverlayHistory";
import { useStallLog } from "./useStallLog";
import { useSpeech } from "./useSpeech";
import { ShowCard, type ShowCardContent } from "./ShowCard";
import { Phrasebook } from "./Phrasebook";
import { CameraIcon, MenuScan } from "./MenuScan";
import { LineAssist } from "./LineAssist";
import { useLineAssist } from "./useLineAssist";

/**
 * 통역 모드. 사이드바 「통역」 보기가 켜지면 작업 대화 칸 위에 덮인다. 「통역 시작」은 세션 없는
 * Codex 라이브 통화(`/api/live/interpret`)를 열고, 두 사람이 번갈아 말하면 통화 모델이 상대 언어로
 * 바로 소리 내어 옮긴다. 화면은 그 통화의 전사를 들은 말(원문)과 모델이 말한 것(통역)의 두 흐름으로
 * 따로 보인다. 통화는 어느 통역이 어느 원문의 것인지 알려 주지 않으므로 둘을 짝짓지 않는다. 기록은
 * 이 폰의 localStorage에만 남기고(`conversation-store.ts`) 서버·세션에 저장하지 않는다. 통화를 새로
 * 열 때(재연결·언어 변경)만 이번 화면에서 생긴 최근 줄을 그 통화의 지시에 실어 앞 맥락을 잇는다.
 *
 * 마주보기·보여주기 카드·자주 쓰는 문장은 기록 칸을 하나씩 얹어 폰의 뒤로가기로 닫힌다
 * (`overlay-history.ts`).
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
  /** 통역 음성을 스피커로 낸다. 끄면 글로만 보고, 스피커가 조용하니 마이크도 막지 않는다. 처음 값은 끔이다. */
  voice: boolean;
  /** 음성을 켰을 때 통역 음성이 나오는 동안 마이크를 막는다(`lib/interpreter-echo-gate.ts`). 폰 스피커로 쓰는 것이 보통이라 처음 값은 켬이다. */
  echoGuard: boolean;
  /** 마이크 소리를 RNNoise로 거른 뒤 통역에 보낸다(`lib/interpreter-noise-suppressor.ts`). 목소리가 뭉개질 수 있어 처음 값은 끔이다. */
  noiseSuppression: boolean;
  /** 전용 번역 모델의 초안 자막을 먼저 띄운다(`lib/translator-draft.ts`). 켠 동안 추가 요금이 들 수 있어 처음 값은 끔이다. */
  fastDrafts: boolean;
  assistMeaning: boolean;
}

function readSettings(): Settings {
  const fallback: Settings = {
    mine: TRANSLATOR_LANGUAGES[0],
    theirs: TRANSLATOR_LANGUAGES[1],
    profile: {},
    face: false,
    size: DEFAULT_TEXT_SIZE,
    voice: false,
    echoGuard: true,
    noiseSuppression: false,
    fastDrafts: false,
    assistMeaning: true,
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
      voice: saved.voice === true,
      echoGuard: saved.echoGuard !== false,
      noiseSuppression: saved.noiseSuppression === true,
      fastDrafts: saved.fastDrafts === true,
      assistMeaning: saved.assistMeaning !== false,
    };
  } catch {
    return fallback;
  }
}

function readConversation(): TranscriptLog {
  try {
    return restoreConversation(window.localStorage.getItem(CONVERSATION_KEY));
  } catch {
    return restoreConversation(null);
  }
}

/** 대화를 이 폰에 남긴다. 글이 없으면 저장한 것을 지운다. 저장소가 막혀도 통역은 그대로 간다. */
function writeConversation(segments: readonly TranscriptSegment[]) {
  try {
    if (segments.some((segment) => segment.text.trim())) window.localStorage.setItem(CONVERSATION_KEY, serializeConversation(segments));
    else window.localStorage.removeItem(CONVERSATION_KEY);
  } catch {
    // Storage full or blocked: the conversation stays in memory for this visit.
  }
}

/** 전사가 쏟아지는 동안 매번 저장하면 화면이 버벅인다. 마지막 변경 뒤 이만큼(ms) 조용하면 저장한다. */
const CONVERSATION_SAVE_DELAY_MS = 800;
/** 공유·복사 결과 안내를 보이는 시간(ms). */
const SHARE_NOTICE_MS = 4000;

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

function ShareIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V4M8 8l4-4 4 4" />
      <path d="M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12" />
    </svg>
  );
}

/** 자주 쓰는 문장: 말풍선 안의 줄. */
function PhrasesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-7l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5z" />
      <path d="M8 9h8M8 12.5h5" />
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

type Line = DisplayLine<TranscriptSegment>;

/** 초안 자막은 언어를 알고, 그 밖의 조각은 글자로 가른다. */
const lineLanguage = (line: Line) => line.language ?? segmentLanguage(line.segment);
const lineSpeaker = (line: Line) => (line.language ? speakerOf(line.segment, line.language) : segmentSpeaker(line.segment));

interface FacePaneProps {
  lines: Line[];
  /** 이 칸의 지금 언어. 그 언어로 된 조각과 언어를 가를 수 없는 조각만 보인다. */
  language: TranslatorLanguage;
  /** 언어를 가를 수 없는 조각(숫자·이름만 있는 말)에 붙이는 표시. */
  unknownLabel: string;
  flipped?: boolean;
  /** 아직 말이 없을 때 이 칸에 보일 안내. 내 쪽 칸은 화면 언어, 상대 쪽 칸은 상대 언어로 쓴다. */
  emptyHint?: string;
  /** 줄을 누르면 그 줄을 보여주기 카드로 띄운다. */
  onShow: (card: ShowCardContent) => void;
  showLabel: string;
}

/**
 * 마주보기 한쪽: 들은 말이든 통역이든 이 칸 언어로 된 조각을 생긴 차례대로 보인다. 조각의 언어는 그
 * 조각의 글자로만 가르고, 가를 수 없으면 두 칸 모두에 「언어 모름」을 붙여 보인다. 초안 자막은
 * 어느 언어로 옮긴 것인지 알고 있어 그 칸에만 보인다.
 */
function FacePane({ lines: allLines, language, unknownLabel, flipped, emptyHint, onShow, showLabel }: FacePaneProps) {
  // 언어를 가를 수 없는 조각은 그 조각의 언어 짝과 상관없이 두 칸 모두에 보인다.
  const lines = allLines
    .map((line) => ({ line, known: lineLanguage(line) }))
    .filter(({ known }) => known === undefined || known.code === language.code)
    .slice(-FACE_LINES);
  return (
    <div className="translator-face-pane" data-flipped={flipped ? "true" : undefined} lang={language.tag}>
      <p className="translator-face-label">{language.nativeName}</p>
      <div className="translator-face-lines">
        {lines.length === 0 && emptyHint ? <p className="translator-face-empty">{emptyHint}</p> : null}
        {lines.map(({ line, known }, index) => (
          <button
            type="button"
            key={line.key}
            className="translator-face-line"
            title={showLabel}
            data-latest={index === lines.length - 1 ? "true" : undefined}
            data-side={lineSpeaker(line) ?? "them"}
            data-draft={line.draft ? "true" : undefined}
            data-language={known ? undefined : "unknown"}
            lang={known ? undefined : ""}
            onClick={() => onShow({ text: line.segment.text, language: known ?? language, flipped })}
          >
            {known ? null : <span className="translator-face-unknown">{unknownLabel}</span>}
            <NumberMarked text={line.segment.text} />
          </button>
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

interface ConversationLogProps {
  label: string;
  /** 들은 말과 통역을 생긴 차례대로 섞은 줄. */
  turns: ConversationTurn[];
  visible: boolean;
  /** 대화 맨 끝에 보일 진행 표시. */
  pending: string | null;
  jumpLabel: string;
  /** 글자 크기·설정 칸처럼 칸 높이를 바꾸는 값. 바뀌면 맨 아래를 보던 칸은 다시 맨 아래로 간다. */
  layoutKey: string;
  /** 통역 줄을 누르면 보여주기 카드로 띄운다. */
  onShow: (card: ShowCardContent) => void;
  speech: Speech;
  renderAssist: (turn: ConversationTurn) => ReactNode;
}

/**
 * 대화 한 줄기. 들은 말(원문)과 통역을 생긴 차례대로 말한 사람 쪽에 놓고, 같은 사람 쪽으로 이어지는 줄은
 * 붙여 한 턴처럼 보인다. 원문과 통역을 짝지어 글을 옮기지는 않는다(제공자가 짝을 알려 주지 않는다).
 * 새 글이 오면 맨 아래를 보고 있을 때만 따라 내려가고, 위로 올려 읽는 중이면 자리를 지키고 「최근 말로」
 * 단추를 보인다.
 */
function ConversationLog({ label, turns, visible, pending, jumpLabel, layoutKey, onShow, speech, renderAssist }: ConversationLogProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [behind, setBehind] = useState(false);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const pin = () => { if (stickRef.current) log.scrollTop = log.scrollHeight; };
    pin();
    // Readings and streamed text can resize existing bubbles without a new turn.
    const observer = new ResizeObserver(pin);
    for (const child of log.children) observer.observe(child);
    return () => observer.disconnect();
  }, [turns, pending, layoutKey]);

  const onScroll = () => {
    const log = logRef.current;
    if (!log) return;
    stickRef.current = log.scrollHeight - log.scrollTop - log.clientHeight <= STICK_THRESHOLD;
    setBehind(!stickRef.current);
  };


  return (
    <section className="translator-conversation" aria-label={label}>
      <div ref={logRef} className="translator-log" role="log" aria-label={label} onScroll={onScroll}>
        {turns.map((turn, index) => <ConversationBubble key={turn.key} turn={turn} latest={index === turns.length - 1}
          visible={visible} speech={speech} onShow={onShow} renderText={(text) => <NumberMarked text={text} />}>
          {renderAssist(turn)}
        </ConversationBubble>)}
        {pending ? <p className="translator-pending">{pending}</p> : null}
      </div>
      {behind ? (
        <button
          type="button"
          className="translator-jump"
          onClick={() => {
            const log = logRef.current;
            if (log) { stickRef.current = true; setBehind(false); log.scrollTop = log.scrollHeight; }
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
  const [typingOpen, setTypingOpen] = useState(false);
  const { mine, theirs, profile, face, size, voice, echoGuard, noiseSuppression, fastDrafts, assistMeaning } = settings;
  const typed = useTypedInterpreter({ mine, theirs, profile, visible, open: typingOpen, assistSettings: { meaning: assistMeaning } });
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!visible) return;
    const dismiss = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [visible]);
  const [restored] = useState(readConversation);
  const [segments, setSegments] = useState<TranscriptSegment[]>(restored.segments);
  /** 통역 중에 접어 둔 언어·상황 설정을 다시 펼쳤는지. 통역을 시작하면 접는다. */
  const [setupOpen, setSetupOpen] = useState(false);
  /** 두 흐름의 조각과 역할별 열린 턴. 전사가 올 때마다 고쳐 쓰고 조각 목록만 화면 상태로 넘긴다. */
  const transcriptRef = useRef(restored);
  /** 지금 통화의 번호. 이 통화에서 들은 말이 통역을 기다릴 때만 「옮기는 중」이다. */
  const [currentCall, setCurrentCall] = useState(0);
  /** 지금 통화를 연 언어 짝. 새 조각에 붙인다. */
  const pairRef = useRef<Settings>(settings);
  /** 크게 띄운 보여주기 카드. */
  const [card, setCard] = useState<ShowCardContent | null>(null);
  const [phrasesOpen, setPhrasesOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [shareNotice, setShareNotice] = useState<"copied" | "failed" | null>(null);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      mine: mine.code,
      theirs: theirs.code,
      profile,
      face,
      size,
      voice,
      echoGuard,
      noiseSuppression,
      fastDrafts,
      assistMeaning,
    }));
  }, [assistMeaning, echoGuard, face, fastDrafts, mine, noiseSuppression, profile, size, theirs, voice]);

  const reconcileDraftsRef = useRef<(segments: TranscriptSegment[]) => void>(() => {});

  const handleTranscript = useCallback((transcript: InterpreterTranscript) => {
    transcriptRef.current = addTranscript(transcriptRef.current, transcript, pairRef.current);
    setSegments(transcriptRef.current.segments);
    // Same event, so one render: a Codex segment and the draft it takes over never show together.
    reconcileDraftsRef.current(transcriptRef.current.segments);
  }, []);

  const getHistory = useCallback((): HistoryLine[] => transcriptHistory(transcriptRef.current, HISTORY_MAX_LINES), []);

  const handleReconnect = useCallback(() => {
    transcriptRef.current = beginTranscriptCall(transcriptRef.current);
    setCurrentCall(transcriptRef.current.call);
  }, []);

  const call = useInterpreterCall({ onTranscript: handleTranscript, getHistory, onReconnect: handleReconnect, muteMicWhilePlaying: echoGuard, playVoice: voice, suppressNoise: noiseSuppression });
  const active = call.state === "connecting" || call.state === "live" || call.state === "working";

  // 켠 동안 통화가 열려 있으면 전용 모델의 초안 자막을 받는다. 재연결·새 통화마다 처음부터 다시 연다.
  const drafts = useDraftCaptions({
    enabled: fastDrafts && active,
    epoch: currentCall,
    pairRef,
    segments,
    sendTrack: call.sendTrack,
    isBlocked: call.isBlocked, onBlockedChange: call.onBlockedChange,
  });

  const { reconcile: reconcileDrafts } = drafts;
  useEffect(() => {
    reconcileDraftsRef.current = reconcileDrafts;
  }, [reconcileDrafts]);

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
  useEffect(() => {
    if (visible) return;
    setCard(null);
    setPhrasesOpen(false);
    setScanOpen(false);
  }, [visible]);

  // 대화는 조용해진 뒤, 그리고 앱이 가려지거나 닫힐 때 이 폰에 남긴다.
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  useEffect(() => {
    const timer = window.setTimeout(() => writeConversation(segments), CONVERSATION_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [segments]);
  useEffect(() => {
    const flush = () => writeConversation(segmentsRef.current);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, []);

  useEffect(() => {
    if (!shareNotice) return;
    const timer = window.setTimeout(() => setShareNotice(null), SHARE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [shareNotice]);

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

  const showSetup = setupOpen;
  const scaleStyle = { "--translator-scale": String(TEXT_SCALES[size] ?? 1) } as CSSProperties;
  const sizeGlyph = locale === "ko" ? "가" : "A";
  const canStart = active || !(unsupported || insecure || call.supported === null);
  const displayLines = useMemo(() => mergeDisplay(segments, drafts.state), [segments, drafts.state]);
  // Voice streams have no reliable pairing: help only known other-person originals.
  const voiceAssistLines = segments.filter((segment) => segment.role === "user" && segment.final && !segment.restored && segmentSpeaker(segment) === "them")
    .slice(-HISTORY_MAX_LINES).map((segment) => ({ id: String(segment.id), mine: segment.mine.code, theirs: segment.theirs.code, speaker: "theirs" as const, text: segment.text }));
  const voiceAssists = useLineAssist(voiceAssistLines, { meaning: assistMeaning }, { profile, history: transcriptHistory(transcriptRef.current, HISTORY_MAX_LINES) }, visible && !face);
  const turns = useMemo(() => conversationTurns(displayLines, typed.turns, mine, typed.provisional), [displayLines, typed.turns, mine, typed.provisional]);
  const layoutKey = `${size}|${typingOpen}|${active}`;

  const faceOn = face;
  const speech = useSpeech();
  const { recordFace } = useStallLog({ visible, phase, face: faceOn, segmentCount: segments.length });

  // 덮개마다 기록 칸을 하나씩 얹어 폰의 뒤로가기가 맨 위 덮개부터 닫게 한다.
  const overlays: OverlayMarker[] = [];
  if (visible) {
    if (faceOn) overlays.push("face");
    if (phrasesOpen) overlays.push("phrases");
    if (scanOpen) overlays.push("scan");
    if (card) overlays.push("card");
  }
  useOverlayHistory(overlays, (marker) => {
    if (marker === "card") setCard(null);
    else if (marker === "phrases") setPhrasesOpen(false);
    else if (marker === "scan") setScanOpen(false);
    else {
      setSettings((previous) => ({ ...previous, face: false }));
      recordFace(false, "back");
    }
  });

  // 저장해 둔 마주보기로 화면이 열리면(단추를 누르지 않고 켜짐) 그것도 남긴다.
  const faceOnRef = useRef(faceOn);
  faceOnRef.current = faceOn;
  useEffect(() => {
    if (visible && faceOnRef.current) recordFace(true, "restore");
  }, [recordFace, visible]);

  const setFace = (on: boolean) => {
    setSettings({ ...settings, face: on });
    recordFace(on, "button");
  };

  // 키보드에서는 Escape로도 마주보기를 끈다. 카드가 떠 있으면 카드가 먼저 받아 닫힌다. 기록에는 화면 안
  // 조작으로 끈 것(`button`)으로 남긴다(기록 형식의 계기는 button·back·restore 셋뿐이다).
  useEffect(() => {
    if (!visible || !faceOn || card) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSettings((previous) => ({ ...previous, face: false }));
      recordFace(false, "button");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [card, faceOn, recordFace, visible]);

  const clearConversation = () => {
    transcriptRef.current = clearTranscripts(transcriptRef.current);
    setSegments([]);
    drafts.reset();
    writeConversation([]);
    typed.clear();
  };

  const shareConversation = async () => {
    const text = formatConversation(
      segments,
      { title: tt("translator.shareTitle"), original: tt("translator.original"), translation: tt("translator.translation") },
      (at) => new Date(at).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    );
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: tt("translator.shareTitle"), text });
        return;
      } catch (error) {
        // The person closed the share sheet; anything else falls back to copying.
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setShareNotice("copied");
    } catch {
      setShareNotice("failed");
    }
  };

  const showLabel = tt("translator.cardTitle");
  const cardLayer = card ? (
    <ShowCard card={card} speech={speech} onClose={() => setCard(null)} renderText={(text) => <NumberMarked text={text} />} />
  ) : null;
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
      data-focus-halo
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
          <FacePane
            lines={displayLines}
            language={theirs}
            unknownLabel={tt("translator.unknownLanguage")}
            flipped
            emptyHint={partnerHint(theirs, mine)}
            onShow={setCard}
            showLabel={showLabel}
          />
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
                onClick={() => setFace(false)}
              >
                <CloseIcon />
                {tt("translator.faceExit")}
              </button>
            </div>
          </div>
          <FacePane
            lines={displayLines}
            language={mine}
            unknownLabel={tt("translator.unknownLanguage")}
            emptyHint={active ? undefined : tt("translator.empty")}
            onShow={setCard}
            showLabel={showLabel}
          />
        </div>
        {cardLayer}
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
          <h2 className="sr-only">{tt("translator.title")}</h2>
          <button type="button" className="translator-pair" aria-expanded={setupOpen} aria-controls="translator-setup"
            aria-label={`${tt("translator.setup")}: ${mine.nativeName} ⇄ ${theirs.nativeName}`} onClick={() => setSetupOpen((open) => !open)}>
            <span className="translator-pair-text"><span lang={mine.tag}>{mine.nativeName}</span><span aria-hidden="true"> ⇄ </span><span lang={theirs.tag}>{theirs.nativeName}</span></span>
            <ChevronIcon />
          </button>
          <details className="translator-more" ref={menuRef} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}
            onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
            <summary className="translator-icon-button" aria-label={tt("translator.more")}><MoreVertical size={22} aria-hidden="true" /></summary>
            <div className="translator-more-menu">
              <div className="translator-menu-size">
                <button type="button" disabled={size <= 0} onClick={() => setSettings({ ...settings, size: Math.max(0, size - 1) })}><span aria-hidden="true">{sizeGlyph}−</span>{tt("translator.sizeDown")}</button>
                <button type="button" disabled={size >= TEXT_SCALES.length - 1} onClick={() => setSettings({ ...settings, size: Math.min(TEXT_SCALES.length - 1, size + 1) })}><span aria-hidden="true">{sizeGlyph}+</span>{tt("translator.sizeUp")}</button>
              </div>
              <button type="button" onClick={() => { if (menuRef.current) menuRef.current.open = false; setFace(true); }}><FaceIcon />{tt("translator.face")}</button>
              <button type="button" disabled={!segments.length} onClick={() => { if (menuRef.current) menuRef.current.open = false; void shareConversation(); }}><ShareIcon />{tt("translator.share")}</button>
              <button type="button" onClick={() => { if (menuRef.current) menuRef.current.open = false; setScanOpen(true); }}><CameraIcon />{tt("translator.scan")}</button>
              <button type="button" onClick={() => { if (menuRef.current) menuRef.current.open = false; setPhrasesOpen(true); }}><PhrasesIcon />{tt("translator.phrases")}</button>
              <button type="button" onClick={() => { if (menuRef.current) menuRef.current.open = false; setSetupOpen(true); }}><Settings2 size={20} aria-hidden="true" />{tt("translator.setup")}</button>
              <button type="button" disabled={!turns.length} onClick={() => { clearConversation(); if (menuRef.current) menuRef.current.open = false; }}><Trash2 size={20} aria-hidden="true" />{tt("translator.clear")}</button>
            </div>
          </details>
        </div>
        {showSetup ? (
          <div id="translator-setup" className="translator-setup">
            <button type="button" className="translator-setup-close translator-icon-button" aria-label={tt("translator.cardClose")} onClick={() => setSetupOpen(false)}><CloseIcon /></button>
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
                  checked={voice}
                  aria-describedby="translator-voice-hint"
                  onChange={(event) => setSettings({ ...settings, voice: event.target.checked })}
                />
                <span>{tt("translator.voice")}</span>
              </label>
              <p id="translator-voice-hint" className="translator-options-note">{tt("translator.voiceHint")}</p>
              {voice ? (
                <>
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
                </>
              ) : null}
              <label className="translator-toggle">
                <input
                  type="checkbox"
                  checked={noiseSuppression}
                  aria-describedby="translator-noise-suppression-hint"
                  onChange={(event) => setSettings({ ...settings, noiseSuppression: event.target.checked })}
                />
                <span>{tt("translator.noiseSuppression")}</span>
              </label>
              <p id="translator-noise-suppression-hint" className="translator-options-note">{tt("translator.noiseSuppressionHint")}</p>
              <label className="translator-toggle">
                <input
                  type="checkbox"
                  checked={fastDrafts}
                  aria-describedby="translator-fast-drafts-hint"
                  onChange={(event) => setSettings({ ...settings, fastDrafts: event.target.checked })}
                />
                <span>{tt("translator.fastDrafts")}</span>
              </label>
              <p id="translator-fast-drafts-hint" className="translator-options-note">{tt("translator.fastDraftsHint")}</p>
            </div>
            <div className="translator-options">
              <label className="translator-toggle">
                <input type="checkbox" checked={assistMeaning} aria-describedby="translator-assist-meaning-hint"
                  onChange={(event) => setSettings({ ...settings, assistMeaning: event.target.checked })} />
                <span>{tt("translator.assistMeaning")}</span>
              </label>
              <p id="translator-assist-meaning-hint" className="translator-options-note">{tt("translator.assistMeaningHint")}</p>
            </div>
            {turns.length > 0 ? (
              <ActionButton
                variant="ghost"
                size="small"
                className="translator-clear"
                onClick={clearConversation}
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
      {shareNotice ? (
        <p className="translator-banner" data-tone={shareNotice === "failed" ? "danger" : undefined} role="status">
          {tt(shareNotice === "copied" ? "translator.shareCopied" : "translator.shareFailed")}
        </p>
      ) : null}
      {turns.length === 0 && !active ? <div className="translator-log"><p className="translator-empty">{tt("translator.empty")}</p></div> : (
        <ConversationLog label={tt("translator.conversation")} turns={turns} visible={visible}
          pending={phase === "translating" ? tt("translator.translationPending") : null}
          jumpLabel={tt("translator.jumpLatest")} layoutKey={layoutKey} onShow={setCard} speech={speech}
          renderAssist={(turn) => turn.typed ? <LineAssist result={typed.assists.get(String(turn.typed.id))}
            meaning={assistMeaning} mine={mine} numericMismatch={assistMeaning && !turn.pending && turn.side === "me" && hasNumericMismatch(turn.typed.original, turn.typed.translation)} />
            : turn.voiceLines.filter((line) => line.segment.role === "user" && !line.draft && line.segment.final).map((line) =>
              <LineAssist key={line.key} result={voiceAssists.get(String(line.segment.id))} meaning={assistMeaning} mine={line.segment.mine} />)}
        />
      )}
      {typed.composer}
      <div className="translator-dock">
        {phase !== "idle" ? statusLine : null}
        <div className="translator-dock-row">
          <button type="button" className="translator-keyboard" aria-label={tt(typingOpen ? "translator.keyboardClose" : "translator.keyboard")} aria-expanded={typingOpen}
            onClick={() => setTypingOpen((open) => !open)}><Keyboard size={24} aria-hidden="true" /></button>
          {callButton(true)}
        </div>
      </div>
      {phrasesOpen ? <Phrasebook mine={mine} theirs={theirs} onShow={setCard} onClose={() => setPhrasesOpen(false)} /> : null}
      {scanOpen ? <MenuScan mine={mine} theirs={theirs} onShow={setCard} onClose={() => setScanOpen(false)} /> : null}
      {cardLayer}
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
