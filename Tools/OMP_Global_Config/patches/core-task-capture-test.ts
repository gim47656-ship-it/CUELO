// task `isolated: "capture"` 패치 검증. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-task-capture-test.ts
// 미패치 core 에서는 schema 가 "capture" 를 거절하고 runner 가 apply 를 받지 못해 FAIL(RED), 패치 core 에서는 PASS(GREEN).
// 두 가지를 본다. (1) getTaskSchema 의 wire 표면이 `isolated` 에 true·false·"capture" 만 받는다. (2) 실제 TaskTool 이 spawn 을 만들 때
// preflight 와 runStructuredSubagent 요청의 `isolation` 이 capture 는 { requested: true, apply: false }, true·false 는 기존 그대로
// { requested: <값> }(apply 키 없음 = 전역 task.isolation.apply 를 따른다)인지. batch item 의 isolated 가 최상위를 이기는 것도 포함한다.
// structured-subagent 를 mock 으로 바꿔 요청만 받으므로 child 도 worktree 도 만들지 않는다. 격리 worktree 안의 patch 보존과
// 부모 결과의 patch 경로 출력은 upstream 의 apply=false 경로(describeCapturedChanges)가 이미 맡는다.
// 동적 import 예외: 정적 import는 bun 전역 캐시의 미패치 사본으로 해석될 수 있다. 이 검사는 지정된 사본만 검증해야 하므로 디스크 경로를 고정한다.
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

const SPACE = "one fix: capture isolation";

function parse(schema: unknown, data: unknown): { ok: boolean; value?: Record<string, unknown> } {
	const value = (schema as (input: unknown) => unknown)(data) as { constructor?: { name?: string } } | null;
	// arktype 계열 스키마는 실패 시 throw 가 아니라 errors 인스턴스를 돌려준다(core 전체 관례).
	if (value?.constructor?.name?.endsWith("Errors")) return { ok: false };
	return { ok: true, value: value as Record<string, unknown> };
}

// 1. schema wire 표면: isolation 이 켜진 네 모양(정적·동적 × batch·단일)이 "capture" 를 보존하고, 모르는 문자열은 거절한다.
const shapes = [
	{ label: "static batch", options: { isolationEnabled: true, batchEnabled: true } },
	{ label: "static single", options: { isolationEnabled: true, batchEnabled: false } },
	{ label: "dynamic batch", options: { isolationEnabled: true, batchEnabled: true, defaultAgent: "maker" } },
	{ label: "dynamic single", options: { isolationEnabled: true, batchEnabled: false, defaultAgent: "maker" } },
];
for (const { label, options } of shapes) {
	const schema = getTaskSchema(options);
	const wrap = (isolated: unknown) => {
		const item = { task: "do", solutionSpace: SPACE, ...(isolated === undefined ? {} : { isolated }) };
		return options.batchEnabled ? { context: "ctx", tasks: [item] } : item;
	};
	const isolatedOf = (value: Record<string, unknown> | undefined): unknown => {
		const item = options.batchEnabled ? (value?.tasks as Array<Record<string, unknown>> | undefined)?.[0] : value;
		return item && "isolated" in item ? item.isolated : "(absent)";
	};
	for (const accepted of [true, false, "capture"]) {
		const parsed = parse(schema, wrap(accepted));
		check(`${label}: isolated ${JSON.stringify(accepted)} 보존`, parsed.ok && isolatedOf(parsed.value) === accepted);
	}
	check(`${label}: isolated 생략 시 부재`, isolatedOf(parse(schema, wrap(undefined)).value) === "(absent)");
	check(`${label}: 모르는 isolated 문자열 거절`, !parse(schema, wrap("apply")).ok);
	check(`${label}: 숫자 isolated 거절`, !parse(schema, wrap(1)).ok);
}

// 2. 실제 TaskTool 이 만드는 isolation 요청. structured-subagent 의 preflight·runner 만 mock 으로 바꿔 받은 요청을 기록한다.
type IsolationRequest = { requested?: unknown; apply?: unknown; merge?: unknown } | undefined;
const preflightSeen: IsolationRequest[] = [];
const runnerSeen: IsolationRequest[] = [];
const actual = await import(`${CORE}/task/structured-subagent.ts`);
const fakePolicy = { effectiveAgent: { blocking: true }, discovery: { projectAgentsDir: null } };
mock.module(`${CORE}/task/structured-subagent.ts`, () => ({
	...actual,
	resolveEffectiveSubagentPolicy: async (request: { isolation?: IsolationRequest }) => {
		preflightSeen.push(request.isolation);
		return fakePolicy;
	},
	runStructuredSubagent: async (request: { isolation?: IsolationRequest; identity?: { label?: string } }) => {
		runnerSeen.push(request.isolation);
		return {
			result: {
				index: 0,
				id: request.identity?.label ?? "CaptureProbe",
				agent: "maker",
				agentSource: "bundled",
				task: "fixture",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			},
			policy: fakePolicy,
			mergeSummary: "",
			changesApplied: false,
		};
	},
}));
const { TaskTool } = await import(`${CORE}/task/index.ts`);
const cwd = mkdtempSync(join(tmpdir(), "cuelo-task-capture-"));
const settingValues: Record<string, unknown> = { "task.batch": true, "async.enabled": false, "task.isolation.enabled": true };
const makeTool = async (batch: boolean) => {
	settingValues["task.batch"] = batch;
	const session = {
		cwd,
		settings: createSettingsTestScope(key => settingValues[key]),
		getSessionSpawns: () => "*",
		getPlanModeState: () => undefined,
		taskDepth: 0,
		suppressSpawnAdvisory: true,
	};
	return TaskTool.create(session as never);
};

/** 한 번 실행하고 spawn 마다 기록된 isolation 요청(preflight, runner)을 돌려준다. */
async function run(batch: boolean, args: Record<string, unknown>): Promise<{ preflight: IsolationRequest[]; runner: IsolationRequest[] }> {
	preflightSeen.length = 0;
	runnerSeen.length = 0;
	const tool = await makeTool(batch);
	await tool.execute("call-capture", args);
	return { preflight: [...preflightSeen], runner: [...runnerSeen] };
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const CAPTURE = { requested: true, apply: false };

try {
	// 2-1. 단일(flat) 호출: 최상위 isolated 가 그대로 spawn 으로 간다.
	for (const [label, isolated, expected] of [
		['"capture"', "capture", CAPTURE],
		["true", true, { requested: true }],
		["false", false, { requested: false }],
		["생략", undefined, undefined],
	] as const) {
		const args = { task: "do", solutionSpace: SPACE, ...(isolated === undefined ? {} : { isolated }) };
		const seen = await run(false, args);
		check(`flat isolated ${label}: preflight 요청`, seen.preflight.length === 1 && same(seen.preflight[0], expected), JSON.stringify(seen.preflight));
		check(`flat isolated ${label}: runner 요청`, seen.runner.length === 1 && same(seen.runner[0], expected), JSON.stringify(seen.runner));
	}

	// 2-2. batch: 후보 둘이 각자 capture 로 나가고, 같은 호출의 true 항목은 apply 를 건드리지 않는다.
	const candidates = await run(true, {
		context: "ctx",
		tasks: [
			{ name: "CandidateA", task: "do", solutionSpace: SPACE, isolated: "capture" },
			{ name: "CandidateB", task: "do", solutionSpace: SPACE, isolated: "capture" },
		],
	});
	check("batch 후보 둘: 둘 다 runner 에서 apply=false", candidates.runner.length === 2 && candidates.runner.every(request => same(request, CAPTURE)), JSON.stringify(candidates.runner));
	check("batch 후보 둘: 둘 다 preflight 에서 apply=false", candidates.preflight.length === 2 && candidates.preflight.every(request => same(request, CAPTURE)), JSON.stringify(candidates.preflight));
	const mixed = await run(true, {
		context: "ctx",
		tasks: [
			{ name: "Captured", task: "do", solutionSpace: SPACE, isolated: "capture" },
			{ name: "Applied", task: "do", solutionSpace: SPACE, isolated: true },
			{ name: "Shared", task: "do", solutionSpace: SPACE },
		],
	});
	// spawn 완료 순서는 보장하지 않으므로 직렬화한 값을 정렬해 비교한다.
	const sorted = (requests: IsolationRequest[]) => requests.map(request => JSON.stringify(request ?? null)).sort();
	check(
		"batch 혼합: capture 만 apply=false, true 는 기존 그대로, 생략은 isolation 없음",
		same(sorted(mixed.runner), sorted([CAPTURE, { requested: true }, undefined])),
		JSON.stringify(mixed.runner),
	);
} finally {
	mock.restore();
	rmSync(cwd, { recursive: true, force: true });
}

console.log(`결과 ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
