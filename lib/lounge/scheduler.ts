import { LOUNGE_MEMBERS, type LoungeMemberSpec } from "./roster";
import type { LoungeMessage, LoungePace } from "./types";

/**
 * 누가 말할지는 매번 전원에게 LLM으로 묻지 않고 본문·답장 대상·최근 발언 순서만으로 정한다.
 * 같은 입력이면 항상 같은 순서가 나온다.
 */

/** 사용자 메시지 한 건(또는 자동 발언 한 건)에 대한 최대 호출 수: 응답 최대 6명 + 후속 발언을 합쳐 6회. */
export const PER_TURN_LIMIT = 6;
/** '전원' 요청은 참여자 순서대로 한 번씩, 이 수를 넘지 않는다. */
export const EVERYONE_LIMIT = 6;

const RESPONDERS_BY_PACE: Record<LoungePace, number> = { slow: 1, normal: 2, active: 3 };

/** 자동 발언 사이 최소 간격. 잠들기(기본 10분) 전까지만 동작한다. */
export const AUTO_TALK_INTERVAL_MS: Record<LoungePace, number> = {
  slow: 6 * 60_000,
  normal: 3 * 60_000,
  active: 90_000,
};

/** 자동 발언 한 번에 멤버끼리 주고받는 최대 발언 수. */
export const AUTO_TALK_TURNS: Record<LoungePace, number> = { slow: 2, normal: 4, active: 6 };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const BOUNDARY_BEFORE = String.raw`(?:^|[\s,.!?~()\[\]"'「」『』:;])`;
/** 이름 뒤에 올 수 있는 것: 끝·구두점·공백, 또는 호격/조사. */
const KOREAN_AFTER = String.raw`(?=$|[\s,.!?~()\[\]"'「」『』:;]|아|야|이|님|씨|은|는|가|도|한테|에게|랑|의|를|을|께)`;
const LATIN_AFTER = String.raw`(?![A-Za-z0-9])`;

function mentionPatterns(member: LoungeMemberSpec): RegExp[] {
  const latin = escapeRegExp(member.id);
  const korean = escapeRegExp(member.koreanName);
  return [
    new RegExp(`@(?:${latin}${LATIN_AFTER}|${korean})`, "giu"),
    new RegExp(`${BOUNDARY_BEFORE}${latin}${LATIN_AFTER}`, "giu"),
    new RegExp(`${BOUNDARY_BEFORE}${korean}${KOREAN_AFTER}`, "gu"),
  ];
}

/** 본문에서 부른 멤버 id를 처음 등장한 순서대로 돌려준다. */
export function detectMentions(text: string, members: readonly LoungeMemberSpec[]): string[] {
  const found: Array<{ id: string; index: number }> = [];
  for (const member of members) {
    let first = Number.POSITIVE_INFINITY;
    for (const pattern of mentionPatterns(member)) {
      const match = pattern.exec(text);
      if (match) first = Math.min(first, match.index);
    }
    if (Number.isFinite(first)) found.push({ id: member.id, index: first });
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.id);
}

const EVERYONE_MENTION = /@(?:all|everyone|전원|모두|다들)(?=$|[\s,.!?~()[\]"'「」『』:;])/iu;
// 전체 지칭만으로 호출 수를 늘리지 않는다. 대상 바로 뒤의 짧은 발언 요청만 인정한다.
const EVERYONE_REQUEST = new RegExp(
  String.raw`${BOUNDARY_BEFORE}(?:전원|모두|다들|여러분)[,\s]+(?:(?:각자|한\s*번씩|한마디|의견(?:을)?|생각(?:을)?|답변(?:을)?|인사(?:를)?)\s+){0,3}(?:말|답|대답|인사|이야기|얘기)?(?:해줘|해봐|해주세요)(?=$|[\s,.!?~])`,
  "u",
);

export function isEveryoneRequest(text: string): boolean {
  return EVERYONE_MENTION.test(text) || EVERYONE_REQUEST.test(text);
}

/** 가장 오래 말하지 않은 멤버부터(한 번도 안 말했으면 맨 앞), 같으면 명단 순서. */
export function byLeastRecent(
  candidates: readonly LoungeMemberSpec[],
  lastSpokeAt: ReadonlyMap<string, number>,
): LoungeMemberSpec[] {
  return candidates
    .map((member, order) => ({ member, order, at: lastSpokeAt.get(member.id) ?? -1 }))
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .map((entry) => entry.member);
}

export function lastSpokeAtByMember(messages: readonly LoungeMessage[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const message of messages) {
    if (message.memberId !== "user") result.set(message.memberId, message.createdAt);
  }
  return result;
}

export interface ReplyPlan {
  memberIds: string[];
  everyone: boolean;
  /** 답글 속 멘션으로 한 명이 이어 말할 수 있는지. */
  allowFollowUp: boolean;
  perTurnLimit: number;
}

/**
 * 사용자 메시지 한 건에 누가 답할지. `candidates`는 지금 호출할 수 있는 참여 멤버(명단 순서).
 * 우선순위: 전원 요청 → 멘션 → 답장 대상 멤버 → 최근에 덜 말한 멤버 1~2명.
 */
export function planReply(input: {
  text: string;
  replyToMemberId?: string;
  candidates: readonly LoungeMemberSpec[];
  messages: readonly LoungeMessage[];
  pace: LoungePace;
}): ReplyPlan {
  const { text, replyToMemberId, candidates, messages, pace } = input;
  const candidateIds = new Set(candidates.map((member) => member.id));
  if (isEveryoneRequest(text)) {
    const memberIds = candidates.slice(0, EVERYONE_LIMIT).map((member) => member.id);
    return { memberIds, everyone: true, allowFollowUp: false, perTurnLimit: memberIds.length };
  }
  // 명시한 멤버가 offline/미참여면 다른 멤버로 조용히 대체하지 않는다.
  const mentioned = detectMentions(text, LOUNGE_MEMBERS);
  if (mentioned.length > 0) {
    const memberIds = mentioned.filter((id) => candidateIds.has(id)).slice(0, PER_TURN_LIMIT);
    return { memberIds, everyone: false, allowFollowUp: true, perTurnLimit: PER_TURN_LIMIT };
  }
  if (replyToMemberId) {
    return { memberIds: candidateIds.has(replyToMemberId) ? [replyToMemberId] : [], everyone: false, allowFollowUp: true, perTurnLimit: PER_TURN_LIMIT };
  }
  const memberIds = byLeastRecent(candidates, lastSpokeAtByMember(messages))
    .slice(0, RESPONDERS_BY_PACE[pace])
    .map((member) => member.id);
  return { memberIds, everyone: false, allowFollowUp: true, perTurnLimit: PER_TURN_LIMIT };
}

/**
 * 방금 말한 멤버 다음에 이어 말할 멤버. 본문에서 부른 다른 멤버가 먼저다(이번 차례에 이미 말했어도
 * 되받아 말할 수 있다). 부른 멤버가 없고 대기열도 비었으면 말한 멤버를 뺀 참여자 중 가장 오래
 * 말하지 않은 멤버가 잇는다. `candidates`는 지금 부를 수 있고 아직 대기열에 없는 멤버다.
 */
export function pickNextSpeaker(input: {
  replyText: string;
  speakerId: string;
  candidates: readonly LoungeMemberSpec[];
  messages: readonly LoungeMessage[];
  queueEmpty: boolean;
}): string | undefined {
  const others = input.candidates.filter((member) => member.id !== input.speakerId);
  const mentioned = detectMentions(input.replyText, others)[0];
  if (mentioned) return mentioned;
  if (!input.queueEmpty) return undefined;
  return byLeastRecent(others, lastSpokeAtByMember(input.messages))[0]?.id;
}

const TRANSCRIPT_LIMIT = 30;
const QUOTE_LIMIT = 60;

function speakerName(memberId: string): string {
  if (memberId === "user") return "사용자";
  return LOUNGE_MEMBERS.find((member) => member.id === memberId)?.alias ?? memberId;
}

/**
 * provider에 보내는 입력은 이름과 방 대화뿐이다. 성격 프롬프트·작업 문맥·기억·도구·프로젝트
 * 지시는 넣지 않는다.
 */
export function buildLoungePrompt(input: {
  member: LoungeMemberSpec;
  participants: readonly LoungeMemberSpec[];
  messages: readonly LoungeMessage[];
  mode: "reply" | "auto";
  lastSpeaker: boolean;
}): { systemPrompt: string; userText: string } {
  const { member, participants, messages, mode, lastSpeaker } = input;
  const others = participants.filter((entry) => entry.id !== member.id).map((entry) => entry.alias);
  const systemPrompt = [
    `너는 단톡방 참여자 ${member.alias}다.`,
    `이 방에는 사용자${others.length > 0 ? `와 ${others.join(", ")}` : ""}가 있다.`,
    "화자 표시나 이름 접두 없이 네가 할 말만 쓴다. 짧게 1~3문장.",
    "사용자 말만 기다리지 않는다. 바로 앞 발언이 다른 참여자면 그 말에 맞장구·반박·되묻기로 이어 가고, 다른 참여자에게 말을 걸어도 된다.",
    "기본은 한국어다. 분위기에 맞는 짧은 감탄·한마디만 가끔 일본어로 표현해도 되지만, 문장마다 섞거나 긴 답변 전체를 일본어로 쓰지 않는다. 사용자가 일본어로 말하거나 대화 자체가 일본어로 이어질 때만 그 흐름을 따른다. 억지로 일본어를 넣을 필요는 없다.",
    "앞 발언에 아직 뜻이 풀리지 않은 일본어가 있으면 네 말 속에서 한국어 뜻을 짧게 풀어 준다.",
    lastSpeaker
      ? "이번에는 네 뒤에 이어 말할 참여자가 없으니, 네가 일본어 한마디를 쓰면 짧은 한국어 뜻을 곁들인다."
      : "네 뒤에 다른 참여자가 이어 말한다.",
    "상태·오류·승인·중단 설명은 한국어로 명확히 한다.",
    "다른 참여자를 부를 때는 @이름을 쓴다. 이 방에서는 도구·파일·작업을 실행할 수 없다.",
  ].join("\n");
  const byId = new Map(messages.map((message) => [message.id, message]));
  const lines = messages.slice(-TRANSCRIPT_LIMIT).map((message) => {
    const target = message.replyToId ? byId.get(message.replyToId) : undefined;
    const reply = target
      ? ` (↳ ${speakerName(target.memberId)}: "${target.text.slice(0, QUOTE_LIMIT)}")`
      : "";
    return `[${speakerName(message.memberId)}]${reply} ${message.text}`;
  });
  const instruction = mode === "auto"
    ? `대화가 잠시 조용하다. ${member.alias}로서 자연스럽게 한마디 해라.`
    : `위 대화에 ${member.alias}로서 이어서 한 번 말해라.`;
  const userText = lines.length > 0
    ? `단톡방 최근 대화:\n${lines.join("\n")}\n\n${instruction}`
    : instruction;
  return { systemPrompt, userText };
}
