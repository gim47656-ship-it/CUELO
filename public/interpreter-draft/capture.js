// AudioWorklet for the interpreter's quick draft captions: collects the microphone as PCM16 mono in
// fixed chunks (the context runs at 24 kHz, the rate the dedicated translation model takes) and hands
// each chunk to the page. `{ muted }` messages from the page zero the audio at once; the page sends
// them when the echo guard blocks the microphone, so the drafts hear exactly what Codex hears.
// Browser AEC handles the room. Fast interpretation also supplies the exact output mix, so a
// delayed copy that survives AEC can be subtracted without closing the mic during double-talk.
// Where a loud or slow speaker defeats that, `{ guard }` closes the mic while the mix plays and
// for `GUARD_HOLD` after it, like the Codex echo guard (`lib/interpreter-echo-gate.ts`).
const REFERENCE_RING = 8192;
const REFERENCE_MASK = REFERENCE_RING - 1;
const MAX_DELAY = 5760; // 240 ms at 24 kHz
const FIT_WINDOW = 512;
const FIT_MASK = FIT_WINDOW - 1;
const MATCH_SCORE = 0.81;
const GUARD_HOLD = 12000; // 500 ms at 24 kHz, `ECHO_HOLD_MS`

class PlaybackReference {
  constructor() {
    this.ring = new Float32Array(REFERENCE_RING);
    this.capture = new Float32Array(FIT_WINDOW);
    this.cursor = 0;
    this.quietFrames = MAX_DELAY;
    this.delay = 0;
    this.gain = 0;
    this.blocks = 0;
  }

  fit(start, delay, energy) {
    let cross = 0;
    let refEnergy = 0;
    for (let i = 0; i < FIT_WINDOW; i += 4) {
      const at = start + i;
      const ref = this.ring[(at - delay) & REFERENCE_MASK];
      cross += this.capture[at & FIT_MASK] * ref;
      refEnergy += ref * ref;
    }
    if (cross <= 0 || refEnergy < 0.0001) return;
    const score = cross * cross / (energy * refEnergy);
    if (score > this.bestScore && cross <= 3 * refEnergy) {
      this.bestScore = score;
      this.bestGain = cross / refEnergy;
      this.bestDelay = delay;
    }
  }

  push(input, reference, frames) {
    const start = this.cursor;
    for (let i = 0; i < frames; i++) {
      const ref = reference?.[i] ?? 0;
      this.ring[this.cursor] = ref;
      this.capture[this.cursor & FIT_MASK] = input?.[i] ?? 0;
      this.cursor = (this.cursor + 1) & REFERENCE_MASK;
      this.quietFrames = ref === 0 ? this.quietFrames + 1 : 0;
    }
    if (!input || this.quietFrames >= MAX_DELAY + FIT_WINDOW) return start;
    const fitStart = this.cursor - FIT_WINDOW;
    let energy = 0;
    for (let i = 0; i < FIT_WINDOW; i += 4) energy += this.capture[(fitStart + i) & FIT_MASK] ** 2;
    if (energy < 0.0001) return start;
    this.bestScore = 0;
    this.fit(fitStart, this.delay, energy);
    if (!this.gain && this.bestScore < MATCH_SCORE && (this.blocks++ & 3) === 0) {
      for (let delay = 0; delay <= MAX_DELAY; delay += 8) this.fit(fitStart, delay, energy);
      const coarse = this.bestDelay ?? this.delay;
      for (let delay = Math.max(0, coarse - 7); delay <= Math.min(MAX_DELAY, coarse + 7); delay++) this.fit(fitStart, delay, energy);
    }
    // Do not reacquire a new delay from overlapping speech. A silent reference subtracts zero.
    if (this.bestScore >= MATCH_SCORE) {
      this.gain = this.gain ? 0.95 * this.gain + 0.05 * this.bestGain : this.bestGain;
      this.delay = this.bestDelay;
    }
    return start;
  }

  subtract(input, at) {
    return input - this.gain * this.ring[(at - this.delay) & REFERENCE_MASK];
  }
}

class InterpreterDraftCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.chunkSamples;
    this.playback = options.processorOptions.cancelPlayback ? new PlaybackReference() : null;
    this.chunk = new Int16Array(this.size);
    this.filled = 0;
    this.muted = false;
    this.guard = false;
    // Counted even while the guard is off, so turning it on mid-call keeps the hold after playback.
    this.sincePlayback = GUARD_HOLD;
    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.muted === "boolean") this.muted = event.data.muted;
      if (event.data && typeof event.data.guard === "boolean") this.guard = event.data.guard;
    };
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    // Without input (the track ended) the frame counts as silence, so the chunk clock keeps running.
    const frames = input ? input.length : 128;
    const reference = inputs[1]?.[0];
    this.sincePlayback = reference?.some((sample) => sample !== 0) ? 0 : this.sincePlayback + frames;
    const mic = this.muted || (this.guard && this.sincePlayback < GUARD_HOLD) ? null : input;
    const start = this.playback?.push(mic, reference, frames) ?? 0;
    const cancel = mic && this.playback?.gain ? this.playback : null;
    for (let i = 0; i < frames; i += 1) {
      const raw = mic?.[i] ?? 0;
      const sample = Math.max(-1, Math.min(1, cancel ? cancel.subtract(raw, start + i) : raw));
      this.chunk[this.filled] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.filled += 1;
      if (this.filled === this.size) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("interpreter-draft-capture", InterpreterDraftCapture);
