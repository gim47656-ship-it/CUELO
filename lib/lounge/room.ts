import { randomUUID } from "node:crypto";
import { LOUNGE_MEMBERS, type LoungeMemberSpec } from "./roster";
import {
  AUTO_TALK_INTERVAL_MS,
  buildLoungePrompt,
  byLeastRecent,
  lastSpokeAtByMember,
  PER_TURN_LIMIT,
  pickFollowUp,
  planReply,
} from "./scheduler";
import { isFiniteNumber, isRecord, LOUNGE_PACES, LoungeLoadError, type LoungeRecord, type LoungeStore } from "./store";
import {
  LOUNGE_EMOJI_MAX,
  LOUNGE_ROOM_ID,
  LOUNGE_SLEEP_MINUTES_MAX,
  LOUNGE_SLEEP_MINUTES_MIN,
  LOUNGE_TEXT_MAX,
  type LoungeAction,
  type LoungeMember,
  type LoungeMemberAccount,
  type LoungeMessage,
  type LoungePace,
  type LoungePostResponse,
  type LoungeRoom,
  type LoungeRoomSettings,
  type LoungeRun,
  type LoungeServerEvent,
  type LoungeSnapshot,
} from "./types";

/** 시간당 provider 호출 상한. 호출 시각은 기록 파일에 남아 재시작해도 이어서 센다. */
export const HOURLY_CALL_LIMIT = 20;
export const CALL_WINDOW_MS = 60 * 60_000;
/** 호출이 실패한 멤버를 다시 부르지 않는 시간. 그 동안 `offline`과 사유로 보인다. */
export const FAILURE_COOLDOWN_MS = 5 * 60_000;

export type LoungeAvailability = { ok: true } | { ok: false; reason: string };

export interface LoungeInvokeRequest {
  member: LoungeMemberSpec;
  credentialId?: number;
  systemPrompt: string;
  userText: string;
  signal: AbortSignal;
  /** 누적 본문. */
  onText: (text: string) => void;
}

/** provider 경계. 실제 구현은 `provider.ts`, 테스트는 transport를 대신하는 가짜를 넣는다. */
export interface LoungeInvoker {
  /** 네트워크 없이 판단할 수 있는 호출 가능 여부(인증·모델·계정 자리). */
  availability(member: LoungeMemberSpec, credentialId?: number): LoungeAvailability;
  account?(member: LoungeMemberSpec, credentialId?: number): LoungeMemberAccount | undefined;
  defaultAccount?(member: LoungeMemberSpec): number | undefined;
  refreshAccounts?(): Promise<void>;
  /** 최종 본문을 돌려준다. 멤버를 쓸 수 없으면 {@link LoungeUnavailableError}. */
  invoke(request: LoungeInvokeRequest): Promise<string>;
}

/** 이 멤버를 지금 호출할 수 없다(대체하지 않고 offline으로 보인다). */
export class LoungeUnavailableError extends Error {
  override name = "LoungeUnavailableError";
  constructor(message: string, readonly until?: number) {
    super(message);
  }
}

export interface LoungeTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface LoungeRoomDeps {
  store: LoungeStore;
  invoker: LoungeInvoker;
  /** 실제 작업 세션에서 실행 중인 provider/model/계정과 일치하는 멤버 id. */
  workingMemberIds: (bindings: Readonly<Record<string, number>>) => ReadonlySet<string>;
  autoTalkBlockReason?: () => string | undefined;
  now?: () => number;
  timers?: LoungeTimers;
  newId?: () => string;
}

export interface LoungeDispatchResult {
  status: number;
  body: LoungePostResponse | { error: string };
}

interface ActiveRun {
  generation: number;
  controller: AbortController;
  kind: "reply" | "auto";
  queue: string[];
  spoken: Set<string>;
  calls: number;
  perTurnLimit: number;
  allowFollowUp: boolean;
  followUpUsed: boolean;
  startedAt: number;
  currentMemberId: string | null;
}

interface Streaming {
  generation: number;
  messageId: string;
  memberId: string;
  text: string;
}

const defaultTimers: LoungeTimers = {
  set(callback, delayMs) {
    const handle: NodeJS.Timeout = setTimeout(callback, delayMs);
    // 방 타이머가 서버 종료를 붙잡지 않게 한다.
    handle.unref();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ParsedAction =
  | { ok: true; action: LoungeAction }
  | { ok: false; error: string };

/** POST 본문 경계 파서. 형식이 틀리면 아무것도 바꾸지 않고 400이다. */
export function parseLoungeAction(body: unknown): ParsedAction {
  if (!isRecord(body)) return { ok: false, error: "본문은 JSON object여야 합니다." };
  const { action, requestId, roomId } = body;
  if (typeof requestId !== "string" || requestId.trim() === "" || requestId.length > 200) {
    return { ok: false, error: "requestId가 필요합니다." };
  }
  if (roomId !== LOUNGE_ROOM_ID) return { ok: false, error: `roomId는 "${LOUNGE_ROOM_ID}"여야 합니다.` };
  switch (action) {
    case "send": {
      if (typeof body.text !== "string") return { ok: false, error: "text가 필요합니다." };
      const text = body.text.trim();
      if (text === "") return { ok: false, error: "빈 메시지는 보낼 수 없습니다." };
      if (text.length > LOUNGE_TEXT_MAX) return { ok: false, error: `메시지는 ${LOUNGE_TEXT_MAX}자까지입니다.` };
      if (body.replyToId !== undefined && typeof body.replyToId !== "string") {
        return { ok: false, error: "replyToId 형식이 올바르지 않습니다." };
      }
      return { ok: true, action: { action, requestId, roomId, text, ...(body.replyToId ? { replyToId: body.replyToId } : {}) } };
    }
    case "stop":
      return { ok: true, action: { action, requestId, roomId } };
    case "reaction": {
      if (typeof body.messageId !== "string" || body.messageId === "") return { ok: false, error: "messageId가 필요합니다." };
      if (typeof body.emoji !== "string") return { ok: false, error: "emoji가 필요합니다." };
      const emoji = body.emoji.trim();
      if (emoji === "" || emoji.length > LOUNGE_EMOJI_MAX) return { ok: false, error: "emoji 형식이 올바르지 않습니다." };
      return { ok: true, action: { action, requestId, roomId, messageId: body.messageId, emoji } };
    }
    case "settings": {
      const patch: Partial<LoungeRoomSettings> = {};
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled는 boolean이어야 합니다." };
        patch.enabled = body.enabled;
      }
      if (body.autoTalk !== undefined) {
        if (typeof body.autoTalk !== "boolean") return { ok: false, error: "autoTalk은 boolean이어야 합니다." };
        patch.autoTalk = body.autoTalk;
      }
      if (body.participants !== undefined) {
        if (!Array.isArray(body.participants) || !body.participants.every((id) => typeof id === "string")) {
          return { ok: false, error: "participants는 문자열 배열이어야 합니다." };
        }
        // 알 수 없는 id·SHION은 저장하지 않는다. 순서는 명단 순서로 고정한다.
        const requested = new Set(body.participants as string[]);
        patch.participants = LOUNGE_MEMBERS.filter((member) => requested.has(member.id)).map((member) => member.id);
      }
      if (body.pace !== undefined) {
        if (typeof body.pace !== "string" || LOUNGE_PACES[body.pace as LoungePace] !== true) {
          return { ok: false, error: "pace는 slow|normal|active 중 하나여야 합니다." };
        }
        patch.pace = body.pace as LoungePace;
      }
      if (body.sleepAfterMinutes !== undefined) {
        if (!isFiniteNumber(body.sleepAfterMinutes)
          || !Number.isInteger(body.sleepAfterMinutes)
          || body.sleepAfterMinutes < LOUNGE_SLEEP_MINUTES_MIN
          || body.sleepAfterMinutes > LOUNGE_SLEEP_MINUTES_MAX) {
          return {
            ok: false,
            error: `sleepAfterMinutes는 ${LOUNGE_SLEEP_MINUTES_MIN}~${LOUNGE_SLEEP_MINUTES_MAX} 정수여야 합니다.`,
          };
        }
        patch.sleepAfterMinutes = body.sleepAfterMinutes;
      }
      let accountBindings: Record<string, number> | undefined;
      if (body.accountBindings !== undefined) {
        if (!isRecord(body.accountBindings) || !Object.entries(body.accountBindings).every(([id, value]) =>
          LOUNGE_MEMBERS.some((member) => member.id === id)
          && typeof value === "number" && Number.isSafeInteger(value) && value > 0)) {
          return { ok: false, error: "accountBindings에 유효한 멤버와 계정 ID가 필요합니다." };
        }
        accountBindings = body.accountBindings as Record<string, number>;
      }
      return { ok: true, action: { action, requestId, roomId, ...patch, ...(accountBindings ? { accountBindings } : {}) } };
    }
    default:
      return { ok: false, error: "action은 settings|send|stop|reaction 중 하나여야 합니다." };
  }
}

/**
 * 방 하나의 상태 기계. 규칙:
 * - provider 호출은 방 전체에서 한 번에 하나(single flight)이고 run마다 generation을 잡는다.
 *   stop·OFF·말하던 멤버 제외는 abort와 함께 generation을 올리며, 이전 generation의 늦은 결과는
 *   저장·표시하지 않는다. 그 뒤에는 사용자가 다시 말하기 전까지 새 호출이 없다.
 * - 조회(GET/SSE)는 상태를 읽기만 한다. 호출은 `send`와 opt-in 자동 발언에서만 시작한다.
 * - 프로세스가 새로 뜨면 run은 없고, 사용자가 다시 말하기 전까지 자동 발언도 없다.
 * - requestId는 기록 파일에 저장과 함께 남아 재시작 뒤 재전송도 다시 저장·호출하지 않는다.
 */
export class LoungeRoomEngine {
  readonly #deps: Required<Omit<LoungeRoomDeps, "timers" | "newId" | "now">> & {
    timers: LoungeTimers;
    newId: () => string;
    now: () => number;
  };
  #record: LoungeRecord | null = null;
  #loadError: string | undefined;
  #snapshotStateKey = "";
  #revision: number;
  #generation = 0;
  #run: ActiveRun | null = null;
  #streaming: Streaming | null = null;
  #listeners = new Set<(event: LoungeServerEvent) => void>();
  /** 이 프로세스에서 사용자가 말한 뒤에만 자동 발언이 가능하다. */
  #resumedByUser = false;
  #autoTimer: unknown;
  #lastAutoAttemptAt = 0;
  #failures = new Map<string, { reason: string; until: number }>();

  constructor(deps: LoungeRoomDeps) {
    this.#deps = {
      store: deps.store,
      invoker: deps.invoker,
      workingMemberIds: deps.workingMemberIds,
      autoTalkBlockReason: deps.autoTalkBlockReason ?? (() => undefined),
      now: deps.now ?? Date.now,
      timers: deps.timers ?? defaultTimers,
      newId: deps.newId ?? randomUUID,
    };
    this.#revision = this.#deps.now() * 1000;
    try {
      this.#record = this.#deps.store.load();
    } catch (error) {
      // 손상된 기록은 덮어쓰지 않는다. 방은 꺼진 것으로 보이고 모든 변경은 503이다.
      this.#loadError = error instanceof LoungeLoadError
        ? `${error.message} (${this.#deps.store.path})`
        : `기록을 읽지 못했습니다: ${errorText(error)} (${this.#deps.store.path})`;
    }
  }

  async refreshAccounts(): Promise<void> {
    await this.#deps.invoker.refreshAccounts?.();
  }

  get generation(): number {
    return this.#generation;
  }

  subscribe(listener: (event: LoungeServerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 재연결 복원용: 진행 중 발언의 누적 본문. */
  currentDelta(): LoungeServerEvent | null {
    const streaming = this.#streaming;
    if (!streaming || !this.#run || streaming.generation !== this.#generation) return null;
    return {
      event: "delta",
      data: { revision: this.#revision, generation: streaming.generation, messageId: streaming.messageId, memberId: streaming.memberId, text: streaming.text },
    };
  }

  snapshot(): LoungeSnapshot {
    const record = this.#record;
    const messages = record ? record.messages.slice() : [];
    const room = this.#roomView();
    const members = this.#memberViews();
    const run = this.#runView();
    // 작업 종료·자동 잠들기·쿨다운 해제처럼 외부/시간에 따라 바뀐 표시도 버전을 올린다.
    const key = JSON.stringify({ room, members, run });
    if (key !== this.#snapshotStateKey) {
      this.#snapshotStateKey = key;
      this.#bump();
    }
    return {
      revision: this.#revision,
      room, members, messages, run,
      ...(this.#loadError ? { loadError: this.#loadError } : {}),
    };
  }

  /**
   * POST 처리. 상태 변경과 기록 저장은 동기로 끝나므로 같은 requestId가 겹쳐 와도 두 번째는
   * 저장된 id를 보고 중복으로 끝난다. 저장이 실패하면 메모리 상태도 바꾸지 않는다.
   */
  dispatch(action: LoungeAction): LoungeDispatchResult {
    const record = this.#record;
    if (!record) {
      return { status: 503, body: { error: this.#loadError ?? "단톡방 기록을 사용할 수 없습니다." } };
    }
    if (record.requests.some((entry) => entry.id === action.requestId)) {
      return { status: 200, body: { duplicate: true, accepted: false, snapshot: this.snapshot() } };
    }
    switch (action.action) {
      case "settings":
        return this.#applySettings(record, action);
      case "send":
        return this.#send(record, action);
      case "stop":
        return this.#stop(record, action.requestId);
      case "reaction":
        return this.#react(record, action);
    }
  }

  /** 테스트·종료용: 진행 중 호출을 끊고 타이머를 치운다. */
  dispose(): void {
    this.#abortRun();
    this.#clearAutoTimer();
    this.#listeners.clear();
  }

  // ── 변경 ────────────────────────────────────────────────────────────────

  #commit(next: LoungeRecord): { ok: true } | { ok: false; result: LoungeDispatchResult } {
    try {
      this.#deps.store.save(next);
    } catch (error) {
      return { ok: false, result: { status: 500, body: { error: `단톡방 기록을 저장하지 못했습니다: ${errorText(error)}` } } };
    }
    this.#record = next;
    return { ok: true };
  }

  #withRequest(record: LoungeRecord, requestId: string): LoungeRecord["requests"] {
    return [...record.requests, { id: requestId, at: this.#deps.now() }];
  }

  #ok(accepted: boolean): LoungeDispatchResult {
    return { status: 200, body: { duplicate: false, accepted, snapshot: this.snapshot() } };
  }

  #applySettings(record: LoungeRecord, action: Extract<LoungeAction, { action: "settings" }>): LoungeDispatchResult {
    const patch: Partial<LoungeRoomSettings> = {};
    if (action.enabled !== undefined) patch.enabled = action.enabled;
    if (action.autoTalk !== undefined) patch.autoTalk = action.autoTalk;
    if (action.participants !== undefined) patch.participants = action.participants;
    if (action.pace !== undefined) patch.pace = action.pace;
    if (action.sleepAfterMinutes !== undefined) patch.sleepAfterMinutes = action.sleepAfterMinutes;
    const settings = { ...record.settings, ...patch };
    const accountBindings = { ...record.accountBindings };
    for (const [id, credentialId] of Object.entries(action.accountBindings ?? {})) {
      const member = LOUNGE_MEMBERS.find((entry) => entry.id === id)!;
      const choices = this.#deps.invoker.account?.(member, credentialId)?.choices ?? [];
      if (!choices.some((choice) => choice.credentialId === credentialId)) {
        return { status: 400, body: { error: "해당 멤버의 사용 가능한 계정을 선택하세요." } };
      }
      accountBindings[id] = credentialId;
    }
    // 자리 해석은 최초 명시 참여 때만. disabled/삭제 뒤에는 기존 durable ID를 절대 재해석하지 않는다.
    for (const id of action.participants ?? []) {
      if (record.settings.participants.includes(id) || accountBindings[id] !== undefined) continue;
      const member = LOUNGE_MEMBERS.find((entry) => entry.id === id)!;
      const suggested = this.#deps.invoker.defaultAccount?.(member);
      if (suggested !== undefined) accountBindings[id] = suggested;
    }
    if (!settings.enabled) {
      this.#abortRun();
      this.#resumedByUser = false;
      this.#clearAutoTimer();
    }
    const committed = this.#commit({
      ...record,
      settings,
      accountBindings,
      requests: this.#withRequest(record, action.requestId),
    });
    if (!committed.ok) return committed.result;
    for (const id of Object.keys(action.accountBindings ?? {})) this.#failures.delete(id);
    const run = this.#run;
    if (settings.enabled && run) {
      const participants = new Set(settings.participants);
      if (run.currentMemberId && (!participants.has(run.currentMemberId)
        || record.accountBindings[run.currentMemberId] !== accountBindings[run.currentMemberId])) this.#abortRun();
      else run.queue = run.queue.filter((id) => participants.has(id));
    }
    this.#emitState();
    this.#scheduleAuto();
    return this.#ok(false);
  }

  #send(record: LoungeRecord, action: Extract<LoungeAction, { action: "send" }>): LoungeDispatchResult {
    if (!record.settings.enabled) return { status: 409, body: { error: "단톡방이 꺼져 있습니다." } };
    const target = action.replyToId ? record.messages.find((message) => message.id === action.replyToId) : undefined;
    if (action.replyToId && !target) return { status: 400, body: { error: "답장할 메시지를 찾지 못했습니다." } };
    const now = this.#deps.now();
    const message: LoungeMessage = {
      id: this.#deps.newId(),
      memberId: "user",
      text: action.text,
      createdAt: now,
      ...(action.replyToId ? { replyToId: action.replyToId } : {}),
      reactions: [],
    };
    const messages = [...record.messages, message];
    const committed = this.#commit({
      ...record,
      messages,
      requests: this.#withRequest(record, action.requestId),
      lastUserActivityAt: now,
    });
    if (!committed.ok) return committed.result;
    this.#resumedByUser = true;
    this.#emit({ event: "message", data: { revision: this.#bump(), message } });

    const candidates = this.#callableParticipants({ excludeWorking: false });
    const plan = planReply({
      text: action.text,
      replyToMemberId: target && target.memberId !== "user" ? target.memberId : undefined,
      candidates,
      messages,
      pace: record.settings.pace,
    });
    const accepted = plan.memberIds.length > 0 && this.#callsRemaining() > 0;
    if (accepted) this.#startTurn("reply", plan.memberIds, plan.perTurnLimit, plan.allowFollowUp);
    else this.#emitState();
    this.#scheduleAuto();
    return this.#ok(accepted);
  }

  #stop(record: LoungeRecord, requestId: string): LoungeDispatchResult {
    // 디스크 오류가 중단을 막아서는 안 된다. 취소는 저장보다 먼저 수행한다.
    this.#abortRun();
    this.#resumedByUser = false;
    this.#clearAutoTimer();
    this.#emitState();
    const committed = this.#commit({ ...record, requests: this.#withRequest(record, requestId) });
    return committed.ok ? this.#ok(false) : committed.result;
  }

  #react(record: LoungeRecord, action: Extract<LoungeAction, { action: "reaction" }>): LoungeDispatchResult {
    const index = record.messages.findIndex((message) => message.id === action.messageId);
    if (index < 0) return { status: 404, body: { error: "반응할 메시지를 찾지 못했습니다." } };
    const current = record.messages[index];
    const existing = current.reactions.find((reaction) => reaction.emoji === action.emoji);
    let reactions: LoungeMessage["reactions"];
    if (!existing) {
      reactions = [...current.reactions, { emoji: action.emoji, by: ["user"] }];
    } else if (existing.by.includes("user")) {
      const by = existing.by.filter((id) => id !== "user");
      reactions = by.length > 0
        ? current.reactions.map((reaction) => (reaction === existing ? { ...reaction, by } : reaction))
        : current.reactions.filter((reaction) => reaction !== existing);
    } else {
      reactions = current.reactions.map((reaction) => (reaction === existing ? { ...reaction, by: [...reaction.by, "user"] } : reaction));
    }
    const message = { ...current, reactions };
    const messages = record.messages.slice();
    messages[index] = message;
    const committed = this.#commit({ ...record, messages, requests: this.#withRequest(record, action.requestId) });
    if (!committed.ok) return committed.result;
    this.#emit({ event: "message", data: { revision: this.#bump(), message } });
    return this.#ok(false);
  }

  // ── run ─────────────────────────────────────────────────────────────────

  #abortRun(): void {
    const run = this.#run;
    this.#generation += 1;
    this.#run = null;
    this.#streaming = null;
    run?.controller.abort();
  }

  #startTurn(kind: ActiveRun["kind"], memberIds: string[], perTurnLimit: number, allowFollowUp: boolean): void {
    const existing = this.#run;
    if (existing) {
      // single flight: 말하던 멤버는 끝까지 말하고, 남은 대기열만 새 차례로 바꾼다.
      existing.kind = kind;
      existing.queue = memberIds.slice();
      existing.spoken = new Set();
      existing.calls = 0;
      existing.perTurnLimit = perTurnLimit;
      existing.allowFollowUp = allowFollowUp;
      existing.followUpUsed = false;
      this.#emitState();
      return;
    }
    const run: ActiveRun = {
      generation: this.#generation,
      controller: new AbortController(),
      kind,
      queue: memberIds.slice(),
      spoken: new Set(),
      calls: 0,
      perTurnLimit,
      allowFollowUp,
      followUpUsed: false,
      startedAt: this.#deps.now(),
      currentMemberId: null,
    };
    this.#run = run;
    this.#clearAutoTimer();
    this.#emitState();
    void this.#loop(run);
  }

  #isLive(run: ActiveRun): boolean {
    return this.#run === run && run.generation === this.#generation && !run.controller.signal.aborted;
  }

  async #loop(run: ActiveRun): Promise<void> {
    try {
      while (this.#isLive(run) && run.queue.length > 0 && run.calls < run.perTurnLimit) {
        const memberId = run.queue.shift()!;
        const record = this.#record!;
        const member = LOUNGE_MEMBERS.find((entry) => entry.id === memberId);
        if (!member || !record.settings.enabled || !record.settings.participants.includes(memberId)) continue;
        if (!this.#availability(member).ok) continue;
        if (run.kind === "auto" && this.#deps.workingMemberIds(record.accountBindings).has(memberId)) continue;
        if (this.#callsRemaining() <= 0) break;

        // 호출 시각을 먼저 기록한다. 저장하지 못하면 상한을 셀 수 없으므로 호출하지 않는다.
        const now = this.#deps.now();
        const calls = [...record.callTimestamps.filter((at) => at > now - CALL_WINDOW_MS), now];
        try {
          this.#deps.store.save({ ...record, callTimestamps: calls });
        } catch (error) {
          this.#failures.set(memberId, { reason: `기록 저장 실패: ${errorText(error)}`, until: now + FAILURE_COOLDOWN_MS });
          break;
        }
        this.#record = { ...record, callTimestamps: calls };

        run.calls += 1;
        run.spoken.add(memberId);
        run.currentMemberId = memberId;
        const messageId = this.#deps.newId();
        this.#streaming = { generation: run.generation, messageId, memberId, text: "" };
        this.#emitState();

        const participants = LOUNGE_MEMBERS.filter((entry) => record.settings.participants.includes(entry.id));
        const prompt = buildLoungePrompt({
          member, participants, messages: this.#record.messages, mode: run.kind,
          lastSpeaker: run.queue.length === 0,
        });
        let text: string;
        try {
          text = await this.#deps.invoker.invoke({
            member,
            credentialId: this.#record.accountBindings[member.id],
            systemPrompt: prompt.systemPrompt,
            userText: prompt.userText,
            signal: run.controller.signal,
            onText: (partial) => {
              if (!this.#isLive(run) || this.#streaming?.messageId !== messageId) return;
              this.#streaming.text = partial;
              this.#emit({
                event: "delta",
                data: { revision: this.#bump(), generation: run.generation, messageId, memberId, text: partial },
              });
            },
          });
        } catch (error) {
          if (!this.#isLive(run)) return;
          const failedAt = this.#deps.now();
          const until = error instanceof LoungeUnavailableError && error.until && error.until > failedAt
            ? error.until
            : failedAt + FAILURE_COOLDOWN_MS;
          this.#failures.set(memberId, { reason: errorText(error), until });
          this.#streaming = null;
          run.currentMemberId = null;
          this.#emitState();
          continue;
        }
        // stop·OFF 뒤에 도착한 결과는 버린다.
        if (!this.#isLive(run)) return;
        this.#failures.delete(memberId);
        this.#streaming = null;
        run.currentMemberId = null;
        const finalText = text.trim().slice(0, LOUNGE_TEXT_MAX);
        if (finalText === "") {
          this.#emitState();
          continue;
        }
        const latest = this.#record!;
        const message: LoungeMessage = { id: messageId, memberId, text: finalText, createdAt: this.#deps.now(), reactions: [] };
        const next = { ...latest, messages: [...latest.messages, message] };
        try {
          this.#deps.store.save(next);
        } catch (error) {
          this.#failures.set(memberId, { reason: `기록 저장 실패: ${errorText(error)}`, until: this.#deps.now() + FAILURE_COOLDOWN_MS });
          break;
        }
        this.#record = next;
        this.#emit({ event: "message", data: { revision: this.#bump(), message } });

        if (run.allowFollowUp && !run.followUpUsed && run.calls < run.perTurnLimit) {
          const candidates = this.#callableParticipants({ excludeWorking: false }).filter((entry) => !run.queue.includes(entry.id));
          const followUp = pickFollowUp(finalText, memberId, candidates, run.spoken);
          if (followUp) {
            run.followUpUsed = true;
            run.queue.push(followUp);
          }
        }
      }
    } finally {
      if (this.#run === run) {
        this.#run = null;
        this.#streaming = null;
        this.#emitState();
        this.#scheduleAuto();
      }
    }
  }

  // ── 자동 발언 ────────────────────────────────────────────────────────────

  #clearAutoTimer(): void {
    if (this.#autoTimer !== undefined) this.#deps.timers.clear(this.#autoTimer);
    this.#autoTimer = undefined;
  }

  #sleepAt(): number | null {
    const record = this.#record;
    if (!record?.settings.enabled || !record.settings.autoTalk || !this.#resumedByUser || record.lastUserActivityAt === null) {
      return null;
    }
    return record.lastUserActivityAt + record.settings.sleepAfterMinutes * 60_000;
  }

  #nextAutoAt(): number | null {
    const record = this.#record;
    const sleepAt = this.#sleepAt();
    if (!record || sleepAt === null || sleepAt <= this.#deps.now() || this.#run) return null;
    const lastMessageAt = record.messages.at(-1)?.createdAt ?? record.lastUserActivityAt ?? this.#deps.now();
    const at = Math.max(lastMessageAt, this.#lastAutoAttemptAt) + AUTO_TALK_INTERVAL_MS[record.settings.pace];
    return at < sleepAt ? at : null;
  }

  #scheduleAuto(): void {
    this.#clearAutoTimer();
    const at = this.#nextAutoAt();
    if (at === null) return;
    this.#autoTimer = this.#deps.timers.set(() => {
      this.#autoTimer = undefined;
      this.#autoTalk();
    }, Math.max(0, at - this.#deps.now()));
  }

  #autoTalk(): void {
    const at = this.#nextAutoAt();
    if (at === null) {
      this.#emitState();
      return;
    }
    if (at > this.#deps.now()) {
      this.#scheduleAuto();
      return;
    }
    this.#lastAutoAttemptAt = this.#deps.now();
    if (this.#deps.autoTalkBlockReason()) {
      this.#emitState();
      this.#scheduleAuto();
      return;
    }
    if (this.#callsRemaining() <= 0) {
      this.#emitState();
      return;
    }
    const record = this.#record!;
    const speaker = byLeastRecent(
      this.#callableParticipants({ excludeWorking: true }),
      lastSpokeAtByMember(record.messages),
    )[0];
    if (!speaker) {
      this.#scheduleAuto();
      return;
    }
    this.#startTurn("auto", [speaker.id], 1, false);
  }

  // ── 조회 ────────────────────────────────────────────────────────────────

  #callsRemaining(): number {
    const record = this.#record;
    if (!record) return 0;
    const since = this.#deps.now() - CALL_WINDOW_MS;
    return HOURLY_CALL_LIMIT - record.callTimestamps.filter((at) => at > since).length;
  }

  #availability(member: LoungeMemberSpec): LoungeAvailability {
    const failure = this.#failures.get(member.id);
    if (failure && failure.until > this.#deps.now()) return { ok: false, reason: failure.reason };
    try {
      return this.#deps.invoker.availability(member, this.#record?.accountBindings[member.id]);
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }

  #callableParticipants(options: { excludeWorking: boolean }): LoungeMemberSpec[] {
    const record = this.#record;
    if (!record?.settings.enabled) return [];
    const working = options.excludeWorking ? this.#deps.workingMemberIds(record.accountBindings) : new Set<string>();
    return LOUNGE_MEMBERS.filter((member) =>
      record.settings.participants.includes(member.id)
      && !working.has(member.id)
      && this.#availability(member).ok);
  }

  #roomView(): LoungeRoom {
    const settings = this.#record?.settings;
    const enabled = settings?.enabled === true;
    const sleepAt = this.#sleepAt();
    const now = this.#deps.now();
    return {
      id: LOUNGE_ROOM_ID,
      enabled,
      autoTalk: settings?.autoTalk ?? false,
      participants: settings?.participants.slice() ?? [],
      pace: settings?.pace ?? "normal",
      sleepAfterMinutes: settings?.sleepAfterMinutes ?? 10,
      asleep: enabled && settings?.autoTalk === true && (sleepAt === null || sleepAt <= now),
      sleepAt: sleepAt !== null && sleepAt > now ? sleepAt : null,
      autoTalkPausedReason: settings?.autoTalk ? this.#deps.autoTalkBlockReason() : undefined,
    };
  }

  #memberViews(): LoungeMember[] {
    const settings = this.#record?.settings;
    const run = this.#run;
    let working: ReadonlySet<string>;
    try {
      working = this.#deps.workingMemberIds(this.#record?.accountBindings ?? {});
    } catch {
      working = new Set();
    }
    return LOUNGE_MEMBERS.map((member) => {
      const availability = this.#availability(member);
      const enabled = settings?.participants.includes(member.id) === true;
      let state: LoungeMember["state"] = "off";
      if (settings?.enabled && enabled) {
        if (run?.currentMemberId === member.id) state = "speaking";
        else if (!availability.ok) state = "offline";
        else if (run?.queue.includes(member.id)) state = "reading";
        else if (working.has(member.id)) state = "working";
        else state = "idle";
      }
      return {
        id: member.id,
        alias: member.alias,
        seed: member.seed,
        provider: member.provider,
        model: member.model,
        enabled,
        available: availability.ok,
        state,
        ...(availability.ok ? {} : { reason: availability.reason }),
        account: this.#deps.invoker.account?.(member, this.#record?.accountBindings[member.id]),
      };
    });
  }

  #runView(): LoungeRun {
    const run = this.#run;
    const record = this.#record;
    const since = this.#deps.now() - CALL_WINDOW_MS;
    return {
      active: run !== null,
      generation: this.#generation,
      currentMemberId: run?.currentMemberId ?? null,
      queuedMemberIds: run?.queue.slice() ?? [],
      startedAt: run?.startedAt ?? null,
      calls: {
        used: record ? record.callTimestamps.filter((at) => at > since).length : 0,
        limit: HOURLY_CALL_LIMIT,
        windowMs: CALL_WINDOW_MS,
      },
      perTurnLimit: run?.perTurnLimit ?? PER_TURN_LIMIT,
    };
  }

  // ── 이벤트 ──────────────────────────────────────────────────────────────

  #bump(): number {
    this.#revision += 1;
    return this.#revision;
  }

  #emitState(): void {
    const revision = this.#bump();
    this.#emit({
      event: "state",
      data: {
        revision,
        members: this.#memberViews(),
        room: this.#roomView(),
        run: this.#runView(),
        ...(this.#loadError ? { loadError: this.#loadError } : {}),
      },
    });
  }

  #emit(event: LoungeServerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // 끊긴 SSE 하나가 다른 구독자와 방 상태를 막지 않는다.
      }
    }
  }
}
