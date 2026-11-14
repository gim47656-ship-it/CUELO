import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createHelperModelReportGuard, findings, namesOf, REMINDER_TYPE, type HelperModels } from "../helper-model-report-guard";

const SESSION = "01a1d7d1-3e0a-73d7-b068-dfcab44fb971";
const OTHER = "maker-child-session";

// 2026-11-14 실제 원장 모양: Main 검토 3회(아스트라 ok, 하이드로젠 보조 ok 2회·late 1회), Maker가 자기 세션에서 돌린 검토,
// 이 세션의 발주(Opus, Sonnet).
const LEDGER = [
  { type: "cross-review", sessionId: SESSION, reviewId: "xr-20261114063555-908616", reviewers: [{ model: "openai-codex/gpt-6-astra", status: "ok" }], advisory: { model: "google-vertex/gemini-4-hydrogen", status: "ok" } },
  { type: "cross-review", sessionId: SESSION, reviewId: "xr-20261114064859-1ddbe5", reviewers: [{ model: "openai-codex/gpt-6-astra", status: "ok" }], advisory: { model: "google-vertex/gemini-4-hydrogen", status: "late" } },
  { type: "cross-review", sessionId: OTHER, reviewId: "xr-20261114054440-e79c70", reviewers: [{ model: "openai-codex/gpt-6-astra", status: "ok" }] },
  { type: "cross-review", sessionId: "vm-maker-session", reviewId: "xr-20261114055840-0c4aa7", reviewers: [{ model: "openai-codex/gpt-6.1-sol", status: "ok" }] },
  { type: "cross-review", sessionId: "unrelated", reviewId: "xr-20261114000130-5a43bf", reviewers: [{ model: "anthropic/claude-fable-5-2", status: "ok" }] },
  { type: "dispatch", sessionId: SESSION, chosenModel: "anthropic/claude-opus-5-5" },
  { type: "dispatch", sessionId: SESSION, chosenModel: "anthropic/claude-sonnet-5-5" },
  { type: "dispatch", sessionId: "unrelated", chosenModel: "openai-codex/gpt-6.1-sol" },
];

const SLOP_RESULT = JSON.stringify({ reviewId: "slop-1", reviewers: [{ family: "openai", model: "openai-codex/gpt-6-luna", status: "ok" }], files: [] });
const BRANCH = [
  { type: "message", message: { role: "toolResult", toolName: "slop_check", content: [{ type: "text", text: SLOP_RESULT }] } },
  // Maker 보고에 나온 Maker 세션의 검토 id: child 보고이므로 그 검토자도 센다.
  { type: "custom_message", customType: "async-result", content: "M2Settings done. cross_review chain xr-20261114054440-e79c70 resolved." },
  // Main이 Maker의 체인을 resolve한 호출 인자의 검토 id도 센다.
  { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "cross_review", arguments: { action: "resolve", reviewId: "xr-20261114055840-0c4aa7" } }] } },
  // 원장을 훑은 bash 결과에 섞인 다른 날 검토 id는 세지 않는다(2026-11-14 첫 실측의 오염 경로).
  { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "xr-20261114000130-5a43bf False ['anthropic/claude-fable-5-2']" }] } },
];

// 2026-11-14 실제 오보.
const WRONG = "도와준 모델은 아래와 같아요.\n- 구현 Maker 4개: 공용 화면은 Opus, 설정, 보조 패널, VM 장치는 각각 Sonnet\n- 코드 교차 검토: GPT 쪽 검토자\n- 문구 점검: Luna";
const RIGHT = "- 구현 Maker 4개: 공용 화면은 Opus, 나머지는 Sonnet\n- 코드 교차 검토(필수): 아스트라\n- 코드 교차 검토(보조): 하이드로젠\n- 문구 점검: 루나";
// 2026-11-14 이 장치 배포 직후 Main의 완료 보고 원문(오탐 회귀용).
const GUARD_REPORT = "장치를 만들어 0.10.256으로 집 PC에 배포했어요. 공개 CI 성공과 배포 검증 네 항목 통과를 확인했고, 실행 중인 런타임에서 확장이 정상적으로 불러와지는 것까지 봤어요.\n\n**도움 모델 명단 확인 장치:** 제가 작업을 끝내며 보고할 때 교차 검토, 문구 점검, Maker 같은 역할이 나오면, 그 세션에서 실제로 답한 모델을 기록에서 찾아 보고 내용과 맞춰 봐요. 기록은 발주와 검토 원장, 검토 도구 결과예요. 세 경우에 숨은 알림이 와서 실제 이름으로 바로 정정하게 해요.\n- \"GPT 쪽\"처럼 제공사 계열만 적은 경우\n- 그 역할의 실제 모델 이름이 하나도 없는 경우\n- 그 역할로 답하지 않은 모델을 적은 경우\n\n보고를 막지는 않아요. 화면에 이미 나간 뒤에 바로잡는 방식이에요. 오늘 틀렸던 보고 문장을 이 세션의 실제 기록에 넣어 보니 두 가지를 다 잡았어요. 계열만 적은 것과 검토자 이름이 없는 것이에요. 실제 명단도 아스트라, 하이드로젠, 루나, 오퍼스, 소네트로 정확히 나왔고, 고친 보고에는 아무 알림도 뜨지 않았어요.\n\n**만들면서 고친 결함:** 처음 실제 데이터로 돌렸을 때, 제가 원장을 뒤지던 bash 결과에 섞인 다른 날의 검토 기록까지 주워 담았어요. 그래서 이번 세션에 없던 오퍼스와 페이블이 검토자로 끼었어요. 검토 기록은 제가 직접 부른 검토 호출과 Maker 보고에서만 모으게 바꿨고, 그 뒤 명단이 맞게 나왔어요.\n\n**교차 검토:** 필수 검토는 아스트라, 보조 검토는 하이드로젠이 네 번에 걸쳐 맡았어요. 지적은 아홉 건이었어요. 그중 여덟 건은 고쳤고, 각 재현 테스트가 고치기 전 코드에서 실패하는 것도 확인했어요. 마지막 한 건은 의도한 한계로 남겼어요. 역할 줄 다음의 일반 설명 문장까지 검사하면, 정상적인 설명에도 알림이 뜨기 때문이에요. 테스트는 집중 11개와 확장 전체 1918개가 모두 통과했어요.\n\n**정정 한 가지:** 앞선 정정 보고에서 하이드로젠이 Vertex 경로로 답했다고 했는데, 정확히는 제 검토 세 번 중 두 번만 제때 답했어요. 한 번은 늦어서 기록만 남았어요. 장치도 제때 답한 경우만 세요.\n\n**배포 중 생긴 일:** 공개 CI 첫 실행에서 두 작업이 실패했어요. zig 도구를 내려받는 외부 서버가 접속을 거부한 탓이에요. 실패한 작업만 다시 돌리니 모두 통과했고, 그 뒤에 배포했어요.\n\n규칙 표에서 이 규칙은 \"글로만 있음\"에서 \"안내 장치\"로 올렸어요. 다만 몇 개를 썼는지와 왜 썼는지 알리는 부분은 여전히 글 규칙이에요. 실제 사용에서 알림이 틀린 명단에만 붙는지는 11-21까지 지켜보고, 오탐이 없으면 닫을게요. 임시 로그는 지웠어요. 출처를 모르는 `/tmp/ci-watch.txt` 하나는 그대로 뒀어요. 요청하신 장치는 완성됐어요.";

function harness(kind: "main" | "sub" = "main", ledger: readonly object[] = LEDGER) {
  const handlers: Record<string, ((event: Record<string, unknown>, ctx: unknown) => unknown)[]> = {};
  const sent: { customType: string; content: string }[] = [];
  createHelperModelReportGuard({ readLedger: () => ledger as never })({
    on: (name: string, handler: (event: Record<string, unknown>, ctx: unknown) => unknown) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: { customType: string; content: string }) => { sent.push(message); },
  } as unknown as ExtensionAPI);
  const ctx = { agent: { kind }, sessionManager: { getBranch: () => BRANCH, getSessionId: () => SESSION } };
  const emit = (name: string, event: Record<string, unknown>) => { for (const handler of handlers[name] ?? []) handler(event, ctx); };
  return {
    sent,
    user: (text: string) => emit("message_start", { message: { role: "user", content: text } }),
    assistant: (text: string, tools: string[] = []) => emit("message_end", { message: { role: "assistant", content: [{ type: "text", text }, ...tools.map((name) => ({ type: "toolCall", name }))] } }),
  };
}

function helpers(review: string[], slop: string[] = [], maker: string[] = []): HelperModels {
  return { review: new Set(review), slop: new Set(slop), maker: new Set(maker) };
}

describe("helper-model-report-guard", () => {
  test("모델 id에서 라틴 이름과 한글 이름을 뽑는다", () => {
    expect(namesOf("openai-codex/gpt-6-astra")).toEqual(["astra", "아스트라", "유키"]);
    expect(namesOf("anthropic/claude-opus-5-5")).toEqual(["opus", "오퍼스", "오푸스"]);
    expect(namesOf("openai-codex/gpt-6.1-sol")).toEqual(["sol", "솔"]);
    expect(namesOf("hive/deepseek-ai/deepseek-v4.1-flash-1017")).toEqual(["deepseek", "딥시크", "이사나"]);
  });

  test("실제 오보(계열만 적은 검토자)에 알리고 실제 명단을 준다", () => {
    const h = harness();
    h.user("장치로만들자.");
    h.assistant(WRONG);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].customType).toBe(REMINDER_TYPE);
    expect(h.sent[0].content).toContain("「GPT 쪽」");
    expect(h.sent[0].content).toContain("코드 교차 검토의 실제 모델 이름이 없다");
    expect(h.sent[0].content).toContain("아스트라(openai-codex/gpt-6-astra)");
    // 제때 답한 보조 검토가 한 번 있었으므로 하이드로젠도 명단에 든다. 이 세션과 무관한 페이블은 들지 않는다.
    expect(h.sent[0].content).toContain("하이드로젠(google-vertex/gemini-4-hydrogen)");
    expect(h.sent[0].content).not.toContain("fable");
    // Main이 resolve한 Maker 체인의 검토자는 든다.
    expect(h.sent[0].content).toContain("솔(openai-codex/gpt-6.1-sol)");
    expect(h.sent[0].content).toContain("루나(openai-codex/gpt-6-luna)");
  });

  test("실제 이름을 적은 보고, 역할 말이 없는 답, 도구 사이 진행 문장, 하위 agent에는 알리지 않는다", () => {
    const h = harness();
    h.user("보고해 줘");
    h.assistant(RIGHT);
    h.assistant("배포가 끝났어요. 서버 네 곳이 정상이에요.");
    h.assistant("코드 교차 검토를 GPT 쪽 검토자에게 보낼게요.", ["cross_review"]);
    expect(h.sent).toHaveLength(0);
    const sub = harness("sub");
    sub.assistant(WRONG);
    expect(sub.sent).toHaveLength(0);
  });

  test("사용자 입력 하나에 한 번만 알린다", () => {
    const h = harness();
    h.user("보고해 줘");
    h.assistant(WRONG);
    h.assistant(WRONG);
    expect(h.sent).toHaveLength(1);
    h.user("다시");
    h.assistant(WRONG);
    expect(h.sent).toHaveLength(2);
  });

  test("계열과 실제 이름을 함께 적은 줄과 역할과 무관한 계열 설명은 계열만 적은 것이 아니다", () => {
    expect(findings("- 코드 교차 검토: GPT 계열 아스트라", helpers(["openai-codex/gpt-6-astra"]))).toEqual([]);
    expect(findings("- 코드 교차 검토: 아스트라\n검토 경로는 Anthropic 작성이면 GPT 쪽으로 간다.", helpers(["openai-codex/gpt-6-astra"]))).toEqual([]);
    // 역할 말이 없으면 계열 표현이 있어도 판정하지 않는다.
    expect(findings("Anthropic 쪽 한도가 찼어요.", helpers(["openai-codex/gpt-6-astra"]))).toEqual([]);
    // 실제 모델을 모르는 역할(Maker) 줄의 계열 표현도 판정하지 않는다(교차검토 R1-OAI-2).
    expect(findings("reviewer: Astra\nMaker: GPT 쪽", helpers(["openai-codex/gpt-6-astra"]))).toEqual([]);
  });

  test("역할 말 아래 목록 항목은 그 역할의 줄로 본다", () => {
    // 교차검토 R2-OAI-1: 제목 줄에만 역할 말이 있고 항목에 계열만 적은 경우.
    expect(findings("reviewer:\n- Astra\n- GPT 쪽", helpers(["openai-codex/gpt-6-astra"]))).toEqual([{ kind: "family-only", phrase: "GPT 쪽" }]);
    // 목록이 끝나고 이어진 일반 문장은 역할을 물려받지 않는다.
    expect(findings("reviewer:\n- Astra\n\n검토 경로는 GPT 쪽으로 간다.", helpers(["openai-codex/gpt-6-astra"]))).toEqual([]);
    // 목록 항목의 다른 모델 이름도 그 역할의 오답이다.
    expect(findings("코드 교차 검토:\n- 아스트라\n- 페이블", helpers(["openai-codex/gpt-6-astra"]))).toEqual([{ kind: "other-model", role: "review", name: "페이블" }]);
    // R3-OAI-2, R3-ADV-2: 들여쓴 이어 줄과 제목 뒤 빈 줄 다음의 목록도 같은 역할이다.
    expect(findings("reviewer:\n  Astra\n  GPT 쪽", helpers(["openai-codex/gpt-6-astra"]))).toEqual([{ kind: "family-only", phrase: "GPT 쪽" }]);
    expect(findings("reviewer:\n\n- Astra\n- GPT 쪽", helpers(["openai-codex/gpt-6-astra"]))).toEqual([{ kind: "family-only", phrase: "GPT 쪽" }]);
    // R3-OAI-1, R3-ADV-1: 실제 모델을 모르는 역할의 목록 항목은 앞 역할을 물려받지 않는다.
    expect(findings("reviewer: Astra\n- Maker: GPT 쪽", helpers(["openai-codex/gpt-6-astra"]))).toEqual([]);
    expect(findings("- reviewer: Astra\n- Maker: Fable", helpers(["openai-codex/gpt-6-astra"]))).toEqual([]);
  });

  test("라틴 이름은 식별자 경계로만 센다", () => {
    // 교차검토 R1-OAI-1: astra_backup, astra2는 아스트라라는 이름이 아니다. 모델 id 안의 이름은 센다.
    expect(findings("reviewer: astra_backup", helpers(["openai-codex/gpt-6-astra"]))).toEqual([{ kind: "missing", role: "review" }]);
    expect(findings("reviewer: astra2", helpers(["openai-codex/gpt-6-astra"]))).toEqual([{ kind: "missing", role: "review" }]);
    expect(findings("reviewer: openai-codex/gpt-6-astra", helpers(["openai-codex/gpt-6-astra"]))).toEqual([]);
  });

  test("모양이 깨진 원장 줄은 건너뛰고 나머지 근거로 판정한다", () => {
    // 교차검토 R1-OAI-3: reviewers가 배열이 아니거나 원소가 null이어도 예외 없이 slop_check 근거로 알린다.
    const h = harness("main", [{ type: "cross-review", sessionId: SESSION, reviewers: {} }, { type: "cross-review", sessionId: SESSION, reviewers: [null], advisory: null }, null]);
    h.user("report");
    expect(() => h.assistant("문구 점검: GPT 쪽")).not.toThrow();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].content).toContain("루나(openai-codex/gpt-6-luna)");
  });

  test("역할 줄에 그 역할에서 답하지 않은 모델을 적으면 알린다", () => {
    expect(findings("- 코드 교차 검토: 페이블", helpers(["openai-codex/gpt-6-astra"]))).toEqual([
      { kind: "missing", role: "review" },
      { kind: "other-model", role: "review", name: "페이블" },
    ]);
    // 다른 역할 줄의 이름(Maker의 Opus)은 검토 줄의 오답이 아니다.
    expect(findings("- 구현 Maker: Opus\n- 코드 교차 검토: 아스트라", helpers(["openai-codex/gpt-6-astra"], [], ["anthropic/claude-opus-5-5"]))).toEqual([]);
  });

  test("늦거나 실패한 보조 검토자만 있으면 그 이름을 실제 명단에 넣지 않는다", () => {
    const ledger = [{ type: "cross-review", sessionId: SESSION, reviewId: "xr-20261114064859-1ddbe5", reviewers: [{ model: "openai-codex/gpt-6-astra", status: "ok" }], advisory: { model: "google-vertex/gemini-4-hydrogen", status: "late" } }];
    const h = harness("main", ledger);
    h.user("보고");
    h.assistant("- 코드 교차 검토: 아스트라, 하이드로젠");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].content).toContain("「하이드로젠」");
    expect(h.sent[0].content).not.toContain("하이드로젠(");
  });

  test("실제 모델을 모르는 역할은 판정하지 않는다", () => {
    const h = harness("main", []);
    h.user("보고");
    h.assistant("- 코드 교차 검토: GPT 쪽 검토자");
    // 원장이 비어도 세션 기록의 slop_check 명단은 있지만, 보고가 말한 역할(교차 검토)의 실제 모델은 모른다.
    expect(h.sent).toHaveLength(0);
  });

  test("이 장치를 설명한 실제 완료 보고(인용 예시, 긴 설명 문단)에는 알리지 않는다", () => {
    // 2026-11-14 0.10.256 배포 직후 Main의 완료 보고 원문. 따옴표 안의 "GPT 쪽" 예시와 실제 명단, 오염 사례를 늘어놓은
    // 긴 문단을 틀린 명단으로 읽어 계열만 적음 1건과 다른 모델 5건을 냈다.
    const real = helpers(["openai-codex/gpt-6-astra", "aistudio/gemini-4-hydrogen", "google-vertex/gemini-4-hydrogen"], ["openai-codex/gpt-6-luna"], ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5"]);
    expect(findings(GUARD_REPORT, real)).toEqual([]);
    // 같은 보고라도 명단 줄(목록 항목)에 계열만 적으면 여전히 잡는다.
    expect(findings(`${GUARD_REPORT}\n\n- 코드 교차 검토: GPT 쪽 검토자`, real)).toEqual([{ kind: "family-only", phrase: "GPT 쪽" }]);
  });
});
