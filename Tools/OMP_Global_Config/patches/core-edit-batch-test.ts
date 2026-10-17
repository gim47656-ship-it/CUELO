// 여러 파일 edit 배치의 seen-line 거부 회귀(2026-10-17). native 는 배치에서 보지 않은 줄을 쓴 첫 파일만 거부하고 그 파일의
// 보인 줄만 기록해, 같은 배치를 그대로 다시 보낼 때마다 다른 파일이 거부됐다(실측 5회). EditTool.execute 의 실제 경로로 본다.
// [고침] 한 응답에 거부 파일 전부, 아무것도 쓰지 않음, 고친 재전송 한 번으로 성공, 미리보기 한도를 넘은 파일이 있으면 성공을 약속하지 않음.
// [보존] 한 파일 배치의 거부 문구(=native 원문의 한국어화)와 재전송 성공, 모두 본 여러 파일 배치의 성공 출력(=native 원문).
// [고정] 쓰기 거부 probe 도 native 의 byte-identical no-op 횟수에 든다: no-op 파일이 낀 배치는 재전송 두 번째에 STOP(이전엔 세 번째).
// patch는 임시 source fixture에만 적용한다. EDIT_BATCH_BASELINE=1 이면 target 설치본을 그대로 읽는다(수정 전 RED 확인용).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

if (!process.env.OMP_EDIT_BATCH_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-edit-batch-"));
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
				OMP_EDIT_BATCH_ROOT: root,
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

const npmRoot = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
const core = process.env.OMP_CORE_PATCH_TARGET ?? [join(npmRoot, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(process.env.CUELO_REAL_HOME ?? homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(npmRoot, "omp-web/node_modules/@oh-my-pi/pi-coding-agent")].find(dir => existsSync(dir)) ?? join(npmRoot, "cuelo/node_modules/@oh-my-pi/pi-coding-agent");
const script = resolve(import.meta.dirname, "apply-core-patch.mjs");
const temp = process.env.OMP_EDIT_BATCH_ROOT;
const fixture = join(temp, "target");
const patchHome = join(temp, "patch-home");
const toUrl = (path: string) => path.replace(/\\/g, "/");
const baseline = process.env.EDIT_BATCH_BASELINE === "1";
let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — ${detail}`}`);
	ok ? passes++ : failures++;
}

if (!existsSync(join(core, "src/edit/index.ts"))) throw new Error(`코어 원본을 찾지 못했다: ${core}`);
const source = readFileSync(script, "utf8");
for (const path of new Set([...source.matchAll(/^\s*file: "([^"]+)",\s*$/gm)].map(match => match[1]!))) {
	const original = join(core, path);
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
console.log(`격리 패치 exit ${applied.status}${baseline ? " (기준선: 설치본을 그대로 읽는다)" : ""}`);

const corePackage = basename(core);
Bun.plugin({
	name: "edit-batch-fixture",
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
const { EditTool, getEditStore, localizeSeenLineRejection } = await import(toUrl(join(core, "src/edit/index.ts")));
const { EditSession, EditStore } = await import(toUrl(join(dirname(core), "pi-natives/native/index.js")));

const settings = Settings.isolated({});
const lines = (name: string, count: number) => `${Array.from({ length: count }, (_, i) => `${name} line ${i + 1}`).join("\n")}\n`;
const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
type Seen = Record<string, { seen: number[]; count?: number }>;

/**
 * One isolated workspace: its own cwd, EditTool and native store; files start with `seen` lines displayed.
 * `failAfterFirstOpen` makes every edit session opened after the first one throw (fault injection for probes).
 */
function workspace(name: string, files: Seen, failAfterFirstOpen = false) {
	const cwd = join(temp, "files", name);
	mkdirSync(cwd, { recursive: true });
	// EditTool은 이 경로에서 cwd·settings·세션 파일만 읽는다. 나머지는 undefined(선택 기능 꺼짐).
	// 세션 파일은 edit session 을 열 때마다 한 번 읽힌다(sessionResolveContext).
	let opens = 0;
	const getSessionFile = () => {
		if (failAfterFirstOpen && ++opens > 1) throw new Error("injected probe session failure");
		return null;
	};
	const session = new Proxy({ cwd, hasUI: false, settings, enableLsp: false, getSessionFile } as Record<string, unknown>, {
		get: (target, key) => (key in target ? target[key as string] : undefined),
	});
	const tool = new EditTool(session as never, "hashline");
	const store = getEditStore(session as never);
	const tags: Record<string, string> = {};
	for (const [file, { seen, count = 60 }] of Object.entries(files)) {
		writeFileSync(join(cwd, file), lines(file, count));
		tags[file] = store.recordSnapshot(join(cwd, file), lines(file, count), seen);
	}
	return {
		cwd,
		tags,
		disk: (file: string) => readFileSync(join(cwd, file), "utf8"),
		async edit(input: string): Promise<{ isError: boolean; text: string }> {
			try {
				const result = await tool.execute("call", { input }, undefined, undefined, undefined);
				return { isError: result.isError === true, text: result.content.map((block: { text?: string }) => block.text ?? "").join("\n") };
			} catch (error) {
				return { isError: true, text: `THREW ${error instanceof Error ? error.message : String(error)}` };
			}
		},
	};
}

/** The pre-patch contract: native apply on an identical, separate store, rendered as the old code did. */
async function nativeOutcome(name: string, files: Seen, input: (tags: Record<string, string>) => string) {
	const cwd = join(temp, "native", name);
	mkdirSync(cwd, { recursive: true });
	const store = new EditStore();
	const tags: Record<string, string> = {};
	for (const [file, { seen, count = 60 }] of Object.entries(files)) {
		writeFileSync(join(cwd, file), lines(file, count));
		tags[file] = store.recordSnapshot(join(cwd, file), lines(file, count), seen);
	}
	const native = new EditSession(store, {
		cwd,
		mode: "hashline",
		allowFuzzy: false,
		fuzzyThreshold: 0.95,
		enforceSeenLines: true,
		blockAutoGenerated: false,
		planActive: false,
		urlSchemes: [],
		urlAliasSchemes: [],
		planWritableRoots: [],
		homeDir: homedir(),
		rawInput: false,
	});
	native.setArgsJson(JSON.stringify({ input: input(tags) }));
	native.finish();
	const outcome = await native.apply({ lspFlush: false }, async (_error: Error | null, request: { path: string; content?: string }) => {
		writeFileSync(request.path, request.content ?? "");
		return { written: request.content ?? "" };
	});
	native.close();
	return { isError: outcome.isError, text: outcome.isError ? localizeSeenLineRejection(outcome.text) : outcome.text };
}

// 2026-10-17 실측 모양: 앞 파일은 본 줄, 뒤 두 파일은 보지 않은 줄을 고친다.
{
	const files: Seen = { "a.txt": { seen: span(1, 60) }, "b.txt": { seen: span(1, 10) }, "c.txt": { seen: span(1, 10) } };
	const ws = workspace("three", files);
	const batch = `[a.txt#${ws.tags["a.txt"]}]\nPUT 5.=5:\n+A5 new\n[b.txt#${ws.tags["b.txt"]}]\nPUT 30.=30:\n+B30 new\n[c.txt#${ws.tags["c.txt"]}]\nPUT 40.=40:\n+C40 new\n`;
	const before = ["a.txt", "b.txt", "c.txt"].map(ws.disk);
	const first = await ws.edit(batch);
	check(
		"여러 파일 배치: 보지 않은 줄을 쓴 파일 둘을 한 응답에 모두 보인다",
		first.isError && first.text.includes("b.txt의 30번 줄") && first.text.includes("c.txt의 40번 줄") && first.text.includes("30:b.txt line 30") && first.text.includes("40:c.txt line 40"),
		JSON.stringify(first.text.slice(0, 600)),
	);
	check("여러 파일 배치: 거부되면 본 줄을 쓴 a.txt 를 포함해 아무 파일도 쓰지 않는다", ["a.txt", "b.txt", "c.txt"].every((file, i) => ws.disk(file) === before[i]), "디스크가 바뀌었다");
	check("여러 파일 배치: 모든 파일이 통과할 때만 그대로 재전송 성공을 약속한다", first.text.includes("그대로 재시도해도 이제 성공한다") && !first.text.includes("보장은 없다"), JSON.stringify(first.text.slice(-300)));
	const resend = await ws.edit(batch);
	check(
		"여러 파일 배치: 같은 배치를 한 번 다시 보내면 세 파일이 모두 쓰인다",
		!resend.isError && ws.disk("a.txt").includes("A5 new") && ws.disk("b.txt").includes("B30 new") && ws.disk("c.txt").includes("C40 new"),
		JSON.stringify(resend.text.slice(0, 300)),
	);
}

// 미리보기 한도(40줄)를 넘는 범위는 native 가 본 줄로 기록하지 않는다. 그 뒤 파일은 검사하지 못했다고 밝히고 성공을 약속하지 않는다.
{
	const ws = workspace("overcap", { "big.txt": { seen: span(1, 10), count: 120 }, "tail.txt": { seen: span(1, 10) } });
	const batch = `[big.txt#${ws.tags["big.txt"]}]\nPUT 11.=100:\n+replaced\n[tail.txt#${ws.tags["tail.txt"]}]\nPUT 30.=30:\n+T30\n`;
	const result = await ws.edit(batch);
	check(
		"미리보기 한도 초과: 검사하지 못했을 수 있는 파일을 밝히고, 기록되지 않은 줄을 기록됐다고도 재전송이 성공한다고도 하지 않는다",
		result.isError &&
			result.text.includes("big.txt:11-100") &&
			result.text.includes("마치지 못했을 수 있는 파일: tail.txt") &&
			!result.text.includes("본 것으로 기록") &&
			!result.text.includes("그대로 재시도해도 이제 성공한다"),
		JSON.stringify(result.text.slice(-400)),
	);
	check("미리보기 한도 초과: 아무 파일도 쓰지 않는다", !ws.disk("big.txt").includes("replaced") && !ws.disk("tail.txt").includes("T30"), "디스크가 바뀌었다");
}

// [보존] 한 파일 배치: 문구는 native 원문의 한국어화 그대로이고 그대로 재전송하면 성공한다.
{
	const files: Seen = { "s.txt": { seen: span(1, 10) } };
	const input = (tags: Record<string, string>) => `[s.txt#${tags["s.txt"]}]\nPUT 30.=30:\n+S30\n`;
	const ws = workspace("single", files);
	const expected = await nativeOutcome("single", files, input);
	const first = await ws.edit(input(ws.tags));
	check("한 파일 배치: 거부 문구가 이전과 같다", expected.isError && first.isError && first.text === expected.text, `${JSON.stringify(first.text)}\n    기대 ${JSON.stringify(expected.text)}`);
	const resend = await ws.edit(input(ws.tags));
	check("한 파일 배치: 그대로 재전송하면 성공한다", !resend.isError && ws.disk("s.txt").includes("S30"), JSON.stringify(resend.text.slice(0, 200)));
}

// [보존] 모두 본 여러 파일 배치: 결과는 native 원문 그대로다.
{
	const files: Seen = { "p.txt": { seen: span(1, 60) }, "q.txt": { seen: span(1, 60) } };
	const input = (tags: Record<string, string>) => `[p.txt#${tags["p.txt"]}]\nPUT 5.=5:\n+P5\n[q.txt#${tags["q.txt"]}]\nPUT 6.=6:\n+Q6\n`;
	const ws = workspace("seen", files);
	const expected = await nativeOutcome("seen", files, input);
	const result = await ws.edit(input(ws.tags));
	check(
		"모두 본 여러 파일 배치: 한 번에 쓰이고 결과 문구가 이전과 같다",
		!result.isError && !expected.isError && result.text === expected.text && ws.disk("p.txt").includes("P5") && ws.disk("q.txt").includes("Q6"),
		`${JSON.stringify(result.text.slice(0, 300))}\n    기대 ${JSON.stringify(expected.text.slice(0, 300))}`,
	);
}

// 교차검토 R1-OAI-2: no-op guard 는 native 문구 줄 모양으로만 알아본다. 파일명·보인 줄에 'byte-identical' 이 있어도 모은다.
{
	const ws = workspace("phrase", { "byte-identical.txt": { seen: span(1, 10) }, "other.txt": { seen: span(1, 10) } });
	const batch = `[byte-identical.txt#${ws.tags["byte-identical.txt"]}]\nPUT 30.=30:\n+X30\n[other.txt#${ws.tags["other.txt"]}]\nPUT 40.=40:\n+O40\n`;
	const result = await ws.edit(batch);
	check(
		"파일명·내용에 byte-identical 이 있어도 두 파일 거부를 한 응답에 모은다",
		result.isError && result.text.includes("byte-identical.txt의 30번 줄") && result.text.includes("other.txt의 40번 줄"),
		JSON.stringify(result.text.slice(0, 400)),
	);
}

// 교차검토 R1-OAI-3: probe 가 던지면(여기서는 두 번째 edit session 열기를 실패시킨다) 예외로 새지 않고 모은 거부와 그 오류를 돌려준다.
{
	const ws = workspace("probe-throws", { "f1.txt": { seen: span(1, 10) }, "f2.txt": { seen: span(1, 10) } }, true);
	const batch = `[f1.txt#${ws.tags["f1.txt"]}]\nPUT 30.=30:\n+F30\n[f2.txt#${ws.tags["f2.txt"]}]\nPUT 40.=40:\n+F40\n`;
	const result = await ws.edit(batch);
	check(
		"probe 예외: 첫 거부와 오류를 돌려주고 성공을 약속하지 않는다",
		result.isError &&
			!result.text.startsWith("THREW") &&
			result.text.includes("f1.txt의 30번 줄") &&
			result.text.includes("injected probe session failure") &&
			!result.text.includes("그대로 재시도해도 이제 성공한다"),
		JSON.stringify(result.text.slice(0, 400)),
	);
	check("probe 예외: 아무 파일도 쓰지 않는다", !ws.disk("f1.txt").includes("F30") && !ws.disk("f2.txt").includes("F40"), "디스크가 바뀌었다");
}

// [고정] probe 도 native 의 byte-identical no-op 횟수에 든다. no-op 파일이 낀 배치는 첫 응답에 no-op 오류가 함께 실리고,
// 고치지 않고 다시 보내면 두 번째 재전송에 STOP 이다(probe 없던 이전: 첫 응답엔 거부만, STOP 은 세 번째 재전송).
{
	const ws = workspace("noop", { "n.txt": { seen: span(1, 60) }, "u.txt": { seen: span(1, 10) } });
	const batch = `[n.txt#${ws.tags["n.txt"]}]\nPUT 5.=5:\n+n.txt line 5\n[u.txt#${ws.tags["u.txt"]}]\nPUT 30.=30:\n+U30\n`;
	const kind = (text: string) => (text.startsWith("STOP.") ? "STOP" : text.includes("produced no change") ? "noop" : text.includes("u.txt의 30번 줄") ? "unseen" : "other");
	const first = await ws.edit(batch);
	const sequence = [first.text.includes("u.txt의 30번 줄") && first.text.includes("produced no change") ? "unseen+noop" : kind(first.text)];
	for (let resend = 0; resend < 2; resend++) sequence.push(kind((await ws.edit(batch)).text));
	check("no-op 파일 낀 배치: 첫 응답에 no-op 오류가 실리고 두 번째 재전송에 STOP", sequence.join(" ") === "unseen+noop noop STOP", sequence.join(" "));
	check("no-op 파일 낀 배치: 아무 파일도 쓰지 않는다", !ws.disk("u.txt").includes("U30"), "디스크가 바뀌었다");
}

console.log(`\n결과: ${passes} pass, ${failures} fail`);
process.exit(failures === 0 ? 0 : 1);
