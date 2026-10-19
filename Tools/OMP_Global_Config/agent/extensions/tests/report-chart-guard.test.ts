import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import reportChartGuard, { chartCandidate, REMINDER_TYPE } from "../report-chart-guard";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type Sent = { customType: string; content: string; display: boolean };

// 2026-10-19 실제 누락 문장(ask 바로 앞 본문).
const MISSED = "실측 결과 Sonnet 조각은 20.8분, 딥시크 두 조각은 각각 34.6분·42.0분 걸렸지만, Main이 04:48~05:01 사이 반복 대기한 건 사실이에요.";
const CHARTED = `${MISSED}\n\n\`\`\`mermaid\nxychart-beta\n  bar [20.8, 34.6, 42.0]\n\`\`\``;

function harness(kind: "main" | "sub" = "main") {
  const handlers: Record<string, Handler[]> = {};
  const sent: Sent[] = [];
  const deliveries: unknown[] = [];
  reportChartGuard({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: Sent, options: unknown) => { sent.push(message); deliveries.push(options); },
  } as unknown as ExtensionAPI);
  const ctx = { agent: { kind } };
  const emit = (name: string, event: Record<string, unknown>) => handlers[name]?.map((h) => h(event, ctx)) ?? [];
  return {
    sent, deliveries,
    user: (text: string, extra: Record<string, unknown> = {}) => emit("message_start", { message: { role: "user", content: text, ...extra } }),
    assistant: (text: string, tools: string[] = []) =>
      emit("message_end", { message: { role: "assistant", content: [{ type: "text", text }, ...tools.map((name) => ({ type: "toolCall", name }))] } }),
    toolCall: (toolName: string) => emit("tool_call", { toolName, toolCallId: "t1", input: {} })[0],
  };
}

describe("chartCandidate", () => {
  test("누락된 실제 문장의 실행 시간 세 값을 같은 묶음으로 잡는다", () => {
    expect(chartCandidate(MISSED)).toEqual({ kind: "time", values: ["20.8분", "34.6분", "42.0분"] });
  });
  test("값이 둘이거나 이미 Mermaid 차트가 있으면 후보가 아니다", () => {
    expect(chartCandidate("Sonnet 20.8분, 딥시크 42.0분 걸렸어요.")).toBeNull();
    expect(chartCandidate(CHARTED)).toBeNull();
  });
  test("버전·시각·날짜·코드 안 숫자와 단위 뒤에 낱말이 붙은 경우는 수치로 세지 않는다", () => {
    expect(chartCandidate("0.10.38 배포, 04:48~05:01 대기, 10-19·10-24·10-26 관찰, `sleep 10s 20s 30s`, 3배포 5분석 7회의")).toBeNull();
  });
  test("시간 단위가 달라도 같은 축으로 묶고, 건과 회는 섞지 않는다", () => {
    expect(chartCandidate("빌드 481초, 대기 2.2분, 재시작 1.5시간")?.values).toEqual(["481초", "2.2분", "1.5시간"]);
    expect(chartCandidate("오류 1건, 재시도 11회, 경고 2건")).toBeNull();
  });
});

describe("report chart guard", () => {
  test("답이 끝난 응답에서 걸리면 바로 이어 가는 숨김 알림을 한 번 보낸다", () => {
    const h = harness();
    h.user("월타임이 길어서 좀 문제이긴한데.");
    h.assistant(MISSED);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ customType: REMINDER_TYPE, display: false });
    expect(h.sent[0]!.content).toContain("20.8분, 34.6분, 42.0분");
    expect(h.deliveries[0]).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
  });
  test("도구를 부르는 중간 보고면 다음 단계 경계로 전달한다", () => {
    const h = harness();
    h.assistant(MISSED, ["bash"]);
    expect(h.deliveries[0]).toEqual({ deliverAs: "aside" });
  });
  test("같은 응답의 ask는 한 번 막고, 다시 보낸 ask는 통과시킨다", () => {
    const h = harness();
    h.assistant(MISSED, ["ask"]);
    expect(h.sent).toHaveLength(0);
    expect(h.toolCall("ask")).toMatchObject({ block: true, reason: expect.stringContaining("질문을 보내지 않았다") });
    h.assistant(MISSED, ["ask"]);
    expect(h.toolCall("ask")).toBeUndefined();
  });
  test("사용자 입력 하나에 한 번만 알리고, 에이전트가 만든 메시지로는 다시 무장하지 않는다", () => {
    const h = harness();
    h.assistant(MISSED);
    h.user("[자동 재개]", { attribution: "agent" });
    h.assistant(MISSED);
    expect(h.sent).toHaveLength(1);
    h.user("다음 질문");
    h.assistant(MISSED);
    expect(h.sent).toHaveLength(2);
  });
  test("차트가 있거나 subagent 응답이면 알리지 않는다", () => {
    const main = harness();
    main.assistant(CHARTED);
    expect(main.sent).toHaveLength(0);
    const sub = harness("sub");
    sub.assistant(MISSED, ["ask"]);
    expect(sub.sent).toHaveLength(0);
    expect(sub.toolCall("ask")).toBeUndefined();
  });
});
