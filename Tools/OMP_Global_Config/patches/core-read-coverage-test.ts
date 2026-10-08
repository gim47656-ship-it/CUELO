// read 전달 범위 회귀(2026-10-04). read 도구 결과가 모델에 가는 실제 경로(ReadTool.execute → postProcessToolResult)에서
// 안내문이 실제로 전달한 범위만 말하는지 본다.
// [과장] hashline 모드에서 첫 줄이 read 예산보다 크면 본문은 거부 문구뿐인데 "partial, 150.0KB" 전달로 보고했다 → 0 B.
// [보존] :raw 의 첫 줄 preview 크기 보고, 첫 줄 미전달 시 재개 offset 미제공, 전달 단계 재잘림(spill)에서 재개 offset이
//        실제 마지막 전달 행 다음이고 중간 생략은 artifact로 회수 가능하다는 안내.
// patch는 임시 source fixture에만 적용한다. READ_COVERAGE_BASELINE=1 이면 target 설치본 원본을 읽는다(수정 전 RED 확인용).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

if (!process.env.OMP_READ_COVERAGE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-read-coverage-"));
	const home = join(root, "home");
	mkdirSync(home);
	let exitCode = 1;
	try {
		const child = Bun.spawnSync([process.execPath, import.meta.path], {
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: home,
				CUELO_REAL_HOME: homedir(),
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_READ_COVERAGE_ROOT: root,
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

const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
const core = process.env.OMP_CORE_PATCH_TARGET ?? [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(process.env.CUELO_REAL_HOME ?? homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent")].find(dir => existsSync(dir)) ?? join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent");
const script = resolve(import.meta.dirname, "apply-core-patch.mjs");
const temp = process.env.OMP_READ_COVERAGE_ROOT;
const fixture = join(temp, "target");
const patchHome = join(temp, "patch-home");
const toUrl = (path: string) => path.replace(/\\/g, "/");
const baseline = process.env.READ_COVERAGE_BASELINE === "1";
let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — ${detail}`}`);
	ok ? passes++ : failures++;
}

if (!existsSync(join(core, "src/tools/read.ts"))) throw new Error(`코어 원본을 찾지 못했다: ${core}`);
const source = readFileSync(script, "utf8");
const pristine = process.env.OMP_CORE_PATCH_BACKUP;
for (const path of new Set([...source.matchAll(/^\s*file: "([^"]+)",\s*$/gm)].map(match => match[1]!))) {
	const backup = pristine ? join(pristine, path) : undefined;
	const original = backup && existsSync(backup) ? backup : join(core, path);
	if (!existsSync(original)) continue;
	const target = join(fixture, path);
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(original, target);
}
mkdirSync(patchHome, { recursive: true });
const applied = spawnSync("node", [script], {
	encoding: "utf8",
	env: { ...process.env, OMP_CORE_PATCH_TARGET: fixture, HOME: patchHome, USERPROFILE: patchHome },
});
if (applied.status !== 0) throw new Error(`격리 패치 실패 (${applied.status}):\n${applied.stdout}\n${applied.stderr}`);
console.log(`격리 패치 exit ${applied.status}${baseline ? " (기준선: 설치본 원본을 읽는다)" : ""}`);

const corePackage = basename(core);
Bun.plugin({
	name: "read-coverage-fixture",
	setup(build) {
		build.onLoad({ filter: /[/\\]@oh-my-pi[/\\][\w-]+[/\\].+\.ts$/ }, args => {
			const [pkg, ...rest] = toUrl(args.path).split("/@oh-my-pi/").at(-1)!.split("/");
			const patched = pkg === corePackage ? join(fixture, ...rest) : join(fixture, "..", pkg!, ...rest);
			const contents = readFileSync(baseline || !existsSync(patched) ? args.path : patched, "utf8");
			if (args.path.endsWith(".d.ts")) return { exports: { default: contents }, loader: "object" };
			return { contents, loader: "ts" };
		});
	},
});
// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET, so these cannot be static imports.
const { setAgentDir } = await import(toUrl(join(dirname(core), "pi-utils/src/dirs.ts")));
setAgentDir(join(process.env.HOME!, ".omp", "agent"));
const { Settings } = await import(toUrl(join(core, "src/config/settings.ts")));
const { ReadTool } = await import(toUrl(join(core, "src/tools/read.ts")));
const { postProcessToolResult } = await import(toUrl(join(core, "src/tools/output-meta.ts")));

const files = join(temp, "files");
mkdirSync(files, { recursive: true });
const settings = Settings.isolated({});
const artifacts = new Map<string, string>();
const sessionManager = {
	saveArtifact: async (text: string) => {
		const id = String(artifacts.size + 1);
		artifacts.set(id, text);
		return id;
	},
};
// ReadTool이 이 읽기 경로에서 쓰는 session 필드만 둔다. 나머지는 undefined(선택 기능 꺼짐).
const session = new Proxy({ cwd: files, hasUI: false, settings } as Record<string, unknown>, {
	get: (target, key) => (key in target ? target[key as string] : undefined),
});
const tool = new ReadTool(session as never);
async function delivered(path: string): Promise<string> {
	const context = { sessionManager, settings } as never;
	const result = await postProcessToolResult(await tool.execute("call", { path }, undefined, undefined, context), "read", context);
	return result.content.map((block: { text?: string }) => block.text ?? "").join("\n");
}
const row = (n: number, width: number) => `L${String(n).padStart(5, "0")} ${"x".repeat(width - 7)}`;

// 첫 줄 200KB JSON + 짧은 줄 20개. read 예산은 max(50KB, 300줄 × 512B) = 150KB다.
writeFileSync(join(files, "first.json"), `${JSON.stringify({ blob: "y".repeat(200_000) })}\n${Array.from({ length: 20 }, (_, i) => row(i + 2, 40)).join("\n")}\n`);
const hashline = await delivered("first.json");
check(
	"hashline: 첫 줄을 내지 않았으면 전달량을 0B로 보고한다",
	!hashline.includes("y".repeat(100)) && /partial, 0B of 195\.3KB/.test(hashline) && !/150\.0KB of/.test(hashline),
	JSON.stringify(hashline.slice(-200)),
);
check("hashline: 첫 줄 미전달이면 다음 행 재개 offset을 권하지 않는다", !/Use :\d+ to continue/.test(hashline), JSON.stringify(hashline.slice(-200)));
const raw = await delivered("first.json:raw");
check(
	":raw: 첫 줄 preview는 그대로 실리고 재개 offset은 없다",
	raw.includes("y".repeat(1000)) && !/Use :\d+ to continue/.test(raw),
	JSON.stringify(raw.slice(-200)),
);

// 300줄 창이 read 예산(150KB)은 통과하지만 전달 단계 spill(50KB)에서 다시 잘린다.
writeFileSync(join(files, "wide.txt"), `${Array.from({ length: 2000 }, (_, i) => row(i + 1, 400)).join("\n")}\n`);
const wide = await delivered("wide.txt:100");
const shown = [...wide.matchAll(/L(\d{5})/g)].map(match => Number(match[1]));
const resume = Number(wide.match(/Use :(\d+) to continue/)?.[1]);
check(
	"spill 재잘림: 재개 offset은 실제로 전달한 마지막 행 바로 다음이다",
	shown.length > 0 && resume === shown.at(-1)! + 1,
	`last=${shown.at(-1)} resume=${resume}`,
);
const artifactId = wide.match(/artifact:\/\/(\d+)/)?.[1];
check(
	"spill 재잘림: 생략한 중간 행은 안내에 밝히고 artifact에 원문이 있다",
	/middle lines? \([^)]*\) elided/.test(wide) && artifactId !== undefined && (artifacts.get(artifactId) ?? "").includes(row(200, 400)),
	JSON.stringify(wide.slice(-240)),
);

console.log(`\n결과: ${passes} pass, ${failures} fail`);
process.exit(failures === 0 ? 0 : 1);
