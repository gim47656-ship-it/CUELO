// Claude Code Maker 엔진 선택 회귀: 브리프의 `ENGINE: claude-code` 줄로만 켜지는 발주별 opt-in이다.
// 기능 스위치(CUELO_MAKER_ENGINES=claude + 절대 CUELO_RUNTIME_DIR)가 켜져 있어도 표시 없는 발주와 캐릭터 소환은
// 기존 OMP 경로를 탄다. 옛 판은 env만 켜면 anthropic Maker 전부(소환 포함)를 외부 엔진으로 보냈다.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-claude-maker-test.ts
// 실제 runSubprocess 로 자식을 만든다. 외부 경로는 fixture runtime(모델 호출 없음)이 받고, OMP 경로는 preload 확장이
// session_start 를 기록한 뒤 첫 provider 호출 전에 abort 한다. 설치본·실제 프로필·Claude Code 는 건드리지 않는다.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (!process.env.OMP_CLAUDE_MAKER_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-claude-maker-"));
	const home = join(root, "home");
	const temp = join(root, "temp");
	mkdirSync(home);
	mkdirSync(temp);
	let exitCode = 1;
	try {
		const child = Bun.spawnSync([process.execPath, import.meta.path], {
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				TEMP: temp,
				TMP: temp,
				TMPDIR: temp,
				PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_CLAUDE_MAKER_FIXTURE_ROOT: root,
			},
			stdout: "inherit",
			stderr: "inherit",
		});
		exitCode = child.exitCode ?? 1;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	process.exit(exitCode);
}

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live core");
const CORE = resolve(target, "src").replace(/\\/g, "/");
if (!existsSync(join(CORE, "task/executor.ts"))) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
const PACKAGES = resolve(dirname(CORE), "..").replace(/\\/g, "/");
const fixtureRoot = process.env.OMP_CLAUDE_MAKER_FIXTURE_ROOT!;

// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET so the test never imports the live installation.
const { setAgentDir } = await import(`${PACKAGES}/pi-utils/src/dirs.ts`);
setAgentDir(join(fixtureRoot, "home", ".omp", "agent"));
const { runSubprocess } = await import(`${CORE}/task/executor.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
// 임시 agentDir 의 모델 preflight 만 통과시키는 비밀 아닌 placeholder. 첫 provider 호출 전에 abort 한다.
process.env.ANTHROPIC_API_KEY = "<probe>";

// fixture runtime: createSession 인자를 기록하고 모델 호출 없이 한 턴을 끝낸다.
const runtimeDir = join(fixtureRoot, "runtime");
mkdirSync(runtimeDir);
const runtimeLog = join(fixtureRoot, "runtime-calls.jsonl");
writeFileSync(
	join(runtimeDir, "index.ts"),
	`import { appendFileSync } from "node:fs";
export async function getRuntime(engine) {
	return {
		engine,
		async createSession(options) {
			const router = typeof options.createGatewayRouter === "function" ? options.createGatewayRouter() : undefined;
			const listeners = new Set();
			const emit = event => { for (const listener of listeners) listener(event); };
			let prompted;
			return {
				id: "fixture-session",
				engine,
				onEvent(handler) { listeners.add(handler); return () => listeners.delete(handler); },
				async prompt(message) {
					prompted = message;
					appendFileSync(${JSON.stringify(runtimeLog)}, JSON.stringify({
						engine,
						model: options.model,
						assignment: options.assignment,
						prompt: prompted,
						hasSystemPrompt: typeof options.systemPrompt === "string" && options.systemPrompt.includes("maker probe"),
						hasEnv: typeof options.env === "object" && options.env !== null,
						agentDir: options.agentDir,
						hasRouter: typeof router?.route === "function",
					}) + "\\n");
					emit({ type: "session_started", sessionId: "fixture-session", engine });
					emit({ type: "text_delta", text: "fixture report" });
					emit({ type: "turn_completed", stopReason: "stop", text: "fixture report" });
				},
				async abort() {},
				async dispose() { router?.close(); },
			};
		},
	};
}
`,
);

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

interface Outcome {
	path: "omp" | "external" | "none";
	call?: Record<string, unknown>;
	output?: string;
}

/** Run one real maker subagent and report which engine took it. */
async function dispatch(name: string, task: string, env: Record<string, string | undefined>): Promise<Outcome> {
	const root = mkdtempSync(join(fixtureRoot, `${name}-`));
	const work = join(root, "work");
	mkdirSync(work);
	const ompMarker = join(root, "omp-session-start");
	const extension = join(root, "probe-extension.ts");
	writeFileSync(
		extension,
		`import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.on("session_start", () => writeFileSync(${JSON.stringify(ompMarker)}, "1"));
}
`,
	);
	const saved = { engines: process.env.CUELO_MAKER_ENGINES, dir: process.env.CUELO_RUNTIME_DIR };
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(runtimeLog, { force: true });
	const controller = new AbortController();
	let output: string | undefined;
	try {
		const result = await runSubprocess({
			cwd: work,
			agent: {
				name: "maker",
				description: "claude maker probe",
				systemPrompt: "maker probe",
				tools: ["read", "bash"],
				model: "anthropic/claude-opus-5-5",
				source: "project",
			},
			task,
			index: 0,
			id: `ClaudeMakerProbe-${name}`,
			settings: Settings.isolated({}),
			getApiKey: () => "example",
			preloadedExtensionPaths: [extension],
			enableMCP: false,
			enableLsp: false,
			signal: controller.signal,
			onProgress: () => {
				if (existsSync(ompMarker)) controller.abort();
			},
		}).catch(() => undefined);
		output = result?.output;
	} finally {
		controller.abort();
		if (saved.engines === undefined) delete process.env.CUELO_MAKER_ENGINES;
		else process.env.CUELO_MAKER_ENGINES = saved.engines;
		if (saved.dir === undefined) delete process.env.CUELO_RUNTIME_DIR;
		else process.env.CUELO_RUNTIME_DIR = saved.dir;
	}
	const call = existsSync(runtimeLog)
		? (JSON.parse(readFileSync(runtimeLog, "utf8").trim().split("\n")[0]) as Record<string, unknown>)
		: undefined;
	const path = call ? "external" : existsSync(ompMarker) ? "omp" : "none";
	return { path, call, output };
}

const ON = { CUELO_MAKER_ENGINES: "claude", CUELO_RUNTIME_DIR: runtimeDir };
const OFF = { CUELO_MAKER_ENGINES: undefined, CUELO_RUNTIME_DIR: undefined };
const OPT_IN = "ENGINE: claude-code\nOWNED_PATHS: notes/\n\nwrite notes/hello.txt";

console.log("[1] 기능 on 이어도 ENGINE 표시가 없는 발주는 OMP 경로");
{
	const outcome = await dispatch("no-marker", "OWNED_PATHS: notes/\n\nwrite notes/hello.txt", ON);
	check("OMP 세션이 시작됐다", outcome.path === "omp", outcome.path);
}

console.log("[2] 기능 on + `ENGINE: claude-code` 발주는 Claude Code 엔진");
{
	const outcome = await dispatch("opt-in", OPT_IN, ON);
	check("외부 런타임이 받았다", outcome.path === "external", outcome.path);
	check("해석된 모델 id 를 넘겼다", outcome.call?.model === "claude-opus-5-5", JSON.stringify(outcome.call?.model));
	check("브리프 원문을 assignment 로 넘겼다", outcome.call?.assignment === OPT_IN, JSON.stringify(outcome.call?.assignment));
	check("user turn 은 브리프 원문이다", outcome.call?.prompt === OPT_IN, JSON.stringify(outcome.call?.prompt));
	check("maker SOP 를 system prompt 로 넘겼다", outcome.call?.hasSystemPrompt === true);
	check("자식 env·agentDir·gateway router 를 넘겼다", outcome.call?.hasEnv === true && typeof outcome.call?.agentDir === "string" && outcome.call?.hasRouter === true, JSON.stringify(outcome.call));
	check("결과가 외부 엔진 표시와 보고 본문을 담는다", outcome.output?.includes("[external-engine: claude]") === true && outcome.output.includes("fixture report"), JSON.stringify(outcome.output));
}

console.log("[3] 캐릭터 소환은 ENGINE 표시가 있어도 항상 OMP 경로");
{
	const outcome = await dispatch("summon", `[character-summon alias="RIN(린)" model="anthropic/claude-opus-5-5" oauth-position="0"]\n${OPT_IN}`, ON);
	check("OMP 세션이 시작됐다", outcome.path === "omp", outcome.path);
}

console.log("[4] 기능 off(기본)면 ENGINE 표시가 있어도 OMP 경로");
{
	const outcome = await dispatch("feature-off", OPT_IN, OFF);
	check("OMP 세션이 시작됐다", outcome.path === "omp", outcome.path);
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
