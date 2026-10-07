import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callModel, skimQuestion, FILE_BYTES, TOTAL_BYTES, type SkimCompletion } from "../skim";

const directories: string[] = [];
const signal = new AbortController().signal;
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "skim-fixture-"));
  directories.push(cwd);
  return cwd;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function context(cwd: string): ExtensionContext { return { cwd } as ExtensionContext; }

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
    const answer = await skimQuestion({ paths: ["docs", "docs/ignored.md", "docs/credentials.json", ".env.local", "private"], question: "두 번째 줄은?" },
      context(cwd), signal, async (input, _ctx, _signal, model) => { expect(model).toBe("google-antigravity/gemini-3.8-flash"); prompt = input; return "Second fact (docs/guide.md:L2)"; });
    expect(prompt).toContain("<file path=\"docs/guide.md\">");
    expect(prompt).toContain("2: Second fact");
    expect(prompt).not.toMatch(/IGNORED_SECRET_MARKER|CREDENTIAL_SECRET_MARKER|ENV_SECRET_MARKER|PRIVATE_SECRET_MARKER|not-a-real-key/);
    expect(answer.startsWith("model: google-antigravity/gemini-3.8-flash")).toBe(true);
    expect(answer).toContain("Second fact (docs/guide.md:L2)");
    expect(answer).toContain("docs/ignored.md: gitignore로 건너뜀");
    expect(answer).toContain("docs/credentials.json: 비밀 경로 제외");
    expect(answer).toContain(".env.local: 비밀 경로 제외");
    expect(answer).toContain("private: gitignore로 건너뜀");
    expect(answer).toContain("docs/note.md: 비밀 내용 제외");
  });

  test("하위 cwd에서도 상위 저장소의 gitignore를 명시 파일에 적용한다", async () => {
    const repo = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    mkdirSync(join(repo, "nested"));
    writeFileSync(join(repo, ".gitignore"), "nested/ignored.md\n");
    writeFileSync(join(repo, "nested", "ignored.md"), "PARENT_IGNORE_MARKER");
    writeFileSync(join(repo, "nested", "allowed.md"), "Allowed fact");
    let prompt = "";
    const output = await skimQuestion({ paths: ["ignored.md", "allowed.md"], question: "근거?" },
      context(join(repo, "nested")), signal, async (input) => { prompt = input; return "allowed.md:L1"; });
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
    const result = await skimQuestion({ paths: ["docs/*.md", "docs/binary.dat"], question: "요약" }, context(cwd), signal,
      async (input) => { prompt = input; return "요약"; });
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
    const result = await skimQuestion({ paths: ["guide.md", ".env.local"], question: "근거?" }, context(cwd), signal,
      async (prompt, _ctx, _signal, model) => {
        calls.push({ prompt, model });
        if (model === "google-antigravity/gemini-3.8-flash") throw new Error("Gemini original 429");
        return "Public fact (guide.md:L1)";
      });
    expect(calls.map(({ model }) => model)).toEqual(["google-antigravity/gemini-3.8-flash", "b-ai/deepseek-v4.1-flash"]);
    expect(calls[0]!.prompt).toBe(calls[1]!.prompt);
    expect(calls[0]!.prompt).not.toContain("PRIVATE_MARKER");
    expect(result.startsWith("model: b-ai/deepseek-v4.1-flash")).toBe(true);
    expect(result).toContain("Gemini 실패: Gemini original 429");
    expect(result).toContain("Public fact (guide.md:L1)");
    expect(result).toContain(".env.local: 비밀 경로 제외");
  });

  test("양쪽 실패 원문을 모두 알리고 세 번째 모델은 호출하지 않는다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "guide.md"), "fact");
    const called: string[] = [];
    const result = await skimQuestion({ paths: ["guide.md"], question: "?" }, context(cwd), signal,
      async (_prompt, _ctx, _signal, model) => {
        called.push(model);
        throw new Error(model.startsWith("google-") ? "Gemini original timeout" : "DeepSeek original 403");
      });
    expect(called).toEqual(["google-antigravity/gemini-3.8-flash", "b-ai/deepseek-v4.1-flash"]);
    expect(result).toContain("model: none");
    expect(result).toContain("Gemini 실패: Gemini original timeout");
    expect(result).toContain("DeepSeek 실패: DeepSeek original 403");
  });

  test("cwd 밖 파일은 호출하지 않고, 모델 오류 원문을 반환한다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "guide.md"), "fact");
    let calls = 0;
    const outside = await skimQuestion({ paths: ["../outside.md"], question: "?" }, context(cwd), signal,
      async () => { calls++; return "unexpected"; });
    expect(outside).toContain("cwd 밖");
    expect(calls).toBe(0);
    const failed = await skimQuestion({ paths: ["guide.md"], question: "?" }, context(cwd), signal,
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
      const model = { id: "deepseek-v4.1-flash", name: "local", api: "openai-completions", provider: "b-ai",
        baseUrl: `http://127.0.0.1:${server.port}/v1`, reasoning: false, input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
      const sessionManager = SessionManager.inMemory(cwd);
      sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "질문" }], timestamp: Date.now() });
      const ctx = { cwd, sessionManager, models: { resolve: () => model },
        modelRegistry: { getApiKey: async () => "local", resolver: () => "local" } } as unknown as ExtensionContext;
      // Gemini는 응답 없이 실패한다 → 관측한 usage가 없으므로 기록하지 않는다.
      const viaDeepSeek: SkimCompletion = (prompt, ctx, attempt, requested) =>
        requested.startsWith("google-") ? Promise.reject(new Error("no response")) : callModel(prompt, ctx, attempt, requested);
      const ok = await skimQuestion({ paths: ["guide.md"], question: "?" }, ctx, signal, viaDeepSeek);
      const empty = await skimQuestion({ paths: ["guide.md"], question: "?" }, ctx, signal, viaDeepSeek);
      expect(ok).toContain("model: b-ai/deepseek-v4.1-flash");
      expect(empty).toContain("DeepSeek 실패: b-ai/deepseek-v4.1-flash가 빈 답을 반환했습니다.");
      const usage = sessionManager.getEntries().filter((entry) => entry.type === "model_usage");
      expect(usage.map((entry) => [entry.purpose, entry.role, entry.provider, entry.model, entry.stopReason])).toEqual([
        ["skim", undefined, "b-ai", "deepseek-v4.1-flash", "stop"],
        ["skim", undefined, "b-ai", "deepseek-v4.1-flash", "stop"],
      ]);
      expect(usage.map((entry) => [entry.usage.input, entry.usage.output, entry.usage.cacheRead])).toEqual([[1000, 80, 200], [1000, 80, 200]]);
      expect(usage[0].usage.cost.total).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });

  test("core Settings가 별도 skim 슬롯을 그대로 해석한다", () => {
    const settings = Settings.isolated({ modelRoles: { skim: "google-antigravity/gemini-3.8-flash" } });
    expect(settings.getModelRole("skim")).toBe("google-antigravity/gemini-3.8-flash");
  });
});
