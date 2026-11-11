// Model calls and session context shared by the explicit check and automatic routing plugins.
import type { Api, AssistantMessage, Model, isUsageLimitOutcome } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { authorFamily, reviewerLanes, SLOT as REVIEW_SLOT, type Lane } from "./cross-review";
import { sameModelRoutes } from "./model-routes";

const PRIMARY_ROLE = "implGemini";
/** The second, independent participant (2026-11-11 user decision: Fable 5.2 through its own role, not a review slot). */
const SECONDARY_ROLE = "preflightAnthropic";
const MAX_PLAN = 24_000;
const MAX_USER = 6_000;
const WIDGET = "lab:argon-preflight";

const SECRET = /(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|api[_-]?key|secret)\s*[:=]\s*\S{8,})/i;

const SYSTEM = [
  "너는 작업을 시작하기 직전에 계획을 짧게 점검하는 검토자다.",
  "사용자의 최근 말과 Main(작업을 지휘하는 에이전트)이 세운 계획(발주 브리프나 목표)을 받는다.",
  "다음만 한국어로 짧게 답한다: (1) 사용자의 말에 비해 계획에 빠진 요구·조건, (2) 계획의 모호하거나 틀려 보이는 가정, (3) 결과를 더 좋게 할 방법이나 아이디어, (4) 사용자가 보는 결과를 좌우하고 나중에 되돌리기 비싼 구현 방식을 계획이 사용자 확인 없이 정했으면 발주 전에 사용자에게 물을 질문 한 줄과 권장안.",
  "(4)의 예: 화면을 디자이너 소유로 만들지 실행 중 덧그릴지, 상태를 어디서 소유할지, 기존 구조를 고칠지 새로 짤지. 결과가 같은 내부 선택(이름, 함수 나눔)이나 사용자 말·기존 코드로 이미 정해진 선택은 묻지 않는다.",
  "항목은 최대 5개, 각 한두 문장. 근거가 계획과 사용자 말에 있는 것만 쓴다. 모르는 사실을 지어내지 않는다.",
  "고칠 게 없으면 「빠진 것 없음」 한 줄만 쓴다.",
].join("\n");

/** Why one model call produced no advice. Only the operating kinds may send the check to the counterpart. */
type Failure = "unresolved" | "provider" | "unusable" | "timeout" | "cancelled" | "secret";
const OPERATING: Partial<Record<Failure, true>> = { unresolved: true, provider: true, unusable: true, timeout: true };
type Attempt = { ok: true; text: string; model: string } | { ok: false; kind: Failure; why: string; model?: string; usageLimit?: boolean };
/** One participant's advice, labelled with the exact model that produced it. */
type Opinion = { text: string; model: string; ms: number; fallback?: { from: string; why: string; sameModel?: boolean } };
/** A participant that gave no advice, and why; a fallback line reports it instead of pretending it reviewed. */
type LaneFailure = { slot: string; model?: string; why: string };
type Advice =
  | { ok: true; opinions: Opinion[]; failures: LaneFailure[]; ms: number }
  | { ok: false; why: string; failures: LaneFailure[]; ms: number };
/** One participant either answers or names why it did not; only an operating failure may send the check further. */
type LaneResult = { opinion: Opinion } | { failure: LaneFailure; operating: boolean };

const QUOTA = /\b429\b|quota|usage.?limit|rate.?limit|exhausted|한도/i;
const SECRET_ANYWHERE = new RegExp(SECRET.source, "gi");

/** A provider error as a short reason; a usage limit is named as such, anything else is clipped and scrubbed of secrets. */
function providerReason(detail: string): string {
  return QUOTA.test(detail) ? "사용량·한도 오류" : `공급자 오류: ${clip(detail.replace(SECRET_ANYWHERE, "[가림]"), 120)}`;
}

/** The line that tells Main which model answered instead, and why the first one did not. */
function fallbackLine(opinion: Opinion): string {
  return opinion.fallback ? `우선 점검(${opinion.fallback.from})이 실패해(${opinion.fallback.why}) ${opinion.fallback.sameModel ? "같은 모델의 다른 경로" : "반대 계열"} ${opinion.model}로 한 번 대체했다.` : "";
}

const secs = (ms: number) => (ms / 1000).toFixed(1);

/** Every opinion under the model that gave it; a single participant keeps the old one-line heading. */
function opinionText(opinions: readonly Opinion[]): string {
  return opinions.map((o, i) => `${opinions.length > 1 ? `${i + 1}. ` : ""}${o.model}(${secs(o.ms)}초)${o.fallback ? `\n${fallbackLine(o)}` : ""}\n${o.text}`).join("\n\n");
}

/** A participant that gave no advice is named here; it is never counted as having reviewed the plan. */
function failureText(failures: readonly LaneFailure[]): string {
  return failures.length ? `참가하지 못한 모델: ${failures.map((f) => `${f.model ?? `modelRoles.${f.slot}`}: ${f.why}`).join("; ")}` : "";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(${text.length - max}자 생략)`;
}

/**
 * The last six user turns within `max` characters. The budget fills from the newest turn, so long earlier turns never
 * push out the latest instruction (issue #72); the kept turns stay oldest first under their numbers, and a leading line
 * counts the earlier turns left out.
 */
function recentTurns(turns: readonly string[], max: number): string {
  const recent = turns.slice(-6);
  const kept: string[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const line = `(${i + 1}) ${recent[i]}`;
    const cost = line.length + (kept.length ? 1 : 0);
    if (used + cost > max) {
      if (!kept.length) kept.push(clip(line, max));
      break;
    }
    kept.unshift(line);
    used += cost;
  }
  const dropped = recent.length - kept.length;
  return dropped > 0 ? [`…(앞선 발언 ${dropped}개 생략)`, ...kept].join("\n") : kept.join("\n");
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function messageText(message: unknown): string {
  if (!record(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (record(b) && b.type === "text" ? String(b.text ?? "") : "")).join("");
}
// The host reloads each plugin's module graph independently; keep the existing combined panel across those copies.
const PANEL_HISTORY = Symbol.for("cuelo.preflight.panel-history");
const shared = globalThis as typeof globalThis & { [PANEL_HISTORY]?: WeakMap<object, string[]> };
const panelHistory = shared[PANEL_HISTORY] ??= new WeakMap<object, string[]>();

export function createPreflightCheck(pi: ExtensionAPI, invalidate: () => void = () => {}) {
  let main = true;
  let userTurns: string[] = [];
  let panelSession: object | undefined;
  /** Provider calls a reset/session change must abort; the explicit tool passes its own caller signal instead. */
  const inflight = new Set<AbortController>();
  let lastInputText = "";
  /** Bumped by every new user message and session change: a check started before it never grants a pass or speaks. */
  let gen = 0;
  /** Bumped only by a session change: a foreground check that started in the previous session leaves no trace. */
  let session = 0;

  /** Stop both participants' provider calls: the answer is worthless once the turn or session it belonged to is gone. */
  const abortInflight = () => {
    for (const controller of inflight) controller.abort();
    inflight.clear();
  };

  const reset = () => {
    // The session is going away, so an in-flight answer is worthless: abort both participants instead of leaving
    // their provider calls running to the deadline. Steering is different (see `redirect`).
    abortInflight();
    userTurns = []; invalidate(); lastInputText = ""; gen += 1; session += 1;
    if (panelSession) panelHistory.delete(panelSession);
  };

  const note = (ctx: ExtensionContext, line: string) => {
    const stamp = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    panelSession = ctx.sessionManager;
    const history = [...(panelHistory.get(panelSession) ?? []), `[${stamp}] ${line}`].slice(-40);
    panelHistory.set(panelSession, history);
    try { ctx.ui.setWidget(WIDGET, history); } catch { /* panel optional */ }
  };

  /**
   * The existing opposite-family review role for this Main, resolved through the shared `reviewerLanes`/`SLOT`
   * mapping `cross_review` already uses: an Anthropic Main asks `crossReviewOpenAI`, and every other author,
   * including a Hive DeepSeek or Gemini Main, asks `crossReviewAnthropic`, exactly as `reviewerLanes` decides. It
   * is looked up only after the Gemini call failed. A Main whose model this session cannot identify, or a role this
   * PC cannot resolve, yields no counterpart instead of a guessed target. `ctx.models.resolve` does not check that
   * the slot's model belongs to the lane's family (a same-family slot resolves fine), so the resolved target is
   * compared with the lane here and a mismatch sends nothing, the way `cross_review` refuses a target of the wrong
   * required family.
   */
  function counterpart(ctx: ExtensionContext): { slot: string; model: string } | undefined {
    const current = ctx.models.current() ?? ctx.model;
    if (!current) return undefined;
    let slot: string | undefined;
    let lane: Lane | undefined;
    try {
      [lane] = reviewerLanes([`${current.provider}/${current.id}`], undefined);
      slot = lane ? REVIEW_SLOT[lane] : undefined;
    } catch {
      return undefined;
    }
    if (!slot || !lane) return undefined;
    try {
      const target = ctx.models.resolve(`@${slot}`);
      return target && authorFamily(`${target.provider}/${target.id}`) === lane ? { slot, model: `${target.provider}/${target.id}` } : undefined;
    } catch {
      return undefined;
    }
  }

  /** A role or exact route call, bounded by the shared deadline and the caller's cancel signal. */
  async function attempt(ctx: ExtensionContext, slot: string, prompt: string, deadline: number, signal?: AbortSignal, exact = false): Promise<Attempt> {
    let target: Model<Api> | undefined;
    try { target = ctx.models.resolve(exact ? slot : `@${slot}`); } catch { /* an unreadable role is an unresolved one */ }
    if (!target || (exact && `${target.provider}/${target.id}` !== slot)) return { ok: false, kind: "unresolved", why: `${exact ? slot : `modelRoles.${slot}`} 모델을 이 PC에서 해석하지 못했다`, ...(exact ? { model: slot } : {}) };
    const model = `${target.provider}/${target.id}`;
    // The historical `low` where the model registers it; a model that does not (Fable 5.2 starts at medium) gets its
    // lowest registered level instead, so asking it is not a guaranteed unsupported-effort error. No ladder sends none.
    const levels = target.thinking?.efforts ?? [];
    const reasoning = levels.includes("low" as never) ? "low" : levels[0];
    const budget = Math.max(1, deadline - Date.now());
    const timeout = AbortSignal.timeout(budget);
    // The call may have been cut by the caller (no second request) or by the deadline; anything else is the provider's.
    const interrupted = (): Attempt | undefined =>
      signal?.aborted ? { ok: false, kind: "cancelled", why: "점검이 취소됐다", model }
        : timeout.aborted ? { ok: false, kind: "timeout", why: `${Math.round(budget / 1000)}초 안에 답이 없었다`, model } : undefined;
    // The host rewrites runtime SDK imports for installed plugins.
    let classify: typeof isUsageLimitOutcome | undefined;
    let providerCall = false;
    try {
      const { completeSimple, isUsageLimitOutcome } = await import("@oh-my-pi/pi-ai");
      classify = isUsageLimitOutcome;
      const sessionId = crypto.randomUUID();
      const apiKey = ctx.modelRegistry.resolver(target, sessionId);
      providerCall = true;
      // Classify provider errors below before providerReason clips or scrubs their raw message.
      const response: AssistantMessage = await completeSimple(target, {
        systemPrompt: [SYSTEM],
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      }, {
        apiKey, sessionId, maxTokens: 8192,
        reasoning: reasoning as never,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const text = response.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim();
      // Secret-looking output is dropped whatever the finish reason: a cut-off or failed answer that carries one must not send the check to another provider either.
      if (SECRET.test(text)) return { ok: false, kind: "secret", why: "답에 비밀값으로 보이는 내용이 있어 쓰지 않았다", model };
      if (response.stopReason === "stop" && text) return { ok: true, text, model };
      const cut = interrupted();
      if (cut) return cut;
      if (response.stopReason === "error") return { ok: false, kind: "provider", why: providerReason(response.errorMessage ?? ""), model, usageLimit: isUsageLimitOutcome(undefined, response.errorMessage ?? "") };
      return { ok: false, kind: "unusable", why: `응답 이상(${response.stopReason === "stop" ? "빈 답" : response.stopReason}${response.errorMessage ? `: ${providerReason(response.errorMessage)}` : ""})`, model };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return interrupted() ?? { ok: false, kind: "provider", usageLimit: providerCall && !!classify?.(undefined, detail), why: providerReason(detail), model };
    }
  }

  /**
   * One configured participant. A usage limit first tries that model's configured same-model provider routes; every
   * call shares the deadline and the caller's cancel signal. It never sees the other participant's answer.
   */
  async function lane(ctx: ExtensionContext, slot: string, prompt: string, deadline: number, opts: { signal?: AbortSignal; live?: () => boolean }, tried: Set<string>): Promise<LaneResult> {
    const t0 = Date.now();
    const first = await attempt(ctx, slot, prompt, deadline, opts.signal);
    if (first.ok) return { opinion: { text: first.text, model: first.model, ms: Date.now() - t0 } };
    const failed = (why: string, operating: boolean): LaneResult => ({ failure: { slot, model: first.model, why }, operating });
    // A cancel or secret result is not an operating failure: it never fans out to another route.
    if (!OPERATING[first.kind]) return failed(first.why, false);
    let why = first.why;
    if (first.kind === "provider" && first.usageLimit && first.model) {
      const routes = await sameModelRoutes(ctx.cwd, first.model);
      for (const route of routes) {
        // A route is another provider call: it obeys the same cancel, freshness and deadline rules as the first.
        if (opts.signal?.aborted || (opts.live && !opts.live()) || deadline - Date.now() <= 0) return failed(why, true);
        if (tried.has(route)) continue;
        tried.add(route);
        const next = await attempt(ctx, route, prompt, deadline, opts.signal, true);
        if (next.ok) return { opinion: { text: next.text, model: next.model, ms: Date.now() - t0, fallback: { from: first.model, why, sameModel: true } } };
        why += `; 대체(${next.model ?? route}) 실패: ${next.why}`;
        if (!OPERATING[next.kind]) return failed(why, false);
      }
    }
    return failed(why, true);
  }

  /**
   * Asks both configured participants at once on the same prompt under one deadline, and returns their separate
   * labelled opinions plus the participants that gave none. Only when neither participant gives advice does the
   * existing opposite-family review role run once, inside the remaining deadline and never on an already-tried model.
   * Secret-looking input or output never reaches another model, and no answer is sent to another participant.
   */
  async function ask(ctx: ExtensionContext, plan: string, extra: string, timeoutMs: number, opts: { signal?: AbortSignal; live?: () => boolean } = {}): Promise<Advice> {
    const t0 = Date.now();
    const deadline = t0 + timeoutMs;
    // Screen the whole input before any clipping: a token straddling the budget boundary would otherwise lose the
    // characters the pattern needs and its visible prefix would reach both participants.
    if (SECRET.test(`${plan}\n${extra}`)) return { ok: false, why: "비밀값으로 보이는 내용이 있어 보내지 않았다", failures: [], ms: 0 };
    const user = recentTurns(userTurns, MAX_USER);
    const prompt = `# 사용자의 최근 말\n${user || "(기록 없음)"}\n\n${clip(plan, MAX_PLAN)}${extra ? `\n\n${extra}` : ""}`;
    if (SECRET.test(prompt)) return { ok: false, why: "비밀값으로 보이는 내용이 있어 보내지 않았다", failures: [], ms: 0 };
    const failed = (why: string, failures: LaneFailure[] = []): Advice => ({ ok: false, why, failures, ms: Date.now() - t0 });
    // Register both participants' models before any await, so one lane's route can never repeat the other's model.
    const tried = new Set<string>();
    for (const slot of [PRIMARY_ROLE, SECONDARY_ROLE]) {
      try {
        const target = ctx.models.resolve(`@${slot}`);
        if (target) tried.add(`${target.provider}/${target.id}`);
      } catch { /* an unresolved role is reported by its own lane */ }
    }
    const results = await Promise.all([PRIMARY_ROLE, SECONDARY_ROLE].map((slot) => lane(ctx, slot, prompt, deadline, opts, tried)));
    const opinions = results.flatMap((r) => ("opinion" in r ? [r.opinion] : []));
    const failures = results.flatMap((r) => ("failure" in r ? [r.failure] : []));
    if (opinions.length) return { ok: true, opinions, failures, ms: Date.now() - t0 };
    const why = failures.length ? failures.map((f) => `${f.model ?? f.slot}: ${f.why}`).join("; ") : "설정된 점검 참가자가 없다";
    // Neither participant gave advice. A cancel or secret stop must not send the check anywhere else.
    if (!results.every((r) => "failure" in r && r.operating)) return failed(why, failures);
    const unavailable = (): Advice | undefined => {
      if (opts.signal?.aborted) return failed(`${why}; 점검이 취소돼 대체하지 않았다`, failures);
      if (opts.live && !opts.live()) return failed(`${why}; 점검이 낡아 대체하지 않았다`, failures);
      if (deadline - Date.now() <= 0) return failed(`${why}; 남은 시간이 없어 대체하지 않았다`, failures);
    };
    const stopped = unavailable();
    if (stopped) return stopped;
    const alternate = counterpart(ctx);
    if (!alternate) return failed(`${why}; 반대 계열 교차 검토 역할을 해석하지 못해 대체하지 않았다`, failures);
    if (tried.has(alternate.model)) return failed(`${why}; 대체(${alternate.model})는 이미 시도해 다시 호출하지 않았다`, failures);
    const second = await attempt(ctx, alternate.slot, prompt, deadline, opts.signal);
    if (second.ok) {
      return {
        ok: true,
        opinions: [{ text: second.text, model: second.model, ms: Date.now() - t0, fallback: { from: failures.map((f) => f.model ?? f.slot).join(", "), why } }],
        failures,
        ms: Date.now() - t0,
      };
    }
    return failed(`${why}; 대체(${second.model ?? alternate.slot}) 실패: ${second.why}`, failures);
  }

  pi.on("session_start", (_event, ctx) => { reset(); main = ctx.agent?.kind !== "sub"; seedFromBranch(ctx); });
  pi.on("session_switch", (_event, ctx) => { reset(); main = ctx.agent?.kind !== "sub"; seedFromBranch(ctx); });
  pi.on("session_shutdown", () => reset());
  // The core runs a blocking tool_call handler inside its own timeout race and never exposes that race's signal here,
  // so a cancelled turn is observed through the settle the core does publish: an interrupt abandons the handler and
  // ends the run, and `agent_end` then aborts both participants instead of leaving them running to the deadline.
  pi.on("agent_end", () => { abortInflight(); });

  const rememberUser = (text: string) => {
    const t = text.trim();
    if (t && userTurns[userTurns.length - 1] !== t) userTurns = [...userTurns, clip(t, 2000)].slice(-12);
  };

  // After a reload or restart the hook state is empty; rebuild the recent user turns from the saved branch.
  const seedFromBranch = (ctx: ExtensionContext) => {
    try {
      for (const entry of ctx.sessionManager.getBranch() as unknown[]) {
        if (!record(entry) || !record(entry.message)) continue;
        const m = entry.message;
        if (m.role === "user" && m.synthetic !== true && m.attribution !== "agent") rememberUser(messageText(m));
      }
    } catch { /* history is best effort */ }
  };

  // CUELO delivers a message sent mid-run (steering) without an `input` event, so a user message whose text is not the
  // last `input` text is treated as steering here; the prompt's own message_start is skipped.
  const squash = (text: string) => text.replace(/\s+/g, "");
  pi.on("message_start", (event) => {
    const message = event.message as unknown as Record<string, unknown>;
    if (message?.role !== "user" || message.synthetic === true || message.attribution === "agent") return;
    const text = messageText(message).trim();
    if (lastInputText && squash(text) === lastInputText) { lastInputText = ""; return; }
    redirect(text);
  });

  pi.on("input", (event) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    const text = String(event.text ?? "").trim();
    lastInputText = squash(text);
    redirect(text);
  });

  function redirect(text: string) {
    rememberUser(text);
    invalidate();
    gen += 1;
  }

  return { ask, note, inflight, get main() { return main; }, get gen() { return gen; }, get session() { return session; } };
}

export { record, opinionText, failureText, secs };
