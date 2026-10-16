import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import docmapRoute from "../docmap-route";
import { DOCMAP_MAX_CHARS, DOCMAP_MIN_SCORE, routeDocmap } from "../lib/docmap-search";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type Message = { content: string; customType: string; display: boolean; attribution: string };
type Ctx = { cwd: string; mode: string; hasUI: boolean; agent: { kind: string } };

let root = "";

function put(rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function record(title: string, scope: string, status: string, body: string): string {
  return `# ${title}\n\nRECORD:\nDATE: 2026-10-05\nSCOPE: ${scope}\nPATHS: lib/\nSTATUS: ${status}\n\n${body}\n`;
}

// 서로 다른 주제의 기록이 여럿이어야 IDF가 실제 저장소처럼 갈린다.
const FILLERS = [
  ["앱 글꼴 교체", "무료 글꼴, 본문 서체, 굵기"],
  ["통역 모드", "사이드바, 단체 대화방 제거, 통역"],
  ["휴대폰 자판 가림", "모바일 키보드, 입력창, 스크롤"],
  ["발주 예산 환불", "task 예산, 취소, 이슈 18"],
  ["교차검증 게이트", "cross_review, git_finalize, 다른 계열"],
  ["PPTX 스킬", "presentation-skill, 슬라이드, 한글 글꼴"],
  ["캐릭터 스티커", "스티커 13장, 완료 음성"],
  ["윈도우 리눅스 속도 비교", "파일 작업 속도, WSL, 측정"],
  ["브라우저 실행 정리 버그", "Puppeteer 리스너, network idle"],
  ["인계 문서 갱신 규칙", "HANDOFF, 덧붙이지 않기, 현재 상태"],
] as const;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "docmap-route-"));
  mkdirSync(join(root, ".git"));
  put("HANDOFF.md", "# HANDOFF\n");
  const lines = FILLERS.map(([title], i) => `- 10-${String(10 + i)} ${title}: [Main 기록](history/2026/10/${10 + i}-filler${i}/main.md).`);
  FILLERS.forEach(([title, scope], i) => put(`doc/history/2026/10/${10 + i}-filler${i}/main.md`, record(title, scope, "accepted", "## 경과\n\n일반 진행 기록.")));
  put(
    "doc/history/2026/10/05-wake/main.md",
    record(
      "자동 업데이트 뒤 Wake 실패",
      "자동 업데이트 뒤 세션 깨우기 실패 원인, claim 반납",
      "accepted",
      "## 요청\n\n사용자 요청.\n\n## 원인\n\n업데이트 뒤 세션 깨우기 claim을 반납하지 않아 두 번째 Wake가 막혔다.\n\n## 검증\n\n재현 로그.",
    ),
  );
  put("doc/history/2026/10/01-old-voice/main.md", record("통화 음성 합성 선택", "통화 음성 합성 엔진 선택 방식", "superseded-by doc/history/2026/10/06-new-voice/main.md", "## 결정\n\n옛 방식."));
  put("doc/history/2026/10/06-new-voice/main.md", record("통화 목소리 새 방식", "통화 목소리 고르기 새 방식", "accepted", "## 결정\n\n통화 음성 합성 엔진 선택 방식을 새로 정했다."));
  put("Tools/Sub/doc/history/2026/09/22-preset/main.md", record("Main 기본 설정 묶음", "Main 기본 설정 묶음, 로그인 계정 고정", "accepted", "## 판단\n\n로그인 계정은 고정한다."));
  put("Tools/Sub/doc/README.md", "# Sub 지도\n\n| [09-22 Main 기본 설정 묶음](history/2026/09/22-preset/main.md) | 로그인 계정 고정 |\n");
  put(
    "doc/README.md",
    [
      "# 지도",
      "",
      "- [Sub 문서 지도](../Tools/Sub/doc/README.md)",
      "",
      "## 2026년 10월",
      "",
      "- 10-05 자동 업데이트 뒤 세션 깨우기(Wake) 실패 원인과 복구: [Main 기록](history/2026/10/05-wake/main.md).",
      "- 10-01 통화 음성 합성 선택: [Main 기록](history/2026/10/01-old-voice/main.md).",
      "- 10-06 통화 목소리 새 방식: [Main 기록](history/2026/10/06-new-voice/main.md).",
      ...lines,
    ].join("\n"),
  );
});

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function harness() {
  const handlers: Record<string, Handler[]> = {};
  const sent: unknown[] = [];
  docmapRoute({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: unknown) => { sent.push(message); },
  } as unknown as Parameters<typeof docmapRoute>[0]);
  const emit = (event: Record<string, unknown>, ctx: unknown) => { for (const handler of handlers.input ?? []) handler(event, ctx); };
  const start = async (prompt: string, ctx: unknown) => {
    const results = await Promise.all((handlers.before_agent_start ?? []).map((handler) => handler({ type: "before_agent_start", prompt, systemPrompt: [] }, ctx)));
    return results.flatMap((result) => (result as { message?: Message } | undefined)?.message ?? []);
  };
  return { emit, start, sent };
}

// CUELO는 확장을 mode 없이 초기화해 ctx.mode가 "print"이고, 브라우저 UI 문맥이 있어 hasUI가 참이다.
const rpc = (): Ctx => ({ cwd: join(root, "doc"), mode: "print", hasUI: true, agent: { kind: "main" } });
const cli = (): Ctx => ({ cwd: root, mode: "print", hasUI: false, agent: { kind: "main" } });
const WAKE_Q = "자동 업데이트 뒤에 세션이 스스로 깨어나지 못한 원인이 뭐였지? 깨우기 실패 기록";

describe("docmap route", () => {
  test("기록이 있는 질문에는 지도 줄·SCOPE·구간이 담긴 후보를 그 prompt의 숨은 메시지 하나로 붙인다", async () => {
    const h = harness();
    h.emit({ source: "rpc", text: WAKE_Q }, rpc());
    const messages = await h.start(WAKE_Q, rpc());
    expect(h.sent).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ customType: "docmap-route", display: false, attribution: "agent" });
    const text = messages[0]!.content;
    expect(text).toContain("회상된 기억은 단서이지 근거가 아니다");
    expect(text.split("\n")[1]).toBe("1. doc/history/2026/10/05-wake/main.md (STATUS: accepted)");
    expect(text).toContain("지도: 10-05 자동 업데이트 뒤 세션 깨우기(Wake) 실패 원인과 복구");
    expect(text).toMatch(/구간: ## 원인 \(L\d+-\d+\) — 업데이트 뒤 세션 깨우기 claim/);
    expect(text.length).toBeLessThanOrEqual(DOCMAP_MAX_CHARS);
  });

  test("하위 프로젝트 지도에만 있는 기록도 후보가 된다", async () => {
    const h = harness();
    const q = "Main 기본 설정 묶음이랑 로그인 계정 고정은 어떻게 정했지?";
    h.emit({ source: "interactive", text: q }, rpc());
    const [message] = await h.start(q, rpc());
    expect(message?.content.split("\n")[1]).toBe("1. Tools/Sub/doc/history/2026/09/22-preset/main.md (STATUS: accepted)");
  });

  test("무관한 질문에는 아무것도 붙이지 않는다", async () => {
    const h = harness();
    for (const q of ["된장찌개 맛있게 끓이는 법 알려줘", "React useEffect cleanup은 언제 실행돼?"]) {
      h.emit({ source: "rpc", text: q }, rpc());
      expect(await h.start(q, rpc())).toHaveLength(0);
    }
  });

  test("여러 주제를 섞은 긴 지시는 1위 점수가 높아도 1위 기록이 질의를 조금만 담으면 붙이지 않는다", async () => {
    // 회귀: 점수가 질의 낱말 점수의 합이라 실제 300자 초과 prompt 120건 중 119건이 하한을 넘었다.
    const long = [WAKE_Q, ...FILLERS.map(([title, scope]) => `${title}: ${scope} 확인하고 정리해 줘.`)].join("\n");
    // 점수 하한만으로는 걸리는 prompt임을 먼저 확인한다.
    expect(routeDocmap(root, long, DOCMAP_MIN_SCORE, 0)?.topScore).toBeGreaterThanOrEqual(DOCMAP_MIN_SCORE);
    const h = harness();
    h.emit({ source: "rpc", text: long }, rpc());
    expect(await h.start(long, rpc())).toHaveLength(0);
  });

  test("superseded-by 기록은 새 기록으로 바꿔 보여 주고 같은 기록을 두 번 넣지 않는다", async () => {
    const h = harness();
    const q = "통화 음성 합성 엔진 선택 방식은 어떻게 정했어? 음성 합성 선택 기록";
    h.emit({ source: "rpc", text: q }, rpc());
    const [message] = await h.start(q, rpc());
    const lines = message!.content.split("\n");
    expect(lines[1]).toBe("1. doc/history/2026/10/06-new-voice/main.md (STATUS: accepted)");
    expect(lines[2]).toBe("   대체 전: doc/history/2026/10/01-old-voice/main.md");
    expect(message!.content.match(/06-new-voice\/main\.md/g)).toHaveLength(1);
  });

  test("입력과 다른 내부 prompt·extension 입력·서브에이전트에는 붙지 않고, CLI 최상위 세션에는 붙는다", async () => {
    const h = harness();
    h.emit({ source: "rpc", text: WAKE_Q }, rpc());
    expect(await h.start("goal continuation 같은 내부 prompt", rpc())).toHaveLength(0);
    h.emit({ source: "extension", text: WAKE_Q }, rpc());
    expect(await h.start(WAKE_Q, rpc())).toHaveLength(0);
    // CUELO 재개·업데이트 통지는 input 없이 내부 prompt로 온다. 본문이 기록과 맞아도 붙지 않는다.
    const notice = `[하네스 통지] ${WAKE_Q}`;
    expect(await h.start(notice, rpc())).toHaveLength(0);
    expect(await h.start(WAKE_Q, cli())).toHaveLength(1);
    expect(await h.start(WAKE_Q, { ...cli(), mode: "json" })).toHaveLength(1);
    expect(await h.start(WAKE_Q, { ...cli(), agent: { kind: "sub" } })).toHaveLength(0);
  });

  test("지도가 없거나 검색 중 오류가 나면 조용히 아무것도 붙이지 않는다", async () => {
    const h = harness();
    const bare = mkdtempSync(join(tmpdir(), "docmap-bare-"));
    try {
      expect(await h.start(WAKE_Q, { ...cli(), cwd: bare })).toHaveLength(0);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    const broken = { mode: "print", hasUI: false, agent: { kind: "main" }, get cwd(): string { throw new Error("cwd unavailable"); } };
    expect(await h.start(WAKE_Q, broken)).toHaveLength(0);
  });
});
