// Native task effort, Astra configuration_update, Main auto 추론 하한의 실제 실행 경로 회귀.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-agent-thinking-test.ts
// 대상 설치/격리 사본의 모듈 로딩 경계가 검사 대상이므로 runtime-selected path로 import한다.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { settingsLike } from "./core-test-settings";

const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
const candidates = process.env.OMP_CORE_PATCH_TARGET
	? [process.env.OMP_CORE_PATCH_TARGET]
	: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
const core = candidates.find(candidate => existsSync(join(candidate, "src/task/executor.ts")));
if (!core) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
const packages = resolve(core, "..").replace(/\\/g, "/");
const { resolveTaskEffortLevel } = await import(`${packages}/pi-tui/src/thinking.ts`);
const { getBundledModels } = await import(`${packages}/pi-catalog/src/models.ts`);
const { buildTransformedCodexRequestBody } = await import(`${packages}/pi-ai/src/providers/openai-codex-responses.ts`);

// Devin OAuth discovery에서 관측한 SWE-2의 지원 ladder. 별도 auto-floor patch는 필요 없다.
const swe2 = {
	provider: "devin", id: "swe-2", reasoning: true,
	thinking: { mode: "effort", efforts: ["medium", "high", "max"], defaultLevel: "medium" },
};
assert.deepEqual(["lo", "med", "hi"].map(hint => resolveTaskEffortLevel(swe2, hint, "max")), ["medium", "high", "max"]);
assert.equal(resolveTaskEffortLevel(swe2, "hi", "high"), "high");
console.log("  PASS  native task lo/med/hi는 SWE-2 medium/high/max이며 ceiling을 지킨다");

const astra = getBundledModels("openai-codex").find(model => model.id === "gpt-6-astra");
assert.ok(astra, "bundled Astra 모델이 필요하다");
assert.equal(astra.compat.supportsConfigurationUpdate, true);
const providerSessionState = new Map();
const sessionId = "your-astra-cache-regression";
const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
const messages = [user("첫 번째 요청", 1)];
const body = (reasoning: string, id = sessionId, input = messages) => buildTransformedCodexRequestBody(
	astra, { systemPrompt: "동일한 시스템 지시", messages: input },
	{ reasoning, sessionId: id, providerSessionState }, id,
);
const first = await body("low");
messages.push(user("두 번째 요청", 2));
const high = await body("high");
assert.equal(high.reasoning.effort, first.reasoning.effort);
assert.equal(high.instructions, first.instructions);
assert.equal(high.prompt_cache_key, first.prompt_cache_key);
assert.deepEqual(high.input.slice(0, first.input.length), first.input);
assert.deepEqual(high.input.at(-2), { type: "configuration_update", reasoning: { effort: "high" } });
assert.deepEqual(await body("high"), high, "같은 요청 재시도는 update를 중복 삽입하지 않는다");
console.log("  PASS  Astra low→high에서 request effort·기존 prefix는 그대로이고 변경만 뒤에 붙는다");

messages.push(user("세 번째 요청", 3));
const medium = await body("medium");
assert.equal(medium.reasoning.effort, first.reasoning.effort);
assert.deepEqual(medium.input.slice(0, high.input.length), high.input);
assert.deepEqual(medium.input.at(-2), { type: "configuration_update", reasoning: { effort: "medium" } });
const independent = await body("high", "another-session");
assert.equal(independent.reasoning.effort, "high");
assert.equal(independent.input.some(item => item.type === "configuration_update"), false);
console.log("  PASS  후속 변경은 기존 update 위치를 보존하며 다른 세션으로 baseline이 새지 않는다");

const compacted = await body("medium", sessionId, [user("압축 후 새 이력", 4)]);
assert.equal(compacted.reasoning.effort, "medium");
assert.equal(compacted.input.some(item => item.type === "configuration_update"), false);
console.log("  PASS  짧아진 이력에서는 이전 update를 버리고 새 baseline을 잡는다");

// Auto 하한(providers.autoThinkingMinEffort)은 실제 ModelControls.applyAutoThinkingLevel →
// classifyDifficulty → Vercel judge 경로에서 본다. fetch만 메모리 stub이고 외부 호출은 없다.
const { ModelControls } = await import(`${packages}/pi-coding-agent/src/session/model-controls.ts`);
const { Settings } = await import(`${packages}/pi-coding-agent/src/config/settings.ts`);
const { cfgProvidersAutoThinkingMinEffort } = await import(`${packages}/pi-coding-agent/src/session/settings.ts`);

type Reply = "fail" | "low" | "medium" | "high" | "xhigh";
let reply: Reply = "low";
let judgeCalls = 0;
globalThis.fetch = (async () => {
	judgeCalls += 1;
	if (reply === "fail") return new Response("{}", { status: 500 });
	const levels = ["low", "medium", "high", "xhigh"];
	const probabilities = Object.fromEntries(levels.map(level => [level, level === reply ? 0.7 : 0.1]));
	return new Response(
		JSON.stringify({
			answers: { level: { type: "choice", choice: reply, probabilities } },
			usage: { inputTokens: 1, outputTokens: 1 },
			rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
			providerMetadata: { typesafe: { confidence: { level: 0.7 } } },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}) as typeof fetch;

let floor: string | undefined;
const autoSettings = settingsLike({
	revision: 0,
	get: (key: string) =>
		key === "providers.judgmentProvider" ? "vercel" : key === "providers.autoThinkingMinEffort" ? floor : undefined,
});
const setFloor = (value: string | undefined) => {
	floor = value;
	autoSettings.revision += 1;
};
const registry = { authStorage: { keys: { resolver: () => "your-floor-key" } } };
const ladderModel = (efforts: string[], defaultLevel = "high") => ({
	provider: "fixture", id: `floor-${efforts.join("-")}`, reasoning: true,
	thinking: { mode: "effort", efforts, defaultLevel },
});
const controls = (model: object, options: { thinkingLevel?: string; thinkingLevelCeiling?: string } = {}) => {
	const persisted: string[] = [];
	const control = new ModelControls(
		{
			agent: { setThinkingLevel() {}, setDisableReasoning() {}, metadataForProvider: () => undefined },
			settings: autoSettings,
			modelRegistry: registry,
			sessionManager: {
				getSessionId: () => "your-floor-session",
				getLeafId: () => null,
				appendModelUsage: () => undefined,
				appendThinkingLevelChange: (level: string) => persisted.push(level),
			},
			providerSessionState: new Map(),
			model: () => model,
			sessionId: () => "your-floor-session",
			promptGeneration: () => 1,
			magicKeywordEnabled: () => true,
			emit() {},
		} as never,
		{ thinkingLevel: options.thinkingLevel ?? "auto", thinkingLevelCeiling: options.thinkingLevelCeiling } as never,
	);
	const turn = async (answer: Reply, prompt = "fixture turn") => {
		reply = answer;
		await control.applyAutoThinkingLevel(prompt, 1);
		return control.thinkingLevel;
	};
	return { control, turn, persisted };
};
const full = ladderModel(["low", "medium", "high", "xhigh"]);

{
	setFloor(undefined);
	const { turn } = controls(full);
	assert.equal(await turn("low"), "low");
	setFloor("medium");
	assert.equal(await turn("fail"), "medium", "이전 low 분류 fallback도 하한으로 올린다");
	assert.equal(await turn("low"), "medium");
	assert.equal(await turn("high"), "high");
	assert.equal(await turn("xhigh"), "xhigh");
	console.log("  PASS  기본 low는 upstream 그대로이고 medium 하한은 low 분류·low fallback만 올리며 high/xhigh는 보존한다");
}

{
	setFloor("medium");
	const { control, turn, persisted } = controls(ladderModel(["low", "medium", "high"], "low"));
	assert.equal(control.thinkingLevel, "low", "새 user turn 분류 전 provisional/active effort는 바꾸지 않는다");
	assert.equal(await turn("fail"), "medium", "첫 분류 실패의 provisional low fallback");
	assert.deepEqual(persisted, ["medium"]);
	console.log("  PASS  하한은 genuine user turn 분류 시점에만 적용되고 첫 분류 실패 fallback도 medium이다");
}

{
	setFloor("medium");
	assert.equal(await controls(ladderModel(["low", "high", "max"])).turn("low"), "high");
	assert.equal(await controls(ladderModel(["low", "max"], "low")).turn("low"), "low", "auto ceiling xhigh를 넘는 max로 튀지 않는다");
	assert.equal(
		await controls(ladderModel(["low", "medium", "high"]), { thinkingLevelCeiling: "low" }).turn("low"),
		"low",
		"세션 effort ceiling이 하한보다 우선한다",
	);
	console.log("  PASS  medium 없는 ladder는 ceiling 안의 medium 이상 최소값, ceiling 충돌은 기존 ceiling 우선");
}

{
	setFloor("medium");
	const explicit = controls(full, { thinkingLevel: "low" });
	assert.equal(await explicit.turn("low"), "low");
	assert.equal(explicit.control.isAutoThinking, false);
	const before = judgeCalls;
	const max = ladderModel(["low", "medium", "high", "xhigh", "max"]);
	assert.equal(await controls(max).turn("low", "ultrathink please"), "max");
	assert.equal(judgeCalls, before, "ultrathink는 분류기를 부르지 않는다");
	console.log("  PASS  명시 선택은 하한 영향 없이 유지되고 ultrathink 최대 특례는 그대로다");
}

{
	const root = mkdtempSync(join(tmpdir(), "omp-auto-floor-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const file = join(root, "config.yml");
	writeFileSync(file, "providers:\n  autoThinkingMinEffort: medium\n", "utf8");
	const loaded = await Settings.loadIsolated({ inMemory: true, cwd, agentDir, configFiles: [file] });
	assert.equal(cfgProvidersAutoThinkingMinEffort.get(loaded), "medium");
	assert.equal(cfgProvidersAutoThinkingMinEffort.default, "low");
	rmSync(root, { recursive: true, force: true });
	console.log("  PASS  실제 Settings 로딩이 providers.autoThinkingMinEffort를 읽고 기본값은 low다");
}
console.log("결과 9 pass");
