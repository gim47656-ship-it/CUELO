"use client";

import { ActionButton } from "@seed-design/react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  MAX_TRANSLATE_CHARS,
  TRANSLATOR_LANGUAGES,
  TRANSLATOR_SPEECH_SAMPLE_RATE,
  findTranslatorLanguage,
  type TranslatorLanguage,
} from "@/lib/translator-languages";
import { useTranslatorText } from "./i18n";

/**
 * 통역 모드. 사이드바 「통역」 보기가 켜지면 작업 대화 칸 위에 덮인다. 듣기와 읽어 주기는 브라우저의
 * Web Speech API(인식·합성)가 하고, 번역 한 건만 `/api/translate`로 보낸다. 기록은 이 화면이 떠
 * 있는 동안만 메모리에 두며 서버·세션에 저장하지 않는다.
 */

type Side = "me" | "them";

interface Entry {
  id: number;
  side: Side;
  original: string;
  source: TranslatorLanguage;
  target: TranslatorLanguage;
  translation: string | null;
  error: string | null;
}

// TypeScript의 DOM lib에는 Web Speech 인식 타입이 없어 이 화면이 쓰는 만큼만 적는다.
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<{ readonly isFinal: boolean; readonly 0: { readonly transcript: string } }>;
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => Recognition;

const SETTINGS_KEY = "cuelo-translator";

interface Settings {
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  autoSpeak: boolean;
}

function readSettings(): Settings {
  const fallback: Settings = { mine: TRANSLATOR_LANGUAGES[0], theirs: TRANSLATOR_LANGUAGES[1], autoSpeak: true };
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null") as Record<string, unknown> | null;
    if (!saved || typeof saved !== "object") return fallback;
    return {
      mine: findTranslatorLanguage(saved.mine) ?? fallback.mine,
      theirs: findTranslatorLanguage(saved.theirs) ?? fallback.theirs,
      autoSpeak: typeof saved.autoSpeak === "boolean" ? saved.autoSpeak : fallback.autoSpeak,
    };
  } catch {
    return fallback;
  }
}

/**
 * 폰 기본 목소리(Web Speech 합성). Cartesia 음성을 받지 못했을 때만 쓴다. 정확한 언어 태그의 목소리가
 * 없으면 같은 언어의 다른 지역 목소리, 그것도 없으면 브라우저 기본으로 읽는다.
 */
function speakWithDevice(text: string, language: TranslatorLanguage): void {
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language.speechTag;
  const tag = language.speechTag.toLowerCase();
  const base = tag.split("-")[0];
  const voices = synth.getVoices().map((voice) => ({ voice, lang: voice.lang.replace("_", "-").toLowerCase() }));
  utterance.voice = (voices.find((entry) => entry.lang === tag) ?? voices.find((entry) => entry.lang.split("-")[0] === base))?.voice ?? null;
  synth.speak(utterance);
}

/** 첫 조각을 바로 붙이면 예약 지연으로 앞이 잘린다. 그만큼만 여유를 둔다. */
const PLAYBACK_LEAD_SECONDS = 0.05;

/** 서버가 흘려보내는 `pcm_s16le` 바이트를 샘플로 바꾼다. 조각 경계에서 잘린 한 바이트는 다음 조각 앞에 붙인다. */
class PcmDecoder {
  #carry: number | null = null;

  push(chunk: Uint8Array): Float32Array<ArrayBuffer> {
    let bytes = chunk;
    if (this.#carry !== null) {
      bytes = new Uint8Array(chunk.length + 1);
      bytes[0] = this.#carry;
      bytes.set(chunk, 1);
      this.#carry = null;
    }
    if (bytes.length % 2 === 1) {
      this.#carry = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(bytes.length / 2);
    for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
    return samples;
  }
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

interface TranslatorViewProps {
  visible?: boolean;
  onBack?: () => void;
}

export function TranslatorView({ visible = true, onBack }: TranslatorViewProps) {
  const { tt } = useTranslatorText();
  const [settings, setSettings] = useState(readSettings);
  const { mine, theirs, autoSpeak } = settings;
  const [recognitionCtor] = useState<RecognitionConstructor | null>(() => {
    // DOM lib에 인식 생성자 타입이 없어, 브라우저가 실제로 두는 두 이름을 위 최소 타입으로 읽는다.
    const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
  });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [listening, setListening] = useState<Side | null>(null);
  const [heard, setHeard] = useState("");
  const [micError, setMicError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [direction, setDirection] = useState<Side>("me");
  const recognitionRef = useRef<Recognition | null>(null);
  const nextIdRef = useRef(0);
  const autoSpeakRef = useRef(autoSpeak);
  const speechUnlockedRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  /** 말풍선별 Cartesia 음성(받는 중이면 다 받았을 때의 소리). 다시 듣기·연타에 크레딧을 또 쓰지 않는다. */
  const audioCacheRef = useRef(new Map<number, Promise<AudioBuffer>>());
  /** 예약됐거나 재생 중인 소리 조각과, 다음 조각을 이어 붙일 시각. */
  const sourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const nextStartRef = useRef(0);
  /** 재생을 멈출 때마다 늘린다. 음성을 받는 사이 멈췄으면 받은 뒤에도 재생하지 않는다. */
  const playTokenRef = useRef(0);
  /**
   * 사용자가 소리를 멈춘 횟수(마이크 시작·대화로 복귀·지우기·자동 읽기 끔). 번역을 기다리는 사이 이 값이
   * 바뀌었으면 늦게 온 번역을 자동으로 읽지 않는다. 다음 말풍선 재생은 이 값을 바꾸지 않는다.
   */
  const silenceRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    autoSpeakRef.current = autoSpeak;
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mine: mine.code, theirs: theirs.code, autoSpeak }));
  }, [mine, theirs, autoSpeak]);

  // 브라우저는 사용자 동작 안에서 한 번 깨운 AudioContext·음성 합성으로만 나중의 비동기 재생을 허용한다(iOS Safari).
  const unlockAudio = useCallback(() => {
    // 음성 인식이 되는 iOS 14.5+·Chrome은 모두 접두사 없는 AudioContext를 지원한다.
    audioContextRef.current ??= new AudioContext();
    void audioContextRef.current?.resume();
    const synth = window.speechSynthesis;
    if (synth && !speechUnlockedRef.current) {
      synth.speak(new SpeechSynthesisUtterance(""));
      speechUnlockedRef.current = true;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    playTokenRef.current += 1;
    for (const source of sourcesRef.current) {
      try {
        source.stop();
      } catch {
        // 이미 끝난 소리다.
      }
    }
    sourcesRef.current.clear();
    nextStartRef.current = 0;
    window.speechSynthesis?.cancel();
  }, []);

  const silence = useCallback(() => {
    silenceRef.current += 1;
    stopPlayback();
  }, [stopPlayback]);

  /** 소리 한 덩어리를 앞 조각 바로 뒤에 이어 예약한다. */
  const queueBuffer = useCallback((context: AudioContext, buffer: AudioBuffer) => {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    // 앞 조각이 아직 끝나지 않았으면 그 끝에 바로 붙인다. 이미 끝났거나 처음이면 예약 여유만큼 뒤에서 시작한다.
    const start = nextStartRef.current > context.currentTime
      ? nextStartRef.current
      : context.currentTime + PLAYBACK_LEAD_SECONDS;
    source.onended = () => {
      sourcesRef.current.delete(source);
    };
    sourcesRef.current.add(source);
    source.start(start);
    nextStartRef.current = start + buffer.duration;
  }, []);

  const playTranslation = useCallback(async (id: number, text: string, language: TranslatorLanguage) => {
    stopPlayback();
    const token = playTokenRef.current;
    const audible = () => token === playTokenRef.current;
    const context = audioContextRef.current;
    let played = false;
    try {
      if (!context) throw new Error("audio is not unlocked");
      const cached = audioCacheRef.current.get(id);
      if (cached) {
        const buffer = await cached;
        if (audible()) queueBuffer(context, buffer);
        return;
      }
      // 받는 중에 다시 듣기를 누르면 이 약속을 기다려 다 받은 소리를 읽는다. 실패하면 지워 다음에 다시 받는다.
      let settle: { resolve: (buffer: AudioBuffer) => void; reject: (error: unknown) => void } | undefined;
      const whole = new Promise<AudioBuffer>((resolve, reject) => {
        settle = { resolve, reject };
      });
      whole.catch(() => {
        if (audioCacheRef.current.get(id) === whole) audioCacheRef.current.delete(id);
      });
      audioCacheRef.current.set(id, whole);
      try {
        const response = await fetch("/api/translate/speech", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, language: language.code }),
        });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new PcmDecoder();
        const parts: Float32Array<ArrayBuffer>[] = [];
        let length = 0;
        // 멈췄어도 끝까지 받아 다시 듣기용으로 기억한다. 재생은 멈추지 않았을 때만 조각마다 이어 붙인다.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const samples = decoder.push(value);
          if (samples.length === 0) continue;
          parts.push(samples);
          length += samples.length;
          if (audible()) {
            const chunk = context.createBuffer(1, samples.length, TRANSLATOR_SPEECH_SAMPLE_RATE);
            chunk.copyToChannel(samples, 0);
            queueBuffer(context, chunk);
            played = true;
          }
        }
        if (length === 0) throw new Error("no audio");
        const buffer = context.createBuffer(1, length, TRANSLATOR_SPEECH_SAMPLE_RATE);
        let offset = 0;
        for (const part of parts) {
          buffer.copyToChannel(part, 0, offset);
          offset += part.length;
        }
        settle?.resolve(buffer);
      } catch (error) {
        settle?.reject(error);
        throw error;
      }
    } catch {
      // 소리를 한 조각도 내지 못했을 때만 폰 목소리로 대신 읽는다. 중간에 끊긴 소리 위에 겹쳐 읽지 않는다.
      if (!played && audible()) speakWithDevice(text, language);
    }
  }, [queueBuffer, stopPlayback]);

  const translate = useCallback(async (id: number, text: string, source: TranslatorLanguage, target: TranslatorLanguage) => {
    const silenced = silenceRef.current;
    setEntries((list) => list.map((entry) => (entry.id === id ? { ...entry, translation: null, error: null } : entry)));
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, source: source.code, target: target.code }),
      });
      const data = (await response.json().catch(() => ({}))) as { translation?: unknown; error?: unknown };
      if (!response.ok || typeof data.translation !== "string") {
        throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
      }
      const translation = data.translation;
      setEntries((list) => list.map((entry) => (entry.id === id ? { ...entry, translation } : entry)));
      if (autoSpeakRef.current && silenced === silenceRef.current) void playTranslation(id, translation, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEntries((list) => list.map((entry) => (entry.id === id ? { ...entry, error: message } : entry)));
    }
  }, [playTranslation]);

  const addUtterance = useCallback((side: Side, text: string, source: TranslatorLanguage, target: TranslatorLanguage) => {
    const id = nextIdRef.current++;
    setEntries((list) => [...list, { id, side, original: text, source, target, translation: null, error: null }]);
    void translate(id, text, source, target);
  }, [translate]);

  const stopListening = useCallback(() => {
    const active = recognitionRef.current;
    if (!active) return;
    active.onresult = null;
    active.onerror = null;
    active.onend = null;
    active.abort();
    recognitionRef.current = null;
    setListening(null);
    setHeard("");
  }, []);

  const toggleListening = useCallback((side: Side) => {
    if (recognitionRef.current) {
      // 같은 쪽을 다시 누르면 지금까지 들은 말로 마무리하고, 다른 쪽이면 버리고 새로 듣는다.
      if (listening === side) {
        recognitionRef.current.stop();
        return;
      }
      stopListening();
    }
    if (!recognitionCtor) return;
    // 읽던 번역을 끊어야 그 소리가 다시 인식되지 않는다.
    unlockAudio();
    silence();
    const source = side === "me" ? mine : theirs;
    const target = side === "me" ? theirs : mine;
    const recognition = new recognitionCtor();
    recognition.lang = source.speechTag;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    let finalText = "";
    let latest = "";
    let failed = false;
    recognition.onresult = (event) => {
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      latest = finalText + interimText;
      setHeard(latest);
      // 한 번에 한 마디만 듣는다(continuous=false). 확정 결과가 나오면 인식이 닫히기를 기다리지 않고 바로 보낸다.
      const text = finalText.trim();
      if (!text || interimText) return;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setListening(null);
      setHeard("");
      recognition.abort();
      addUtterance(side, text, source, target);
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      failed = true;
      setMicError(event.error === "not-allowed" || event.error === "service-not-allowed"
        ? tt("translator.micDenied")
        : tt("translator.micFailed", { error: event.error }));
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setListening(null);
      setHeard("");
      // 멈춤 버튼으로 끊으면 확정 결과 없이 끝나는 브라우저가 있어 마지막으로 들은 말까지 쓴다.
      // 인식이 오류로 끝났으면 중간 결과를 믿지 않고 보내지 않는다.
      const text = latest.trim();
      if (text && !failed) addUtterance(side, text, source, target);
    };
    recognitionRef.current = recognition;
    setMicError(null);
    setHeard("");
    setListening(side);
    try {
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      setListening(null);
      setMicError(tt("translator.micFailed", { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [addUtterance, listening, mine, recognitionCtor, silence, stopListening, theirs, tt, unlockAudio]);

  // 대화 화면으로 돌아가거나 화면이 사라지면 마이크와 읽기를 멈춘다.
  useEffect(() => {
    if (visible) return;
    stopListening();
    silence();
  }, [silence, stopListening, visible]);
  useEffect(() => () => {
    stopListening();
    silence();
    void audioContextRef.current?.close();
  }, [silence, stopListening]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [entries]);

  const submitDraft = (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    const text = draft.trim();
    unlockAudio();
    if (!text || text.length > MAX_TRANSLATE_CHARS) return;
    addUtterance(direction, text, direction === "me" ? mine : theirs, direction === "me" ? theirs : mine);
    setDraft("");
  };

  const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) submitDraft(event);
  };

  const secure = window.isSecureContext;
  const canListen = secure && recognitionCtor !== null;
  const notice = micError
    ?? (!secure ? tt("translator.insecure") : recognitionCtor === null ? tt("translator.noSpeech") : null);

  const languageOptions = TRANSLATOR_LANGUAGES.map((language) => (
    <option key={language.code} value={language.code}>{language.nativeName}</option>
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
                if (!language) return;
                // 이미 듣고 있는 인식은 시작할 때의 언어로 계속 듣는다. 바꾸는 순간 끊어 새 언어로 다시 누르게 한다.
                stopListening();
                setSettings((current) => ({ ...current, mine: language }));
              }}
            >
              {languageOptions}
            </select>
          </label>
          <button
            type="button"
            className="translator-swap"
            aria-label={tt("translator.swap")}
            title={tt("translator.swap")}
            onClick={() => {
              stopListening();
              setSettings((current) => ({ ...current, mine: current.theirs, theirs: current.mine }));
            }}
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
                if (!language) return;
                stopListening();
                setSettings((current) => ({ ...current, theirs: language }));
              }}
            >
              {languageOptions}
            </select>
          </label>
        </div>
        <div className="translator-actions">
          <label className="translator-toggle">
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={(event) => {
                const checked = event.target.checked;
                setSettings((current) => ({ ...current, autoSpeak: checked }));
                if (!checked) silence();
              }}
            />
            {tt("translator.autoSpeak")}
          </label>
          <ActionButton
            variant="ghost"
            size="small"
            disabled={entries.length === 0}
            onClick={() => {
              silence();
              audioCacheRef.current.clear();
              setEntries([]);
            }}
          >
            {tt("translator.clear")}
          </ActionButton>
        </div>
      </header>
      {notice ? (
        <p className="translator-banner" data-tone={micError ? "danger" : undefined} role={micError ? "alert" : "status"}>{notice}</p>
      ) : null}
      <div ref={logRef} className="translator-log" role="log" aria-label={tt("translator.conversation")}>
        {entries.length === 0 ? <p className="translator-empty">{tt("translator.empty")}</p> : null}
        {entries.map((entry) => (
          <div key={entry.id} className="translator-entry" data-side={entry.side}>
            <div className="translator-bubble">
              {entry.translation !== null ? (
                <p className="translator-translation" lang={entry.target.speechTag}>{entry.translation}</p>
              ) : entry.error !== null ? (
                <p className="translator-error" role="alert">{tt("translator.failed", { error: entry.error })}</p>
              ) : (
                <p className="translator-pending" role="status">{tt("translator.translating")}</p>
              )}
              <p className="translator-original" lang={entry.source.speechTag}>
                <span className="sr-only">{tt("translator.original")}: </span>
                {entry.original}
              </p>
            </div>
            {entry.translation !== null ? (
              <button
                type="button"
                className="translator-entry-action"
                aria-label={tt("translator.replay")}
                title={tt("translator.replay")}
                onClick={() => {
                  unlockAudio();
                  void playTranslation(entry.id, entry.translation ?? "", entry.target);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 9v6h4l5 4V5L8 9H4z" />
                  <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />
                </svg>
              </button>
            ) : entry.error !== null ? (
              <button
                type="button"
                className="translator-entry-action"
                onClick={() => { void translate(entry.id, entry.original, entry.source, entry.target); }}
              >
                {tt("translator.retry")}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="translator-dock">
        <p className="translator-heard" role="status" aria-live="polite">
          {listening ? heard || tt("translator.listening") : ""}
        </p>
        <div className="translator-talk">
          {(["me", "them"] as const).map((side) => {
            const language = side === "me" ? mine : theirs;
            return (
              <button
                key={side}
                type="button"
                className="translator-talk-button"
                data-side={side}
                aria-pressed={listening === side}
                disabled={!canListen}
                onClick={() => toggleListening(side)}
              >
                <span className="translator-talk-who">{tt(side === "me" ? "translator.me" : "translator.them")}</span>
                <span className="translator-talk-label" lang={language.speechTag}>
                  <MicIcon />
                  {language.speakLabel}
                </span>
              </button>
            );
          })}
        </div>
        <form className="translator-type" onSubmit={submitDraft}>
          <select
            className="translator-direction"
            aria-label={tt("translator.direction")}
            value={direction}
            onChange={(event) => setDirection(event.target.value === "them" ? "them" : "me")}
          >
            <option value="me">{tt("translator.directionMine")}</option>
            <option value="them">{tt("translator.directionTheirs")}</option>
          </select>
          <input
            className="translator-input"
            value={draft}
            maxLength={MAX_TRANSLATE_CHARS}
            placeholder={tt("translator.inputPlaceholder")}
            aria-label={tt("translator.input")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onDraftKeyDown}
          />
          <ActionButton type="submit" variant="neutralSolid" size="small" disabled={!draft.trim()}>
            {tt("translator.send")}
          </ActionButton>
        </form>
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
