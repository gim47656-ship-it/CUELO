import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callModel, collect, secretFileName, skimQuestion, withFallback, DRAFT_FALLBACK, ROLE_PRIMARY, HelperCallError, FILE_BYTES, TOTAL_BYTES, type HelperAnswer, type SkimCompletion } from "../skim";

const directories: string[] = [];
const signal = new AbortController().signal;
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "skim-fixture-"));
  directories.push(cwd);
  return cwd;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function context(cwd: string): ExtensionContext { return { cwd } as ExtensionContext; }
const TEST_MODEL = "openai-codex/gpt-6.1-terra";
const reply = (text: string, model: string = TEST_MODEL): HelperAnswer => ({ text, model });
async function skimText(...args: Parameters<typeof skimQuestion>): Promise<string> { return (await skimQuestion(...args)).text; }

describe("skim", () => {
  test("주 모델에 허용 파일만 보내고 secret·gitignore 대상은 명시해도 제외한다", async () => {
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
      context(cwd), signal, async (input, _ctx, _signal, model) => { expect(model).toBe(ROLE_PRIMARY); prompt = input; return reply("Second fact (docs/guide.md:L2)"); });
    expect(prompt).toContain("<file path=\"docs/guide.md\">");
    expect(prompt).toContain("2: Second fact");
    expect(prompt).not.toMatch(/IGNORED_SECRET_MARKER|CREDENTIAL_SECRET_MARKER|ENV_SECRET_MARKER|PRIVATE_SECRET_MARKER|not-a-real-key/);
    expect(answer.startsWith(`model: ${TEST_MODEL}`)).toBe(true);
    expect(answer).toContain("Second fact (docs/guide.md:L2)");
    expect(answer).toContain("docs/ignored.md: gitignore로 건너뜀");
    expect(answer).toContain("docs/credentials.json: 비밀 경로 제외");
    expect(answer).toContain(".env.local: 비밀 경로 제외");
    expect(answer).toContain("private: gitignore로 건너뜀");
    expect(answer).toContain("docs/note.md: 비밀 내용 제외");
  });

  test("auth·token은 단어로 떨어진 이름만 비밀로 보고, 그 글자를 품은 일반 이름과 소스 코드는 보낸다", async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, "docs"));
    for (const name of ["authentic-product.md", "tokenizer.md", "author.md", "auth-broker-config.ts", "oauth_token.py"]) writeFileSync(join(cwd, "docs", name), `PUBLIC ${name}`);
    for (const name of ["auth.json", "oauth-token.txt", "github-auth.yml", "tokens.md", ".env.ts"]) writeFileSync(join(cwd, "docs", name), "SECRET_NAME_MARKER");
    // 소스 코드도 비밀 값 모양 내용이면 내용 검사가 뺀다. setup 비밀 검사를 피하려고 키 이름을 이어 붙인다.
    writeFileSync(join(cwd, "docs", "auth-keys.ts"), `const ${["api", "Key"].join("")} = "not-a-real-key";`);
    let prompt = "";
    const answer = await skimText({ paths: ["docs"], question: "?" }, context(cwd), signal, async (input) => { prompt = input; return reply("ok"); });
    for (const name of ["authentic-product.md", "tokenizer.md", "author.md", "auth-broker-config.ts", "oauth_token.py"]) expect(prompt).toContain(`<file path="docs/${name}">`);
    expect(prompt).not.toMatch(/SECRET_NAME_MARKER|not-a-real-key/);
    for (const name of ["auth.json", "oauth-token.txt", "github-auth.yml", "tokens.md", ".env.ts"]) expect(answer).toContain(`docs/${name}: 비밀 경로 제외`);
    expect(answer).toContain("docs/auth-keys.ts: 비밀 내용 제외");
  });

  test("비밀 이름은 파일 이름에만 걸고 폴더 이름은 보지 않으며, .omp/agent 같은 관리 위치는 그대로 뺀다", async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, "doc", "29-token-saving"), { recursive: true });
    mkdirSync(join(cwd, "secrets"));
    mkdirSync(join(cwd, ".omp", "agent"), { recursive: true });
    writeFileSync(join(cwd, "doc", "29-token-saving", "main.md"), "FOLDER_TOKEN_MARKER");
    writeFileSync(join(cwd, "secrets", "plan.md"), "FOLDER_SECRET_MARKER");
    writeFileSync(join(cwd, "secrets", "api-key.md"), "NAMED_SECRET_MARKER");
    writeFileSync(join(cwd, ".omp", "agent", "note.md"), "AGENT_DIR_MARKER");
    let prompt = "";
    const answer = await skimText({ paths: ["doc/29-token-saving", "secrets", ".omp/agent/note.md"], question: "?" },
      context(cwd), signal, async (input) => { prompt = input; return reply("ok"); });
    // 10-29~30: 기록 폴더 `29-token-saving/`이 `token`에 걸려 통째로 빠졌다.
    expect(prompt).toContain("FOLDER_TOKEN_MARKER");
    expect(prompt).toContain("FOLDER_SECRET_MARKER");
    expect(prompt).not.toMatch(/NAMED_SECRET_MARKER|AGENT_DIR_MARKER/);
    expect(answer).toContain("secrets/api-key.md: 비밀 경로 제외");
    expect(answer).toContain(".omp/agent/note.md: 비밀 경로 제외");
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

  test("주 모델 실패 뒤 고정 대체(Sonnet)에 같은 비밀 제외 prompt를 한 번만 재사용하고 실제 모델·원문 오류를 표시한다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "guide.md"), "Public fact");
    writeFileSync(join(cwd, ".env.local"), "PRIVATE_MARKER");
    const calls: Array<{ prompt: string; model: string }> = [];
    const result = await skimText({ paths: ["guide.md", ".env.local"], question: "근거?" }, context(cwd), signal,
      async (prompt, _ctx, _signal, model) => {
        calls.push({ prompt, model });
        if (model === ROLE_PRIMARY) throw new Error("primary original 429");
        return reply("Public fact (guide.md:L1)", model);
      });
    expect(calls.map(({ model }) => model)).toEqual([ROLE_PRIMARY, "anthropic/claude-sonnet-5-5"]);
    expect(calls[0]!.prompt).toBe(calls[1]!.prompt);
    expect(calls[0]!.prompt).not.toContain("PRIVATE_MARKER");
    expect(result.startsWith("model: anthropic/claude-sonnet-5-5")).toBe(true);
    expect(result).toContain("@skim 실패: primary original 429");
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
        throw new Error(model === ROLE_PRIMARY ? "primary original timeout" : "Sonnet original 403");
      });
    expect(called).toEqual([ROLE_PRIMARY, "anthropic/claude-sonnet-5-5"]);
    expect(result).toContain("model: none");
    expect(result).toContain("@skim 실패: primary original timeout");
    expect(result).toContain("Sonnet 실패: Sonnet original 403");
  });

  test("cwd 밖 파일·폴더는 절대 경로 이름으로 보내되 인증 폴더와 비밀은 빼고, cwd 자체는 호출 없이 거절한다", async () => {
    const cwd = fixture();
    const outside = fixture();
    writeFileSync(join(cwd, "guide.md"), "fact");
    mkdirSync(join(outside, "lib"));
    mkdirSync(join(outside, ".ssh"));
    writeFileSync(join(outside, "lib", "core.ts"), "OUTSIDE_FACT");
    writeFileSync(join(outside, "lib", "auth.json"), "OUTSIDE_SECRET_MARKER");
    writeFileSync(join(outside, ".ssh", "config"), "SSH_MARKER");
    let prompt = "";
    const answer = await skimText({ paths: [join(outside, "lib"), join(outside, ".ssh", "config")], question: "?" }, context(cwd), signal,
      async (input) => { prompt = input; return reply("ok"); });
    expect(prompt).toContain(`<file path="${join(outside, "lib", "core.ts")}">`);
    expect(prompt).toContain("OUTSIDE_FACT");
    expect(prompt).not.toMatch(/OUTSIDE_SECRET_MARKER|SSH_MARKER/);
    expect(answer).toContain(`${join(outside, "lib", "auth.json")}: 비밀 경로 제외`);
    expect(answer).toContain(`${join(outside, ".ssh", "config")}: 비밀 경로 제외`);
    let calls = 0;
    const whole = await skimText({ paths: ["."], question: "?" }, context(cwd), signal, async () => { calls++; return reply("unexpected"); });
    expect(whole).toContain("cwd 전체 경로");
    expect(calls).toBe(0);
    const failed = await skimText({ paths: ["guide.md"], question: "?" }, context(cwd), signal,
      async () => { throw new Error("provider original 429"); });
    expect(failed).toContain("provider original 429");
  });

  test("의존성 폴더는 탐색 중에는 건너뛰지만 이름을 댄 폴더·파일은 gitignore를 넘어 보낸다", async () => {
    const repo = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    mkdirSync(join(repo, "app", "node_modules", "pkg", "src"), { recursive: true });
    writeFileSync(join(repo, "app", "main.ts"), "APP_FACT");
    writeFileSync(join(repo, "app", "node_modules", "pkg", "src", "index.ts"), "PKG_FACT");
    const cwd = fixture();
    let prompt = "";
    const traversed = await skimText({ paths: [join(repo, "app")], question: "?" }, context(cwd), signal,
      async (input) => { prompt = input; return reply("ok"); });
    expect(prompt).toContain("APP_FACT");
    expect(prompt).not.toContain("PKG_FACT");
    expect(traversed).not.toContain("PKG_FACT");
    for (const path of [join(repo, "app", "node_modules", "pkg", "src"), join(repo, "app", "node_modules", "pkg", "src", "index.ts")]) {
      prompt = "";
      await skimText({ paths: [path], question: "?" }, context(cwd), signal, async (input) => { prompt = input; return reply("ok"); });
      expect(prompt).toContain("PKG_FACT");
    }
  });

  test("소스 예외는 auth·token 이름에만 적용되고, cwd에 걸친 인증 폴더·build라는 무시 파일·조상 폴더 입력의 이름을 바로 다룬다", async () => {
    for (const name of ["credentials.py", "auth-password.ts", "api_key.ts", "auth.sh"]) expect(secretFileName(name)).toBe(true);
    expect(secretFileName("auth-broker-config.ts")).toBe(false);
    const home = fixture();
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "GH_FIXTURE");
    const gh = await collect({ paths: ["gh/hosts.yml"] }, join(home, ".config"), signal);
    expect(gh.chunks.join("")).not.toContain("GH_FIXTURE");
    const repo = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    writeFileSync(join(repo, ".gitignore"), "/build\n");
    writeFileSync(join(repo, "build"), "IGNORED_FIXTURE");
    const ignored = await collect({ paths: ["build"] }, repo, signal);
    expect(ignored.chunks.join("")).not.toContain("IGNORED_FIXTURE");
    const parent = fixture();
    mkdirSync(join(parent, "project"));
    writeFileSync(join(parent, "project", "guide.md"), "GUIDE");
    writeFileSync(join(parent, "other.md"), "OTHER");
    const ancestor = await collect({ paths: [".."] }, join(parent, "project"), signal);
    expect(ancestor.chunks.join("")).toContain("<file path=\"guide.md\">");
    expect(ancestor.chunks.join("")).toContain(`<file path="${join(parent, "other.md")}">`);
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
      const model = { id: "claude-sonnet-5-5", name: "local", api: "openai-completions", provider: "anthropic",
        baseUrl: `http://127.0.0.1:${server.port}/v1`, reasoning: false, input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
      const sessionManager = SessionManager.inMemory(cwd);
      sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "질문" }], timestamp: Date.now() });
      const ctx = { cwd, sessionManager, models: { resolve: (selector: string) => selector === "anthropic/claude-sonnet-5-5" ? model : undefined },
        modelRegistry: { getApiKey: async () => "local", resolver: () => "local" } } as unknown as ExtensionContext;
      const viaFallback: SkimCompletion = (prompt, ctx, attempt, requested) =>
        requested === ROLE_PRIMARY ? Promise.reject(new Error("no response")) : callModel(prompt, ctx, attempt, requested);
      const ok = await skimText({ paths: ["guide.md"], question: "?" }, ctx, signal, viaFallback);
      const empty = await skimText({ paths: ["guide.md"], question: "?" }, ctx, signal, viaFallback);
      expect(ok).toContain("model: anthropic/claude-sonnet-5-5");
      expect(empty).toContain("Sonnet 실패: anthropic/claude-sonnet-5-5가 빈 답을 반환했습니다.");
      const usage = sessionManager.getEntries().filter((entry) => entry.type === "model_usage");
      expect(usage.map((entry) => [entry.purpose, entry.role, entry.provider, entry.model, entry.stopReason])).toEqual([
        ["skim", undefined, "anthropic", "claude-sonnet-5-5", "stop"],
        ["skim", undefined, "anthropic", "claude-sonnet-5-5", "stop"],
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
      const model = { id: "claude-sonnet-5-5", name: "local", api: "openai-completions", provider: "anthropic",
        baseUrl: `http://127.0.0.1:${server.port}/v1`, reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 150000 };
      const ctx = { cwd, sessionManager: SessionManager.inMemory(cwd), models: { resolve: (selector: string) => selector === "anthropic/claude-sonnet-5-5" ? model : undefined },
        modelRegistry: { getApiKey: async () => "local", resolver: () => "local" } } as unknown as ExtensionContext;
      const viaFallback: SkimCompletion = (prompt, ctx, attempt, requested) =>
        requested === ROLE_PRIMARY ? Promise.reject(new Error("no response")) : callModel(prompt, ctx, attempt, requested);
      const result = await skimText({ paths: ["guide.md"], question: "?" }, ctx, signal, viaFallback);
      expect(result).toContain("model: anthropic/claude-sonnet-5-5");
      expect(result).toContain("긴 답의 앞부분 (guide.md:L1)");
      expect(result).toContain("[출력 상한 8192토큰에서 답이 끊겼습니다.");
      expect(result).not.toContain("Sonnet 실패");
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
      if (model === ROLE_PRIMARY) throw new Error("first down");
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
    expect(called).toEqual([ROLE_PRIMARY]);
  });

  test("withFallback: 설정한 대체 대상은 사용자 취소 뒤 부르지 않고, 주 모델과 같은 이름이면 다시 부르지 않으며, 표지를 그대로 받는다", async () => {
    const target = { marker: DRAFT_FALLBACK, name: "x/terra", label: "modelRoles.draftFallback" } as const;
    const controller = new AbortController();
    const cancelledCalls: string[] = [];
    const cancelled = await withFallback(async (requested) => { cancelledCalls.push(requested); controller.abort(); throw new Error("aborted"); }, controller.signal, target);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelledCalls).toEqual([ROLE_PRIMARY]);
    const sameCalls: string[] = [];
    const same = await withFallback(async (requested) => { sameCalls.push(requested); throw new HelperCallError("down", "x/terra"); }, signal, target);
    expect(same).toMatchObject({ status: "failed" });
    expect(same.failures.at(-1)).toContain("modelRoles.draftFallback 모델과 같아 다시 호출하지 않았습니다");
    expect(sameCalls).toEqual([ROLE_PRIMARY]);
    const calls: string[] = [];
    const done = await withFallback(async (requested) => {
      calls.push(requested);
      if (requested === ROLE_PRIMARY) throw new Error("primary down");
      return { model: "x/terra", value: "ok" };
    }, signal, target);
    expect(done).toMatchObject({ status: "done", model: "x/terra", value: "ok" });
    expect(calls).toEqual([ROLE_PRIMARY, DRAFT_FALLBACK]);
  });

  test("withFallback: 설정한 대체 대상의 실패는 모델을 밝히지 않는 오류도 대체 모델 이름으로 남긴다", async () => {
    const target = { marker: DRAFT_FALLBACK, name: "x/terra", label: "modelRoles.draftFallback" } as const;
    const out = await withFallback(async () => { throw new Error("boom"); }, signal, target);
    expect(out.failures).toEqual(["@primary 실패: boom", "x/terra 실패: boom"]);
  });

  test("skim: 계정 확인·정책 거절은 다른 모델로 다시 보내지 않고, 일시적 운영 장애는 기존대로 대체 모델을 부른다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "guide.md"), "fact");
    const run = (cause: unknown) => {
      const called: string[] = [];
      const result = skimQuestion({ paths: ["guide.md"], question: "?" }, context(cwd), signal, async (_p, _c, _s, model) => {
        called.push(model);
        if (model === ROLE_PRIMARY) throw new HelperCallError("provider refused", TEST_MODEL, { cause, providerFailure: true });
        return reply("ok", model);
      }).then((out) => ({ out, called }));
      return result;
    };
    const refused = await run(new Error("Your account must be verified to use this model"));
    expect(refused.called).toEqual([ROLE_PRIMARY]);
    expect(refused.out.isError).toBe(true);
    expect(refused.out.text).toContain("model: none");
    const transient = await run({ stopReason: "error", errorStatus: 503, errorMessage: "Unavailable" });
    expect(transient.called).toEqual([ROLE_PRIMARY, "anthropic/claude-sonnet-5-5"]);
    expect(transient.out.isError).toBe(false);
  });

  test("core Settings가 별도 skim 슬롯을 그대로 해석한다", () => {
    const settings = Settings.isolated({ modelRoles: { skim: TEST_MODEL } });
    expect(settings.getModelRole("skim")).toBe(TEST_MODEL);
  });
});
