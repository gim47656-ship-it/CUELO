import { AudioTurns, AUDIO_RATE, SPEAKER_BUFFER_MS, overlapDetected } from "@/lib/interpreter-voice/audio-turns";
import { shouldChunkMonologue } from "@/lib/interpreter-voice/chunks";
import { confidentSide, singleVoiceSide, speakerBoundary, type SpeakerSide, type VoiceMatch } from "@/lib/interpreter-voice/speakers";
import { VoiceInterpreterSession, type VoiceUtterance } from "@/lib/interpreter-voice/session";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import type { InterpreterProfile } from "@/lib/translator-context";
import { readInterpreterTextEvents } from "./read-text-stream";
import { readAloud } from "./read-aloud";

export interface VoiceEngineOptions {
  mine: TranslatorLanguage; theirs: TranslatorLanguage; profile: InterpreterProfile;
  onUpdate(item: VoiceUtterance): void;
  onState(state: "connecting" | "live" | "working" | "idle" | "error", failure?: string): void;
  onModels(state: "loading" | "ready" | "failed", percent: number): void;
  onEnrollment(side: SpeakerSide | null, seconds: number, failed?: boolean): void;
  onOverlap(): void;
  playback(): { enabled: boolean; echoGuard: boolean };
}
function pcmBase64(samples: Int16Array) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function resample16(samples: Int16Array): Float32Array {
  const output = new Float32Array(Math.floor(samples.length * 2 / 3));
  for (let i = 0; i < output.length; i++) {
    const position = i * 1.5, index = Math.floor(position), fraction = position - index;
    output[i] = ((samples[index] ?? 0) * (1 - fraction) + (samples[index + 1] ?? samples[index] ?? 0) * fraction) / 32768;
  }
  return output;
}
/** Correction re-enrollment reads at most 3 s of the corrected turn; only recent turns stay correctable. */
const CORRECTION_AUDIO_SAMPLES = AUDIO_RATE * 3;
const CORRECTION_TURNS = 20;
/** Owns one microphone, transcription socket and local workers; no work session is created. */
export class VoiceEngine {
  readonly session: VoiceInterpreterSession;
  private turns: AudioTurns;
  private socket?: WebSocket;
  private worker?: Worker;
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private abort = new AbortController();
  private disposed = false;
  private stopping = false;
  private speakerReady = false;
  private workerBusy = false;
  private nextAnalysis = 1000;
  private analysisRing = new Float32Array(24000);
  private analysisSize = 0;
  private lastAnalysis?: { endMs: number; matches: VoiceMatch[] };
  private identityEpoch = 0;
  private enrollment: SpeakerSide | null = "me";
  private enrollmentAudio: Float32Array[] = [];
  private enrollmentSize = 0;
  private pendingEnrollment?: SpeakerSide;
  private confirmedSides = new Set<SpeakerSide>();
  private enrollmentFailed = false;
  private audio = new Map<number, { chunks: Int16Array[]; size: number }>();
  private playbackQueue = Promise.resolve();
  private pendingFinals = new Set<number>();
  private finalWaiters: (() => void)[] = [];
  private guardTimer?: number;
  private stopFailure?: string;
  constructor(private options: VoiceEngineOptions) {
    this.session = new VoiceInterpreterSession({ ...options,
      translate: async ({ text, source, previous, signal, onDelta }) => {
        const response = await fetch("/api/live/interpret/text", { method: "POST", headers: { "Content-Type": "application/json" }, signal,
          body: JSON.stringify({ mine: options.mine.code, theirs: options.theirs.code, source, text, mode: "voice", profile: options.profile,
            history: previous.map((part) => ({ role: "user", text: part })) }),
        });
        if (!response.ok || !response.body) throw new Error(response.status === 401 ? "auth" : "upstream");
        let partial = "";
        for await (const event of readInterpreterTextEvents(response.body)) {
          if (event.type === "delta") { partial += event.text; onDelta(partial); }
          else if (event.type === "done") return event.text;
          else if (event.type === "error") throw new Error(event.error);
        }
        throw new Error("Incomplete interpretation");
      },
      onFinal: (item) => {
        const text = item.translation;
        if (!text || item.translationError || !options.playback().enabled) return;
        const language = item.side === "me" ? options.theirs : options.mine;
        this.playbackQueue = this.playbackQueue.then(async () => {
          if (this.disposed || !options.playback().enabled || !this.context) return;
          let guarded = false;
          try {
            await readAloud(text, language, this.abort.signal, () => this.context!, () => {
              clearTimeout(this.guardTimer);
              guarded = options.playback().echoGuard;
              this.node?.port.postMessage({ muted: guarded });
            });
          } catch { /* Keep the translation readable and allow the next utterance to play. */ }
          finally {
            if (guarded && !this.disposed) this.guardTimer = window.setTimeout(() => this.node?.port.postMessage({ muted: false }), 250);
          }
        });
      },
    });
    this.turns = new AudioTurns({
      open: (turn) => {
        this.session.open(turn); this.audio.set(turn.id, { chunks: [], size: 0 });
        if (this.audio.size > CORRECTION_TURNS) this.audio.delete(this.audio.keys().next().value!);
      },
      append: (samples, turn) => {
        const kept = this.audio.get(turn.id);
        if (kept && kept.size < CORRECTION_AUDIO_SAMPLES) { const part = samples.slice(0, CORRECTION_AUDIO_SAMPLES - kept.size); kept.chunks.push(part); kept.size += part.length; }
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcmBase64(samples) }));
      },
      commit: (turn) => {
        this.session.commit(turn); this.pendingFinals.add(turn.id);
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      },
    });
  }
  async start() {
    this.options.onState("connecting");
    this.options.onModels("loading", 0);
    this.options.onEnrollment("me", 0);
    try {
      this.worker = new Worker("/interpreter-voice/worker.mjs", { type: "module" });
      this.worker.onmessage = ({ data }) => this.workerMessage(data);
      this.worker.onerror = () => { this.workerMessage({ type: "speaker-failed" }); this.workerBusy = false; };
      this.worker.postMessage({ type: "init" });
    } catch { this.workerMessage({ type: "speaker-failed" }); }
    try {
      // Called synchronously from the start gesture; model downloads do not gate mic or STT.
      const context = new AudioContext({ sampleRate: AUDIO_RATE });
      this.context = context;
      const resume = context.resume();
      const media = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).catch((error) => {
        throw new Error(error instanceof DOMException && /NotAllowed|Security/.test(error.name) ? "mic-denied" : "mic-unavailable");
      }).then((stream) => {
        this.stream = stream;
        if (this.disposed) stream.getTracks().forEach((track) => track.stop());
        return stream;
      });
      const [stream] = await Promise.all([media, resume]);
      if (this.stopping || this.disposed) return;
      // A permission dialog may stay open for minutes; mint the 60-second secret only afterwards.
      const response = await fetch("/api/live/transcribe-secret", { method: "POST", headers: { "Content-Type": "application/json" }, signal: this.abort.signal,
        body: JSON.stringify({ mine: this.options.mine.code, theirs: this.options.theirs.code }) });
      if (this.stopping || this.disposed) return;
      if (!response.ok) throw new Error(response.status === 401 ? "auth" : "upstream");
      const { secret } = await response.json();
      if (this.stopping || this.disposed) return;
      await this.connect(secret);
      await resume;
      await context.audioWorklet.addModule("/interpreter-draft/capture.js");
      if (this.stopping) return;
      if (this.disposed) return;
      this.node = new AudioWorkletNode(context, "interpreter-draft-capture", { numberOfOutputs: 0, processorOptions: { chunkSamples: 2400 } });
      this.node.port.onmessage = ({ data }) => this.capture(new Int16Array(data));
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(this.node);
      this.options.onState("live");
    } catch (error) {
      if (this.disposed || this.stopping) return;
      const failure = error instanceof Error && ["auth", "mic-denied", "mic-unavailable"].includes(error.message) ? error.message : "upstream";
      this.options.onState("error", failure);
      this.dispose();
    }
  }
  private async connect(secret: string) {
    const ready = Promise.withResolvers<void>();
    const socket = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", ["realtime", `openai-insecure-api-key.${secret}`]);
    this.socket = socket;
    const timeout = setTimeout(() => ready.reject(new Error("upstream")), 15000);
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(String(data));
      if (event.type === "session.created" || event.type === "session.updated") ready.resolve();
      else if (event.type === "input_audio_buffer.committed") this.session.committed(event.item_id);
      else if (event.type === "conversation.item.input_audio_transcription.delta") this.session.transcript(event.item_id, event.delta ?? "", false);
      else if (event.type === "conversation.item.input_audio_transcription.completed" || event.type === "conversation.item.input_audio_transcription.failed") {
        // A failed item closes with its partial source; only that utterance ends, not the session.
        const item = event.type.endsWith(".failed") ? this.session.failed(event.item_id) : this.session.transcript(event.item_id, event.transcript ?? "", true);
        if (item) {
          this.pendingFinals.delete(item.id);
        }
        if (!this.pendingFinals.size) for (const resolve of this.finalWaiters.splice(0)) resolve();
      } else if (event.type === "error") {
        ready.reject(new Error("upstream"));
        this.stopFailure = "upstream";
        for (const resolve of this.finalWaiters.splice(0)) resolve();
        if (!this.disposed) void this.stop("upstream");
      }
    };
    socket.onerror = () => { ready.reject(new Error("upstream")); this.stopFailure = "upstream"; for (const resolve of this.finalWaiters.splice(0)) resolve(); if (!this.disposed) void this.stop("upstream"); };
    socket.onclose = () => {
      ready.reject(new Error("upstream"));
      for (const resolve of this.finalWaiters.splice(0)) resolve();
      if (!this.disposed && !this.stopping) void this.stop("upstream");
    };
    try { await ready.promise; } finally { clearTimeout(timeout); }
  }
  private capture(samples: Int16Array) {
    if (this.disposed || this.stopping || this.socket?.readyState !== WebSocket.OPEN) return;
    const floats = resample16(samples);
    let energy = 0; for (const value of floats) energy += value * value;
    if (this.enrollment && !this.pendingEnrollment && energy / floats.length >= 0.000144 && this.enrollmentSize < 48000) {
      this.enrollmentAudio.push(floats); this.enrollmentSize += floats.length;
      this.options.onEnrollment(this.enrollment, this.enrollmentSize / 16000, this.enrollmentFailed);
    }
    this.turns.push(samples, this.speakerReady ? this.enrollment ?? undefined : undefined);
    const current = this.turns.current;
    if (current && shouldChunkMonologue(this.session.utterances.get(current.id)?.text ?? "", this.turns.now - current.startMs)) this.turns.finish();
    this.analysisRing.copyWithin(0, floats.length);
    this.analysisRing.set(floats, this.analysisRing.length - floats.length);
    this.analysisSize = Math.min(this.analysisRing.length, this.analysisSize + floats.length);
    if (this.turns.now >= this.nextAnalysis && this.analysisSize >= 16000 && !this.workerBusy && this.worker) {
      this.nextAnalysis = this.turns.now + 250; this.workerBusy = true;
      const window = this.analysisRing.slice(this.analysisRing.length - this.analysisSize);
      this.worker.postMessage({ type: "analyze", samples: window, endMs: this.turns.now, epoch: this.identityEpoch }, [window.buffer]);
    }
  }
  private workerMessage(data: { type: string; percent?: number; matches?: VoiceMatch[]; endMs?: number; epoch?: number; overlapFrames?: number; speechFrames?: number; side?: SpeakerSide; ok?: boolean }) {
    if (this.disposed || this.stopping) return;
    if (data.type === "progress") this.options.onModels("loading", data.percent ?? 0);
    else if (data.type === "speaker-ready") { this.speakerReady = true; this.turns.holdMs = SPEAKER_BUFFER_MS; this.options.onModels("ready", 100); }
    else if (data.type === "speaker-failed") {
      this.speakerReady = false; this.turns.holdMs = 0; this.options.onModels("failed", 0);
      this.enrollment = null; this.pendingEnrollment = undefined; this.enrollmentAudio = []; this.enrollmentSize = 0;
      this.options.onEnrollment(null, 0);
    }
    else if (data.type === "enrolled" && data.side) {
      if (this.pendingEnrollment === data.side) {
        this.pendingEnrollment = undefined;
        if (!data.ok) {
          this.enrollmentFailed = true;
          this.enrollmentAudio = []; this.enrollmentSize = 0;
          this.options.onEnrollment(this.enrollment, 0, true);
          return;
        }
        this.confirmedSides.add(data.side); this.enrollmentFailed = false;
        this.enrollment = data.side === "me" ? "them" : null;
        this.enrollmentAudio = []; this.enrollmentSize = 0;
        this.options.onEnrollment(this.enrollment, 0);
      }
    }
    else if (data.type === "analysis" || data.type === "analysis-error") {
      this.workerBusy = false;
      if (data.epoch !== undefined && data.epoch !== this.identityEpoch) return;
      if (data.type === "analysis-error") return;
      if (overlapDetected(data.overlapFrames ?? 0, data.speechFrames ?? 0)) this.options.onOverlap();
      const analysis = { endMs: data.endMs ?? this.turns.now, matches: data.matches ?? [] };
      const duration = this.turns.current ? (analysis.endMs - this.turns.current.startMs) / 1000 : 0;
      const side = this.speakerReady ? this.enrollment ?? confidentSide(analysis.matches, duration)
        ?? singleVoiceSide(analysis.matches, duration) : undefined;
      if (side && this.turns.current && analysis.endMs >= this.turns.current.startMs + 500) {
        this.turns.identify(side, speakerBoundary(this.lastAnalysis, analysis, this.turns.current?.side, side));
        if (this.turns.current) this.session.direction(this.turns.current.id, side);
      }
      if (side) this.lastAnalysis = analysis;
    }
  }
  nextEnrollment() {
    if (!this.enrollment || this.pendingEnrollment || !this.speakerReady || this.enrollmentSize < 16000) return;
    this.enrollmentFailed = false;
    const samples = new Float32Array(this.enrollmentSize);
    let offset = 0; for (const chunk of this.enrollmentAudio) { samples.set(chunk, offset); offset += chunk.length; }
    this.pendingEnrollment = this.enrollment;
    this.worker?.postMessage({ type: "enroll", side: this.enrollment, samples }, [samples.buffer]);
    this.turns.finish();
    this.enrollmentAudio = []; this.enrollmentSize = 0;
    this.options.onEnrollment(this.enrollment, 0);
  }
  skipEnrollment() {
    const currentId = this.turns.current?.id;
    this.identityEpoch++; this.lastAnalysis = undefined;
    if (!this.confirmedSides.size) this.worker?.postMessage({ type: "reset" });
    else if (this.pendingEnrollment && !this.confirmedSides.has(this.pendingEnrollment)) this.worker?.postMessage({ type: "remove", side: this.pendingEnrollment });
    this.turns.releaseIdentity(); this.session.releaseDirection(currentId);
    this.turns.finish();
    this.enrollment = null; this.pendingEnrollment = undefined; this.enrollmentAudio = []; this.enrollmentSize = 0;
    this.enrollmentFailed = false;
    this.options.onEnrollment(null, 0);
  }
  private enrollAudio(id: number, side: SpeakerSide) {
    const kept = this.audio.get(id);
    if (!kept || kept.size < AUDIO_RATE) return;
    const joined = new Int16Array(kept.size);
    let offset = 0;
    for (const chunk of kept.chunks) { joined.set(chunk, offset); offset += chunk.length; }
    const samples = resample16(joined);
    this.worker?.postMessage({ type: "enroll", side, samples }, [samples.buffer]);
  }
  correct(id: number, side: SpeakerSide) {
    this.identityEpoch++; this.turns.correct(id, side); this.lastAnalysis = undefined;
    this.session.correct(id, side); this.enrollAudio(id, side);
  }
  async stop(failure?: string) {
    if (this.disposed || this.stopping) return;
    this.stopping = true;
    this.stopFailure ??= failure;
    if (!this.socket) { this.dispose(); this.options.onState(failure ? "error" : "idle", failure); return; }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.source?.disconnect(); this.node?.disconnect();
    this.turns.finish();
    this.options.onEnrollment(null, 0);
    this.options.onState(failure ? "error" : "working", failure);
    if (this.pendingFinals.size && !failure) {
      const done = Promise.withResolvers<void>(); this.finalWaiters.push(done.resolve);
      const timeout = setTimeout(done.resolve, 15000);
      await done.promise; clearTimeout(timeout);
    }
    if (this.disposed) return;
    if (this.socket) this.socket.onmessage = null;
    this.session.completeInput();
    await this.session.whenIdle();
    if (this.disposed) return;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.source?.disconnect(); this.node?.disconnect();
    void this.playbackQueue.then(() => { if (!this.disposed) void this.context?.close().catch(() => {}); });
    this.socket?.close(1000); this.worker?.terminate(); clearTimeout(this.guardTimer);
    this.audio.clear(); this.enrollmentAudio = []; this.analysisRing.fill(0);
    this.options.onState(this.stopFailure ? "error" : "idle", this.stopFailure);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.abort.abort(); this.session.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.source?.disconnect(); this.node?.disconnect();
    void this.context?.close().catch(() => {});
    if (this.socket) this.socket.onmessage = null;
    this.socket?.close(1000); this.worker?.terminate(); clearTimeout(this.guardTimer);
    this.audio.clear(); this.enrollmentAudio = []; this.analysisRing.fill(0);
    for (const resolve of this.finalWaiters.splice(0)) resolve();
  }
}
