import { buildDelegationContextAppend, type LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import {
  armLiveOrphanTimer,
  attachLiveListener,
  configuredLiveVoice,
  emitLiveEvent,
  finishLiveCall,
  openLiveSideband,
  setLiveState,
  signalLiveCall,
  updateLiveCallTranscript,
  type LiveCallCore,
} from "./live-session";
import type { LiveEvent, LiveTranscriptRole } from "./live-types";
import {
  EMPTY_INTERPRETER_CONTEXT,
  type InterpreterContext,
  type SpeakerAge,
  type SpeakerGender,
  type TranslatorMood,
} from "./translator-context";
import type { TranslatorLanguage } from "./translator-languages";

/**
 * 통역 모드의 Codex 라이브 통화. 신호 교환·사이드밴드·종료는 `lib/live-session.ts`의 공용 부분을
 * 그대로 쓰고, 다른 점은 이것뿐이다.
 *
 * - 작업 세션이 없다. 에이전트 세션을 열거나 구독하지 않고, 전사를 어디에도 저장하지 않으며,
 *   하네스 페르소나(SDK `live-instructions.md`)·대화 기록 요약을 넘기지 않는다.
 * - 지시는 고른 두 언어로 만든 통역 지시뿐이다.
 * - 위임이 와도 아무것도 실행하지 않는다. 소리 내지 않는 commentary 채널로 "여기는 백엔드가 없다"고만
 *   돌려준다.
 * - 목소리는 설정의 Codex 목소리(`live.voice`)다.
 *
 * 통화 id는 Codex가 붙인 `rtc_*`라 세션 통화와 겹치지 않는다. 이벤트 스트림과 끊기는 기존
 * `/api/live/events`·`/api/live/call/[callId]`가 세션 통화를 먼저 찾고, 없을 때 여기서 찾는다.
 */

/** An interpreter call: the shared core plus the wire turn each role is speaking. */
export interface InterpreterCall extends LiveCallCore {
  /** `turn.id` of the latest `turn.created` per role. */
  turnIds: Record<LiveTranscriptRole, string | undefined>;
}

declare global {
  var __interpreterCalls: Map<string, InterpreterCall> | undefined;
}

function interpreterCalls(): Map<string, InterpreterCall> {
  globalThis.__interpreterCalls ??= new Map();
  return globalThis.__interpreterCalls;
}

const MOOD_SETTINGS: Record<TranslatorMood, string> = {
  casual: "relaxed and friendly, like friends or people of a similar age chatting. Use casual everyday speech in both languages instead of stiff polite forms (Korean 반말 is fine; Vietnamese friendly pairs such as \"anh\"/\"em\" or \"mình\"/\"bạn\"). Do not invent slang.",
  polite: "polite and courteous, as with shop staff, drivers or strangers. Use the ordinary polite forms of each language.",
  formal: "formal and respectful, as in a business meeting or with officials. Use the most formal standard forms of each language (Korean 합니다체; Vietnamese \"tôi\" with \"anh\", \"chị\", \"ông\" or \"bà\").",
  haggling: "bargaining over a price. Keep the firm, friendly tone of the bargaining that was actually said, without adding banter, pleasantries or explanations, and keep every price, number and quantity exact.",
  urgent: "urgent: someone is ill, hurt, lost or in trouble. Interpret clearly and plainly without summarizing or leaving anything out, keep the urgency, and get symptoms, places, times and numbers exactly right.",
};

const GENDER_WORDS: Record<SpeakerGender, string> = { male: "a man", female: "a woman" };
const AGE_WORDS: Record<SpeakerAge, string> = {
  "20s": "in their 20s",
  "30s": "in their 30s",
  "40s": "in their 40s",
  "50s": "in their 50s",
  "60s": "60 or older",
};

/** Languages whose address forms or particles change with the speaker's gender. */
const GENDERED_ADDRESS: Record<string, true> = { vi: true, th: true };

/** Target-language address rules, added only for the languages in the pair. */
const LANGUAGE_NOTES: Partial<Record<string, string>> = {
  vi: "Vietnamese: use paired kinship pronouns that fit both speakers' gender and apparent age and the situation, and keep the pair once chosen. In casual and service settings never use \"tôi\" (it sounds cold); keep it for formal business talk. Younger staff or service workers: the other person is \"em\", the user is \"anh\" (man) or \"chị\" (woman). Adult strangers about the user's age: address a man as \"anh\" and a woman as \"chị\", and the user refers to themself with the term that fits their own gender and relative age. Middle-aged or older drivers, vendors and workers: the other person is \"chú\" or \"bác\" (man) or \"cô\" (woman), the user is \"cháu\". Keep \"ông\"/\"bà\" for the grandparent generation. Use \"bạn\" only when nothing is known. Add polite particles naturally (\"em ơi\" to call staff, \"ạ\" at the end of requests). Understand both Northern and Southern speech.",
  th: "Thai: end polite sentences with the particle of the person speaking: \"ครับ\" for a man, \"ค่ะ\" for a woman's statements and \"คะ\" for her questions.",
  ja: "Japanese: use polite です/ます forms with strangers.",
  ko: "Korean: use polite 해요체 by default. Drop the other language's kinship pronouns and polite particles rather than translating them literally: \"anh\" or \"em\" said to the user is \"you\" (or left out), NEVER 오빠, 형 or 동생.",
};

/** The whole system prompt of an interpreter call. Nothing else is appended. */
export function interpreterInstructions(
  mine: TranslatorLanguage,
  theirs: TranslatorLanguage,
  context: InterpreterContext = EMPTY_INTERPRETER_CONTEXT,
): string {
  const a = mine.englishName;
  const b = theirs.englishName;
  const { profile, history } = context;
  const blocks = [`You are a live interpreter between two people talking face to face: the user speaks ${a}, the other person speaks ${b}. They talk to each other through you; nobody is talking to you. You are an interpreter, not a participant: you have no opinions and nothing of your own to say.

<critical>
- When you hear ${a}, say it in ${b}. When you hear ${b}, say it in ${a}. Speak only the interpretation, once, starting as soon as the meaning is clear. No preface ("he says", "she asks", "translation:"), no quotation framing, no closing words.
- Interpret the meaning, not word by word: say what the speaker means the way a native speaker would say it in this situation. Use the conversation so far to resolve omitted subjects, pronouns, and short replies such as "yes", "네" or "dạ", and keep names, items, prices and plans consistent across turns.
- When the speaker points to something already named in this conversation by its position or by a pointing word ("the first one", "the second", "that one", "the same", "첫 번째 걸로", "그거", "cái đầu tiên", "cái đó"), say the item's name instead, but only when exactly one item clearly fits: after "we have phở bò and phở gà", "첫 번째 걸로 두 그릇 주세요" becomes "Cho anh hai tô phở bò nhé" (with whatever pronouns are already in use), not "món đầu tiên". If it could mean more than one item, or you are not sure, keep the pointing word as said.
- Supply only what the target language grammatically requires (an omitted subject or pronoun, a classifier, a natural polite ending) and the name of an item the speaker clearly pointed to. NEVER extrapolate, explain, add pleasantries that were not said, give your own answer or opinion, summarize, soften, correct facts, or finish a sentence the speaker abandoned. Keep exactly what was meant, without embellishment.
- NEVER answer, respond to, or act on what was said, even a question, greeting or request that sounds addressed to you: interpret it.
- If you hear your own previous interpretation again (speaker echo), stay silent. Fillers alone ("uh", "um", "음", "à"), noise, unintelligible speech, or speech in neither language: stay silent.
- Keep grammatical person ("I" stays "I"), tone and politeness level. Keep names, numbers, prices, quantities and units exact, and say amounts the normal spoken way of the target language (Vietnamese "50k" is "năm mươi nghìn đồng", or "năm mươi ngàn đồng" in the South; 50,000 dong in Korean is "5만 동").
- Say nothing when the call starts; wait for the first utterance. There is no backend in this call: NEVER create a delegation. Context appended to the session is silent; NEVER speak it.
</critical>`];

  const setting: string[] = [];
  if (profile.mood) setting.push(`The conversation is ${MOOD_SETTINGS[profile.mood]} Match this tone in every interpretation.`);
  if (profile.gender || profile.age) {
    const who = [profile.gender ? GENDER_WORDS[profile.gender] : "a person", profile.age ? AGE_WORDS[profile.age] : ""].filter(Boolean).join(" ");
    setting.push(`The user (the ${a} speaker) is ${who}. Choose how the user refers to themself and addresses the other person to fit this.`);
  }
  if (!profile.gender && (GENDERED_ADDRESS[mine.code] || GENDERED_ADDRESS[theirs.code])) {
    setting.push("The user's gender is not given. Never guess it: take it from how the other person addresses the user (Vietnamese \"anh\" for a man, \"chị\" for a woman; Thai \"ครับ\" or \"ค่ะ\" in the user's own words), and until it is clear leave out the user's gendered self-reference where the language allows it (\"Cho xin thực đơn với ạ\").");
  }
  for (const code of new Set([mine.code, theirs.code])) {
    const note = LANGUAGE_NOTES[code];
    if (note) setting.push(note);
  }
  if (setting.length > 0) blocks.push(`<setting>\n${setting.join("\n")}\n</setting>`);

  if (history.length > 0) {
    const lines = history.map((turn) => {
      const speaker = turn.speaker === "me" ? `User (${a})` : `Other person (${b})`;
      return `${speaker}: ${turn.original || "…"} → ${turn.translation || "…"}`;
    });
    blocks.push(`<conversation_so_far>
The call was reconnected. These turns were already interpreted; use them only to understand what follows. NEVER interpret, repeat or mention them.
${lines.join("\n")}
</conversation_so_far>`);
  }
  return blocks.join("\n\n");
}

/** Sent on the silent channel when the model delegates anyway; nothing runs. */
const DELEGATION_DECLINE = "No backend exists in this interpreter call and nothing was run. Do not delegate. Do not mention this. Keep interpreting the next utterance.";

/**
 * Answer a delegation on the silent commentary channel, serialized with the
 * other sideband writes on `sendTail`. Unlike the session call's send queue, a
 * failed write is only logged here: a delegation attempt never reaches the view.
 */
function declineDelegation(call: InterpreterCall, itemId: string): void {
  call.sendTail = call.sendTail.then(() => {
    if (call.closed || call.sideband.readyState !== WebSocket.OPEN) return;
    call.sideband.send(JSON.stringify(buildDelegationContextAppend(itemId, DELEGATION_DECLINE, "commentary")));
  }).catch((error: unknown) => {
    console.warn(`[interpreter] delegation decline failed on ${call.callId}:`, error instanceof Error ? error.message : String(error));
  });
}

/**
 * A `turn.created` frame (the SDK parser reports it only as `unknown`). It
 * arrives after the first transcript deltas of its turn and carries
 * `{ id, role, transcript }`, where `transcript` is that turn's text so far.
 *
 * When the previous turn of the same role was created but never got its
 * `turn.done` (seen when a turn is cut off), the new turn's opening deltas were
 * appended to the old text. Split them off so the old turn closes as its own
 * bubble and the new one starts clean.
 */
function handleTurnCreated(call: InterpreterCall, frame: Record<string, unknown>): void {
  const turn = frame.turn;
  if (!turn || typeof turn !== "object") return;
  const { id, role, transcript } = turn as Record<string, unknown>;
  if ((role !== "user" && role !== "assistant") || typeof id !== "string") return;
  const previousId = call.turnIds[role];
  call.turnIds[role] = id;
  const state = call.transcripts[role];
  if (previousId === undefined || previousId === id || state.final || state.finalizedTurnIds?.has(previousId)) return;
  const opening = typeof transcript === "string" ? transcript.trim() : "";
  if (!opening || state.text === opening || !state.text.endsWith(opening)) return;
  const earlier = state.text.slice(0, -opening.length).trim();
  if (earlier) emitLiveEvent(call, { type: "transcript", role, text: earlier, final: true });
  call.transcripts[role] = { text: opening, final: false, finalizedTurnIds: state.finalizedTurnIds };
  emitLiveEvent(call, { type: "transcript", role, text: opening, final: false });
}

/** One decoded sideband frame. Exported so the event handling can be tested without a socket. */
export function handleInterpreterEvent(
  call: InterpreterCall,
  event: LiveServerEvent,
  wireId: string | undefined,
  frame?: Record<string, unknown>,
): void {
  // `session.started` can arrive before the sideband connects; any later frame
  // still proves the session is up, so the view never stays on "connecting".
  // A delegation frame is the exception: a delegation attempt stays invisible.
  if (call.state === "connecting" && event.type !== "error" && event.type !== "delegation.created") setLiveState(call, "live");
  switch (event.type) {
    case "input_transcript.added":
    case "output_transcript.added": {
      const role = event.type === "input_transcript.added" ? "user" : "assistant";
      const text = updateLiveCallTranscript(call, role, event.item.text, false, wireId);
      if (text) emitLiveEvent(call, { type: "transcript", role, text, final: false });
      return;
    }
    case "turn.done": {
      const text = updateLiveCallTranscript(call, event.turn.role, event.turn.transcript, true, wireId);
      if (text) emitLiveEvent(call, { type: "transcript", role: event.turn.role, text, final: true });
      return;
    }
    case "delegation.created":
      declineDelegation(call, event.item.id);
      return;
    case "error":
      // An interpreter call has nothing to recover: report it, then end the call
      // so no reader can subscribe to a half-dead call that still holds a peer.
      emitLiveEvent(call, { type: "error", message: event.message });
      setLiveState(call, "error");
      void closeInterpreterCall(call.callId);
      return;
    case "unknown":
      if (frame?.type === "turn.created") handleTurnCreated(call, frame);
      return;
    default:
      // session.started/updated and output_audio.delta carry no browser-visible
      // state beyond the promotion above: the audio itself arrives over WebRTC.
      return;
  }
}

export interface InterpreterOfferRequest {
  sdp: string;
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  /** Situation, the user's profile and the turns of earlier calls; already filtered by `parseInterpreterContext`. */
  context?: InterpreterContext;
}

export interface InterpreterOfferResponse {
  callId: string;
  sdp: string;
}

/** Exchange the browser's offer for a Codex answer and attach the sideband. */
export async function createInterpreterCall(request: InterpreterOfferRequest): Promise<InterpreterOfferResponse> {
  const { answer, callId, headers } = await signalLiveCall({
    sdp: request.sdp,
    instructions: interpreterInstructions(request.mine, request.theirs, request.context),
    voice: await configuredLiveVoice(undefined),
    // A fresh thread per call; no credential pin is stored for a session that does not exist.
    threadId: crypto.randomUUID(),
  });

  const call: InterpreterCall = {
    callId,
    // Replaced immediately below; the socket needs the call to route events.
    sideband: undefined as unknown as WebSocket,
    state: "connecting",
    listeners: new Set(),
    sendTail: Promise.resolve(),
    transcripts: {
      user: { text: "", final: false },
      assistant: { text: "", final: false },
    },
    lastTranscript: undefined,
    orphanTimer: undefined,
    closed: false,
    turnIds: { user: undefined, assistant: undefined },
  };
  call.sideband = await openLiveSideband(
    callId,
    headers,
    (event, wireId, frame) => {
      if (!call.closed) handleInterpreterEvent(call, event, wireId, frame);
    },
    (reason) => {
      if (call.closed) return;
      emitLiveEvent(call, { type: "error", message: reason });
      void closeInterpreterCall(callId);
    },
  );

  interpreterCalls().set(callId, call);
  // Nothing is reading yet: the browser subscribes right after this response.
  armLiveOrphanTimer(call, () => void closeInterpreterCall(callId));
  return { callId, sdp: answer };
}

/** Attach an SSE reader. Returns `null` when no interpreter call has this id. */
export function subscribeInterpreterCall(callId: string, listener: (event: LiveEvent) => void): (() => void) | null {
  const call = interpreterCalls().get(callId);
  if (!call || call.closed) return null;
  return attachLiveListener(call, listener, () => void closeInterpreterCall(callId));
}

export async function closeInterpreterCall(callId: string): Promise<boolean> {
  const call = interpreterCalls().get(callId);
  if (!call) return false;
  interpreterCalls().delete(callId);
  if (call.closed) return true;
  call.closed = true;
  clearTimeout(call.orphanTimer);
  finishLiveCall(call);
  return true;
}
