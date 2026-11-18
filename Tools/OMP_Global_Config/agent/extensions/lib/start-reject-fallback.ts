import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { DeepSeekUsageLimitRecord, StartRejectRecord } from "./routing-ledger";
import { onSessionLifecycle } from "./session-identity";

/**
 * 시작 거절 Maker 자동 재발주(2026-11-18 사용자 결정: 「시작하자마자 거절되고 한 일이 없는 Maker는 대체 순서의 다음 모델로
 * 한 번 자동 재발주하고, Main과 너에게 그 사실과 원래 오류를 바로 알림」).
 *
 * 대상은 Maker child의 첫 모델 요청이 공급자 거절로 끝난 경우뿐이다: stopReason error, 도구 호출 0, core 오류 분류가 사용 한도·
 * 중단·재시도 가능(네트워크·시간 초과·5xx)이 아닌 것. 새 task를 띄우지 않고 같은 child 안에서 core의 기존 hard-error 대체
 * 경로(`retry.fallbackChains` exact 모델 키 → role 체인, 같은 모델 제외)가 첫 요청을 다음 모델로 다시 보내게 한다. 그 경로는
 * `retry.fallbackOn`이 허락할 때만 열리므로, 첫 응답을 본 `assistant_message`(agent_end 복구 전에 await된다)에서 그 child의
 * settings overlay(쓰기가 그 child에만 남고 저장되지 않는다)만 `any`로 바꾸고, 대체 적용·첫 도구 시작·다음 응답 중 먼저 오는
 * 때 원래 값으로 되돌린다. 같은 child라 이름·브리프·OWNED_PATHS·placement가 그대로여서 새 발주의 차단(placement, 준비 이름,
 * 소유 충돌)이 생기지 않는다. 부모는 core가 child 세션 이벤트를 싣는 event bus 채널에서 이를 관측해 알린다.
 */

/** core task executor가 child 세션 이벤트를 부모 event bus에 싣는 채널(core `task/types.ts` TASK_SUBAGENT_EVENT_CHANNEL). */
export const SUBAGENT_EVENT_CHANNEL = "task:subagent:event";
export const START_REJECT_CUSTOM_TYPE = "start-reject-fallback";
const DEEPSEEK_LIMIT_CUSTOM_TYPE = "deepseek-usage-limit-fallback";

export type FailureKind = "rejection" | "usage-limit" | "abort" | "transient";

export interface AssistantLike {
  role?: string;
  api?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  errorStatus?: number;
  errorId?: number;
  content?: ReadonlyArray<{ type?: string }>;
}

export type ClassifyFailure = (message: AssistantLike) => FailureKind;

/** core `@oh-my-pi/pi-ai/error`에서 쓰는 부분만. */
export interface AIErrorLike {
  classifyMessage(message: { api?: string; errorId?: number; errorMessage?: string; errorStatus?: number }): number;
  is(id: number | undefined, flag: number): boolean;
  retriable(id: number | undefined): boolean;
  Flag: { UsageLimit: number; Abort: number; UserInterrupt: number; SilentAbort: number };
}

/** core 재시도 정책과 같은 분류기로 실패 종류를 정한다. 거절은 사용 한도·중단·재시도 가능 오류가 아닌 나머지 전부다. */
export function classifierFrom(AIError: AIErrorLike): ClassifyFailure {
  return (message) => {
    if (message.stopReason === "aborted") return "abort";
    const id = AIError.classifyMessage({
      api: message.api, errorId: message.errorId, errorMessage: message.errorMessage, errorStatus: message.errorStatus,
    });
    if (AIError.is(id, AIError.Flag.UsageLimit)) return "usage-limit";
    if (AIError.is(id, AIError.Flag.Abort) || AIError.is(id, AIError.Flag.UserInterrupt) || AIError.is(id, AIError.Flag.SilentAbort)) return "abort";
    if (AIError.retriable(id)) return "transient";
    return "rejection";
  };
}

let defaultClassifier: Promise<ClassifyFailure> | undefined;
/** legacy-pi loader가 host SDK specifier를 재작성하므로 core 모듈은 실행 시점에 동적으로 읽는다(jev-runtime과 같은 관례). */
const loadClassifier = (): Promise<ClassifyFailure> =>
  defaultClassifier ??= import("@oh-my-pi/pi-ai/error").then((module) => classifierFrom(module as unknown as AIErrorLike));

/** 도구 호출 없이 공급자 거절로 끝난 assistant 응답인가. */
export function isStartRejection(message: AssistantLike | undefined, classify: ClassifyFailure): boolean {
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return false;
  if ((message.content ?? []).some((block) => block?.type === "toolCall")) return false;
  return classify(message) === "rejection";
}

const modelOf = (message: AssistantLike) =>
  message.provider && message.model ? `${message.provider}/${message.model}` : message.model ?? "<unknown>";
// 원문 그대로 싣는다(공백·줄바꿈 포함). 비었을 때만 표시를 넣는다.
const errorOf = (message: AssistantLike) => message.errorMessage || "<no error text>";
const isDeepSeek = (id: string | undefined) => /(?:^|[/-])deepseek(?:[-_/]|$)/iu.test(id ?? "");
const isSonnet = (id: string) => /(?:^|[/.])claude-sonnet(?:[-.]|$)/iu.test(id);
const modelIdOf = (selector: string) => selector.slice(selector.indexOf("/") + 1);
const isDeepSeekRequest = (selector: string) => /^@implDeepSeek(?::[^:]+)?$/iu.test(selector) || isDeepSeek(modelIdOf(selector));

async function isDeepSeekUsageLimit(message: AssistantLike, classify: () => Promise<ClassifyFailure>): Promise<boolean> {
  // Core's reserve preflight can synthesize a limit without issuing a request.
  return message.role === "assistant" && message.stopReason === "error" && isDeepSeek(message.model) &&
    message.errorMessage?.startsWith("Usage preflight blocked:") !== true &&
    (await classify())(message) === "usage-limit";
}

interface DeepSeekFallbackArm {
  sourceKeys: Set<string>;
  target: string | undefined;
  release(applied: boolean): void;
}

/** Let core roll back just the failed request; neither the assignment nor its completed tool calls are replayed. */
async function armDeepSeekFallback(ctx: ExtensionContext): Promise<DeepSeekFallbackArm | undefined> {
  const [{ findScopedSettings }, retry, selectors] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    import("@oh-my-pi/pi-coding-agent/session/settings"),
    import("@oh-my-pi/pi-coding-agent/session/retry-fallback-chains"),
  ]);
  const settings = findScopedSettings();
  if (!settings || !ctx.model || !isDeepSeek(ctx.model.id)) return undefined;
  // NORMAL_SONNET resolves through the same slot as maker-routing.
  const slot = settings.getModelRole("implSonnet");
  const parsed = slot && selectors.parseRetryFallbackSelector(slot, ctx.modelRegistry);
  const model = parsed && ctx.modelRegistry.find(parsed.provider, parsed.id);
  const target = parsed && model && isSonnet(model.id) ? `${parsed.provider}/${parsed.id}:auto` : undefined;
  const source = selectors.formatRetryFallbackSelector(ctx.model, undefined);
  const routedId = selectors.parseRetryFallbackSelector(source, ctx.modelRegistry)?.id;
  const previousChains = retry.cfgRetryFallbackChains.get(settings);
  const previousTrigger = retry.cfgRetryFallbackOn.get(settings);
  const previousRevert = retry.cfgRetryFallbackRevertPolicy.get(settings);
  const previousUsageAware = retry.cfgRetryUsageAwareFallback.get(settings);
  // Exact effort keys outrank the base key. Give every matching key the same single
  // target and mask the other chains, including any role pinned by an earlier hop.
  const onlyTarget = target ? [target] : [];
  const sourceKeys = new Set([source]);
  const temporaryChains = { [source]: onlyTarget };
  for (const key of Object.keys(previousChains)) {
    if (key === source) continue;
    const selector = selectors.parseRetryFallbackSelector(key, ctx.modelRegistry);
    if (selector && selector.provider === ctx.model.provider && (selector.id === ctx.model.id || selector.id === routedId)) {
      sourceKeys.add(key);
      temporaryChains[key] = onlyTarget;
    } else {
      temporaryChains[key] = [];
    }
  }
  retry.cfgRetryFallbackChains.override(settings, temporaryChains);
  retry.cfgRetryFallbackOn.override(settings, "usage-limit");
  retry.cfgRetryFallbackRevertPolicy.override(settings, "never");
  retry.cfgRetryUsageAwareFallback.override(settings, false);
  return {
    sourceKeys, target,
    release(applied) {
      retry.cfgRetryFallbackChains.override(settings, previousChains);
      retry.cfgRetryFallbackOn.override(settings, previousTrigger);
      if (applied) {
        // Keep the chosen model; allowing Sonnet's own chain could return to DeepSeek.
        retry.cfgRetryModelFallback.override(settings, false);
      } else {
        retry.cfgRetryFallbackRevertPolicy.override(settings, previousRevert);
        retry.cfgRetryUsageAwareFallback.override(settings, previousUsageAware);
      }
    },
  };
}

/** child 세션 자신의 `retry.fallbackOn` 값. 이 child의 settings overlay에만 읽고 쓴다. */
export interface FallbackOnPort {
  get(): string | undefined;
  set(value: string): void;
}

/**
 * handler 안에서는 runner가 그 세션 settings로 scope를 잡는다(core `withActiveSettings`). subagent 세션의 settings는 부모
 * 위의 overlay라 쓰기가 그 child에만 남고 저장되지 않는다.
 */
async function defaultFallbackOnPort(): Promise<FallbackOnPort | undefined> {
  const [{ findScopedSettings }, { cfgRetryFallbackOn }] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    import("@oh-my-pi/pi-coding-agent/session/settings"),
  ]);
  const settings = findScopedSettings();
  if (!settings) return undefined;
  const setting = cfgRetryFallbackOn as unknown as { get(s: unknown): string; set(s: unknown, value: string): void };
  return { get: () => setting.get(settings), set: (value) => setting.set(settings, value) };
}

export interface ChildFallbackDeps {
  classify?: () => Promise<ClassifyFailure>;
  fallbackOn?: () => Promise<FallbackOnPort | undefined>;
}

/** child 한 세션의 첫 응답 판정과 overlay 복원. */
export interface ChildFallback {
  /** core가 응답을 확정한 직후, agent 문맥·agent_end 복구보다 먼저 await된다. */
  onAssistantMessage(message: AssistantLike, ctx?: ExtensionContext): Promise<void>;
  onFallbackApplied(event?: { to: string; role: string }): void;
  /** 복구가 이어 가지 않기로 정한 뒤의 실행 끝(쓸 수 있는 다음 모델이 없던 경우)에도 원래 값으로 돌린다. */
  onRunEnd(): void;
  onToolStart(): void;
  reset(): void;
  /** 테스트·진단용. */
  readonly flipped: boolean;
}

/** Child-local recovery, reset only when switching sessions. */
export function createChildFallback(deps: ChildFallbackDeps = {}): ChildFallback {
  const classify = deps.classify ?? loadClassifier;
  const fallbackOn = deps.fallbackOn ?? defaultFallbackOnPort;
  let assistants = 0;
  let tools = 0;
  let flipped: { port: FallbackOnPort; previous: string } | undefined;
  let deepSeekOrigin = false;
  let deepSeekSwitched = false;
  let arm: DeepSeekFallbackArm | undefined;
  const releaseArm = (applied: boolean) => {
    arm?.release(applied);
    arm = undefined;
  };
  const restore = () => {
    if (!flipped) return;
    const { port, previous } = flipped;
    flipped = undefined;
    port.set(previous);
  };
  return {
    /** core가 응답을 확정한 직후, agent 문맥·agent_end 복구보다 먼저 await된다. */
    async onAssistantMessage(message, ctx): Promise<void> {
      assistants += 1;
      if (assistants === 1) {
        const initial = ctx?.sessionManager?.getEntries?.().find(entry => entry.type === "model_change");
        const requested = initial?.type === "model_change" ? initial.requestedModel : undefined;
        deepSeekOrigin = requested ? isDeepSeekRequest(requested) : isDeepSeek(message.model);
      }
      if (flipped) {
        // 대체 모델의 응답이다. 그 응답의 복구 판단 전에 원래 정책으로 돌려 대체를 한 번으로 묶는다.
        restore();
        return;
      }
      if (ctx && deepSeekOrigin && !deepSeekSwitched) {
        if (await isDeepSeekUsageLimit(message, classify)) {
          arm ??= await armDeepSeekFallback(ctx);
          return;
        }
        // A same-model credential retry can recover without taking the armed hop.
        releaseArm(false);
      }
      if (assistants !== 1 || tools > 0) return;
      if (!isStartRejection(message, await classify())) return;
      const port = await fallbackOn();
      const previous = port?.get();
      if (!port || previous === undefined || previous === "any") return;
      port.set("any");
      flipped = { port, previous };
    },
    onFallbackApplied(event): void {
      restore();
      if (arm && event && arm.sourceKeys.has(event.role) && event.to === arm.target) {
        deepSeekSwitched = true;
        releaseArm(true);
      }
    },
    onRunEnd(): void {
      restore();
      releaseArm(false);
    },
    onToolStart(): void {
      tools += 1;
      restore();
    },
    reset(): void {
      restore();
      releaseArm(false);
      deepSeekOrigin = false;
      deepSeekSwitched = false;
      assistants = 0;
      tools = 0;
    },
    /** 테스트·진단용. */
    get flipped(): boolean {
      return flipped !== undefined;
    },
  };
}

export type StartRejectStage = StartRejectRecord["stage"];

export interface StartRejectNotice {
  stage: StartRejectStage;
  childId: string;
  fromModel: string;
  error: string;
  toModel?: string;
  replacementError?: string;
  /** 이 세션에서 같은 모델이 앞서 같은 식으로 거절된 횟수. 0이면 처음이다. */
  priorRejections: number;
}

type DeepSeekLimitNotice = Pick<DeepSeekUsageLimitRecord, "stage" | "fromModel" | "error" | "toModel" | "replacementError"> & {
  childId: string;
};

function renderDeepSeekLimitNotice(notice: DeepSeekLimitNotice): string {
  const head = `[DeepSeekUsageLimitFallback] Maker ${notice.childId}의 ${notice.fromModel} 요청이 사용 한도에 도달했다. 원문 오류: ${JSON.stringify(notice.error)}.`;
  if (notice.stage === "switched") {
    return `${head} 같은 child가 기존 작업을 ${notice.toModel}로 이어간다. Main은 새로 발주하지 않는다.`;
  }
  if (notice.stage === "no-replacement") {
    return `${head} NORMAL_SONNET으로 전환하지 못했다. 다른 모델로 바꾸지 않고 종료했다.`;
  }
  return `${head} 전환한 ${notice.toModel}도 실패해 멈췄다. 대체 모델 원문 오류: ${JSON.stringify(notice.replacementError)}. 추가 모델 전환은 없다.`;
}

export function renderStartRejectNotice(notice: StartRejectNotice): string {
  const repeat = notice.priorRejections > 0
    ? ` 반복: 이 세션에서 ${notice.fromModel}의 시작 거절은 이번이 ${notice.priorRejections + 1}번째다.`
    : "";
  const head = `[StartRejectFallback] Maker ${notice.childId}의 첫 요청이 공급자에서 거절됐다(도구 호출·파일 변경 없음). 원래 모델: ${notice.fromModel}. 원문 오류: ${JSON.stringify(notice.error)}.`;
  if (notice.stage === "redispatched") {
    return `${head} 같은 child를 대체 순서의 다음 모델 ${notice.toModel}로 자동 재발주했다(2026-11-18 사용자 결정, 한 번만). automatic redispatch done; Main must not redispatch manually.${repeat}`;
  }
  const cleanup = " 추가 자동 시도는 없다. 이 child는 owner·placement 후보에서 뺐으니 Main이 같은 준비(preparedId·이름)로 다시 발주할 수 있다.";
  if (notice.stage === "no-replacement") {
    return `${head} ${notice.fromModel}의 retry.fallbackChains에 쓸 수 있는 다음 모델이 없어 재발주하지 않았다.${cleanup}${repeat}`;
  }
  return `${head} 자동 재발주한 ${notice.toModel}도 시작에서 실패했다(도구 호출 없음): ${JSON.stringify(notice.replacementError ?? "")}.${cleanup}${repeat}`;
}

type ChildState = {
  assistants: number;
  worked: boolean;
  first?: { model: string; error: string; prior: number };
  /** core가 이 child에서 처음 적용한 대체. 부모 쪽 전달 순서가 첫 응답의 message_end보다 앞설 수 있어 따로 둔다. */
  applied?: { from: string; to: string };
  /** 위 대체가 첫 응답의 시작 거절에 대한 자동 재발주로 확인됐다. */
  switched?: { from: string; to: string };
  replacementSeen: boolean;
  /** 대체 모델이 오류 아닌 응답을 냈다(시작 실패가 아니다). */
  replacementOk: boolean;
  /** 대체 모델의 마지막 오류 원문. */
  replacementError?: string;
  ended: boolean;
  final: boolean;
  deepSeekOrigin?: boolean;
  limit?: Omit<DeepSeekLimitNotice, "stage" | "childId">;
  limitHop?: { fromModel: string; toModel: string };
};

export interface StartRejectTrackerDeps {
  classify?: () => Promise<ClassifyFailure>;
  notify?(notice: StartRejectNotice): void;
  notifyDeepSeekLimit?(notice: DeepSeekLimitNotice): void;
}

/** 부모 세션의 시작 거절 관측 상태. 호출부(jev-runtime)는 owner 정리와 수동 중복 발주 차단에 쓴다. */
export interface StartRejectTracker {
  /** Apply a child event, using the dispatch's model when progress has reported one. */
  onChildEvent(id: string, event: { type?: string; [key: string]: unknown }, requestedDeepSeek?: boolean): Promise<void>;
  /** 끝내 시작 거절로 실패해 owner·placement 후보에서 뺄 child id인가. */
  failedChild(id: string | undefined): boolean;
  /** 자동 재발주한 대체 모델로 아직 실행 중인 child id → 대체 모델. */
  replaying(): Map<string, string>;
  reset(): void;
}

/** 부모 세션에서 child 세션 이벤트를 받아 자동 재발주를 알리고, 끝내 실패한 child를 owner 후보에서 빼는 상태. */
export function createStartRejectTracker(deps: StartRejectTrackerDeps): StartRejectTracker {
  const classify = deps.classify ?? loadClassifier;
  const children = new Map<string, ChildState>();
  /** 모델별 시작 거절 횟수(반복 표시용). */
  const rejectionsByModel = new Map<string, number>();
  const failed = new Set<string>();
  /** reset마다 늘린다. 분류를 기다리던 이전 세션의 처리는 돌아와도 새 세션 상태를 바꾸지 않는다. */
  let epoch = 0;
  const stateOf = (id: string) => {
    let state = children.get(id);
    if (!state) {
      state = { assistants: 0, worked: false, replacementSeen: false, replacementOk: false, ended: false, final: false };
      children.set(id, state);
    }
    return state;
  };
  const finish = (id: string, state: ChildState, notice: Omit<StartRejectNotice, "childId" | "fromModel" | "error" | "priorRejections">) => {
    state.final = true;
    failed.add(id);
    deps.notify?.({ childId: id, fromModel: state.first!.model, error: state.first!.error, priorRejections: state.first!.prior, ...notice });
  };
  const redispatched = (id: string, state: ChildState) => {
    state.switched = state.applied;
    deps.notify?.({ stage: "redispatched", childId: id, fromModel: state.first!.model, error: state.first!.error, toModel: state.applied!.to, priorRejections: state.first!.prior });
  };
  const confirmLimitHop = (id: string, state: ChildState) => {
    const { limit, limitHop } = state;
    if (!state.deepSeekOrigin || !limit || limit.toModel || limitHop?.fromModel !== limit.fromModel) return;
    limit.toModel = limitHop.toModel;
    state.limitHop = undefined;
    deps.notifyDeepSeekLimit?.({ ...limit, childId: id, stage: "switched" });
  };
  return {
    async onChildEvent(id, event, requestedDeepSeek): Promise<void> {
      if (!id || !event || typeof event.type !== "string") return;
      const state = stateOf(id);
      if (requestedDeepSeek !== undefined) state.deepSeekOrigin = requestedDeepSeek;
      const startedEpoch = epoch;
      if (event.type === "agent_start" && state.ended) {
        // 끝난 child가 다시 깨어난 실행은 새 판정 대상이 아니다. 끝내 실패 표시는 다음 실행이 시작되면 거둔다.
        state.ended = false;
        failed.delete(id);
        return;
      }
      if (event.type === "tool_execution_start") {
        state.worked = true;
        return;
      }
      if (event.type === "message_end") {
        const message = event.message as AssistantLike | undefined;
        if (message?.role !== "assistant") return;
        state.assistants += 1;
        if (state.assistants === 1) state.deepSeekOrigin ??= isDeepSeek(message.model);
        if (state.limit?.toModel && modelOf(message) === state.limit.toModel) {
          state.limit.replacementError = message.stopReason === "error" ? errorOf(message) : undefined;
        } else if (state.deepSeekOrigin) {
          if (await isDeepSeekUsageLimit(message, classify)) {
            if (startedEpoch !== epoch) return;
            state.limit ??= { fromModel: modelOf(message), error: errorOf(message) };
            confirmLimitHop(id, state);
            return;
          }
          if (!state.limit?.toModel) {
            state.limit = undefined;
            state.limitHop = undefined;
          }
        }
        if (!deps.notify) return;
        if (state.assistants === 1 && !state.worked) {
          if (!isStartRejection(message, await classify()) || startedEpoch !== epoch) return;
          const model = modelOf(message);
          const prior = rejectionsByModel.get(model) ?? 0;
          rejectionsByModel.set(model, prior + 1);
          state.first = { model, error: errorOf(message), prior };
          if (state.applied) redispatched(id, state);
          return;
        }
        if (state.switched && !state.final && !state.worked && !state.replacementOk) {
          // 대체 모델의 응답이다. 첫 응답이 거절이면 바로 멈춤을 알리고, 재시도 가능한 오류는 실행이 끝날 때 마지막 오류로 판정한다.
          const first = !state.replacementSeen;
          state.replacementSeen = true;
          if (message.stopReason !== "error") {
            state.replacementOk = true;
            return;
          }
          state.replacementError = errorOf(message);
          if (first && isStartRejection(message, await classify()) && startedEpoch === epoch) {
            const model = modelOf(message);
            rejectionsByModel.set(model, (rejectionsByModel.get(model) ?? 0) + 1);
            finish(id, state, { stage: "replacement-rejected", toModel: state.switched.to, replacementError: state.replacementError });
          }
        }
        return;
      }
      if (event.type === "retry_fallback_applied") {
        if (state.deepSeekOrigin !== false && typeof event.from === "string" && typeof event.role === "string" &&
            isDeepSeekRequest(event.from) && isDeepSeekRequest(event.role) &&
            typeof event.to === "string" && event.to.endsWith(":auto") && isSonnet(modelIdOf(event.to))) {
          state.limitHop = {
            fromModel: event.from.replace(/:(?:off|none|minimal|low|medium|high|xhigh|max|auto)$/u, ""),
            toModel: event.to.slice(0, -":auto".length),
          };
          confirmLimitHop(id, state);
          if (state.limit?.toModel) return;
        }
        if (!deps.notify || state.applied || state.worked || state.assistants > 1) return;
        state.applied = { from: String(event.from ?? ""), to: String(event.to ?? "<unknown>") };
        if (state.first) redispatched(id, state);
        return;
      }
      if (event.type === "agent_end") {
        // core의 세션 agent_end는 실행이 끝날 때만 온다. 이어 가는 loop 끝이 실려도 끝으로 보지 않는다.
        if (event.willContinue === true) return;
        state.ended = true;
        state.limitHop = undefined;
        if (state.limit && state.deepSeekOrigin) {
          const limit = state.limit;
          if (!limit.toModel) deps.notifyDeepSeekLimit?.({ ...limit, childId: id, stage: "no-replacement" });
          else if (limit.replacementError) deps.notifyDeepSeekLimit?.({ ...limit, childId: id, stage: "replacement-failed" });
          if (!limit.toModel || limit.replacementError) state.limit = undefined;
        }
        if (state.final || !state.first) return;
        if (!state.switched) finish(id, state, { stage: "no-replacement" });
        else if (!state.worked && !state.replacementOk && state.replacementError !== undefined) {
          finish(id, state, { stage: "replacement-rejected", toModel: state.switched.to, replacementError: state.replacementError });
        }
      }
    },
    failedChild(id: string | undefined): boolean {
      return Boolean(id && failed.has(id));
    },
    replaying(): Map<string, string> {
      const out = new Map<string, string>();
      for (const [id, state] of children) {
        if (state.ended) continue;
        if (state.limit?.toModel) out.set(id, state.limit.toModel);
        else if (state.switched && !state.final) out.set(id, state.switched.to);
      }
      return out;
    },
    reset(): void {
      epoch += 1;
      children.clear();
      rejectionsByModel.clear();
      failed.clear();
    },
  };
}

const isMakerChild = (ctx: ExtensionContext | undefined) => ctx?.agent?.kind === "sub" && ctx.agent.name === "maker";

/** core `@oh-my-pi/pi-tui/overlays/session-observer-registry` TASK_SUBAGENT_LIFECYCLE_CHANNEL. `started`가 child id와 agent 이름을 싣는다. */
export const SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
const SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/**
 * 한 세션 event bus에 묶인 상태. extension reload는 모듈을 다시 읽고 등록을 다시 부르지만 세션의 bus는 그대로라,
 * 같은 bus면 child 판정·부모 관측을 이어 쓰고 알림 전달만 새 등록으로 바꾼다.
 */
interface Station {
  child: ChildFallback;
  tracker: StartRejectTracker;
  /** lifecycle `started`에서 agent가 maker로 확인된 child id. 다른 agent의 거절은 이 기능의 대상이 아니다. */
  makers: Set<string>;
  requestedDeepSeek?: Map<string, boolean>;
  legacyMakers?: Set<string>;
  isIdle?: () => boolean;
  sessionId: string | undefined;
  /** 세션 전환마다 늘린다. 전환 전에 줄 선 이벤트와 진행 중인 판정은 새 세션에 알리거나 기록하지 않는다. */
  generation: number;
  /** 지금 처리 중인 이벤트가 줄 설 때의 generation. */
  processing: number;
  /** child 이벤트 처리 줄. 등록이 바뀌어도 이어진다. */
  queue: Promise<void>;
  deliver(notice: StartRejectNotice): void;
  deliverDeepSeekLimit(notice: DeepSeekLimitNotice): void;
  unsubscribe(): void;
}

const STATIONS_KEY = Symbol.for("cuelo.start-reject-fallback.stations");
function stationsByBus(): WeakMap<object, Station> {
  const holder = globalThis as unknown as Record<symbol, WeakMap<object, Station> | undefined>;
  return holder[STATIONS_KEY] ??= new WeakMap();
}

export interface StartRejectFallbackDeps extends ChildFallbackDeps {
  /** 원장에 남길 기록. 실패해도 던지지 않는다. */
  record?(record: StartRejectRecord): void;
  recordDeepSeekLimit?(record: DeepSeekUsageLimitRecord): void;
}

type EventBusLike = { on(channel: string, handler: (data: unknown) => void): () => void };

/**
 * child 쪽(첫 응답 판정·overlay 복원)과 부모 쪽(event bus 관측·알림·원장)을 함께 등록한다. 돌려준 tracker로 호출부가
 * owner 후보 정리와 수동 중복 발주 차단을 한다.
 */
export function registerStartRejectFallback(
  pi: Pick<ExtensionAPI, "on" | "sendMessage"> & { events?: EventBusLike },
  deps: StartRejectFallbackDeps = {},
): StartRejectTracker {
  const bus = pi.events;
  const previous = bus ? stationsByBus().get(bus) : undefined;
  previous?.unsubscribe();
  const newTracker = (observeStartReject: boolean) => createStartRejectTracker({
    classify: deps.classify,
    notify: observeStartReject ? (notice) => station.deliver(notice) : undefined,
    notifyDeepSeekLimit: (notice) => station.deliverDeepSeekLimit(notice),
  });
  const station: Station = previous ?? {
    child: createChildFallback(deps),
    tracker: newTracker(true),
    makers: new Set(),
    sessionId: undefined,
    generation: 0,
    processing: 0,
    queue: Promise.resolve(),
    deliver: () => {},
    deliverDeepSeekLimit: () => {},
    unsubscribe: () => {},
  };
  if (previous && !previous.requestedDeepSeek) {
    // Keep the session's existing start-reject state and repeat counts. Add a
    // usage-limit observer for newly dispatched children on this bus.
    const legacy = previous.tracker;
    const legacyMakers = station.legacyMakers = new Set(previous.makers);
    const live = newTracker(false);
    station.tracker = {
      async onChildEvent(id, event, requested) {
        await legacy.onChildEvent(id, event);
        if (!legacyMakers.has(id)) await live.onChildEvent(id, event, requested);
      },
      failedChild: id => legacy.failedChild(id),
      replaying() {
        const active = live.replaying();
        for (const [id, model] of legacy.replaying()) active.set(id, model);
        return active;
      },
      reset() {
        legacy.reset();
        legacyMakers.clear();
        live.reset();
      },
    };
  }
  const requestedDeepSeek = station.requestedDeepSeek ??= new Map();
  station.deliver = (notice) => {
    if (station.processing !== station.generation) return;
    pi.sendMessage(
      { customType: START_REJECT_CUSTOM_TYPE, content: renderStartRejectNotice(notice), display: true, attribution: "agent" },
      { deliverAs: "aside" },
    );
    deps.record?.({
      type: "start-reject",
      ts: new Date().toISOString(),
      sessionId: station.sessionId ?? "",
      agentId: notice.childId,
      stage: notice.stage,
      fromModel: notice.fromModel,
      error: notice.error,
      ...(notice.toModel ? { toModel: notice.toModel } : {}),
      ...(notice.replacementError ? { replacementError: notice.replacementError } : {}),
      repeat: notice.priorRejections > 0,
    });
  };
  station.deliverDeepSeekLimit = ({ childId, ...notice }) => {
    if (station.processing !== station.generation) return;
    // An aside wakes idle Main and starts a provider request. Show the same notice without doing that.
    pi.sendMessage(
      { customType: DEEPSEEK_LIMIT_CUSTOM_TYPE, content: renderDeepSeekLimitNotice({ childId, ...notice }), display: true, attribution: "agent" },
      station.isIdle ? station.isIdle() ? undefined : { deliverAs: "aside" } : { deliverAs: "nextTurn" },
    );
    deps.recordDeepSeekLimit?.({
      type: "deepseek-usage-limit", ts: new Date().toISOString(), sessionId: station.sessionId ?? "",
      agentId: childId, ...notice,
    });
  };
  const { child, tracker } = station;

  pi.on("assistant_message", async (event, ctx) => {
    if (isMakerChild(ctx)) await child.onAssistantMessage(event.message as AssistantLike, ctx);
    return undefined;
  });
  pi.on("retry_fallback_applied", (event, ctx) => {
    if (isMakerChild(ctx)) child.onFallbackApplied(event);
  });
  pi.on("tool_execution_start", (_event, ctx) => {
    if (isMakerChild(ctx)) child.onToolStart();
  });
  pi.on("agent_end", (event, ctx) => {
    if (isMakerChild(ctx) && !event.willContinue) child.onRunEnd();
  });
  // 다른 세션으로 옮겼을 때만 비운다. 같은 세션 id(reload, 새로 읽힌 등록 포함)는 진행 중인 관측을 그대로 둔다.
  onSessionLifecycle(pi, { start: (ctx) => {
    station.isIdle = ctx?.isIdle ? () => ctx.isIdle() : undefined;
    const next = String(ctx?.sessionManager?.getSessionId?.() ?? "");
    if (station.sessionId === next) return;
    station.sessionId = next;
    station.generation += 1;
    station.makers.clear();
    requestedDeepSeek.clear();
    child.reset();
    tracker.reset();
  } });

  if (bus) {
    // 분류기를 기다리는 동안 다음 이벤트(retry_fallback_applied)가 앞서 처리되지 않게 도착 순서대로 처리한다.
    // 줄은 station에 두어 reload 전에 줄 선 처리 뒤로 새 등록의 이벤트가 이어진다.
    const offEvents = bus.on(SUBAGENT_EVENT_CHANNEL, (data) => {
      if (!data || typeof data !== "object" || !("id" in data) || !("event" in data)) return;
      const { id, event } = data;
      if (typeof id !== "string" || !station.makers.has(id) || !event || typeof event !== "object") return;
      const generation = station.generation;
      station.queue = station.queue.then(async () => {
        if (generation !== station.generation) return;
        station.processing = generation;
        await tracker.onChildEvent(id, event as { type?: string }, requestedDeepSeek.get(id));
      }).catch(() => {});
    });
    const offLifecycle = bus.on(SUBAGENT_LIFECYCLE_CHANNEL, (data) => {
      if (!data || typeof data !== "object" || !("id" in data) || !("agent" in data) || !("status" in data)) return;
      if (data.status === "started" && data.agent === "maker" && typeof data.id === "string") {
        station.legacyMakers?.delete(data.id);
        station.makers.add(data.id);
      }
    });
    const offProgress = bus.on(SUBAGENT_PROGRESS_CHANNEL, (data) => {
      if (!data || typeof data !== "object" || !("progress" in data)) return;
      const progress = data.progress as { id?: unknown; modelOverride?: unknown } | undefined;
      const id = progress?.id;
      if (typeof id !== "string" || !station.makers.has(id) || requestedDeepSeek.has(id)) return;
      const model = Array.isArray(progress?.modelOverride) ? progress.modelOverride[0] : progress?.modelOverride;
      if (typeof model === "string") requestedDeepSeek.set(id, isDeepSeekRequest(model));
    });
    station.unsubscribe = () => {
      offEvents();
      offLifecycle();
      offProgress();
    };
    stationsByBus().set(bus, station);
  }
  return tracker;
}
