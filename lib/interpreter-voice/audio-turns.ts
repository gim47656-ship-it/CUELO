import type { SpeakerSide } from "./speakers";
export const AUDIO_RATE = 24000;
export const ENDPOINT_MS = 400;
export const SPEAKER_BUFFER_MS = 1500;
export interface AudioTurn { id: number; startMs: number; endMs: number; side?: SpeakerSide }
interface Frame { samples: Int16Array; startMs: number; endMs: number }
/** Audio still in the rolling buffer can be cut at a worker's estimated boundary, never retroactively. */
export class AudioTurns {
  private pending: Frame[] = [];
  private clock = 0;
  private nextId = 0;
  private sentUntil = 0;
  private silence = 0;
  private voiced = 0;
  private turn?: AudioTurn;
  private previous?: SpeakerSide;
  private identified = false;
  private manualTurn?: number;
  holdMs = 0;
  constructor(private callbacks: {
    append(samples: Int16Array, turn: AudioTurn): void;
    commit(turn: AudioTurn): void;
    open(turn: AudioTurn): void;
  }) {}
  get current() { return this.turn; }
  get now() { return this.clock; }
  push(samples: Int16Array, side?: SpeakerSide) {
    const startMs = this.clock, duration = samples.length / AUDIO_RATE * 1000;
    this.clock += duration;
    let sum = 0;
    for (const sample of samples) sum += (sample / 32768) ** 2;
    const speech = Math.sqrt(sum / samples.length) >= 0.012;
    if (!this.turn && !speech) return;
    if (!this.turn) {
      this.turn = { id: this.nextId++, startMs, endMs: this.clock, side: side ?? this.previous };
      this.identified = side !== undefined;
      this.sentUntil = startMs;
      this.voiced = 0;
      this.callbacks.open(this.turn);
    }
    if (side && !this.turn.side) this.turn.side = side;
    this.turn.endMs = this.clock;
    this.pending.push({ samples, startMs, endMs: this.clock });
    this.voiced += speech ? duration : 0;
    this.silence = speech ? 0 : this.silence + duration;
    if (this.silence >= ENDPOINT_MS) this.finish();
    else this.flush(this.clock - this.holdMs);
  }
  identify(side: SpeakerSide, boundaryMs: number) {
    if (!this.turn) { this.previous = side; return; }
    if (this.manualTurn === this.turn.id) return;
    if (!this.identified || !this.turn.side) { this.turn.side = side; this.previous = side; this.identified = true; return; }
    if (this.turn.side === side) return;
    const boundary = Math.max(this.sentUntil, Math.min(boundaryMs, this.clock));
    // The next item may be empty at detection time; it is not committed until it has audio.
    if (boundary - this.turn.startMs < 100) return;
    this.flush(boundary);
    const old = this.turn;
    this.callbacks.commit({ ...old, endMs: boundary });
    this.previous = side;
    if (!this.pending.length) { this.turn = undefined; this.silence = 0; return; }
    this.turn = { id: this.nextId++, startMs: boundary, endMs: this.clock, side };
    this.identified = true;
    this.sentUntil = boundary;
    this.voiced = this.clock - boundary;
    this.callbacks.open(this.turn);
  }
  private flush(until: number) {
    if (!this.turn) return;
    while (this.pending.length && this.pending[0].startMs < until) {
      const frame = this.pending[0];
      const count = Math.min(frame.samples.length, Math.round((until - frame.startMs) * AUDIO_RATE / 1000));
      if (count <= 0) break;
      this.callbacks.append(frame.samples.subarray(0, count), this.turn);
      this.sentUntil = frame.startMs + count / AUDIO_RATE * 1000;
      if (count === frame.samples.length) this.pending.shift();
      else { frame.samples = frame.samples.subarray(count); frame.startMs = this.sentUntil; break; }
    }
  }
  finish() {
    if (!this.turn) return;
    this.flush(this.clock);
    this.previous = this.turn.side ?? this.previous;
    if (this.voiced >= 100) this.callbacks.commit({ ...this.turn, endMs: this.clock - this.silence });
    this.turn = undefined;
    this.pending = [];
    this.silence = 0;
  }
  releaseIdentity() {
    this.previous = undefined;
    if (this.turn && this.manualTurn !== this.turn.id) { this.turn.side = undefined; this.identified = false; }
  }
  correct(id: number, side: SpeakerSide) {
    if (this.turn?.id === id) { this.turn.side = side; this.identified = true; this.manualTurn = id; }
    if (this.turn?.id === id || (!this.turn && id === this.nextId - 1)) this.previous = side;
  }
}

export function overlapDetected(overlapFrames: number, speechFrames: number): boolean {
  return overlapFrames >= Math.max(2, speechFrames * 0.1);
}
