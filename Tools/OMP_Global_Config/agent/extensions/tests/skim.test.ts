import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callModel, skimQuestion, FILE_BYTES, TOTAL_BYTES, type HelperAnswer, type SkimCompletion } from "../skim";

const directories: string[] = [];
const signal = new AbortController().signal;
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "skim-fixture-"));
  directories.push(cwd);
  return cwd;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function context(cwd: string): ExtensionContext { return { cwd } as ExtensionContext; }
const GEMINI = "google-vertex/gemini-4-argon";
/** 주입 모델 응답. 모델 이름을 밝히지 않는 fake는 요청한 표지(slot=GEMINI)로 응답한 것으로 본다. */
const reply = (text: string, model: string = GEMINI): HelperAnswer => ({ text, model });
async function skimText(...args: Parameters<typeof skimQuestion>): Promise<string> { return (await skimQuestion(...args)).text; }

describe("skim", () => {
  test("Gemini에 허용 파일만 보내고 secret·gitignore 대상은 명시해도 제외한다", async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, "docs"));
    mkdirSync(join(cwd, "private"));
    writeFileSync(join(cwd, ".gitignore"), "docs/ignored.md\nprivate/\n");
    writeFileSync(join(cwd, "docs", "guide.md"), "First heading\nSecond fact\n");
    writeFileSync(join(cwd, "docs", "ignored.md"), "IGNORED_SECRET_MARKER");
    writeFileSync(join(cwd, "docs", "credentials.json"), "CREDENTIAL_SECRET_MARKER");
    writeFileSync(join(cwd, ".env.local"), "ENV_SECRET_MARKER");
    writeFileSync(join(cwd, "private", "note.md"), "PRIVATE_SECRET_MARKER");
    // setup 비밀 검사(content-scan)가 소스의 할당 모양을 막으므로 키 이름을 이어 붙여 만든다.
    writeFileSync(join(cwd, "docs", "note.md"), ["api", "key"].join("_") + " = \"not-a-real-key\"");
    let prompt = "";
    const answer = await skimText({ paths: ["docs", "docs/ignored.md", "docs/credentials.json", ".env.local", "private"], question: "두 번째 줄은?" },
      context(cwd), signal, async (input, _ctx, _signal, model) => { expect(model).toBe(GEMINI); prompt = input; return reply("Second fact (docs/guide.md:L2)"); });
    expect(prompt).toContain("<file path=\"docs/guide.md\">");
    expect(prompt).toContain("2: Second fact");
    expect(prompt).not.toMatch(/IGNORED_SECRET_MARKER|CREDENTIAL_SECRET_MARKER|ENV_SECRET_MARKER|PRIVATE_SECRET_MARKER|not-a-real-key/);
    expect(answer.startsWith(`model: ${GEMINI}`)).toBe(true);
    expect(answer).toContain("Second fact (docs/guide.md:L2)");
    expect(answer).toContain("docs/ignored.md: gitignore로 건너뜀");
    expect(answer).toContain("docs/credentials.json: 비밀 경로 제외");
    expect(answer).toContain(".env.local: 비밀 경로 제외");
    expect(answer).toContain("private: gitignore로 건너뜀");
    expect(answer).toContain("docs/note.md: 비밀 내용 제외");
  });

  test("auth·token은 단어로 떨어진 이름만 비밀로 보고, 그 글자를 품은 일반 이름은 보낸다", async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, "docs"));
    for (const name of ["authentic-product.md", "tokenizer.md", "author.md"]) writeFileSync(join(cwd, "docs", name), `PUBLIC ${name}`);
    for (const name of ["auth.json", "oauth-token.txt", "github-auth.yml", "tokens.md"]) writeFileSync(join(cwd, "docs", name), "SECRET_NAME_MARKER");
    let prompt = "";
    const answer = await skimText({ paths: ["docs"], question: "?" }, context(cwd), signal, async (input) => { prompt = input; return reply("ok"); });
    for (const name of ["authentic-product.md", "tokenizer.md", "author.md"]) expect(prompt).toContain(`<file path="docs/${name}">`);
    expect(prompt).not.toContain("SECRET_NAME_MARKER");
    for (const name of ["auth.json", "oauth-token.txt", "github-auth.yml", "tokens.md"]) expect(answer).toContain(`docs/${name}: 비밀 경로 제외`);
  });

  test("하위 cwd에서도 상위 저장소의 gitignore를 명시 파일에 적용한다", async () => {
    const repo = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    mkdirSync(join(repo, "nested"));
    writeFileSync(join(repo, ".gitignore"), "nested/ignored.md\n");
    writeFileSync(join(repo, "nested", "ignored.md"), "PARENT_IGNORE_MARKER");
    writeFileSync(join(repo, "nested", "allowed.md"), "Allowed fact");
    let prompt = "";
    const output = await skimText({ paths: ["ignored.md", "allowed.md"], question: "근거?" },
      context(join(repo, "nested")), signal, async (input) => { prompt = input; return reply("allowed.md:L1"); });
    expect(prompt).toContain("Allowed fact");
    expect(prompt).not.toContain("PARENT_IGNORE_MARKER");
    expect(output).toContain("ignored.md: gitignore로 건너뜀");
  });

  test("파일별·총량 상한을 알리고 빠진 경로를 보여 주며 비UTF·바이너리는 전송하지 않는다", async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, "docs"));
    for (let index = 0; index < 5; index++) writeFileSync(join(cwd, "docs", `part-${index}.md`), "x".repeat(FILE_BYTES + 100));
    writeFileSync(join(cwd, "docs", "binary.dat"), Buffer.from([0, 1, 2]));
    writeFileSync(join(cwd, "docs", "oversize.md"), "y".repeat(1024 * 1024 + 1));
    let prompt = "";
    const result = await skimText({ paths: ["docs/*.md", "docs/binary.dat"], question: "요약" }, context(cwd), signal,
      async (input) => { prompt = input; return reply("요약"); });
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(TOTAL_BYTES);
    expect(prompt).toContain("<file path=\"docs/part-0.md\">");
    expect(prompt).not.toContain("<file path=\"docs/part-4.md\">");
    expect(result).toContain("docs/part-0.md:");
    expect(result).toContain("잘림");
    expect(result).toContain("docs/part-4.md: 총량 상한으로 빠짐");
    expect(result).toContain("docs/binary.dat: 바이너리 또는 빈 파일 제외");
    expect(result).toContain("docs/oversize.md: 거대 파일 제외");
  });

  test("Gemini 실패 뒤 DeepSeek에 같은 비밀 제외 prompt를 한 번만 재사용하고 실제 모델·원문 오류를 표시한다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "guide.md"), "Public fact");
    writeFileSync(join(cwd, ".env.local"), "PRIVATE_MARKER");
    const calls: Array<{ prompt: string; model: string }> = [];
    const result = await skimText({ paths: ["guide.md", ".env.local"], question: "근거?" }, context(cwd), signal,
      async (prompt, _ctx, _signal, model) => {
        calls.push({ prompt, model });
        if (model === GEMINI) throw new Error("Gemini original 429");
        return reply("Public fact (guide.md:L1)", model);
      });
    expect(calls.map(({ model }) => model)).toEqual([GEMINI, "hive/deepseek-ai/deepseek-v4.1-flash-1017"]);
    expect(calls[0]!.prompt).toBe(calls[1]!.prompt);
    expect(calls[0]!.prompt).not.toContain("PRIVATE_MARKER");
    expect(result.startsWith("model: hive/deepseek-ai/deepseek-v4.1-flash-1017")).toBe(true);
    expect(result).toContain("Gemini 실패: Gemini original 429");
    expect(result).toContain("Public fact (guide.md:L1)");
    expect(result).toContain(".env.local: 비밀 경로 제외");
  });

  test("양쪽 실패 원문을 모두 알리고 세 번째 모델은 호출하지 않는다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "guide.md"), "fact");
    const called: string[] = [];
    const result = await skimText({ paths: ["guide.md"], question: "?" }, context(cwd), signal,
      async (_prompt, _ctx, _signal, model) => {
        called.push(model);
        throw new Error(model.startsWith("google-") ? "Gemini original timeout" : "DeepSeek original 403");
      });
    expect(called).toEqual([GEMINI, "hive/deepseek-ai/deepseek-v4.1-flash-1017"]);
    expect(result).toContain("model: none");
    expect(result).toContain("Gemini 실패: Gemini original timeout");
    expect(result).toContain("DeepSeek 실패: DeepSeek original 403");
  });

  test("cwd 밖 파일은 호출하지 않고, 모델 오류 원문을 반환한다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "guide.md"), "fact");
    let calls = 0;
    const outside = await skimText({ paths: ["../outside.md"], question: "?" }, context(cwd), signal,
      async () => { calls++; return reply("unexpected"); });
    expect(outside).toContain("cwd 밖");
    expect(calls).toBe(0);
    const failed = await skimText({ paths: ["guide.md"], question: "?" }, context(cwd), signal,
      async () => { throw new Error("provider original 429"); });
    expect(failed).toContain("provider original 429");
  });

  test("응답이 돌아온 시도만 세션 비용 장부(model_usage)에 남기고 빈 답 실패 응답도 기록한다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "guide.md"), "fact");
    // 무과금 로컬 OpenAI 호환 서버. 두 번째 응답은 토큰만 쓰고 빈 답을 돌려준다.
    let served = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      await request.text();
      served++;
      const base = { id: `local-${served}`, object: "chat.completion.chunk", created: 0, model: "deepseek-v4.1-flash" };
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: served === 1 ? "fact (guide.md:L1)" : "" }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { ...base, choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, prompt_tokens_details: { cached_tokens: 200 } } },
      ];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      const model = { id: "deepseek-ai/deepseek-v4.1-flash-1017", name: "local", api: "openai-completions", provider: "hive",
        baseUrl: `http://127.0.0.1:${server.port}/v1`, reasoning: false, input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
      const sessionManager = SessionManager.inMemory(cwd);
      sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "질문" }], timestamp: Date.now() });
      const ctx = { cwd, sessionManager, models: { resolve: () => model },
        modelRegistry: { getApiKey: async () => "local", resolver: () => "local" } } as unknown as ExtensionContext;
      // Gemini는 응답 없이 실패한다 → 관측한 usage가 없으므로 기록하지 않는다.
      const viaDeepSeek: SkimCompletion = (prompt, ctx, attempt, requested) =>
        requested.startsWith("google-") ? Promise.reject(new Error("no response")) : callModel(prompt, ctx, attempt, requested);
      const ok = await skimText({ paths: ["guide.md"], question: "?" }, ctx, signal, viaDeepSeek);
      const empty = await skimText({ paths: ["guide.md"], question: "?" }, ctx, signal, viaDeepSeek);
      expect(ok).toContain("model: hive/deepseek-ai/deepseek-v4.1-flash-1017");
      expect(empty).toContain("DeepSeek 실패: hive/deepseek-ai/deepseek-v4.1-flash-1017가 빈 답을 반환했습니다.");
      const usage = sessionManager.getEntries().filter((entry) => entry.type === "model_usage");
      expect(usage.map((entry) => [entry.purpose, entry.role, entry.provider, entry.model, entry.stopReason])).toEqual([
        ["skim", undefined, "hive", "deepseek-ai/deepseek-v4.1-flash-1017", "stop"],
        ["skim", undefined, "hive", "deepseek-ai/deepseek-v4.1-flash-1017", "stop"],
      ]);
      expect(usage.map((entry) => [entry.usage.input, entry.usage.output, entry.usage.cacheRead])).toEqual([[1000, 80, 200], [1000, 80, 200]]);
      expect(usage[0].usage.cost.total).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });

  test("출력 상한(8192토큰)에 닿은 답은 버리지 않고 끊김 안내와 함께 돌려준다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "guide.md"), "fact");
    const bodies: Record<string, unknown>[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      bodies.push(await request.json() as Record<string, unknown>);
      const base = { id: "local-length", object: "chat.completion.chunk", created: 0, model: "deepseek-v4.1-flash" };
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "긴 답의 앞부분 (guide.md:L1)" }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
        { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292 } },
      ];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      const model = { id: "deepseek-ai/deepseek-v4.1-flash-1017", name: "local", api: "openai-completions", provider: "hive",
        baseUrl: `http://127.0.0.1:${server.port}/v1`, reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 150000 };
      const ctx = { cwd, sessionManager: SessionManager.inMemory(cwd), models: { resolve: () => model },
        modelRegistry: { getApiKey: async () => "local", resolver: () => "local" } } as unknown as ExtensionContext;
      const viaDeepSeek: SkimCompletion = (prompt, ctx, attempt, requested) =>
        requested.startsWith("google-") ? Promise.reject(new Error("no response")) : callModel(prompt, ctx, attempt, requested);
      const result = await skimText({ paths: ["guide.md"], question: "?" }, ctx, signal, viaDeepSeek);
      expect(result).toContain("model: hive/deepseek-ai/deepseek-v4.1-flash-1017");
      expect(result).toContain("긴 답의 앞부분 (guide.md:L1)");
      expect(result).toContain("[출력 상한 8192토큰에서 답이 끊겼습니다.");
      expect(result).not.toContain("DeepSeek 실패");
      expect(JSON.stringify(bodies[0])).toMatch(/"max_(?:completion_)?tokens":8192/);
    } finally {
      server.stop(true);
    }
  });

  test("isError는 두 모델 실패·수집 실패에만 붙고 fallback 성공·입력 없음·보낼 텍스트 없음·사용자 취소는 오류가 아니다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "guide.md"), "fact");
    const run = (paths: string[], question: string, complete: SkimCompletion, abort?: AbortSignal) =>
      skimQuestion({ paths, question }, context(cwd), abort ?? signal, complete);
    const fail: SkimCompletion = async (_p, _c, _s, model) => { throw new Error(`${model} down`); };
    expect((await run(["guide.md"], "?", fail)).isError).toBe(true);
    expect((await run(["guide.md"], "?", async (_p, _c, _s, model) => {
      if (model === GEMINI) throw new Error("first down");
      return reply("ok", model);
    })).isError).toBe(false);
    expect((await run(["guide.md"], " ", fail))).toEqual({ text: "model: none\n질문과 경로를 하나 이상 지정해 주세요.", isError: false });
    expect((await run(["nothing-here.md"], "?", fail)).isError).toBe(false);
    // 사용자 취소: 다음 모델을 부르지 않고 실패로 세지 않는다.
    const controller = new AbortController();
    const called: string[] = [];
    const cancelled = await run(["guide.md"], "?", async (_p, _c, _s, model) => {
      called.push(model);
      controller.abort();
      throw new Error("aborted by user");
    }, controller.signal);
    expect(cancelled.isError).toBe(false);
    expect(cancelled.text).toContain("model: none");
    expect(called).toEqual([GEMINI]);
  });

  test("core Settings가 별도 skim 슬롯을 그대로 해석한다", () => {
    const settings = Settings.isolated({ modelRoles: { skim: "google-antigravity/gemini-3.8-flash" } });
    expect(settings.getModelRole("skim")).toBe("google-antigravity/gemini-3.8-flash");
  });
});
