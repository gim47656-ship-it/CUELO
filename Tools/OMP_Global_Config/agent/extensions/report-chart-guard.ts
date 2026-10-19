import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { onSessionLifecycle } from "./lib/session-identity";

/**
 * 보고 차트 누락 알림. 2026-10-19 사용자 결정(전역 `AGENTS.md` 「사용자 보고」): 기록 수치의 비교·추이·분해에 값이
 * 셋 이상이면 Mermaid 차트 하나를 붙인다. 같은 날 Main이 조각 세 개의 실행 시간(20.8분·34.6분·42.0분)을 `ask` 바로 앞
 * 한 문장에 적고 차트를 빠뜨렸다. 규칙은 문맥에 있었으므로 문구만 고쳐서는 재발을 막지 못한다고 보고, 본문에서 같은 종류의
 * 수치 셋 이상을 결정론적으로 찾아 한 번 일깨운다. 차트를 그릴지는 모델이 수치의 출처·비교 여부로 정한다(알림은 차단이 아니다).
 */

export const REMINDER_TYPE = "report-chart-guard";
export const MIN_VALUES = 3;

type Message = { role?: string; content?: unknown; synthetic?: boolean; attribution?: string };

// 단위를 같은 종류로 묶는다. 시간끼리, 크기끼리는 단위가 달라도 같은 축에 놓일 수 있다.
// 셈 단위(건·회)는 서로 다른 것을 세는 일이 많아 따로 묶는다(2026-10-19 재생: "1건, 11회, 2건" 같은 나열 오탐).
const UNIT_KIND: Readonly<Record<string, string>> = {
  ms: "time", s: "time", "초": "time", "분": "time", "시간": "time",
  "%": "percent", "배": "ratio", "건": "count-건", "회": "count-회",
  KB: "size", MB: "size", GB: "size", KiB: "size", MiB: "size", GiB: "size",
};
// 버전(0.10.38)·시각(04:48)·날짜(10-19)·경로 조각 안의 숫자는 수치로 보지 않는다(앞뒤 문자 경계).
// 단위 바로 뒤에 다른 낱말이 붙으면(배포·분석·회의·초기·건너…) 단위가 아니다.
const QUANTITY =
  /(?<![\d.:/\-A-Za-z_])(\d+(?:\.\d+)?)\s?(ms|s|초|분|시간|%|배|건|회|KiB|MiB|GiB|KB|MB|GB)(?![A-Za-z\d])(?!(?:포|치|열|석|류|기|화|의|수|복|너|당|위|면|산|간|리|야|장|별)[가-힣])/g;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** 값이 셋 이상인 같은 종류의 수치 묶음. 없으면 null. Mermaid 블록이 이미 있으면 판정하지 않는다. */
export function chartCandidate(text: string): { kind: string; values: string[] } | null {
  if (/```\s*mermaid\b/i.test(text)) return null;
  const groups = new Map<string, string[]>();
  // 코드 블록·인라인 코드 안의 수치(명령·로그)는 보고 수치로 세지 않는다.
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, "\n").replace(/`[^`\n]*`/g, " ");
  for (const match of prose.matchAll(QUANTITY)) {
    const kind = UNIT_KIND[match[2]!];
    if (!kind) continue;
    const value = `${match[1]}${match[2]}`;
    const list = groups.get(kind) ?? [];
    if (!list.includes(value)) list.push(value);
    groups.set(kind, list);
  }
  let best: { kind: string; values: string[] } | null = null;
  for (const [kind, values] of groups) {
    if (values.length >= MIN_VALUES && (!best || values.length > best.values.length)) best = { kind, values };
  }
  return best;
}

export function reminderText(candidate: { values: string[] }): string {
  const shown = candidate.values.slice(0, 6).join(", ");
  return `직전 사용자 표시 문장에 같은 종류의 수치가 ${candidate.values.length}개 있었다(${shown}). 그런데 Mermaid 차트가 없었다. `
    + "이 값들이 도구 출력·실행 기록·측정 산출물에서 온 비교·추이·분해라면, 바로 다음 응답에 출처와 함께 차트 하나(`xychart-beta` 막대, `gantt` 시간선 등)를 붙인다. "
    + "`ask` 질문 앞 근거 문장, 진행 중 중간 보고도 보고다. 비교가 아니거나(서로 무관한 값의 나열) 추정치라면 차트를 그리지 않는다. 그때 답이 이미 끝났다면 아무 문장도 덧붙이지 말고 끝내고, 어느 경우든 이 알림을 사용자에게 언급하지 않는다.";
}

export default function reportChartGuard(pi: ExtensionAPI): void {
  let reminded = false;
  // 같은 응답의 `ask` 호출을 막을 때 쓰는 알림. 수치를 보여 주고 바로 결정을 묻는 경우는 차트 없이 결정하게 두지 않는다.
  let askHold: string | undefined;
  const reset = () => { reminded = false; askHold = undefined; };
  onSessionLifecycle(pi, { start: reset });
  pi.on("session_shutdown", reset);
  // 사용자 직접 입력 하나에 한 번만 알린다. 알림이 만든 이어 가기 응답이 다시 차트 없이 끝나도 반복하지 않는다.
  pi.on("message_start", (event) => {
    const message = event.message as Message;
    if (message.role === "user" && message.synthetic !== true && message.attribution !== "agent") reset();
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message as Message;
    if (reminded || message.role !== "assistant" || ctx.agent.kind !== "main") return;
    const candidate = chartCandidate(textOf(message.content));
    if (!candidate) return;
    reminded = true;
    const calls = Array.isArray(message.content)
      ? message.content.filter((block): block is { type: string; name?: string } => block?.type === "toolCall")
      : [];
    if (calls.some((call) => call.name === "ask")) {
      askHold = `[report-chart-guard] 질문을 보내지 않았다. ${reminderText(candidate)} 차트가 필요하면 차트를 붙인 응답에서 같은 질문을 다시 보낸다. 필요 없으면 같은 질문을 그대로 다시 보낸다.`;
      return;
    }
    // 도구를 부르는 중이면 다음 단계 경계에서, 답이 끝났으면 바로 이어 가는 내부 continuation으로 전달한다.
    pi.sendMessage(
      { customType: REMINDER_TYPE, content: reminderText(candidate), display: false, attribution: "agent" },
      calls.length > 0 ? { deliverAs: "aside" } : { deliverAs: "nextTurn", triggerTurn: true },
    );
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== "ask" || askHold === undefined) return;
    const reason = askHold;
    askHold = undefined;
    return { block: true, reason };
  });
}
