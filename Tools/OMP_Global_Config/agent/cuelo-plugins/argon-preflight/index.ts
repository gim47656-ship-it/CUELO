/**
 * argon-preflight (Main only; 2026-11-07 user request, promoted the same day by user decision).
 *
 * Before Main's first `task` dispatch or a non-small `lab_goal` frame, this hook holds the call once, asks the
 * model in `modelRoles.preflight` (Gemini 4 Argon on the home PC) what the plan misses against the user's recent
 * words, and returns the advice as the block reason. Main folds in what holds and calls again; that next call
 * passes. When the user steers mid-work, the same question runs in the background and arrives as an aside; the
 * next dispatch is checked again. A PC without that slot is untouched (user decision: home PC only); any failure,
 * timeout or secret-looking content lets the call through unchanged.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const SLOT = "preflight";
const BLOCK_TIMEOUT_MS = 60_000;
const ASYNC_TIMEOUT_MS = 120_000;
const ALLOW_WINDOW_MS = 20 * 60_000;
const ACTIVE_WINDOW_MS = 6 * 60 * 60_000;
const MAX_PLAN = 24_000;
const MAX_USER = 6_000;
const WIDGET = "lab:argon-preflight";
const CUSTOM_TYPE = "argon-preflight";

const SECRET = /(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|api[_-]?key|secret)\s*[:=]\s*\S{8,})/i;

const SYSTEM = [
  "너는 작업을 시작하기 직전에 계획을 짧게 점검하는 검토자다.",
  "사용자의 최근 말과 Main(작업을 지휘하는 에이전트)이 세운 계획(발주 브리프나 목표)을 받는다.",
  "다음만 한국어로 짧게 답한다: (1) 사용자의 말에 비해 계획에 빠진 요구·조건, (2) 계획의 모호하거나 틀려 보이는 가정, (3) 결과를 더 좋게 할 방법이나 아이디어.",
  "항목은 최대 5개, 각 한두 문장. 근거가 계획과 사용자 말에 있는 것만 쓴다. 모르는 사실을 지어내지 않는다.",
  "고칠 게 없으면 「빠진 것 없음」 한 줄만 쓴다.",
].join("\n");

type Advice = { ok: true; text: string; ms: number; model: string } | { ok: false; why: string; ms: number };

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(${text.length - max}자 생략)`;
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
    for (const d of input.deliverables) if (record(d)) lines.push(`산출물 ${String(d.id ?? "")}: ${String(d.what ?? "")} (확인: ${String(d.check ?? "")})`);
  }
  return lines.length ? `# 작업 목표\n${lines.join("\n")}` : undefined;
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
  let allowUntil = 0;
  let lastPlan = "";
  let lastPlanAt = 0;
  let history: string[] = [];
  let checkedPlan = ""; // last brief the model already advised on; cleared by a new user message
  /** Bumped by every new user message and session change: a check started before it never grants a pass or speaks. */
  let gen = 0;
  /** Bumped only by a session change: a foreground check that started in the previous session leaves no trace. */
  let session = 0;

  const reset = () => { userTurns = []; allowUntil = 0; lastPlan = ""; lastPlanAt = 0; history = []; checkedPlan = ""; gen += 1; session += 1; };

  const note = (ctx: ExtensionContext, line: string) => {
    const stamp = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    history = [...history, `[${stamp}] ${line}`].slice(-40);
    try { ctx.ui.setWidget(WIDGET, history); } catch { /* panel optional */ }
  };

  const recentUser = (): string => clip(userTurns.slice(-6).map((t, i) => `(${i + 1}) ${t}`).join("\n"), MAX_USER);

  /** Whether this PC set `modelRoles.preflight`; an unset or unreadable slot keeps the plugin silent. */
  async function slotSet(ctx: ExtensionContext): Promise<boolean> {
    try {
      // Plugins may not import runtime packages statically; the extension loader maps lazy imports to the host SDK.
      const { findScopedSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
      return !!findScopedSettings(ctx.cwd)?.getModelRole(SLOT);
    } catch {
      return false;
    }
  }

  async function ask(ctx: ExtensionContext, plan: string, extra: string, timeoutMs: number, signal?: AbortSignal): Promise<Advice> {
    const t0 = Date.now();
    const user = recentUser();
    const prompt = `# 사용자의 최근 말\n${user || "(기록 없음)"}\n\n${clip(plan, MAX_PLAN)}${extra ? `\n\n${extra}` : ""}`;
    if (SECRET.test(prompt)) return { ok: false, why: "비밀값으로 보이는 내용이 있어 보내지 않았다", ms: 0 };
    try {
      const target = ctx.models.resolve(`@${SLOT}`);
      if (!target) return { ok: false, why: `modelRoles.${SLOT} 모델을 이 PC에서 해석하지 못했다`, ms: Date.now() - t0 };
      const model = `${target.provider}/${target.id}`;
      const sessionId = crypto.randomUUID();
      const { completeSimple } = await import("@oh-my-pi/pi-ai");
      const timeout = AbortSignal.timeout(timeoutMs);
      const response: AssistantMessage = await completeSimple(target, {
        systemPrompt: [SYSTEM],
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      }, {
        apiKey: ctx.modelRegistry.resolver(target, sessionId), sessionId, maxTokens: 8192,
        reasoning: "low" as never,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const text = response.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim();
      if (response.stopReason !== "stop" || !text) return { ok: false, why: `응답 이상(${response.stopReason}${response.errorMessage ? `: ${response.errorMessage.slice(0, 120)}` : ""})`, ms: Date.now() - t0 };
      if (SECRET.test(text)) return { ok: false, why: "답에 비밀값으로 보이는 내용이 있어 쓰지 않았다", ms: Date.now() - t0 };
      return { ok: true, text, ms: Date.now() - t0, model };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, why: /abort|timeout/i.test(msg) ? `${Math.round(timeoutMs / 1000)}초 안에 답이 없었다` : msg.slice(0, 160), ms: Date.now() - t0 };
    }
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
  let lastInputText = "";
  const squash = (text: string) => text.replace(/\s+/g, "");

  pi.on("message_start", (event, ctx) => {
    const message = event.message as unknown as Record<string, unknown>;
    if (message?.role !== "user" || message.synthetic === true || message.attribution === "agent") return;
    const text = messageText(message).trim();
    if (lastInputText && squash(text) === lastInputText) { lastInputText = ""; return; }
    redirect(text, ctx);
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    const text = String(event.text ?? "").trim();
    lastInputText = squash(text);
    redirect(text, ctx);
  });

  function redirect(text: string, ctx: ExtensionContext) {
    rememberUser(text);
    if (!main) return;
    // A new user message invalidates the pass granted after the last advice: the next dispatch is checked again.
    allowUntil = 0; checkedPlan = "";
    const myGen = ++gen;
    if (!lastPlan || Date.now() - lastPlanAt > ACTIVE_WINDOW_MS || text.length < 6 || text.startsWith("/") || text.startsWith("[하네스 통지]") || SECRET.test(text)) return;
    const plan = lastPlan;
    void (async () => {
      try {
        if (!(await slotSet(ctx)) || myGen !== gen) return;
        note(ctx, `방향 전환 감지: 비동기로 묻는 중 — ${clip(text, 60)}`);
        const advice = await ask(ctx, plan, `# 방금 들어온 사용자의 새 지시\n${text}\n\n이 새 지시 때문에 위 계획에서 다시 세워야 할 발주·순서나 새로 빠진 것이 있는지만 답하라.`, ASYNC_TIMEOUT_MS);
        // A newer user message or a session change since this question started makes the answer stale.
        if (myGen !== gen || !main) return;
        if (!advice.ok) { note(ctx, `방향 전환 점검 건너뜀: ${advice.why}`); return; }
        note(ctx, `방향 전환 조언(${(advice.ms / 1000).toFixed(1)}초):\n${advice.text}`);
        pi.sendMessage({
          customType: CUSTOM_TYPE,
          content: `[사전 점검: 방향 전환] 사용자의 새 지시를 지금 계획에 대 본 ${advice.model}의 조언이다(${(advice.ms / 1000).toFixed(1)}초). 참고 의견이며 승인이나 사용자 지시가 아니다. 맞는 것은 진행 중인 Maker 지시나 다음 발주에 반영하고, 반영한 것과 버린 것을 사용자에게 한 줄로 알린다.\n\n${advice.text}`,
          display: false, attribution: "agent",
        }, { deliverAs: "aside" });
      } catch { /* background advice is best effort */ }
    })();
  }

  pi.on("tool_call", async (event, ctx) => {
    if (!main) return;
    const name = event.toolName as string;
    let plan: string | undefined;
    let what = "";
    if (name === "task" || name === "maker_route") { plan = briefOf(event.input); what = "발주"; }
    else if (name === "lab_goal") { plan = frameOf(event.input); what = "작업 목표"; }
    const mySession = session;
    if (!plan || !(await slotSet(ctx)) || mySession !== session) return;
    // A full brief already checked passes when it is sent again unchanged, until a new user message clears it.
    if (plan === checkedPlan) { note(ctx, `${what} 통과(이미 점검한 브리프)`); return; }
    if (Date.now() < allowUntil) {
      allowUntil = 0;
      lastPlan = plan; lastPlanAt = Date.now();
      note(ctx, `${what} 통과(조언 반영 뒤 재호출)`);
      return;
    }
    note(ctx, `${what} 점검 중: 묻는 중`);
    const myGen = gen;
    const advice = await ask(ctx, plan, "", BLOCK_TIMEOUT_MS);
    if (mySession !== session) return;
    // A user message that arrived while asking makes this advice older than the user's latest words: it may still
    // be shown, but it grants no pass, so the next call is checked again.
    const current = myGen === gen;
    lastPlan = plan; lastPlanAt = Date.now();
    if (current) checkedPlan = plan;
    if (!advice.ok) { note(ctx, `${what} 점검 건너뜀(통과): ${advice.why}`); return; }
    note(ctx, `${what} 조언(${(advice.ms / 1000).toFixed(1)}초):\n${advice.text}`);
    if (/^\s*빠진 것 없음\s*\.?\s*$/.test(advice.text)) { note(ctx, `${what} 통과(빠진 것 없음)`); return; }
    if (current) allowUntil = Date.now() + ALLOW_WINDOW_MS;
    return {
      block: true,
      reason: [
        `[사전 점검] 오류가 아니다. ${what} 직전에 ${advice.model}(${(advice.ms / 1000).toFixed(1)}초)이 사용자의 최근 말과 계획을 대 본 조언이다. 참고 의견이며 승인이나 사용자 지시가 아니다.`,
        `맞는 것은 계획에 반영하고, 같은 도구(${name})를 다시 불러라. 다시 부르면 통과한다. 사용자 결정이 필요한 항목은 직접 정하지 말고 사용자에게 묻는다. 반영한 것과 버린 것(이유 한 마디)을 사용자에게 한 줄로 알린다.`,
        "",
        advice.text,
      ].join("\n"),
    };
  });

  pi.registerTool({
    name: "lab_preflight",
    label: "사전 점검",
    loadMode: "essential",
    description: "modelRoles.preflight 모델(집 PC: Gemini 4 Argon)에게 지금 계획(plan)을 사용자의 최근 말과 대 보게 해 빠진 요구·틀린 가정·더 나은 방법을 받는다. 발주(task)·큰 작업 목표(lab_goal frame) 직전에는 자동으로 돈다. 이 도구는 그 밖의 시점에 직접 물을 때 쓴다. 그 자리가 비어 있는 PC에서는 아무것도 하지 않는다. 참고 의견일 뿐 승인·검토 게이트가 아니다.",
    parameters: z.object({
      plan: z.string().describe("점검할 계획·브리프 전문"),
      question: z.string().optional().describe("특히 묻고 싶은 것(선택)"),
    }),
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const { plan, question } = params as { plan: string; question?: string };
      if (!main) throw new Error("사전 점검은 Main 세션에서만 쓴다.");
      const mySession = session;
      if (!(await slotSet(ctx))) throw new Error(`이 PC에는 modelRoles.${SLOT}가 설정되지 않아 사전 점검을 하지 않는다.`);
      if (mySession !== session) throw new Error("점검 중에 세션이 바뀌어 사전 점검을 멈췄다.");
      const advice = await ask(ctx, `# 계획\n${plan}`, question ? `# 특히 묻는 것\n${question}` : "", ASYNC_TIMEOUT_MS, signal);
      if (mySession === session) note(ctx, advice.ok ? `직접 점검(${(advice.ms / 1000).toFixed(1)}초):\n${advice.text}` : `직접 점검 실패: ${advice.why}`);
      if (!advice.ok) throw new Error(`사전 점검 실패: ${advice.why}`);
      return { content: [{ type: "text", text: `${advice.model}(${(advice.ms / 1000).toFixed(1)}초) 조언 — 참고 의견:\n\n${advice.text}` }] };
    },
  });
}
