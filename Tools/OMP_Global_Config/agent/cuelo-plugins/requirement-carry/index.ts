import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { isPhoneOperatorCall } from "../../extensions/command-guard/task-guard";
import { createQuietDelivery } from "../../extensions/lib/quiet-delivery";
import { onSessionLifecycle } from "../../extensions/lib/session-identity";
import { carriesUserWords, compactionAdvice, forLog, handoffAdvice, messageText, stripGuardLines, unsupportedApprovalClaims } from "./requirement-carry";

// 2026-11 요구 보존 검사. 압축 요약이 사용자 원문에 없는 승인을 쓰는지(arXiv 2611.06545), Main의 발주 브리프에
// 사용자 원문 조각이 하나도 없는지(arXiv 2611.07483)를 문자열로만 본다. 막거나 고치지 않고 안내만 한다.
// 시스템 프롬프트와 도구 정의는 건드리지 않는다: 압축 안내는 quiet 메시지, 발주 안내는 도구 결과 뒤 글이다.

export const EVENTS_FILE = "cuelo-requirement-carry-events.jsonl";
const EVENTS_ENV = "CUELO_REQUIREMENT_CARRY_EVENTS_PATH";
const MAX_USERS = 2000;

type Log = (record: Record<string, unknown>) => void;

// 관찰 기록은 플러그인 폴더 밖(에이전트 폴더)에 둔다. 정식 폴더는 프로필 동기화가 덮는다. 시험은 환경 변수로 임시 경로를 준다.
const defaultLog: Log = (record) => {
  try {
    const path = process.env[EVENTS_ENV] || join(import.meta.dir, "..", "..", EVENTS_FILE);
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch {
    // 기록 실패는 동작을 막지 않는다.
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 사람이 쓴 사용자 메시지만: synthetic 주입과 agent 귀속 메시지는 사용자의 말이 아니다. */
function userMessageText(message: unknown): string {
  if (!isRecord(message) || message.role !== "user" || message.synthetic === true || message.attribution === "agent") return "";
  return messageText(message).trim();
}

export function createRequirementCarry(options: { log?: Log } = {}) {
  const sink = options.log ?? defaultLog;
  // 기록 실패(주입한 sink 포함)가 안내 전달을 막아서는 안 된다.
  const log: Log = (record) => {
    try {
      sink(record);
    } catch {
      // 관찰 기록은 부가 기능이다.
    }
  };
  return function requirementCarry(pi: ExtensionAPI): void {
    const quiet = createQuietDelivery(pi);
    /** 세션의 사용자 메시지 전부(압축 요약 대조용). */
    let allUsers: string[] = [];
    /** 이번 요청의 사용자 입력: 첫 입력 하나에 steering을 더한다(발주 대조용). */
    let current: string[] = [];
    let lastInput = "";
    const pending = new Map<string, { text: string; names: string[]; sessionId: string }>();

    const remember = (text: string) => {
      if (text && allUsers[allUsers.length - 1] !== text) allUsers = [...allUsers, text].slice(-MAX_USERS);
    };
    const branchUsers = (ctx: ExtensionContext): string[] => {
      try {
        const out: string[] = [];
        for (const entry of ctx.sessionManager.getBranch() as unknown[]) {
          const text = isRecord(entry) ? userMessageText(entry.message) : "";
          if (text) out.push(text);
        }
        return out;
      } catch {
        return [];
      }
    };
    const sessionOf = (ctx: ExtensionContext) => ctx.sessionManager?.getSessionId?.() ?? "";
    const isMain = (ctx: ExtensionContext) => ctx.agent?.kind !== "sub";

    onSessionLifecycle(pi, {
      start(ctx) {
        allUsers = [];
        current = [];
        lastInput = "";
        pending.clear();
        const users = branchUsers(ctx);
        users.forEach(remember);
        current = users.slice(-1);
      },
    });
    pi.on("session_shutdown", () => {
      allUsers = [];
      current = [];
      pending.clear();
    });

    pi.on("input", (event) => {
      if (event.source !== "interactive" && event.source !== "rpc") return;
      const text = String(event.text ?? "").trim();
      lastInput = text.replace(/\s+/g, "");
      if (!text) return;
      current = [text];
      remember(text);
    });
    // 실행 중 끼워 넣은 steering은 `input` 없이 들어온다. 직전 `input`의 본문과 같은 메시지는 그 프롬프트 자신이므로 건너뛴다.
    pi.on("message_start", (event) => {
      const text = userMessageText(event.message);
      if (!text) return;
      if (lastInput && text.replace(/\s+/g, "") === lastInput) {
        lastInput = "";
        return;
      }
      current = [...current, text];
      remember(text);
    });

    // 압축 뒤에는 앞서 보낸 안내도 요약에 흡수돼 모델이 더는 보지 못한다. 그래서 요약마다 다시 알린다.
    pi.on("session_compact", (event, ctx) => {
      const summary = event.compactionEntry?.summary;
      if (typeof summary !== "string" || !summary.trim()) return;
      const claims = unsupportedApprovalClaims(summary, [...branchUsers(ctx), ...allUsers]);
      if (claims.length === 0) return;
      log({ kind: "compaction", sessionId: sessionOf(ctx), main: isMain(ctx), count: claims.length, items: claims.map(forLog) });
      quiet({ customType: "requirement-carry", content: compactionAdvice(claims), display: false, attribution: "agent" }, ctx);
    });

    pi.on("tool_call", (event, ctx) => {
      if (!isMain(ctx) || event.toolName !== "task") return;
      const input = event.input;
      if (!isRecord(input) || current.length === 0) return;
      const sessionId = sessionOf(ctx);
      const context = typeof input.context === "string" ? stripGuardLines(input.context) : "";
      const items: unknown[] = Array.isArray(input.tasks) ? input.tasks : [input];
      const names: string[] = [];
      items.forEach((item, index) => {
        if (!isRecord(item) || typeof item.task !== "string" || isPhoneOperatorCall(item, input)) return;
        if (item.agent !== undefined && String(item.agent).trim().toLowerCase() !== "maker") return;
        if (carriesUserWords(`${context}\n${stripGuardLines(item.task)}`, current)) return;
        names.push(typeof item.name === "string" && item.name.trim() ? item.name.trim() : `task ${index + 1}`);
      });
      if (names.length === 0) return;
      pending.set(event.toolCallId, { text: handoffAdvice(names), names, sessionId });
    });
    // 결과가 오지 않은(막힌) 호출의 항목은 턴이 끝나면 버린다. 살아 있는 호출의 안내를 상한으로 밀어내지 않는다.
    pi.on("agent_end", (event) => {
      if (!event.willContinue) pending.clear();
    });

    pi.on("tool_result", (event) => {
      const advice = pending.get(event.toolCallId);
      if (!advice) return;
      pending.delete(event.toolCallId);
      log({ kind: "handoff", sessionId: advice.sessionId, main: true, tool: event.toolName, count: advice.names.length, items: advice.names.map(forLog) });
      return { content: [...event.content, { type: "text", text: advice.text }] };
    });
  };
}

export default createRequirementCarry();
