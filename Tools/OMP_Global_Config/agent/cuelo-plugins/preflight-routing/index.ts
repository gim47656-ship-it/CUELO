import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPreflightCheck, record, opinionText, failureText, secs } from "../../extensions/lib/preflight-check";
import { extractGuardBlock, readGuardField } from "../../extensions/command-guard/task-guard";

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

type Check = {
  plan: string;
  tool: string;
  checked: boolean;
  correctionTool?: string;
  pending?: Promise<{ block: true; reason: string } | undefined>;
};

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

/**
 * One correction belongs to a tool and its work identity, not to every plan sent during a time window. A frame's
 * identity is its deliverable ids and paths, not the goal sentence: advice usually rewrites that sentence, and keying
 * on it made every folded-in correction look like new work and ask again (2026-11-11 user decision).
 */
function correctionIdentity(name: string, input: unknown): string | undefined {
  if (!record(input)) return undefined;
  if (name === "lab_goal") {
    if (typeof input.goal !== "string" || !input.goal.trim() || !Array.isArray(input.deliverables) || !input.deliverables.length) return undefined;
    const targets = input.deliverables.map((d) => record(d) && typeof d.id === "string" && d.id.trim() ? [d.id, d.path ?? ""] : null);
    return targets.every(Boolean) ? JSON.stringify([name, targets]) : undefined;
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
export default async function preflightRouting(pi: ExtensionAPI): Promise<void> {
  // Installed plugins resolve host SDK packages through the loader's lazy-import bridge.
  const { getAgentDir } = await import("@oh-my-pi/pi-utils");
  const checks = new Map<string, Check>();
  const state = createPreflightCheck(pi, () => checks.clear());
  const { ask, note, inflight } = state;

  pi.on("tool_call", async (event, ctx) => {
    if (!state.main) return;
    const name = event.toolName as string;
    const input: unknown = event.input;
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
    const current = () => mySession === state.session && myGen === state.gen && checks.get(key) === check;
    note(ctx, `${what} 점검 중: 묻는 중`);
    // The session change aborts this call (reset); steering deliberately does not, so a successful answer that was
    // already in flight still holds without licensing a retry.
    const abort = new AbortController();
    inflight.add(abort);
    check.pending = (async (): Promise<{ block: true; reason: string } | undefined> => {
      const advice = await ask(ctx, plan, "", BLOCK_TIMEOUT_MS, { signal: abort.signal, live: current });
      if (mySession !== state.session) return;
      if (!current()) {
        // Keep fail-open for a failed check, but never execute a successfully checked plan superseded by steering.
        if (!advice.ok) return;
        return { block: true, reason: "[사전 점검] 점검 중 사용자 지시나 같은 작업의 계획이 바뀌었다. 최신 지시에 맞는 현재 계획으로 다시 호출하라. 이전 답으로 재호출을 허용하지 않는다." };
      }
      check.checked = true;
      if (!advice.ok) { note(ctx, `${what} 점검 건너뜀(통과): ${advice.why}`); return; }
      const failedLanes = failureText(advice.failures);
      note(ctx, `${what} 조언(${secs(advice.ms)}초):\n${opinionText(advice.opinions)}${failedLanes ? `\n${failedLanes}` : ""}`);
      // Every participant that answered found nothing to change: that is a pass. A participant that gave no advice
      // stays named in the panel and never counts as having reviewed the plan.
      if (advice.opinions.every((o) => CLEAN.test(o.text))) { note(ctx, `${what} 통과(빠진 것 없음${failedLanes ? `; ${failedLanes}` : ""})`); return; }
      if (identity) check.correctionTool = name;
      return {
        block: true,
        reason: [
          `[사전 점검] 오류가 아니다. ${what} 직전에 ${advice.opinions.map((o) => o.model).join("와 ")}(${secs(advice.ms)}초)가 사용자의 최근 말과 계획을 대 본 조언이다. 참고 의견이며 승인이나 사용자 지시가 아니다.`,
          ...(failedLanes ? [failedLanes] : []),
          identity
            ? `맞는 것은 계획에 반영하고, 같은 도구(${name})를 다시 불러라. ${name === "lab_goal" ? "산출물 id와 경로가 같으면 목표 문장을 고친 재호출도 한 번 통과하며, 산출물이 바뀌면 다시 점검한다." : "같은 작업 이름과 범위의 수정 재호출은 한 번 통과하며, 범위가 바뀌면 다시 점검한다."}`
            : `작업 식별 정보가 부족해 수정 재호출 허용을 묶을 수 없다. 내용을 바꾸면 새 계획으로 점검하고, 같은 내용을 그대로 다시 보내면 통과한다.`,
          "사용자 결정이 필요한 항목은 직접 정하지 말고 사용자에게 묻는다. 반영한 것과 버린 것(이유 한 마디)을 사용자에게 한 줄로 알린다.",
          "",
          opinionText(advice.opinions),
        ].join("\n"),
      };
    })();
    try {
      return await check.pending;
    } finally {
      check.pending = undefined;
      inflight.delete(abort);
    }
  });
}
