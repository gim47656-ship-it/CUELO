/**
 * argon-preflight (Main only; 2026-11-07 user request, promoted the same day by user decision).
 *
 * Before Main's first `task` dispatch or a non-small `lab_goal` frame, this hook holds the call once, asks a model
 * what the plan misses against the user's recent words, and returns the advice as the block reason. Main folds in
 * what holds and calls again within the same work identity; that correction passes once. New user input only
 * invalidates the remembered check. The next current plan is checked instead of asking about the previous plan.
 *
 * Who is asked (2026-11-08 user decision, restoring the Gemini-first meaning): the PC's own Gemini role
 * `modelRoles.implGemini` first, resolved locally so the AI Studio or Vertex assignment stays PC-specific. A Gemini
 * answer ends the check; the opposite-family review role is not even looked up. Only an operating failure of the
 * Gemini call (role unresolved, provider error such as a usage limit, unusable response, no answer in time) tries
 * the same existing opposite-family route `cross_review` uses (`reviewerLanes` + `SLOT`: an Anthropic Main asks
 * `crossReviewOpenAI`, every other Main asks `crossReviewAnthropic`) exactly once, inside the same deadline. A user
 * cancel, a stale session or generation, and secret-looking content never start a second request. Any failure,
 * timeout or secret-looking content lets the call through unchanged. The plugin's enable/disable state, not a
 * separate model slot, decides whether a PC runs it.
 */
import type { Api, AssistantMessage, Model, isUsageLimitOutcome } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { authorFamily, reviewerLanes, SLOT as REVIEW_SLOT, type Lane } from "../../extensions/lib/cross-review";
import { sameModelRoutes } from "../../extensions/lib/model-routes";
import { extractGuardBlock, readGuardField } from "../../extensions/command-guard/task-guard";

// The core bounds every tool_call handler (`extensionHandlers.toolCallTimeoutMs`, default 30 s) and blocks the tool
// when it runs out, so the blocking question gives up first and lets the call through (2026-11-07 live test: a 39 s
// answer turned the user's `lab_goal` into an error instead of passing). Gemini and its single counterpart share
// one deadline of this length, never one each.
const BLOCK_TIMEOUT_MS = 25_000;
const ASYNC_TIMEOUT_MS = 120_000;
/** The model asked first: the PC's own Gemini assignment (AI Studio or Vertex Argon), not a fixed provider. */
const PRIMARY_ROLE = "implGemini";
const MAX_PLAN = 24_000;
const MAX_USER = 6_000;
const WIDGET = "lab:argon-preflight";

const SECRET = /(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|api[_-]?key|secret)\s*[:=]\s*\S{8,})/i;

const SYSTEM = [
  "너는 작업을 시작하기 직전에 계획을 짧게 점검하는 검토자다.",
  "사용자의 최근 말과 Main(작업을 지휘하는 에이전트)이 세운 계획(발주 브리프나 목표)을 받는다.",
  "다음만 한국어로 짧게 답한다: (1) 사용자의 말에 비해 계획에 빠진 요구·조건, (2) 계획의 모호하거나 틀려 보이는 가정, (3) 결과를 더 좋게 할 방법이나 아이디어.",
  "항목은 최대 5개, 각 한두 문장. 근거가 계획과 사용자 말에 있는 것만 쓴다. 모르는 사실을 지어내지 않는다.",
  "고칠 게 없으면 「빠진 것 없음」 한 줄만 쓴다.",
].join("\n");

/** Why one model call produced no advice. Only the operating kinds may send the check to the counterpart. */
type Failure = "unresolved" | "provider" | "unusable" | "timeout" | "cancelled" | "secret";
const OPERATING: Partial<Record<Failure, true>> = { unresolved: true, provider: true, unusable: true, timeout: true };
type Attempt = { ok: true; text: string; model: string } | { ok: false; kind: Failure; why: string; model?: string; usageLimit?: boolean };
type Advice =
  | { ok: true; text: string; ms: number; model: string; fallback?: { from: string; why: string; sameModel?: boolean } }
  | { ok: false; why: string; ms: number };

const QUOTA = /\b429\b|quota|usage.?limit|rate.?limit|exhausted|한도/i;
const SECRET_ANYWHERE = new RegExp(SECRET.source, "gi");

/** A provider error as a short reason; a usage limit is named as such, anything else is clipped and scrubbed of secrets. */
function providerReason(detail: string): string {
  return QUOTA.test(detail) ? "사용량·한도 오류" : `공급자 오류: ${clip(detail.replace(SECRET_ANYWHERE, "[가림]"), 120)}`;
}

/** The line that tells Main which model answered instead, and why the first one did not. */
function fallbackLine(advice: Extract<Advice, { ok: true }>): string {
  return advice.fallback ? `우선 점검(${advice.fallback.from})이 실패해(${advice.fallback.why}) ${advice.fallback.sameModel ? "같은 모델의 다른 경로" : "반대 계열"} ${advice.model}로 한 번 대체했다.` : "";
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

function briefOf(input: unknown): string {
  if (!record(input)) return "";
  const parts: string[] = [];
  // Prepared references carry no brief text; maker_route already checked the full brief they restore.
  if (typeof input.context === "string" && input.context.trim() && !input.context.trim().startsWith("PREPARED_CONTEXT")) parts.push(`# 공통 맥락\n${input.context.trim()}`);
  if (Array.isArray(input.tasks)) {
    input.tasks.forEach((task, i) => {
      if (!record(task)) return;
      const name = typeof task.name === "string" ? task.name : `task ${i + 1}`;
      const body = typeof task.task === "string" ? task.task.trim() : "";
      const space = typeof task.solutionSpace === "string" ? `\n(해법 범위: ${task.solutionSpace})` : "";
      if (body && !body.startsWith("PREPARED_TASK:")) parts.push(`# 발주 ${name}${space}\n${body}`);
    });
  }
  return parts.some((p) => p.startsWith("# 발주")) ? parts.join("\n\n") : "";
}

function frameOf(input: unknown): string | undefined {
  if (!record(input) || input.op !== "frame" || input.size === "small") return undefined;
  const lines: string[] = [];
  if (typeof input.goal === "string") lines.push(`목표: ${input.goal}`);
  if (Array.isArray(input.explicit) && input.explicit.length) lines.push(`사용자 조건: ${input.explicit.join(" / ")}`);
  if (Array.isArray(input.assumptions) && input.assumptions.length) lines.push(`Main의 가정: ${input.assumptions.join(" / ")}`);
  if (Array.isArray(input.deliverables)) {
    for (const d of input.deliverables) if (record(d)) lines.push(`산출물 ${String(d.id ?? "")}: ${String(d.what ?? "")} (경로: ${String(d.path ?? "")}; 확인: ${String(d.check ?? "")})`);
  }
  return lines.length ? `# 작업 목표\n${lines.join("\n")}` : undefined;
}

/** One correction belongs to a tool and its work identity, not to every plan sent during a time window. */
function correctionIdentity(name: string, input: unknown): string | undefined {
  if (!record(input)) return undefined;
  if (name === "lab_goal") {
    if (typeof input.goal !== "string" || !input.goal.trim() || !Array.isArray(input.deliverables) || !input.deliverables.length) return undefined;
    const targets = input.deliverables.map((d) => record(d) && typeof d.id === "string" && d.id.trim() ? [d.id, d.path ?? ""] : null);
    return targets.every(Boolean) ? JSON.stringify([name, input.goal, targets]) : undefined;
  }
  if (!Array.isArray(input.tasks) || !input.tasks.length) return undefined;
  const contracts = input.tasks.map((task) => {
    if (!record(task) || typeof task.name !== "string" || !task.name.trim() || typeof task.task !== "string") return null;
    const guard = extractGuardBlock(task.task);
    if (!guard || !readGuardField(guard.block, "OWNED_PATHS")) return null;
    return [task.name, ...["WORK_CLASS", "PRIMARY_DELIVERABLE", "OWNED_PATHS", "FINDING_ID"].map((field) => readGuardField(guard.block, field) ?? "")];
  });
  return contracts.every(Boolean) ? JSON.stringify(["dispatch", contracts]) : undefined;
}

function messageText(message: unknown): string {
  if (!record(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (record(b) && b.type === "text" ? String(b.text ?? "") : "")).join("");
}

export default function argonPreflight(pi: ExtensionAPI): void {
  const z = pi.zod;
  let main = true;
  let userTurns: string[] = [];
  type Check = {
    plan: string;
    tool: string;
    checked: boolean;
    correctionTool?: string;
    pending?: Promise<{ block: true; reason: string } | undefined>;
  };
  const checks = new Map<string, Check>();
  let lastInputText = "";
  let history: string[] = [];
  /** Bumped by every new user message and session change: a check started before it never grants a pass or speaks. */
  let gen = 0;
  /** Bumped only by a session change: a foreground check that started in the previous session leaves no trace. */
  let session = 0;

  const reset = () => { userTurns = []; checks.clear(); lastInputText = ""; history = []; gen += 1; session += 1; };

  const note = (ctx: ExtensionContext, line: string) => {
    const stamp = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    history = [...history, `[${stamp}] ${line}`].slice(-40);
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
        reasoning: "low" as never,
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
   * Asks Gemini first. A provider usage limit tries configured same-model routes before the opposite-family
   * counterpart. Every further call shares the deadline and checks cancellation and freshness again.
   * Secret-looking input or output never reaches another model.
   */
  async function ask(ctx: ExtensionContext, plan: string, extra: string, timeoutMs: number, opts: { signal?: AbortSignal; live?: () => boolean } = {}): Promise<Advice> {
    const t0 = Date.now();
    const deadline = t0 + timeoutMs;
    const user = recentTurns(userTurns, MAX_USER);
    const prompt = `# 사용자의 최근 말\n${user || "(기록 없음)"}\n\n${clip(plan, MAX_PLAN)}${extra ? `\n\n${extra}` : ""}`;
    if (SECRET.test(prompt)) return { ok: false, why: "비밀값으로 보이는 내용이 있어 보내지 않았다", ms: 0 };
    const failed = (why: string): Advice => ({ ok: false, why, ms: Date.now() - t0 });
    const first = await attempt(ctx, PRIMARY_ROLE, prompt, deadline, opts.signal);
    if (first.ok) return { ok: true, text: first.text, model: first.model, ms: Date.now() - t0 };
    if (!OPERATING[first.kind]) return failed(first.why);
    let why = first.why;
    const unavailable = (): Advice | undefined => {
      if (opts.signal?.aborted) return failed(`${why}; 점검이 취소돼 대체하지 않았다`);
      if (opts.live && !opts.live()) return failed(`${why}; 점검이 낡아 대체하지 않았다`);
      if (deadline - Date.now() <= 0) return failed(`${why}; 남은 시간이 없어 대체하지 않았다`);
    };
    const routes = first.kind === "provider" && first.usageLimit && first.model ? await sameModelRoutes(ctx.cwd, first.model) : [];
    const tried = new Set(first.model ? [first.model] : []);
    for (const route of routes) {
      const stopped = unavailable();
      if (stopped) return stopped;
      if (tried.has(route)) continue;
      tried.add(route);
      const next = await attempt(ctx, route, prompt, deadline, opts.signal, true);
      if (next.ok) return { ok: true, text: next.text, model: next.model, ms: Date.now() - t0, fallback: { from: first.model!, why, sameModel: true } };
      why += `; 대체(${next.model ?? route}) 실패: ${next.why}`;
      if (!OPERATING[next.kind]) return failed(why);
    }
    const stopped = unavailable();
    if (stopped) return stopped;
    const alternate = counterpart(ctx);
    if (!alternate) return failed(`${why}; 반대 계열 교차 검토 역할을 해석하지 못해 대체하지 않았다`);
    if (routes.length && tried.has(alternate.model)) return failed(`${why}; 대체(${alternate.model})는 이미 시도해 다시 호출하지 않았다`);
    const second = await attempt(ctx, alternate.slot, prompt, deadline, opts.signal);
    if (second.ok) return { ok: true, text: second.text, model: second.model, ms: Date.now() - t0, fallback: { from: first.model ?? `modelRoles.${PRIMARY_ROLE}`, why } };
    return failed(`${why}; 대체(${second.model ?? alternate.slot}) 실패: ${second.why}`);
  }

  pi.on("session_start", (_event, ctx) => { reset(); main = ctx.agent?.kind !== "sub"; seedFromBranch(ctx); });
  pi.on("session_switch", (_event, ctx) => { reset(); main = ctx.agent?.kind !== "sub"; seedFromBranch(ctx); });
  pi.on("session_shutdown", () => reset());

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
    checks.clear();
    gen += 1;
  }

  pi.on("tool_call", async (event, ctx) => {
    if (!main) return;
    const name = event.toolName as string;
    const input: unknown = event.input;
    let plan: string | undefined;
    let what = "";
    if (name === "task" || name === "maker_route") { plan = briefOf(input); what = "발주"; }
    else if (name === "lab_goal") { plan = frameOf(input); what = "작업 목표"; }
    const mySession = session;
    if (!plan) {
      if (name === "lab_goal" && record(input) && input.op === "frame") {
        for (const [key, check] of checks) if (check.tool === "lab_goal") checks.delete(key);
      }
      return;
    }
    const identity = correctionIdentity(name, input);
    const key = identity ?? JSON.stringify([name === "lab_goal" ? "lab_goal" : "dispatch", plan]);
    const previous = checks.get(key);
    if (previous?.checked && previous.plan === plan) {
      previous.correctionTool = undefined;
      note(ctx, `${what} 통과(이미 점검한 계획)`);
      return;
    }
    if (identity && previous?.correctionTool === name) {
      checks.set(key, { plan, tool: name, checked: true });
      note(ctx, `${what} 통과(같은 작업의 조언 반영 뒤 재호출)`);
      return;
    }
    if (previous?.plan === plan && previous.pending) return previous.pending;
    const check: Check = { plan, tool: name, checked: false };
    checks.set(key, check);
    const myGen = gen;
    const current = () => mySession === session && myGen === gen && checks.get(key) === check;
    note(ctx, `${what} 점검 중: 묻는 중`);
    check.pending = (async (): Promise<{ block: true; reason: string } | undefined> => {
      const advice = await ask(ctx, plan, "", BLOCK_TIMEOUT_MS, { live: current });
      if (mySession !== session) return;
      if (!current()) {
        // Keep fail-open for a failed check, but never execute a successfully checked plan superseded by steering.
        if (!advice.ok) return;
        return { block: true, reason: "[사전 점검] 점검 중 사용자 지시나 같은 작업의 계획이 바뀌었다. 최신 지시에 맞는 현재 계획으로 다시 호출하라. 이전 답으로 재호출을 허용하지 않는다." };
      }
      check.checked = true;
      if (!advice.ok) { note(ctx, `${what} 점검 건너뜀(통과): ${advice.why}`); return; }
      note(ctx, `${what} 조언(${(advice.ms / 1000).toFixed(1)}초, ${advice.model}):\n${advice.text}`);
      if (/^\s*빠진 것 없음\s*\.?\s*$/.test(advice.text)) { note(ctx, `${what} 통과(빠진 것 없음)`); return; }
      if (identity) check.correctionTool = name;
      return {
        block: true,
        reason: [
          `[사전 점검] 오류가 아니다. ${what} 직전에 ${advice.model}(${(advice.ms / 1000).toFixed(1)}초)이 사용자의 최근 말과 계획을 대 본 조언이다. 참고 의견이며 승인이나 사용자 지시가 아니다.`,
          ...(advice.fallback ? [fallbackLine(advice)] : []),
          identity
            ? `맞는 것은 계획에 반영하고, 같은 도구(${name})를 다시 불러라. 같은 목표와 작업 범위의 수정 재호출은 한 번 통과하며, 범위가 바뀌면 다시 점검한다.`
            : `작업 식별 정보가 부족해 수정 재호출 허용을 묶을 수 없다. 내용을 바꾸면 새 계획으로 점검하고, 같은 내용을 그대로 다시 보내면 통과한다.`,
          "사용자 결정이 필요한 항목은 직접 정하지 말고 사용자에게 묻는다. 반영한 것과 버린 것(이유 한 마디)을 사용자에게 한 줄로 알린다.",
          "",
          advice.text,
        ].join("\n"),
      };
    })();
    try {
      return await check.pending;
    } finally {
      check.pending = undefined;
    }
  });

  pi.registerTool({
    name: "lab_preflight",
    label: "사전 점검",
    loadMode: "essential",
    description: "지금 계획(plan)을 사용자의 최근 말과 대 보게 해 빠진 요구·틀린 가정·더 나은 방법을 받는다. 먼저 이 PC의 Gemini 역할(modelRoles.implGemini)에 묻는다. 공급자 사용량이나 속도 한도 오류이면 설정된 같은 모델의 다른 공급자 경로를 먼저 시도하고, 답을 받지 못하면 이 세션 Main의 반대 계열 기존 교차 검토 역할에 한 번 대신 묻는다(Anthropic Main이면 crossReviewOpenAI, 그 밖의 Main이면 crossReviewAnthropic). 해석 실패나 그 밖의 공급자 오류, 응답 이상은 다른 경로를 거치지 않고 반대 계열로 대체한다. 결과에 실제로 답한 모델과 대체 이유가 적힌다. 발주(task)와 큰 작업 목표(lab_goal frame) 직전에는 자동으로 돈다. 이 도구는 그 밖의 시점에 직접 물을 때 쓴다. 비밀값이 의심되거나 취소됐거나 세션이 바뀌면 대체 호출도 하지 않는다. 참고 의견일 뿐 승인이나 검토 게이트가 아니다.",
    parameters: z.object({
      plan: z.string().describe("점검할 계획·브리프 전문"),
      question: z.string().optional().describe("특히 묻고 싶은 것(선택)"),
    }),
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const { plan, question } = params as { plan: string; question?: string };
      if (!main) throw new Error("사전 점검은 Main 세션에서만 쓴다.");
      const mySession = session;
      const myGen = gen;
      const advice = await ask(ctx, `# 계획\n${plan}`, question ? `# 특히 묻는 것\n${question}` : "", ASYNC_TIMEOUT_MS, { signal, live: () => mySession === session && myGen === gen });
      if (mySession === session) note(ctx, advice.ok ? `직접 점검(${(advice.ms / 1000).toFixed(1)}초, ${advice.model}):\n${advice.text}` : `직접 점검 실패: ${advice.why}`);
      if (!advice.ok) throw new Error(`사전 점검 실패: ${advice.why}`);
      return { content: [{ type: "text", text: `${advice.model}(${(advice.ms / 1000).toFixed(1)}초) 조언 — 참고 의견:${advice.fallback ? `\n${fallbackLine(advice)}` : ""}\n\n${advice.text}` }] };
    },
  });
}
