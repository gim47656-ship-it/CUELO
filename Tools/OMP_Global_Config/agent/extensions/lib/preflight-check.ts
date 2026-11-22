// Model calls and session context shared by the explicit check and automatic routing plugins.
import type { Api, AssistantMessage, Model, isUsageLimitOutcome } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { helperAttemptRecorder } from "./helper-usage";
import { beforeModelAbort, sameModelRoutes } from "./model-routes";
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

type Attempt = { ok: true; text: string; model: string } | { ok: false; why: string; model?: string; usageLimit?: boolean };
type Opinion = { text: string; model: string; ms: number; fallback?: { from: string; why: string }; partial?: boolean };
type Advice = { ok: true; opinion: Opinion } | { ok: false; why: string };

const SECRET_ANYWHERE = new RegExp(SECRET.source, "gi");

/** A provider error as a short reason; a usage limit is named as such, anything else is clipped and scrubbed of secrets. */
function providerReason(detail: string, limit = false): string {
  return limit ? "사용량 한도 오류" : `공급자 오류: ${clip(detail.replace(SECRET_ANYWHERE, "[가림]"), 120)}`;
}

/** The line that tells Main which model answered instead, and why the first one did not. */
function fallbackLine(opinion: Opinion): string {
  return opinion.fallback ? `우선 점검(${opinion.fallback.from})이 실패해(${opinion.fallback.why}) 같은 모델의 다른 경로 ${opinion.model}로 한 번 대체했다.` : "";
}

const secs = (ms: number) => (ms / 1000).toFixed(1);

/** Label the advice with the model that actually answered. */
function opinionText(opinion: Opinion): string {
  const partial = opinion.partial ? "\n부분 점검: 입력 일부가 생략돼 전체를 보지 않고 낸 의견이다." : "";
  return `${opinion.model}(${secs(opinion.ms)}초)${opinion.fallback ? `\n${fallbackLine(opinion)}` : ""}${partial}\n${opinion.text}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(${text.length - max}자 생략)`;
}

/** Keep the head and the end of a long text, cutting the middle, so a closing instruction survives the budget. */
function clipEnds(text: string, max: number): string {
  if (text.length <= max) return text;
  const sized = (omitted: number) => `\n…(${omitted}자 생략)…\n`;
  // The longest marker (digits of the full length) fixes the room, so the result never exceeds max.
  const room = Math.max(0, max - sized(text.length).length);
  const marker = sized(text.length - room);
  const head = Math.floor(room / 4);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (room - head))}`;
}

type UserTurn = { text: string; cut: boolean; secret: boolean };

/**
 * The last six user turns within `max` characters. The budget fills from the newest turn, so long earlier turns never
 * push out the latest instruction (issue #72); the kept turns stay oldest first under their numbers, and a leading line
 * counts the earlier turns left out.
 */
function recentTurns(turns: readonly UserTurn[], max: number): { text: string; partial: boolean } {
  const recent = turns.slice(-6);
  const kept: string[] = [];
  let used = 0;
  let partial = false;
  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i]!;
    // Only the newest turn is kept whole; an earlier turn may be clipped to its head.
    const body = i === recent.length - 1 ? turn.text : clip(turn.text, 2000);
    const line = `(${i + 1}) ${body}`;
    const cost = line.length + (kept.length ? 1 : 0);
    if (used + cost > max) {
      if (!kept.length) { kept.push(clipEnds(line, max)); partial = true; }
      break;
    }
    kept.unshift(line);
    used += cost;
    if (turn.cut || (i !== recent.length - 1 && turn.text.length > 2000)) partial = true;
  }
  const dropped = recent.length - kept.length;
  if (dropped > 0) partial = true;
  return { text: dropped > 0 ? [`…(앞선 발언 ${dropped}개 생략)`, ...kept].join("\n") : kept.join("\n"), partial };
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
  let userTurns: UserTurn[] = [];
  let panelSession: object | undefined;
  /** Provider calls to abort when their session or turn ends. */
  const inflight = new Set<AbortController>();
  let lastInputText = "";
  /** Bumped by every new user message and session change: a check started before it never grants a pass or speaks. */
  let gen = 0;
  /** Bumped only by a session change: a foreground check that started in the previous session leaves no trace. */
  let session = 0;

  /** Abort provider work when its turn or session ends. */
  const abortInflight = () => {
    for (const controller of inflight) controller.abort();
    inflight.clear();
  };

  const reset = () => {
    // Session changes abort in-flight work. Steering is handled separately by redirect.
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

  /** A role or exact route call, bounded by the shared deadline and the caller's cancel signal. */
  async function attempt(ctx: ExtensionContext, selector: string, prompt: string, deadline: number, signal?: AbortSignal, exact = false): Promise<Attempt> {
    if (signal?.aborted) return { ok: false, why: "점검이 취소됐다" };
    if (Date.now() >= deadline) return { ok: false, why: "점검 시간이 끝났다" };
    let target: Model<Api> | undefined;
    try { target = ctx.models.resolve(exact ? selector : `@${selector}`); } catch { /* report an unresolved role below */ }
    if (!target || (exact && `${target.provider}/${target.id}` !== selector)) return { ok: false, why: `${exact ? selector : `modelRoles.${selector}`} 모델을 이 PC에서 해석하지 못했다`, ...(exact ? { model: selector } : {}) };
    const model = `${target.provider}/${target.id}`;
    const usage = helperAttemptRecorder(ctx, { purpose: "preflight", role: exact ? undefined : selector, model: target, scrub: (message) => message.replace(SECRET_ANYWHERE, "[가림]") });
    if (!exact && (selector === "preflightOpenAI"
      ? target.provider !== "openai-codex" && target.provider !== "openai"
      : target.provider !== "anthropic")) {
      return { ok: false, why: `modelRoles.${selector}에 다른 계열 모델이 지정돼 점검하지 않았다`, model };
    }
    // The historical `low` where the model registers it; a model that does not (Fable 5.2 starts at medium) gets its
    // lowest registered level instead, so asking it is not a guaranteed unsupported-effort error. No ladder sends none.
    const levels = target.thinking?.efforts ?? [];
    const reasoning = levels.includes("low" as never) ? "low" : levels[0];
    const budget = Math.max(1, deadline - Date.now());
    const timeout = AbortSignal.timeout(budget);
    // The call may have been cut by the caller (no second request) or by the deadline; anything else is the provider's.
    const interrupted = (): Attempt | undefined =>
      signal?.aborted ? { ok: false, why: "점검이 취소됐다", model }
        : timeout.aborted ? { ok: false, why: `${Math.round(budget / 1000)}초 안에 답이 없었다`, model } : undefined;
    // The host rewrites runtime SDK imports for installed plugins.
    let classify: typeof isUsageLimitOutcome | undefined;
    let providerCall = false;
    try {
      const { completeSimple, isUsageLimitOutcome } = await import("@oh-my-pi/pi-ai");
      classify = isUsageLimitOutcome;
      const sessionId = crypto.randomUUID();
      const apiKey = ctx.modelRegistry.resolver(target, sessionId);
      providerCall = true;
      const callSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      // Classify provider errors below before providerReason clips or scrubs their raw message.
      const complete = () => completeSimple(target!, {
        systemPrompt: [SYSTEM],
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      }, {
        apiKey, sessionId, maxTokens: 8192,
        reasoning: reasoning as never,
        signal: callSignal,
        // Every completed attempt (including core-internal retries) is billed, so each one lands in the model_usage ledger.
        onAttempt: usage.onAttempt,
      });
      const response: AssistantMessage = await beforeModelAbort(callSignal, complete);
      usage.assertSaved();
      const text = response.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim();
      // Do not retry an answer containing a secret, even when it stopped with an error.
      if (SECRET.test(text)) return { ok: false, why: "답에 비밀값으로 보이는 내용이 있어 쓰지 않았다", model };
      const cut = interrupted();
      if (cut) return cut;
      if (response.stopReason === "stop" && text) return { ok: true, text, model };
      if (response.stopReason === "error") {
        const usageLimit = isUsageLimitOutcome(response.errorStatus, response.errorMessage);
        return { ok: false, why: providerReason(response.errorMessage ?? "", usageLimit), model, usageLimit };
      }
      return { ok: false, why: `응답 이상(${response.stopReason === "stop" ? "빈 답" : response.stopReason}${response.errorMessage ? `: ${providerReason(response.errorMessage)}` : ""})`, model };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const cut = interrupted();
      if (cut) return cut;
      const usageLimit = providerCall && !!classify?.(undefined, detail);
      return { ok: false, usageLimit, why: providerReason(detail, usageLimit), model };
    }
  }

  /** Ask one model; only usage limits permit retrying the same model on configured other routes. */
  async function ask(ctx: ExtensionContext, plan: string, extra: string, timeoutMs: number, opts: { signal?: AbortSignal; live?: () => boolean } = {}): Promise<Advice> {
    const t0 = Date.now();
    const deadline = t0 + timeoutMs;
    // Screen the whole input before clipping so a secret split by the budget is not sent.
    if (SECRET.test(`${plan}\n${extra}`) || userTurns.slice(-6).some((turn) => turn.secret)) return { ok: false, why: "비밀값으로 보이는 내용이 있어 보내지 않았다" };
    const recent = recentTurns(userTurns, MAX_USER);
    const user = recent.text;
    const partial = recent.partial || plan.length > MAX_PLAN;
    const prompt = `${partial ? "[부분 입력: 아래 내용 일부가 생략 부호(…)로 잘려 있다. 보지 못한 부분이 있으니 전체를 점검한 것처럼 말하지 말고 부분 점검임을 밝혀라.]\n\n" : ""}# 사용자의 최근 말\n${user || "(기록 없음)"}\n\n${clip(plan, MAX_PLAN)}${extra ? `\n\n${extra}` : ""}`;
    if (SECRET.test(prompt)) return { ok: false, why: "비밀값으로 보이는 내용이 있어 보내지 않았다" };
    const provider = (ctx.models.current() ?? ctx.model)?.provider;
    const slot = provider === "anthropic" ? "preflightOpenAI" : "preflightAnthropic";
    const first = await attempt(ctx, slot, prompt, deadline, opts.signal);
    const success = (answer: Extract<Attempt, { ok: true }>, fallback?: Opinion["fallback"]): Advice => ({
      ok: true, opinion: { text: answer.text, model: answer.model, ms: Date.now() - t0, ...(fallback ? { fallback } : {}), ...(partial ? { partial } : {}) },
    });
    if (first.ok) return success(first);
    let why = first.why;
    if (first.usageLimit && first.model) {
      const routes = await sameModelRoutes(ctx.cwd, first.model);
      for (const route of routes) {
        if (opts.signal?.aborted || (opts.live && !opts.live()) || Date.now() >= deadline) break;
        const next = await attempt(ctx, route, prompt, deadline, opts.signal, true);
        if (next.ok) return success(next, { from: first.model, why });
        why += `; 대체(${next.model ?? route}) 실패: ${next.why}`;
        if (!next.usageLimit) break;
      }
    }
    return { ok: false, why: `${first.model ?? slot}: ${why}` };
  }

  pi.on("session_start", (_event, ctx) => { reset(); main = ctx.agent?.kind !== "sub"; seedFromBranch(ctx); });
  pi.on("session_switch", (_event, ctx) => { reset(); main = ctx.agent?.kind !== "sub"; seedFromBranch(ctx); });
  pi.on("session_shutdown", () => reset());
  // The core runs a blocking tool_call handler inside its own timeout race and never exposes that race's signal here,
  // so a cancelled turn is observed through the settle the core does publish: an interrupt abandons the handler and
  // ends the run, and `agent_end` then aborts provider work instead of leaving it running to the deadline.
  pi.on("agent_end", () => { abortInflight(); });

  const rememberUser = (text: string) => {
    const t = text.trim();
    // The latest request keeps its head and its end (a closing constraint often sits last); only an oversized one is cut.
    const kept = clipEnds(t, MAX_USER - 8); // room for the "(n) " number the line gets
    // The secret screen reads the whole request: clipping can drop a key's header while its body survives.
    const secret = SECRET.test(t);
    const last = userTurns[userTurns.length - 1];
    if (t && (last?.text !== kept || last.secret !== secret)) userTurns = [...userTurns, { text: kept, cut: kept !== t, secret }].slice(-12);
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

export { record, opinionText, secs };
