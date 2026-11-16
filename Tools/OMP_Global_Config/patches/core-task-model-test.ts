// task per-item model selector 패치 검증. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-task-model-test.ts
// 미패치 core에서는 model이 삭제돼 FAIL(RED), 패치 core에서는 PASS(GREEN).
// getTaskSchema wire 표면만 검증한다. executor 전달 한 줄과 preflight 전달은
// apply-core-patch.mjs --check(앵커 적용 여부)와 Main의 diff 검수로 본다.
// 동적 import 예외: 정적 import는 bun 전역 캐시의 미패치 사본으로 해석될 수 있다.
// 이 검사는 지정된 사본만 검증해야 하므로 디스크 경로를 고정한다.
import { mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
// The CUELO Maker passes one routed selector as the host model. Ordinary agents
// retain task.perCallModel gating, including after the 18.20.3 task API removal.
const PER_CALL_GATE = existsSync(`${CORE}/task/index.ts`) && readFileSync(`${CORE}/task/index.ts`, "utf8").includes("function spawnModelFields(");
const PER_CALL_OFF = "Per-call model is disabled for task calls";

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

// Wire declaration must not disappear when upstream gates task.perCallModel: Maker routing
// needs the selector advertised even though non-Maker execution still goes through preflight.
for (const batchEnabled of [true, false]) {
	for (const isolationEnabled of [true, false]) {
		for (const defaultAgent of ["task", "maker"]) {
			const schema = getTaskSchema({ batchEnabled, isolationEnabled, defaultAgent, perCallModel: false });
			const wire = schema.toJsonSchema() as {
				properties: Record<string, { type?: string; items?: { properties: Record<string, { type?: string }> } }>;
			};
			const model = batchEnabled ? wire.properties.tasks.items?.properties.model : wire.properties.model;
			check(`wire model with per-call disabled: ${defaultAgent}/${batchEnabled ? "batch" : "single"}/${isolationEnabled ? "iso" : "flat"}`,
				model?.type === "string", JSON.stringify(model));
		}
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


// Exercise the real planner and dispatch for #33 and #89. Stop at policy
// preflight, before a provider call; speculative launches are denied by the fixture.
{
	const actual = await import(`${CORE}/task/structured-subagent.ts`);
	const PREFLIGHT = "CUELO-TEST-PREFLIGHT model=";
	mock.module(`${CORE}/task/structured-subagent.ts`, () => ({
		...actual,
		resolveEffectiveSubagentPolicy: async (request: { model?: unknown; perCallModel?: unknown }) => {
			throw new Error(`${PREFLIGHT}${JSON.stringify(request.model ?? null)} perCallModel=${JSON.stringify(request.perCallModel ?? null)}`);
		},
	}));
	const { TaskTool } = await import(`${CORE}/task/index.ts`);
	const SELECTOR = "anthropic/claude-sonnet-5-5:auto";
	const cwd = mkdtempSync(join(tmpdir(), "cuelo-task-model-"));
	const settingValues: Record<string, unknown> = { "task.batch": true, "task.speculativeLaunch": true, "async.enabled": false };
	const makeTool = async (spawns: string, batch: boolean, steps = false, perCallModel = false) => {
		settingValues["task.steps"] = steps;
		settingValues["task.perCallModel"] = perCallModel ? "on" : "off";
		settingValues["task.isolation.enabled"] = true;
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
			const batchParsed = parse(getTaskSchema({ isolationEnabled: false, batchEnabled: true, defaultAgent: spawns === "maker" ? "maker" : "task", perCallModel: false }), batchArgs(agent));
			if (!batchParsed.ok) throw new Error(batchParsed.error);
			const batchResult = resultText(await batchTool.execute("call-batch", batchParsed.value));
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
		const otherParsed = parse(getTaskSchema({ isolationEnabled: false, batchEnabled: true, perCallModel: false }), otherArgs);
		if (!otherParsed.ok) throw new Error(otherParsed.error);
		const otherResult = resultText(await otherTool.execute("call-other", otherParsed.value));
		const refusal = PER_CALL_OFF;
		check("TaskTool dispatch 다른 agent + model: validator 가 거절한다", otherResult.includes(refusal) && !otherResult.includes(PREFLIGHT), otherResult.slice(0, 200));
		if (PER_CALL_GATE) {
			// 18.14.2+: Maker 의 잘못된 model 은 validateModel 의 CUELO 분기가, 다른 agent 의 model 은 upstream 게이트가 거절한다.
			for (const [label, model] of [["배열", [SELECTOR]], ["빈 문자열", "  "]] as const) {
				const bad = resultText(await otherTool.execute(`call-bad-${label}`, { context: "Fixture", tasks: [{ name: "SyntheticMaker", agent: "maker", task: "Read-only fixture.", solutionSpace: SPACE, model }] }));
				check(`TaskTool dispatch Maker model ${label}: 거절`, bad.includes("`maker` agent must be one non-empty selector string") && !bad.includes(PREFLIGHT), bad.slice(0, 200));
			}
			const flatOther = resultText(await (await makeTool("*", false)).execute("call-other-flat", { agent: "explore", task: "Read-only fixture.", solutionSpace: SPACE, model: SELECTOR }));
			check("TaskTool dispatch flat 다른 agent + model: 게이트가 거절한다", flatOther.includes(PER_CALL_OFF) && !flatOther.includes(PREFLIGHT), flatOther.slice(0, 200));
		}
		// #89 crosses wire validation and the real spawn boundary, including the
		// upstream steps shape (the CUELO profile keeps steps disabled).
		for (const batchEnabled of [false, true]) {
			for (const steps of [false, true]) {
				for (const isolated of [undefined, true, "capture"] as const) {
					for (const [spawns, agent] of [["maker", undefined], ["*", "maker"]] as const) {
						const item = {
							name: "MatrixMaker", solutionSpace: SPACE, model: SELECTOR,
							...(steps ? { steps: ["Read the fixture", "Return its result"] } : { task: "Read the fixture" }),
							...(agent ? { agent } : {}), ...(isolated === undefined ? {} : { isolated }),
						};
						const args = batchEnabled ? { context: "Fixture", tasks: [item] } : item;
						const schema = getTaskSchema({ batchEnabled, isolationEnabled: true, defaultAgent: spawns === "maker" ? "maker" : "task", steps, perCallModel: false });
						const parsed = parse(schema, args);
						const label = `${batchEnabled ? "batch" : "single"}/${steps ? "steps" : "task"}/${String(isolated)}/${agent ?? "default"}`;
						const value = parsed.ok ? parsed.value : undefined;
						const wireModel = batchEnabled ? firstTaskModel(value).model :
							value && typeof value === "object" && "model" in value ? value.model : undefined;
						check(`#89 wire ${label}: preserves one model`, parsed.ok && wireModel === SELECTOR, parsed.ok ? "" : parsed.error);
						if (!parsed.ok) continue;
						const tool = await makeTool(spawns, batchEnabled, steps);
						const output = resultText(await tool.execute(`matrix-${label}`, parsed.value));
						check(`#89 dispatch ${label}: Maker host model`, output.includes(`${PREFLIGHT}${JSON.stringify(SELECTOR)} perCallModel=null`), output.slice(0, 300));
					}
				}
			}
			const allowedTool = await makeTool("*", batchEnabled, false, true);
			const ordinary = { agent: "explore", task: "Read fixture", solutionSpace: SPACE, model: SELECTOR };
			const allowed = resultText(await allowedTool.execute("ordinary-allowed", batchEnabled ? { context: "Fixture", tasks: [ordinary] } : ordinary));
			check(`#89 ordinary selector enabled/${batchEnabled ? "batch" : "single"}: per-call model`, allowed.includes(`${PREFLIGHT}null perCallModel=${JSON.stringify(SELECTOR)}`), allowed.slice(0, 300));
			const invalidTool = await makeTool("maker", batchEnabled);
			for (const model of [null, 42, [SELECTOR], "", "   "]) {
				const item = { task: "Read fixture", solutionSpace: SPACE, model };
				const output = resultText(await invalidTool.execute("invalid-default-maker", batchEnabled ? { context: "Fixture", tasks: [item] } : item));
				check(`#89 default Maker invalid model ${JSON.stringify(model)}/${batchEnabled ? "batch" : "single"}`, output.includes("`maker` agent must be one non-empty selector string") && !output.includes(PREFLIGHT), output.slice(0, 300));
			}
		}
	} finally {
		mock.restore();
		rmSync(cwd, { recursive: true, force: true });
	}
}

console.log(`결과 ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
