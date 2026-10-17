import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createDocmapRoute } from "../docmap-route";
import { buildDocmapCorpus, DOCMAP_MAX_CHARS, DOCMAP_MIN_COVERAGE, DOCMAP_MIN_SCORE, docmapQueryTerms, docmapSignals, findDocmapMaps, rankDocmap, routeDocmap } from "../lib/docmap-search";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type Message = { content: string; customType: string; display: boolean; attribution: string };
type Ctx = { cwd: string; mode: string; hasUI: boolean; agent: { kind: string } };

let root = "";

function put(rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// 실제 기록 본문은 길어서 조사·일반어(「에서」「실행」「확인」)가 거의 모든 기록에 나온다. 한 줄짜리 fixture 본문만으로는
// 그것이 드문 낱말처럼 보이므로, 모든 본문에 그런 일상 어휘 문장을 넣는다.
function record(title: string, scope: string, status: string, body: string, date = "2026-10-05"): string {
  return `# ${title}\n\nRECORD:\nDATE: ${date}\nSCOPE: ${scope}\nPATHS: lib/\nSTATUS: ${status}\n\n${body}\n\n진행 기록에서 확인한 내용으로 정리했다. 실행 결과와 설명, 사용자 요청은 아래에 있다.\n`;
}

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "docmap-size-"));
  mkdirSync(join(dir, ".git"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
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
  put("doc/history/2026/10/16-rag/main.md", record("RAG 재조사", "기억 회상 재측정, 문서 지도 탐색 정확도, 무관 질문 주입률", "accepted", "## 결과\n\nRAG 검색 단계별로 놓친 곳을 쟀다.", "2026-10-16"));
  put("doc/history/2026/10/14-wsl-hint/main.md", record("WSL에서 윈도우 실행 힌트", "WSL에서 윈도우 프로그램 실행 안내", "accepted", "## 결정\n\n힌트를 붙였다.", "2026-10-14"));
  // 같은 주제 기록 넷. 13~15는 헤더가 같아 점수가 같고, 16은 SCOPE가 길어 점수가 조금 낮다.
  for (const [dd, extra] of [["13", ""], ["14", ""], ["15", ""], ["16", ", 재측정 후속, 표본 늘림"]] as const) {
    put(`doc/history/2026/10/${dd}-latency/main.md`, record("음성 비서 응답 지연 측정", `음성 비서 응답 지연 측정${extra}`, "accepted", "## 측정\n\n지연을 쟀다.", `2026-10-${dd}`));
  }
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

type JudgeFn = (request: { state: unknown; questions: Record<string, unknown> }, options?: { signal?: AbortSignal }) => Promise<{ answers: Record<string, { type: string; bool?: number } | undefined> }>;

/** 기본 판정기는 모든 후보를 남긴다(낱말 후보 그대로). `judge`를 주면 그 답을 쓰고, `null`이면 판정기 없음. */
function harness(options: { judge?: JudgeFn | null; judgeTimeoutMs?: number } = {}) {
  const handlers: Record<string, Handler[]> = {};
  const sent: unknown[] = [];
  const logs: unknown[] = [];
  let judgeCalls = 0;
  const keepAll: JudgeFn = async (request) => ({ answers: Object.fromEntries(Object.keys(request.questions).map((k) => [k, { type: "bool", bool: 1 }])) });
  const judge = options.judge === undefined ? keepAll : options.judge;
  const route = createDocmapRoute({
    resolveJudge: async () => (judge ? { judge: (request, opts) => { judgeCalls++; return judge(request, opts); } } : undefined),
    judgeTimeoutMs: options.judgeTimeoutMs,
  });
  route({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: unknown) => { sent.push(message); },
    logger: { debug: (...args: unknown[]) => { logs.push(args); }, warn: () => {}, info: () => {} },
  } as unknown as Parameters<typeof route>[0]);
  const emit = (event: Record<string, unknown>, ctx: unknown) => { for (const handler of handlers.input ?? []) handler(event, ctx); };
  const fire = (name: string) => { for (const handler of handlers[name] ?? []) handler({ type: name }, {}); };
  const start = async (prompt: string, ctx: unknown) => {
    const results = await Promise.all((handlers.before_agent_start ?? []).map((handler) => handler({ type: "before_agent_start", prompt, systemPrompt: [] }, ctx)));
    return results.flatMap((result) => (result as { message?: Message } | undefined)?.message ?? []);
  };
  return { emit, fire, start, sent, logs, judgeCalls: () => judgeCalls };
}

// CUELO는 확장을 mode 없이 초기화해 ctx.mode가 "print"이고, 브라우저 UI 문맥이 있어 hasUI가 참이다.
const rpc = (): Ctx => ({ cwd: join(root, "doc"), mode: "print", hasUI: true, agent: { kind: "main" } });
const cli = (): Ctx => ({ cwd: root, mode: "print", hasUI: false, agent: { kind: "main" } });
const WAKE_Q = "자동 업데이트 뒤에 세션이 스스로 깨어나지 못한 원인이 뭐였지? 깨우기 실패 기록";

function signalsFor(base: string, q: string) {
  const corpus = buildDocmapCorpus(base, findDocmapMaps(base, base));
  const terms = docmapQueryTerms(corpus, q);
  return docmapSignals(corpus, rankDocmap(corpus, q, terms)[0]!, terms);
}

function picked(base: string, q: string, now?: Date): string[] {
  return routeDocmap(base, q, now)?.candidates.map((c) => relative(base, c.unit.key).split(sep).join("/")) ?? [];
}

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
    // 점수 조건만으로는 걸리는 prompt임을 먼저 확인한다.
    const signals = signalsFor(root, long);
    expect(signals.score).toBeGreaterThanOrEqual(DOCMAP_MIN_SCORE);
    expect(signals.coverage).toBeLessThan(DOCMAP_MIN_COVERAGE);
    const h = harness();
    h.emit({ source: "rpc", text: long }, rpc());
    expect(await h.start(long, rpc())).toHaveLength(0);
  });

  test("드문 낱말 하나에 조사만 붙은 짧은 질문도 맞는 기록에 붙고, 조사만 맞은 기록은 후보가 아니다", () => {
    // 회귀(2026-10-17 실제 질문): 1위가 정답이었지만 절대 하한 10 미만(5.78)이라 버려졌고, 2위는 「에서」로만 걸렸다.
    const keys = picked(root, "RAG에서 안된것좀찾아바");
    expect(keys[0]).toBe("doc/history/2026/10/16-rag");
    expect(keys).not.toContain("doc/history/2026/10/14-wsl-hint");
  });

  test("기록 수가 1개든 16개든 같은 질문은 같은 기록으로 붙는다", () => {
    // 회귀: 절대 BM25 하한은 기록 1개일 때 정답 4.07로 떨어지고, 무관 기록 15개를 더하면 같은 정답이 22.39로 붙었다.
    const gold = {
      "doc/README.md": "# 지도\n\n- 10-05 세션 깨우기 실패: [Main 기록](history/2026/10/05-wake/main.md).\n",
      "doc/history/2026/10/05-wake/main.md": record("자동 업데이트 뒤 Wake 실패", "자동 업데이트 뒤 세션 깨우기 실패 원인, claim 반납", "accepted", "## 원인\n\nclaim을 반납하지 않았다."),
    };
    const more = ["가계부 앱", "날씨 위젯", "사진 정리", "독서 기록장", "운동 일지"].map((t) => [t, `${t} 화면, 저장 방식`] as const);
    const crowd = Object.fromEntries([...FILLERS, ...more].map(([title, scope], i) => [`doc/history/2026/09/${String(10 + i)}-other${i}/main.md`, record(title, scope, "accepted", "## 경과\n\n일반 진행.")]));
    const alone = repo(gold);
    const crowded = repo({ ...gold, ...crowd });
    try {
      expect(Object.keys(crowd)).toHaveLength(15);
      expect(picked(alone, WAKE_Q)[0]).toBe("doc/history/2026/10/05-wake");
      expect(picked(crowded, WAKE_Q)[0]).toBe("doc/history/2026/10/05-wake");
    } finally {
      rmSync(alone, { recursive: true, force: true });
      rmSync(crowded, { recursive: true, force: true });
    }
  });

  test("긴 배경 뒤에 놓인 질문도 검색한다", () => {
    // 회귀: 앞 1000자만 질의로 써서 붙여 넣은 로그 뒤의 질문에는 후보가 없었다.
    const prompt = `${"at worker.run(job.ts:42) retry=3 code=E_TIMEOUT pid=7781\n".repeat(60)}\n위 로그는 무시하고, ${WAKE_Q}`;
    expect(prompt.length).toBeGreaterThan(2000);
    expect(picked(root, prompt)[0]).toBe("doc/history/2026/10/05-wake");
  });

  test("같은 주제 기록이 여럿이면 최근·날짜 질문에서 그 날짜 기록을 앞에 두고, 점수가 같으면 새 기록이 먼저다", () => {
    // 회귀: 「최근」을 물어도 같은 주제의 13·14·15일 기록이 세 자리를 채워 가장 새 16일 기록이 빠졌다.
    const now = new Date(2026, 9, 17);
    const q = "음성 비서 응답 지연 측정";
    expect(picked(root, `${q} 기록`, now).slice(0, 3)).toEqual(["doc/history/2026/10/15-latency", "doc/history/2026/10/14-latency", "doc/history/2026/10/13-latency"]);
    expect(picked(root, `최근 ${q} 기록 보여줘`, now)[0]).toBe("doc/history/2026/10/16-latency");
    expect(picked(root, `어제 ${q}한 거`, now)[0]).toBe("doc/history/2026/10/16-latency");
    expect(picked(root, `10-14 ${q}`, now)[0]).toBe("doc/history/2026/10/14-latency");
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

  describe("JEV 후보 판정", () => {
    const LAT_Q = "음성 비서 응답 지연 측정 기록";
    const answer = (bools: number[]) => async (request: { questions: Record<string, unknown> }) => ({
      answers: Object.fromEntries(Object.keys(request.questions).map((k, i) => [k, { type: "bool", bool: bools[i] ?? 0 }])),
    });

    test("판정기는 후보마다 bool 질문 하나를 받고, 0.6 이상인 후보만 원래 순서로 남는다", async () => {
      let seen: { state: unknown; questions: Record<string, unknown> } | undefined;
      const h = harness({ judge: async (request) => { seen = request; return answer([0.2, 0.9, 0.6])(request); } });
      h.emit({ source: "rpc", text: LAT_Q }, cli());
      const [message] = await h.start(LAT_Q, cli());
      expect(Object.keys(seen!.questions)).toEqual(["c1", "c2", "c3"]);
      const state = seen!.state as { prompt: string; candidates: { path: string; map?: string; scope?: string; date?: string }[] };
      expect(state.prompt).toBe(LAT_Q);
      expect(state.candidates).toHaveLength(3);
      expect(state.candidates[0]).toMatchObject({ path: "doc/history/2026/10/15-latency/main.md", date: "2026-10-15" });
      expect(state.candidates[0]!.scope).toContain("음성 비서 응답 지연 측정");
      const lines = message!.content.split("\n").filter((l) => /^\d+\. /.test(l));
      expect(lines).toEqual(["1. doc/history/2026/10/14-latency/main.md (STATUS: accepted)", "2. doc/history/2026/10/13-latency/main.md (STATUS: accepted)"]);
      // 0.59는 하한 아래다.
      const h2 = harness({ judge: answer([0.59, 0.6, 0]) });
      h2.emit({ source: "rpc", text: LAT_Q }, cli());
      const [m2] = await h2.start(LAT_Q, cli());
      expect(m2!.content.split("\n").filter((l) => /^\d+\. /.test(l))).toEqual(["1. doc/history/2026/10/14-latency/main.md (STATUS: accepted)"]);
      expect(h.judgeCalls()).toBe(1);
    });

    test("남는 후보가 없으면 아무것도 붙이지 않는다", async () => {
      const h = harness({ judge: answer([0.1, 0.2, 0.3]) });
      h.emit({ source: "rpc", text: LAT_Q }, cli());
      expect(await h.start(LAT_Q, cli())).toHaveLength(0);
      expect(h.judgeCalls()).toBe(1);
    });

    test("판정이 제한 시간 안에 끝나지 않으면 취소하고 낱말 후보를 그대로 붙인다", async () => {
      let aborted = false;
      const h = harness({
        judgeTimeoutMs: 30,
        judge: (_request, options) => new Promise((resolve) => { options?.signal?.addEventListener("abort", () => { aborted = true; }); setTimeout(() => resolve({ answers: {} }), 2_000); }),
      });
      h.emit({ source: "rpc", text: LAT_Q }, cli());
      const t0 = performance.now();
      const [message] = await h.start(LAT_Q, cli());
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(aborted).toBe(true);
      expect(message!.content.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(3);
      expect(JSON.stringify(h.logs)).toContain("제한 시간");
    });

    test("판정기 오류나 판정기 없음은 낱말 후보를 그대로 붙인다", async () => {
      for (const judge of [async () => { throw new Error("judge down"); }, null] as const) {
        const h = harness({ judge });
        h.emit({ source: "rpc", text: LAT_Q }, cli());
        const [message] = await h.start(LAT_Q, cli());
        expect(message!.content.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(3);
      }
    });

    test("실행 중(agent_start~agent_end) 재요청은 판정하지 않고 붙이며, 끝난 뒤 새 요청은 다시 판정한다", async () => {
      const h = harness({ judge: answer([0, 0, 0]) });
      h.fire("agent_start");
      h.emit({ source: "rpc", text: LAT_Q }, cli());
      expect(await h.start(LAT_Q, cli())).toHaveLength(1);
      expect(h.judgeCalls()).toBe(0);
      h.fire("agent_end");
      h.emit({ source: "rpc", text: LAT_Q }, cli());
      expect(await h.start(LAT_Q, cli())).toHaveLength(0);
      expect(h.judgeCalls()).toBe(1);
    });
  });
});
