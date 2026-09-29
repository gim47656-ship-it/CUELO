/**
 * 단톡방(lounge) 공유 계약의 정본. backend(`lib/lounge/**`, `app/api/lounge/**`)가 소유하고
 * frontend(`components/lounge/**`, `hooks/useLounge.ts`)는 이 타입만 import한다.
 *
 * 방은 하나(`roomId: "main"`)다. 멤버 `id`는 roster alias의 영문 이름을 소문자로 바꾼 안정
 * 식별자다(`"RIN(린)"` → `"rin"`). SHION(web6)은 단톡방 멤버가 아니다.
 *
 * GET `/api/lounge`        → {@link LoungeSnapshot}. 호출을 시작하지 않는다.
 * POST `/api/lounge`       → {@link LoungeAction} → {@link LoungePostResponse} 또는 `{ error }` + 4xx.
 * GET `/api/lounge/events` → SSE named events: `snapshot`(연결·재연결 복원), `delta`, `message`,
 *                            `state`. 연결 자체로는 호출을 시작하지 않는다.
 */

export const LOUNGE_ROOM_ID = "main" as const;
export type LoungeRoomId = typeof LOUNGE_ROOM_ID;

export type LoungePace = "slow" | "normal" | "active";

/**
 * - `off`: 방이 꺼졌거나 이 멤버가 참여하지 않는다.
 * - `idle`: 참여 중이고 대기한다.
 * - `reading`: 이번 차례 발언 대기열에 있다(앞 멤버가 말하는 중).
 * - `speaking`: 지금 provider 호출로 말하고 있다.
 * - `working`: 같은 provider/model(계정 자리까지)이 실제 작업 세션에서 실행 중이다. 자동 수다의
 *   신규 호출을 보류한다(멘션·답장·전원 요청은 그대로 받는다).
 * - `offline`: provider 미인증·모델 미해결·계정 자리 없음·한도 차단 등으로 호출할 수 없다.
 *   다른 계정·모델로 대체하지 않는다. `reason`이 짧은 사유다.
 */
export type LoungeMemberState = "off" | "idle" | "reading" | "speaking" | "working" | "offline";

export interface LoungeWeeklyUsage {
  /** 0..1(1 이상은 초과). */
  usedFraction: number;
  resetsAt?: number;
}

export interface LoungeAccountChoice {
  credentialId: number;
  position: number;
  /** 이메일·토큰 없이 위치와 durable ID로만 구분한다. */
  label: string;
}

export interface LoungeMemberAccount {
  credentialId?: number;
  choices: LoungeAccountChoice[];
  selectionRequired: boolean;
}

export interface LoungeMember {
  /** roster alias 영문 소문자(`rin`, `mio`, `nova`, `yuki`, `isana`, `hikari`). */
  id: string;
  alias: string;
  /** `AccountAvatar`용 얼굴 자리. */
  seed: number;
  provider: string;
  model: string;
  /** 방 참여 토글(= `room.participants`에 포함). */
  enabled: boolean;
  /** 지금 호출 가능한지. false면 `reason`이 있다. */
  available: boolean;
  state: LoungeMemberState;
  reason?: string;
  /** 백엔드가 확실히 아는 경우에만 싣는다. 없으면 프론트가 기존 사용량 스냅샷으로 매칭한다. */
  weeklyUsage?: LoungeWeeklyUsage;
  account?: LoungeMemberAccount;
}

export interface LoungeReaction {
  emoji: string;
  /** 반응한 주체: `"user"` 또는 멤버 id. */
  by: string[];
}

export interface LoungeMessage {
  id: string;
  memberId: "user" | string;
  text: string;
  /** epoch ms */
  createdAt: number;
  replyToId?: string;
  reactions: LoungeReaction[];
}

export interface LoungeRoomSettings {
  enabled: boolean;
  /** 명시 opt-in일 때만 idle 자발 발언을 한다. */
  autoTalk: boolean;
  /** 참여 멤버 id. 알 수 없는 id·SHION은 저장하지 않는다. */
  participants: string[];
  pace: LoungePace;
  /** 사용자 활동이 없을 때 자동 발언을 멈추고 잠드는 시간(분). */
  sleepAfterMinutes: number;
}

export interface LoungeRoom extends LoungeRoomSettings {
  id: LoungeRoomId;
  /** 사용자 활동이 `sleepAfterMinutes` 동안 없어서 자동 발언이 멈춘 상태. */
  asleep: boolean;
  /** 자동으로 잠들 예정 시각(epoch ms). 켜져 있지 않거나 이미 잠들었으면 null. */
  sleepAt: number | null;
  /** 작업 실행 등으로 자동 발언만 잠시 보류하는 사유. */
  autoTalkPausedReason?: string;
}

export interface LoungeCallBudget {
  /** 최근 `windowMs` 안에 시작한 provider 호출 수. */
  used: number;
  limit: number;
  windowMs: number;
}

export interface LoungeRun {
  /** provider 호출 차례가 진행 중인지(방 단일 flight). */
  active: boolean;
  /** stop·OFF마다 올라간다. 늦은 결과는 이 값이 달라 버려진다. */
  generation: number;
  /** 지금 말하는 멤버. */
  currentMemberId: string | null;
  /** 이번 차례에 아직 말하지 않은 대기 멤버(순서대로). */
  queuedMemberIds: string[];
  startedAt: number | null;
  calls: LoungeCallBudget;
  /** 차례 하나(사용자 메시지 1건 또는 자동 발언 1건)당 최대 호출 수. */
  perTurnLimit: number;
}

export type LoungeAction =
  | ({ action: "settings"; requestId: string; roomId: LoungeRoomId; accountBindings?: Record<string, number> } & Partial<LoungeRoomSettings>)
  | { action: "send"; requestId: string; roomId: LoungeRoomId; text: string; replyToId?: string }
  | { action: "stop"; requestId: string; roomId: LoungeRoomId }
  | { action: "reaction"; requestId: string; roomId: LoungeRoomId; messageId: string; emoji: string };

export interface LoungePostResponse {
  /** 같은 `requestId`를 다시 보냈으면 true(다시 저장·호출하지 않는다). */
  duplicate: boolean;
  /** `send`가 provider 차례를 시작했는지. */
  accepted: boolean;
  snapshot: LoungeSnapshot;
}

export interface LoungeSnapshot {
  /**
   * 방 상태·멤버·run·메시지·반응 어느 것이든 바뀔 때마다 오르는 단조 증가 값. 프로세스 시작
   * 시각(epoch ms)에서 출발하므로 재시작해도 줄지 않는다. 이보다 작은 snapshot/state는 버린다.
   */
  revision: number;
  room: LoungeRoom;
  members: LoungeMember[];
  messages: LoungeMessage[];
  run: LoungeRun;
  /**
   * 기록 파일을 읽지 못했을 때의 사유. 이때 방은 꺼진 것으로 보이고 POST는 503이다. 원본
   * 파일은 덮어쓰지 않고 그대로 둔다(사용자가 직접 확인·복구).
   */
  loadError?: string;
}

/** SSE `delta`: 말하는 중인 메시지의 **누적** 본문(재연결에도 그대로 덮어쓰면 된다). */
export interface LoungeDeltaEvent {
  revision: number;
  /** 이 발언이 속한 run generation. 현재 `run.generation`과 다르면 버린다. */
  generation: number;
  messageId: string;
  memberId: string;
  text: string;
}

/** SSE `message`: 새 메시지 또는 반응이 바뀐 메시지(같은 id는 교체). */
export interface LoungeMessageEvent {
  revision: number;
  message: LoungeMessage;
}

export interface LoungeStateEvent {
  revision: number;
  members: LoungeMember[];
  room: LoungeRoom;
  run: LoungeRun;
  loadError?: string;
}

export type LoungeServerEvent =
  | { event: "snapshot"; data: LoungeSnapshot }
  | { event: "delta"; data: LoungeDeltaEvent }
  | { event: "message"; data: LoungeMessageEvent }
  | { event: "state"; data: LoungeStateEvent };

export const LOUNGE_TEXT_MAX = 2000;
export const LOUNGE_EMOJI_MAX = 16;
export const LOUNGE_SLEEP_MINUTES_MIN = 1;
export const LOUNGE_SLEEP_MINUTES_MAX = 120;
