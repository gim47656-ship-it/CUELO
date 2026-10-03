import { ACCOUNT_FACES, type AccountFace } from "@/lib/hanse-resource-client";
import type { AgentMessage, SubagentSnapshot, SubagentStatus } from "@/lib/types";

/**
 * 오피스 보기의 자리 배정.
 *
 * 자리는 번들 얼굴 목록(`ACCOUNT_FACES`) 그대로 일곱 개이고, 자리 번호가 곧 얼굴 seed 다. 누가
 * 어느 자리에 앉는지는 새로 정하지 않는다 — 대화 기록과 사용량 탭이 이미 쓰는 얼굴 배정
 * (`resolveAccountFace`: 기록된 credential → provider 예약 얼굴)을 그대로 거친 값만 자리로 간다.
 * 그 배정이 얼굴을 내주지 않는 참여자(계정이 여럿인 provider 에서 credential 을 아직 못 본
 * Maker, 얼굴이 없는 provider 등)는 비슷한 캐릭터에 끌어붙이지 않고 「이름 없는 참여자」로 둔다.
 *
 * 상태도 관측한 값만 쓴다. Main 은 대화창이 알려 준 실행 상태, Maker 는 런타임 스냅샷의 status
 * 그대로다. Maker 의 실행 완료는 Main 의 수용과 다르므로 여기서 둘을 합치지 않는다.
 */

export const OFFICE_MAIN_KEY = "main";

export function officeMakerKey(id: string): string {
  return `maker:${id}`;
}

/** 대화창이 알려 준 Main 상태. AppShell 상단 상태줄과 같은 우선순위로 고른 값이다. */
export type OfficeMainState = "attention" | "waiting" | "working" | "idle";

export interface OfficeMainInput {
  /** 대화창이 관측한 Main 모델. 관측 전이면 null. */
  provider: string | null;
  modelId: string | null;
  /** 대화창이 이 세션에 그린 얼굴. 특정하지 못했으면 null. */
  face: AccountFace | null;
  state: OfficeMainState;
}

/** Maker 기록에서 읽은 실제 계정 근거. 관측하지 못한 칸은 null 이다. */
export interface OfficeMakerAccount {
  provider: string | null;
  credentialId: number | null;
}

/** 얼굴 배정 규칙. 앱에서는 `resolveAccountFace(undefined, provider, credentialId)` 다. */
export type OfficeFaceResolver = (provider: string, credentialId: number | undefined) => AccountFace | null;

export interface OfficeMainParticipant {
  key: typeof OFFICE_MAIN_KEY;
  kind: "main";
  seat: number | null;
  provider: string | null;
  model: string | null;
  state: OfficeMainState;
}

export interface OfficeMakerParticipant {
  key: string;
  kind: "maker";
  seat: number | null;
  /** spawn 이름. 런타임이 따로 나르는 표시 이름은 없다. */
  name: string;
  agent: string | null;
  provider: string | null;
  model: string | null;
  status: SubagentStatus;
  retrying: boolean;
  snapshot: SubagentSnapshot;
}

export type OfficeParticipant = OfficeMainParticipant | OfficeMakerParticipant;

export interface OfficeSeat {
  seat: number;
  alias: string;
  participants: OfficeParticipant[];
}

export interface OfficeRoster {
  seats: OfficeSeat[];
  /** 캐릭터를 특정할 근거가 없는 참여자. */
  unnamed: OfficeParticipant[];
  /** 하단 참여자 줄의 순서: Main 먼저, 그 다음 Maker 를 런타임 순서대로. */
  participants: OfficeParticipant[];
}

function isCredentialId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function recordedProvider(snapshot: SubagentSnapshot): string | null {
  const recorded = typeof snapshot.progress?.resolvedModel === "string" ? snapshot.progress.resolvedModel.trim() : "";
  const slash = recorded.indexOf("/");
  return slash > 0 ? recorded.slice(0, slash) : null;
}

/**
 * Maker 가 실제로 쓴 계정. 기록의 마지막 assistant 메시지가 근거다 — 그 답을 만든 provider 와
 * credential 이 거기 박혀 있다. 메시지가 아직 없으면 런타임이 기록한 모델의 provider 만 쓰고
 * credential 은 비운다. 세션 provider 나 요청한 모델로 메우지 않는다: 그것은 관측이 아니다.
 */
export function observeMakerAccount(
  snapshot: SubagentSnapshot,
  messages: readonly AgentMessage[],
): OfficeMakerAccount {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const provider = typeof message.provider === "string" && message.provider.trim() ? message.provider.trim() : null;
    if (!provider) continue;
    return { provider, credentialId: isCredentialId(message.credentialId) ? message.credentialId : null };
  }
  return { provider: recordedProvider(snapshot), credentialId: null };
}

function seatOf(face: AccountFace | null): number | null {
  if (!face) return null;
  return Number.isInteger(face.seed) && face.seed >= 0 && face.seed < ACCOUNT_FACES.length ? face.seed : null;
}

export function buildOfficeRoster({
  main,
  subagents,
  accounts,
  resolveFace,
}: {
  main: OfficeMainInput;
  subagents: readonly SubagentSnapshot[];
  /** Maker id 별 관측 계정. 없는 Maker 는 스냅샷의 기록 모델만 본다. */
  accounts: ReadonlyMap<string, OfficeMakerAccount>;
  resolveFace: OfficeFaceResolver;
}): OfficeRoster {
  const mainParticipant: OfficeMainParticipant = {
    key: OFFICE_MAIN_KEY,
    kind: "main",
    seat: seatOf(main.face),
    provider: main.provider,
    model: main.provider && main.modelId ? `${main.provider}/${main.modelId}` : null,
    state: main.state,
  };

  const makers = [...subagents]
    .sort((a, b) => a.index - b.index)
    .map((snapshot): OfficeMakerParticipant => {
      const account = accounts.get(snapshot.id) ?? { provider: recordedProvider(snapshot), credentialId: null };
      const face = account.provider ? resolveFace(account.provider, account.credentialId ?? undefined) : null;
      const recordedModel = typeof snapshot.progress?.resolvedModel === "string" && snapshot.progress.resolvedModel.trim()
        ? snapshot.progress.resolvedModel.trim()
        : null;
      return {
        key: officeMakerKey(snapshot.id),
        kind: "maker",
        seat: seatOf(face),
        name: snapshot.id,
        agent: snapshot.agent.trim() || null,
        provider: account.provider,
        model: recordedModel,
        status: snapshot.status,
        retrying: Boolean(snapshot.progress?.retryState),
        snapshot,
      };
    });

  const participants: OfficeParticipant[] = [mainParticipant, ...makers];
  const seats: OfficeSeat[] = ACCOUNT_FACES.map((face, seat) => ({ seat, alias: face.alias, participants: [] }));
  const unnamed: OfficeParticipant[] = [];
  for (const participant of participants) {
    if (participant.seat === null) unnamed.push(participant);
    else seats[participant.seat].participants.push(participant);
  }
  return { seats, unnamed, participants };
}

/** 선택한 대상이 사라졌으면(세션 전환 등) Main 으로 돌아간다. 선택이 다른 대상을 가리키게 두지 않는다. */
export function resolveOfficeSelection(roster: OfficeRoster, selected: string): string {
  return roster.participants.some((participant) => participant.key === selected) ? selected : OFFICE_MAIN_KEY;
}

/**
 * 오피스 장면의 몸 하나. 한 캐릭터(자리)는 작업이 몇 개든 몸이 하나다 — Main 과 같은 캐릭터의 Maker,
 * 같은 계정의 Maker 여럿이 한 몸에 모인다. 캐릭터를 특정하지 못한 참여자는 어느 몸에도 합치지 않고
 * 저마다 몸 하나다. 작업(참여자) 하나하나의 키·선택·기록은 그대로 `members` 에 남는다.
 */
export interface OfficeBody {
  /** 장면 키. 자리 몸은 `body:<자리>` 라 대표 작업이 바뀌어도 같은 몸이 이어 움직인다. */
  key: string;
  seat: number | null;
  /** 몸의 자리와 동작을 정하는 대표 작업. */
  lead: OfficeParticipant;
  /** 이 몸이 맡은 작업 전부. 참여자 줄 순서다. */
  members: OfficeParticipant[];
}

const MAIN_ACTIVITY: Record<OfficeMainState, number> = { working: 0, waiting: 1, attention: 2, idle: 3 };

/**
 * 대표를 고르는 순서(작을수록 앞): 실제로 일하는 중(Main working, Maker running·재시도 아님) →
 * 기다리는 중(waiting, pending, 재시도 대기) → 사람을 부르거나 실패(attention, failed) → 쉬거나
 * 끝남(idle, 완료·중단). 같은 순위면 참여자 줄 순서가 앞선 쪽이다.
 */
function activityRank(participant: OfficeParticipant): number {
  if (participant.kind === "main") return MAIN_ACTIVITY[participant.state];
  if (participant.status === "running") return participant.retrying ? 1 : 0;
  if (participant.status === "pending") return 1;
  return participant.status === "failed" ? 2 : 3;
}

export function officeBodies(roster: OfficeRoster): OfficeBody[] {
  const bodies: OfficeBody[] = [];
  const bySeat = new Map<number, OfficeBody>();
  for (const participant of roster.participants) {
    const { seat } = participant;
    const body = seat === null ? undefined : bySeat.get(seat);
    if (body) {
      body.members.push(participant);
      if (activityRank(participant) < activityRank(body.lead)) body.lead = participant;
      continue;
    }
    const created: OfficeBody = { key: seat === null ? participant.key : `body:${seat}`, seat, lead: participant, members: [participant] };
    if (seat !== null) bySeat.set(seat, created);
    bodies.push(created);
  }
  return bodies;
}
