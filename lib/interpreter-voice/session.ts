import { languageSide, type SpeakerSide } from "./speakers";
import type { TranslatorLanguage } from "../translator-languages";
export interface VoiceUtterance {
  id: number;
  text: string;
  startMs: number;
  endMs: number;
  side?: SpeakerSide;
  closed: boolean;
  translation: string;
  final: boolean;
  translationError?: boolean;
}
export interface DirectedTranslation {
  text: string; source: string; target: string; previous: string[]; signal: AbortSignal;
  onDelta(text: string): void;
}
export type FinalTranslator = (request: DirectedTranslation) => Promise<string>;
export class OrderedOutput<T> {
  private next = 0;
  private values = new Map<number, T>();
  ready(sequence: number, value: T): T[] {
    this.values.set(sequence, value);
    const result: T[] = [];
    while (this.values.has(this.next)) { result.push(this.values.get(this.next)!); this.values.delete(this.next++); }
    return result;
  }
}
interface Job { item: VoiceUtterance; revision: number; sequence: number; abort: AbortController }
/** Source is immediate; completed translations and playback release in audio order, not network order. */
export class VoiceInterpreterSession {
  readonly utterances = new Map<number, VoiceUtterance>();
  private serverItems = new Map<string, number>();
  private revisions = new Map<number, number>();
  private manualSides = new Map<number, SpeakerSide>();
  private jobs: Job[] = [];
  private active = new Set<Job>();
  private output = new OrderedOutput<{ job: Job; text?: string; error?: boolean }>();
  private sequence = 0;
  private reservations = new Map<number, number>();
  private stopped = false;
  private idleResolvers: (() => void)[] = [];
  constructor(private options: {
    mine: TranslatorLanguage; theirs: TranslatorLanguage; translate: FinalTranslator;
    onUpdate(item: VoiceUtterance): void; onFinal(item: VoiceUtterance): void;
  }) {}
  open(turn: { id: number; startMs: number; endMs: number; side?: SpeakerSide }) {
    this.utterances.set(turn.id, { ...turn, text: "", closed: false, translation: "", final: false });
    this.reservations.set(turn.id, this.sequence++);
  }
  direction(id: number, side: SpeakerSide) {
    const item = this.utterances.get(id);
    if (item && !item.closed && !this.manualSides.has(id)) { item.side = side; this.options.onUpdate({ ...item }); }
  }
  commit(turn: { id: number; startMs: number; endMs: number; side?: SpeakerSide }) {
    const item = this.utterances.get(turn.id);
    if (!item) return;
    item.startMs = turn.startMs; item.endMs = turn.endMs;
    if (turn.side !== undefined) item.side = turn.side;
    const corrected = this.manualSides.get(turn.id);
    if (corrected) item.side = corrected;
  }
  private bind(serverId: string): VoiceUtterance | undefined {
    let id = this.serverItems.get(serverId);
    if (id === undefined) {
      const assigned = new Set(this.serverItems.values());
      id = [...this.utterances.keys()].find((key) => !assigned.has(key));
      if (id !== undefined) this.serverItems.set(serverId, id);
    }
    return id === undefined ? undefined : this.utterances.get(id);
  }
  committed(serverId: string) { this.bind(serverId); }
  transcript(serverId: string, text: string, final: boolean) {
    const item = this.bind(serverId);
    if (!item || this.stopped || item.closed) return;
    item.text = final ? text : item.text + text;
    // First recognizable source locks this utterance; code switching cannot flip it later.
    item.side ??= languageSide(item.text, this.options.mine, this.options.theirs) ?? this.previousSide(item.id);
    item.closed = final;
    this.options.onUpdate({ ...item });
    if (final) this.schedule(item);
    return item;
  }
  /** A failed recognition closes only its own utterance, keeping whatever partial source arrived. */
  failed(serverId: string) {
    const item = this.bind(serverId);
    return item && !item.closed ? this.transcript(serverId, item.text, true) : item;
  }
  correct(id: number, side: SpeakerSide) {
    const item = this.utterances.get(id);
    if (!item || this.stopped) return;
    this.manualSides.set(id, side);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    for (const job of [...this.jobs, ...this.active]) if (job.item.id === id) job.abort.abort();
    if (item.closed) this.reservations.set(id, this.sequence++);
    item.side = side; item.translation = ""; item.final = false; item.translationError = false;
    this.options.onUpdate({ ...item });
    if (item.closed) this.schedule(item);
  }
  releaseDirection(id: number | undefined) {
    if (id === undefined || this.manualSides.has(id)) return;
    const item = this.utterances.get(id);
    if (item && !item.closed) { item.side = languageSide(item.text, this.options.mine, this.options.theirs); this.options.onUpdate({ ...item }); }
  }
  private schedule(item: VoiceUtterance) {
    // Even ambiguous/numeric text must be interpreted; mine is the deterministic initial language rule.
    item.side ??= this.previousSide(item.id) ?? "me";
    const job = { item: { ...item }, revision: this.revisions.get(item.id) ?? 0, sequence: this.reservations.get(item.id)!, abort: new AbortController() };
    this.jobs.push(job); this.pump();
  }
  private previousSide(id: number) {
    let side: SpeakerSide | undefined;
    for (const item of this.utterances.values()) if (item.id < id && item.side) side = item.side;
    return side;
  }
  private valid(job: Job) { return !this.stopped && !job.abort.signal.aborted && job.revision === (this.revisions.get(job.item.id) ?? 0); }
  private pump() {
    while (!this.stopped && this.active.size < 2 && this.jobs.length) {
      const job = this.jobs.shift()!;
      this.active.add(job);
      const source = job.item.side === "me" ? this.options.mine : this.options.theirs;
      const target = job.item.side === "me" ? this.options.theirs : this.options.mine;
      const previous = [...this.utterances.values()].filter((item) => item.id < job.item.id && item.side === job.item.side && item.closed && item.text.trim()).slice(-1).map((item) => item.text);
      const run = this.valid(job) && job.item.text.trim() ? this.options.translate({ text: job.item.text, source: source.code, target: target.code, previous, signal: job.abort.signal,
        onDelta: (text) => { if (this.valid(job)) { const item = this.utterances.get(job.item.id)!; item.translation = text; this.options.onUpdate({ ...item }); } },
      }).then((text) => ({ job, text }), () => ({ job, error: true as const })) : Promise.resolve({ job, text: "" });
      void run.then((result) => {
        for (const ready of this.output.ready(job.sequence, result)) {
          if (!this.valid(ready.job)) continue;
          const item = this.utterances.get(ready.job.item.id)!;
          item.translation = "text" in ready ? ready.text ?? "" : "";
          item.translationError = "error" in ready || (!!item.text.trim() && !item.translation.trim());
          item.final = true;
          this.options.onUpdate({ ...item });
          this.options.onFinal({ ...item });
        }
        this.active.delete(job); this.pump();
        if (!this.active.size && !this.jobs.length) for (const resolve of this.idleResolvers.splice(0)) resolve();
      });
    }
  }
  whenIdle() {
    if (!this.active.size && !this.jobs.length) return Promise.resolve();
    const done = Promise.withResolvers<void>();
    this.idleResolvers.push(done.resolve);
    return done.promise;
  }
  completeInput() {
    if (this.stopped) return;
    for (const item of this.utterances.values()) {
      if (item.closed) continue;
      item.closed = true;
      this.options.onUpdate({ ...item });
      this.schedule(item);
    }
  }
  close() { this.stopped = true; for (const job of [...this.active, ...this.jobs]) job.abort.abort(); this.jobs = []; for (const resolve of this.idleResolvers.splice(0)) resolve(); }
}
