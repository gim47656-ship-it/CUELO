import { getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import { CARTESIA_PROXY_PROVIDER, CARTESIA_VERSION, redactSecret } from "./cartesia";
import { LIVE_SPEECH_SAMPLE_RATE, type LiveEvent } from "./live-types";
import type { LiveVoiceGeneration } from "./live-voice-manifest";

/**
 * 통화 한 건의 캐릭터 발화 — Codex sideband의 assistant 전사를 Cartesia WebSocket으로 합성한다.
 *
 * 합성할 텍스트는 이 서버가 받은 전사뿐이다. 브라우저는 텍스트를 보낼 길이 없고 PCM만 받는다.
 *
 * 발화 하나가 Cartesia context 하나다. 전사가 자라는 동안 문장·쉼표 경계까지를 `continue: true`로
 * 보내고, `turn.done`에서 나머지를 `continue: false`로 닫는다. 경계가 텍스트 맨 끝이면 그 조각은
 * 다음 텍스트가 올 때까지 보류한다 — 그래야 닫을 때 보낼 조각이 늘 남는다.
 *
 * 앞 발화의 소리가 끝나기 전에 다음 발화가 시작돼도 순서가 섞이지 않게, 앞 context가 `done`이
 * 될 때까지 뒤 context의 청크는 버퍼에 둔다. 사용자가 끼어들거나 캐릭터가 바뀌면 남은 context를
 * 모두 취소하고 epoch를 올린다. 브라우저는 그 epoch 이전 청크를 버린다.
 */

export interface SpeechSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SpeechSocketFactory = (url: string, apiKey: string) => SpeechSocket;

export interface SpeechVoice {
  voiceId: string;
  generation: LiveVoiceGeneration;
}

export interface CharacterSpeechOptions {
  apiKey: string;
  model: string;
  voice: SpeechVoice;
  /** 전사에 한글·가나가 없을 때 쓸 언어(통화 locale에서). */
  defaultLanguage: string;
  emit: (event: LiveEvent) => void;
  /** 더는 캐릭터 음성을 만들 수 없다. 통화를 끝내야 한다. */
  onFatal: (message: string) => void;
  openSocket?: SpeechSocketFactory;
}

const SOCKET_OPEN = 1;
const TTS_URL = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${CARTESIA_VERSION}`;
/** 구두점 없이 이만큼 쌓이면 마지막 공백에서 끊는다. */
const MAX_UNPUNCTUATED = 120;
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;
const KANA = /[\u3040-\u30FF]/;
/** 끊어도 되는 자리: 문장·쉼표 부호 뒤 공백, 또는 띄어 쓰지 않는 CJK 부호·줄바꿈 뒤. */
const BOUNDARY = /[.!?…,;:]+["')\]]*\s+|[。！？、，；：\n]+\s*/g;

const openBunSocket: SpeechSocketFactory = (url, apiKey) => (
  // Bun의 WebSocket은 서버에서 요청 헤더를 두 번째 인자로 받는다(sideband와 같은 방식).
  Reflect.construct(WebSocket, [url, {
    headers: { "X-API-Key": apiKey },
    proxy: getProxyForUrl(CARTESIA_PROXY_PROVIDER, new URL(url)),
  }]) as SpeechSocket
);

/** 아직 보내지 않은 `text[from..]`에서 지금 보내도 되는 끝 위치. 없으면 `from`. */
export function speakableEnd(text: string, from: number): number {
  let end = from;
  BOUNDARY.lastIndex = from;
  for (let match = BOUNDARY.exec(text); match; match = BOUNDARY.exec(text)) {
    const cut = match.index + match[0].length;
    if (cut < text.length) end = cut;
  }
  if (end === from && text.length - from > MAX_UNPUNCTUATED) {
    const space = text.lastIndexOf(" ", text.length - 2);
    if (space >= from) end = space + 1;
  }
  return end;
}

export function speechLanguage(text: string, fallback: string): string {
  if (HANGUL.test(text)) return "ko";
  if (KANA.test(text)) return "ja";
  return fallback;
}

interface Utterance {
  contextId: string;
  voice: SpeechVoice;
  language: string;
  /** 이 context로 이미 보낸 전사. */
  sent: string;
  finalSent: boolean;
  done: boolean;
  /** 앞 발화가 끝나기 전에 도착한 이 발화의 청크. */
  buffered: string[];
  /** 이 context의 프레임이 provider에 실제로 나갔다. 아직 연결 대기 중이면 false. */
  submitted: boolean;
}

export class CharacterSpeech {
  readonly #options: CharacterSpeechOptions;
  readonly #openSocket: SpeechSocketFactory;
  #voice: SpeechVoice;
  #socket: SpeechSocket | undefined;
  #pending: string[] = [];
  #queue: Utterance[] = [];
  #current: Utterance | undefined;
  #epoch = 0;
  #spokeSinceReset = false;
  #closed = false;

  constructor(options: CharacterSpeechOptions) {
    this.#options = options;
    this.#voice = options.voice;
    this.#openSocket = options.openSocket ?? openBunSocket;
  }

  get epoch(): number {
    return this.#epoch;
  }

  /** 키·연결 문제를 사용자가 말하기 전에 드러내려고 통화 시작 때 미리 연다. */
  connect(): void {
    this.#ensureSocket();
  }

  /** 누적 assistant 전사 한 프레임. `final`은 그 발화의 `turn.done`이다. */
  assistantText(text: string, final: boolean): void {
    if (this.#closed) return;
    let utterance = this.#current;
    if (!utterance) {
      if (!text.trim()) return;
      utterance = {
        contextId: crypto.randomUUID(),
        voice: this.#voice,
        language: speechLanguage(text, this.#options.defaultLanguage),
        sent: "",
        finalSent: false,
        done: false,
        buffered: [],
        submitted: false,
      };
      this.#queue.push(utterance);
      this.#current = utterance;
    }
    // 앞서 보낸 전사를 고쳐 쓴 프레임은 따라갈 수 없다. 이미 말한 부분을 두 번 말하지 않는다.
    const follows = text.startsWith(utterance.sent);
    if (final) {
      this.#current = undefined;
      const rest = follows ? text.slice(utterance.sent.length) : "";
      if (rest.trim()) {
        this.#sendText(utterance, rest, false);
      } else {
        // 닫을 조각이 없다. 이 context의 남은 소리는 버리고 다음 발화가 막히지 않게 한다.
        utterance.done = true;
        this.#advance();
      }
      return;
    }
    if (!follows) return;
    const end = speakableEnd(text, utterance.sent.length);
    if (end > utterance.sent.length) this.#sendText(utterance, text.slice(utterance.sent.length, end), true);
  }

  /**
   * 지금까지의 발화를 모두 버린다(끼어들기·캐릭터 전환). 이미 받은 소리가 브라우저에서 재생 중일
   * 수 있으므로, 이번 reset 뒤로 한 번이라도 소리를 냈다면 큐가 비어 있어도 알린다.
   */
  reset(): void {
    if (this.#closed) return;
    // 연결을 기다리며 쌓인 프레임은 아직 provider에 가지 않았다. 버려진 발화를 열린 뒤에 합성시키지 않는다.
    // 이 버퍼에는 지금 큐의 발화 프레임만 있으므로(reset·close가 함께 비운다) 통째로 버린다.
    this.#pending = [];
    for (const utterance of this.#queue) {
      if (!utterance.done && utterance.submitted) this.#sendRaw({ context_id: utterance.contextId, cancel: true });
    }
    const hadQueue = this.#queue.length > 0;
    this.#queue = [];
    this.#current = undefined;
    if (!hadQueue && !this.#spokeSinceReset) return;
    this.#spokeSinceReset = false;
    this.#epoch += 1;
    this.#options.emit({ type: "speech-reset", epoch: this.#epoch });
  }

  /** 다음 발화부터 다른 voice로 말한다. 이전 캐릭터의 남은 소리를 먼저 지운다. */
  setVoice(voice: SpeechVoice): void {
    this.reset();
    this.#voice = voice;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    this.#current = undefined;
    this.#pending = [];
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, "call closed");
      } catch {
        // 이미 닫히는 중
      }
    }
  }

  #sendText(utterance: Utterance, transcript: string, more: boolean): void {
    utterance.sent += transcript;
    if (!more) utterance.finalSent = true;
    const { emotion, speed, volume } = utterance.voice.generation;
    if (this.#sendRaw({
      model_id: this.#options.model,
      transcript,
      voice: utterance.voice.voiceId,
      language: utterance.language,
      context_id: utterance.contextId,
      continue: more,
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: LIVE_SPEECH_SAMPLE_RATE },
      generation_config: { speed, volume, ...(emotion ? { emotion } : {}) },
    })) utterance.submitted = true;
  }

  /** 바로 보냈으면 true, 연결을 기다리며 쌓았으면 false. */
  #sendRaw(message: Record<string, unknown>): boolean {
    const frame = JSON.stringify(message);
    const socket = this.#ensureSocket();
    if (socket && socket.readyState === SOCKET_OPEN) {
      socket.send(frame);
      return true;
    }
    this.#pending.push(frame);
    return false;
  }

  #ensureSocket(): SpeechSocket | undefined {
    if (this.#closed) return undefined;
    if (this.#socket) return this.#socket;
    let socket: SpeechSocket;
    try {
      socket = this.#openSocket(TTS_URL, this.#options.apiKey);
    } catch (error) {
      this.#fail(`Cartesia 음성 연결을 열지 못했습니다 (${error instanceof Error ? error.message : String(error)})`);
      return undefined;
    }
    this.#socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      const frames = this.#pending;
      this.#pending = [];
      for (const frame of frames) socket.send(frame);
      for (const utterance of this.#queue) if (utterance.sent) utterance.submitted = true;
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") this.#receive(event.data);
    };
    socket.onerror = () => {
      if (!opened) this.#fail("Cartesia 음성 연결에 실패했습니다.");
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      // 말하는 중에 끊기면 그 캐릭터 목소리는 더 나오지 않는다. 쉬는 중이면 다음 발화가 다시 연다.
      if (!opened || this.#pending.length > 0 || this.#queue.some((utterance) => !utterance.done)) {
        this.#fail("Cartesia 음성 연결이 끊겼습니다.");
      }
    };
    return socket;
  }

  #receive(payload: string): void {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed !== "object" || parsed === null) return;
      record = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const contextId = typeof record.context_id === "string" ? record.context_id : undefined;
    const utterance = contextId ? this.#queue.find((candidate) => candidate.contextId === contextId) : undefined;
    if (record.type === "error") {
      // 취소한 context의 뒤늦은 오류는 이미 버린 발화의 것이다.
      if (contextId && !utterance) return;
      const parts = [record.title, record.message].filter((part): part is string => typeof part === "string" && part !== "");
      const status = typeof record.status_code === "number" ? ` ${record.status_code}` : "";
      this.#fail(`Cartesia${status}: ${parts.join(": ") || "음성 생성 오류"}`);
      return;
    }
    if (!utterance) return;
    if (record.type === "chunk" && typeof record.data === "string" && record.data) {
      if (utterance === this.#queue[0]) this.#deliver(record.data);
      else utterance.buffered.push(record.data);
    }
    if (record.type === "done" || (record.type === "chunk" && record.done === true)) {
      if (!utterance.finalSent) return;
      utterance.done = true;
      this.#advance();
    }
  }

  #deliver(audio: string): void {
    this.#spokeSinceReset = true;
    this.#options.emit({ type: "speech", epoch: this.#epoch, audio });
  }

  /** 끝난 발화를 앞에서 빼고, 새 머리 발화의 버퍼를 순서대로 내보낸다. */
  #advance(): void {
    while (this.#queue.length > 0) {
      const head = this.#queue[0];
      for (const audio of head.buffered.splice(0)) this.#deliver(audio);
      if (!head.done) return;
      this.#queue.shift();
    }
  }

  /** 모든 치명 오류가 지나는 한 곳. provider 문구·연결 예외에 키가 섞여 와도 지운 뒤 내보낸다. */
  #fail(message: string): void {
    if (this.#closed) return;
    this.close();
    this.#options.onFatal(redactSecret(message, this.#options.apiKey));
  }
}
