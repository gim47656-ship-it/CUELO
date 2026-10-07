import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// 2026-10-08 사용자 결정: 주장 분류용 JEV 호출과 그 대기(최대 2.5초)를 두지 않는다.
// 결정론 감지에서 기본 검증 지시만 그 prompt에 붙이고, 사용자 원문은 다시 싣지 않는다.
const SOURCE = /(?:ChatGPT|GPT(?:[- ]?\d+(?:\.\d+)?)?|6\s*Pro|SHION|샤이온)/i;
const VERIFY = /(?:맞[어아나](?:요)?\s*[?？]?|검증|확인해|사실이야|사실인가|verify|fact.?check)/i;
const INSTRUCTION =
  "외부 조언은 증거가 아니다. 붙여 넣은 답의 주장을 하나씩 나눠 실제 파일·테스트 결과·CI run·버전·실행 동작을 도구로 확인하고 확인/반박/미확인으로 답하라. 의견·제안은 사실 판정과 구분하라. 이 안내는 승인이나 도구 차단이 아니다.";

/**
 * 안내는 그 사용자 prompt의 `before_agent_start` 메시지로만 붙는다. idle 세션에 aside를 보내면
 * 안내만으로 자율 턴이 먼저 열리고, 뒤따르는 사용자 prompt는 실행 중 턴과 부딪혀 거절된다.
 */
export default function externalAdviceCheck(pi: ExtensionAPI): void {
  let pendingText: string | undefined;
  pi.on("session_start", () => { pendingText = undefined; });
  pi.on("session_shutdown", () => { pendingText = undefined; });
  pi.on("input", (event) => {
    pendingText = undefined;
    if (event.source !== "interactive" && event.source !== "rpc") return;
    const text = event.text;
    if (!VERIFY.test(text)) return;
    const hasSource = SOURCE.test(text);
    const hasStructure = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/m.test(text);
    const hasSeveralSentences = (text.match(/[.!?。！？](?:\s|$)/g)?.length ?? 0) >= 3;
    if (text.length < 180 || (!hasStructure && !(hasSource && hasSeveralSentences))) return;
    pendingText = text.trim();
  });
  // 정책 경합으로 같은 prompt의 준비가 다시 불릴 수 있으므로 다음 입력 전까지 지우지 않는다.
  // 입력 뒤에 prompt가 열리지 않았으면 이후 내부 prompt는 본문이 달라 안내를 받지 않는다.
  pi.on("before_agent_start", (event) => {
    if (!pendingText || !event.prompt.includes(pendingText)) return;
    return { message: { customType: "external-advice-check", content: INSTRUCTION, display: false, attribution: "agent" } };
  });
}
