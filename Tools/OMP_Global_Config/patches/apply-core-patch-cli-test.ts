// apply-core-patch.mjs 의 실행 경계 검증. 실행(저장소에서):
//   bun run patches/apply-core-patch-cli-test.ts
//
// 이 테스트가 지키는 계약은 셋이다.
//  (1) import 는 아무 일도 하지 않는다. 2026-09-12 실장애: 다른 테스트가 이 파일을
//      import 하자 최상위 코드가 그대로 돌아 전역 설치를 찾아 실제로 패치하고
//      process.exit 로 시험 프로세스까지 끝냈다.
//  (2) 직접 실행의 계약(기본 적용 / --check / --revert 의 출력과 종료 코드)은 그대로다.
//      가드가 너무 엄해 CLI 가 조용히 아무것도 안 하는 쪽으로 깨지는 것이 실제 위험이라
//      상대 경로·슬래시·드라이브 문자 소문자까지 실제 호출로 확인한다.
//  (3) 도움말·잘못된 인자는 적용으로 해석하지 않는다. 대상 파일과 백업을 쓰지 않는다.
//
// 살아 있는 설치는 건드리지 않는다. 대상은 임시 폴더로 복사한 사본이고(OMP_CORE_PATCH_TARGET),
// 백업 경로도 임시 홈(USERPROFILE/HOME)으로 갈라 두므로 이 프로세스가 쓰는 파일은 전부
// mkdtemp 아래에 있다.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = resolve(import.meta.dirname, "apply-core-patch.mjs");
const SCRIPT_TEXT = readFileSync(SCRIPT, "utf8");

/** 전역 npm 위치는 PC마다 다르다. apply-core-patch.mjs 와 같은 순서로 찾는다. */
function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(p => existsSync(join(p, "src/registry/agent-registry.ts")));
	if (!hit) throw new Error(`CUELO 전역 설치를 찾지 못했다: ${candidates.join(", ")}`);
	return hit;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const CORE = resolveCore();
console.log(`원본 ${CORE}`);

const tmpRoot = mkdtempSync(join(tmpdir(), "omp-core-patch-cli-"));
const fixture = join(tmpRoot, "target");
const fakeHome = join(tmpRoot, "home");
const emptyTarget = join(tmpRoot, "empty");
mkdirSync(fakeHome, { recursive: true });
mkdirSync(emptyTarget, { recursive: true });

/** EDITS 가 건드리는 파일만 사본으로 만든다. 목록은 스크립트 자신이 정본이다.
 *  줄 끝은 LF·CRLF 어느 쪽으로 저장돼도 허용한다. */
const editFiles = [...new Set([...SCRIPT_TEXT.matchAll(/^\s*file: "([^"]+)",\s*$/gm)].map(m => m[1]!))];
if (editFiles.length === 0) throw new Error("apply-core-patch.mjs 에서 EDITS 대상 파일을 하나도 뽑지 못했다");
for (const rel of editFiles) {
	const src = join(CORE, rel);
	if (!existsSync(src)) continue;
	const dest = join(fixture, rel);
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
}
const baseEnv = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, OMP_CORE_PATCH_TARGET: fixture };

type Run = { code: number | null; out: string };
function run(args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; script?: string } = {}): Run {
	const r = spawnSync("node", [opts.script ?? SCRIPT, ...args], {
		encoding: "utf8",
		env: opts.env ?? baseEnv,
		cwd: opts.cwd,
	});
	return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// 살아 있는 설치가 이미 적용된 상태일 수도, 아닐 수도 있다. 사본을 먼저 되돌려
// "미적용" 기준선을 만든다(이 한 번은 준비 단계라 판정하지 않는다).
const baseline = run(["--revert"]);
if (baseline.code !== 0) throw new Error(`사본 기준선을 만들지 못했다: code=${baseline.code}\n${baseline.out}`);
const snapshot = new Map(
	editFiles.filter(rel => existsSync(join(fixture, rel))).map(rel => [rel, readFileSync(join(fixture, rel))] as const),
);
console.log(`사본 ${fixture} (${snapshot.size} files)`);

function fixtureUnchanged(): boolean {
	return [...snapshot].every(([rel, bytes]) => readFileSync(join(fixture, rel)).equals(bytes));
}

console.log("\n[1] import 는 대상을 찾지도, 쓰지도, 프로세스를 끝내지도 않는다");
// 자식 프로세스로 import 한다. 가드가 깨져 있으면 여기서 실제 적용이 돌아 사본이 바뀌고
// 출력과 종료 코드로 바로 드러난다(시험 프로세스 자신이 죽지는 않는다).
const importer = join(tmpRoot, "importer.mjs");
writeFileSync(
	importer,
	`await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});\nconsole.log("IMPORT-OK");\n`,
	"utf8",
);
for (const [label, exe] of [
	["node", "node"],
	["bun", process.execPath],
] as const) {
	const r = spawnSync(exe, [importer], { encoding: "utf8", env: baseEnv });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	check(`${label}: import 는 끝까지 돌아가고 프로세스를 끝내지 않는다`, r.status === 0 && out.includes("IMPORT-OK"), `code=${r.status} out=${out.slice(0, 200)}`);
	check(`${label}: import 는 대상 탐색·적용 로그를 내지 않는다`, !out.includes("대상 ") && !out.includes("적용 ") && !out.includes("NOTFOUND"), out.slice(0, 200));
	check(`${label}: import 는 대상 파일을 쓰지 않는다`, fixtureUnchanged());
	check(`${label}: import 는 백업도 만들지 않는다`, !existsSync(join(fakeHome, ".omp/core-patch-backup")));
}

console.log("\n[2] 직접 실행 — --check / 적용 / --revert 의 출력과 종료 코드");
const checkBefore = run(["--check"]);
check("미적용 사본의 --check 는 MISSING 과 1 이다", checkBefore.code === 1 && checkBefore.out.includes("MISSING"), `code=${checkBefore.code} out=${checkBefore.out.slice(-200)}`);
check("--check 는 대상 경로를 밝힌다", checkBefore.out.includes(fixture), checkBefore.out.slice(0, 200));
check("--check 는 아무것도 쓰지 않는다", fixtureUnchanged());

const applied = run([]);
check("기본 실행은 적용하고 0 으로 끝난다", applied.code === 0 && applied.out.includes("적용 완료"), `code=${applied.code} out=${applied.out.slice(-2_000)}`);
check("적용은 실제로 파일을 바꾼다", !fixtureUnchanged());
check("적용은 백업을 임시 홈에 남긴다", existsSync(join(fakeHome, ".omp/core-patch-backup")));
const completionBridgeAfterApply = readFileSync(join(fixture, "src/eval/completion-bridge.ts"), "utf8");
check(
	"eval completion exact WEB6 anchor는 정확히 한 번 적용된다",
	completionBridgeAfterApply.split('const EXACT_WEB6_MODEL = "web6/gpt-6-pro" as const;').length - 1 === 1,
);
check(
	"eval completion sessionId provider option은 정확히 한 번 적용된다",
	completionBridgeAfterApply.split("sessionId: session.getSessionId?.() ?? undefined,").length - 1 === 1,
);

const checkAfter = run(["--check"]);
check("적용 뒤 --check 는 APPLIED 와 0 이다", checkAfter.code === 0 && checkAfter.out.includes("APPLIED"), `code=${checkAfter.code} out=${checkAfter.out.slice(-200)}`);

const again = run([]);
check("이미 적용된 대상의 재실행은 SKIP 과 0 이다", again.code === 0 && again.out.includes("SKIP"), `code=${again.code} out=${again.out.slice(-200)}`);

// An installed 0.5.4 already carries the older learn-id patch. Upgrading it
// must replace that exact fragment instead of treating its old marker as final.
const learnPath = join(fixture, "src/tools/learn.ts");
const latestLearn = readFileSync(learnPath, "utf8");
const oldLearn = latestLearn
	.replace(
		"const topicResult = params.topic ? upsertLearnTopic(state, params, target ?? state.getScopedRetainTarget()) : undefined;\n\t\t\t\tconst memoryId = topicResult?.id ?? state.rememberScoped(",
		"const memoryId = state.rememberScoped(",
	)
	.replace(
		'if (memoryId) memoryMessage = `Lesson stored (id: ${memoryId}${topicResult ? `, revision: ${topicResult.revision}` : ""})`;',
		'if (memoryId) memoryMessage = `Lesson stored (id: ${memoryId})`;',
	);
check("0.5.4 learn-id 본문을 재현한다", oldLearn !== latestLearn && !oldLearn.includes("const topicResult ="));
writeFileSync(learnPath, oldLearn);
const oldCheck = run(["--check"]);
check("옛 learn-id 패치는 MISSING으로 판정한다", oldCheck.code === 1 && oldCheck.out.includes("legacy"), oldCheck.out.slice(-400));
const upgraded = run([]);
check("옛 learn-id 패치를 최신으로 바꾼다", upgraded.code === 0 && readFileSync(learnPath, "utf8") === latestLearn,
	`code=${upgraded.code} out=${upgraded.out.slice(-400)}`);

const reverted = run(["--revert"]);
check("--revert 는 복원 완료와 0 으로 끝난다", reverted.code === 0 && reverted.out.includes("복원 완료"), `code=${reverted.code} out=${reverted.out.slice(-2_000)}`);
check("--revert 는 원본 바이트로 되돌린다", fixtureUnchanged());

const notFound = run(["--check"], { env: { ...baseEnv, OMP_CORE_PATCH_TARGET: emptyTarget } });
check("설치가 없으면 NOTFOUND 와 2 다", notFound.code === 2 && notFound.out.includes("NOTFOUND"), `code=${notFound.code} out=${notFound.out.slice(-200)}`);

console.log("\n[3] 호출 표기가 달라도 직접 실행으로 인식한다 (Windows 경로)");
// 가드가 경로 비교이므로, 호출 표기가 달라 CLI 가 조용히 아무 일도 하지 않는 것이
// 이 변경의 실제 회귀 위험이다. 표기별로 실제로 main 이 돌았는지(대상 출력)를 본다.
const invocations: Array<[string, string, string | undefined]> = [
	["절대 경로", SCRIPT, undefined],
	["슬래시 경로", SCRIPT.replaceAll("\\", "/"), undefined],
	["상대 경로", "./apply-core-patch.mjs", dirname(SCRIPT)],
	["드라이브 문자 소문자", SCRIPT.charAt(0).toLowerCase() + SCRIPT.slice(1), undefined],
];
for (const [label, scriptPath, cwd] of invocations) {
	const r = run(["--check"], { script: scriptPath, cwd });
	check(`${label} 호출도 실제로 실행된다`, r.out.includes("대상 ") && r.code !== null, `code=${r.code} out=${r.out.slice(0, 200)}`);
}

console.log("\n[4] 도움말·잘못된 인자는 대상과 백업을 쓰지 않는다");
for (const [label, args, code] of [
	["도움말", ["--help"], 0],
	["알 수 없는 인자", ["--chek"], 1],
	["상충하는 모드", ["--check", "--revert"], 1],
] as const) {
	const queryTarget = join(tmpRoot, label, "target");
	const queryHome = join(tmpRoot, label, "home");
	mkdirSync(queryHome, { recursive: true });
	for (const [rel, bytes] of snapshot) {
		const dest = join(queryTarget, rel);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, bytes);
	}
	const r = run([...args], { env: { ...baseEnv, USERPROFILE: queryHome, HOME: queryHome, OMP_CORE_PATCH_TARGET: queryTarget } });
	check(`${label}: 종료 코드 ${code}`, r.code === code, `code=${r.code} out=${r.out.slice(-200)}`);
	check(`${label}: 대상 바이트 보존`, [...snapshot].every(([rel, bytes]) => readFileSync(join(queryTarget, rel)).equals(bytes)));
	check(`${label}: 백업 생성 없음`, !existsSync(join(queryHome, ".omp/core-patch-backup")));
}

console.log("\n[5] 옛 판 적용본과 새 판 순정이 국소 문맥까지 같은 항목 — 같은 파일 조건(requires/excludes)");
// 18.5.0 upstream 은 task/index.ts 의 preflight·launch 에 우리 18.4.12 패치와 바이트까지 같은 model 전달 줄을 넣었다.
// 18.4.12 적용본을 순정 no-op 으로 오인하면 --revert 가 우리 줄을 못 지우고, 18.5.0 순정을 우리 적용본으로 오인하면
// --revert 가 upstream 줄을 지운다. 두 판을 가르는 것은 같은 파일의 18.5.0 전용 import 다.
const crossBody = (newImport: boolean) =>
	`import {\n${newImport ? "\tinvalidModelSelectorReason,\n" : ""}\tresolveEffectiveSubagentPolicy,\n} from "./structured-subagent";\n` +
	"\t\treturn resolveEffectiveSubagentPolicy({\n" +
	"\t\t\t...(params.effort !== undefined ? { effort: params.effort } : {}),\n" +
	"\t\t\t...(params.model !== undefined ? { model: params.model } : {}),\n" +
	'\t\t\t...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),\n' +
	"\t\t});\n" +
	"\t\t\t\t...(params.effort !== undefined ? { effort: params.effort } : {}),\n" +
	"\t\t\t\tsolutionSpace: params.solutionSpace,\n" +
	"\t\t\t\t...(params.model !== undefined ? { model: params.model } : {}),\n" +
	"\t\t\t\t...(params.tools?.length\n";
for (const [label, newImport] of [["18.4.12 적용본", false], ["18.5.0 순정", true]] as const) {
	const crossTarget = join(tmpRoot, `cross-${newImport ? "new" : "old"}`, "target");
	const crossHome = join(tmpRoot, `cross-${newImport ? "new" : "old"}`, "home");
	mkdirSync(join(crossTarget, "src/registry"), { recursive: true });
	mkdirSync(join(crossTarget, "src/task"), { recursive: true });
	mkdirSync(crossHome, { recursive: true });
	writeFileSync(join(crossTarget, "src/registry/agent-registry.ts"), "");
	const indexPath = join(crossTarget, "src/task/index.ts");
	const before = crossBody(newImport);
	writeFileSync(indexPath, before);
	const env = { ...baseEnv, USERPROFILE: crossHome, HOME: crossHome, OMP_CORE_PATCH_TARGET: crossTarget };
	const checked = run(["--check"], { env });
	check(`${label}: task/index.ts 항목이 ambiguous 로 막히지 않는다`, !/ambiguous\s+src\/task\/index\.ts/.test(checked.out), checked.out.slice(-600));
	const r = run(["--revert"], { env });
	const after = readFileSync(indexPath, "utf8");
	if (newImport) {
		check(`${label}: --revert 는 upstream model 전달 줄을 지우지 않는다`, r.code === 0 && after === before, `code=${r.code} out=${r.out.slice(-600)}`);
	} else {
		check(
			`${label}: --revert 는 우리 model 전달 줄 둘을 되돌린다(순정 no-op 으로 오인하지 않음)`,
			r.code === 0 && !after.includes("{ model: params.model }") && after.includes("solutionSpace: params.solutionSpace,\n"),
			`code=${r.code} out=${r.out.slice(-600)}`,
		);
	}
}

console.log("\n[N] 일부 task schema만 model이 없을 때 다른 schema가 marker를 대신 채우지 않고 빠진 곳만 복구한다");
// 18.6.1 순정 기준선(agent default 표현)에서 한 schema의 model 줄만 빠진 상태를 만든다. 각 schema의 marker가 자기 header를
// 포함하지 않으면 다른 schema의 model 줄이 이 항목을 이미 적용한 것으로 보이게 하고(false APPLIED/SKIP) 복구도 건너뛴다.
const typesRel = "src/task/types.ts";
const baselineTypes = snapshot.get(typesRel)?.toString("utf8");
if (baselineTypes === undefined) throw new Error("기준선에 src/task/types.ts 가 없다");
const modelLine = /^\t"model\?": [^\n]*\n/m;
const modelLineCount = (text: string) => text.split("\n").filter(line => /^\t"model\?": /.test(line)).length;
for (const header of ["export const taskSchema = type({", "const taskSchemaNoIsolation = type({"]) {
	const partialRoot = join(tmpRoot, `partial-${header.includes("NoIsolation") ? "noiso" : "plain"}`);
	const partialTarget = join(partialRoot, "target");
	const partialHome = join(partialRoot, "home");
	mkdirSync(partialHome, { recursive: true });
	for (const [rel, bytes] of snapshot) {
		mkdirSync(dirname(join(partialTarget, rel)), { recursive: true });
		writeFileSync(join(partialTarget, rel), bytes);
	}
	const start = baselineTypes.indexOf(header);
	const end = baselineTypes.indexOf("\n});", start);
	const block = baselineTypes.slice(start, end);
	const stripped = block.replace(modelLine, "");
	check(`${header}: 준비 상태는 이 schema의 model 줄만 뺀다`, start >= 0 && stripped !== block && modelLineCount(baselineTypes.slice(0, start) + stripped + baselineTypes.slice(end)) === modelLineCount(baselineTypes) - 1);
	const partialPath = join(partialTarget, typesRel);
	writeFileSync(partialPath, baselineTypes.slice(0, start) + stripped + baselineTypes.slice(end), "utf8");
	const partialEnv = { ...baseEnv, USERPROFILE: partialHome, HOME: partialHome, OMP_CORE_PATCH_TARGET: partialTarget };
	const partialCheck = run(["--check"], { env: partialEnv });
	check(`${header}: model이 빠진 schema가 있으면 --check 는 APPLIED 로 보고하지 않는다`, partialCheck.code === 1 && !partialCheck.out.includes("APPLIED"), `code=${partialCheck.code}`);
	const partialApply = run([], { env: partialEnv });
	const recovered = readFileSync(partialPath, "utf8");
	const recoveredStart = recovered.indexOf(header);
	const recoveredBlock = recovered.slice(recoveredStart, recovered.indexOf("\n});", recoveredStart));
	check(`${header}: 적용이 빠진 model 줄을 그 schema에 복구한다`, partialApply.code === 0 && /^\t"model\?": /m.test(recoveredBlock), `code=${partialApply.code} out=${partialApply.out.slice(-300)}`);
	check(`${header}: 복구 뒤 model 줄 수는 기준선과 같다(다른 schema에 중복 추가 없음)`, modelLineCount(recovered) === modelLineCount(baselineTypes));
	const again = run(["--check"], { env: partialEnv });
	check(`${header}: 복구 뒤 --check 는 APPLIED 이고 재적용은 SKIP 이다`, again.code === 0 && run([], { env: partialEnv }).out.includes("SKIP"), again.out.slice(-200));
}

rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
