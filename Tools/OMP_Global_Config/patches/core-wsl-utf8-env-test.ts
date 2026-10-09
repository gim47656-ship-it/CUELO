// WSL wsl.exe UTF-8 env default core patch regression (2026-10-09 WSL 회귀 감사 3.3).
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core>/pi-coding-agent bun run patches/core-wsl-utf8-env-test.ts
// buildNonInteractiveEnv 의 플랫폼·env 경계는 인자로 직접 검사한다. 실제 bash 도구 경로(executeBash → native 셸 →
// wsl.exe)는 WSL 에서 wsl.exe 가 있을 때만 돌고, 임시 HOME 의 별도 프로세스라 라이브 프로필·설정은 건드리지 않는다.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

function resolveCore(): string {
	const override = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = override
		? [override]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(candidate => existsSync(join(candidate, "src/exec/non-interactive-env.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
// The core copy is chosen at runtime (OMP_CORE_PATCH_TARGET or the installed core), so this import cannot be static.
const { buildNonInteractiveEnv, NON_INTERACTIVE_ENV } = await import(`${CORE}/exec/non-interactive-env.ts`);

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

const WSL = { WSL_DISTRO_NAME: "Ubuntu-24.04" };
const shown = (env: Record<string, string>) => JSON.stringify({ WSL_UTF8: env.WSL_UTF8, WSLENV: env.WSLENV });

console.log("WSL: wsl.exe 가 UTF-8 로 쓰도록 WSL_UTF8 을 WSLENV 로 넘긴다");
{
	const env = buildNonInteractiveEnv(undefined, WSL, "linux");
	check("WSL_UTF8=1 과 WSLENV=WSL_UTF8 이 붙는다", env.WSL_UTF8 === "1" && env.WSLENV === "WSL_UTF8", shown(env));
	check(
		"비대화 기본값은 그대로이고 두 값만 늘어난다",
		isDeepStrictEqual(env, { ...NON_INTERACTIVE_ENV, WSL_UTF8: "1", WSLENV: "WSL_UTF8" }),
		`keys=${Object.keys(env).length}`,
	);
	const shared = buildNonInteractiveEnv(undefined, { ...WSL, WSLENV: "WT_SESSION:WT_PROFILE_ID/up:" }, "linux");
	check("서버의 WSLENV 항목은 남기고 WSL_UTF8 만 덧붙인다", shared.WSLENV === "WT_SESSION:WT_PROFILE_ID/up:WSL_UTF8", shown(shared));
	const listed = buildNonInteractiveEnv(undefined, { ...WSL, WSLENV: "WSL_UTF8/w:WT_SESSION" }, "linux");
	check("이미 넘기는 WSL_UTF8 은 두 번 넣지 않는다", listed.WSL_UTF8 === "1" && listed.WSLENV === "WSL_UTF8/w:WT_SESSION", shown(listed));
}
{
	const service = buildNonInteractiveEnv(undefined, { ...WSL, WSL_UTF8: "1" }, "linux");
	check(
		"서비스 env 가 WSL_UTF8=1 만 정했어도 WSLENV 로 넘긴다",
		isDeepStrictEqual(service, { ...NON_INTERACTIVE_ENV, WSLENV: "WSL_UTF8" }),
		shown(service),
	);
	const serverSet = buildNonInteractiveEnv(undefined, { ...WSL, WSL_UTF8: "0", WSLENV: "WT_SESSION" }, "linux");
	check(
		"서버 env 가 정한 WSL_UTF8 값은 그대로 두고 WSLENV 로 넘긴다",
		isDeepStrictEqual(serverSet, { ...NON_INTERACTIVE_ENV, WSLENV: "WT_SESSION:WSL_UTF8" }),
		shown(serverSet),
	);
	const callerSet = buildNonInteractiveEnv({ WSL_UTF8: "0" }, WSL, "linux");
	check(
		"호출자가 준 WSL_UTF8 값이 이기고 WSLENV 로 넘긴다",
		isDeepStrictEqual(callerSet, { ...NON_INTERACTIVE_ENV, WSL_UTF8: "0", WSLENV: "WSL_UTF8" }),
		shown(callerSet),
	);
	const callerShared = buildNonInteractiveEnv({ WSLENV: "FOO/p", PAGER: "less" }, WSL, "linux");
	check(
		"호출자가 준 WSLENV 와 다른 값이 이긴다",
		callerShared.WSLENV === "FOO/p" && callerShared.PAGER === "less" && callerShared.WSL_UTF8 === "1",
		`${shown(callerShared)} PAGER=${callerShared.PAGER}`,
	);
}

console.log("WSL 밖은 그대로다");
{
	check("linux(WSL 아님) 기본 env 는 같은 객체다", buildNonInteractiveEnv(undefined, {}, "linux") === NON_INTERACTIVE_ENV);
	const linuxOverride = buildNonInteractiveEnv({ PAGER: "less" }, { WSLENV: "WT_SESSION" }, "linux");
	check(
		"linux(WSL 아님)는 WSLENV 가 있어도 WSL_UTF8·WSLENV 를 넣지 않는다",
		isDeepStrictEqual(linuxOverride, { ...NON_INTERACTIVE_ENV, PAGER: "less" }),
		shown(linuxOverride),
	);
	check("darwin 은 WSL_DISTRO_NAME 이 있어도 같은 객체다", buildNonInteractiveEnv(undefined, WSL, "darwin") === NON_INTERACTIVE_ENV);
	const win = buildNonInteractiveEnv(undefined, WSL, "win32");
	check(
		"win32 는 기존 UTF-8 기본값만 넣는다",
		isDeepStrictEqual(win, { ...NON_INTERACTIVE_ENV, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }),
		shown(win),
	);
}

// 2026-10-09 감사 원문: `wsl.exe --help`·`--version` 이 bash 도구에서 `WSL ���:` 처럼 NUL·U+FFFD 로 왔다. 실제 executeBash 를
// 별도 프로세스에서 돌려 native 셸이 받은 env 로 wsl.exe 가 UTF-8 로 쓰는지 본다. 셸 설정은 프로세스 수명 동안 캐시되므로
// 서버 env 세 가지를 각각 자식 env 로 만든다: 지금 서비스(WSL_UTF8·WSLENV 없음), WSL_UTF8=1 만 정한 env(그것만으로는
// wsl.exe 에 닿지 않는다), run-service.sh 처럼 WSL_UTF8=1·WSLENV=WSL_UTF8 을 둘 다 정한 env(WSL_UTF8 을 두 번 넣지 않는다).
console.log("실제 bash 도구 경로: wsl.exe --version 이 UTF-8 로 온다");
if (process.platform !== "linux" || !process.env.WSL_DISTRO_NAME || !Bun.which("wsl.exe")) {
	console.log("  (WSL 이 아니거나 wsl.exe 가 없다: 실제 경로 검사는 세지 않는다)");
} else {
	const { WSL_UTF8: _utf8, WSLENV: _shared, ...inherited } = process.env;
	const servers: Array<[string, Record<string, string>]> = [
		["서버 env 에 WSL_UTF8 없음", {}],
		["서버 env 가 WSL_UTF8=1 만 정함", { WSL_UTF8: "1" }],
		["서버 env 가 WSL_UTF8=1·WSLENV=WSL_UTF8 을 정함", { WSL_UTF8: "1", WSLENV: "WSL_UTF8" }],
	];
	for (const [label, serverEnv] of servers) {
		const probeHome = mkdtempSync(join(tmpdir(), "cuelo-wsl-utf8-home-"));
		try {
			const probe = `const { executeBash } = await import(${JSON.stringify(`${CORE}/exec/bash-executor.ts`)});
const result = await executeBash('echo "ENV=$WSL_UTF8|$WSLENV"; wsl.exe --version', { cwd: ${JSON.stringify(probeHome)}, timeout: 60_000 });
console.log(JSON.stringify({ exitCode: result.exitCode, output: result.output }));
process.exit(0);`;
			const child = Bun.spawnSync([process.execPath, "-e", probe], {
				cwd: probeHome,
				env: { ...inherited, ...serverEnv, HOME: probeHome, USERPROFILE: probeHome },
				timeout: 90_000,
			});
			const last = child.stdout.toString().trim().split(/\r?\n/).pop() ?? "";
			// The probe prints `JSON.stringify({ exitCode, output })` as its last line.
			let result: { exitCode?: number; output: string } | undefined;
			try {
				result = JSON.parse(last);
			} catch {
				// No JSON line: reported below as <no result>.
			}
			const output = result?.output ?? `<no result> stdout=${last.slice(0, 200)} stderr=${child.stderr.toString().trim().slice(0, 300)}`;
			const exitCode = result?.exitCode;
			check(`${label}: 셸 안에 WSL_UTF8=1 과 WSLENV=WSL_UTF8 이 한 번 보인다`, /^ENV=1\|WSL_UTF8$/m.test(output), output.slice(0, 120));
			check(
				`${label}: wsl.exe --version 이 NUL·U+FFFD 없이 버전 줄을 낸다`,
				exitCode === 0 && !/[\u0000\uFFFD]/.test(output) && /WSL[^\n]*\d+\.\d+\.\d+/.test(output),
				`exit=${exitCode} ${JSON.stringify(output.slice(0, 160))}`,
			);
		} finally {
			rmSync(probeHome, { recursive: true, force: true });
		}
	}
}

console.log(`\n결과 ${pass} pass / ${fail} fail`);
process.exitCode = fail === 0 ? 0 : 1;
