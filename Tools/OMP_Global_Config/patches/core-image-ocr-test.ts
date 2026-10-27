// OCR 전용 이미지 질문 slot 회귀(2026-10-18). `read <image>?ocr=<질문>` 은 modelRoles.ocr 모델이, `?q=<질문>` 은
// 그대로 modelRoles.vision 모델이 답해야 한다. 질문 종류는 모델 추측이 아니라 쿼리 키로 정한다(좌표 질문이 Gemini 로 새면
// 크게 틀린다. OCR 질문이 Opus 로 가는 것은 정확도 손해가 없다).
// [선택] ocr slot 이 있으면 ?ocr= 은 그 모델, ?q= 은 vision 모델. thinking 은 각자 selector(:low 등)를 따른다.
// [폴백] ocr slot 이 없거나 모델이 목록에 없거나 이미지 입력이 안 되면 ?ocr= 도 ?q= 과 같은 순서(@vision → @default → 활성 모델)로 간다.
// [후보군] retry.fallbackChains.ocr 가 @ocr 다음 순서다. 고른 모델이 실패하면 남은 후보, 마지막으로 vision 모델에 묻고 답 앞에 실패한
//          모델을 밝힌다. 호출자 abort 와 ?q= 질문은 넘기지 않는다.
// [거절] ?q= 와 ?ocr= 를 함께 주면 추측하지 않고 ToolError. 이미지가 아닌 대상은 두 selector 모두 같은 오류.
// [안내] read 도구 설명과 텍스트 전용 모델용 메타데이터 안내가 ?ocr= 를 알려 준다.
// patch는 임시 source fixture에만 적용한다. OCR_BASELINE=1 이면 target 설치본 원본을 읽는다(수정 전 RED 확인용).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

if (!process.env.OMP_OCR_TEST_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-image-ocr-"));
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
				OMP_OCR_TEST_ROOT: root,
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
const temp = process.env.OMP_OCR_TEST_ROOT;
const fixture = join(temp, "target");
const patchHome = join(temp, "patch-home");
const toUrl = (path: string) => path.replace(/\\/g, "/");
const baseline = process.env.OCR_BASELINE === "1";
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
	name: "image-ocr-fixture",
	setup(build) {
		build.onLoad({ filter: /[/\\]@oh-my-pi[/\\][\w-]+[/\\].+\.ts$/ }, args => {
			const [pkg, ...rest] = toUrl(args.path).split("/@oh-my-pi/").at(-1)!.split("/");
			const patched = pkg === corePackage ? join(fixture, ...rest) : join(fixture, "..", pkg!, ...rest);
			const contents = readFileSync(baseline || !existsSync(patched) ? args.path : patched, "utf8");
			if (args.path.endsWith(".d.ts")) return { exports: { default: contents }, loader: "object" };
			return { contents, loader: "ts" };
		});
		// read.ts imports its tool description as text (`with { type: "text" }`); serve the patched prompt, not the installed one.
		build.onLoad({ filter: /[/\\]@oh-my-pi[/\\][\w-]+[/\\].+\.md$/ }, args => {
			const [pkg, ...rest] = toUrl(args.path).split("/@oh-my-pi/").at(-1)!.split("/");
			const patched = pkg === corePackage ? join(fixture, ...rest) : join(fixture, "..", pkg!, ...rest);
			return { exports: { default: readFileSync(baseline || !existsSync(patched) ? args.path : patched, "utf8") }, loader: "object" };
		});
	},
});
// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET, so these cannot be static imports.
const { setAgentDir } = await import(toUrl(join(dirname(core), "pi-utils/src/dirs.ts")));
setAgentDir(join(process.env.HOME!, ".omp", "agent"));
const { Settings } = await import(toUrl(join(core, "src/config/settings.ts")));
const { ReadTool } = await import(toUrl(join(core, "src/tools/read.ts")));

const files = join(temp, "files");
mkdirSync(files, { recursive: true });
// 1x1 PNG. 이미지 질문 경로가 파일을 실제로 읽고 디코드한다.
writeFileSync(
	join(files, "shot.png"),
	Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"),
);
writeFileSync(join(files, "note.txt"), "plain text\n");

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const thinking = { mode: "anthropic-adaptive", efforts: ["low", "medium", "high"], supportsDisplay: true };
const fakeModel = (provider: string, id: string, input: string[], api = "anthropic-messages") => ({
	id,
	name: id,
	api,
	provider,
	baseUrl: "https://example.invalid",
	reasoning: true,
	thinking,
	input,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 8000,
});
const opus = fakeModel("anthropic", "claude-opus-5-5", ["text", "image"]);
const gemini = fakeModel("google-antigravity", "gemini-3.8-flash", ["text", "image"], "google-gemini-cli");
const textOnlyOcr = fakeModel("google-antigravity", "gemini-3.8-flash", ["text"], "google-gemini-cli");
const sonnet = fakeModel("anthropic", "claude-sonnet-5-5", ["text", "image"]);
// Registry models on openai-completions always carry `compat`; sendsImageInputOnWire reads it.
const hiveDeepseek = { ...fakeModel("hive", "deepseek-ai/deepseek-v4.1-flash-1017", ["text", "image"], "openai-completions"), compat: {} };

interface Call {
	model: string;
	reasoning: unknown;
	question: string | undefined;
}
async function ask(options: {
	roles: Record<string, string>;
	chains?: Record<string, string[]>;
	models?: unknown[];
	activeInput?: string[];
	path: string;
	/** provider/id keys whose request fails with a provider error. */
	fail?: string[];
	/** provider/id key whose request is cut by the caller's abort (the read tool's own signal). */
	abortOn?: string;
}): Promise<{ calls: Call[]; text: string; error?: string }> {
	const calls: Call[] = [];
	const settings = Settings.isolated({ modelRoles: options.roles, ...(options.chains ? { retry: { fallbackChains: options.chains } } : {}) });
	const caller = new AbortController();
	const models = options.models ?? [opus, gemini];
	const modelRegistry = {
		getAvailable: () => models,
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	};
	const session = new Proxy(
		{
			cwd: files,
			hasUI: false,
			settings,
			modelRegistry,
			getActiveModelString: () => "anthropic/claude-opus-5-5",
			getActiveModel: () => ({ ...opus, input: options.activeInput ?? ["text", "image"] }),
		} as Record<string, unknown>,
		{ get: (target, key) => (key in target ? target[key as string] : undefined) },
	);
	const complete = async (model: { provider: string; id: string }, context: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }, opts: { reasoning?: unknown }) => {
		calls.push({
			model: `${model.provider}/${model.id}`,
			reasoning: opts.reasoning,
			question: context.messages[0]?.content.find(block => block.type === "text")?.text,
		});
		const key = `${model.provider}/${model.id}`;
		if (options.abortOn === key) {
			caller.abort();
			return { role: "assistant", content: [], api: "x", provider: model.provider, model: model.id, usage, stopReason: "aborted", timestamp: Date.now() };
		}
		if (options.fail?.includes(key)) {
			// Real provider errors can carry raw multi-line bodies; the fallback notice must still be one line.
			return { role: "assistant", content: [], api: "x", provider: model.provider, model: model.id, usage, stopReason: "error", errorMessage: `upstream 503\n{"from": "${key}"}`, timestamp: Date.now() };
		}
		return { role: "assistant", content: [{ type: "text", text: `answered by ${key}` }], api: "x", provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
	};
	const tool = new ReadTool(session as never, complete as never);
	try {
		const result = await tool.execute("call", { path: options.path }, caller.signal, undefined, { settings } as never);
		return { calls, text: result.content.map((block: { text?: string }) => block.text ?? "").join("\n") };
	} catch (error) {
		return { calls, text: "", error: error instanceof Error ? error.message : String(error) };
	}
}

const split = { vision: "anthropic/claude-opus-5-5:low", ocr: "google-antigravity/gemini-3.8-flash" };

const ocr = await ask({ roles: split, path: "shot.png?ocr=표의 글자를 그대로 옮겨라" });
check(
	"?ocr= 은 modelRoles.ocr 모델(gemini-3.8-flash)이 답하고 질문 원문만 모델에 간다",
	ocr.calls.length === 1 && ocr.calls[0]!.model === "google-antigravity/gemini-3.8-flash" && ocr.calls[0]!.question === "표의 글자를 그대로 옮겨라" && ocr.text === "answered by google-antigravity/gemini-3.8-flash",
	JSON.stringify(ocr),
);

const plain = await ask({ roles: split, path: "shot.png?q=버튼이 잘렸나" });
check(
	"?q= 는 그대로 modelRoles.vision 모델(claude-opus-5-5)과 그 selector(:low)를 쓴다",
	plain.calls.length === 1 && plain.calls[0]!.model === "anthropic/claude-opus-5-5" && plain.calls[0]!.reasoning === "low" && plain.calls[0]!.question === "버튼이 잘렸나",
	JSON.stringify(plain),
);

const ocrThinking = await ask({ roles: { vision: "anthropic/claude-opus-5-5:low", ocr: "google-antigravity/gemini-3.8-flash:high" }, path: "shot.png?ocr=글자" });
check("?ocr= 의 thinking 은 @ocr selector(:high)를 따른다", ocrThinking.calls[0]?.reasoning === "high", JSON.stringify(ocrThinking.calls));

const noSlot = await ask({ roles: { vision: "anthropic/claude-opus-5-5:low" }, path: "shot.png?ocr=글자" });
check(
	"ocr slot 이 없으면 ?ocr= 도 vision 모델과 그 thinking 으로 답한다",
	noSlot.calls.length === 1 && noSlot.calls[0]!.model === "anthropic/claude-opus-5-5" && noSlot.calls[0]!.reasoning === "low" && noSlot.calls[0]!.question === "글자",
	JSON.stringify(noSlot),
);

const missingModel = await ask({ roles: split, models: [opus], path: "shot.png?ocr=글자" });
check("ocr 모델이 사용 가능 목록에 없으면 vision 으로 폴백한다", missingModel.calls[0]?.model === "anthropic/claude-opus-5-5", JSON.stringify(missingModel));

const textOnly = await ask({ roles: split, models: [opus, textOnlyOcr], path: "shot.png?ocr=글자" });
check("ocr 모델이 이미지 입력을 못 받으면 vision 으로 폴백한다", textOnly.calls[0]?.model === "anthropic/claude-opus-5-5", JSON.stringify(textOnly));

const both = await ask({ roles: split, path: "shot.png?q=a&ocr=b" });
check("?q= 와 ?ocr= 를 함께 주면 모델을 부르지 않고 오류를 낸다", both.calls.length === 0 && /\?q=.*\?ocr=|\?ocr=.*\?q=/.test(both.error ?? "") && /not both|only one|either/i.test(both.error ?? ""), JSON.stringify(both));
// 18.13.2: 파일 경로의 질문은 리터럴 파일 판별 뒤에, media 대상 `local://`·`artifact://` 의 질문은 execute 에서 뗀다. 두 키 거절은 두 자리에서 같아야 한다.
const localBoth = await ask({ roles: split, path: "local://shot.png?q=a&ocr=b" });
check("local:// 이미지 대상도 ?q= 와 ?ocr= 를 함께 주면 모델을 부르지 않고 같은 오류를 낸다", localBoth.calls.length === 0 && /not both/.test(localBoth.error ?? ""), JSON.stringify(localBoth));
// 두 키가 "있는지"로 거절한다. 빈 값이어도 어느 쪽 의도인지 추측하지 않는다.
for (const path of ["shot.png?q=&ocr=transcribe", "shot.png?q=describe&ocr="]) {
	const empty = await ask({ roles: split, path });
	check(`값이 비어 있어도 두 키가 함께 있으면 거절한다: ${path}`, empty.calls.length === 0 && /not both/.test(empty.error ?? ""), JSON.stringify(empty));
}
// OCR 표식은 문자열 앞에 붙는 in-band 값이다. ?q= 질문이 그 표식(NUL + "ocr:")으로 시작해도 OCR 로 가면 안 된다.
const forged = await ask({ roles: split, path: "shot.png?q=%00ocr%3Adescribe" });
check(
	"?q= 질문 안의 NUL 은 OCR 표식으로 읽히지 않는다(vision 모델, 질문에서 NUL 만 제거)",
	forged.calls.length === 1 && forged.calls[0]!.model === "anthropic/claude-opus-5-5" && forged.calls[0]!.question === "ocr:describe",
	JSON.stringify(forged),
);
const forgedOcr = await ask({ roles: split, path: "shot.png?ocr=%00%00x" });
check("?ocr= 값 안의 NUL 도 제거되어 모델에는 질문 글자만 간다", forgedOcr.calls[0]?.model === "google-antigravity/gemini-3.8-flash" && forgedOcr.calls[0]?.question === "x", JSON.stringify(forgedOcr));

// [후보군] 2026-10-21: `retry.fallbackChains.ocr` 는 OCR 후보 순서다. 고른 모델이 실패하면 다음 후보, 마지막으로 vision 모델에 묻는다.
const all = [opus, gemini, sonnet, hiveDeepseek];
const ocrChain = { ocr: ["anthropic/claude-sonnet-5-5:low", "hive/deepseek-ai/deepseek-v4.1-flash-1017"] };
const healthy = await ask({ roles: split, chains: ocrChain, models: all, path: "shot.png?ocr=글자" });
check("후보군이 있어도 ocr 모델이 답하면 한 번만 묻고 안내 줄을 달지 않는다", healthy.calls.length === 1 && healthy.text === "answered by google-antigravity/gemini-3.8-flash", JSON.stringify(healthy));

const failover = await ask({ roles: split, chains: ocrChain, models: all, fail: ["google-antigravity/gemini-3.8-flash"], path: "shot.png?ocr=글자" });
check(
	"ocr 모델이 실패하면 후보군 첫 모델이 그 selector thinking(:low)으로 같은 질문에 답하고, 실패한 모델을 답 앞에 밝힌다",
	failover.calls.map(call => call.model).join(",") === "google-antigravity/gemini-3.8-flash,anthropic/claude-sonnet-5-5" &&
		failover.calls[1]!.reasoning === "low" && failover.calls[1]!.question === "글자" &&
		/^\[OCR fallback: google-antigravity\/gemini-3\.8-flash failed \(upstream 503[^\n]*answered by anthropic\/claude-sonnet-5-5\]\nanswered by anthropic\/claude-sonnet-5-5$/.test(failover.text),
	JSON.stringify(failover),
);

const exhausted = await ask({ roles: split, chains: ocrChain, models: all, fail: ["google-antigravity/gemini-3.8-flash", "anthropic/claude-sonnet-5-5", "hive/deepseek-ai/deepseek-v4.1-flash-1017", "anthropic/claude-opus-5-5"], path: "shot.png?ocr=글자" });
check(
	"후보가 모두 실패하면 ocr → 후보군 순서 → vision 모델까지 한 번씩 묻고, 오류가 모든 후보의 실패를 밝힌다",
	exhausted.calls.map(call => call.model).join(",") === "google-antigravity/gemini-3.8-flash,anthropic/claude-sonnet-5-5,hive/deepseek-ai/deepseek-v4.1-flash-1017,anthropic/claude-opus-5-5" &&
		/Every OCR candidate failed/.test(exhausted.error ?? "") && (exhausted.error ?? "").split("upstream 503").length === 5,
	JSON.stringify(exhausted),
);

const ocrMissing = await ask({ roles: split, chains: ocrChain, models: [opus, sonnet, hiveDeepseek], path: "shot.png?ocr=글자" });
check("ocr 모델을 쓸 수 없으면 vision 이 아니라 후보군 첫 모델이 먼저 답한다", ocrMissing.calls.length === 1 && ocrMissing.calls[0]!.model === "anthropic/claude-sonnet-5-5", JSON.stringify(ocrMissing));

const callerAbort = await ask({ roles: split, chains: ocrChain, models: all, abortOn: "google-antigravity/gemini-3.8-flash", path: "shot.png?ocr=글자" });
check("호출자가 끊은 요청은 다음 후보로 넘기지 않는다", callerAbort.calls.length === 1 && callerAbort.error !== undefined, JSON.stringify(callerAbort));

const visionFails = await ask({ roles: split, chains: ocrChain, models: all, fail: ["anthropic/claude-opus-5-5"], path: "shot.png?q=버튼이 잘렸나" });
check("?q= 질문은 후보군을 쓰지 않고 vision 모델 실패를 그대로 돌려준다", visionFails.calls.length === 1 && /upstream 503/.test(visionFails.error ?? "") && !/OCR/.test(visionFails.error ?? ""), JSON.stringify(visionFails));

const nonImage = await ask({ roles: split, path: "note.txt?ocr=글자" });
check("이미지가 아닌 파일의 ?ocr= 는 ?q= 와 같은 selector 오류다", nonImage.calls.length === 0 && /only support images/.test(nonImage.error ?? "") && /\?ocr=/.test(nonImage.error ?? ""), JSON.stringify(nonImage));

const textOnlyActive = await ask({ roles: split, activeInput: ["text"], path: "shot.png" });
check(
	"텍스트 전용 모델의 이미지 메타데이터 안내가 ?q= 와 ?ocr= 를 함께 알려 준다",
	textOnlyActive.calls.length === 0 && textOnlyActive.text.includes("shot.png?q=<question>") && textOnlyActive.text.includes("shot.png?ocr=<question>"),
	JSON.stringify(textOnlyActive.text.slice(-300)),
);

const description: string = new ReadTool(new Proxy({ cwd: files, hasUI: false, settings: Settings.isolated({}) } as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : undefined) }) as never).description;
check("read 도구 설명이 ?ocr= 를 ?q= 옆에 알려 준다", description.includes("?ocr=") && description.includes("?q=<"), JSON.stringify(description.match(/.{80}images:.{200}/s)?.[0]));

console.log(`\n결과: ${passes} pass, ${failures} fail`);
process.exit(failures === 0 ? 0 : 1);
