// Native task effort, Astra configuration_update, Main auto 추론 하한의 실제 실행 경로 회귀.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-agent-thinking-test.ts
// 대상 설치/격리 사본의 모듈 로딩 경계가 검사 대상이므로 runtime-selected path로 import한다.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { settingsLike } from "./core-test-settings";
import { decideAutoEffort, parseAutoEffortConfig } from "../agent/extensions/lib/auto-effort-policy";

const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
const candidates = process.env.OMP_CORE_PATCH_TARGET
	? [process.env.OMP_CORE_PATCH_TARGET]
	: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
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
// classifyDifficulty 경로에서 본다. 분류기 전송은 judge role chain(ChainJudge.withCandidate)을 후보 하나로 대체하는 메모리 stub 이고
// 외부 호출은 없다. 후보가 받는 질문은 classifier 가 실제로 만든 것이다.
const { ModelControls } = await import(`${packages}/pi-coding-agent/src/session/model-controls.ts`);
const { Settings } = await import(`${packages}/pi-coding-agent/src/config/settings.ts`);
const { cfgProvidersAutoThinkingMinEffort } = await import(`${packages}/pi-coding-agent/src/session/settings.ts`);
const { ChainJudge } = await import(`${packages}/pi-coding-agent/src/judgment/index.ts`);

type Reply = "fail" | "low" | "medium" | "high" | "xhigh" | "max";
let reply: Reply = "low";
let judgeCalls = 0;
let askedLevels: string[] = [];
type LevelRequest = { state?: { request?: string; solution_space?: string }; questions?: { level?: { criteria?: Record<string, string> } } };
const classifiedInputs: Array<LevelRequest["state"]> = [];
const fixtureJudge = {
	label: "fixture",
	async judge(request: LevelRequest) {
		judgeCalls += 1;
		classifiedInputs.push(request.state);
		// 질문이 허용하는 단계(criteria 키)로만 답한다: auto ceiling 이 xhigh 면 max 는 질문에 없어 고를 수 없다.
		askedLevels = Object.keys(request.questions?.level?.criteria ?? {});
		if (reply === "fail" || !askedLevels.includes(reply)) throw new Error("fixture classifier failure");
		const other = (1 - 0.6) / (askedLevels.length - 1);
		const probabilities = Object.fromEntries(askedLevels.map(level => [level, level === reply ? 0.6 : other]));
		return {
			api: "fixture",
			provider: "fixture",
			model: "fixture",
			answers: { level: { type: "choice", choice: reply, probabilities, confidence: 0.6 } },
			usage: { input: 1, output: 1 },
		};
	},
};
ChainJudge.prototype.withCandidate = async function withFixtureCandidate(
	run: (judge: typeof fixtureJudge, kind: string) => Promise<unknown>,
) {
	return run(fixtureJudge, "native");
};

let floor: string | undefined;
const autoSettings = settingsLike({
	revision: 0,
	get: (key: string) => (key === "providers.autoThinkingMinEffort" ? floor : undefined),
});
const setFloor = (value: string | undefined) => {
	floor = value;
	autoSettings.revision += 1;
};
const registry = {};
const ladderModel = (efforts: string[], defaultLevel = "high") => ({
	provider: "fixture", id: `floor-${efforts.join("-")}`, reasoning: true,
	thinking: { mode: "effort", efforts, defaultLevel },
});
const controls = (
	model: object,
	options: { thinkingLevel?: string; thinkingLevelCeiling?: string; settings?: unknown; branch?: object[] } = {},
) => {
	const persisted: string[] = [];
	const control = new ModelControls(
		{
			agent: { setThinkingLevel() {}, setDisableReasoning() {}, metadataForProvider: () => undefined },
			settings: options.settings ?? autoSettings,
			modelRegistry: registry,
			sessionManager: {
				getSessionId: () => "your-floor-session",
				getLeafId: () => null,
				getBranch: () => options.branch ?? [],
				appendModelUsage: () => undefined,
				appendThinkingLevelChange: (level: string) => persisted.push(level),
			},
			providerSessionState: new Map(),
			model: () => model,
			sessionId: () => "your-floor-session",
			promptGeneration: () => 1,
			magicKeywordEnabled: () => true,
			clearInheritedProviderPromptCacheKey() {},
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

// [raise-only] 실행 중 사용자 steering·follow-up 재판정(2026-10-04 사용자 결정): 같은 턴 안에서는 현재보다 높을 때만
// 반영하고, 낮은 판정·분류 실패는 상태·기록을 그대로 둔다. 다음 새 사용자 턴은 평소처럼 내려갈 수 있다.
{
	setFloor("medium");
	const { control, turn, persisted } = controls(full);
	assert.equal(await turn("medium"), "medium");
	assert.equal(await turn("high"), "high");
	const raise = async (answer: Reply) => {
		reply = answer;
		await control.applyAutoThinkingLevel("fixture turn\n\n추가 목표", 1, undefined, { raiseOnly: true });
		return control.thinkingLevel;
	};
	assert.equal(await raise("medium"), "high", "낮은 재판정은 내리지 않는다");
	assert.equal(await raise("fail"), "high", "분류 실패 fallback도 내리지 않는다");
	assert.deepEqual(persisted, ["medium", "high"], "올리지 않은 재판정은 기록을 남기지 않는다");
	assert.equal(await raise("xhigh"), "xhigh");
	assert.deepEqual(persisted, ["medium", "high", "xhigh"]);
	assert.equal(await turn("low"), "medium", "다음 새 사용자 턴은 raise-only 가 아니라 하한까지 내려간다");
	console.log("  PASS  raise-only 재판정은 올리기만 하고, 다음 새 사용자 턴은 다시 내려갈 수 있다");
}

// [child-range] Maker auto 범위(2026-11-08 사용자 결정): child(createSubagentSettings overlay)의 auto 는 high~xhigh 안에서 고른다(Main 은 medium~xhigh).
// Opus 처럼 max 가 있는 모델도 auto 는 max 를 묻지 않고, low·medium 은 high 로 올린다. 선언하지 않은 단계는 만들지 않고, concrete effort 로 띄운 child 는 auto 가 아니다.
{
	const { createSubagentSettings } = await import(`${packages}/pi-coding-agent/src/task/executor.ts`);
	const root = mkdtempSync(join(tmpdir(), "omp-child-range-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const file = join(root, "config.yml");
	writeFileSync(
		file,
		"providers:\n  autoThinkingMinEffort: medium\n  autoThinkingMaxEffort: xhigh\n",
		"utf8",
	);
	const main = await Settings.loadIsolated({ inMemory: true, cwd, agentDir, configFiles: [file] });
	const child = createSubagentSettings(main);
	const opus = ladderModel(["low", "medium", "high", "xhigh", "max"]);
	const childTurn = controls(opus, { settings: child }).turn;
	assert.equal(await childTurn("xhigh"), "xhigh", "child Opus auto 상한은 xhigh 다");
	assert.ok(!askedLevels.includes("max"), "child 분류 질문에 Opus max 가 없다");
	assert.equal(await childTurn("low"), "high", "child low 는 하한 high 로 올린다");
	assert.equal(await childTurn("medium"), "high", "child medium 도 하한 high 로 올린다");
	assert.equal(await childTurn("high"), "high", "child 일반 작업 단계 high 는 그대로다");
	assert.equal(await controls(full, { settings: child }).turn("xhigh"), "xhigh", "max 가 없는 모델도 상한 xhigh 까지다");
	const mainTurn = controls(opus, { settings: main }).turn;
	assert.equal(await mainTurn("low"), "medium", "Main 하한 medium 은 그대로다");
	assert.equal(await mainTurn("xhigh"), "xhigh");
	assert.ok(!askedLevels.includes("max"), "Main 분류 질문은 xhigh 상한 그대로 max 가 없다");
	const concrete = controls(opus, { settings: child, thinkingLevel: "high" });
	assert.equal(await concrete.turn("max"), "high", "concrete effort child 는 분류 결과를 쓰지 않는다");
	assert.equal(concrete.control.isAutoThinking, false);
	rmSync(root, { recursive: true, force: true });
	// DeepSeek 처럼 low·high·max 만 선언한 사다리: low 는 high 로 올리고 max 는 상한 xhigh 에 막혀 선언된 high 로 남는다.
	const sparse = ladderModel(["low", "high", "max"]);
	assert.equal(await controls(sparse, { settings: child }).turn("low"), "high", "선언된 low 는 high 로 올린다");
	assert.equal(await controls(sparse, { settings: child }).turn("xhigh"), "high", "선언하지 않은 xhigh 를 만들지 않고 max 로 올리지도 않는다");
	// high~xhigh 사이에 선언된 단계가 없으면 하한을 올리지 못하므로 그대로 둔다.
	const lowOnly = ladderModel(["low", "medium"]);
	assert.equal(await controls(lowOnly, { settings: child }).turn("low"), "low", "high 이상이 없는 사다리는 그대로다");
	assert.equal(await controls(lowOnly, { settings: child }).turn("medium"), "medium");
	console.log("  PASS  child auto 는 high~xhigh(Opus 도 max 없음, 선언 단계만)이고 Main medium~xhigh·concrete child 는 그대로다");
}
// [auto-policy] Exercise the real core seam without an external model request.
const policyKey = Symbol.for("cuelo.autoThinkingPolicy");
const previousPolicy = Reflect.get(globalThis, policyKey);
try {
	setFloor("medium");
	let policyCalls = 0;
	Reflect.set(globalThis, policyKey, () => { policyCalls++; return { floor: "high" }; });
	const high = controls(full);
	for (const answer of ["low", "medium", "high", "xhigh"] as const) {
		assert.equal(await high.turn(answer), answer === "xhigh" ? "xhigh" : "high");
	}
	assert.equal(policyCalls, 4, "consult the policy once per ordinary auto call");
	const classifiedCapped = controls(full);
	classifiedCapped.control.setThinkingLevelCeiling("medium");
	assert.equal(await classifiedCapped.turn("low"), "medium");
	classifiedCapped.control.setThinkingLevelCeiling("xhigh");
	assert.equal(classifiedCapped.control.thinkingLevel, "high", "policy floor also applies to the uncapped classified value");
	console.log("  PASS  policy high replaces settings medium and preserves classified xhigh");

	setFloor("high");
	Reflect.set(globalThis, policyKey, () => ({ floor: "medium" }));
	assert.equal(await controls(full).turn("low"), "medium", "policy medium replaces the child high floor");
	console.log("  PASS  a policy medium floor overrides the child-style settings high floor");

	setFloor("medium");
	const held = controls(full);
	assert.equal(await held.turn("xhigh"), "xhigh");
	Reflect.set(globalThis, policyKey, () => ({ floor: "medium", hold: true }));
	const beforeHold = judgeCalls;
	assert.equal(await held.turn("low"), "xhigh");
	assert.equal(judgeCalls, beforeHold);
	held.control.setThinkingLevelCeiling("medium");
	assert.equal(await held.turn("low"), "medium");
	held.control.setThinkingLevelCeiling("xhigh");
	assert.equal(held.control.thinkingLevel, "xhigh", "hold preserves the last uncapped classification");
	assert.equal(judgeCalls, beforeHold);
	console.log("  PASS  hold skips judging and preserves classified xhigh across temporary session ceilings");

	const rising = controls(full);
	assert.equal(await rising.turn("fail"), "medium", "first hold ignores provisional high");
	Reflect.set(globalThis, policyKey, () => ({ floor: "high", hold: true }));
	assert.equal(await rising.turn("low"), "high", "a higher tier floor raises the held resolution");
	assert.equal(await controls(full).turn("xhigh"), "high", "first held turn resolves at the floor");
	const capped = controls(ladderModel(["low", "medium", "high", "xhigh"], "xhigh"));
	capped.control.setThinkingLevelCeiling("medium");
	assert.equal(await capped.turn("xhigh"), "medium");
	capped.control.setThinkingLevelCeiling("xhigh");
	assert.equal(capped.control.thinkingLevel, "high", "first hold stores the floor, never provisional high/xhigh");
	assert.equal(judgeCalls, beforeHold);
	console.log("  PASS  first holds start at the floor, higher floors raise holds and session ceilings still win");

	const beforeRaise = [...rising.persisted];
	await rising.control.applyAutoThinkingLevel("accumulated request", 1, undefined, { raiseOnly: true, added: "yes" });
	assert.equal(rising.control.thinkingLevel, "high");
	assert.deepEqual(rising.persisted, beforeRaise);
	assert.equal(judgeCalls, beforeHold);
	console.log("  PASS  raise-only hold keeps state and persistence unchanged");

	const sparseConfig = parseAutoEffortConfig('autoEffort:\n  floorHigh: "fixture/*"\n');
	Reflect.set(globalThis, policyKey, (input: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(input, sparseConfig));
	for (const efforts of [["low", "high", "max"], ["minimal", "low", "medium", "high"]]) {
		assert.equal(await controls(ladderModel(efforts)).turn("low"), "high");
	}
	assert.equal(judgeCalls, beforeHold, "rule C skips the judge when only high is eligible");
	console.log("  PASS  both sparse ladder shapes skip judging through the registered policy seam");

	// A session loaded from its file (idle unload, server restart) has no in-memory resolution.
	Reflect.set(globalThis, policyKey, () => ({ floor: "medium", hold: true }));
	const userTurn = { type: "message", message: { role: "user" } };
	const levelChange = (thinkingLevel: string, configured = "auto") => ({ type: "thinking_level_change", thinkingLevel, configured });
	const loaded = (branch: object[], model: object = full) => controls(model, { branch });
	const withMax = ladderModel(["low", "medium", "high", "xhigh", "max"]);
	const beforeLoaded = judgeCalls;
	assert.equal(await loaded([userTurn, levelChange("xhigh")]).turn("low"), "xhigh", "a loaded session keeps the auto level its transcript recorded");
	assert.equal(await loaded([levelChange("xhigh"), userTurn]).turn("low"), "xhigh", "a first-turn classification is recorded before its user entry");
	assert.equal(await loaded([levelChange("xhigh")]).turn("low"), "medium", "a session without a user turn still starts at the floor");
	assert.equal(await loaded([userTurn]).turn("low"), "high", "no recorded change means the session worked at the provisional level");
	assert.equal(await loaded([userTurn, levelChange("low")]).turn("low"), "medium", "a recorded level below the tier floor is raised");
	assert.equal(await loaded([userTurn, levelChange("xhigh"), levelChange("low", "low")]).turn("low"), "medium", "a concrete last change is not an auto level");
	assert.equal(await loaded([userTurn, levelChange("bogus")]).turn("low"), "medium", "an unknown recorded level is ignored");
	assert.equal(await loaded([userTurn, levelChange("max")], withMax).turn("low"), "xhigh", "a recorded ultrathink maximum resumes inside the auto ceiling");
	const loadedCapped = loaded([userTurn, levelChange("xhigh")]);
	loadedCapped.control.setThinkingLevelCeiling("medium");
	assert.equal(await loadedCapped.turn("low"), "medium");
	loadedCapped.control.setThinkingLevelCeiling("xhigh");
	assert.equal(loadedCapped.control.thinkingLevel, "xhigh", "the session ceiling wins and lifting it restores the recorded level");
	const sparseLadder = ladderModel(["low", "high", "max"]);
	Reflect.set(globalThis, policyKey, () => ({ floor: "high", hold: true }));
	assert.equal(await loaded([userTurn, levelChange("max")], sparseLadder).turn("low"), "high", "without promotion a recorded maximum resumes at high");
	Reflect.set(globalThis, policyKey, () => ({ floor: "high", hold: true, xhighAsMax: true }));
	assert.equal(await loaded([userTurn, levelChange("max")], sparseLadder).turn("low"), "max", "a promotion model keeps its recorded maximum");
	Reflect.set(globalThis, policyKey, () => ({ floor: "medium" }));
	const reclassified = loaded([userTurn, levelChange("low")]);
	assert.equal(await reclassified.turn("xhigh"), "xhigh");
	Reflect.set(globalThis, policyKey, () => ({ floor: "medium", hold: true }));
	assert.equal(await reclassified.turn("low"), "xhigh", "a resolution made in this process outranks the transcript");
	assert.equal(judgeCalls, beforeLoaded + 1, "loaded holds never call the judge");
	console.log("  PASS  a session loaded from its file resumes the recorded auto level on a hold");

	let observed: Record<string, unknown> | undefined;
	Reflect.set(globalThis, policyKey, (input: Record<string, unknown>) => { observed = input; return { hold: true }; });
	await rising.control.applyAutoThinkingLevel("accumulated", 1, "solution", { raiseOnly: true, added: "new" });
	assert.deepEqual(observed, {
		provider: full.provider, modelId: full.id, supportedEfforts: ["low", "medium", "high", "xhigh"],
		request: "accumulated", added: "new", solutionSpace: "solution", raiseOnly: true, current: "high",
	});
	console.log("  PASS  policy receives model, new evidence, solution space and last resolution");

	Reflect.set(globalThis, policyKey, () => { throw new Error("fixture policy failure"); });
	const beforeThrow = judgeCalls;
	assert.equal(await controls(full).turn("low"), "medium");
	assert.equal(judgeCalls, beforeThrow + 1, "throwing policy follows the unmodified classifier path");
	for (const value of [42, () => ({ floor: "max", hold: "yes" }), () => null]) {
		Reflect.set(globalThis, policyKey, value);
		assert.equal(await controls(full).turn("low"), "medium");
	}
	Reflect.set(globalThis, policyKey, () => { throw new Error("ultrathink must bypass the policy"); });
	const beforeMagic = judgeCalls;
	assert.equal(await controls(ladderModel(["low", "medium", "high", "xhigh", "max"])).turn("low", "ultrathink please"), "max");
	assert.equal(judgeCalls, beforeMagic);
	console.log("  PASS  invalid/throwing policies fall back and ultrathink keeps priority");
	Reflect.set(globalThis, policyKey, () => ({ floor: "high", hold: true }));
	assert.equal(await controls(ladderModel(["minimal", "low"], "low")).turn("low"), "low", "M2: unreachable first-hold floor keeps the normal provisional effort");
	console.log("  PASS  an unreachable first-hold floor falls back to the normal provisional effort");
	for (const [efforts, expected] of [
		[["low", "medium", "high", "xhigh", "max"], "xhigh"],
		[["low", "high", "max"], "high"],
	] as const) {
		const afterMagic = controls(ladderModel([...efforts]));
		assert.equal(await afterMagic.turn("low", "ultrathink please"), "max");
		const beforeHeldMagic = judgeCalls;
		assert.equal(await afterMagic.turn("low", "ok"), expected, "M1: ultrathink bypass ends on the next held turn");
		afterMagic.control.setThinkingLevelCeiling("low");
		afterMagic.control.setThinkingLevelCeiling("max");
		assert.equal(afterMagic.control.thinkingLevel, expected, "M1: the uncapped held value obeys the auto ceiling too");
		assert.equal(judgeCalls, beforeHeldMagic);
	}
	const maxSettings = settingsLike({ get: (key: string) =>
		key === "providers.autoThinkingMaxEffort" ? "max" : key === "providers.autoThinkingMinEffort" ? "medium" : undefined });
	const permittedMax = controls(ladderModel(["low", "high", "max"]), { settings: maxSettings });
	assert.equal(await permittedMax.turn("low", "ultrathink please"), "max");
	assert.equal(await permittedMax.turn("low", "ok"), "max", "M1: an explicit auto max ceiling still permits held max");
	console.log("  PASS  holds cap previous ultrathink at the auto ceiling, including sparse ladders and explicit max");
	Reflect.set(globalThis, policyKey, () => ({ floor: "high", xhighAsMax: true }));
	const promoted = controls(ladderModel(["low", "high", "max"]));
	assert.equal(await promoted.turn("xhigh"), "max", "M3: ordinary xhigh evidence maps to supported max");
	assert.deepEqual(askedLevels, ["low", "high", "xhigh"], "M3: use the ordinary xhigh question, never the max rubric");
	assert.equal(await promoted.turn("high"), "high");
	assert.equal(await promoted.turn("low"), "high");
	assert.equal(await promoted.turn("xhigh"), "max");
	Reflect.set(globalThis, policyKey, () => ({ floor: "high", xhighAsMax: true, hold: true }));
	const beforePromotedHold = judgeCalls;
	assert.equal(await promoted.turn("low", "ok"), "max");
	assert.equal(judgeCalls, beforePromotedHold);
	promoted.control.setThinkingLevelCeiling("high");
	assert.equal(await promoted.turn("low", "ok"), "high");
	promoted.control.setThinkingLevelCeiling("max");
	assert.equal(promoted.control.thinkingLevel, "max", "M3: capped promoted hold retains uncapped max");
	Reflect.set(globalThis, policyKey, () => ({ floor: "high", xhighAsMax: true }));
	assert.equal(await controls(ladderModel(["low", "high", "max"]), { thinkingLevelCeiling: "high" }).turn("xhigh"), "high");
	assert.equal(await controls(ladderModel(["low", "medium", "high", "xhigh", "max"])).turn("xhigh"), "xhigh");
	assert.ok(!askedLevels.includes("max"), "M3: a declared xhigh ladder ignores promotion");
	Reflect.set(globalThis, policyKey, (input: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(input, sparseConfig));
	const beforeUnpromoted = judgeCalls;
	assert.equal(await controls(ladderModel(["low", "high", "max"])).turn("xhigh"), "high");
	assert.equal(judgeCalls, beforeUnpromoted, "M3: no flag keeps sparse rule C");
	console.log("  PASS  promoted sparse xhigh evidence reaches max while holds, floors and session ceilings remain correct");

	const nativeCandidate = ChainJudge.prototype.withCandidate;
	try {
		let bucket = "hard";
		ChainJudge.prototype.withCandidate = async function withLocalCandidate(run: (judge: unknown, kind: string) => Promise<unknown>) {
			return run({ judge: async () => ({ answers: { bucket: { choice: bucket } } }) }, "local");
		};
		Reflect.set(globalThis, policyKey, () => ({ floor: "high", xhighAsMax: true }));
		const local = controls(ladderModel(["low", "high", "max"]));
		assert.equal(await local.turn("low"), "max", "M3: on-device hard also maps to max");
		bucket = "moderate";
		assert.equal(await local.turn("low"), "high");
	} finally {
		ChainJudge.prototype.withCandidate = nativeCandidate;
	}
	console.log("  PASS  promoted local hard reaches max and local moderate remains high");
} finally {
	if (previousPolicy === undefined) Reflect.deleteProperty(globalThis, policyKey);
	else Reflect.set(globalThis, policyKey, previousPolicy);
}

// Regression checks run independently so RED records each failed contract.
const regressionErrors: string[] = [];
let regressionCount = 0;
async function regression(name: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
		regressionCount++;
		console.log(`  PASS  ${name}`);
	} catch (error) {
		const message = `${name}: ${error instanceof Error ? error.message : String(error)}`;
		regressionErrors.push(message);
		console.error(`  RED  ${message}`);
	}
}
try {
	setFloor("medium");
	await regression("ceiling clamps classified and remembered levels; session ceiling still wins", async () => {
		Reflect.set(globalThis, policyKey, () => ({ ceiling: "high" }));
		const capped = controls(full);
		capped.control.setThinkingLevelCeiling("medium");
		assert.equal(await capped.turn("xhigh"), "medium");
		capped.control.setThinkingLevelCeiling("xhigh");
		assert.equal(capped.control.thinkingLevel, "high");
		assert.equal(await controls(full).turn("xhigh"), "high");
	});
	await regression("ceiling clamps held and transcript-restored levels even above the floor", async () => {
		Reflect.set(globalThis, policyKey, () => ({}));
		const held = controls(full);
		await held.turn("xhigh");
		Reflect.set(globalThis, policyKey, () => ({ floor: "xhigh", ceiling: "high", hold: true }));
		const before = judgeCalls;
		assert.equal(await held.turn("low"), "high");
		const restored = controls(full, { branch: [
			{ type: "message", message: { role: "user" } },
			{ type: "thinking_level_change", thinkingLevel: "xhigh", configured: "auto" },
		] });
		assert.equal(await restored.turn("low"), "high");
		held.control.setThinkingLevelCeiling("low");
		held.control.setThinkingLevelCeiling("xhigh");
		assert.equal(held.control.thinkingLevel, "high");
		assert.equal(judgeCalls, before);
		Reflect.set(globalThis, policyKey, () => ({ floor: "xhigh", ceiling: "high" }));
		assert.equal(await controls(full).turn("low"), "high", "ceiling also wins over floor in the classifier path");
	});
	await regression("raise-only candidate respects cap but never lowers an already higher turn", async () => {
		Reflect.set(globalThis, policyKey, () => ({ ceiling: "high" }));
		const provisional = controls(full);
		reply = "low";
		await provisional.control.applyAutoThinkingLevel("long steering text here", 1, undefined, { raiseOnly: true, added: "long steering text here" });
		assert.equal(provisional.control.thinkingLevel, "high", "R1-ANT-2: no resolved value yet keeps provisional high");
		provisional.control.setThinkingLevelCeiling("low");
		provisional.control.setThinkingLevelCeiling("xhigh");
		assert.equal(provisional.control.thinkingLevel, "high", "R1-ANT-2: absent uncapped memory remains provisional");
		console.log("  PROBE R1-ANT-2: fresh raise-only resolves without throwing; high before/after ceiling toggle");
		const rising = controls(full);
		await rising.turn("medium");
		reply = "xhigh";
		await rising.control.applyAutoThinkingLevel("new substantive steering", 1, undefined, { raiseOnly: true, added: "new substantive steering" });
		assert.equal(rising.control.thinkingLevel, "high");
		rising.control.setThinkingLevelCeiling("low");
		rising.control.setThinkingLevelCeiling("xhigh");
		assert.equal(rising.control.thinkingLevel, "high");
		await rising.turn("low", "ultrathink please");
		assert.equal(rising.control.thinkingLevel, "xhigh");
		await rising.control.applyAutoThinkingLevel("new substantive steering", 1, undefined, { raiseOnly: true });
		assert.equal(rising.control.thinkingLevel, "xhigh");
		rising.control.setThinkingLevelCeiling("low");
		rising.control.setThinkingLevelCeiling("xhigh");
		assert.equal(rising.control.thinkingLevel, "high", "a non-keyword raise-only call caps the remembered value even when the turn stays higher");
		assert.equal(await rising.turn("xhigh"), "high", "next non-raise-only call brings an over-cap turn down");
	});
	await regression("matching cap single eligible level holds without judging; ultrathink bypasses", async () => {
		const config = parseAutoEffortConfig('autoEffort:\n  floorHigh: "fixture/*"\n  capHigh: "fixture/*"\n');
		Reflect.set(globalThis, policyKey, (value: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(value, config));
		const before = judgeCalls;
		assert.equal(await controls(full).turn("xhigh", "a substantive classification request longer than twenty characters"), "high");
		assert.equal(judgeCalls, before);
		assert.equal(await controls(ladderModel(["low", "medium", "high", "xhigh", "max"])).turn("low", "ultrathink please"), "max");
		assert.equal(judgeCalls, before);
	});
	await regression("unmatched cap and invalid cap keep the existing Auto behavior", async () => {
		const config = parseAutoEffortConfig('autoEffort:\n  capHigh: "other/*"\n');
		assert.equal(decideAutoEffort({ provider: "other", modelId: "test", supportedEfforts: ["medium", "high", "xhigh"], request: "substantive request for classification", raiseOnly: false }, config).ceiling, "high");
		Reflect.set(globalThis, policyKey, (value: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(value, config));
		assert.equal(await controls(full).turn("xhigh", "a substantive unmatched request longer than twenty characters"), "xhigh");
		Reflect.set(globalThis, policyKey, () => ({ ceiling: "max" }));
		assert.equal(await controls(full).turn("xhigh"), "xhigh");
	});
	await regression("real streaming steering classifies new message only and never raises for lower evidence", async () => {
		Reflect.deleteProperty(globalThis, policyKey);
		// SDK path is selected by OMP_CORE_PATCH_TARGET, not the checkout dependency.
		const { createAgentSession } = await import(`${packages}/pi-coding-agent/src/sdk.ts`);
		const dir = mkdtempSync(join(tmpdir(), "effort-latest-steer-"));
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  default: fixture/latest\n");
		writeFileSync(join(agentDir, "models.yml"), "providers:\n  fixture:\n    baseUrl: http://127.0.0.1:1\n    api: openai-completions\n    apiKey: fixture\n    models:\n      - id: latest\n        name: latest\n        reasoning: true\n        input: [text]\n        contextWindow: 32000\n        maxTokens: 1024\n        thinking:\n          mode: effort\n          efforts: [low, medium, high, xhigh]\n          defaultLevel: high\n");
		const { session } = await createAgentSession({ cwd: dir, agentDir, disableExtensionDiscovery: true });
		try {
			session.setThinkingLevel("low");
			const observed: Array<{ request: string | undefined; level: string | undefined; initial: string | undefined }> = [];
			session.agent.addBeforeModelCallHook(async () => {
				session.setThinkingLevel("auto");
				const initial = session.thinkingLevel;
				for (const text of ["first substantive steering request", "second substantive steering request"]) {
					reply = "medium";
					const before = classifiedInputs.length;
					await session.prompt(text, { streamingBehavior: "steer" });
					for (let i = 0; i < 100 && classifiedInputs.length === before; i++) await Bun.sleep(10);
					await Bun.sleep(10);
					observed.push({ request: classifiedInputs.at(-1)?.request, level: session.thinkingLevel, initial });
				}
				session.agent.clearAllQueues();
				throw new Error("fixture stops before provider call");
			});
			try { await session.prompt("original task must not be included in steering"); } catch {}
			assert.deepEqual(observed.map(item => item.request), ["first substantive steering request", "second substantive steering request"]);
			assert.equal(observed.every(item => item.level === item.initial), true);
		} finally {
			session.agent.clearAllQueues();
			await session.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});
} finally {
	if (previousPolicy === undefined) Reflect.deleteProperty(globalThis, policyKey);
	else Reflect.set(globalThis, policyKey, previousPolicy);
}
assert.deepEqual(regressionErrors, []);
console.log(`latest-message/ceiling regressions ${regressionCount} pass`);
console.log(`결과 ${24 + regressionCount} pass`);
