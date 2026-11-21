import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPreflightCheck, record, opinionText, secs } from "../../extensions/lib/preflight-check";
import { createQuietDelivery } from "../../extensions/lib/quiet-delivery";
import { preparedPlanIdentity, resolvePreparedTaskInput } from "../../extensions/lib/prepared-task";
import { isPhoneOperatorCall, taskGuardLockOf } from "../../extensions/command-guard/task-guard";

const CLEAN = /^\s*빠진 것 없음\s*\.?\s*$/;

// Stay aligned with lib/plugin-lab.ts: absent state enables plugins; unreadable or malformed state disables them.
function checkEnabled(agentDir: string): boolean {
  try {
    const state: unknown = JSON.parse(readFileSync(join(agentDir, "plugin-lab", "state.json"), "utf8"));
    return record(state) && Array.isArray(state.disabled) && !state.disabled.includes("argon-preflight");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

const BLOCK_TIMEOUT_MS = 25_000;

type Verdict = { block: true; reason: string; stale?: true };

/** A dispatch correction may be resent through either dispatch tool; a goal correction only through lab_goal. */
const DISPATCH = "dispatch";

type Check = {
  plan: string;
  tool: string;
  checked: boolean;
  correctionTool?: string;
  pending?: Promise<Verdict | undefined>;
  /** Steering generation the check started in; a goal frame never reuses a check from an older one. */
  gen?: number;
  advice?: string;
  delivered?: boolean;
};

function briefOf(input: unknown): string {
  if (!record(input)) return "";
  const parts: string[] = [];
  // Prepared references carry no brief text; maker_route already checked the full brief they restore.
  if (typeof input.context === "string" && input.context.trim() && !input.context.trim().startsWith("PREPARED_CONTEXT")) parts.push(`# 공통 맥락\n${input.context.trim()}`);
  const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
  tasks.forEach((task, i) => {
    if (!record(task) || isPhoneOperatorCall(task, input)) return;
    const name = typeof task.name === "string" ? task.name : `task ${i + 1}`;
    const body = typeof task.task === "string" ? task.task.trim() : "";
    const space = typeof task.solutionSpace === "string" ? `\n(해법 범위: ${task.solutionSpace})` : "";
    if (body && !body.startsWith("PREPARED_TASK:")) parts.push(`# 발주 ${name}${space}\n${body}`);
  });
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

/**
 * One correction belongs to a tool and its work identity, not to every plan sent during a time window. A frame's
 * identity is its deliverable ids and paths, not the goal sentence: advice usually rewrites that sentence, and keying
 * on it made every folded-in correction look like new work and ask again (2026-11-11 user decision).
 */
function correctionIdentity(name: string, input: unknown, sessionId: string): string | undefined {
  if (!record(input)) return undefined;
  if (name === "lab_goal") {
    if (typeof input.goal !== "string" || !input.goal.trim() || !Array.isArray(input.deliverables) || !input.deliverables.length) return undefined;
    const targets = input.deliverables.map((d) => record(d) && typeof d.id === "string" && d.id.trim() ? [d.id, d.path ?? ""] : null);
    return targets.every(Boolean) ? JSON.stringify([name, targets]) : undefined;
  }
  const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
  if (!tasks.length) return undefined;
  let lock = taskGuardLockOf(sessionId);
  const contracts = tasks.map((task) => {
    if (!record(task) || typeof task.name !== "string" || !task.name.trim() || typeof task.task !== "string") return null;
    const identity = preparedPlanIdentity(task.task, task.name, sessionId, lock);
    if (identity) lock ??= JSON.parse(identity)[1];
    return identity ?? null;
  });
  return contracts.every(Boolean) ? JSON.stringify(["dispatch", contracts]) : undefined;
}
export default async function preflightRouting(pi: ExtensionAPI): Promise<void> {
  // Installed plugins resolve host SDK packages through the loader's lazy-import bridge.
  const { getAgentDir } = await import("@oh-my-pi/pi-utils");
  const checks = new Map<string, Check>();
  /** Advice for a maker_route call that ran unheld, keyed by its tool call id until its result arrives. */
  const advised = new Map<string, { reason: string; check: Check; identities: string[]; gen: number }>();
  const delivered = new Set<string>();
  const reused = new Set<string>();
  const state = createPreflightCheck(pi, () => { checks.clear(); advised.clear(); delivered.clear(); reused.clear(); });
  const { ask, note, inflight } = state;
  // 조언은 wait를 끊거나 끝난 턴을 다시 열지 않고 다음 모델 호출 전에 닿는다(2026-11-16, lib/quiet-delivery).
  const quiet = createQuietDelivery(pi);

  pi.on("tool_call", async (event, ctx) => {
    if (!state.main) return;
    const name = event.toolName as string;
    let input: unknown = event.input;
    const sessionId = ctx.sessionManager.getSessionId?.() ?? "";
    if (name === "task" && record(input)) {
      try { input = resolvePreparedTaskInput(input, sessionId); }
      catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
    }
    let plan: string | undefined;
    let what = "";
    if (name === "task" || name === "maker_route") { plan = briefOf(input); what = "발주"; }
    else if (name === "lab_goal") { plan = frameOf(input); what = "작업 목표"; }
    const mySession = state.session;
    if (!plan) {
      if (name === "lab_goal" && record(input) && input.op === "frame") {
        for (const [key, check] of checks) if (check.tool === "lab_goal") checks.delete(key);
      }
      return;
    }
    const myGen = state.gen;
    // Do not yield before registering the check: steering must stale the plan, never let it slip through.
    if (!checkEnabled(getAgentDir())) {
      checks.clear();
      return;
    }
    const identity = correctionIdentity(name, input, sessionId);
    const identities = identity && name !== "lab_goal" ? JSON.parse(identity)[1] as string[] : [];
    if (name === "task" && identities.length && identities.every((key) => delivered.has(key))) {
      reused.add(event.toolCallId);
      note(ctx, "발주 통과(maker_route 결과로 이미 전달한 같은 준비 계획의 조언)");
      return;
    }
    const key = identity ?? JSON.stringify([name === "lab_goal" ? "lab_goal" : "dispatch", plan]);
    const previous = checks.get(key);
    if (previous?.tool === "maker_route" && previous.advice && !previous.delivered) {
      if (name === "task") return { block: true, reason: `${previous.advice}\nmaker_route 결과가 아직 전달되지 않았습니다. 같은 이름과 TASK_GUARD 계약으로 maker_route를 다시 호출해 결과의 조언을 받은 뒤 task를 발주하세요.` };
      advised.set(event.toolCallId, { reason: previous.advice, check: previous, identities, gen: myGen });
      return;
    }
    if (previous?.checked && previous.plan === plan) {
      previous.correctionTool = undefined;
      note(ctx, `${what} 통과(이미 점검한 계획)`);
      return;
    }
    const correctionScope = name === "lab_goal" ? name : DISPATCH;
    if (identity && previous?.correctionTool === correctionScope) {
      checks.set(key, { plan, tool: name, checked: true });
      note(ctx, `${what} 통과(같은 작업의 조언 반영 뒤 재호출)`);
      return;
    }
    // 2026-11-12 user decision: a goal frame is never held. Its check runs behind the call and the advice arrives as an
    // aside; dispatches stay held because a wrong dispatch costs a whole Maker run.
    const background = name === "lab_goal";
    // 2026-11-17 user decision (「둘 다 고치기」): maker_route only prepares, the Maker starts at task. Holding it made Main
    // resend the whole brief (45 of 101 maker_route calls in 7 days), so its check still runs before it executes but the
    // advice rides on its result instead of refusing it. The Maker still never starts before the advice is read.
    const advisory = name === "maker_route";
    // A goal frame resent after steering starts a fresh check instead of sharing one the steering already made stale.
    if (previous?.plan === plan && previous.pending && (!background || previous.gen === state.gen)) {
      if (background) return;
      const verdict = await previous.pending;
      if (advisory && !verdict?.stale && previous.advice) {
        advised.set(event.toolCallId, { reason: verdict?.reason ?? previous.advice, check: previous, identities, gen: myGen });
        return;
      }
      return verdict;
    }
    const check: Check = { plan, tool: name, checked: false, gen: myGen };
    // Only one goal is current: a new frame retires every other frame's check, so its late advice is dropped.
    if (background) for (const [other, entry] of checks) if (entry.tool === "lab_goal" && other !== key) checks.delete(other);
    checks.set(key, check);
    const current = () => mySession === state.session && myGen === state.gen && checks.get(key) === check;
    note(ctx, `${what} 점검 중: 묻는 중`);
    // The session change aborts this call (reset); steering deliberately does not, so a successful answer that was
    // already in flight still holds without licensing a retry.
    const abort = new AbortController();
    inflight.add(abort);
    check.pending = (async (): Promise<Verdict | undefined> => {
      const advice = await ask(ctx, plan, "", BLOCK_TIMEOUT_MS, { signal: abort.signal, live: current });
      if (mySession !== state.session) return;
      if (!current()) {
        // Keep fail-open for a failed check, but never execute a successfully checked plan superseded by steering.
        if (!advice.ok) return;
        return { block: true, stale: true, reason: "[사전 점검] 점검 중 사용자 지시나 같은 작업의 계획이 바뀌었다. 최신 지시에 맞는 현재 계획으로 다시 호출하라. 이전 답으로 재호출을 허용하지 않는다." };
      }
      check.checked = true;
      if (!advice.ok) { note(ctx, `${what} 점검 건너뜀(통과): ${advice.why}`); return; }
      const { opinion } = advice;
      const summary = opinionText(opinion);
      note(ctx, `${what} 조언:\n${summary}`);
      check.advice = `[사전 점검] ${summary}`;
      if (CLEAN.test(opinion.text)) { note(ctx, `${what} 통과(빠진 것 없음)`); return; }
      if (identity) check.correctionTool = correctionScope;
      return {
        block: true,
        reason: [
          background
            ? `[사전 점검] 오류가 아니다. 작업 목표는 이미 등록됐고 도구는 막지 않았다. ${opinion.model}(${secs(opinion.ms)}초)가 사용자의 최근 말과 그 목표를 대 본 조언이다. 참고 의견이며 승인이나 사용자 지시가 아니다.`
            : advisory
              ? `[사전 점검] maker_route는 막지 않았다. ${opinion.model}(${secs(opinion.ms)}초)가 사용자의 최근 말과 발주 계획을 대 본 조언이다. 참고 의견이며 승인이나 사용자 지시가 아니다.`
              : `[사전 점검] 오류가 아니다. ${what} 직전에 ${opinion.model}(${secs(opinion.ms)}초)가 사용자의 최근 말과 계획을 대 본 조언이다. 참고 의견이며 승인이나 사용자 지시가 아니다.`,
          background
            ? identity
              ? "맞는 것이 있으면 같은 산출물 id와 경로로 lab_goal frame을 다시 불러 반영하라. 그 재호출은 한 번 점검 없이 통과하고, 산출물이 바뀌면 다시 점검한다. 반영할 것이 없으면 그대로 진행한다."
              : "맞는 것이 있으면 lab_goal frame을 다시 불러 반영하라. 내용을 바꾸면 새 목표로 다시 점검한다. 반영할 것이 없으면 그대로 진행한다."
            : advisory
              ? identity
                ? "맞는 것은 task 발주에 반영하라: `PREPARED_TASK: <preparedId>` 다음 줄에 덧붙이거나 고친 발주문 전체를 보낸다. maker_route는 다시 부르지 않는다. 같은 작업 이름과 범위의 수정 발주는 한 번 통과하며, TASK_GUARD 범위가 바뀌면 다시 점검한다. 반영할 것이 없으면 준비 참조로 그대로 발주한다."
                : "작업 식별 정보가 부족해 수정 발주 허용을 묶을 수 없다. task에서 내용을 바꾸면 새 계획으로 점검하고, 준비 참조나 같은 내용으로 발주하면 통과한다."
              : identity
                ? `맞는 것은 계획에 반영하고, 같은 도구(${name})를 다시 불러라. 같은 작업 이름과 범위의 수정 재호출은 한 번 통과하며, 범위가 바뀌면 다시 점검한다.`
                : `작업 식별 정보가 부족해 수정 재호출 허용을 묶을 수 없다. 내용을 바꾸면 새 계획으로 점검하고, 같은 내용을 그대로 다시 보내면 통과한다.`,
          "사용자 결정이 필요한 항목은 직접 정하지 말고 사용자에게 묻는다. 반영한 것과 버린 것(이유 한 마디)을 사용자에게 한 줄로 알린다.",
          "",
          summary,
        ].join("\n"),
      };
    })();
    const settle = () => {
      check.pending = undefined;
      inflight.delete(abort);
    };
    if (background) {
      // A stale or superseded answer is dropped (the frame already ran, and the next frame is checked on its own). The
      // check is advisory, so a delivery failure is noted in the panel instead of escaping as an unhandled rejection.
      void check.pending.then((verdict) => {
        if (!verdict) return;
        if (verdict.stale || !current()) { note(ctx, `${what} 조언 버림(점검 중 지시나 목표가 바뀜)`); return; }
        quiet({ customType: "preflight-advice", content: verdict.reason, display: false, attribution: "agent" }, ctx);
      }).catch((error: unknown) => note(ctx, `${what} 조언 전달 실패: ${error instanceof Error ? error.message : String(error)}`)).finally(settle);
      return;
    }
    try {
      const verdict = await check.pending;
      if (!verdict) {
        if (advisory && check.advice) advised.set(event.toolCallId, { reason: check.advice, check, identities, gen: myGen });
        return;
      }
      // A stale answer still refuses: steering changed the work, so the prepared plan must not run on old advice.
      if (advisory && !verdict.stale) {
        check.advice = verdict.reason;
        advised.set(event.toolCallId, { reason: verdict.reason, check, identities, gen: myGen });
        return;
      }
      return { block: verdict.block, reason: verdict.reason };
    } finally {
      settle();
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "task" && reused.delete(event.toolCallId)) {
      return { content: [...event.content, { type: "text", text: "[사전 점검] 같은 준비 계획의 조언을 maker_route 결과로 이미 전달해 중복 점검 없이 발주했습니다." }] };
    }
    const advice = advised.get(event.toolCallId);
    if (advice === undefined) return;
    advised.delete(event.toolCallId);
    if (advice.gen !== state.gen || event.toolName !== "maker_route") return;
    advice.check.delivered = true;
    for (const identity of advice.identities) delivered.add(identity);
    return { content: [...event.content, { type: "text", text: advice.reason }] };
  });
}
