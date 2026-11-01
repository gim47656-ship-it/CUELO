import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import askAutoSelectGuard from "../ask-autoselect-guard";

type Question = {
  id: string;
  question: string;
  options: { label: string; description?: string; preview?: string }[];
  recommended?: number;
  autoSelectRecommended?: boolean;
};
type Result = { block: boolean; reason: string } | undefined;

function harness() {
  let handler: (event: { toolName: string; input: unknown }) => Result;
  askAutoSelectGuard({
    on: (_name: string, callback: typeof handler) => { handler = callback; },
  } as unknown as ExtensionAPI);
  return (questions: Question[], toolName = "ask") => handler({ toolName, input: { questions } });
}

function question(text: string, autoSelectRecommended: boolean | undefined = true): Question {
  return {
    id: "choice",
    question: text,
    options: [{ label: "진행" }, { label: "보류" }],
    recommended: 0,
    autoSelectRecommended,
  };
}

const decisions = [
  "백업 파일을 삭제할까?",
  "운영 환경에 배포할까?",
  "추가 비용을 지불할까?",
  "결제를 진행할까?",
  "어느 계정을 사용할까?",
  "접근 권한을 허용할까?",
  "제공자 안전 확인을 승인할까?",
  "원하는 결과는 어느 쪽인가?",
  "UI 동작을 어떻게 바꿀까?",
  "데이터 처리 정책을 골라 줘.",
  "판정 기준을 무엇으로 할까?",
  "기존 기능을 보존할까?",
  "기존 기능을 유지할까?",
  "Should we delete the backup?",
  "Approve deployment to production?",
  "Choose the payment account and permissions.",
  "What is the desired outcome?",
  "Which UI behavior do you want?",
  "Choose data handling and judgment criteria.",
  "Preserve existing features?",
  "Which model should handle this role?",
  "Change model routing?",
  "Which provider should handle this: OpenAI or Anthropic?",
  "Maker로 Opus를 쓸까요, Sol을 쓸까요?",
  "어느 프로바이더를 쓸까요?",
  "Use GPT-5.6 or GPT-6?",
  "Should we spend $500 on additional compute this month?",
  "리뷰어는 Opus 5.5와 GPT-6 Astra 중 어떤 걸로 진행할까요?",
  "Gemini로 갈까요, Claude로 갈까요?",
  "Opus로 바꿀까요?",
  "Should the review use Opus 4.7 or 4.8?",
  "gpt-5.5로 할까 5.6으로 할까?",
  "Switch to Opus for this review?",
  "Should we switch to GPT-5.6?",
  "Use Gemini instead?",
  "이번엔 Gemini를 쓸까요?",
  "Which provider should handle the review?",
  "크레딧 5천원어치 추가 구매할까요?",
];

describe("ask auto-select guard", () => {
  test.each(decisions)("blocks auto-selection for decision: %s", text => {
    const result = harness()([question(text)]);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("autoSelectRecommended");
  });

  test.each(decisions)("allows the same decision without auto-selection: %s", text => {
    const call = harness();
    expect(call([question(text, false)])).toBeUndefined();
    const withoutFlag = question(text);
    delete withoutFlag.autoSelectRecommended;
    expect(call([withoutFlag])).toBeUndefined();
  });

  test("blocks the measured HIKARI model choice", () => {
    const q = question("HIKARI 호출 모델을 어떻게 정할까?");
    q.options = [{ label: "implGemini 역할을 따르게" }, { label: "프록시로 고정" }];
    expect(harness()([q, question("같은 작업에 넣을 것을 골라 줘.")])?.block).toBe(true);
  });

  test("blocks the measured Gemini web fallback choice", () => {
    const q = question("웹검색에 Gemini 3.8 Flash를 어떻게 붙일까?");
    q.options = [{ label: "Luna 실패 때만 Gemini로 폴백" }, { label: "항상 사용" }];
    expect(harness()([q])?.block).toBe(true);
  });

  test.each(["label", "description", "preview"] as const)("inspects option %s text", key => {
    const q = question("어느 쪽으로 할까?");
    q.options = [{ label: "A", [key]: "기존 데이터 보존" }, { label: "B" }];
    expect(harness()([q])?.block).toBe(true);
  });

  test("blocks English provider fallback choices", () => {
    const q = question("How should web search use Gemini?");
    q.options = [{ label: "Fall back to Gemini only if Luna fails" }, { label: "Always" }];
    expect(harness()([q])?.block).toBe(true);
  });

  test.each([
    "함수를 나눌까, 기존 함수 안에 둘까?",
    "반복문과 map 중 어느 구현을 쓸까?",
    "Should the helper be inline or extracted?",
    "Should we use a map or a loop?",
    "Which fallback value should the parser return?",
    "How should we split the view model helper?",
    "모델 객체의 helper를 어느 파일에 둘까?",
    "accounting helper를 나눌까?",
    "Which data model should the parser use?",
    "메모리 비용이 적은 자료구조를 고를까?",
    "Should the parser account for CRLF?",
    "Should the map preserve insertion order?",
    "공개 함수로 둘까요?",
    "파일 권한 비트 확인 방식을 고를까?",
    "Which data structure should we use for the account lookup cache?",
    "Should the helper parse lower memory cost options first?",
    "Which file should hold the provider registry?",
    "Which provider should we use for dependency injection?",
  ])("allows routine implementation auto-selection: %s", text => {
    expect(harness()([question(text)])).toBeUndefined();
  });

  test("does not combine opted-out decisions with a different auto-select question", () => {
    expect(harness()([
      question("운영에 배포할까?", false),
      question("함수를 나눌까?"),
    ])).toBeUndefined();
  });

  test("blocks a sensitive question later in a batch", () => {
    expect(harness()([question("함수를 나눌까?"), question("계정을 바꿀까?")])?.block).toBe(true);
  });

  test("does not inspect non-ask tool input or question identifiers", () => {
    const q = question("함수를 나눌까?");
    q.id = "deployment-model-choice";
    expect(harness()([q])).toBeUndefined();
    expect(harness()([question("배포할까?")], "other_tool")).toBeUndefined();
  });
});
