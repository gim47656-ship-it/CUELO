// task per-item model selector 패치 검증. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-task-model-test.ts
// 미패치 core에서는 model이 삭제돼 FAIL(RED), 패치 core에서는 PASS(GREEN).
// getTaskSchema wire 표면만 검증한다. executor 전달 한 줄과 preflight 전달은
// apply-core-patch.mjs --check(앵커 적용 여부)와 Main의 diff 검수로 본다.
// 동적 import 예외: 정적 import는 bun 전역 캐시의 미패치 사본으로 해석될 수 있다.
// 이 검사는 지정된 사본만 검증해야 하므로 디스크 경로를 고정한다.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 전역 npm 위치는 PC마다 다르다. apply-core-patch.mjs 와 같은 순서로 찾는다. */
function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
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

// 1. batch flat(static): model 보존, 생략 시 부재.
{
	const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
	const kept = parse(schema, { context: "ctx", tasks: [{ task: "do", model: MODEL }] });
	const keptModel = kept.ok ? firstTaskModel(kept.value) : { found: false, model: undefined };
	check("batch flat: model 보존", kept.ok && keptModel.found && keptModel.model === MODEL);
	const omitted = parse(schema, { context: "ctx", tasks: [{ task: "do" }] });
	check("batch flat: 생략 시 부재", omitted.ok && !firstTaskModel(omitted.value).found);
}

// 2. batch isolation(static): model 보존.
{
	const schema = getTaskSchema({ isolationEnabled: true, batchEnabled: true });
	const kept = parse(schema, { context: "ctx", tasks: [{ task: "do", model: MODEL }] });
	const keptModel = kept.ok ? firstTaskModel(kept.value) : { found: false, model: undefined };
	check("batch isolation: model 보존", kept.ok && keptModel.found && keptModel.model === MODEL);
}

// 3. dynamic schema(defaultAgent 변경): iso + flat 모두 model 보존.
{
	for (const isolationEnabled of [true, false]) {
		const schema = getTaskSchema({ isolationEnabled, batchEnabled: true, defaultAgent: "maker" });
		const kept = parse(schema, { context: "ctx", tasks: [{ task: "do", model: MODEL }] });
		const keptModel = kept.ok ? firstTaskModel(kept.value) : { found: false, model: undefined };
		check(`dynamic ${isolationEnabled ? "iso" : "flat"}: model 보존`, kept.ok && keptModel.found && keptModel.model === MODEL);
	}
}

// 4. single flat: 최상위 model 보존, 생략 시 부재.
{
	const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false });
	const kept = parse(schema, { task: "do", model: MODEL });
	let found = false;
	let model: unknown;
	if (kept.ok && kept.value && typeof kept.value === "object" && "model" in kept.value) {
		found = true;
		model = kept.value.model;
	}
	check("single flat: model 보존", kept.ok && found && model === MODEL);
	const omitted = parse(schema, { task: "do" });
	const omittedHas =
		omitted.ok && omitted.value && typeof omitted.value === "object" && "model" in omitted.value;
	check("single flat: 생략 시 부재", omitted.ok && !omittedHas);
}

// 5. delete 유지: 미지 키는 여전히 삭제된다.
{
	const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
	const parsed = parse(schema, { context: "ctx", tasks: [{ task: "do", model: MODEL, nope: 1 }] });
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
	const offParsed = parse(off, { context: "ctx", tasks: [{ task: "do", effort: "lo" }] });
	let offHas = false;
	if (offParsed.ok && offParsed.value && typeof offParsed.value === "object" && "tasks" in offParsed.value) {
		const tasks = offParsed.value.tasks;
		offHas =
			Array.isArray(tasks) && tasks.length > 0 && !!tasks[0] && typeof tasks[0] === "object" && "effort" in tasks[0];
	}
	check("effort 게이트 불변: off면 삭제", offParsed.ok && !offHas);
	const on = getTaskSchema({ isolationEnabled: false, batchEnabled: true, effortEnabled: true });
	const onParsed = parse(on, { context: "ctx", tasks: [{ task: "do", effort: "lo", model: MODEL }] });
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
	const bad = parse(schema, { context: "ctx", tasks: [{ task: "do", model: 123 }] });
	check("타입 거부: model 비문자열 실패", !bad.ok, bad.ok ? "파싱됨" : "");
}

console.log(`결과 ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
