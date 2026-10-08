// find hierarchical directory pass regression (jfind cascade: files past the lexical candidate cap).
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-find-hierarchy-test.ts
// 실제 외부 호출은 없다. judge 는 메모리 stub 이고, 파일 트리는 임시 디렉터리다. 라이브 프로필·credential 은 건드리지 않는다.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

function resolveCore(): string {
	const override = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = override
		? [override]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(candidate => existsSync(join(candidate, "src/tools/jfind/cascade.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const { runCascade } = await import(`${CORE}/tools/jfind/cascade.ts`);
const { resolveSearchRoot } = await import(`${CORE}/tools/jfind/tree.ts`);
const { InternalUrlFilesystem } = await import(`${CORE}/internal-urls/url-filesystem.ts`);

type Answers = Record<string, { noul: number }>;
interface Seen {
	kind: "folder" | "name" | "sketch" | "verify";
	json: string;
	questions: number;
}
interface StubOptions {
	/** folder probability by folder path */
	folder?: (dir: string) => number;
	/** throw for this request kind (provider failure) */
	failKind?: Seen["kind"];
	/** hang the folder request until the signal aborts */
	hangFolder?: boolean;
}

/** Decision stub: GOLD text is relevant, folders named billing/wide are relevant, file names starting with gold rank first. */
function stubJudge(seen: Seen[], options: StubOptions = {}) {
	return {
		async judge(
			request: { state: Record<string, unknown>; questions: Record<string, { instructions: string }> },
			opts?: { signal?: AbortSignal },
		) {
			const state = request.state as {
				criteria: { file?: unknown; folder?: unknown };
				format?: string;
				passages?: Record<string, unknown>;
				file?: string;
			};
			const keys = Object.keys(request.questions);
			const kind: Seen["kind"] = state.format?.includes("lists folders")
				? "folder"
				: state.criteria.file !== undefined
					? "name"
					: state.file !== undefined
						? "verify"
						: "sketch";
			seen.push({ kind, json: JSON.stringify(request), questions: keys.length });
			if (options.failKind === kind) throw new Error(`stub ${kind} failure`);
			if (kind === "folder" && options.hangFolder) {
				const { promise, reject } = Promise.withResolvers<never>();
				if (opts?.signal?.aborted) reject(opts.signal.reason);
				opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
				await promise;
			}
			const answers: Answers = {};
			for (const key of keys) {
				const text = request.questions[key]!.instructions;
				let p = 0.05;
				if (kind === "folder") {
					const dir = /\("([^"]*)\/"\)/.exec(text)?.[1] ?? "";
					p = options.folder ? options.folder(dir) : /billing|wide/.test(dir) ? 0.9 : 0.1;
				} else if (kind === "name") {
					p = /\("gold/.test(text) ? 0.8 : 0.3;
				} else if (kind === "sketch") {
					const entry = (state.passages as Record<string, [string, string]>)[key];
					p = entry?.[1].includes("GOLD") ? 0.9 : 0.05;
				} else {
					const body = (state.passages as Record<string, string>)[key];
					p = body?.includes("GOLD") ? 0.9 : 0.05;
				}
				answers[key] = { noul: p };
			}
			return { answers, usage: { input: 10, output: 1, cost: { total: 0.001 } } };
		},
	};
}

function write(root: string, rel: string, text: string): void {
	const file = join(root, rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

const KEYWORDS_LINE = "frobnicate widget pipeline step\n";
interface TreeOptions {
	noise?: number;
	billing?: number;
	insideGold?: boolean;
	archive?: boolean;
}
/** noise/* outrank everything lexically; billing/* have no query word; archive/* is never admitted. */
function buildTree(options: TreeOptions = {}): string {
	const root = mkdtempSync(join(tmpdir(), "find-hierarchy-"));
	for (let i = 0; i < (options.noise ?? 140); i++) {
		write(root, `noise/n${String(i).padStart(3, "0")}.ts`, `${KEYWORDS_LINE.repeat(3)}export const n${i} = ${i};\n`);
	}
	if (options.insideGold !== false) write(root, "core/target.ts", "GOLD frobnicate widget pipeline inside the lexical cap\n".repeat(6) + "export const t = 1;\n");
	for (let i = 0; i < (options.billing ?? 3); i++) {
		write(root, `billing/gold_${String(i).padStart(3, "0")}.ts`, `// GOLD outside the lexical cap ${i}\nexport const b${i} = ${i};\n`);
	}
	write(root, "billing/other.ts", "export const filler = 1;\n");
	if (options.archive !== false) {
		write(root, "archive/trap.ts", "// GOLD TRAP_CONTENT in a folder that must not be admitted\nexport const trap = 1;\n");
		write(root, "archive/old.ts", "export const old = 1;\n");
	}
	// never searchable: secret names, hidden paths, binary extension
	write(root, "billing/secrets.yml", "SECRET_CONTENT GOLD\n");
	write(root, "billing/Credentials.json", "SECRET_CONTENT GOLD\n");
	write(root, "billing/.env", "SECRET_CONTENT GOLD\n");
	write(root, ".hidden/h.ts", "SECRET_CONTENT GOLD\n");
	write(root, "billing/photo.png", "SECRET_CONTENT GOLD\n");
	return root;
}

interface Hit {
	rel: string;
	contentScore: number;
	ranges: unknown[];
	linesSeen: number;
	truncated: boolean;
	nameScore: number | undefined;
}
interface Result {
	hits: Hit[];
	stats: { failures: string[]; errors: number; requests: number };
}
async function search(root: string, judge: unknown, signal?: AbortSignal): Promise<Result> {
	const filesystem = new InternalUrlFilesystem({ context: { cwd: root }, tier: "read" });
	const searchRoot = await resolveSearchRoot(filesystem, root, root);
	return runCascade({
		root: searchRoot,
		filesystem,
		query: "frobnicate widget pipeline",
		extraKeywords: [],
		judge,
		includeHidden: false,
		signal,
	});
}

let pass = 0;
function ok(name: string): void {
	pass += 1;
	console.log(`  PASS  ${name}`);
}
const roots: string[] = [];
const tree = (options?: TreeOptions) => {
	const root = buildTree(options);
	roots.push(root);
	return root;
};
const rels = (result: Result) => result.hits.map(hit => hit.rel).sort();
const ofKind = (seen: Seen[], kind: Seen["kind"]) => seen.filter(entry => entry.kind === kind);

try {
	// 1. 폴더 판정이 상한 밖 관련 파일을 hit 에 더하고, 폴더를 허용하지 않은 실행과 비교해 baseline hit 은 그대로다.
	{
		const root = tree();
		const off = await search(root, stubJudge([], { folder: () => 0.1 }));
		const seen: Seen[] = [];
		const on = await search(root, stubJudge(seen));
		assert.deepEqual(rels(off), ["core/target.ts"], "폴더를 하나도 허용하지 않으면 baseline 만 남는다");
		for (const base of off.hits) {
			assert.deepEqual(on.hits.find(hit => hit.rel === base.rel), base, `baseline hit 불변: ${base.rel}`);
		}
		const extra = on.hits.filter(hit => hit.rel.startsWith("billing/")).map(hit => hit.rel);
		assert.deepEqual(extra.sort(), ["billing/gold_000.ts", "billing/gold_001.ts", "billing/gold_002.ts"]);
		ok("허용된 폴더의 상한 밖 파일이 hit 에 더해지고 baseline hit 은 필드까지 그대로다");
		assert.equal(ofKind(seen, "folder").length >= 1, true);

		// 2. 허용되지 않은 폴더의 파일은 이름·sketch·verify 어디로도 나가지 않는다.
		const beyondFolder = seen.filter(entry => entry.kind !== "folder").map(entry => entry.json).join("\n");
		assert.equal(beyondFolder.includes("TRAP_CONTENT"), false);
		assert.equal(beyondFolder.includes("archive/"), false);
		assert.equal(beyondFolder.includes("old.ts"), false);
		ok("허용되지 않은 폴더의 파일은 이름·본문 판정에 전송되지 않는다");

		// 3. 비밀·숨김·binary 는 어떤 요청에도 없다.
		const all = seen.map(entry => entry.json).join("\n");
		for (const banned of ["SECRET_CONTENT", "secrets.yml", "Credentials.json", ".env", ".hidden", "photo.png"]) {
			assert.equal(all.includes(banned), false, `전송되면 안 됨: ${banned}`);
		}
		ok("secret 이름·hidden·binary 파일은 폴더 카드 포함 어떤 판정 요청에도 없다");
	}

	// 4. baseline hit 이 0개인 정상 완료도 폴더 단계를 지난다.
	{
		const root = tree({ insideGold: false });
		const seen: Seen[] = [];
		const result = await search(root, stubJudge(seen));
		assert.equal(result.hits.every(hit => hit.rel.startsWith("billing/")), true);
		assert.equal(result.hits.length, 3);
		assert.equal(ofKind(seen, "folder").length >= 1, true);
		ok("baseline hit 이 0개여도 폴더 단계가 실행돼 상한 밖 파일을 찾는다");
	}

	// 5. 후보 상한(128), read 상한(10), 이름 판정 중복 없음.
	{
		const root = tree({ billing: 200 });
		const seen: Seen[] = [];
		const result = await search(root, stubJudge(seen));
		const extra = result.hits.filter(hit => hit.rel.startsWith("billing/"));
		assert.equal(extra.length, 10, "추가 read 는 10개까지");
		const nameQuestions = ofKind(seen, "name");
		const judgedNames: string[] = [];
		for (const entry of nameQuestions) {
			for (const match of entry.json.matchAll(/file tagged e\d+ \(\\"([^"\\]+)\\"\)/g)) judgedNames.push(match[1]!);
		}
		const billingJudged = judgedNames.filter(name => name.startsWith("gold_"));
		assert.equal(billingJudged.length, 128, "상한 밖 후보 이름 판정은 128개까지");
		assert.equal(new Set(judgedNames).size, judgedNames.length, "같은 파일을 이름 판정에 두 번 보내지 않는다");
		const verifyFiles = ofKind(seen, "verify")
			.map(entry => /"file":"([^"]+)"/.exec(entry.json)?.[1])
			.filter(name => name?.startsWith("billing/"));
		assert.equal(new Set(verifyFiles).size <= 10, true, "verify 로 읽는 상한 밖 파일은 10개 이하");
		ok("상한 밖 이름 판정 128개·추가 read 10개·이름 판정 중복 없음");
	}

	// 6. 상한 밖 파일이 없으면 폴더 요청 자체가 없다.
	{
		const root = tree({ noise: 20, billing: 2 });
		const seen: Seen[] = [];
		const result = await search(root, stubJudge(seen));
		assert.equal(ofKind(seen, "folder").length, 0);
		assert.equal(result.hits.some(hit => hit.rel === "core/target.ts"), true);
		ok("파일이 상한 안이면 추가 JEV 호출이 없다");
	}

	// 7. 확률 경계: 정확히 0.5 는 허용, 0.49 는 거부.
	{
		const root = tree();
		const at = await search(root, stubJudge([], { folder: dir => (dir === "billing" ? 0.5 : 0.1) }));
		const below = await search(root, stubJudge([], { folder: dir => (dir === "billing" ? 0.49 : 0.1) }));
		assert.equal(at.hits.some(hit => hit.rel.startsWith("billing/")), true);
		assert.equal(below.hits.some(hit => hit.rel.startsWith("billing/")), false);
		ok("폴더 확률 0.5 이상만 허용한다");
	}

	// 8. 폴더·이름 판정 provider 실패는 baseline 을 지우지 않고 기록만 남긴다.
	for (const failKind of ["folder", "name"] as const) {
		const root = tree();
		const seen: Seen[] = [];
		const result = await search(root, stubJudge(seen, { failKind }));
		if (failKind === "folder") {
			assert.deepEqual(rels(result), ["core/target.ts"]);
			assert.equal(result.stats.failures.some(message => message.startsWith("folders:")), true);
		} else {
			// name 실패는 baseline 파일명 판정에도 닿으므로 baseline 이 줄 수 있다. 예외 없이 끝나고 실패가 기록된다.
			assert.equal(result.stats.failures.some(message => message.startsWith("filenames:")), true);
		}
		assert.equal(result.stats.errors > 0, true);
	}
	ok("provider 실패는 던지지 않고 stats.failures 에 남으며 폴더 실패 시 baseline hit 이 그대로다");

	// 9. 전체 timeout 은 완료된 baseline 을 보존하고, 사용자 취소는 그대로 던진다.
	{
		const root = tree();
		const seen: Seen[] = [];
		const result = await search(root, stubJudge(seen, { hangFolder: true }), AbortSignal.timeout(1500));
		assert.deepEqual(rels(result), ["core/target.ts"]);
		assert.equal(result.stats.failures.some(message => message.startsWith("hierarchy:")), true);
		ok("폴더 단계 중 timeout 이면 완료된 baseline hit 을 반환하고 실패를 기록한다");

		const controller = new AbortController();
		const pending = search(root, stubJudge([], { hangFolder: true }), AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]));
		setTimeout(() => controller.abort(), 700);
		await assert.rejects(pending);
		ok("폴더 단계 중 사용자 취소는 기존처럼 던진다");
	}
} finally {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(`\ncore-find-hierarchy-test: ${pass} groups passed`);
