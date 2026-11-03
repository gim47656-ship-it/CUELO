import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { AuthStorage, createAgentSession, type ExtensionContext, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { CONSULT_BYTES, consultModel } from "../consult";

// 실제 SDK 경로: 부모 모델(fake stream)이 consult를 부르면 확장 loader가 읽은 consult.ts의 handler가 로컬 OpenAI 호환
// 서버로 한 번 호출한다. 무과금 fake 서버가 받은 요청 본문으로 도구 정의·대체 호출 유무를 본다.

const EXTENSION = fileURLToPath(new URL("../consult.ts", import.meta.url));
const FABLE = "anthropic/claude-fable-5-1";
type Behavior = "ok" | "fail" | "length" | "length-empty" | "hang";
const bodies: Array<Record<string, unknown>> = [];
const behavior: Record<string, Behavior> = {};
const roots: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let arrived: (() => void) | undefined;

beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown> & { model: string };
    bodies.push(body);
    arrived?.();
    const mode = behavior[body.model] ?? "ok";
    if (mode === "hang") {
      const { promise, resolve } = Promise.withResolvers<Response>();
      request.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 })));
      return promise;
    }
    if (mode === "fail") return new Response(JSON.stringify({ error: { message: `${body.model} synthetic outage` } }), { status: 400, headers: { "content-type": "application/json" } });
    const base = { id: `fake-${bodies.length}`, object: "chat.completion.chunk", created: 0, model: body.model };
    const chunks = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: mode === "length" ? "앞부분만 쓴 답" : mode === "length-empty" ? "" : "상담 답: 작은 변경이 낫습니다." }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: mode === "length" || mode === "length-empty" ? "length" : "stop" }] },
      { ...base, choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
    ];
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
});
afterAll(() => server.stop(true));
afterEach(() => {
  bodies.length = 0;
  arrived = undefined;
  for (const key of Object.keys(behavior)) delete behavior[key];
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const spec = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, reasoning: false, input: ["text"] as ("text" | "image")[], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096, ...extra,
});

async function fixture(noKeyFor?: string) {
  const root = mkdtempSync(join(tmpdir(), "consult-test-"));
  roots.push(root);
  const work = join(root, "work");
  const agentDir = join(root, "agent");
  mkdirSync(work, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const auth = await AuthStorage.create(join(agentDir, "agent.db"));
  const registry = new ModelRegistry(auth, join(agentDir, "models.yml"));
  const provider = { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "local", api: "openai-completions" as const };
  registry.registerProvider("fakeparent", { ...provider, models: [spec("parent")] });
  registry.registerProvider("anthropic", { ...provider, models: [spec("claude-fable-5-1")] });
  registry.registerProvider("fakeglm", { ...provider, models: [spec("glm-fake"), spec("image-only", { input: ["image"] }), spec("think-fake", { reasoning: true, thinking: { mode: "effort", efforts: ["low", "high"] } })] });
  if (noKeyFor) {
    const getApiKey = registry.getApiKey.bind(registry);
    registry.getApiKey = (async (target: { id: string }, ...rest: unknown[]) =>
      target.id === noKeyFor ? undefined : (getApiKey as (...args: unknown[]) => Promise<string | undefined>)(target, ...rest)) as never;
  }
  return { root, work, agentDir, auth, registry };
}

interface Outcome { isError: boolean; text: string; usage: Array<[string | undefined, string | undefined, string, string, string | undefined]>; sessionFiles: string[]; tools: string[] }

/** 부모 모델이 consult를 한 번 부르고 끝나는 세션. 확장은 discovery 없이 파일 경로로만 실제 loader가 읽는다. */
async function callConsult(args: Record<string, unknown>, noKeyFor?: string): Promise<Outcome> {
  const { root, work, agentDir, auth, registry } = await fixture(noKeyFor);
  const model = registry.find("fakeparent", "parent")!;
  const sessionsDir = join(root, "sessions");
  const sessionManager = SessionManager.create(work, sessionsDir);
  const { session } = await createAgentSession({
    cwd: work, agentDir, model, modelRegistry: registry, sessionManager,
    settings: Settings.isolated({ tools: { approvalMode: "yolo" } } as never),
    additionalExtensionPaths: [EXTENSION], disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, skipPythonPreflight: true,
    skills: [], rules: [], contextFiles: [], toolNames: ["consult"],
  });
  let turn = 0;
  session.agent.streamFn = (() => {
    const stream = createAssistantMessageEventStream();
    const first = turn++ === 0;
    const message = {
      role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: first ? [{ type: "toolCall" as const, id: "call-1", name: "consult", arguments: args }] : [{ type: "text" as const, text: "done" }],
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
    await session.prompt("consult once");
    const result = session.agent.state.messages.find((message) => message.role === "toolResult") as
      { isError: boolean; content: Array<{ type: string; text?: string }> } | undefined;
    expect(result).toBeDefined();
    const usage = sessionManager.getEntries().filter((entry) => entry.type === "model_usage")
      .map((entry) => [entry.role, entry.purpose, entry.provider, entry.model, entry.stopReason] as Outcome["usage"][number]);
    await sessionManager.flush();
    const tools = session.agent.state.tools.map((tool) => tool.name);
    return { isError: result!.isError, text: result!.content.map((part) => part.text ?? "").join(""), usage, sessionFiles: readdirSync(sessionsDir, { recursive: true }).map(String).filter((name) => name.endsWith(".jsonl")), tools };
  } finally {
    await session.dispose();
    await sessionManager.close();
    auth.close();
  }
}

describe("consult through the extension loader", () => {
  test("정확한 Fable selector는 도구 정의 없이 한 번만 부르고 사용량을 consult로 남긴다", async () => {
    const out = await callConsult({ model: FABLE, question: "작게 고칠까?", context: "변경 후보 두 개" });
    expect(out.tools).toContain("consult");
    expect(out.isError).toBe(false);
    expect(out.text).toContain(`requested: ${FABLE}\nresolved: ${FABLE}\nreasoning: off\nstatus: complete`);
    expect(out.text).toContain("상담 답: 작은 변경이 낫습니다.");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].model).toBe("claude-fable-5-1");
    expect(bodies[0].tools).toBeUndefined();
    expect(JSON.stringify((bodies[0].messages as unknown[]).at(-1))).toContain("<context>\\n변경 후보 두 개\\n</context>");
    expect(out.usage).toEqual([[undefined, "consult", "anthropic", "claude-fable-5-1", "stop"]]);
    // 부모 세션 파일 하나뿐이다. 상담은 하위 세션을 만들지 않는다.
    expect(out.sessionFiles).toHaveLength(1);
  });

  test("별칭·짧은 이름·접미사·없는 모델·자격 없음·이미지 전용·미지원 강도·비밀·초과 입력은 호출 없이 거절한다", async () => {
    const cases: Array<[Record<string, unknown>, string, string?]> = [
      [{ model: "@smol", question: "?" }, "정확한 provider/id"],
      [{ model: "claude-fable-5-1", question: "?" }, "정확한 provider/id"],
      [{ model: `${FABLE}:high`, question: "?" }, `정확히 일치하지 않는 ${FABLE}로 해석돼`],
      // 같은 provider의 부분 이름·없는 id. bundled anthropic 모델은 실제 원격으로 가므로 fake provider로만 본다.
      [{ model: "fakeglm/glm", question: "?" }, "requested: fakeglm/glm"],
      [{ model: "fakeglm/nope-fake", question: "?" }, "fakeglm/nope-fake 모델을 찾지 못했습니다"],
      [{ model: "fakeglm/glm-fake", question: "?" }, "자격을 찾지 못했습니다", "glm-fake"],
      [{ model: "fakeglm/image-only", question: "?" }, "텍스트 입력을 지원하지 않습니다"],
      [{ model: "fakeglm/glm-fake", question: "?", reasoning: "high" }, "reasoning 강도를 지정할 수 없는 모델"],
      [{ model: "fakeglm/think-fake", question: "?", reasoning: "max" }, "지원: low, high"],
      [{ model: "fakeglm/glm-fake", question: "?", reasoning: "turbo" }, "reasoning은 minimal"],
      [{ model: FABLE, question: "?", context: ["api", "key"].join("_") + " = \"not-a-real-key\"" }, "비밀로 보이는 값"],
      [{ model: FABLE, question: "?", context: "가".repeat(CONSULT_BYTES / 3 + 1) }, `상한 ${CONSULT_BYTES}바이트`],
      [{ model: FABLE, question: "  " }, "question을 비울 수 없습니다"],
      // 공백만 덧붙여 상한을 넘긴 입력도 trim으로 줄여 보내지 않는다.
      [{ model: FABLE, question: "?", context: " ".repeat(CONSULT_BYTES) }, `상한 ${CONSULT_BYTES}바이트`],
    ];
    for (const [args, expected, noKeyFor] of cases) {
      const out = await callConsult(args, noKeyFor);
      expect(out.isError).toBe(true);
      expect(out.text).toContain("status: rejected");
      expect(out.text).toContain(expected);
      expect(bodies).toHaveLength(0);
      expect(out.usage).toEqual([]);
    }
  });

  test("제공자 오류는 다른 모델로 넘어가지 않고 오류로 돌려주며 청구된 응답을 기록한다", async () => {
    behavior["claude-fable-5-1"] = "fail";
    const out = await callConsult({ model: FABLE, question: "?" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("status: error");
    expect(out.text).toContain("synthetic outage");
    expect(bodies.map((body) => body.model)).toEqual(["claude-fable-5-1"]);
    expect(out.usage).toEqual([[undefined, "consult", "anthropic", "claude-fable-5-1", "error"]]);
  });

  test("출력 상한에서 끊긴 답은 incomplete로 부분 답과 함께 돌려주고 오류로 치지 않는다", async () => {
    behavior["claude-fable-5-1"] = "length";
    const out = await callConsult({ model: FABLE, question: "?" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("status: incomplete");
    expect(out.text).toContain("앞부분만 쓴 답");
    expect(out.usage).toEqual([[undefined, "consult", "anthropic", "claude-fable-5-1", "length"]]);
  });

  test("출력 상한에서 답 글 없이 끝나면 incomplete가 아니라 오류다", async () => {
    behavior["claude-fable-5-1"] = "length-empty";
    const out = await callConsult({ model: FABLE, question: "?" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("status: error");
    expect(out.usage).toEqual([[undefined, "consult", "anthropic", "claude-fable-5-1", "length"]]);
  });

  test("지원하는 reasoning은 그 강도로 요청하고 결과에 그대로 밝힌다", async () => {
    const out = await callConsult({ model: "fakeglm/think-fake", question: "?", reasoning: "High" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("reasoning: high\nstatus: complete");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].reasoning_effort).toBe("high");
  });
});

describe("consult cancellation", () => {
  test("호출 중 취소는 cancelled로 돌려주고 오류로 치지 않는다", async () => {
    const { auth, registry } = await fixture();
    behavior["claude-fable-5-1"] = "hang";
    const target = registry.find("anthropic", "claude-fable-5-1")!;
    const ctx = {
      cwd: tmpdir(), models: { resolve: () => target }, modelRegistry: registry,
      sessionManager: { getSessionId: () => "consult-abort", getLeafId: () => null },
    } as unknown as ExtensionContext;
    const controller = new AbortController();
    arrived = () => controller.abort();
    try {
      const result = await consultModel({ model: FABLE, question: "?" }, ctx, controller.signal);
      expect(result.isError).toBe(false);
      expect(result.text).toContain("status: cancelled");
      expect(bodies).toHaveLength(1);
    } finally {
      auth.close();
    }
  });
});
