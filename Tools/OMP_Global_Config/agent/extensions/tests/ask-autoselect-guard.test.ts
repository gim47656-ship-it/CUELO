import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import askAutoSelectGuard from "../ask-autoselect-guard";

type AskInput = { html: string; autoSelectRecommended?: boolean };
type Result = { block: boolean; reason: string } | undefined;

function harness() {
  let handler: (event: { toolName: string; input: unknown }) => Result;
  askAutoSelectGuard({
    on: (_name: string, callback: typeof handler) => { handler = callback; },
  } as unknown as ExtensionAPI);
  return (input: unknown, toolName = "ask") => handler({ toolName, input });
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One radio question in a fieldset, `<legend>` as the question text; `context` goes in front of it as extra markup. */
function form(text: string, options: { labels?: string[]; context?: string; name?: string } = {}): string {
  const [first = "진행", second = "보류"] = options.labels ?? [];
  const name = options.name ?? "choice";
  return `<form>${options.context ?? ""}<fieldset><legend>${escapeHtml(text)}</legend>` +
    `<label><input type="radio" name="${name}" value="go" checked> ${escapeHtml(first)}</label>` +
    `<label><input type="radio" name="${name}" value="hold"> ${escapeHtml(second)}</label></fieldset></form>`;
}

/** `flag` "omit" leaves the opt-in out entirely, as a call that never mentions it. */
function ask(text: string, flag: boolean | "omit" = true, options?: Parameters<typeof form>[1]): AskInput {
  const input: AskInput = { html: form(text, options) };
  if (flag !== "omit") input.autoSelectRecommended = flag;
  return input;
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
    const result = harness()(ask(text));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("autoSelectRecommended");
  });

  test.each(decisions)("allows the same decision without auto-selection: %s", text => {
    const call = harness();
    expect(call(ask(text, false))).toBeUndefined();
    expect(call(ask(text, "omit"))).toBeUndefined();
  });

  test("blocks the measured HIKARI model choice", () => {
    const input = ask("HIKARI 호출 모델을 어떻게 정할까?", true, { labels: ["implGemini 역할을 따르게", "프록시로 고정"] });
    expect(harness()(input)?.block).toBe(true);
  });

  test("blocks the measured Gemini web fallback choice", () => {
    const input = ask("웹검색에 Gemini 3.8 Flash를 어떻게 붙일까?", true, { labels: ["Luna 실패 때만 Gemini로 폴백", "항상 사용"] });
    expect(harness()(input)?.block).toBe(true);
  });

  test("blocks English provider fallback choices", () => {
    const input = ask("How should web search use Gemini?", true, { labels: ["Fall back to Gemini only if Luna fails", "Always"] });
    expect(harness()(input)?.block).toBe(true);
  });

  test.each([
    ["an option label", { labels: ["기존 데이터 보존", "B"] }],
    ["a context paragraph", { context: "<p>기존 데이터 보존</p>" }],
    ["a context list item", { context: "<ul><li>영향 없음</li><li>기존 데이터 보존</li></ul>" }],
    ["a context table cell", { context: "<table><tr><th>항목</th><th>영향</th></tr><tr><td>데이터</td><td>기존 데이터 보존</td></tr></table>" }],
    ["a context code block", { context: "<pre>기존 데이터 보존</pre>" }],
    ["an image alt", { context: '<img src="data:image/png;base64,AAAA" alt="기존 데이터 보존">' }],
    ["a text field placeholder", { context: '<label>메모 <input type="text" name="note" placeholder="기존 데이터 보존"></label>' }],
    ["a textarea's initial text", { context: '<label>메모 <textarea name="note">기존 데이터 보존</textarea></label>' }],
    ["a text field's initial value", { context: '<label>메모 <input type="text" name="note" value="기존 데이터 보존"></label>' }],
  ] as [string, Parameters<typeof form>[1]][])("inspects the visible text of %s", (_name, options) => {
    expect(harness()(ask("어느 쪽으로 할까?", true, options))?.block).toBe(true);
  });

  test("inspects every question of a multi-question form", () => {
    const html = "<form>" +
      '<fieldset><legend>함수를 나눌까?</legend><label><input type="radio" name="a" value="1" checked> 나눈다</label><label><input type="radio" name="a" value="2"> 둔다</label></fieldset>' +
      '<fieldset><legend>계정을 바꿀까?</legend><label><input type="radio" name="b" value="1" checked> 바꾼다</label><label><input type="radio" name="b" value="2"> 둔다</label></fieldset>' +
      "</form>";
    expect(harness()({ html, autoSelectRecommended: true })?.block).toBe(true);
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
    expect(harness()(ask(text))).toBeUndefined();
  });

  test("does not inspect control names, option values or non-ask tool input", () => {
    // Identifiers are not wording: the old guard ignored question ids the same way.
    const input = ask("함수를 나눌까?", true, { name: "deployment-model-choice" });
    input.html = input.html.replace('value="go"', 'value="deploy-to-production"');
    expect(harness()(input)).toBeUndefined();
    expect(harness()(ask("배포할까?"), "other_tool")).toBeUndefined();
  });

  test("ignores an ask call without an html string", () => {
    const call = harness();
    expect(call({ autoSelectRecommended: true })).toBeUndefined();
    expect(call({ html: 42, autoSelectRecommended: true })).toBeUndefined();
    expect(call(undefined)).toBeUndefined();
  });
});
