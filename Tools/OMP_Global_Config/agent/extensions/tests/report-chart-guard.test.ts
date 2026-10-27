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
    expect(chartCandidate(MISSED)).toEqual({ kind: "time", values: ["20.8분", "34.6분", "42.0분"], strong: true });
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
  // 2026-10-19~26 알림이 걸렸지만 비교가 아니었던 실제 답변에서 값이 셋으로 세어진 부분(출처: doc/history/2026/10/26-residual-fixes/ChartGuardFix/evidence/trigger-cases.out.txt).
  test("회차 서수·구간·약값·주기·한계 표현은 수치로 세지 않는다", () => {
    expect(chartCandidate("1회차 기준 DSH는 도구 86회, 우리 하네스는 62회였고, 2·3회차 결과를 기다리겠습니다.")).toBeNull();
    expect(chartCandidate("탁구 검색 1~2분, 외부 조회 한도 1분 300번, 8초 안 안내와 재시도.")).toBeNull();
    expect(chartCandidate("제품당 약 7~8KB, 하루 3,000개면 대략 20~25MB, 1,000개면 7~8MB, 한 달 내내 켜 둬도 1GB를 넘기기 어려워.")).toBeNull();
    expect(chartCandidate("1분마다 메모리를 75분 동안 기록하고 10분마다 보내요. 읽기 루프는 3ms 간격이에요.")).toBeNull();
    expect(chartCandidate("지금 약 4~6분 더 걸릴 것 같아. 직전은 10분, 마지막 전환은 30초야.")).toBeNull();
  });
  test("분·초가 이어진 한 시간 값은 하나로 세고, 전체 중 일부의 전체·한계 이름은 세지 않는다", () => {
    expect(chartCandidate("직전 배포는 빌드 5분 15초, host 교체 6분 26초였다.")).toBeNull();
    expect(chartCandidate("빌드 5분 15초, host 교체 6분 26초, 검증 2분 3초였다.")?.values).toEqual(["5분 15초", "6분 26초", "2분 3초"]);
    expect(chartCandidate("지적 17건 중 16건은 수정, 1건은 철회했다.")).toBeNull();
    expect(chartCandidate("CI가 시간 초과(5.3초 > 5초 제한)로 떨어져 stage 테스트에 30초 제한을 줬다.")).toBeNull();
  });
  // Main 검수: 0건·최대/최소·우연히 합이 맞는 값은 실제 기록이므로 비교 값으로 센다. 산술·값 크기로 추정하지 않는다.
  test("0건, 최대·최소 값, 우연히 합이 맞는 값도 기록된 비교 값으로 센다", () => {
    expect(chartCandidate("A 0건, B 5건, C 10건이었다.")?.values).toEqual(["0건", "5건", "10건"]);
    expect(chartCandidate("A 2건, B 3건, C 5건이었다.")?.values).toEqual(["2건", "3건", "5건"]);
    expect(chartCandidate("실측은 최대 12초, 최소 3초, 평균 5초였다.")?.values).toEqual(["12초", "3초", "5초"]);
    expect(chartCandidate("지연이 1초에서 2초, 3초로 늘었다.")?.values).toEqual(["1초", "2초", "3초"]);
  });
  test("값은 같은 문단·목록·표 안에서만 묶고, 다른 주제의 블록 값은 합치지 않는다", () => {
    const scattered = "지적 3건을 고쳤다.\n\n테스트는 7건이었다.\n\n별도로 1건이 남았다.\n\n마지막으로 2건을 확인했다.";
    expect(chartCandidate(scattered)).toBeNull();
    expect(chartCandidate("**첫 번째 확인:**\n지적 3건을 고쳤다.\n**두 번째 확인:**\n테스트는 7건이었다.\n# 소제목\n별도로 1건이 남았다.")).toBeNull();
    // 같은 문단의 여러 문장, 빈 줄로 띄운 느슨한 목록은 한 비교로 본다.
    expect(chartCandidate("빌드는 20.8분 걸렸다. 배포는 34.6분이었다. 검증은 42.0분이었다.")?.values).toEqual(["20.8분", "34.6분", "42.0분"]);
    expect(chartCandidate("- 빌드 20.8분\n\n- 배포 34.6분\n\n- 검증 42.0분")?.values).toEqual(["20.8분", "34.6분", "42.0분"]);
    // 표 앞뒤 문단도 표와 합치지 않는다.
    expect(chartCandidate("앞 문단 3건.\n\n| 항목 | 값 |\n|---|---|\n| A | 7건 |\n\n뒤 문단 1건.")).toBeNull();
  });
  // cross-review R4: 라벨·소개 문단과 목록 사이 빈 줄, 이어 줄이 있는 느슨한 목록은 한 블록이다.
  test("라벨·소개 문단 뒤 빈 줄과 이어 줄이 있는 느슨한 목록을 쪼개지 않는다", () => {
    expect(chartCandidate("**실측 비교: 기준 10초**\n\n- 변경 A: 20초\n- 변경 B: 30초")?.values).toEqual(["10초", "20초", "30초"]);
    expect(chartCandidate("- A: 10초\n  동일 입력으로 측정했다.\n\n- B: 20초\n\n- C: 30초")?.values).toEqual(["10초", "20초", "30초"]);
    expect(chartCandidate("변경 전에는 20.8분 걸렸고 이후 단계는 다음과 같다:\n\n- 1차: 34.6분\n- 2차: 42.0분")?.values).toEqual(["20.8분", "34.6분", "42.0분"]);
  });
  // Main 검수: 표·값 하나씩인 목록 항목 셋·비교 말씨·라벨+값이 쉼표로 이어진 반복 측정은 강한 후보, 문장에 흩어진 값만 있는 산문은 모호한 후보다.
  test("강한 후보와 모호한 산문 후보를 구분한다", () => {
    expect(chartCandidate("빌드 20.8분, 배포 34.6분, 검증 42.0분이 걸렸다.")?.strong).toBe(true);
    expect(chartCandidate("A 0건, B 5건, C 10건이었다.")?.strong).toBe(true);
    expect(chartCandidate("- 빌드 20.8분\n- 배포 34.6분\n- 검증 42.0분")?.strong).toBe(true);
    expect(chartCandidate("지연이 1초에서 2초, 3초로 늘었다.")?.strong).toBe(true);
    expect(chartCandidate("빌드는 20.8분 걸렸다. 배포는 34.6분이었다. 검증은 42.0분이었다.")?.strong).toBe(false);
    // 쉼표로 이어졌어도 값이 서로 다르지 않거나(3, 1, 1) 문장·괄호가 끼면 나열이 아니다.
    expect(chartCandidate("쉼표 3건, 줄표 1건, 콜론 1건을 고쳤다.")).toBeNull();
    expect(chartCandidate("A는 2건이었고, B는 3건이었고, 다음 날 C가 5건 나왔다.")?.strong).toBe(false);
  });
  // cross-review R4-GGL: 굵은 라벨별로 묶인 목록, 코드 블록이 끼어도 문단이 안 갈라진다.
  test("라벨별로 묶인 목록과 코드 블록이 낀 문단은 한 블록이다", () => {
    expect(chartCandidate("**Sonnet:**\n- 조각 1: 20.8분\n**DeepSeek:**\n- 조각 1: 34.6분\n- 조각 2: 42.0분")?.values).toEqual(["20.8분", "34.6분", "42.0분"]);
    expect(chartCandidate("빌드 10초였다.\n```\nmake\n```\n배포 20초, 검증 30초였다.")?.values).toEqual(["10초", "20초", "30초"]);
  });
  // 신규 체인 xr-20261026054650-a2f5a3 R1-OAI-1~6, 지적별 한 줄씩.
  test("신규 리뷰 지적 1~6: 숫자·콜론 라벨, 빈 줄 뒤 이어 줄, 이어 줄의 값, 띄운 구간, 한계 라벨, 낱말 속 '약'", () => {
    // R1-OAI-1
    expect(chartCandidate("A1 0건, A2 5건, A3 10건이었다.")?.strong).toBe(true);
    expect(chartCandidate("빌드: 20.8분, 배포: 34.6분, 검증: 42.0분이 걸렸다.")?.strong).toBe(true);
    // R1-OAI-2
    expect(chartCandidate("- A: 10초\n\n  동일 입력으로 측정했다.\n\n- B: 20초\n\n- C: 30초")?.values).toEqual(["10초", "20초", "30초"]);
    // R1-OAI-3
    expect(chartCandidate("- A:\n  10초\n- B:\n  20초\n- C:\n  30초")?.strong).toBe(true);
    // R1-OAI-4
    expect(chartCandidate("- A: 1분 ~ 2분\n- B: 3분 ~ 4분\n- C: 5분 ~ 6분")).toBeNull();
    // R1-OAI-5
    expect(chartCandidate("- 빌드 제한: 10분\n- 배포 한도: 20분\n- 검증 상한: 30분")).toBeNull();
    // R1-OAI-6
    expect(chartCandidate("계약 2건, 예약 3건, 해약 5건이었다.")?.values).toEqual(["2건", "3건", "5건"]);
    // 체인 xr-20261026055557-28ff14 R2-OAI-1, R2-OAI-2
    expect(chartCandidate("실측 결과 A의 권한도 2건, B의 권한도 3건, C의 권한도 5건이었다.")?.values).toEqual(["2건", "3건", "5건"]);
    expect(chartCandidate("- A: 10초\n\n  **측정 메모**\n\n- B: 20초\n\n- C: 30초")?.values).toEqual(["10초", "20초", "30초"]);
  });
  // cross-review R1: 0%·0초는 실제 기록값, 반복 값이 있는 2×2 표, 바깥 파이프 없는 표, 줄바꿈으로 나뉜 값은 합치지 않는다.
  test("0%·0초 기록값, 같은 값이 겹친 2×2 표, 바깥 파이프 없는 표, 줄 단위 측정값을 놓치거나 합치지 않는다", () => {
    expect(chartCandidate("실측 캐시 적중률은 변경 전 0%, 중간 50%, 변경 후 100%였다.")?.values).toEqual(["0%", "50%", "100%"]);
    expect(chartCandidate("측정 지연은 변경 전 3초, 중간 1초, 변경 후 0초였다.")?.values).toEqual(["3초", "1초", "0초"]);
    expect(chartCandidate("| 항목 | 전 | 후 |\n|---|---|---|\n| A | 25% | 20% |\n| B | 25% | 23% |")?.values).toEqual(["25%", "20%", "23%"]);
    expect(chartCandidate("지갑 | 사이트 잔액 비율 | 사용 비율\n---|---|---\nGoogle | 99% | 3%\nHive | 미확인 | 2%\n\n별도 환급률은 50%다.")).toBeNull();
    // R2: 표 뒤에 이어진 제목 줄은 산문이고, 표 전체 문턱은 칸 수로 센다.
    expect(chartCandidate("항목 | 상태\n---|---\n배포 | 완료\n# 실측 B는 20초, C는 30초, D는 40초")?.values).toEqual(["20초", "30초", "40초"]);
    expect(chartCandidate("항목 | 전 | 후\n---|---|---\nA | 10% / 20% | 미측정\nB | 미측정 | 10% / 30%")).toBeNull();
    expect(chartCandidate("실측 시간(실행 순서대로):\n5분\n15초\n200ms")?.values).toEqual(["5분", "15초", "200ms"]);
  });
  test("천 단위 쉼표 수는 한 값이다", () => {
    expect(chartCandidate("1,395건을 판정했고 CH2 465건, CH3 464건이 맞았다.")?.values).toEqual(["1,395건", "465건", "464건"]);
  });
  test("표는 열·행 하나의 값 셋이나 표 전체 값 넷(전후 비교)부터 한 묶음으로 본다", () => {
    const credit = "| 지갑 | 입력한 값 | 사이트 실제 | CUELO 표시 |\n|---|---|---|---|\n| Google | $300 | 잔액 ₩404,308 / ₩407,626(99%) | 사용 3% |\n| Hive | $106 | 잔액 $99.81 | 사용 2% |\n\nArgon은 나중에 50%를 돌려받기 전의 정가로 계산돼요.";
    expect(chartCandidate(credit)).toBeNull();
    expect(chartCandidate("| 단계 | 소요 |\n|---|---|\n| 빌드 | 20.8분 |\n| 배포 | 34.6분 |\n| 검증 | 42.0분 |")).toEqual({ kind: "time", values: ["20.8분", "34.6분", "42.0분"], strong: true });
    expect(chartCandidate("| 항목 | 전 | 후 |\n|---|---|---|\n| 지연 문장 비율 | 25% | 20% |\n| 연결어미 문장 비율 | 31% | 23% |")?.values).toEqual(["25%", "20%", "31%", "23%"]);
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
  // 2026-10-26 알림이 실제로 걸렸던 끝난 답의 원문 문장(코드 표기만 뺌). 값은 0건·3건·1건으로 묶이지만 서로 견준 값이 아니다.
  const ORIGINAL_FILLER = "새 절 초안은 Gemini( ) 1회로 받았습니다.   기준으로는 S1 0건이었고, S2(연결어미 뒤 쉼표 3건, 줄표 1건, 콜론 1건)는 모두 고쳐서 자연도 A입니다.";
  test("원문 오탐 문장: 끝난 답은 이어 가기를 만들지 않고, ask 차단 정책과 뒤따른 강한 비교는 그대로다", () => {
    expect(chartCandidate(ORIGINAL_FILLER)).toEqual({ kind: "count-건", values: ["0건", "3건", "1건"], strong: false });
    const h = harness();
    h.user("정리해 줘");
    h.assistant(ORIGINAL_FILLER);
    expect(h.sent).toHaveLength(0);
    h.assistant(MISSED);
    expect(h.sent).toHaveLength(1);
    expect(h.deliveries[0]).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
  });
  // 2026-10-28 표본(D5·D18): 뜻이 다른 값(경과·제한·캐시 전후)이 섞인 진행 문장은 도구 사이에 알리지 않는다. ask 차단은 그대로다.
  test("모호한 후보는 도구를 부르는 중간 보고에서 조용하고, ask면 한 번 차단으로 기존 정책을 따른다", () => {
    const mid = harness();
    mid.assistant(ORIGINAL_FILLER, ["bash"]);
    mid.assistant("21분 시험은 10분이 넘었는데 아직 응답이 없어요. 서버 호출 제한을 150분으로 둔 이유가 바로 이거예요.", ["bash"]);
    expect(mid.sent).toHaveLength(0);
    mid.assistant(MISSED, ["bash"]);
    expect(mid.deliveries).toEqual([{ deliverAs: "aside" }]);
    const asked = harness();
    asked.assistant(ORIGINAL_FILLER, ["ask"]);
    expect(asked.toolCall("ask")).toMatchObject({ block: true });
    asked.assistant(ORIGINAL_FILLER, ["ask"]);
    expect(asked.toolCall("ask")).toBeUndefined();
  });
  // Main 검수: 동사 없이 라벨+값이 쉼표로 이어진 분명한 비교는 끝난 답에서도 알리고, 같은 턴의 원문 오탐 문장은 조용하다.
  test("라벨+값 반복 측정과 0건이 든 라벨 비교는 끝난 답에서도 이어 가기로 알리고, 원문 오탐 문장은 알리지 않는다", () => {
    for (const text of ["빌드 20.8분, 배포 34.6분, 검증 42.0분이 걸렸다.", "A 0건, B 5건, C 10건이었다."]) {
      const h = harness();
      h.user("결과 알려 줘");
      h.assistant(ORIGINAL_FILLER);
      expect(h.sent).toHaveLength(0);
      h.assistant(text);
      expect(h.sent).toHaveLength(1);
      expect(h.deliveries[0]).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
    }
  });
  // 2026-10-28 표본(D2·D19): "N건 중 M건" 분해는 비교 말씨가 없어도 강한 후보이고, 알림은 값을 채운 차트 뼈대를 싣는다.
  test("전체 중 일부로 나눈 기록 수치는 강한 후보이고 알림에 채운 차트 뼈대가 붙는다", () => {
    const text = "finding 312건 중 240건은 실제 수정, 52건은 반박, 20건은 보류로 처리됐네요.";
    expect(chartCandidate(text)).toEqual({ kind: "count-건", values: ["240건", "52건", "20건"], strong: true });
    const h = harness();
    h.assistant(text, ["bash"]);
    expect(h.deliveries).toEqual([{ deliverAs: "aside" }]);
    expect(h.sent[0]!.content).toContain("```mermaid\nxychart-beta");
    expect(h.sent[0]!.content).toContain("bar [240, 52, 20]");
    expect(chartCandidate("지적 17건 중 16건은 수정, 1건은 철회했다.")).toBeNull();
    // 이어진 분·초 값은 한 숫자가 아니므로 앞 숫자만 채우지 않고 같은 단위로 바꿔 채울 자리만 둔다.
    const compound = harness();
    compound.assistant("빌드 5분 30초, 배포 6분 30초, 검증 7분 30초가 걸렸다.", ["bash"]);
    expect(compound.sent[0]!.content).toContain("bar [<같은 단위 값>, <같은 단위 값>, <같은 단위 값>]");
    expect(compound.sent[0]!.content).toContain('y-axis "<단위>"');
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
