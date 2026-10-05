// task schema agent 생략 보존 패치 검증. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-task-agent-test.ts
// 미패치 core에서는 생략한 agent가 'task'로 채워져 FAIL(RED), 패치 core에서는 PASS(GREEN).
// extension tool_call hook은 이 schema 검증을 거친 입력을 받으므로(pi-agent-core agent-loop validate →
// beforeToolCall) 여기서 생략이 undefined로 남아야 CUELO guard가 생략과 명시 `task`를 구별한다.
// executor의 생략 처리(task/index.ts spawnParamsFor `item.agent?.trim() || defaultAgent`)는 이 패치가
// 건드리지 않으므로 비-CUELO 프로필의 기본 agent 의미는 그대로다.
// 동적 import 예외: 정적 import는 bun 전역 캐시의 미패치 사본으로 해석될 수 있다.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(p => existsSync(join(p, "src/task/types.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
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

function parse(schema: unknown, data: unknown): Record<string, unknown> | undefined {
	const value = (schema as (input: unknown) => unknown)(data);
	const name = (value as { constructor?: { name?: string } } | null)?.constructor?.name ?? "";
	if (name.endsWith("Errors")) return undefined;
	return value as Record<string, unknown>;
}

const SPACE = "one fix: keep omitted agent";
const itemOf = (value: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
	if (!value) return undefined;
	const tasks = value.tasks;
	return Array.isArray(tasks) ? (tasks[0] as Record<string, unknown>) : value;
};

const shapes = [
	{ label: "static batch flat", options: { isolationEnabled: false, batchEnabled: true } },
	{ label: "static batch isolation", options: { isolationEnabled: true, batchEnabled: true } },
	{ label: "static single flat", options: { isolationEnabled: false, batchEnabled: false } },
	{ label: "static single isolation", options: { isolationEnabled: true, batchEnabled: false } },
	{ label: "dynamic batch flat", options: { isolationEnabled: false, batchEnabled: true, defaultAgent: "maker" } },
	{ label: "dynamic batch isolation", options: { isolationEnabled: true, batchEnabled: true, defaultAgent: "maker" } },
	{ label: "dynamic single flat", options: { isolationEnabled: false, batchEnabled: false, defaultAgent: "maker" } },
	{ label: "dynamic single isolation", options: { isolationEnabled: true, batchEnabled: false, defaultAgent: "maker" } },
	{ label: "effort batch flat", options: { isolationEnabled: false, batchEnabled: true, effortEnabled: true } },
];

for (const { label, options } of shapes) {
	const schema = getTaskSchema(options);
	const wrap = (item: Record<string, unknown>) => (options.batchEnabled ? { context: "ctx", tasks: [item] } : item);
	const omitted = itemOf(parse(schema, wrap({ task: "do", solutionSpace: SPACE })));
	check(`${label}: 생략한 agent가 undefined로 남는다`, omitted !== undefined && !("agent" in omitted), JSON.stringify(omitted));
	for (const agent of ["task", "scout", "maker"]) {
		const kept = itemOf(parse(schema, wrap({ agent, task: "do", solutionSpace: SPACE })));
		check(`${label}: 명시한 agent '${agent}' 보존`, kept?.agent === agent, JSON.stringify(kept));
	}
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
