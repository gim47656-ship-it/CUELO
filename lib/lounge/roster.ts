import { CHARACTER_ROSTER, type CharacterRosterEntry } from "@/lib/hanse-resource-client";

/**
 * 단톡방 멤버 명단. 정본은 `CHARACTER_ROSTER` 한 벌이고 여기서는 두 가지만 더한다.
 * - SHION(web6)은 상담 전용이라 단톡방 참여·자동 발언·멤버 선택에서 뺀다.
 * - 멤버 id는 alias의 영문 이름 소문자(`"RIN(린)"` → `"rin"`), 한국어 이름은 괄호 안 표기다.
 */
export interface LoungeMemberSpec {
  id: string;
  alias: string;
  koreanName: string;
  seed: number;
  provider: string;
  model: string;
  oauthPosition?: number;
}

function specFromRoster(entry: CharacterRosterEntry): LoungeMemberSpec {
  const match = /^([A-Za-z]+)\((.+)\)$/.exec(entry.alias);
  if (!match) throw new Error(`roster alias 형식이 올바르지 않습니다: ${entry.alias}`);
  return {
    id: match[1].toLowerCase(),
    alias: entry.alias,
    koreanName: match[2],
    seed: entry.seed,
    provider: entry.provider,
    model: entry.model,
    ...(entry.oauthPosition !== undefined ? { oauthPosition: entry.oauthPosition } : {}),
  };
}

/** 얼굴 자리(seed) 순서로 정렬한 멤버. 순번·표시 순서가 모두 이 순서를 따른다. */
export const LOUNGE_MEMBERS: readonly LoungeMemberSpec[] = CHARACTER_ROSTER
  .filter((entry) => entry.provider !== "web6")
  .map(specFromRoster)
  .sort((a, b) => a.seed - b.seed);

export function findLoungeMember(id: string): LoungeMemberSpec | undefined {
  return LOUNGE_MEMBERS.find((member) => member.id === id);
}
