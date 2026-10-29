import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";

// mock.module은 프로세스 전체에 남아 다른 테스트 파일(character-voice 등)을 깨므로, 가짜를 거는 본문은 이 파일을 다시 실행하는 자식 프로세스에서만 돈다.
const inChild = process.env.ADVISORY_WIRING_CHILD === "1";

// 실제 도구 진입점(executeCrossReview 기본 reviewDeps, slop_check 등록 도구의 execute)과 실제 completeReviewer·advisoryFallbackOf를 거친다.
// 가짜는 제공자 호출(completeSimple)과 settings의 modelRoles 조회뿐이다. 두 모듈은 끝나면 원래 것으로 되돌린다.
const realAi = await import("@oh-my-pi/pi-ai");
const realSettings = await import("@oh-my-pi/pi-coding-agent/config/settings");

const roles: Record<string, string | undefined> = {};
const providerCalls: string[] = [];
const dirs: string[] = [];
const saved = { xr: process.env.OMP_CROSS_REVIEW_LEDGER, snap: process.env.OMP_CROSS_REVIEW_DIR, slop: process.env.OMP_SLOP_GATE_LEDGER };
const env = (name: "xr" | "snap" | "slop", value: string | undefined) => {
  const key = { xr: "OMP_CROSS_REVIEW_LEDGER", snap: "OMP_CROSS_REVIEW_DIR", slop: "OMP_SLOP_GATE_LEDGER" }[name];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
};

beforeAll(() => {
  if (!inChild) return;
  mock.module("@oh-my-pi/pi-ai", () => ({
    ...realAi,
    completeSimple: async (model: { id: string }) => {
      providerCalls.push(model.id);
      // 필수 reviewer(Astra)는 깨끗한 답, 자문(Argon)은 오류, 대체 모델이 불리면 안 되므로 그 id는 만들지 않는다.
      if (model.id === "gemini-4-argon") return { stopReason: "error", errorMessage: "429 quota exhausted", content: [], usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } } };
      return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ findings: [], files: [{ id: "a1", findings: [] }], summary: "ok" }) }], usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } } };
    },
  }));
  mock.module("@oh-my-pi/pi-coding-agent/config/settings", () => ({ ...realSettings, findScopedSettings: () => ({ getModelRole: (slot: string) => roles[slot] }) }));
});
afterAll(() => {
  if (!inChild) return;
  mock.module("@oh-my-pi/pi-ai", () => realAi);
  mock.module("@oh-my-pi/pi-coding-agent/config/settings", () => realSettings);
  env("xr", saved.xr); env("snap", saved.snap); env("slop", saved.slop);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { dir: string; ctx: never } {
  const dir = mkdtempSync(join(tmpdir(), "advisory-fallback-wiring-"));
  dirs.push(dir);
  env("xr", join(dir, "xr.jsonl")); env("snap", join(dir, "snap")); env("slop", join(dir, "slop.jsonl"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git("add", "."); git("commit", "-qm", "init");
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "new.html"), "<p>새 문서의 본문은 이렇게 짧다. 설치하고 실행하면 된다. 끝이다.</p>\n");
  const split = (name: string) => { const [provider, ...rest] = name.split("/"); return { provider: provider!, id: rest.join("/"), api: "x", maxTokens: 1000 }; };
  const ctx = {
    cwd: dir, agent: { kind: "main" }, model: { provider: "anthropic", id: "claude-sonnet-5-5" },
    models: { current: () => ({ provider: "anthropic", id: "claude-sonnet-5-5" }), resolve: (selector: string) => { const name = roles[selector.slice(1)]; return name && !name.startsWith("nowhere/") ? split(name) : undefined; } },
    modelRegistry: { getApiKey: async () => "key", resolver: () => "key" },
    sessionManager: { getSessionId: () => "wiring", getLeafId: () => "leaf" },
    isIdle: () => true,
  } as never;
  return { dir, ctx };
}

const base = { crossReviewOpenAI: "openai-codex/gpt-6-astra", crossReviewAnthropic: "anthropic/claude-opus-5-5", crossReviewAdvisory: "aistudio/gemini-4-argon" };

test("배선 검사는 격리된 자식 프로세스에서 모두 통과한다", () => {
  if (inChild) return;
  const child = Bun.spawnSync([process.execPath, "test", import.meta.path], { env: { ...process.env, ADVISORY_WIRING_CHILD: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, `${child.stdout.toString()}${child.stderr.toString()}`).toBe(0);
});

(inChild ? describe : describe.skip)("자문 대체 설정 배선: 설정했지만 비어 있거나 풀리지 않으면 대체 실패로 기록하고 다른 모델로 넘어가지 않는다", () => {
  for (const [label, selector] of [["빈 문자열", ""], ["풀 수 없는 selector", "nowhere/missing-model"]] as const) {
    test(`cross_review: ${label}`, async () => {
      const { executeCrossReview } = await import("../cross-review");
      const { ctx } = workspace();
      for (const key of Object.keys(roles)) delete roles[key];
      Object.assign(roles, base, { crossReviewAdvisoryFallback: selector });
      providerCalls.length = 0;
      const review = await executeCrossReview({ action: "review", files: ["a.ts"], acceptance: "a stays 1", authors: ["anthropic/claude-sonnet-5-5"] }, ctx, new AbortController().signal) as { reviewers: { family: string; model: string; status: string; error?: string; fallbackFrom?: { model: string; status: string; error: string } }[]; passable: boolean };
      const advisory = review.reviewers.find((reviewer) => reviewer.family === "advisory")!;
      expect(advisory).toMatchObject({ status: "error", fallbackFrom: { model: "aistudio/gemini-4-argon", status: "error", error: expect.stringContaining("429") } });
      expect(advisory.error).toContain(selector === "" ? "modelRoles.crossReviewAdvisoryFallback is not configured" : "Could not resolve modelRoles.crossReviewAdvisoryFallback");
      expect(providerCalls).toEqual(["gpt-6-astra", "gemini-4-argon"]);
      expect(review.passable).toBe(true);
    });

    test(`slop_check: ${label}`, async () => {
      const slop = await import("../slop-gate");
      const { ctx } = workspace();
      for (const key of Object.keys(roles)) delete roles[key];
      Object.assign(roles, base, { crossReviewAdvisoryFallback: selector });
      providerCalls.length = 0;
      let tool: { execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> } | undefined;
      slop.default({ zod, registerTool: (registered: never) => { tool = registered; }, on: () => {}, sendMessage: () => {}, setLabel: () => {} } as never);
      const result = await tool!.execute("1", { action: "review", files: ["docs/new.html"], authors: ["anthropic/claude-sonnet-5-5"] }, new AbortController().signal, undefined, ctx);
      const text = result.content[0]!.text;
      const parsed = JSON.parse(text.slice(text.indexOf("{")));
      expect(parsed.failedAttempts).toMatchObject([{ family: "advisory", model: "aistudio/gemini-4-argon", status: "error", error: expect.stringContaining("429") }, { family: "advisory", status: "error", error: expect.stringContaining("crossReviewAdvisoryFallback") }]);
      const advisory = parsed.reviewers.find((reviewer: { family: string }) => reviewer.family === "advisory");
      expect(advisory).toMatchObject({ status: "error", error: expect.stringContaining(selector === "" ? "modelRoles.crossReviewAdvisoryFallback is not configured" : "Could not resolve modelRoles.crossReviewAdvisoryFallback") });
      expect(providerCalls).toEqual(["gpt-6-astra", "gemini-4-argon"]);
      expect(parsed.files[0].status).toBe("pass");
    });
  }
});

(inChild ? describe : describe.skip)("slop_check reviewer slot: slopReviewOpenAI(Luna)·slopReviewGemini(Flash)가 있으면 그 모델, 없거나 풀리지 않으면 옛 slot", () => {
  type Reviewer = { family: string; model?: string; status: string; error?: string; advisory?: true };
  const runSlop = async (author: string, extra: Record<string, string>) => {
    const slop = await import("../slop-gate");
    const { ctx } = workspace();
    for (const key of Object.keys(roles)) delete roles[key];
    Object.assign(roles, base, extra);
    providerCalls.length = 0;
    let tool: { execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> } | undefined;
    slop.default({ zod, registerTool: (registered: never) => { tool = registered; }, on: () => {}, sendMessage: () => {}, setLabel: () => {} } as never);
    const result = await tool!.execute("1", { action: "review", files: ["docs/new.html"], authors: [author] }, new AbortController().signal, undefined, ctx);
    const text = result.content[0]!.text;
    return JSON.parse(text.slice(text.indexOf("{"))) as { reviewers: Reviewer[]; files: { status: string }[] };
  };
  const both = { slopReviewOpenAI: "openai-codex/gpt-6-luna", slopReviewGemini: "aistudio/gemini-3.8-flash" };
  const answered = (parsed: { reviewers: Reviewer[] }) => parsed.reviewers.map((reviewer) => `${reviewer.family}:${reviewer.model}`).sort();

  test("Anthropic 저자: Luna가 필수, Gemini Flash가 자문(Opus·Astra·Argon은 부르지 않는다)", async () => {
    const parsed = await runSlop("anthropic/claude-sonnet-5-5", both);
    expect([...providerCalls].sort()).toEqual(["gemini-3.8-flash", "gpt-6-luna"]);
    expect(answered(parsed)).toEqual(["advisory:aistudio/gemini-3.8-flash", "openai:openai-codex/gpt-6-luna"]);
    expect(parsed.reviewers.find((reviewer) => reviewer.family === "advisory")).toMatchObject({ advisory: true });
    expect(parsed.files[0]!.status).toBe("pass");
  });

  test("OpenAI 저자: Gemini Flash가 필수이고 Luna(같은 계열)는 건너뛴다", async () => {
    const parsed = await runSlop("openai-codex/gpt-6-astra", both);
    expect(providerCalls).toEqual(["gemini-3.8-flash"]);
    expect(answered(parsed)).toEqual(["google:aistudio/gemini-3.8-flash"]);
    expect(parsed.files[0]!.status).toBe("pass");
  });

  test("slot이 없거나 풀리지 않으면 옛 경로(crossReviewOpenAI Astra 필수 + crossReviewAdvisory 자문)", async () => {
    for (const extra of [{}, { slopReviewOpenAI: "nowhere/missing", slopReviewGemini: "nowhere/missing" }]) {
      const parsed = await runSlop("anthropic/claude-sonnet-5-5", extra);
      expect([...providerCalls].sort()).toEqual(["gemini-4-argon", "gpt-6-astra"]);
      expect(parsed.reviewers.find((reviewer) => reviewer.family === "openai")).toMatchObject({ status: "ok", model: "openai-codex/gpt-6-astra" });
    }
  });

  test("한쪽 slot만 있으면 그 자리만 바뀐다: Luna만 → Luna 필수 + Argon 자문", async () => {
    await runSlop("anthropic/claude-sonnet-5-5", { slopReviewOpenAI: "openai-codex/gpt-6-luna" });
    expect([...providerCalls].sort()).toEqual(["gemini-4-argon", "gpt-6-luna"]);
  });

  test("slot이 계열이 맞지 않는 모델로 풀리면 거절되어 통과가 없다", async () => {
    const luna = await runSlop("anthropic/claude-sonnet-5-5", { slopReviewOpenAI: "anthropic/claude-opus-5-5" });
    expect(luna.reviewers.find((reviewer) => reviewer.family === "openai")).toMatchObject({ status: "error", error: expect.stringContaining("not a openai model") });
    expect(luna.files[0]!.status).toBe("error");
    expect(providerCalls).not.toContain("claude-opus-5-5");
    const flash = await runSlop("openai-codex/gpt-6-astra", { slopReviewGemini: "anthropic/claude-opus-5-5" });
    expect(flash.reviewers.find((reviewer) => reviewer.family === "google")).toMatchObject({ status: "error", error: expect.stringContaining("not a google model") });
    expect(flash.files[0]!.status).toBe("error");
    expect(providerCalls).not.toContain("claude-opus-5-5");
  });
});
