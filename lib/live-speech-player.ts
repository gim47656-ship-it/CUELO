import { LIVE_SPEECH_SAMPLE_RATE } from "./live-types";

/**
 * 브라우저 쪽 캐릭터 음성 재생. 서버가 SSE로 보낸 `pcm_s16le` 청크를 받은 순서대로 이어 붙여
 * 재생한다. `reset(epoch)` 뒤로는 그 epoch보다 오래된 청크를 버리고, 이미 예약된 소리도 멈춘다 —
 * 끼어든 사용자 위로 이전 대답이 이어지지 않게.
 */

export interface SpeechBufferSource {
  buffer: unknown;
  onended: (() => void) | null;
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(): void;
}

export interface SpeechAudioContext {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): {
    readonly duration: number;
    getChannelData(channel: number): Float32Array;
  };
  createBufferSource(): SpeechBufferSource;
}

/** 첫 청크를 바로 붙이면 디코딩·스케줄 지연으로 앞이 잘린다. 그만큼만 여유를 둔다. */
const START_LEAD_SECONDS = 0.05;

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export class LiveSpeechPlayer {
  readonly #createContext: () => SpeechAudioContext;
  #context: SpeechAudioContext | null = null;
  #epoch = 0;
  #nextTime = 0;
  /** 청크 경계가 샘플 중간에서 끊겼을 때 남은 한 바이트. */
  #carry: number | null = null;
  readonly #sources = new Set<SpeechBufferSource>();

  constructor(createContext: () => SpeechAudioContext = () => new AudioContext() as unknown as SpeechAudioContext) {
    this.#createContext = createContext;
  }

  /** 사용자 조작 안에서 불러 자동 재생 차단을 푼다. */
  unlock(): void {
    const context = this.#ensureContext();
    if (context?.state === "suspended") void context.resume().catch(() => {});
  }

  /** 예약됐거나 재생 중인 소리가 있는지. */
  get speaking(): boolean {
    return this.#sources.size > 0;
  }

  push(epoch: number, base64: string): void {
    if (epoch < this.#epoch) return;
    if (epoch > this.#epoch) this.reset(epoch);
    const context = this.#ensureContext();
    if (!context) return;
    let bytes = decodeBase64(base64);
    if (this.#carry !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.#carry;
      joined.set(bytes, 1);
      bytes = joined;
      this.#carry = null;
    }
    if (bytes.length % 2 === 1) {
      this.#carry = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const samples = bytes.length / 2;
    if (samples === 0) return;
    const buffer = context.createBuffer(1, samples, LIVE_SPEECH_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < samples; index += 1) channel[index] = view.getInt16(index * 2, true) / 32768;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + START_LEAD_SECONDS, this.#nextTime);
    source.onended = () => {
      this.#sources.delete(source);
    };
    this.#sources.add(source);
    source.start(startAt);
    this.#nextTime = startAt + buffer.duration;
  }

  /** 예약된 소리를 모두 멈추고 `epoch` 이전 청크를 앞으로 버린다. */
  reset(epoch: number): void {
    this.#epoch = Math.max(this.#epoch, epoch);
    this.#nextTime = 0;
    this.#carry = null;
    for (const source of this.#sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // 아직 시작 전이거나 이미 끝난 소스
      }
    }
    this.#sources.clear();
  }

  close(): void {
    this.reset(this.#epoch);
    const context = this.#context;
    this.#context = null;
    if (context) void context.close().catch(() => {});
  }

  #ensureContext(): SpeechAudioContext | null {
    if (this.#context && this.#context.state !== "closed") return this.#context;
    try {
      this.#context = this.#createContext();
    } catch {
      this.#context = null;
    }
    return this.#context;
  }
}
