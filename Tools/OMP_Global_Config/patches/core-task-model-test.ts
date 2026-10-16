// task per-item model selector 패치 검증. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-task-model-test.ts
// 미패치 core에서는 model이 삭제돼 FAIL(RED), 패치 core에서는 PASS(GREEN).
// getTaskSchema wire 표면만 검증한다. executor 전달 한 줄과 preflight 전달은
// apply-core-patch.mjs --check(앵커 적용 여부)와 Main의 diff 검수로 본다.
// 동적 import 예외: 정적 import는 bun 전역 캐시의 미패치 사본으로 해석될 수 있다.
// 이 검사는 지정된 사본만 검증해야 하므로 디스크 경로를 고정한다.
import { mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsTestScope } from "./core-test-settings";

/** 전역 npm 위치는 PC마다 다르다. apply-core-patch.mjs 와 같은 순서로 찾는다. */
function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(p => existsSync(join(p, "src/task/types.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	// 동적 import 는 URL 로 해석되므로 역슬래시를 쓰면 안 된다.
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const { getTaskSchema } = await import(`${CORE}/task/types.ts`);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name} ${detail}`);
	}
}

function isSchemaErrors(value: unknown): boolean {
	// arktype 계열 스키마는 실패 시 throw가 아니라 errors 인스턴스를 반환한다(core 전체 관례).
	// core 구현체는 ArkErrors가 아니라 OmpErrors이므로 이름 하나로 단정하지 않고
	// errors형 constructor명 + summary 문자열을 함께 본다. 성공 페이로드는 일반 Object다.
	return !!value && typeof value === "object"
		&& typeof (value as { constructor?: { name?: unknown } }).constructor?.name === "string"
		&& (value as { constructor: { name: string } }).constructor.name.endsWith("Errors")
		&& typeof (value as { summary?: unknown }).summary === "string";
}

function parse(schema: unknown, data: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
	if (typeof schema !== "function") return { ok: false, error: "스키마가 호출 가능하지 않다" };
	try {
		const value = (schema as (input: unknown) => unknown)(data);
		if (isSchemaErrors(value)) {
			const summary = "summary" in value && typeof value.summary === "string" ? value.summary : "schema 거부";
			return { ok: false, error: summary };
		}
		return { ok: true, value };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function firstTaskModel(value: unknown): { found: boolean; model: unknown } {
	if (!value || typeof value !== "object") return { found: false, model: undefined };
	if (!("tasks" in value) || !Array.isArray(value.tasks) || value.tasks.length === 0) {
		return { found: false, model: undefined };
	}
	const item = value.tasks[0];
	if (!item || typeof item !== "object" || !("model" in item)) return { found: false, model: undefined };
	return { found: true, model: item.model };
}

const MODEL = "b-ai/deepseek-v4.1-flash:max";
// 18.3.4 upstream 은 모든 task schema 에서 `solutionSpace` 를 필수로 받는다. 이 검사는 model 전달만 본다.
const SPACE = "one fix: forward model";

// 1. batch flat(static): model 보존, 생략 시 부재.
{
	const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
	const kept = parse(schema, { context: "ctx", tasks: [{ task: "do", solutionSpace: SPACE, model: MODEL }] });
	const keptModel = kept.ok ? firstTaskModel(kept.value) : { found: false, model: undefined };
	check("batch flat: model 보존", kept.ok && keptModel.found && keptModel.model === MODEL);
	const omitted = parse(schema, { context: "ctx", tasks: [{ task: "do", solutionSpace: SPACE }] });
	check("batch flat: 생략 시 부재", omitted.ok && !firstTaskModel(omitted.value).found);
}

// 2. batch isolation(static): model 보존.
{
	const schema = getTaskSchema({ isolationEnabled: true, batchEnabled: true });
	const kept = parse(schema, { context: "ctx", tasks: [{ task: "do", solutionSpace: SPACE, model: MODEL }] });
	const keptModel = kept.ok ? firstTaskModel(kept.value) : { found: false, model: undefined };
	check("batch isolation: model 보존", kept.ok && keptModel.found && keptModel.model === MODEL);
}

// 3. dynamic schema(defaultAgent 변경): iso + flat 모두 model 보존.
{
	for (const isolationEnabled of [true, false]) {
		const schema = getTaskSchema({ isolationEnabled, batchEnabled: true, defaultAgent: "maker" });
		const kept = parse(schema, { context: "ctx", tasks: [{ task: "do", solutionSpace: SPACE, model: MODEL }] });
		const keptModel = kept.ok ? firstTaskModel(kept.value) : { found: false, model: undefined };
		check(`dynamic ${isolationEnabled ? "iso" : "flat"}: model 보존`, kept.ok && keptModel.found && keptModel.model === MODEL);
	}
}

// 4. single flat: 최상위 model 보존, 생략 시 부재.
{
	const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false });
	const kept = parse(schema, { task: "do", solutionSpace: SPACE, model: MODEL });
	let found = false;
	let model: unknown;
	if (kept.ok && kept.value && typeof kept.value === "object" && "model" in kept.value) {
		found = true;
		model = kept.value.model;
	}
	check("single flat: model 보존", kept.ok && found && model === MODEL);
	const omitted = parse(schema, { task: "do", solutionSpace: SPACE });
	const omittedHas =
		omitted.ok && omitted.value && typeof omitted.value === "object" && "model" in omitted.value;
	check("single flat: 생략 시 부재", omitted.ok && !omittedHas);
}

// 5. delete 유지: 미지 키는 여전히 삭제된다.
{
	const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
	const parsed = parse(schema, { context: "ctx", tasks: [{ task: "do", solutionSpace: SPACE, model: MODEL, nope: 1 }] });
	let stripped = false;
	if (parsed.ok && parsed.value && typeof parsed.value === "object" && "tasks" in parsed.value) {
		const tasks = parsed.value.tasks;
		stripped =
			Array.isArray(tasks) && tasks.length > 0 && !!tasks[0] && typeof tasks[0] === "object" && !("nope" in tasks[0]);
	}
	check("delete 유지: 미지 키 삭제", parsed.ok && stripped);
}

// 6. effort 게이트 불변: 꺼지면 삭제, 켜지면 보존.
{
	const off = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
	const offParsed = parse(off, { context: "ctx", tasks: [{ task: "do", solutionSpace: SPACE, effort: "lo" }] });
	let offHas = false;
	if (offParsed.ok && offParsed.value && typeof offParsed.value === "object" && "tasks" in offParsed.value) {
		const tasks = offParsed.value.tasks;
		offHas =
			Array.isArray(tasks) && tasks.length > 0 && !!tasks[0] && typeof tasks[0] === "object" && "effort" in tasks[0];
	}
	check("effort 게이트 불변: off면 삭제", offParsed.ok && !offHas);
	const on = getTaskSchema({ isolationEnabled: false, batchEnabled: true, effortEnabled: true });
	const onParsed = parse(on, { context: "ctx", tasks: [{ task: "do", solutionSpace: SPACE, effort: "lo", model: MODEL }] });
	let onEffort: unknown;
	let onModel: unknown;
	if (onParsed.ok && onParsed.value && typeof onParsed.value === "object" && "tasks" in onParsed.value) {
		const tasks = onParsed.value.tasks;
		if (Array.isArray(tasks) && tasks.length > 0 && !!tasks[0] && typeof tasks[0] === "object") {
			onEffort = "effort" in tasks[0] ? tasks[0].effort : undefined;
			onModel = "model" in tasks[0] ? tasks[0].model : undefined;
		}
	}
	check("effort 게이트 불변: on이면 effort+model 보존", onParsed.ok && onEffort === "lo" && onModel === MODEL);
}

// 7. 타입 거부: model이 문자열이 아니면 파싱 실패.
{
	const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
	const bad = parse(schema, { context: "ctx", tasks: [{ task: "do", solutionSpace: SPACE, model: 123 }] });
	check("타입 거부: model 비문자열 실패", !bad.ok, bad.ok ? "파싱됨" : "");
}

// 8. 2026-10-17 18.11.3 공개 이슈 #33: upstream validateSeanceParams 가 비-seance agent 의 model 을 거절해 CUELO Maker 의
// `model: '<후보>:auto'` 발주가 막혔다. 패치는 agent `maker` 의 문자열 selector 하나만 더 받는다. 이슈의 7개 입력(1-4 는 이제
// 통과), 다른 비-seance agent 의 model·비-seance sourceSession·잘못된 Maker model 거절, seance 검사 불변을 본다.
// seance.ts 가 없는 core(18.11.1 이하)에는 이 검증이 없다.
if (!existsSync(`${CORE}/task/seance.ts`)) {
	console.log("  SKIP  이 core 에는 seance validator 가 없다(18.11.3 이전)");
} else {
	const { validateSeanceParams, seanceTaskSchemaFields } = await import(`${CORE}/task/seance.ts`);
	const SELECTOR = "anthropic/claude-sonnet-5-5:auto";
	const item = { name: "SyntheticMaker", task: "Read-only fixture.", solutionSpace: SPACE, model: SELECTOR };
	const seanceOnly = "`model` is only accepted for the `seance` agent.";
	const cases: Array<[string, unknown, boolean, boolean, (output: string | null) => boolean]> = [
		["#33-1 flat 명시 Maker + model 통과", { ...item, agent: "maker" }, false, false, output => output === null],
		["#33-2 flat 기본 Maker + model 통과", item, false, false, output => output === null],
		["#33-3 batch 기본 Maker + item model 통과", { context: "Fixture", tasks: [item] }, true, false, output => output === null],
		["#33-4 batch 명시 Maker + seance 노출 통과", { context: "Fixture", tasks: [{ ...item, agent: "maker" }] }, true, true, output => output === null],
		["#33-5 Maker model 없음 통과", { ...item, agent: "maker", model: undefined }, false, false, output => output === null],
		["#33-6 flat seance 통과", { ...item, agent: "seance", sourceSession: "synthetic.jsonl" }, false, true, output => output === null],
		["#33-7 batch seance 통과", { tasks: [{ ...item, agent: "seance", sourceSession: "synthetic.jsonl" }] }, true, true, output => output === null],
		["다른 비-seance agent 의 model 은 그대로 거절", { ...item, agent: "explore" }, false, true, output => output === seanceOnly],
		["batch 의 다른 비-seance agent model 도 거절", { context: "Fixture", tasks: [item, { ...item, agent: "task" }] }, true, false, output => output === seanceOnly],
		["Maker 의 sourceSession 은 그대로 거절", { ...item, agent: "maker", sourceSession: "synthetic.jsonl" }, false, true, output => output?.startsWith("`sourceSession` is only accepted") === true],
		["Maker model 배열은 거절", { ...item, agent: "maker", model: [SELECTOR] }, false, false, output => output?.includes("`maker` agent must be one non-empty selector string") === true],
		["Maker 빈 model 은 거절", { ...item, agent: "maker", model: "  " }, false, false, output => output?.includes("`maker` agent must be one non-empty selector string") === true],
		["batch 최상위 model 은 그대로 거절", { context: "Fixture", model: SELECTOR, tasks: [{ ...item, model: undefined }] }, true, false, output => output?.startsWith("Put `sourceSession` and `model`") === true],
		["seance 의 sourceSession 필수 검사 불변", { ...item, agent: "seance" }, false, true, output => output?.includes("requires a non-empty `sourceSession`") === true],
	];
	for (const [name, params, batchEnabled, seanceAdvertised, expected] of cases) {
		const output = validateSeanceParams({ params, batchEnabled, defaultAgent: "maker", seanceAdvertised }) ?? null;
		check(name, expected(output), `output=${JSON.stringify(output)}`);
	}
	// seance 가 노출되면 upstream seance 필드가 schema 의 model 을 string | string[] 로 넓힌다. Maker 항목의 문자열은 그대로다.
	for (const isolationEnabled of [true, false]) {
		const schema = getTaskSchema({ isolationEnabled, batchEnabled: true, defaultAgent: "maker", seanceFields: seanceTaskSchemaFields });
		const kept = parse(schema, { context: "ctx", tasks: [{ task: "do", solutionSpace: SPACE, model: SELECTOR }] });
		const keptModel = kept.ok ? firstTaskModel(kept.value) : { found: false, model: undefined };
		check(`seance 노출 dynamic ${isolationEnabled ? "iso" : "flat"}: Maker model 보존`, kept.ok && keptModel.found && keptModel.model === SELECTOR, kept.ok ? "" : kept.error);
	}
}

// 9. 같은 #33 계약을 실제 TaskTool 로 본다. planSpawns 는 speculative launcher 와 dispatch 가 함께 쓴다. speculative 경로는
// host 가 launch 를 거절하게 두고 host 에 물은 항목 수(= planSpawns 가 통과시킨 spawn 수)를 센다. dispatch 경로는
// structured-subagent 의 preflight 를 mock 으로 바꿔 받은 request.model 을 오류로 돌려받는다. 실제 child 는 띄우지 않는다.
if (!existsSync(`${CORE}/task/seance.ts`)) {
	console.log("  SKIP  이 core 에는 seance validator 가 없다(18.11.3 이전)");
} else {
	const actual = await import(`${CORE}/task/structured-subagent.ts`);
	const PREFLIGHT = "CUELO-TEST-PREFLIGHT model=";
	mock.module(`${CORE}/task/structured-subagent.ts`, () => ({
		...actual,
		resolveEffectiveSubagentPolicy: async (request: { model?: unknown }) => {
			throw new Error(`${PREFLIGHT}${JSON.stringify(request.model ?? null)}`);
		},
	}));
	const { TaskTool } = await import(`${CORE}/task/index.ts`);
	const SELECTOR = "anthropic/claude-sonnet-5-5:auto";
	const cwd = mkdtempSync(join(tmpdir(), "cuelo-task-model-"));
	const settingValues: Record<string, unknown> = { "task.batch": true, "task.speculativeLaunch": true, "async.enabled": false };
	const makeTool = async (spawns: string, batch: boolean) => {
		settingValues["task.batch"] = batch;
		const session = {
			cwd,
			settings: createSettingsTestScope(key => settingValues[key]),
			getSessionSpawns: () => spawns,
			getPlanModeState: () => undefined,
			taskDepth: 0,
			suppressSpawnAdvisory: true,
		};
		return TaskTool.create(session as never);
	};
	const resultText = (result: { content: Array<{ type: string; text?: string }> }) =>
		result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
	const speculativeAsked = async (tool: { speculation: { stream: { open: (context: unknown) => Promise<unknown> } } }, args: unknown) => {
		let asked = 0;
		const coordinator = {
			authorizeLaunch: () => {
				asked++;
				return { allowed: false, reason: "test" };
			},
		};
		const launch = (await tool.speculation.stream.open({ coordinator, parentToolCallId: "call-spec" })) as
			| { update: (call: unknown, json: string) => void; adopt: (spawns: unknown[]) => Promise<Map<number, unknown>> }
			| undefined;
		if (!launch) return -1;
		const json = JSON.stringify(args);
		launch.update({ type: "toolCall", id: "call-spec", name: "task", arguments: {} }, json.slice(0, -2));
		launch.update({ type: "toolCall", id: "call-spec", name: "task", arguments: args }, json);
		await launch.adopt([]);
		return asked;
	};
	try {
		const batchArgs = (agent: string | undefined) => ({
			context: "Fixture",
			tasks: [{ name: "SyntheticMaker", task: "Read-only fixture.", solutionSpace: SPACE, model: SELECTOR, ...(agent ? { agent } : {}) }],
		});
		for (const [spawns, agent] of [["maker", undefined], ["*", "maker"]] as const) {
			const label = agent ? "명시 maker(spawns *)" : "생략 agent(spawns maker)";
			const batchTool = await makeTool(spawns, true);
			const asked = await speculativeAsked(batchTool, batchArgs(agent));
			check(`TaskTool speculative ${label}: planSpawns 가 spawn 을 만든다`, asked >= 1, `asked=${asked}`);
			const batchResult = resultText(await batchTool.execute("call-batch", batchArgs(agent)));
			check(`TaskTool dispatch batch ${label}: preflight 가 같은 selector 를 받는다`, batchResult.includes(`${PREFLIGHT}${JSON.stringify(SELECTOR)}`), batchResult.slice(0, 200));
			const flatTool = await makeTool(spawns, false);
			const flatArgs = { task: "Read-only fixture.", solutionSpace: SPACE, model: SELECTOR, ...(agent ? { agent } : {}) };
			const flatResult = resultText(await flatTool.execute("call-flat", flatArgs));
			check(`TaskTool dispatch flat ${label}: preflight 가 같은 selector 를 받는다`, flatResult.includes(`${PREFLIGHT}${JSON.stringify(SELECTOR)}`), flatResult.slice(0, 200));
		}
		const otherTool = await makeTool("*", true);
		const otherArgs = { context: "Fixture", tasks: [{ name: "Other", agent: "explore", task: "Read-only fixture.", solutionSpace: SPACE, model: SELECTOR }] };
		const otherAsked = await speculativeAsked(otherTool, otherArgs);
		check("TaskTool speculative 다른 agent + model: spawn 을 만들지 않는다", otherAsked === 0, `asked=${otherAsked}`);
		const otherResult = resultText(await otherTool.execute("call-other", otherArgs));
		check("TaskTool dispatch 다른 agent + model: validator 가 거절한다", otherResult.includes("`model` is only accepted for the `seance` agent.") && !otherResult.includes(PREFLIGHT), otherResult.slice(0, 200));
	} finally {
		mock.restore();
		rmSync(cwd, { recursive: true, force: true });
	}
}

console.log(`결과 ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
