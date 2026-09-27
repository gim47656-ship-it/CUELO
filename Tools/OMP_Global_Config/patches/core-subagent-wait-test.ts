// SubAgent `wait` 부여 회귀: CUELO 는 Main 전용 wait 계약이다(harness-policy mainLane.waitContract).
// 18.3.3 upstream 은 `task`·`bash` 를 가진 SubAgent 정의에 `wait` 를 자동으로 더한다. patch 는 그 자동
// 확장만 막고, agent 정의가 `wait` 를 직접 적은 경우는 그대로 준다.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-subagent-wait-test.ts
// 실제 runSubprocess 로 자식 세션을 만들고, 자식에 preload 한 확장이 session_start 에서 본 active tool
// 목록을 기록한 뒤 첫 provider 호출 전에 abort 한다. 모델 호출·설치본·실제 프로필은 건드리지 않는다.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// SDK DB 핸들이 열린 자식에서 지우지 않고, 종료를 기다린 부모가 이 실행의 fixture만 지운다.
if (!process.env.OMP_WAIT_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-subagent-wait-"));
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
				OMP_WAIT_FIXTURE_ROOT: root,
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
const fixtureRoot = process.env.OMP_WAIT_FIXTURE_ROOT!;

// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET so the test never imports the live installation.
const { setAgentDir } = await import(`${PACKAGES}/pi-utils/src/dirs.ts`);
setAgentDir(join(fixtureRoot, "home", ".omp", "agent"));
const { runSubprocess } = await import(`${CORE}/task/executor.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
// 임시 agentDir 의 모델 preflight 만 통과시키는 비밀 아닌 placeholder. 첫 provider 호출 전에 abort 한다.
process.env.OPENAI_API_KEY = "<probe>";

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

/** Spawn a real subagent with `tools` and return the child's active tool names at session start. */
async function childTools(name: string, tools: string[]): Promise<string[] | undefined> {
	const root = mkdtempSync(join(fixtureRoot, `${name}-`));
	const work = join(root, "work");
	mkdirSync(work);
	const out = join(root, "tools.json");
	const extension = join(root, "probe-extension.ts");
	writeFileSync(
		extension,
		`import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.on("session_start", () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(pi.getActiveTools())));
}
`,
	);
	const recorded = (): string[] | undefined => {
		if (!existsSync(out)) return undefined;
		return JSON.parse(readFileSync(out, "utf8")) as string[];
	};
	const controller = new AbortController();
	// A wake source (`async.enabled`) is on, so a missing `wait` can only come from the tool list itself.
	const settings = Settings.isolated({ "async.enabled": true });
	await runSubprocess({
		cwd: work,
		agent: { name: "maker", description: "wait probe", systemPrompt: "wait probe", tools, model: "openai/gpt-4o-mini", source: "project" },
		task: "wait probe",
		index: 0,
		id: `WaitProbe-${name}`,
		settings,
		getApiKey: () => "example",
		preloadedExtensionPaths: [extension],
		enableMCP: false,
		enableLsp: false,
		signal: controller.signal,
		onProgress: () => {
			if (recorded()) controller.abort();
		},
	}).catch(() => undefined);
	controller.abort();
	return recorded();
}

console.log("[1] bash 를 가진 SubAgent 정의는 wait 를 자동으로 받지 않는다");
{
	const tools = await childTools("bash-only", ["read", "bash"]);
	check("자식 세션이 만들어져 tool 목록이 기록됐다", tools !== undefined);
	check("bash 는 그대로 있다", tools?.includes("bash") === true, JSON.stringify(tools));
	check("wait 가 자동으로 붙지 않는다", tools !== undefined && !tools.includes("wait"), JSON.stringify(tools));
}

console.log("[2] 정의가 wait 를 직접 적으면 그대로 받는다(명시 요청 경로 보존)");
{
	const tools = await childTools("explicit-wait", ["read", "bash", "wait"]);
	check("명시한 wait 가 자식 세션에 있다", tools?.includes("wait") === true, JSON.stringify(tools));
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
