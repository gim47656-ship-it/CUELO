import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { analyzeGuardEffects } from "../../../evals/analyze-guard-effects.mjs";
import { analyzeLessonRecurrence } from "../../../evals/analyze-lesson-recurrence.mjs";
import draft from "../draft";
import * as realPdf from "../draft/pdf";
import skim, { DEEPSEEK, GEMINI } from "../skim";

// bun `mock.module`은 이미 import한 모듈의 live export를 바꾼다. 되돌릴 원본은 어떤 mock보다 먼저 값으로 잡아 둔다.
const ORIGINAL_PDF = { findEdge: realPdf.findEdge, renderPdf: realPdf.renderPdf };

// 실제 SDK 경로 통합 회귀: 모델이 skim·draft 도구를 부르면 AgentSession의 tool 실행 → 확장 wrapper →
// 세션 toolResult(isError)까지 간다. 부모·helper 모델은 모두 무과금 fake다(부모는 stream 함수, helper는
// 로컬 OpenAI 호환 서버). 역할 설정이 가리키는 모델이 실제로 불리는지, usage가 그 모델에 귀속되는지도 본다.

const GLM = "fakeglm/glm-fake";
const IMAGE_ONLY = "fakeglm/image-only";
type Behavior = "ok" | "fail" | "empty";

const roots: string[] = [];
const requested: string[] = [];
const behavior: Record<string, Behavior> = {};
let server: ReturnType<typeof Bun.serve>;
/** 요청이 서버에 닿는 순간 실행할 일(예: draft 저장 직전에 대상 파일을 먼저 만들어 저장 실패를 만든다). */
let onRequest: (() => void) | undefined;

beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string };
    // antigravity 계열은 wire 이름에 추론 강도 접미사(-low)를 붙인다. 모델 id 비교는 접미사를 뗀 값으로 한다.
    body.model = body.model.replace(/-low$/, "");
    requested.push(body.model);
    onRequest?.();
    const mode = behavior[body.model] ?? "ok";
    if (mode === "fail") return new Response(JSON.stringify({ error: { message: `${body.model} synthetic outage` } }), { status: 400, headers: { "content-type": "application/json" } });
    const base = { id: `fake-${requested.length}`, object: "chat.completion.chunk", created: 0, model: body.model };
    const chunks = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: mode === "empty" ? "" : `# 결과\n\n${body.model} 가 쓴 본문 (guide.md:L1)` }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { ...base, choices: [], usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 } },
    ];
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
});
afterAll(() => server.stop(true));
afterEach(() => {
  requested.length = 0;
  onRequest = undefined;
  for (const key of Object.keys(behavior)) delete behavior[key];
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const spec = (id: string, input: ("text" | "image")[] = ["text"]) => ({
  id, name: id, reasoning: false, input, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
});

interface Outcome { isError: boolean; text: string; sessionsDir: string; usage: Array<[string | undefined, string | undefined, string, string]> }

/** hooks: 해당 모델 id의 자격 조회 또는 비용 장부 저장이 던지게 한다(실제 저장소·자격 갱신 실패를 흉내 낸다). */
interface Hooks { apiKeyThrows?: string; usageThrows?: string }

/** 부모 모델이 도구를 한 번 부르고 끝나는 세션을 돌려 세션에 남은 toolResult를 읽는다. */
async function callTool(name: "skim" | "draft", args: Record<string, unknown>, roles: { skim?: string; draft?: string }, cwd?: string, hooks: Hooks = {}): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), "helper-contract-"));
  roots.push(root);
  const work = cwd ?? join(root, "work");
  mkdirSync(work, { recursive: true });
  if (!existsSync(join(work, "guide.md"))) writeFileSync(join(work, "guide.md"), "첫 줄\n");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  // 세션은 넘겨 준 registry/authStorage를 닫지 않는다. agent.db 핸들은 이 fixture가 직접 닫는다(Windows 삭제 잠금 방지).
  const auth = await AuthStorage.create(join(agentDir, "agent.db"));
  const registry = new ModelRegistry(auth, join(agentDir, "models.yml"));
  const baseUrl = `http://127.0.0.1:${server.port}/v1`;
  const provider = { baseUrl, apiKey: "local", api: "openai-completions" as const };
  registry.registerProvider("fakeparent", { ...provider, models: [spec("parent")] });
  registry.registerProvider("fakeglm", { ...provider, models: [spec("glm-fake"), spec("image-only", ["image"])] });
  registry.registerProvider("google-antigravity", { ...provider, models: [spec("gemini-3.8-flash")] });
  registry.registerProvider("b-ai", { ...provider, models: [spec("deepseek-v4.1-flash")] });
  const model = registry.find("fakeparent", "parent")!;
  const getApiKey = registry.getApiKey.bind(registry);
  registry.getApiKey = (async (target: { id: string }, ...rest: unknown[]) => {
    if (target.id === hooks.apiKeyThrows) throw new Error("credential refresh down");
    return (getApiKey as (...args: unknown[]) => Promise<string | undefined>)(target, ...rest);
  }) as never;
  const settings = Settings.isolated({ modelRoles: roles, tools: { approvalMode: "yolo" } } as never);
  const sessionsDir = join(root, "sessions");
  const sessionManager = SessionManager.create(work, sessionsDir);
  const appendModelUsage = sessionManager.appendModelUsage.bind(sessionManager);
  sessionManager.appendModelUsage = ((entry: { model: string }, ...rest: unknown[]) => {
    if (entry.model === hooks.usageThrows) throw new Error("ledger write failed");
    return (appendModelUsage as (...args: unknown[]) => unknown)(entry, ...rest);
  }) as never;
  const { session } = await createAgentSession({
    cwd: work, agentDir, model, modelRegistry: registry, settings, sessionManager,
    extensions: [skim, draft], disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, skipPythonPreflight: true,
    skills: [], rules: [], contextFiles: [], toolNames: ["skim", "draft"],
  });
  let turn = 0;
  session.agent.streamFn = ((_model: unknown) => {
    const stream = createAssistantMessageEventStream();
    const first = turn++ === 0;
    const message = {
      role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: first ? [{ type: "toolCall" as const, id: "call-1", name, arguments: args }] : [{ type: "text" as const, text: "done" }],
      stopReason: first ? "toolUse" as const : "stop" as const,
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (first) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as never, partial: message });
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end();
    });
    return stream;
  }) as never;
  try {
    await session.prompt("run the tool");
    const result = session.agent.state.messages.find((message) => message.role === "toolResult") as
      { isError: boolean; content: Array<{ type: string; text?: string }> } | undefined;
    expect(result).toBeDefined();
    const usage = sessionManager.getEntries().filter((entry) => entry.type === "model_usage")
      .map((entry) => [entry.role, entry.purpose, entry.provider, entry.model] as Outcome["usage"][number]);
    await sessionManager.flush();
    return { isError: result!.isError, text: result!.content.map((part) => part.text ?? "").join(""), sessionsDir, usage };
  } finally {
    await session.dispose();
    await sessionManager.close();
    auth.close();
  }
}

describe("helper tool result contract through the SDK", () => {
  test("기본 설정: Gemini 슬롯 성공은 정상 toolResult이고 사용량은 그 모델에 귀속된다", async () => {
    const out = await callTool("skim", { paths: ["guide.md"], question: "?" }, { skim: GEMINI });
    expect(out.isError).toBe(false);
    expect(out.text).toContain(`model: ${GEMINI}`);
    expect(requested).toEqual(["gemini-3.8-flash"]);
    expect(out.usage).toEqual([["skim", "skim", "google-antigravity", "gemini-3.8-flash"]]);
  });

  test("역할만 바꾼 설정: 해석된 다른 모델이 실제로 불리고 표시·사용량이 그 모델이다", async () => {
    const out = await callTool("skim", { paths: ["guide.md"], question: "?" }, { skim: GLM });
    expect(out.isError).toBe(false);
    expect(out.text).toContain(`model: ${GLM}`);
    expect(out.text).not.toContain(GEMINI);
    expect(requested).toEqual(["glm-fake"]);
    expect(out.usage).toEqual([["skim", "skim", "fakeglm", "glm-fake"]]);
  });

  test("slot 모델 실패 뒤 DeepSeek 성공은 오류가 아니며 실패 경위와 두 시도의 사용량이 남는다", async () => {
    behavior["glm-fake"] = "fail";
    const out = await callTool("skim", { paths: ["guide.md"], question: "?" }, { skim: GLM });
    expect(out.isError).toBe(false);
    expect(out.text.startsWith(`model: ${DEEPSEEK}`)).toBe(true);
    expect(out.text).toContain(`${GLM} 실패:`);
    expect(out.text).toContain("synthetic outage");
    expect(requested).toEqual(["glm-fake", "deepseek-v4.1-flash"]);
    expect(out.usage.map((row) => row[3])).toEqual(["glm-fake", "deepseek-v4.1-flash"]);
  });

  test("두 모델이 모두 실패하면 세션 toolResult.isError가 true이고 본문에 두 원인이 남는다", async () => {
    behavior["glm-fake"] = "fail";
    behavior["deepseek-v4.1-flash"] = "fail";
    const out = await callTool("skim", { paths: ["guide.md"], question: "?" }, { skim: GLM });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("model: none");
    expect(out.text).toContain(`${GLM} 실패:`);
    expect(out.text).toContain("DeepSeek 실패:");
    expect(requested).toEqual(["glm-fake", "deepseek-v4.1-flash"]);
  });

  test("slot이 고정 대체와 같은 DeepSeek로 해석돼 실패하면 같은 모델을 다시 부르지 않고 오류로 끝난다", async () => {
    behavior["deepseek-v4.1-flash"] = "fail";
    const out = await callTool("skim", { paths: ["guide.md"], question: "?" }, { skim: DEEPSEEK });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("다시 호출하지 않았습니다");
    expect(requested).toEqual(["deepseek-v4.1-flash"]);
  });

  test("텍스트 입력이 없는 모델로 설정되면 호출 없이 그 모델 이름으로 실패하고 DeepSeek 대체로 이어진다", async () => {
    const out = await callTool("skim", { paths: ["guide.md"], question: "?" }, { skim: IMAGE_ONLY });
    expect(out.isError).toBe(false);
    expect(out.text).toContain(`${IMAGE_ONLY} 실패: ${IMAGE_ONLY}은 텍스트 입력을 지원하지 않아`);
    expect(out.text.startsWith(`model: ${DEEPSEEK}`)).toBe(true);
    expect(requested).toEqual(["deepseek-v4.1-flash"]);
  });

  test("보낼 텍스트가 없는 입력은 모델을 부르지 않고 오류도 아니다", async () => {
    const out = await callTool("skim", { paths: ["missing-dir/none.md"], question: "?" }, { skim: GLM });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("model: none");
    expect(requested).toEqual([]);
  });

  test("draft: 설정된 모델이 쓴 초안을 저장하고 정상 결과로 돌려준다", async () => {
    const root = mkdtempSync(join(tmpdir(), "helper-contract-work-"));
    roots.push(root);
    const out = await callTool("draft", { instruction: "보고서", output: "out.md" }, { draft: GLM }, root);
    expect(out.isError).toBe(false);
    expect(out.text).toContain(`model: ${GLM}`);
    expect(readFileSync(join(root, "out.md"), "utf8")).toContain("glm-fake 가 쓴 본문");
    expect(out.usage).toEqual([["draft", "draft", "fakeglm", "glm-fake"]]);
  });

  test("draft: 두 모델이 모두 실패하면 파일 없이 isError toolResult를 돌려준다", async () => {
    behavior["glm-fake"] = "fail";
    behavior["deepseek-v4.1-flash"] = "fail";
    const root = mkdtempSync(join(tmpdir(), "helper-contract-work-"));
    roots.push(root);
    const out = await callTool("draft", { instruction: "보고서", output: "out.md" }, { draft: GLM }, root);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("DeepSeek 실패:");
    expect(existsSync(join(root, "out.md"))).toBe(false);
  });

  test("draft: fallback으로 받은 초안의 저장이 실패하면 처음 실패 경위·모델·경로·원인을 모두 담은 isError이고 먼저 있던 파일을 건드리지 않는다", async () => {
    behavior["glm-fake"] = "fail";
    const root = mkdtempSync(join(tmpdir(), "helper-contract-work-"));
    roots.push(root);
    // 대상은 호출 전에는 없다(없어야 대상 확인을 통과한다). 모델 응답을 기다리는 사이 다른 쓰기가 같은 이름을 만든다.
    onRequest = () => writeFileSync(join(root, "out.md"), "RACED");
    const out = await callTool("draft", { instruction: "보고서", output: "out.md" }, { draft: GLM }, root);
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`${GLM} 실패:`);
    expect(out.text).toContain(`${DEEPSEEK}의 초안은 받았지만 out.md 저장에 실패했습니다:`);
    expect(readFileSync(join(root, "out.md"), "utf8")).toBe("RACED");
    expect(out.usage.map((row) => row[3])).toEqual(["glm-fake", "deepseek-v4.1-flash"]);
  });

  test("draft: fallback으로 받은 초안의 PDF 변환이 실패하면 처음 실패 경위와 저장하지 않았다는 상태·원인을 담은 isError이고 사용량은 남는다", async () => {
    behavior["glm-fake"] = "fail";
    const root = mkdtempSync(join(tmpdir(), "helper-contract-work-"));
    roots.push(root);
    // 실제 Windows Edge를 띄우지 않도록 PDF 백엔드만 대체한다. 끝나면 미리 잡아 둔 원본 값으로 되돌리고 identity를 확인한다.
    mock.module("../draft/pdf", () => ({ findEdge: async () => "mock-edge", renderPdf: async () => { throw new Error("mock Edge print failed"); } }));
    try {
      expect(realPdf.renderPdf).not.toBe(ORIGINAL_PDF.renderPdf);
      const out = await callTool("draft", { instruction: "보고서", output: "out.pdf" }, { draft: GLM }, root);
      expect(out.isError).toBe(true);
      expect(out.text).toContain(`${GLM} 실패:`);
      expect(out.text).toContain(`${DEEPSEEK}의 초안은 받았지만 PDF 변환에 실패해 저장하지 않았습니다: mock Edge print failed`);
      expect(existsSync(join(root, "out.pdf"))).toBe(false);
      expect(out.usage.map((row) => row[3])).toEqual(["glm-fake", "deepseek-v4.1-flash"]);
    } finally {
      mock.module("../draft/pdf", () => ORIGINAL_PDF);
    }
    expect(realPdf.findEdge).toBe(ORIGINAL_PDF.findEdge);
    expect(realPdf.renderPdf).toBe(ORIGINAL_PDF.renderPdf);
  });

  test("slot 모델의 자격 갱신이 던져도 실패는 그 모델 이름으로 남고 DeepSeek 대체는 한 번 이어진다", async () => {
    const out = await callTool("skim", { paths: ["guide.md"], question: "?" }, { skim: GLM }, undefined, { apiKeyThrows: "glm-fake" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain(`${GLM} 실패: credential refresh down`);
    expect(out.text).not.toContain("Gemini 실패");
    expect(out.text.startsWith(`model: ${DEEPSEEK}`)).toBe(true);
    expect(requested).toEqual(["deepseek-v4.1-flash"]);
  });

  test("slot이 DeepSeek일 때 비용 장부 저장이 던지면 실제 저장 실패를 DeepSeek 이름으로 알리고 같은 모델을 다시 부르지 않는다", async () => {
    const out = await callTool("skim", { paths: ["guide.md"], question: "?" }, { skim: DEEPSEEK }, undefined, { usageThrows: "deepseek-v4.1-flash" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("DeepSeek 실패: ledger write failed");
    expect(out.text).toContain("다시 호출하지 않았습니다");
    expect(out.text).not.toContain("Gemini 실패");
    expect(requested).toEqual(["deepseek-v4.1-flash"]);
  });

  test("실제로 남은 세션 transcript를 두 분석기가 읽는다: 최종 실패는 오류로, 성공한 fallback은 오류 없이 센다", async () => {
    behavior["glm-fake"] = "fail";
    behavior["deepseek-v4.1-flash"] = "fail";
    const failed = await callTool("skim", { paths: ["guide.md"], question: "?" }, { skim: GLM });
    behavior["deepseek-v4.1-flash"] = "ok";
    const fallback = await callTool("skim", { paths: ["guide.md"], question: "?" }, { skim: GLM });
    expect([failed.isError, fallback.isError]).toEqual([true, false]);
    const lesson = { id: "helper-final-failure", since: "2000-01-01T00:00:00Z", pattern: "model: none", callPattern: "guide\\.md" };
    const guard = (dir: string) => analyzeGuardEffects({ sessionsDir: dir, since: undefined, until: undefined }).weeks.reduce((sum: number, week: { toolErrors: number }) => sum + week.toolErrors, 0);
    const recurrence = (dir: string) => analyzeLessonRecurrence({ lessons: [lesson], sessionsDir: dir, ledgerPath: undefined })[0]!.after;
    expect(guard(failed.sessionsDir)).toBe(1);
    expect(recurrence(failed.sessionsDir)).toMatchObject({ calls: 1, matches: 1, episodes: 1 });
    expect(guard(fallback.sessionsDir)).toBe(0);
    expect(recurrence(fallback.sessionsDir)).toMatchObject({ calls: 1, matches: 0 });
  });
});
