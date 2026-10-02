// SubAgent 검증 지시 회귀: CUELO 계약은 "Maker가 자기 변경을 집중 검사로 증명하고 보고한다"이다
// (agent/sop/_writer.md, rule://subagent 「검증 소유권」). 18.4.12 upstream 은 subagent 프롬프트에서
// 검증 자체를 금지했다(system-prompt.md §5 Hand-off "NEVER verify your changes …", project-prompt.md
// "verification is main agent's job", subagent-system-prompt.md # Validation 삭제). patch 는 그 금지를
// CUELO 계약으로 되돌린다: 프로젝트 전체 빌드·포매터·린터·전체 스위트는 형제와 작업 트리를 공유할 때만
// 금지하고(18.4.10 과 같은 `{{#unless worktree}}`), 집중 증명 실행·보고와 못 돌린 검사의 exact command 는
// worktree 여부와 관계없이 모든 subagent 에 요구한다. main 세션 렌더는 upstream 그대로다.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-subagent-verify-test.ts
// 미패치 18.4.12 에서는 [1][2] FAIL(RED), 패치 core 에서는 전부 PASS(GREEN).
// 실제 runSubprocess 로 자식 세션을 만들고, 자식에 preload 한 확장이 session_start 에서 본 system prompt
// (모델이 받는 블록 전체)를 기록한 뒤 첫 provider 호출 전에 abort 한다. 모델 호출·설치본·실제 프로필은 건드리지 않는다.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// SDK DB 핸들이 열린 자식에서 지우지 않고, 종료를 기다린 부모가 이 실행의 fixture만 지운다.
if (!process.env.OMP_VERIFY_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-subagent-verify-"));
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
				OMP_VERIFY_FIXTURE_ROOT: root,
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
const fixtureRoot = process.env.OMP_VERIFY_FIXTURE_ROOT!;
console.log(`대상 ${CORE}`);

// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET so the test never imports the live installation.
const { setAgentDir } = await import(`${PACKAGES}/pi-utils/src/dirs.ts`);
setAgentDir(join(fixtureRoot, "home", ".omp", "agent"));
const { runSubprocess } = await import(`${CORE}/task/executor.ts`);
const { buildSystemPrompt } = await import(`${CORE}/system-prompt.ts`);
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

/** Spawn a real subagent and return the system prompt its session would send to the model. */
async function childSystemPrompt(name: string, worktree: boolean): Promise<string | undefined> {
	const root = mkdtempSync(join(fixtureRoot, `${name}-`));
	const work = join(root, "work");
	mkdirSync(work);
	const out = join(root, "system-prompt.json");
	const extension = join(root, "probe-extension.ts");
	writeFileSync(
		extension,
		`import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.on("session_start", (_event, ctx) => writeFileSync(${JSON.stringify(out)}, JSON.stringify(ctx.getSystemPrompt())));
}
`,
	);
	const recorded = (): string | undefined => {
		if (!existsSync(out)) return undefined;
		return (JSON.parse(readFileSync(out, "utf8")) as string[]).join("\n\n");
	};
	const controller = new AbortController();
	await runSubprocess({
		cwd: work,
		...(worktree ? { worktree: work } : {}),
		agent: { name: "maker", description: "verify probe", systemPrompt: "verify probe", tools: ["read", "bash"], model: "openai/gpt-4o-mini", source: "project" },
		task: "verify probe",
		index: 0,
		id: `VerifyProbe-${name}`,
		settings: Settings.isolated({}),
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

// 문구가 아니라 지시의 의미를 본다: 금지·요구 대상과 조건이 같은 줄에 있는지만 확인한다.
const FORBIDS_ALL_VERIFICATION = /NEVER (verify your changes|run it yourself)/i;
const FORBIDS_PROJECT_WIDE = /NEVER run[^\n]*(formatters|linters)[^\n]*(project-wide|full)[^\n]*unless your assignment explicitly instructs it/i;
const REQUIRES_SCOPED_PROOF = /scoped (proof|check)[^\n]*(required|is yours|run it|MUST)/i;
const REPORTS_EXIT_STATUS = /exit status/i;
const HANDS_OFF_EXACT_COMMAND = /exact command[^\n]*main agent|main agent[^\n]*exact command/i;
const REQUIRES_SMOKE = /NEVER yield without a smoke run/;

function expectSubagentContract(prompt: string | undefined, label: string): void {
	check(`${label}: 자식 세션 system prompt 가 기록됐다`, prompt !== undefined);
	const text = prompt ?? "";
	check(`${label}: 검증 전체 금지(upstream Hand-off) 지시가 없다`, !FORBIDS_ALL_VERIFICATION.test(text), text.match(FORBIDS_ALL_VERIFICATION)?.[0]);
	check(`${label}: 변경 경로를 직접 실행하는 smoke 요구가 있다`, REQUIRES_SMOKE.test(text));
	check(`${label}: 자기 변경의 집중 증명을 실행해야 한다`, REQUIRES_SCOPED_PROOF.test(text));
	check(`${label}: 검사 결과(exit status)를 보고한다`, REPORTS_EXIT_STATUS.test(text));
	check(`${label}: 못 돌린 검사는 Main용 exact command 로 넘긴다`, HANDS_OFF_EXACT_COMMAND.test(text));
}

console.log("[1] 작업 트리를 공유하는 subagent: 집중 증명은 요구, 프로젝트 전체 검사만 금지");
{
	const prompt = await childSystemPrompt("shared-tree", false);
	expectSubagentContract(prompt, "shared");
	check("shared: 프로젝트 전체 빌드·포매터·린터·전체 스위트는 배정 없이는 금지", FORBIDS_PROJECT_WIDE.test(prompt ?? ""));
}

console.log("[2] 격리 worktree subagent: 집중 증명 요구는 같고 형제 경합 금지는 없다");
{
	const prompt = await childSystemPrompt("isolated-tree", true);
	expectSubagentContract(prompt, "worktree");
	check("worktree: 형제 경합 이유의 전체 검사 금지가 렌더되지 않는다", !FORBIDS_PROJECT_WIDE.test(prompt ?? ""), prompt?.match(FORBIDS_PROJECT_WIDE)?.[0]);
}

console.log("[3] main 세션 렌더는 upstream 그대로다");
{
	const { systemPrompt } = await buildSystemPrompt({ cwd: fixtureRoot });
	const text = (systemPrompt as string[]).join("\n\n");
	check("main: Verify 절과 smoke 요구가 있다", /# 5\. Verify/.test(text) && REQUIRES_SMOKE.test(text));
	check("main: 행동 변경 검증 의무가 있다", /Before yielding, MUST verify significant behavioral changes/.test(text));
	check("main: subagent 전용 지시가 섞이지 않는다", !REQUIRES_SCOPED_PROOF.test(text) && !HANDS_OFF_EXACT_COMMAND.test(text) && !/# 5\. Hand-off/.test(text));
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
