import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 이 회귀는 설치된(또는 격리 패치된) core가 실제로 조립하는 system prompt를 검사한다.
// 대상 경로가 runtime fixture이므로 이 boundary만 동적 import를 사용한다.
const npmModules = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
const coreRoot = process.env.OMP_CORE_PATCH_TARGET
  ?? [
    ...["cuelo", "omp-web"].map((name) => join(npmModules, name, "node_modules/@oh-my-pi/pi-coding-agent")),
    join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"),
  ].find((dir) => existsSync(dir))
  ?? join(npmModules, "cuelo/node_modules/@oh-my-pi/pi-coding-agent");
const systemPromptModule = join(coreRoot, "src/system-prompt.ts").replace(/\\/gu, "/");
if (!existsSync(systemPromptModule)) {
  throw new Error(`system prompt core를 찾지 못했다: ${systemPromptModule}`);
}
const { buildSystemPrompt } = await import(systemPromptModule);

import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import characterVoice, {
  anthropicCharacterForAccounts,
  CHARACTER_TARGETS,
  CHARACTER_VOICES,
  characterForProvider,
  characterTarget,
  buildCharacterSummonBrief,
  injectCharacterVoice,
  parseCharacterIntent,
  parseCharacterSummonDirectives,
  renderCharacterSummonRouting,
  parseCharacterSummonMarker,
  roleModelSelector,
  malformedSummonMarkerReason,
  renderCharacterVoice,
  rewriteTaskInputForCharacterSummon,
  setCharacterIntentJudgeResolver,
} from "../character-voice";
import type { CharacterAlias } from "../character-voice";

// 사무실 모드는 agent dir의 모드 파일·명단을 요청마다 읽는다. 실제 프로필이 사무실 모드여도 기본 출력 회귀가 흔들리지 않게
// 이 파일은 빈 agent dir에서 돈다(사무실 모드 테스트는 withOfficeProfile이 따로 덮는다).
const realAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "character-voice-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
afterAll(() => {
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
  rmSync(isolatedAgentDir, { recursive: true, force: true });
});

// 호출·교체 의도 확인은 JEV를 부른다. 기존 회귀는 판정기가 없는 경로(정규식 결과 그대로)로 결정적으로 돌고,
// JEV 판정을 보는 테스트만 가짜 판정기를 따로 넣는다.
const noJudge = async () => { throw new Error("judge unavailable in tests"); };
beforeEach(() => setCharacterIntentJudgeResolver(noJudge));
afterAll(() => setCharacterIntentJudgeResolver(undefined));

/** 정해진 답을 돌려주는 가짜 JEV. 받은 state를 judged에 남긴다. */
function fakeIntentJudge(choice: string, judged: unknown[] = []) {
  return async () => ({
    judge: async (request: { state: unknown }) => {
      judged.push(request.state);
      return { answers: { intent: { type: "choice", choice, probabilities: { [choice]: 0.9 } } } } as never;
    },
  });
}

type Handler = (event: unknown, ctx: unknown) => unknown;

interface HarnessOptions {
  unavailableSelector?: string;
  recoverableSelector?: string;
  discoveryError?: string;
  /** sessions.pin이 false를 돌려주는 경우(override·비 OAuth 행). */
  pinRefused?: boolean;
  /** pi.setModel이 인증 부재로 false를 돌려주는 selector. */
  refusedModelSelector?: string;
}

function createRuntimeHarness(options: HarnessOptions = {}) {
  const handlers: Record<string, Handler[]> = {};
  const calls: string[] = [];
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const models = [
    { provider: "openai-codex", id: "gpt-6-astra" },
    { provider: "anthropic", id: "claude-opus-5-5" },
    { provider: "hive", id: "deepseek-ai/deepseek-v4.1-flash-1017" },
    { provider: "hive", id: "zai-org/glm-5.3-flash" },
  ];
  const accounts = [
    { position: 0, credentialId: 11, active: false },
    { position: 1, credentialId: 13, active: true },
  ];
  let currentModel = models[0]!;
  let discovered = false;

  // 18.3.0 AuthStorage 네임스페이스(credentials·oauth·sessions)와 core patch의 exact pin 계약:
  // sessions.pin의 options.exactLabel, exact pin이면 sessions.release는 false.
  let exactPinLabel: string | undefined;
  const authStorage = {
    credentials: {
      async reload() {
        calls.push("reload");
      },
    },
    oauth: {
      accounts() {
        return accounts;
      },
    },
    sessions: {
      pin(
        _provider: string,
        _sessionId: string,
        credentialId: number,
        pinOptions?: { restoredAtMs?: number; exactLabel?: string },
      ) {
        const account = accounts.find((candidate) => candidate.credentialId === credentialId);
        if (options.pinRefused || !account) return false;
        for (const candidate of accounts) candidate.active = candidate === account;
        exactPinLabel = pinOptions?.exactLabel;
        calls.push(`pin:${credentialId}${exactPinLabel ? `:exact:${exactPinLabel}` : ""}`);
        return true;
      },
      release() {
        if (exactPinLabel || !accounts.some((account) => account.active)) return false;
        for (const account of accounts) account.active = false;
        calls.push("release");
        return true;
      },
    },
  };
  const ctx = {
    get model() {
      return currentModel;
    },
    models: {
      resolve(selector: string) {
        if (selector === options.unavailableSelector) return undefined;
        if (selector === options.recoverableSelector && !discovered) return undefined;
        return models.find((model) => `${model.provider}/${model.id}` === selector);
      },
    },
    modelRegistry: {
      authStorage,
      hasProvider: (provider: string) => provider === "hive",
      async refreshDiscoverableProviders(providers: Iterable<string>) {
        calls.push(`discover:${[...providers].join(",")}`);
        if (options.discoveryError) throw new Error(options.discoveryError);
        discovered = true;
      },
    },
    sessionManager: { getSessionId: () => "session-1" },
  };
  const pi = {
    on(name: string, handler: Handler) {
      (handlers[name] ??= []).push(handler);
    },
    async setModel(model: { provider: string; id: string }) {
      if (`${model.provider}/${model.id}` === options.refusedModelSelector) {
        calls.push(`set-refused:${model.provider}/${model.id}`);
        return false;
      }
      currentModel = model;
      calls.push(`set:${model.provider}/${model.id}`);
      return true;
    },
    sendMessage(message: Record<string, unknown>, sendOptions: Record<string, unknown>) {
      sent.push({ message, options: sendOptions });
    },
  };
  characterVoice(pi as never);

  return {
    calls,
    sent,
    ctx,
    accounts,
    /** `/model` 같은 선택 밖의 model 변경을 흉내 낸다. */
    selectModel(selector: string) {
      const next = models.find((model) => `${model.provider}/${model.id}` === selector);
      if (!next) throw new Error(`unknown model ${selector}`);
      currentModel = next;
    },
    async emit(name: string, event: unknown) {
      let result: unknown;
      for (const handler of handlers[name] ?? []) {
        const candidate = await handler(event, ctx);
        if (candidate !== undefined) result = candidate;
      }
      return result;
    },
  };
}

describe("character voice identity", () => {
  test("character targets use exact runtime selectors", () => {
    expect(CHARACTER_TARGETS).toEqual({
      "YUKI(유키)": { model: "openai-codex/gpt-6-astra", toolCapable: true },
      "ISANA(이사나)": { model: "hive/deepseek-ai/deepseek-v4.1-flash-1017", toolCapable: true },
      "MIO(미오)": { model: "anthropic/claude-opus-5-5", oauthPosition: 1, toolCapable: true },
      "RIN(린)": { model: "anthropic/claude-opus-5-5", oauthPosition: 0, toolCapable: true },
      "MITSU(미츠)": { model: "hive/zai-org/glm-5.3-flash", toolCapable: true },
      "SHION(시온)": { model: "web6/gpt-6-pro", toolCapable: false },
      "HIKARI(히카리)": { model: "google-vertex/gemini-4-argon", toolCapable: true },
    });
    expect(characterForProvider("openai-codex")).toBe("YUKI(유키)");
    expect(characterForProvider("hive")).toBe("ISANA(이사나)");
    expect(characterForProvider("hive", [], "deepseek-ai/deepseek-v4.1-flash-1017")).toBe("ISANA(이사나)");
    expect(characterForProvider("hive", [], "zai-org/glm-5.3-flash")).toBe("MITSU(미츠)");
    expect(characterForProvider("opencode-go")).toBeUndefined();
    expect(characterForProvider("web6")).toBe("SHION(시온)");
    expect(characterForProvider("google-antigravity")).toBeUndefined();
    expect(characterForProvider("google-antigravity", [], "gemini-3.8-flash")).toBe("HIKARI(히카리)");
    expect(characterForProvider("google-vertex", [], "gemini-4-argon")).toBe("HIKARI(히카리)");
    // 모델 id로 거는 얼굴이라 다른 공급자 아래의 같은 모델도 HIKARI다. 모델이 없거나 다른 모델이면 아니다.
    expect(characterForProvider("localproxy", [], "gemini-4-argon")).toBe("HIKARI(히카리)");
    expect(characterForProvider("localproxy")).toBeUndefined();
    expect(characterForProvider("localproxy", [], "other-model")).toBeUndefined();
    expect(characterForProvider("google-vertex", [], "claude-opus-4-6")).toBeUndefined();
  });

  test("Anthropic stable storage positions map 0 to RIN and 1 to MIO", () => {
    expect(anthropicCharacterForAccounts([
      { position: 0, credentialId: 11, active: true },
      { position: 1, credentialId: 13, active: false },
    ])).toBe("RIN(린)");
    expect(anthropicCharacterForAccounts([
      { position: 0, credentialId: 11, active: false },
      { position: 1, credentialId: 13, active: true },
    ])).toBe("MIO(미오)");
  });

  test("a known unmapped Anthropic account is not the unselected default", () => {
    expect(characterForProvider("anthropic", [
      { position: 2, credentialId: 17, active: true },
    ])).toBeUndefined();
  });

  test("effective Main prompt omits generic report personality and keeps conversational voice authoritative", async () => {
    const agentsPath = resolve(import.meta.dirname, "../..", "AGENTS.md");
    const built = await buildSystemPrompt({
      cwd: resolve(import.meta.dirname, "../.."),
      personality: "none",
      tools: new Map(),
      toolNames: [],
      skills: [],
      rules: [],
      alwaysApplyRules: [],
      contextFiles: [{
        path: agentsPath,
        content: readFileSync(agentsPath, "utf8"),
        level: "project",
        depth: 0,
        _source: { kind: "test" },
      } as never],
    });
    const harness = createRuntimeHarness();
    const result = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "오늘 기분 어때?",
      systemPrompt: built.systemPrompt,
    }) as { systemPrompt: string[] };
    const effective = result.systemPrompt.join("\n");
    expect(effective).not.toContain("Evidence-first terse engineer");
    expect(effective).not.toContain("# Reasoning Format");
    expect(effective).not.toContain("Problem: what's wrong");
    expect(effective.match(/<character-voice alias="YUKI\(유키\)">/gu)).toHaveLength(1);
  });

  test("natural-language summon and current-session switch follow action semantics", () => {
    expect(parseCharacterIntent("린 호출해")).toEqual({ kind: "summon", aliases: ["RIN(린)"] });
    expect(parseCharacterIntent("미오 불러와")).toEqual({ kind: "summon", aliases: ["MIO(미오)"] });
    expect(parseCharacterIntent("이 대화에서 미오불러와")).toEqual({ kind: "summon", aliases: ["MIO(미오)"] });
    expect(parseCharacterIntent("미오를 불러오다")).toEqual({ kind: "summon", aliases: ["MIO(미오)"] });
    expect(parseCharacterIntent("미오 소환해")).toEqual({ kind: "summon", aliases: ["MIO(미오)"] });
    expect(parseCharacterIntent("린으로 교체해")).toEqual({ kind: "switch", alias: "RIN(린)" });
    expect(parseCharacterIntent("장난치지말고 교체해봐 미오로")).toEqual({ kind: "switch", alias: "MIO(미오)" });
    expect(parseCharacterIntent("메인을 MIO로 지금 교체해 주세요.")).toEqual({ kind: "switch", alias: "MIO(미오)" });
    expect(parseCharacterIntent("시온 호출해")).toEqual({ kind: "summon", aliases: ["SHION(시온)"] });
    expect(parseCharacterIntent("미오와 린을 교체해")).toBeUndefined();
    expect(parseCharacterIntent("히카리 불러와")).toEqual({ kind: "summon", aliases: ["HIKARI(히카리)"] });
    expect(parseCharacterIntent("hikari로 교체해")).toEqual({ kind: "switch", alias: "HIKARI(히카리)" });
    // 이미 일어난 전환을 설명하는 과거·수동형은 명령이 아니다(2026-09-29 오전환 재현 문장 포함).
    expect(parseCharacterIntent("아까 유키로 교체됐었어")).toBeUndefined();
    expect(parseCharacterIntent("유키로 바로교체됬었어..")).toBeUndefined();
    expect(parseCharacterIntent("린으로 교체된 거 맞아?")).toBeUndefined();
    // 부정·설명 요청은 교체 명령이 아니다(2026-09-29 사용자 반례).
    expect(parseCharacterIntent("유키로 교체하지 마")).toBeUndefined();
    expect(parseCharacterIntent("유키로 교체하는 방법만 설명해줘")).toBeUndefined();
    expect(parseCharacterIntent("린으로 교체해야 할까?")).toBeUndefined();
    expect(parseCharacterIntent("미오로 교체 좀 해줘")).toEqual({ kind: "switch", alias: "MIO(미오)" });
    expect(parseCharacterIntent("미오로 교체!")).toEqual({ kind: "switch", alias: "MIO(미오)" });
    expect(parseCharacterIntent("유키로 교체해 달라는 말이 아니야")).toBeUndefined();
    expect(parseCharacterIntent("유키로 교체해 라는 문장을 설명해줘")).toBeUndefined();
    expect(parseCharacterIntent("유키로 교체해도 돼?")).toBeUndefined();
    expect(parseCharacterIntent("유키로 교체해 주는 방법 알려줘")).toBeUndefined();
    expect(parseCharacterIntent("유키로 교체해 주지 마")).toBeUndefined();
    expect(parseCharacterIntent("유키로 교체해 줘야 하는지 설명해줘")).toBeUndefined();
    expect(parseCharacterIntent("유키로 안 교체해")).toBeUndefined();
    expect(parseCharacterIntent("유키로 못 교체해")).toBeUndefined();
    expect(parseCharacterIntent("유키로 교체 안 해")).toBeUndefined();
    expect(parseCharacterIntent("유키로 절대 교체해 주지 마")).toBeUndefined();
    expect(parseCharacterIntent("린으로 교체해줘 지금")).toEqual({ kind: "switch", alias: "RIN(린)" });
    expect(parseCharacterIntent("미오로 교체 좀 부탁해")).toEqual({ kind: "switch", alias: "MIO(미오)" });
    expect(parseCharacterIntent("린으로 교체하자")).toEqual({ kind: "switch", alias: "RIN(린)" });
  });

  test("a summon verb followed by a particle is a noun, not a summon command", () => {
    // 2026-10-26: `히카리호출도 프록시로바꿔임마`(히카리 호출 모델을 프록시로 바꾸라는 설정 요청)가 소환으로 읽혔다.
    expect(parseCharacterIntent("히카리호출도 프록시로바꿔임마")).toBeUndefined();
    expect(parseCharacterIntent("히카리 호출은 프록시로 바꿔")).toBeUndefined();
    expect(parseCharacterIntent("미오 소환이 안 돼")).toBeUndefined();
    expect(parseCharacterIntent("린 호출을 막아줘")).toBeUndefined();
    expect(parseCharacterIntent("시온 호출가")).toBeUndefined();
    // 명령형·청유형 어미는 그대로 소환이다.
    expect(parseCharacterIntent("히카리 호출해")).toEqual({ kind: "summon", aliases: ["HIKARI(히카리)"] });
    expect(parseCharacterIntent("히카리호출해")).toEqual({ kind: "summon", aliases: ["HIKARI(히카리)"] });
    expect(parseCharacterIntent("히카리 불러와")).toEqual({ kind: "summon", aliases: ["HIKARI(히카리)"] });
    expect(parseCharacterIntent("미오 소환")).toEqual({ kind: "summon", aliases: ["MIO(미오)"] });
    expect(parseCharacterIntent("린 호출하자")).toEqual({ kind: "summon", aliases: ["RIN(린)"] });
  });

  describe("HIKARI target follows modelRoles.implGemini", () => {
    const withRole = <T>(selector: string | undefined, fn: () => T): T =>
      withActiveSettings(Settings.isolated(selector === undefined ? {} : { modelRoles: { implGemini: selector } }), fn);
    const markerFor = (model: string) => `[character-summon alias="HIKARI(히카리)" model="${model}"]`;

    test("the role selector wins with any :level suffix stripped", () => {
      expect(withRole("localproxy/gemini-4-argon:auto", () => characterTarget("HIKARI(히카리)"))).toEqual({
        model: "localproxy/gemini-4-argon",
        toolCapable: true,
      });
      expect(withRole("localproxy/gemini-4-argon:high", () => characterTarget("HIKARI(히카리)")?.model)).toBe("localproxy/gemini-4-argon");
      expect(withRole("localproxy/gemini-4-argon", () => characterTarget("HIKARI(히카리)")?.model)).toBe("localproxy/gemini-4-argon");
      // 모델 id에 들어 있는 콜론은 접미사가 아니다.
      expect(roleModelSelector("localproxy/vendor/model:free:low")).toBe("localproxy/vendor/model:free");
    });

    test("an unset or malformed role falls back to the built-in selector", () => {
      const fallback = CHARACTER_TARGETS["HIKARI(히카리)"].model;
      expect(withRole(undefined, () => characterTarget("HIKARI(히카리)")?.model)).toBe(fallback);
      expect(withRole("", () => characterTarget("HIKARI(히카리)")?.model)).toBe(fallback);
      expect(withRole("no-provider-part", () => characterTarget("HIKARI(히카리)")?.model)).toBe(fallback);
      expect(withRole("localproxy/", () => characterTarget("HIKARI(히카리)")?.model)).toBe(fallback);
      expect(roleModelSelector(undefined)).toBeUndefined();
    });

    test("the marker writer and validator use the same resolved selector, and other seats are untouched", () => {
      withRole("localproxy/gemini-4-argon:auto", () => {
        expect(renderCharacterSummonRouting(["HIKARI(히카리)"])).toContain("localproxy/gemini-4-argon을(를) 호출한다고");
        expect(rewriteTaskInputForCharacterSummon({ tasks: [{ agent: "maker", task: `${markerFor("localproxy/gemini-4-argon")}\n인사` }] }, ["HIKARI(히카리)"]).ok).toBe(true);
        // 낡은 marker(이전 선택자)는 단일 호출에서 지금 role의 exact marker로 다시 쓰인다.
        const restamped = rewriteTaskInputForCharacterSummon({ tasks: [{ agent: "maker", task: `${markerFor("google-vertex/gemini-4-argon")}\n인사` }] }, ["HIKARI(히카리)"]);
        expect(JSON.stringify(restamped)).toContain("model=\\\"localproxy/gemini-4-argon\\\"");
        expect(malformedSummonMarkerReason(markerFor("google-vertex/gemini-4-argon"))).toContain(markerFor("localproxy/gemini-4-argon"));
        expect(parseCharacterSummonMarker(markerFor("localproxy/gemini-4-argon"))).toBe("HIKARI(히카리)");
        expect(parseCharacterSummonMarker(markerFor("google-vertex/gemini-4-argon"))).toBeUndefined();
        expect(characterTarget("MIO(미오)")).toEqual(CHARACTER_TARGETS["MIO(미오)"]);
      });
      withRole(undefined, () => {
        expect(parseCharacterSummonMarker(markerFor("google-vertex/gemini-4-argon"))).toBe("HIKARI(히카리)");
      });
    });

    test("a role pointing at another model does not hand HIKARI's face to it", () => {
      withRole("google-vertex/claude-opus-5-5:low", () => {
        expect(characterForProvider("google-vertex", [], "claude-opus-5-5")).toBeUndefined();
        expect(characterForProvider("localproxy", [], "gemini-4-argon")).toBe("HIKARI(히카리)");
      });
    });

    test("a selector with a blank provider or model part is malformed", () => {
      expect(roleModelSelector("google-vertex/ :low")).toBeUndefined();
      expect(roleModelSelector(" /gemini-4-argon")).toBeUndefined();
      expect(withRole("google-vertex/ :low", () => characterTarget("HIKARI(히카리)")?.model)).toBe(CHARACTER_TARGETS["HIKARI(히카리)"].model);
    });
  });

  test("review paragraphs that quote switch sentences never become a switch command", () => {
    // 반례를 인용한 리뷰 단락이 실제 Main 교체를 일으켰다(2026-09-29).
    const review = [
      "리뷰: parseCharacterIntent가 '유키로 교체하지 마', '유키로 교체하는 방법만 설명해줘'를 교체로 읽었다.",
      "기존 긍정 \"린으로 교체해\"와 `미오로 교체해`는 보존한다.",
      "> 유키로 교체해",
      "```",
      "parseCharacterIntent(\"hikari로 교체해\")",
      "```",
    ].join("\n");
    expect(parseCharacterIntent(review)).toBeUndefined();
    expect(parseCharacterIntent("「유키로 교체해」라고 쓰면 교체돼?")).toBeUndefined();
    // 인용 속 이름과 인용 밖 명령어는 결합하지 않는다.
    expect(parseCharacterIntent("'유키로 바꿔' 말고 그냥 교체해")).toBeUndefined();
    expect(parseCharacterIntent("'유키' 말고 린으로 교체해")).toEqual({ kind: "switch", alias: "RIN(린)" });
    // 인용 밖의 직접 명령은 그대로 실행한다.
    expect(parseCharacterIntent("'교체하지 마'는 무시하고 린으로 교체해")).toEqual({ kind: "switch", alias: "RIN(린)" });
  });

  test("explicit multi-character summon carries every named alias in mention order", () => {
    expect(parseCharacterIntent("유키랑 미오 불러와")).toEqual({
      kind: "summon",
      aliases: ["YUKI(유키)", "MIO(미오)"],
    });
    expect(parseCharacterIntent("유키와 미오와 린을 소환해")).toEqual({
      kind: "summon",
      aliases: ["YUKI(유키)", "MIO(미오)", "RIN(린)"],
    });
    expect(parseCharacterIntent("유키 미오 불러와")).toEqual({
      kind: "summon",
      aliases: ["YUKI(유키)", "MIO(미오)"],
    });
    expect(parseCharacterIntent("미오랑 유키 불러와")).toEqual({
      kind: "summon",
      aliases: ["MIO(미오)", "YUKI(유키)"],
    });
    expect(parseCharacterIntent("여섯 명 모두 불러와")).toBeUndefined();
    expect(parseCharacterIntent("다 같이 모여")).toBeUndefined();
  });

  test("multi-summon routing names every intent and each exact marker", () => {
    const routing = renderCharacterSummonRouting(["YUKI(유키)", "MIO(미오)", "SHION(시온)"]);
    expect(routing).toContain('[character-summon-intent alias="YUKI(유키)"]');
    expect(routing).toContain('[character-summon-intent alias="MIO(미오)"]');
    expect(routing).toContain('[character-summon-intent alias="SHION(시온)"]');
    expect(routing).toContain('[character-summon alias="YUKI(유키)" model="openai-codex/gpt-6-astra"]');
    expect(routing).toContain('[character-summon alias="MIO(미오)" model="anthropic/claude-opus-5-5" oauth-position="1"]');
    expect(routing).toContain("web6/gpt-6-pro");
    expect(routing).toContain("WEB6");
    expect(parseCharacterSummonDirectives(routing)).toEqual(["YUKI(유키)", "MIO(미오)", "SHION(시온)"]);
  });

  test("multi-summon rewrite claims marked tasks and rejects unmarked or partial dispatch", () => {
    const yukiMarker = '[character-summon alias="YUKI(유키)" model="openai-codex/gpt-6-astra"]';
    const mioMarker = '[character-summon alias="MIO(미오)" model="anthropic/claude-opus-5-5" oauth-position="1"]';
    const pending = ["YUKI(유키)", "MIO(미오)"] as const;

    const unmarked = rewriteTaskInputForCharacterSummon(
      { tasks: [{ agent: "maker", task: "인사 A" }, { agent: "maker", task: "인사 B" }] },
      pending,
    );
    expect(unmarked.ok).toBe(false);

    const partial = rewriteTaskInputForCharacterSummon(
      { tasks: [{ agent: "maker", task: `${yukiMarker}\n인사` }] },
      pending,
    );
    expect(partial.ok).toBe(false);

    const foreign = rewriteTaskInputForCharacterSummon(
      {
        tasks: [
          { agent: "maker", task: `${yukiMarker}\n인사` },
          { agent: "maker", task: '[character-summon alias="RIN(린)" model="anthropic/claude-opus-5-5" oauth-position="0"]\n인사' },
        ],
      },
      pending,
    );
    expect(foreign.ok).toBe(false);

    const rewritten = rewriteTaskInputForCharacterSummon(
      {
        tasks: [
          { agent: "maker", task: `${mioMarker}\n미오 인사` },
          { agent: "maker", task: `${yukiMarker}\n유키 인사` },
        ],
      },
      pending,
    );
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    expect(rewritten.claimed).toEqual(["MIO(미오)", "YUKI(유키)"]);
    const tasks = rewritten.input.tasks as Array<{ task: string }>;
    expect(tasks[0]?.task).toContain('alias="MIO(미오)"');
    expect(tasks[0]?.task).toContain("미오 인사");
    expect(tasks[1]?.task).toContain('alias="YUKI(유키)"');
    expect(tasks[1]?.task).toContain("유키 인사");
  });

  test("summon routing preserves the user's greeting request without switching Main", async () => {
    const harness = createRuntimeHarness();
    const text = "미오 불러와. 추석 인사를 두 문장으로 해 줘.";
    const result = await harness.emit("input", { type: "input", source: "rpc", text }) as { text: string };
    expect(result.text).toContain(text);
    expect(harness.calls).toEqual([]);
    expect(harness.ctx.model.provider).toBe("openai-codex");
  });

  test("tool-capable summon rewrites one task with exact model and selected voice", () => {
    const oldVoice = renderCharacterVoice("MIO(미오)");
    const rewritten = rewriteTaskInputForCharacterSummon(
      {
        agent: "maker",
        task: `TASK_GUARD:\nWORK_CLASS: diagnostic\nPRIMARY_DELIVERABLE: 결과 설명\nOWNED_PATHS: .\n\n${oldVoice}\n\n원인을 조사한다.`,
      },
      "RIN(린)",
    );
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    const task = rewritten.input.task;
    expect(typeof task).toBe("string");
    expect(task).toContain('alias="RIN(린)" model="anthropic/claude-opus-5-5" oauth-position="0"');
    expect(task).toContain('alias="RIN(린)"');
    expect(task).not.toContain('alias="MIO(미오)"');
    expect(task.match(/<character-voice\b/gu)).toHaveLength(1);
    expect(task).toContain("TASK_GUARD:");
    expect(task).toContain("terminal 발화 자체가 사용자 화면에 표시되는 정본");
    expect(renderCharacterSummonRouting("RIN(린)")).toContain("Main은 그 본문을 다시 인용·요약·재집계하지 않고");
  });

  test("SHION summon names WEB6 consultation and cannot become a task child", () => {
    const routing = renderCharacterSummonRouting("SHION(시온)");
    expect(routing).toContain("web6/gpt-6-pro");
    expect(routing).toContain("WEB6");
    expect(routing).toContain("task child를 만들거나 세션 Main 모델을 바꾸지 않는다");
    expect(routing).toContain("현재 OMP sessionId를 자동 운반");
    expect(routing).toContain("relay 답 수집·/api/gpt6/reply 투영");
    expect(routing).toContain("raw HTTP·clipboard·수동 붙여넣기·탭 이동을 요구하지 않는다");
    expect(routing).toContain("실제 전송 전에 fail closed");
    expect(routing).toContain('<character-voice alias="SHION(시온)">');
    expect(routing).toContain("SHION의 terminal 발화는 이미 사용자 화면에 표시되는 정본");
    expect(routing).toContain("Main은 그 본문을 다시 인용·요약·재집계하지 않고");
    expect(rewriteTaskInputForCharacterSummon({ task: "상담" }, "SHION(시온)").ok).toBe(false);
  });

  test("RIN switch pins OAuth position 0 as an exact identity after changing only the live session model", async () => {
    const harness = createRuntimeHarness();
    const result = await harness.emit("input", {
      type: "input",
      text: "린으로 교체해",
      source: "rpc",
    });
    expect(harness.calls).toEqual(["reload", "set:anthropic/claude-opus-5-5", "pin:11:exact:RIN(린)"]);
    expect(result).toEqual({
      text: "[CharacterSwitchRuntime] 현재 세션만 RIN(린)(anthropic/claude-opus-5-5)로 교체했다. 전역 기본값은 바꾸지 않았다. 사용자에게 선택된 character voice를 살린 자연스러운 한국어로 교체 완료를 짧게 알린다.",
    });

    const systemResult = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "교체 완료를 답한다.",
      systemPrompt: ["base", renderCharacterVoice("MIO(미오)")],
    });
    expect(systemResult).toEqual({
      systemPrompt: ["base", renderCharacterVoice("RIN(린)")],
    });

    const payloadResult = await harness.emit("before_provider_request", {
      type: "before_provider_request",
      payload: {
        model: "claude-opus-5-5",
        system: [{
          type: "text",
          text: `base\n\n<report-style>Problem / Decision / Check / Next를 항상 쓴다.</report-style>\n\n${renderCharacterVoice("MIO(미오)")}`,
        }],
        messages: [],
      },
    });
    const serialized = JSON.stringify(payloadResult);
    expect(serialized.split('alias=\\"RIN(린)\\"')).toHaveLength(2);
    expect(serialized).not.toContain('alias=\\\"MIO(미오)\\\"');
    expect(serialized).not.toContain("<report-style");
    expect(serialized).not.toContain("Problem / Decision / Check / Next를 항상 쓴다");
  });

  test("MIO switch pins OAuth position 1 for a conversational switch command", async () => {
    const harness = createRuntimeHarness();
    await harness.emit("input", {
      type: "input",
      text: "장난치지말고 교체해봐 미오로",
      source: "interactive",
    });
    expect(harness.calls).toEqual(["reload", "set:anthropic/claude-opus-5-5", "pin:13:exact:MIO(미오)"]);
  });

  test("genuine steering switch changes the current Main session before continuation", async () => {
    const harness = createRuntimeHarness();
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "미오 불러와서 교체해 메인을" }],
        steering: true,
      },
    });
    expect(harness.calls).toEqual(["reload", "set:anthropic/claude-opus-5-5", "pin:13:exact:MIO(미오)"]);
    expect(harness.ctx.model).toEqual({ provider: "anthropic", id: "claude-opus-5-5" });
    expect(harness.sent).toEqual([{
      message: {
        customType: "character-switch-runtime",
        content: expect.stringContaining("현재 세션만 MIO(미오)"),
        display: false,
        attribution: "agent",
      },
      options: { deliverAs: "aside" },
    }]);
  });

  test("failed steering switch reports the original reason and never claims completion", async () => {
    const harness = createRuntimeHarness({ unavailableSelector: "anthropic/claude-opus-5-5" });
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "user",
        content: "미오 불러와서 교체해 메인을",
        steering: true,
      },
    });
    expect(harness.calls).toEqual([]);
    const content = String(harness.sent[0]?.message.content);
    expect(content).toContain("런타임 model registry에서 anthropic/claude-opus-5-5을(를) 해석하지 못했습니다");
    expect(content).not.toContain("현재 세션만 MIO(미오)");
  });

  test("steering summon keeps the task-child route instead of switching Main", async () => {
    const harness = createRuntimeHarness();
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "user",
        content: "린 좀 불러와",
        steering: true,
      },
    });
    expect(harness.calls).toEqual([]);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.message.customType).toBe("character-summon-runtime");
    expect(String(harness.sent[0]?.message.content)).toContain('[character-summon-intent alias="RIN(린)"]');
  });

  test("synthetic, agent-attributed, and non-user events never trigger character routing", async () => {
    const harness = createRuntimeHarness();
    const messages = [
      { role: "user", content: "미오로 교체해", steering: true, synthetic: true },
      { role: "user", content: "미오로 교체해", steering: true, attribution: "agent" },
      { role: "custom", customType: "async-result", content: "미오로 교체해", steering: true },
      { role: "system", content: "미오로 교체해", steering: true },
    ];
    for (const message of messages) {
      await harness.emit("message_start", { type: "message_start", message });
    }
    expect(harness.calls).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  test("negation, explanation, and quoted review text never call setModel or pin on input or steering", async () => {
    const texts = [
      "유키로 교체하지 마",
      "유키로 교체하는 방법만 설명해줘",
      "리뷰: '유키로 교체하지 마', '유키로 교체하는 방법만 설명해줘'가 재현됐고 \"린으로 교체해\"는 보존한다.",
      "유키로 교체해 주지 마",
      "유키로 교체해 줘야 하는지 설명해줘",
      "유키로 안 교체해",
      "유키로 절대 교체해 주지 마",
    ];
    for (const text of texts) {
      const harness = createRuntimeHarness();
      expect(await harness.emit("input", { type: "input", source: "interactive", text })).toBeUndefined();
      await harness.emit("message_start", {
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text }], steering: true },
      });
      expect(harness.calls).toEqual([]);
      expect(harness.sent).toEqual([]);
      expect(harness.ctx.model).toEqual({ provider: "openai-codex", id: "gpt-6-astra" });
    }
  });

  test("the same user command seen by input and steering hooks switches exactly once", async () => {
    const harness = createRuntimeHarness();
    const text = "미오 불러와서 교체해 메인을";
    await harness.emit("input", { type: "input", source: "rpc", text });
    await harness.emit("message_start", {
      type: "message_start",
      message: { role: "user", content: text, steering: true },
    });
    expect(harness.calls).toEqual(["reload", "set:anthropic/claude-opus-5-5", "pin:13:exact:MIO(미오)"]);
    expect(harness.sent).toEqual([]);
  });

  // 2026-10-31 집 PC 7.23일 실측: 정규식이 호출로 본 문장이 붙여 넣은 다른 세션 답과 호출 코드 질문이었다.
  const NOT_SUMMONS = [
    "이사나와 히카리는 작업자가 아니라 검증자로 배치할게요. 히카리(제미나이)는 작업자 후보에 없어서 다른 경로로 불러야 하니, 먼저 이 PC에서 역할별로 묶인 모델을 확인해볼게요.",
    "어제 히카리 호출했을 때 왜 실패했어?",
    "이사나 호출 경로 코드 어디 있어?",
  ];
  const SUMMONS = ["히카리 불러서 이 코드 검증시켜", "린 호출해서 이거 같이 봐줘"];

  test("JEV가 캐릭터 이야기나 붙여 넣은 글이라고 하면 input과 steering 모두 호출 지시를 넣지 않는다", async () => {
    for (const text of NOT_SUMMONS) {
      expect(parseCharacterIntent(text)?.kind).toBe("summon");
      const judged: unknown[] = [];
      setCharacterIntentJudgeResolver(fakeIntentJudge(text.length > 40 ? "pasted-transcript" : "about-character", judged));
      const harness = createRuntimeHarness();
      expect(await harness.emit("input", { type: "input", source: "rpc", text })).toBeUndefined();
      await harness.emit("message_start", { type: "message_start", message: { role: "user", content: text, steering: true } });
      expect(harness.sent).toEqual([]);
      // input과 steering이 같은 문장을 받아도 판정은 한 번이다.
      expect(judged).toHaveLength(1);
    }
  });

  test("JEV가 지금 부르는 요청이라고 하거나 판정이 실패·unknown이면 지금처럼 호출 지시를 넣는다", async () => {
    for (const resolver of [fakeIntentJudge("summon-now"), noJudge, fakeIntentJudge("unknown")]) {
      for (const text of SUMMONS) {
        setCharacterIntentJudgeResolver(resolver);
        const harness = createRuntimeHarness();
        const result = await harness.emit("input", { type: "input", source: "rpc", text }) as { text?: string } | undefined;
        expect(result?.text).toContain(renderCharacterSummonRouting((parseCharacterIntent(text) as { aliases: CharacterAlias[] }).aliases));
      }
    }
  });

  test("판정기에는 코드·경로·주소를 가린 앞부분만 보내고 비밀처럼 보이는 문장은 보내지 않는다", async () => {
    const judged: unknown[] = [];
    setCharacterIntentJudgeResolver(fakeIntentJudge("summon-now", judged));
    const harness = createRuntimeHarness();
    await harness.emit("input", { type: "input", source: "rpc", text: `히카리 불러서 \`src/a.ts\` 와 https://example.com/x 봐줘 ${"가".repeat(900)}` });
    const state = judged[0] as { excerpt: string };
    expect(state.excerpt).not.toContain("src/a.ts");
    expect(state.excerpt).not.toContain("example.com");
    expect(state.excerpt.length).toBeLessThanOrEqual(600);
    // cross-review R1-OAI-3: UNC 경로와 따옴표 안 경로도 가린다.
    const uncJudged: unknown[] = [];
    setCharacterIntentJudgeResolver(fakeIntentJudge("summon-now", uncJudged));
    await createRuntimeHarness().emit("input", { type: "input", source: "rpc", text: '히카리 불러서 \\\\server\\share\\report.txt 와 "/repo/alice/Client Acme acquisition.txt", "reports/Beta deal.txt", "/repo/bob/O\'Brien plan.txt", "/repo/bob/Acme \\"Project Cedar\\" plan.txt" 봐줘' });
    const uncExcerpt = (uncJudged[0] as { excerpt: string }).excerpt;
    expect(uncExcerpt).not.toContain("server");
    expect(uncExcerpt).not.toContain("alice");
    expect(uncExcerpt).not.toContain("Acme");
    // cross-review R3-OAI-1: 따옴표 안 상대 경로와 아포스트로피가 든 경로도 끝까지 가린다.
    expect(uncExcerpt).not.toContain("Beta");
    expect(uncExcerpt).not.toContain("Brien");
    // cross-review R4-OAI-1: 따옴표 안의 escape된 같은 따옴표에서 끊지 않는다.
    expect(uncExcerpt).not.toContain("Cedar");
    // 2차 체인(xr-20261030211626-f458f4) R1-OAI-4: ~~~ 펜스와 여러 backtick literal도 가린다.
    const fenceJudged: unknown[] = [];
    setCharacterIntentJudgeResolver(fakeIntentJudge("summon-now", fenceJudged));
    await createRuntimeHarness().emit("input", { type: "input", source: "rpc", text: "히카리 불러서 봐줘\n~~~\nprivate-fence-body\n~~~\n그리고 ``a `b` private-literal`` 와 `private-span\nsecond-line` 와 `alpha `` private-beta` 도" });
    const fenceExcerpt = (fenceJudged[0] as { excerpt: string }).excerpt;
    expect(fenceExcerpt).not.toContain("private-fence-body");
    expect(fenceExcerpt).not.toContain("private-literal");
    // 2차 체인 R2-OAI-3: 빈 줄을 넘지 않는 여러 줄 code span도 가린다.
    expect(fenceExcerpt).not.toContain("private-span");
    expect(fenceExcerpt).not.toContain("second-line");
    // 2차 체인 R3-OAI-1: 더 긴 backtick 덩어리의 일부에서 span을 끝내지 않는다.
    expect(fenceExcerpt).not.toContain("private-beta");

    const secretJudged: unknown[] = [];
    setCharacterIntentJudgeResolver(fakeIntentJudge("about-character", secretJudged));
    const secret = createRuntimeHarness();
    const result = await secret.emit("input", { type: "input", source: "rpc", text: "히카리 불러서 이 token 값 확인해" }) as { text?: string } | undefined;
    expect(secretJudged).toHaveLength(0);
    expect(result?.text).toContain("HIKARI");
  });

  // cross-review R1-OAI-4·R2-OAI-1: choice가 빠지거나 질문에 없는 답은 판정 실패와 같다.
  // 2차 체인 R1-OAI-2: 지우는 label(about-character·pasted-transcript)을 고르고 0.5 이상일 때만 지운다.
  test("choice가 빠지거나 질문에 없거나 확신이 낮은 판정 답이면 파서 결과를 그대로 쓴다", async () => {
    for (const intent of [
      { type: "choice" },
      { type: "choice", choice: "" },
      { type: "choice", choice: "constructor" },
      { type: "choice", choice: "summon-now", probabilities: { "summon-now": 0.4, "about-character": 0.35, "pasted-transcript": 0.25 } },
      { type: "choice", choice: "about-character", probabilities: { "about-character": 0.45, "summon-now": 0.3, "pasted-transcript": 0.25 } },
      // 2차 체인 R2-OAI-2: 확률이 없거나 NaN이면 확신을 지어내지 않는다.
      { type: "choice", choice: "about-character" },
      { type: "choice", choice: "pasted-transcript", probabilities: { "pasted-transcript": Number.NaN } },
    ]) {
      setCharacterIntentJudgeResolver(async () => ({ judge: async () => ({ answers: { intent } }) as never }));
      const result = await createRuntimeHarness().emit("input", { type: "input", source: "rpc", text: SUMMONS[0]! }) as { text?: string } | undefined;
      expect(result?.text).toContain("HIKARI");
    }
  });

  // cross-review R1-OAI-1: 판정을 기다리는 동안 새 steering이 오면 옛 문장의 호출 지시를 보내지 않는다.
  test("판정 중 새 steering이 오면 옛 steering의 호출 지시를 버린다", async () => {
    const gate = Promise.withResolvers<string>();
    setCharacterIntentJudgeResolver(async () => ({
      judge: async () => {
        const choice = await gate.promise;
        return { answers: { intent: { type: "choice", choice, probabilities: { [choice]: 0.9 } } } } as never;
      },
    }));
    const harness = createRuntimeHarness();
    const old = harness.emit("message_start", { type: "message_start", message: { role: "user", content: SUMMONS[0], steering: true } });
    await harness.emit("message_start", { type: "message_start", message: { role: "user", content: "아니 부르지 말고 그냥 계속해", steering: true } });
    gate.resolve("summon-now");
    await old;
    expect(harness.sent).toEqual([]);
  });

  test("unresolved switch stays on the previous session model and reports the failure", async () => {
    const harness = createRuntimeHarness({ unavailableSelector: "anthropic/claude-opus-5-5" });
    const result = await harness.emit("input", {
      type: "input",
      text: "린으로 교체해",
      source: "rpc",
    });
    expect(harness.calls).toEqual([]);
    expect(result).toEqual({
      text: "[CharacterSwitchRuntime] 교체를 실행하지 못했다. 도구를 호출하지 말고 사용자에게 다음 이유를 그대로 한국어로 알린다: 런타임 model registry에서 anthropic/claude-opus-5-5을(를) 해석하지 못했습니다.",
    });
    expect(harness.ctx.model).toEqual({ provider: "openai-codex", id: "gpt-6-astra" });
  });

  test("pin이 거부되면 다른 계정·모델로 조용히 대체하지 않고 실패를 알린다", async () => {
    const harness = createRuntimeHarness({ pinRefused: true });
    const result = await harness.emit("input", { type: "input", text: "린으로 교체해", source: "rpc" });
    expect(harness.calls).toEqual(["reload", "set:anthropic/claude-opus-5-5", "set:openai-codex/gpt-6-astra"]);
    expect(result).toEqual({
      text: "[CharacterSwitchRuntime] 교체를 실행하지 못했다. 도구를 호출하지 말고 사용자에게 다음 이유를 그대로 한국어로 알린다: RIN(린) 교체 실패: Anthropic OAuth 저장 위치 0 계정을 현재 세션에 pin하지 못했습니다. 현재 세션 모델은 전환 전 상태로 유지했습니다.",
    });
    expect(harness.ctx.model).toEqual({ provider: "openai-codex", id: "gpt-6-astra" });
    expect(harness.accounts.find((account) => account.active)?.credentialId).toBe(13);
  });

  test("모델 교체가 거부되면 계정 pin을 건드리지 않고 이전 모델을 유지한다", async () => {
    const harness = createRuntimeHarness({ refusedModelSelector: "anthropic/claude-opus-5-5" });
    const result = await harness.emit("input", { type: "input", text: "린으로 교체해", source: "rpc" }) as { text: string };
    expect(harness.calls).toEqual(["reload", "set-refused:anthropic/claude-opus-5-5"]);
    expect(result.text).toContain("RIN(린) 교체 실패");
    expect(result.text).toContain("현재 세션 모델은 전환 전 상태로 유지했습니다.");
    expect(harness.ctx.model).toEqual({ provider: "openai-codex", id: "gpt-6-astra" });
    expect(harness.accounts.find((account) => account.active)?.credentialId).toBe(13);
  });


  test("final payload replacement preserves ordinary text and removes stale voice/report blocks", () => {
    const payload = {
      model: "claude-opus-5-5",
      system: [
        {
          type: "text",
          text: `base contract\n\n<report-style>Problem / Decision / Check / Next를 항상 쓴다.</report-style>\n\n${renderCharacterVoice("MIO(미오)")}\n\ntail contract`,
        },
      ],
      messages: [],
    };
    const replaced = injectCharacterVoice(payload, "RIN(린)") as typeof payload;
    const serialized = JSON.stringify(replaced);
    expect(replaced.system).toHaveLength(2);
    expect(replaced.system[0]?.text).toContain("base contract");
    expect(replaced.system[0]?.text).toContain("tail contract");
    expect(replaced.system[1]?.text).toBe(renderCharacterVoice("RIN(린)"));
    expect(serialized.split('alias=\\"RIN(린)\\"')).toHaveLength(2);
    expect(serialized).not.toContain("MIO(미오)");
    expect(serialized).not.toContain("<report-style");
    expect(serialized).not.toContain("Problem / Decision / Check / Next를 항상 쓴다");
  });

  test.each([true, false])("Cloud Code Assist keeps voice inside systemInstruction (existing=%s)", (existing) => {
    const payload = {
      project: "fixture-project",
      model: "gemini-test",
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: { maxOutputTokens: 100 },
        ...(existing ? { systemInstruction: { role: "user", parts: [
          { text: `base contract\n${renderCharacterVoice("YUKI(유키)")}` },
        ] } } : {}),
      },
    };
    const before = JSON.stringify(payload);
    const once = injectCharacterVoice(payload, "HIKARI(히카리)") as typeof payload;
    const twice = injectCharacterVoice(once, "HIKARI(히카리)") as typeof payload;
    expect(twice).not.toHaveProperty("system");
    expect(twice.request.contents).toEqual(payload.request.contents);
    expect(twice.request.generationConfig).toEqual(payload.request.generationConfig);
    expect(twice.request.systemInstruction).toEqual({
      ...(existing ? { role: "user" } : {}),
      parts: [...(existing ? [{ text: "base contract" }] : []), { text: renderCharacterVoice("HIKARI(히카리)") }],
    });
    expect(JSON.stringify(payload)).toBe(before);
  });

  // core는 system 맨 끝의 `<memories>`만 변동 구간으로 보고 그 앞에 cache breakpoint를 건다.
  // voice가 recall 뒤에 오거나 옛 voice 블록의 cache_control이 사라지면 첫 요청마다 system 전체가 재기록된다.
  test("voice stays ahead of trailing recall and keeps the system cache breakpoint", async () => {
    const memories = "<memories>\nrecalled facts\n</memories>";
    const harness = createRuntimeHarness();
    const started = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "안녕",
      systemPrompt: ["base contract", memories],
    }) as { systemPrompt: string[] };
    expect(started.systemPrompt).toEqual(["base contract", renderCharacterVoice("YUKI(유키)"), memories]);

    const payload = {
      system: [
        { type: "text", text: "base contract" },
        { type: "text", text: renderCharacterVoice("MIO(미오)"), cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: memories },
      ],
      messages: [],
    };
    const replaced = injectCharacterVoice(payload, "RIN(린)") as typeof payload;
    expect(replaced.system).toEqual([
      { type: "text", text: "base contract" },
      { type: "text", text: renderCharacterVoice("RIN(린)"), cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: memories },
    ]);
  });

  test("a system array without a voice block gets the voice before the trailing recall", () => {
    const memories = "<memories>\nrecalled facts\n</memories>";
    const replaced = injectCharacterVoice(
      { system: [{ type: "text", text: "base contract" }, { type: "text", text: memories }], messages: [] },
      "RIN(린)",
    ) as { system: Array<{ text: string }> };
    expect(replaced.system.map((part) => part.text)).toEqual(["base contract", renderCharacterVoice("RIN(린)"), memories]);
  });

  test("Main OpenAI payload receives the same final selected-character boundary", async () => {
    const harness = createRuntimeHarness();
    const result = await harness.emit("before_provider_request", {
      type: "before_provider_request",
      payload: {
        instructions: `<report-style>Problem / Decision / Check / Next를 항상 쓴다.</report-style>\n\n${renderCharacterVoice("MIO(미오)")}`,
        messages: [],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized.split('alias=\\"YUKI(유키)\\"')).toHaveLength(2);
    expect(serialized).not.toContain("MIO(미오)");
    expect(serialized).not.toContain("<report-style");
    expect(serialized).not.toContain("Problem / Decision / Check / Next를 항상 쓴다");
  });

  // Codex Responses 본문은 system 블록 0을 `instructions`로, 나머지를 input 앞의 developer 메시지로 싣는다.
  // before_agent_start가 넣은 voice가 developer 메시지에 남은 채 instructions 끝에도 붙어 voice가 두 번 나갔다.
  interface CodexPayloadFixture {
    model: string;
    instructions: string;
    input: unknown[];
    store: boolean;
    stream: boolean;
    prompt_cache_key: string;
  }
  const voiceCount = (value: unknown): number => JSON.stringify(value).split("<character-voice").length - 1;
  const itemRole = (item: unknown): string | undefined =>
    item && typeof item === "object" && "role" in item && typeof item.role === "string" ? item.role : undefined;
  const developerItems = (payload: CodexPayloadFixture): unknown[] => payload.input.filter((item) => itemRole(item) === "developer");
  const otherItems = (payload: CodexPayloadFixture): unknown[] => payload.input.filter((item) => itemRole(item) !== "developer");
  const developerItem = (text: string) => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
  const codexPayload = (turns: number, alias: CharacterAlias = "YUKI(유키)"): CodexPayloadFixture => {
    const quoted = `사용자가 붙여 넣은 예시: ${renderCharacterVoice("MIO(미오)")}`;
    const input: unknown[] = [
      developerItem("<project-context>\ncwd=/w\n</project-context>"),
      developerItem(renderCharacterVoice(alias)),
      developerItem("<memories>\nrecalled facts\n</memories>"),
      { role: "user", content: [{ type: "input_text", text: quoted }] },
    ];
    for (let turn = 0; turn < turns; turn += 1) {
      input.push({ type: "reasoning", id: `rs_${turn}`, encrypted_content: `enc${turn}`, summary: [] });
      input.push({ type: "function_call", call_id: `call_${turn}`, name: "read", arguments: "{}" });
      input.push({ type: "function_call_output", call_id: `call_${turn}`, output: quoted });
    }
    return { model: "gpt-6-astra", instructions: "base contract", input, store: false, stream: true, prompt_cache_key: "session-1" };
  };
  const toCodexPayload = (value: unknown): CodexPayloadFixture => {
    if (!value || typeof value !== "object" || !("instructions" in value) || !("input" in value) || !Array.isArray(value.input)) {
      throw new Error("Codex payload shape was lost");
    }
    // 위에서 두 키를 모두 확인했고 fixture가 만든 이 형태만 들어온다.
    return value as CodexPayloadFixture;
  };

  test("Codex payload keeps exactly one current voice and leaves user/tool items untouched", async () => {
    const harness = createRuntimeHarness();
    const payload = codexPayload(2);
    const before = JSON.stringify(payload);
    const result = toCodexPayload(await harness.emit("before_provider_request", { type: "before_provider_request", payload }));
    expect(JSON.stringify(payload)).toBe(before);
    expect(result.instructions).toBe(`base contract\n\n${renderCharacterVoice("YUKI(유키)")}`);
    expect(developerItems(result)).toEqual([
      developerItem("<project-context>\ncwd=/w\n</project-context>"),
      developerItem("<memories>\nrecalled facts\n</memories>"),
    ]);
    // 사용자가 인용한 voice 마커와 도구 출력은 그대로 남는다(보호 대상은 system/developer 항목뿐).
    expect(otherItems(result)).toEqual(otherItems(payload));
    expect(voiceCount(result.instructions)).toBe(1);
    expect(voiceCount(developerItems(result))).toBe(0);
    expect(result.prompt_cache_key).toBe("session-1");
  });

  test("Codex payload voice injection is idempotent and append-only across turns", async () => {
    const harness = createRuntimeHarness();
    const emit = async (payload: unknown) =>
      toCodexPayload(await harness.emit("before_provider_request", { type: "before_provider_request", payload }));
    const turnN = await emit(codexPayload(2));
    const turnN1 = await emit(codexPayload(3));
    expect(turnN1.instructions).toBe(turnN.instructions);
    expect(turnN1.input.slice(0, turnN.input.length)).toEqual(turnN.input);
    expect(await emit(turnN)).toEqual(turnN);
  });

  test("a stale voice from another character is replaced in Codex instructions and developer items", async () => {
    const harness = createRuntimeHarness();
    const payload = { ...codexPayload(1, "MIO(미오)"), instructions: `base contract\n\n${renderCharacterVoice("RIN(린)")}` };
    const result = toCodexPayload(await harness.emit("before_provider_request", { type: "before_provider_request", payload }));
    const serialized = JSON.stringify(developerItems(result)) + JSON.stringify(result.instructions);
    expect(serialized.split('alias=\\"YUKI(유키)\\"')).toHaveLength(2);
    expect(serialized).not.toContain("MIO(미오)");
    expect(serialized).not.toContain("RIN(린)");
  });

  // 세션 전환 뒤에도 이전 선택이 새 컨텍스트로 새지 않는다: 선택 alias는 현재 model/계정과 맞을 때만 쓰이고,
  // 그때 값은 provider별 기본 alias와 같다. 그래서 session_switch에서 지우지 않는다.
  test("an earlier selection never leaks across new/resume/fork or a model/account change", async () => {
    const harness = createRuntimeHarness();
    const voiceOf = async (): Promise<string | undefined> => {
      const started = await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "안녕", systemPrompt: ["base"] });
      if (!started || typeof started !== "object" || !("systemPrompt" in started) || !Array.isArray(started.systemPrompt)) return undefined;
      const block = started.systemPrompt.find((part) => typeof part === "string" && part.startsWith("<character-voice"));
      return typeof block === "string" ? block.match(/alias="([^"]+)"/u)?.[1] : undefined;
    };
    await harness.emit("input", { type: "input", text: "린으로 교체해", source: "rpc" });
    expect(await voiceOf()).toBe("RIN(린)");
    // 같은 세션 reload는 선택과 계정 pin을 그대로 유지한다.
    await harness.emit("session_switch", { type: "session_switch", reason: "resume", previousSessionFile: "same.jsonl" });
    expect(await voiceOf()).toBe("RIN(린)");
    // 새 세션은 pin을 잃고 계정 랭킹이 다른 계정을 고를 수 있다: 보이는 voice는 그 계정의 것이다.
    for (const reason of ["new", "fork", "resume"] as const) {
      await harness.emit("session_switch", { type: "session_switch", reason, previousSessionFile: "old.jsonl" });
      for (const account of harness.accounts) account.active = account.position === 1;
      expect(await voiceOf()).toBe("MIO(미오)");
      for (const account of harness.accounts) account.active = account.position === 0;
      expect(await voiceOf()).toBe("RIN(린)");
    }
    // model이 바뀌면 이전 선택은 쓰이지 않는다.
    await harness.emit("input", { type: "input", text: "이사나로 교체해", source: "rpc" });
    expect(await voiceOf()).toBe("ISANA(이사나)");
    harness.selectModel("openai-codex/gpt-6-astra");
    await harness.emit("session_switch", { type: "session_switch", reason: "new", previousSessionFile: "old.jsonl" });
    expect(await voiceOf()).toBe("YUKI(유키)");
  });

  test("Hive models split by model: MITSU on glm-5.3-flash, ISANA on the DeepSeek model", async () => {
    const harness = createRuntimeHarness();
    const voiceOf = async (): Promise<string | undefined> => {
      const started = await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "안녕", systemPrompt: ["base"] });
      if (!started || typeof started !== "object" || !("systemPrompt" in started) || !Array.isArray(started.systemPrompt)) return undefined;
      const block = started.systemPrompt.find((part) => typeof part === "string" && part.startsWith("<character-voice"));
      return typeof block === "string" ? block.match(/alias="([^"]+)"/u)?.[1] : undefined;
    };
    await harness.emit("input", { type: "input", text: "미츠로 교체해", source: "rpc" });
    expect(harness.ctx.model).toEqual({ provider: "hive", id: "zai-org/glm-5.3-flash" });
    expect(await voiceOf()).toBe("MITSU(미츠)");
    // 선택 기록이 없는 새 세션에서도 모델만으로 같은 캐릭터가 나온다.
    await harness.emit("input", { type: "input", text: "이사나로 교체해", source: "rpc" });
    expect(harness.ctx.model).toEqual({ provider: "hive", id: "deepseek-ai/deepseek-v4.1-flash-1017" });
    expect(await voiceOf()).toBe("ISANA(이사나)");
    harness.selectModel("hive/zai-org/glm-5.3-flash");
    await harness.emit("session_switch", { type: "session_switch", reason: "new", previousSessionFile: "old.jsonl" });
    expect(await voiceOf()).toBe("MITSU(미츠)");
    harness.selectModel("hive/deepseek-ai/deepseek-v4.1-flash-1017");
    await harness.emit("session_switch", { type: "session_switch", reason: "new", previousSessionFile: "old.jsonl" });
    expect(await voiceOf()).toBe("ISANA(이사나)");
  });

  test("summoned task child receives the same final payload enforcement", async () => {
    const harness = createRuntimeHarness();
    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: buildCharacterSummonBrief("원인을 조사한다.", "RIN(린)"),
      systemPrompt: [
        "base",
        "<report-style>Problem / Decision / Check / Next를 항상 쓴다.</report-style>",
        renderCharacterVoice("MIO(미오)"),
      ],
    });
    expect(harness.calls).toEqual([
      "reload",
      "set:anthropic/claude-opus-5-5",
      "pin:11:exact:RIN(린)",
    ]);
    const result = await harness.emit("before_provider_request", {
      type: "before_provider_request",
      payload: {
        system: [{ type: "text", text: renderCharacterVoice("MIO(미오)") }],
        messages: [],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized.split('alias=\\"RIN(린)\\"')).toHaveLength(2);
    expect(serialized).not.toContain("MIO(미오)");
    expect(serialized).not.toContain("<report-style");
  });

  test("ISANA summon recovers its discovery model without a helper role assignment", async () => {
    const harness = createRuntimeHarness({ recoverableSelector: "hive/deepseek-ai/deepseek-v4.1-flash-1017" });
    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: buildCharacterSummonBrief("인사한다.", "ISANA(이사나)"),
      systemPrompt: ["base"],
    });
    expect(harness.ctx.model).toEqual({ provider: "hive", id: "deepseek-ai/deepseek-v4.1-flash-1017" });
    expect(harness.calls.filter((call) => call.startsWith("discover:"))).toEqual(["discover:hive"]);
    const result = await harness.emit("before_provider_request", {
      type: "before_provider_request",
      payload: { messages: [], instructions: "base" },
    });
    expect(JSON.stringify(result)).toContain("ISANA(이사나)");
    expect(JSON.stringify(result)).not.toContain("MITSU(미츠)");
  });

  test("failed ISANA discovery preserves the previous model and does not switch providers", async () => {
    const harness = createRuntimeHarness({
      recoverableSelector: "hive/deepseek-ai/deepseek-v4.1-flash-1017",
      discoveryError: "discovery unavailable",
    });
    const result = await harness.emit("input", {
      type: "input",
      text: "이사나로 교체해",
      source: "rpc",
    });
    expect(harness.ctx.model).toEqual({ provider: "openai-codex", id: "gpt-6-astra" });
    expect(harness.calls).toEqual(["discover:hive"]);
    expect(JSON.stringify(result)).toContain("discovery unavailable");
  });

  test("MIO summon pins OAuth position 1 as the only exact identity", async () => {
    const harness = createRuntimeHarness();
    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: buildCharacterSummonBrief("인사한다.", "MIO(미오)"),
      systemPrompt: ["base"],
    });
    expect(harness.calls).toEqual([
      "reload",
      "set:anthropic/claude-opus-5-5",
      "pin:13:exact:MIO(미오)",
    ]);
  });
});

// 사무실 모드: 모드 파일 + roster를 임시 agentDir에서 읽는다. 이름은 가상이며 실존 인물과 무관하다.
const OFFICE_ALIAS = "TESTA(테스타)";
const OFFICE_ROSTER = {
  seats: {
    "YUKI(유키)": {
      id: "testa",
      face: "testa.png",
      alias: OFFICE_ALIAS,
      names: ["testa", "테스타"],
      voice: { temperament: "FIXTURE-TEMPERAMENT 느긋하고 정리 잘하는 선배형", expression: "FIXTURE-EXPRESSION 낮은 목소리의 반말" },
    },
  },
};

async function withOfficeProfile<T>(
  profile: { mode?: unknown; roster?: unknown; rosterRaw?: string; noFace?: boolean },
  run: (dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "office-mode-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    if (profile.mode !== undefined) writeFileSync(join(dir, "cuelo-character-mode.json"), JSON.stringify({ mode: profile.mode }));
    if (profile.roster !== undefined || profile.rosterRaw !== undefined) {
      mkdirSync(join(dir, "characters-office"));
      writeFileSync(join(dir, "characters-office", "roster.json"), profile.rosterRaw ?? JSON.stringify(profile.roster));
      if (!profile.noFace) writeFileSync(join(dir, "characters-office", "testa.png"), "png");
    }
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("office mode character seat", () => {
  test("unselected Anthropic uses RIN or its office alias without pinning an account", async () => {
    for (const office of [false, true]) {
      const alias = office ? "POTETO(포테이토)" : "RIN(린)";
      const roster = { seats: { "RIN(린)": {
        ...OFFICE_ROSTER.seats["YUKI(유키)"], alias, names: ["poteto", "포테이토"],
      } } };
      await withOfficeProfile({ mode: office ? "office" : "default", roster }, async () => {
        const harness = createRuntimeHarness();
        harness.selectModel("anthropic/claude-opus-5-5");
        for (const account of harness.accounts) account.active = false;
        const result = await harness.emit("before_provider_request", {
          type: "before_provider_request", payload: { system: "base", messages: [] },
        });
        expect(JSON.stringify(result)).toContain(`alias=\\"${alias}\\"`);
        expect(harness.accounts.some(account => account.active)).toBe(false);
        expect(harness.calls).toEqual([]);
        harness.accounts[1]!.active = true;
        const selected = await harness.emit("before_provider_request", {
          type: "before_provider_request", payload: { system: "base", messages: [] },
        });
        expect(JSON.stringify(selected)).toContain('alias=\\"MIO(미오)\\"');
      });
    }
  });
  test("openai-codex seat renders the roster voice in the provider request", async () => {
    await withOfficeProfile({ mode: "office", roster: OFFICE_ROSTER }, async () => {
      expect(characterForProvider("openai-codex")).toBe(OFFICE_ALIAS);
      const block = renderCharacterVoice(OFFICE_ALIAS);
      expect(block).toContain(`<character-voice alias="${OFFICE_ALIAS}">`);
      expect(block).toContain("FIXTURE-TEMPERAMENT");
      expect(block).toContain("FIXTURE-EXPRESSION");
      expect(block).not.toContain("YUKI");
      const harness = createRuntimeHarness();
      const result = JSON.stringify(
        await harness.emit("before_provider_request", {
          type: "before_provider_request",
          payload: { messages: [], instructions: "base" },
        }),
      );
      expect(result).toContain(OFFICE_ALIAS);
      expect(result).not.toContain("YUKI");
      // 다른 6자리는 사무실 모드에서도 기본이다.
      expect(characterForProvider("hive")).toBe("ISANA(이사나)");
      expect(characterForProvider("google-vertex", [], "gemini-4-argon")).toBe("HIKARI(히카리)");
    });
  });

  test("summon by the roster name emits a marker with the roster alias and the seat model", async () => {
    await withOfficeProfile({ mode: "office", roster: OFFICE_ROSTER }, () => {
      const intent = parseCharacterIntent("테스타 불러와");
      expect(intent).toEqual({ kind: "summon", aliases: [OFFICE_ALIAS] });
      expect(parseCharacterIntent("testa 호출해")).toEqual({ kind: "summon", aliases: [OFFICE_ALIAS] });
      const marker = `[character-summon alias="${OFFICE_ALIAS}" model="openai-codex/gpt-6-astra"]`;
      const routing = renderCharacterSummonRouting([OFFICE_ALIAS]);
      expect(routing).toContain(`[character-summon-intent alias="${OFFICE_ALIAS}"]`);
      expect(routing).toContain("FIXTURE-TEMPERAMENT");
      expect(renderCharacterSummonRouting([OFFICE_ALIAS, "ISANA(이사나)"])).toContain(marker);
      expect(buildCharacterSummonBrief("인사한다.", OFFICE_ALIAS).startsWith(marker)).toBe(true);
      expect(parseCharacterSummonDirectives(routing)).toEqual([OFFICE_ALIAS]);
      const rewritten = rewriteTaskInputForCharacterSummon({ agent: "maker", task: `${marker}\n인사한다.` }, [OFFICE_ALIAS]);
      expect(rewritten.ok).toBe(true);
      expect(JSON.stringify(rewritten)).toContain("FIXTURE-TEMPERAMENT");
    });
  });

  test("switch by the roster name sets the seat model and the roster voice", async () => {
    await withOfficeProfile({ mode: "office", roster: OFFICE_ROSTER }, async () => {
      expect(parseCharacterIntent("테스타로 교체해")).toEqual({ kind: "switch", alias: OFFICE_ALIAS });
      const harness = createRuntimeHarness();
      harness.selectModel("anthropic/claude-opus-5-5");
      const result = await harness.emit("input", { type: "input", text: "테스타로 교체해", source: "rpc" });
      expect(harness.calls).toContain("set:openai-codex/gpt-6-astra");
      expect(JSON.stringify(result)).toContain(OFFICE_ALIAS);
      const wire = await harness.emit("before_provider_request", {
        type: "before_provider_request",
        payload: { messages: [], instructions: "base" },
      });
      expect(JSON.stringify(wire)).toContain(`alias=\\"${OFFICE_ALIAS}\\"`);
    });
  });

  test("the seat's default name still resolves to the roster seat", async () => {
    await withOfficeProfile({ mode: "office", roster: OFFICE_ROSTER }, () => {
      expect(parseCharacterIntent("유키 불러와")).toEqual({ kind: "summon", aliases: [OFFICE_ALIAS] });
      expect(parseCharacterIntent("yuki로 교체해")).toEqual({ kind: "switch", alias: OFFICE_ALIAS });
      expect(parseCharacterSummonDirectives('[character-summon-intent alias="YUKI(유키)"]')).toEqual([OFFICE_ALIAS]);
    });
  });

  test("an entry whose names take another seat's default name is invalid and the seat stays default", async () => {
    const hijack = { seats: { "YUKI(유키)": { ...OFFICE_ROSTER.seats["YUKI(유키)"], names: ["미오", "테스타"] } } };
    await withOfficeProfile({ mode: "office", roster: hijack }, () => {
      expect(characterForProvider("openai-codex")).toBe("YUKI(유키)");
      expect(parseCharacterIntent("미오 불러와")).toEqual({ kind: "summon", aliases: ["MIO(미오)"] });
      expect(parseCharacterIntent("테스타 불러와")).toBeUndefined();
    });
    const ownName = { seats: { "YUKI(유키)": { ...OFFICE_ROSTER.seats["YUKI(유키)"], names: ["유키", "테스타"] } } };
    await withOfficeProfile({ mode: "office", roster: ownName }, () => {
      expect(parseCharacterIntent("테스타 불러와")).toEqual({ kind: "summon", aliases: [OFFICE_ALIAS] });
    });
  });

  const officeSeat = (id: string, alias: string, names: string[]) => ({
    id,
    face: `${id}.png`,
    alias,
    names,
    voice: { temperament: `FIXTURE-${id} 성향`, expression: `FIXTURE-${id} 말투` },
  });
  const writeFaces = (dir: string, ids: string[]) => {
    for (const id of ids) writeFileSync(join(dir, "characters-office", `${id}.png`), "png");
  };
  const MULTI_ROSTER = {
    seats: {
      "HIKARI(히카리)": officeSeat("delta", "DELTA(델타)", ["delta", "델타"]),
      "SHION(시온)": officeSeat("cedar", "CEDAR(시더)", ["cedar", "시더"]),
      "RIN(린)": officeSeat("birch", "BIRCH(버치)", ["birch", "버치"]),
      "MIO(미오)": officeSeat("alder", "ALDER(앨더)", ["alder", "앨더"]),
      "ISANA(이사나)": officeSeat("elm", "ELM(엘름)", ["elm", "엘름"]),
      "YUKI(유키)": officeSeat("testa", OFFICE_ALIAS, ["testa", "테스타"]),
      "MITSU(미츠)": officeSeat("tiber", "TIBER(티버)", ["tiber", "티버"]),
    },
  };

  test("six seats change independently, MITSU stays default, and every seat keeps its own model, account and consult limits", async () => {
    await withOfficeProfile({ mode: "office", roster: MULTI_ROSTER }, (dir) => {
      writeFaces(dir, ["delta", "cedar", "birch", "alder", "elm", "tiber"]);
      expect(characterForProvider("openai-codex")).toBe(OFFICE_ALIAS);
      expect(characterForProvider("hive")).toBe("ELM(엘름)");
      expect(characterForProvider("web6")).toBe("CEDAR(시더)");
      expect(characterForProvider("google-vertex", [], "gemini-4-argon")).toBe("DELTA(델타)");
      expect(characterForProvider("localproxy", [], "gemini-4-argon")).toBe("DELTA(델타)");
      expect(withActiveSettings(Settings.isolated({ modelRoles: { implGemini: "localproxy/gemini-4-argon:auto" } }), () => characterTarget("DELTA(델타)")?.model)).toBe("localproxy/gemini-4-argon");
      expect(characterForProvider("hive", [], "zai-org/glm-5.3-flash")).toBe("MITSU(미츠)");
      expect(anthropicCharacterForAccounts([{ active: true, position: 0 }])).toBe("BIRCH(버치)");
      expect(anthropicCharacterForAccounts([{ active: true, position: 1 }])).toBe("ALDER(앨더)");
      expect(characterTarget("CEDAR(시더)")).toEqual(CHARACTER_TARGETS["SHION(시온)"]);
      expect(characterTarget("CEDAR(시더)")?.toolCapable).toBe(false);
      expect(characterTarget("BIRCH(버치)")).toEqual(CHARACTER_TARGETS["RIN(린)"]);
      expect(characterTarget("ALDER(앨더)")).toEqual(CHARACTER_TARGETS["MIO(미오)"]);
      expect(characterTarget("TIBER(티버)")).toBeUndefined();
      for (const [alias, id] of [["ELM(엘름)", "elm"], ["DELTA(델타)", "delta"], ["BIRCH(버치)", "birch"]]) {
        expect(renderCharacterVoice(alias)).toContain(`FIXTURE-${id} 성향`);
      }
      expect(renderCharacterVoice("MITSU(미츠)")).toContain(CHARACTER_VOICES["MITSU(미츠)"].temperament);
      expect(parseCharacterIntent("앨더랑 버치 불러와")).toEqual({ kind: "summon", aliases: ["ALDER(앨더)", "BIRCH(버치)"] });
      expect(parseCharacterIntent("시더로 교체해")).toEqual({ kind: "switch", alias: "CEDAR(시더)" });
      expect(parseCharacterIntent("미오 불러와")).toEqual({ kind: "summon", aliases: ["ALDER(앨더)"] });
      expect(parseCharacterIntent("mitsu 불러와")).toEqual({ kind: "summon", aliases: ["MITSU(미츠)"] });
      expect(parseCharacterIntent("티버 불러와")).toBeUndefined();
      expect(buildCharacterSummonBrief("인사한다.", "ALDER(앨더)").startsWith(
        '[character-summon alias="ALDER(앨더)" model="anthropic/claude-opus-5-5" oauth-position="1"]',
      )).toBe(true);
    });
  });

  test("a later seat colliding with an earlier one stays default, in fixed seat order and not roster key order", async () => {
    const base = {
      "MIO(미오)": officeSeat("alder", "ALDER(앨더)", ["alder", "앨더"]),
      "RIN(린)": officeSeat("birch", "BIRCH(버치)", ["birch", "버치"]),
    };
    const collisions: Array<[string, Record<string, unknown>]> = [
      ["alias", { "RIN(린)": officeSeat("birch", "alder(앨더)", ["birch"]) }],
      ["name", { "RIN(린)": officeSeat("birch", "BIRCH(버치)", ["birch", "앨더"]) }],
      ["alias against name", { "RIN(린)": officeSeat("birch", "ALDER", ["birch"]) }],
      ["id", { "RIN(린)": officeSeat("alder", "BIRCH(버치)", ["birch"]) }],
    ];
    for (const [label, override] of collisions) {
      await withOfficeProfile({ mode: "office", roster: { seats: { ...base, ...override } } }, (dir) => {
        writeFaces(dir, ["alder", "birch"]);
        expect(anthropicCharacterForAccounts([{ active: true, position: 1 }]), label).toBe("ALDER(앨더)");
        expect(anthropicCharacterForAccounts([{ active: true, position: 0 }]), label).toBe("RIN(린)");
      });
    }
    // The roster lists SHION before RIN, but RIN comes first in seat order, so RIN keeps the shared name.
    const reversed = {
      seats: {
        "SHION(시온)": officeSeat("cedar", "CEDAR(시더)", ["cedar", "birch"]),
        "RIN(린)": officeSeat("birch", "BIRCH(버치)", ["birch"]),
      },
    };
    await withOfficeProfile({ mode: "office", roster: reversed }, (dir) => {
      writeFaces(dir, ["cedar", "birch"]);
      expect(characterForProvider("web6")).toBe("SHION(시온)");
      expect(anthropicCharacterForAccounts([{ active: true, position: 0 }])).toBe("BIRCH(버치)");
      expect(parseCharacterIntent("birch 불러와")).toEqual({ kind: "summon", aliases: ["BIRCH(버치)"] });
    });
  });

  test("an entry breaking any part of the validity rule keeps the seat default without throwing", async () => {
    const entry = OFFICE_ROSTER.seats["YUKI(유키)"];
    const withSeat = (patch: Record<string, unknown>) => ({ seats: { "YUKI(유키)": { ...entry, ...patch } } });
    const withoutKey = (key: string) => {
      const { [key]: _omitted, ...rest } = entry as Record<string, unknown>;
      return { seats: { "YUKI(유키)": rest } };
    };
    const profiles: Array<{ mode?: unknown; roster?: unknown; rosterRaw?: string; noFace?: boolean }> = [
      { mode: "office" },
      { mode: "office", rosterRaw: "{not json" },
      { mode: "office", roster: { seats: {} } },
      { mode: "office", roster: { seats: { "NOBODY(없음)": entry } } },
      { mode: "office", roster: { seats: { "MITSU(미츠)": entry } } },
      { mode: "broken", roster: OFFICE_ROSTER },
      { mode: "office", roster: withoutKey("id") },
      { mode: "office", roster: withSeat({ id: "Bad_Id" }) },
      { mode: "office", roster: withoutKey("names") },
      { mode: "office", roster: withSeat({ names: [] }) },
      { mode: "office", roster: withSeat({ names: ["테스타", " "] }) },
      { mode: "office", roster: withSeat({ names: ["테스타", "MIO(미오)"] }) },
      { mode: "office", roster: withSeat({ alias: "RIN(린)" }) },
      { mode: "office", roster: withSeat({ alias: 'BAD"(테스타)' }) },
      { mode: "office", roster: withSeat({ alias: "TES'TA(테스타)" }) },
      { mode: "office", roster: withSeat({ alias: "TES`TA(테스타)" }) },
      { mode: "office", roster: withSeat({ alias: "TES\u2019TA(테스타)" }) },
      { mode: "office", roster: withSeat({ alias: `${"A".repeat(65)}` }) },
      { mode: "office", roster: withSeat({ id: " Bad Id " }) },
      { mode: "office", roster: withoutKey("face") },
      { mode: "office", roster: withSeat({ face: "../outside.png" }) },
      { mode: "office", roster: withSeat({ face: "/etc/passwd" }) },
      { mode: "office", roster: withSeat({ face: "missing.png" }) },
      { mode: "office", roster: OFFICE_ROSTER, noFace: true },
      { mode: "office", roster: withSeat({ voice: { temperament: "x", expression: "" } }) },
    ];
    for (const profile of profiles) {
      await withOfficeProfile(profile, () => {
        expect(characterForProvider("openai-codex")).toBe("YUKI(유키)");
        expect(parseCharacterIntent("테스타 불러와")).toBeUndefined();
        expect(parseCharacterIntent("유키 불러와")).toEqual({ kind: "summon", aliases: ["YUKI(유키)"] });
      });
    }
  });

  test("a face that resolves outside characters-office through a symlink is rejected, and a later deleted face invalidates the entry", async () => {
    await withOfficeProfile({ mode: "office", roster: OFFICE_ROSTER, noFace: true }, (dir) => {
      const outside = join(dir, "outside.png");
      // Windows는 파일 시각이 시스템 tick 단위라, 같은 크기의 새 파일이 링크 대상과 같은 mtime을 받을 수 있다. 두 파일을 같은 시각에 고정한다.
      const tick = new Date("2026-01-01T00:00:00.000Z");
      writeFileSync(outside, "png");
      utimesSync(outside, tick, tick);
      symlinkSync(outside, join(dir, "characters-office", "testa.png"));
      expect(characterForProvider("openai-codex")).toBe("YUKI(유키)");
      rmSync(join(dir, "characters-office", "testa.png"));
      writeFileSync(join(dir, "characters-office", "testa.png"), "png");
      utimesSync(join(dir, "characters-office", "testa.png"), tick, tick);
      expect(characterForProvider("openai-codex")).toBe(OFFICE_ALIAS);
      rmSync(join(dir, "characters-office", "testa.png"));
      expect(characterForProvider("openai-codex")).toBe("YUKI(유키)");
    });
  });

  test("a padded id is trimmed before the id rule, and a roster.json symlinked outside characters-office gives no office state", async () => {
    const padded = { seats: { "YUKI(유키)": { ...OFFICE_ROSTER.seats["YUKI(유키)"], id: "  testa  ", alias: `  ${OFFICE_ALIAS}  ` } } };
    await withOfficeProfile({ mode: "office", roster: padded }, () => {
      expect(characterForProvider("openai-codex")).toBe(OFFICE_ALIAS);
    });
    await withOfficeProfile({ mode: "office", roster: OFFICE_ROSTER }, (dir) => {
      const rosterPath = join(dir, "characters-office", "roster.json");
      const outside = join(dir, "roster-outside.json");
      writeFileSync(outside, JSON.stringify(OFFICE_ROSTER));
      rmSync(rosterPath);
      symlinkSync(outside, rosterPath);
      expect(characterForProvider("openai-codex")).toBe("YUKI(유키)");
      expect(parseCharacterIntent("테스타 불러와")).toBeUndefined();
      rmSync(rosterPath);
      writeFileSync(rosterPath, JSON.stringify(OFFICE_ROSTER, null, 1));
      expect(characterForProvider("openai-codex")).toBe(OFFICE_ALIAS);
    });
  });

  test("default mode ignores a present roster and keeps the built-in output", async () => {
    await withOfficeProfile({ mode: "default", roster: OFFICE_ROSTER }, () => {
      expect(characterForProvider("openai-codex")).toBe("YUKI(유키)");
      expect(parseCharacterIntent("테스타 불러와")).toBeUndefined();
      expect(renderCharacterVoice("YUKI(유키)")).toContain(CHARACTER_VOICES["YUKI(유키)"].temperament);
      expect(buildCharacterSummonBrief("인사한다.", "YUKI(유키)").startsWith(
        '[character-summon alias="YUKI(유키)" model="openai-codex/gpt-6-astra"]',
      )).toBe(true);
    });
  });

  test("switching the mode file takes effect on the next request", async () => {
    await withOfficeProfile({ mode: "default", roster: OFFICE_ROSTER }, (dir) => {
      expect(characterForProvider("openai-codex")).toBe("YUKI(유키)");
      writeFileSync(join(dir, "cuelo-character-mode.json"), JSON.stringify({ mode: "office" }));
      expect(characterForProvider("openai-codex")).toBe(OFFICE_ALIAS);
      writeFileSync(join(dir, "cuelo-character-mode.json"), JSON.stringify({ mode: "default" }));
      expect(characterForProvider("openai-codex")).toBe("YUKI(유키)");
    });
  });
});
