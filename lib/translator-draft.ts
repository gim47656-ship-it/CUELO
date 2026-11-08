import { guessTranslatorLanguage, type TranslatorLanguage } from "./translator-languages";

/**
 * Quick draft captions for the interpreter: the dedicated translation model (gpt-realtime-translate)
 * answers in ~3 s, Codex Live in ~11 s. While a draft setting is on, one microphone feeds two
 * dedicated sessions, one per output language, because a single session cannot tell which of the two
 * speakers talks. This module is the pure part: it turns the two sessions' transcript deltas into
 * draft bubbles and hands each bubble over to the Codex translation that replaces it.
 *
 * - A session with output language X also hears X speech, and then it "translates" X into X: an echo.
 *   An echo is itself in X, so the output language alone cannot reject it; the session's own input
 *   transcript can (see `isEcho`). Output deltas can come before the input that proves the echo, so
 *   a shown draft is retracted when its turn turns out to be one.
 * - Turn boundary: the session has no turn event. A new turn starts when an input delta comes more
 *   than `TURN_GAP_MS` after the previous one, or earlier (`LANGUAGE_SWITCH_GAP_MS`) when its script
 *   is the other language's. An output run belongs to the latest turn, except that an output run that
 *   is still streaming stays with its own turn. Turns spoken back to back inside the gap can merge.
 * - Drafts never reach the transcript log, so never Codex or the history sent on reconnect.
 */

/** Silence in a session's input transcript that ends a turn. Words of one turn arrive within ~0.8 s of each other. */
export const TURN_GAP_MS = 1500;
/** Input pause after which a delta in the other language's script starts a new turn (a loanword inside a sentence does not). */
export const LANGUAGE_SWITCH_GAP_MS = 600;
/** An output run that paused less than this is still streaming. */
export const OUTPUT_RUN_GAP_MS = 1200;
/** A draft nobody replaced by then is dropped: Codex skipped that turn or ended its call. */
export const DRAFT_TTL_MS = 20_000;
/** A translation that starts before any input transcript waits this long for the input that may prove it an echo. */
export const OUTPUT_FIRST_HOLD_MS = 800;
/**
 * Codex's first translated text came 8 to 11 s after a turn started in every measured run. A draft this
 * old with a newer draft of its language behind it was skipped by Codex (it can merge quick turns into
 * one translation), and keeping it would pair every later final with the wrong draft.
 */
export const SKIPPED_DRAFT_MS = 15_000;
/** Echo by similarity needs this many letters on both sides; shorter strings match by chance. */
const ECHO_MIN_LETTERS = 8;
const ECHO_SIMILARITY = 0.8;
/** Letters a still-streaming Codex segment needs before its language is trusted to pick a draft. */
const MIN_STREAMING_LETTERS = 6;
/** The same for a completed segment: shorter ones are leftovers, not a translation. */
const MIN_FINAL_LETTERS = 4;
/** Codex segments can open with the previous sentence's tail in the other language: the language is read from the latest letters. */
const TAIL_LETTERS = 24;
const MAX_TURNS_KEPT = 12;
const MAX_COMPARE_LETTERS = 400;

/** The part of a transcript segment this module reads. `TranscriptSegment` satisfies it. */
export interface SegmentLike {
  id: number;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  call: number;
}

export interface DraftPair {
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
}

interface Turn {
  id: number;
  pair: DraftPair;
  target: TranslatorLanguage;
  input: string;
  output: string;
  inputAt: number;
  outputAt: number;
  /** When its first output piece came. */
  outputSince: number;
  /** Sticky: once a turn is an echo, later deltas do not bring its draft back. */
  echo: boolean;
  /** Its draft expired unmatched; later output must not bring it back. */
  dead: boolean;
}

export interface Draft {
  id: number;
  /** Target language of the session that produced it. */
  language: TranslatorLanguage;
  pair: DraftPair;
  turnId: number;
  text: string;
  createdAt: number;
  /** Id of the last transcript segment when the draft appeared: it sits after that segment. */
  after: number;
  /** The Codex assistant segment that took this draft over. */
  matched: number | null;
}

export interface DraftState {
  turns: Record<string, Turn[]>;
  drafts: Draft[];
  /** Assistant segments that are settled: matched, or complete with no draft to take. Segments that existed at reset start in it. */
  seen: number[];
  /** When each other assistant segment first read as a language; a draft made after that is never its draft. A new reading starts it again. */
  born: Record<number, { at: number; code: string }>;
  lastSegmentId: number;
  nextTurnId: number;
  nextDraftId: number;
}

/** Ids keep counting across resets so a React key is never reused. */
export function emptyDraftState(segments: readonly SegmentLike[] = [], previous?: DraftState): DraftState {
  return {
    turns: {},
    drafts: [],
    seen: segments.filter((segment) => segment.role === "assistant").map((segment) => segment.id),
    born: {},
    lastSegmentId: segments.reduce((last, segment) => Math.max(last, segment.id), -1),
    nextTurnId: previous?.nextTurnId ?? 0,
    nextDraftId: previous?.nextDraftId ?? 0,
  };
}

const tailOf = (text: string) => [...text.replace(/\s/gu, "")].slice(-TAIL_LETTERS).join("");

const letterCount = (text: string) => text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;

const letters = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/** 1 for identical letters, ignoring case, accents and punctuation; the output is compared with the input's matching start. */
export function echoSimilarity(output: string, input: string): number {
  const out = letters(output).slice(0, MAX_COMPARE_LETTERS);
  const inn = letters(input);
  if (out.length < ECHO_MIN_LETTERS || inn.length < ECHO_MIN_LETTERS) return 0;
  const window = inn.slice(0, Math.min(MAX_COMPARE_LETTERS, out.length + Math.ceil(out.length * 0.15)));
  return 1 - levenshtein(out, window) / Math.max(out.length, window.length);
}

/** Pairs whose languages share letters: the script tells nothing, so a delta cannot prove a language switch. */
const AMBIGUOUS_PAIRS = [["en", "vi"], ["ja", "zh"]];
const isAmbiguousPair = (pair: DraftPair) => AMBIGUOUS_PAIRS.some((codes) => codes.includes(pair.mine.code) && codes.includes(pair.theirs.code));

function switchesLanguage(pair: DraftPair, text: string, delta: string): boolean {
  if (isAmbiguousPair(pair)) return false;
  const before = guessTranslatorLanguage(text, pair.mine, pair.theirs);
  const now = guessTranslatorLanguage(delta, pair.mine, pair.theirs);
  return before !== undefined && now !== undefined && before.code !== now.code;
}

/** Whether this turn of a session with output language `target` is that session repeating what it heard. */
export function isEcho(pair: DraftPair, target: TranslatorLanguage, turn: Pick<Turn, "input" | "output">): boolean {
  if (guessTranslatorLanguage(turn.input, pair.mine, pair.theirs)?.code === target.code) return true;
  return echoSimilarity(turn.output, turn.input) >= ECHO_SIMILARITY;
}

/** Create, update or retract the draft of one turn after its input or output changed. */
function syncTurn(state: DraftState, pair: DraftPair, target: TranslatorLanguage, turn: Turn, now: number): DraftState {
  const echo = turn.echo || isEcho(pair, target, turn);
  turn.echo = echo;
  const index = state.drafts.findIndex((draft) => draft.language.code === target.code && draft.turnId === turn.id);
  const text = turn.output.trim();
  if (echo || turn.dead) {
    // A draft a Codex final already took over stays as the final's place; only its own text goes.
    if (index < 0) return state;
    const drafts = state.drafts.flatMap((draft, i) => {
      if (i !== index) return [draft];
      return draft.matched === null ? [] : [{ ...draft, text: "" }];
    });
    return { ...state, drafts };
  }
  if (!text) return state;
  if (index < 0 && awaitsInput(turn) && now - turn.outputSince < OUTPUT_FIRST_HOLD_MS) return state;
  if (index >= 0) {
    if (state.drafts[index].text === text) return state;
    return { ...state, drafts: state.drafts.map((draft, i) => (i === index ? { ...draft, text } : draft)) };
  }
  const draft: Draft = {
    id: state.nextDraftId,
    language: target,
    pair,
    turnId: turn.id,
    text,
    createdAt: now,
    after: state.lastSegmentId,
    matched: null,
  };
  return { ...state, drafts: [...state.drafts, draft], nextDraftId: state.nextDraftId + 1 };
}

function withTurns(state: DraftState, target: TranslatorLanguage, turns: Turn[]): DraftState {
  return { ...state, turns: { ...state.turns, [target.code]: turns.slice(-MAX_TURNS_KEPT) } };
}

/** A piece of the input transcript the session with output language `target` heard. */
export function applyInputDelta(state: DraftState, pair: DraftPair, target: TranslatorLanguage, delta: string, now: number): DraftState {
  if (!delta) return state;
  const turns = (state.turns[target.code] ?? []).map((turn) => ({ ...turn }));
  const latest = turns.at(-1);
  const gap = latest ? now - latest.inputAt : Number.POSITIVE_INFINITY;
  const joins = latest !== undefined && gap <= TURN_GAP_MS && !(gap > LANGUAGE_SWITCH_GAP_MS && switchesLanguage(pair, latest.input, delta));
  let turn: Turn;
  let next = state;
  if (joins && latest) {
    turn = latest;
    turn.input += delta;
    turn.inputAt = now;
  } else {
    turn = { id: next.nextTurnId, pair, target, input: delta, output: "", inputAt: now, outputAt: Number.NEGATIVE_INFINITY, outputSince: now, echo: false, dead: false };
    next = { ...next, nextTurnId: next.nextTurnId + 1 };
    turns.push(turn);
  }
  return syncTurn(withTurns(next, target, turns), pair, target, turn, now);
}

/** A piece of the translation the session with output language `target` produced. */
export function applyOutputDelta(state: DraftState, pair: DraftPair, target: TranslatorLanguage, delta: string, now: number): DraftState {
  if (!delta) return state;
  const turns = (state.turns[target.code] ?? []).map((turn) => ({ ...turn }));
  const latest = turns.at(-1);
  let turn = [...turns].reverse().find((candidate) => now - candidate.outputAt <= OUTPUT_RUN_GAP_MS)
    ?? (latest && now - Math.max(latest.inputAt, latest.outputAt) <= TURN_GAP_MS ? latest : undefined);
  let next = state;
  if (!turn) {
    // The translation of a short turn can come before its input transcript, and the latest turn is
    // an older one (often the echo before it): a new turn, which the input that follows joins.
    turn = { id: next.nextTurnId, pair, target, input: "", output: "", inputAt: now, outputAt: now, outputSince: now, echo: false, dead: false };
    next = { ...next, nextTurnId: next.nextTurnId + 1 };
    turns.push(turn);
  }
  if (!turn.output) turn.outputSince = now;
  turn.output += delta;
  turn.outputAt = now;
  return syncTurn(withTurns(next, target, turns), pair, target, turn, now);
}

/** Output with no input transcript that could say which language was spoken: it may be an echo, so it waits. */
const awaitsInput = (turn: Turn) => guessTranslatorLanguage(turn.input, turn.pair.mine, turn.pair.theirs) === undefined;

const isHeld = (state: DraftState, turn: Turn) =>
  awaitsInput(turn) && !turn.echo && !turn.dead && turn.output.trim() !== "" && !state.drafts.some((draft) => draft.turnId === turn.id && draft.language.code === turn.target.code);

/** Whether the state needs a clock tick: a draft is pending, or an output-first translation waits out its hold. */
export function needsTick(state: DraftState): boolean {
  return state.drafts.length > 0 || Object.values(state.turns).some((turns) => turns.some((turn) => isHeld(state, turn)));
}

/** Show the output-first translations whose hold is over although no further delta came to release them. */
function releaseHeld(state: DraftState, now: number): DraftState {
  let next = state;
  for (const turns of Object.values(state.turns)) {
    for (const turn of turns) {
      if (isHeld(next, turn) && now - turn.outputSince >= OUTPUT_FIRST_HOLD_MS) next = syncTurn(next, turn.pair, turn.target, { ...turn }, now);
    }
  }
  return next;
}

/**
 * Expire stale drafts and hand each Codex assistant segment the oldest pending draft of its language
 * (FIFO), skipping drafts Codex evidently skipped (`SKIPPED_DRAFT_MS`). The language is read from the
 * text so far and read again as it grows, until the segment takes a draft or completes: Codex can
 * open a segment with the tail of the previous sentence in the other language. A draft created after
 * a segment first appeared is never that segment's draft.
 */
export function reconcileDrafts(held: DraftState, segments: readonly SegmentLike[], now: number): DraftState {
  const state = releaseHeld(held, now);
  const seen = new Set(state.seen);
  const born = { ...state.born };
  // An overdue draft expires before anything can take it over.
  const stale = state.drafts.filter((draft) => draft.matched === null && now - draft.createdAt > DRAFT_TTL_MS);
  let drafts = state.drafts.filter((draft) => !stale.includes(draft));
  const dropped: Draft[] = [...stale];
  let changed = false;
  for (const segment of segments) {
    if (segment.role !== "assistant" || seen.has(segment.id)) continue;
    if (letterCount(segment.text) < (segment.final ? MIN_FINAL_LETTERS : MIN_STREAMING_LETTERS)) continue;
    const language = guessTranslatorLanguage(tailOf(segment.text), segment.mine, segment.theirs);
    if (language) {
      if (born[segment.id]?.code !== language.code) {
        born[segment.id] = { at: now, code: language.code };
        changed = true;
      }
      const pending = () => drafts.filter((draft) => draft.matched === null && draft.text && draft.language.code === language.code && draft.createdAt <= born[segment.id].at);
      while (pending().length > 1 && now - pending()[0].createdAt > SKIPPED_DRAFT_MS) {
        const skipped = pending()[0];
        dropped.push(skipped);
        drafts = drafts.filter((draft) => draft !== skipped);
      }
      const oldest = pending()[0];
      if (oldest) {
        drafts = drafts.map((draft) => (draft === oldest ? { ...oldest, matched: segment.id } : draft));
        seen.add(segment.id);
        changed = true;
        continue;
      }
    }
    if (segment.final) {
      seen.add(segment.id);
      changed = true;
    }
  }
  const ids = new Set(segments.map((segment) => segment.id));
  const expired = drafts.filter((draft) => (draft.matched === null ? now - draft.createdAt > DRAFT_TTL_MS : !ids.has(draft.matched)));
  dropped.push(...expired.filter((draft) => draft.matched === null));
  drafts = drafts.filter((draft) => !expired.includes(draft));
  let turns = state.turns;
  if (dropped.length > 0) {
    // A dropped draft's turn must not bring it back with a later delta.
    turns = { ...turns };
    for (const draft of dropped) {
      turns[draft.language.code] = (turns[draft.language.code] ?? []).map((turn) => (turn.id === draft.turnId ? { ...turn, dead: true } : turn));
    }
  }
  const lastSegmentId = segments.reduce((last, segment) => Math.max(last, segment.id), state.lastSegmentId);
  if (!changed && dropped.length === 0 && expired.length === 0 && lastSegmentId === state.lastSegmentId) return state;
  return { ...state, turns, drafts, seen: [...seen], born, lastSegmentId };
}

/** What a bubble shows: a transcript segment, or the draft standing in for the one that is still coming. */
export interface DisplayLine<S extends SegmentLike = SegmentLike> {
  key: string;
  segment: S;
  /** The text shown is the dedicated model's draft, not Codex's. */
  draft: boolean;
  /** Set when the line is (or took over) a draft: its language is known, not guessed from the text. */
  language?: TranslatorLanguage;
}

/**
 * The bubbles in order. A draft sits after the segment that was last when it appeared. A matched
 * draft keeps its place and key and shows the Codex text once that is complete or longer than the
 * draft, so the bubble never shrinks and grows back while the final streams in.
 */
export function mergeDisplay<S extends SegmentLike>(segments: readonly S[], state: DraftState): DisplayLine<S>[] {
  const taken = new Map(state.drafts.filter((draft) => draft.matched !== null).map((draft) => [draft.matched, draft]));
  const items: { order: number; line: DisplayLine<S> }[] = [];
  const waiting = state.drafts.some((draft) => draft.matched === null && draft.text);
  for (const segment of segments) {
    if (taken.has(segment.id)) continue;
    // A Codex translation that has only just begun cannot take a draft yet (`MIN_STREAMING_LETTERS`); showing
    // it for that moment would put a second bubble beside the draft it is about to replace.
    if (waiting && segment.role === "assistant" && !segment.final && !state.seen.includes(segment.id) && letterCount(segment.text) < MIN_STREAMING_LETTERS) continue;
    items.push({ order: segment.id, line: { key: `s${segment.id}`, segment, draft: false } });
  }
  for (const draft of state.drafts) {
    const order = draft.after + 0.5 + draft.id * 1e-6;
    if (draft.matched === null) {
      if (!draft.text) continue;
      const segment = { id: -1 - draft.id, role: "assistant", text: draft.text, final: false, mine: draft.pair.mine, theirs: draft.pair.theirs, call: 0 } as S;
      items.push({ order, line: { key: `d${draft.id}`, segment, draft: true, language: draft.language } });
      continue;
    }
    const segment = segments.find((candidate) => candidate.id === draft.matched);
    if (!segment) continue;
    const showDraft = draft.text !== "" && !segment.final && segment.text.trim().length < draft.text.length;
    items.push({
      order,
      line: { key: `d${draft.id}`, segment: showDraft ? { ...segment, text: draft.text } : segment, draft: showDraft, language: draft.language },
    });
  }
  return items.sort((a, b) => a.order - b.order).map((item) => item.line);
}
