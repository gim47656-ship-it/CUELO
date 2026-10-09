// typesafe judgment question-bound split core patch regression (2026-10-09 WSL 회귀 감사 3.5).
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core>/pi-coding-agent bun run patches/core-typesafe-split-test.ts
// 외부 호출은 없다. fetch 는 메모리 stub 이고, Experiential Labs gateway 의 입장 검사
// (experientiallabs/experiential exp/runtime/gateway/decisions_contracts.py)를 옮겨 typesafe 경로로 나가는 본문마다 적용한다.
// 검사에 걸리면 실제 gateway 처럼 400 "Invalid decision request" 를 돌려준다.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

function resolveCore(): string {
	const override = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = override
		? [override]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(candidate => existsSync(join(candidate, "src/tools/jfind/questions.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
const PI_AI = join(CORE, "..", "..", "pi-ai", "src").replace(/\\/g, "/");
console.log(`대상 ${CORE}`);
// The core copy is chosen at runtime (OMP_CORE_PATCH_TARGET or the installed core), so these imports cannot be static.
const { TypeSafeJudge, TypeSafeApiError } = await import(`${PI_AI}/judgment/typesafe.ts`);
const { nameBatch, dirBatch, sketchBatch, passageBatch } = await import(`${CORE}/tools/jfind/questions.ts`);

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

const GATEWAY_REJECTION =
	"Invalid decision request. Send only model, state, and bounded typed questions; chat, streaming, tools, and generation controls are not supported.";

/** decisions_contracts.py 의 입장 검사. 통과하면 undefined, 걸리면 그 이유. */
function gatewayRejection(body: string): string | undefined {
	const bytes = Buffer.byteLength(body, "utf8");
	if (bytes > 262_144) return `body ${bytes} bytes > 262144`;
	const raw: unknown = JSON.parse(body);
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "body must be a JSON object";
	const pending: Array<[unknown, number]> = [[raw, 0]];
	while (pending.length > 0) {
		const [item, depth] = pending.pop()!;
		if (depth > 64) return "JSON nesting > 64";
		if (typeof item === "string" && !item.isWellFormed()) return "text is not valid UTF-8";
		if (Array.isArray(item)) for (const child of item) pending.push([child, depth + 1]);
		else if (item !== null && typeof item === "object") {
			for (const [key, child] of Object.entries(item)) pending.push([key, depth + 1], [child, depth + 1]);
		}
	}
	const keys = Object.keys(raw).sort().join(",");
	if (keys !== "model,questions,state" || !("state" in raw) || !("questions" in raw)) return `body keys ${keys}`;
	if (raw.state === null || !["string", "object"].includes(typeof raw.state)) return "state must be text, object or array";
	const questions = raw.questions;
	if (questions === null || typeof questions !== "object" || Array.isArray(questions)) return "questions must be an object";
	const entries: Array<[string, unknown]> = Object.entries(questions);
	if (entries.length < 1 || entries.length > 32) return `${entries.length} questions (1..32)`;
	for (const [id, question] of entries) {
		const idBytes = Buffer.byteLength(id, "utf8");
		if (idBytes < 1 || idBytes > 256) return `question id of ${idBytes} bytes`;
		if (question === null || typeof question !== "object" || Array.isArray(question) || !("type" in question)) return `question ${id} has no type`;
		if (question.type !== "noul" && question.type !== "choice" && question.type !== "score") return `question type ${String(question.type)}`;
		const extra = Object.keys(question).filter(field => !["type", "instructions", "criteria"].includes(field));
		if (extra.length > 0) return `extra question fields ${extra.join(",")}`;
		if (!("instructions" in question) || question.instructions === null || !["string", "object"].includes(typeof question.instructions)) return "instructions type";
	}
	return undefined;
}

interface Sent {
	path: string;
	body: string;
	ids: string[];
	state: unknown;
	model: string;
}

/** What the judge sends: `JSON.stringify({ state, model, questions })` in typesafe.ts. */
interface SentBody {
	state: unknown;
	model: string;
	questions: Record<string, { type: string }>;
}

interface StubOptions {
	/** Answer this request with 400 although the gateway would admit it. */
	failWhen?: (ids: string[]) => boolean;
	/** Billed cost the route reports for this request (OpenRouter style); absent when undefined. */
	cost?: (ids: string[]) => number | undefined;
}

function stubFetch(sent: Sent[], options: StubOptions = {}): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const body = String(init?.body);
		const parsed: SentBody = JSON.parse(body);
		const ids = Object.keys(parsed.questions);
		sent.push({ path: url.pathname, body, ids, state: parsed.state, model: parsed.model });
		const rejected = url.pathname.endsWith("/v1/systemone") ? gatewayRejection(body) : undefined;
		if (rejected !== undefined || options.failWhen?.(ids)) {
			return Response.json(
				{ error: { message: GATEWAY_REJECTION, type: "invalid_request_error", param: "body", code: "invalid_field" } },
				{ status: 400 },
			);
		}
		const answers = Object.fromEntries(ids.map((id, k) => [id, { type: parsed.questions[id]!.type, noul: (k % 10) / 10 }]));
		const cost = options.cost?.(ids);
		return Response.json({
			model: parsed.model,
			answers,
			usage: { input_tokens: 1000 + ids.length, output_tokens: 20 * ids.length, ...(cost === undefined ? {} : { cost }) },
		});
	}) as typeof fetch;
}

type Route = "typesafe" | "openrouter-decisions";
function judgeFor(route: Route, fetchImpl: typeof fetch) {
	return new TypeSafeJudge({
		apiKey: "test-key",
		api: route,
		provider: route === "typesafe" ? "typesafe" : "openrouter",
		baseUrl: route === "typesafe" ? "https://api.experientiallabs.ai" : "https://openrouter.ai/api/alpha",
		model: route === "typesafe" ? "jev-latest" : "~typesafe/jev-latest",
		fetch: fetchImpl,
	});
}

function noulQuestions(count: number): Record<string, { type: "noul"; instructions: string }> {
	const questions: Record<string, { type: "noul"; instructions: string }> = {};
	for (let i = 0; i < count; i++) {
		const key = `e${String(i).padStart(3, "0")}`;
		questions[key] = { type: "noul", instructions: `Is the file tagged ${key} likely to match the search?` };
	}
	return questions;
}

const STATE = { search: "where the bash tool decodes child output", task: "semantic grep", tree: "# e000 src/a.ts (1.2KB)" };

async function judged(name: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (error) {
		check(name, false, `threw ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
	}
}

console.log("typesafe 경로: gateway 의 요청당 32문항 한도로 나눠 보내고 합친다");
await judged("64문항 판정", async () => {
	const sent: Sent[] = [];
	const questions = noulQuestions(64);
	const result = await judgeFor("typesafe", stubFetch(sent)).judge({ state: STATE, questions });
	// Parts may reach fetch in any order; compare them in the order of their first question id.
	const parts = [...sent].sort((a, b) => (a.ids[0] ?? "").localeCompare(b.ids[0] ?? ""));
	check("64문항은 32문항 두 요청으로 나간다", parts.length === 2 && parts.every(part => part.ids.length === 32), `sizes=${parts.map(part => part.ids.length)}`);
	check("나눈 요청은 모두 gateway 입장 검사를 통과한다", parts.every(part => gatewayRejection(part.body) === undefined), parts.map(part => gatewayRejection(part.body)).join(";"));
	check(
		"각 요청은 같은 state·model 을 싣고 질문은 원래 순서로 한 번씩만 나뉜다",
		parts.every(part => isDeepStrictEqual(part.state, STATE) && part.model === "jev-latest" && part.path === "/v1/systemone") &&
			isDeepStrictEqual(parts.flatMap(part => part.ids), Object.keys(questions)),
		parts.map(part => `${part.ids[0]}..${part.ids.at(-1)}`).join(" "),
	);
	check("64문항 답이 모두 요청한 type 으로 온다", Object.keys(questions).every(id => result.answers[id]?.type === "noul"), `answers=${Object.keys(result.answers).length}`);
	check(
		"사용량은 두 요청의 합이고 비용을 보고하지 않으면 0 이다",
		result.usage.input === 2 * (1000 + 32) && result.usage.output === 2 * 20 * 32 && result.usage.cost.total === 0,
		`input=${result.usage.input} output=${result.usage.output} cost=${result.usage.cost.total}`,
	);
	check("응답 model 을 그대로 보고한다", result.model === "jev-latest" && result.provider === "typesafe", `${result.provider}/${result.model}`);
});
await judged("33문항 판정", async () => {
	const sent: Sent[] = [];
	const result = await judgeFor("typesafe", stubFetch(sent)).judge({ state: STATE, questions: noulQuestions(33) });
	const parts = [...sent].sort((a, b) => (a.ids[0] ?? "").localeCompare(b.ids[0] ?? ""));
	check("33문항은 32 + 1 두 요청이다", isDeepStrictEqual(parts.map(part => part.ids.length), [32, 1]), `sizes=${parts.map(part => part.ids.length)}`);
	check("33문항 답이 모두 온다", Object.keys(result.answers).length === 33, `answers=${Object.keys(result.answers).length}`);
});
await judged("32문항 이하 판정", async () => {
	for (const count of [1, 32]) {
		const sent: Sent[] = [];
		const questions = noulQuestions(count);
		await judgeFor("typesafe", stubFetch(sent)).judge({ state: STATE, questions });
		check(
			`${count}문항은 한 요청이고 본문이 원래 식과 바이트까지 같다`,
			sent.length === 1 && sent[0]!.body === JSON.stringify({ state: STATE, model: "jev-latest", questions }),
			`requests=${sent.length}`,
		);
	}
});
await judged("비용 합산", async () => {
	const sent: Sent[] = [];
	const result = await judgeFor("typesafe", stubFetch(sent, { cost: ids => ids.length * 0.0001 })).judge({ state: STATE, questions: noulQuestions(40) });
	check("각 요청이 보고한 비용을 더한다", sent.length === 2 && Math.abs(result.usage.cost.total - 0.004) < 1e-12, `cost=${result.usage.cost.total}`);
});
await judged("한 부분 실패", async () => {
	const sent: Sent[] = [];
	let error: unknown;
	try {
		await judgeFor("typesafe", stubFetch(sent, { failWhen: ids => ids.includes("e040") })).judge({ state: STATE, questions: noulQuestions(64) });
	} catch (caught) {
		error = caught;
	}
	check(
		"한 부분이 400 이면 부분 결과 없이 그 오류로 실패하고 다시 보내지 않는다",
		error instanceof Error && error instanceof TypeSafeApiError && error.message.includes("(400)") && sent.length === 2,
		`error=${error instanceof Error ? error.message.slice(0, 120) : String(error)} requests=${sent.length}`,
	);
});

console.log("openrouter-decisions 경로는 그대로다");
await judged("openrouter 64문항", async () => {
	const sent: Sent[] = [];
	const result = await judgeFor("openrouter-decisions", stubFetch(sent)).judge({ state: STATE, questions: noulQuestions(64) });
	check(
		"openrouter-decisions 는 64문항도 한 요청으로 보낸다",
		sent.length === 1 && sent[0]!.ids.length === 64 && sent[0]!.path === "/api/alpha/decisions" && Object.keys(result.answers).length === 64,
		`requests=${sent.length} sizes=${sent.map(part => part.ids.length)} path=${sent[0]?.path}`,
	);
});

// find 가 실제로 만드는 네 가지 요청(cascade 의 최대 배치: NAME_BATCH·DIR_BATCH 64, SKETCH_CARDS_MAX 48, 한 파일의 WINDOWS 24)을
// jfind/questions.ts 그대로 만들어 typesafe 경로로 판정한다. 2026-10-09 기록상 35문항 이상 요청은 전부 이 400 이었다.
console.log("find 요청 모양: 최대 배치도 gateway 입장 검사를 통과한다");
const QUERY = "where the bash tool decodes child process output bytes";
const shapes: Array<[string, { state: unknown; questions: Record<string, unknown> }]> = [];
shapes.push([
	"filename 64",
	nameBatch(
		"CUELO-private",
		QUERY,
		Array.from({ length: 64 }, (_, i) => ({ path: `/repo/src/area-${i % 6}/module-${i}.ts`, rel: `src/area-${i % 6}/module-${i}.ts`, size: 900 + 37 * i })),
	),
]);
if (typeof dirBatch === "function") {
	shapes.push([
		"folder 64",
		dirBatch(
			"CUELO-private",
			QUERY,
			Array.from({ length: 64 }, (_, i) => ({ path: `packages/pkg-${i}/src`, summary: `${12 + i} files, 3 subfolders, .ts×${10 + i} .md×2: index.ts, exec.ts, decode.ts, shell.ts` })),
		),
	]);
} else {
	console.log("  (이 core 에는 folder 판정 요청(dirBatch)이 없다: folder 모양은 세지 않는다)");
}
shapes.push([
	"sketch 48",
	sketchBatch(
		QUERY,
		Array.from({ length: 48 }, (_, i) => ({
			fileKey: `f${String(i % 20).padStart(2, "0")}`,
			rel: `src/area-${i % 6}/module-${i % 20}.ts`,
			sketch: Array.from({ length: 8 }, (_, line) => `L${10 * i + line}| const chunk${line} = decoder.decode(bytes, { stream: true }); // 한글 주석`).join("\n").slice(0, 384),
		})),
	),
]);
shapes.push([
	"passage 24",
	passageBatch(
		QUERY,
		"src/exec/bash-executor.ts",
		Array.from({ length: 24 }, (_, i) => ({
			start: 40 * i + 1,
			end: 40 * i + 30,
			text: Array.from({ length: 30 }, (_, line) => `L${40 * i + 1 + line}| enqueueChunk(chunk); // ${"x".repeat(line % 7)}`).join("\n"),
			score: 1 + (i % 3),
		})),
	),
]);
for (const [name, request] of shapes) {
	await judged(name, async () => {
		const sent: Sent[] = [];
		const result = await judgeFor("typesafe", stubFetch(sent)).judge(request);
		const total = Object.keys(request.questions).length;
		check(
			`${name}: ${total}문항이 ${Math.ceil(total / 32)}요청으로 나가 모두 gateway 입장 검사를 통과하고 모든 답이 온다`,
			sent.length === Math.ceil(total / 32) &&
				sent.every(part => gatewayRejection(part.body) === undefined) &&
				Object.keys(request.questions).every(id => result.answers[id] !== undefined),
			`requests=${sent.length} sizes=${sent.map(part => part.ids.length)} rejections=${sent.map(part => gatewayRejection(part.body) ?? "ok").join(",")} bytes=${sent.map(part => part.body.length).join(",")}`,
		);
	});
}

console.log(`\n결과 ${pass} pass / ${fail} fail`);
process.exitCode = fail === 0 ? 0 : 1;
