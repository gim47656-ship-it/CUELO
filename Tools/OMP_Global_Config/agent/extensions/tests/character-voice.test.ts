import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// 이 회귀는 설치된(또는 격리 패치된) core가 실제로 조립하는 system prompt를 검사한다.
// 대상 경로가 runtime fixture이므로 이 boundary만 동적 import를 사용한다.
const npmModules = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
const coreRoot = process.env.OMP_CORE_PATCH_TARGET
  ?? ["cuelo", "omp-web"].map((name) => join(npmModules, name, "node_modules/@oh-my-pi/pi-coding-agent"))
    .find((dir) => existsSync(dir))
  ?? join(npmModules, "cuelo/node_modules/@oh-my-pi/pi-coding-agent");
const systemPromptModule = join(coreRoot, "src/system-prompt.ts").replace(/\\/gu, "/");
if (!existsSync(systemPromptModule)) {
  throw new Error(`system prompt core를 찾지 못했다: ${systemPromptModule}`);
}
const { buildSystemPrompt } = await import(systemPromptModule);

import characterVoice, {
  anthropicCharacterForAccounts,
  CHARACTER_TARGETS,
  CHARACTER_VOICES,
  characterForProvider,
  buildCharacterSummonBrief,
  injectCharacterVoice,
  parseCharacterIntent,
  parseCharacterSummonDirectives,
  renderCharacterSummonRouting,
  renderCharacterVoice,
  rewriteTaskInputForCharacterSummon,
} from "../character-voice";

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
    { provider: "b-ai", id: "deepseek-v4.1-flash" },
    { provider: "opencode-go", id: "muse-spark-1.3-contributor" },
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
      hasProvider: (provider: string) => provider === "b-ai",
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
      "ISANA(이사나)": { model: "b-ai/deepseek-v4.1-flash", toolCapable: true },
      "MIO(미오)": { model: "anthropic/claude-opus-5-5", oauthPosition: 1, toolCapable: true },
      "RIN(린)": { model: "anthropic/claude-opus-5-5", oauthPosition: 0, toolCapable: true },
      "NOVA(노바)": { model: "opencode-go/muse-spark-1.3-contributor", toolCapable: true },
      "SHION(시온)": { model: "web6/gpt-6-pro", toolCapable: false },
    });
    expect(characterForProvider("openai-codex")).toBe("YUKI(유키)");
    expect(characterForProvider("b-ai")).toBe("ISANA(이사나)");
    expect(characterForProvider("opencode-go")).toBe("NOVA(노바)");
    expect(characterForProvider("web6")).toBe("SHION(시온)");
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

  test("tool-capable summon rewrites one task with exact model, Korean, and selected voice", () => {
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
    expect(task).toContain("task brief의 산문과 사용자 화면에 표시하는 모든 진행·최종 산문은 한국어");
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
    expect(routing).toContain("OMP TOOL rich 멘션");
    expect(routing).toContain("raw HTTP·clipboard·수동 붙여넣기·탭 이동을 요구하지 않는다");
    expect(routing).toContain("실제 전송 전에 fail closed");
    expect(routing).toContain('<character-voice alias="SHION(시온)">');
    expect(routing).toContain("SHION의 terminal 발화는 이미 사용자 화면에 표시되는 정본");
    expect(routing).toContain("Main은 그 본문을 다시 인용·요약·재집계하지 않고");
    expect(rewriteTaskInputForCharacterSummon({ task: "상담" }, "SHION(시온)").ok).toBe(false);
  });

  test("RIN switch pins OAuth position 0 before changing only the live session model", async () => {
    const harness = createRuntimeHarness();
    const result = await harness.emit("input", {
      type: "input",
      text: "린으로 교체해",
      source: "rpc",
    });
    expect(harness.calls).toEqual(["reload", "pin:11", "set:anthropic/claude-opus-5-5"]);
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
    expect(harness.calls).toEqual(["reload", "pin:13", "set:anthropic/claude-opus-5-5"]);
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
    expect(harness.calls).toEqual(["reload", "pin:13", "set:anthropic/claude-opus-5-5"]);
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

  test("the same user command seen by input and steering hooks switches exactly once", async () => {
    const harness = createRuntimeHarness();
    const text = "미오 불러와서 교체해 메인을";
    await harness.emit("input", { type: "input", source: "rpc", text });
    await harness.emit("message_start", {
      type: "message_start",
      message: { role: "user", content: text, steering: true },
    });
    expect(harness.calls).toEqual(["reload", "pin:13", "set:anthropic/claude-opus-5-5"]);
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
    expect(harness.calls).toEqual(["reload"]);
    expect(result).toEqual({
      text: "[CharacterSwitchRuntime] 교체를 실행하지 못했다. 도구를 호출하지 말고 사용자에게 다음 이유를 그대로 한국어로 알린다: Anthropic OAuth 저장 위치 0 계정을 현재 세션에 pin하지 못했습니다. 현재 세션 모델은 유지했습니다.",
    });
    expect(harness.ctx.model).toEqual({ provider: "openai-codex", id: "gpt-6-astra" });
    expect(harness.accounts.find((account) => account.active)?.credentialId).toBe(13);
  });

  test("pin 뒤 모델 교체가 실패하면 이전 계정 pin과 이전 모델을 되돌린다", async () => {
    const harness = createRuntimeHarness({ refusedModelSelector: "anthropic/claude-opus-5-5" });
    const result = await harness.emit("input", { type: "input", text: "린으로 교체해", source: "rpc" }) as { text: string };
    expect(harness.calls).toEqual(["reload", "pin:11", "set-refused:anthropic/claude-opus-5-5", "pin:13"]);
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
      "pin:11:exact:RIN(린)",
      "set:anthropic/claude-opus-5-5",
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
    const harness = createRuntimeHarness({ recoverableSelector: "b-ai/deepseek-v4.1-flash" });
    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: buildCharacterSummonBrief("인사한다.", "ISANA(이사나)"),
      systemPrompt: ["base"],
    });
    expect(harness.ctx.model).toEqual({ provider: "b-ai", id: "deepseek-v4.1-flash" });
    expect(harness.calls.filter((call) => call.startsWith("discover:"))).toEqual(["discover:b-ai"]);
    const result = await harness.emit("before_provider_request", {
      type: "before_provider_request",
      payload: { messages: [], instructions: "base" },
    });
    expect(JSON.stringify(result)).toContain("ISANA(이사나)");
    expect(JSON.stringify(result)).not.toContain("NOVA(노바)");
  });

  test("failed ISANA discovery preserves the previous model and does not switch providers", async () => {
    const harness = createRuntimeHarness({
      recoverableSelector: "b-ai/deepseek-v4.1-flash",
      discoveryError: "discovery unavailable",
    });
    const result = await harness.emit("input", {
      type: "input",
      text: "이사나로 교체해",
      source: "rpc",
    });
    expect(harness.ctx.model).toEqual({ provider: "openai-codex", id: "gpt-6-astra" });
    expect(harness.calls).toEqual(["discover:b-ai"]);
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
      "pin:13:exact:MIO(미오)",
      "set:anthropic/claude-opus-5-5",
    ]);
  });
});
