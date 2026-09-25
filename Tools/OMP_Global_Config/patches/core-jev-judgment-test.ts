// Vercel Jev typed judgment core patch regression.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-jev-judgment-test.ts
// 실제 외부 호출은 없으며 모든 fetch·credential resolver·Settings 입력은 메모리 fixture 이거나
// 임시 디렉터리 파일이다. 라이브 프로필·credential·HTTP 는 건드리지 않는다.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function resolveCore(): string {
	const override = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = override
		? [override]
		: [join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(candidate => existsSync(join(candidate, "src/judgment/index.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const {
	VERCEL_JUDGMENT_AUTH_PROVIDER,
	VERCEL_JUDGMENT_ENDPOINT,
	VERCEL_JUDGMENT_MODEL,
	VERCEL_JUDGMENT_PROVIDER,
	VercelJudge,
	resolveJudge,
} = await import(`${CORE}/judgment/index.ts`);
const { SETTINGS_SCHEMA } = await import(`${CORE}/config/settings-schema.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);

let pass = 0;
function ok(name: string): void {
	pass += 1;
	console.log(`  PASS  ${name}`);
}

assert.deepEqual(SETTINGS_SCHEMA["providers.judgmentProvider"].values, ["auto", "vercel"]);
assert.equal(SETTINGS_SCHEMA["providers.judgmentProvider"].default, "auto");
ok("settings schema는 auto/vercel 두 값만 노출한다");

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const request = {
	state: { task: "structured-summary", attempts: 1 },
	questions: {
		route: {
			type: "choice" as const,
			instructions: "Choose a route",
			criteria: { existing: "Reuse", new: "Create" },
		},
		severity: {
			type: "score" as const,
			instructions: "Score severity",
			criteria: ["low", "medium", "high"] as [string, string, ...string[]],
		},
		retry: {
			type: "noul" as const,
			instructions: "Should this retry?",
			criteria: { true: "Retry", false: "Stop" },
		},
	},
};

const successPayload = {
	answers: {
		route: { type: "choice", choice: "new", probabilities: { existing: 0.1, new: 0.9 } },
		severity: { type: "score", score: 1.3, probabilities: { "0": 0.2, "1": 0.3, "2": 0.5 } },
		retry: { type: "boolean", probability: 0.75 },
	},
	usage: { inputTokens: 420, outputTokens: 70 },
	rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
	providerMetadata: { typesafe: { confidence: { route: 0.84, severity: 0.67 } } },
};

{
	const key = "fixture-key-never-log";
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const judge = new VercelJudge({
		apiKey: key,
		fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			return jsonResponse(successPayload);
		},
	});
	const result = await judge.judge(request);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.url, VERCEL_JUDGMENT_ENDPOINT);
	assert.equal(calls[0]?.init.method, "POST");
	const headers = new Headers(calls[0]?.init.headers);
	assert.equal(headers.get("authorization"), `Bearer ${key}`);
	assert.equal(headers.get("content-type"), "application/json");
	assert.equal(headers.get("ai-gateway-protocol-version"), "0.0.1");
	assert.equal(headers.get("ai-gateway-auth-method"), "api-key");
	assert.equal(headers.get("ai-evaluation-model-specification-version"), "4");
	assert.equal(headers.get("ai-model-id"), VERCEL_JUDGMENT_MODEL);
	const body = JSON.parse(String(calls[0]?.init.body));
	assert.deepEqual(Object.keys(body), ["state", "questions"]);
	assert.deepEqual(body.state, request.state);
	assert.equal(body.questions.retry.type, "boolean");
	assert.equal(body.questions.route.type, "choice");
	assert.equal(body.questions.severity.type, "score");
	assert.deepEqual(result.answers.route, {
		type: "choice",
		choice: "new",
		probabilities: { existing: 0.1, new: 0.9 },
		confidence: 0.84,
	});
	assert.deepEqual(result.answers.severity, {
		type: "score",
		score: 1.3,
		probabilities: { "0": 0.2, "1": 0.3, "2": 0.5 },
		confidence: 0.67,
	});
	assert.deepEqual(result.answers.retry, { type: "noul", noul: 0.75 });
	assert.equal(result.usage.input, 420);
	assert.equal(result.usage.output, 70);
	ok("exact URL/header/body와 choice·score·Noul 변환");
}

{
	let fetchCalls = 0;
	const judge = new VercelJudge({
		apiKey: async () => undefined,
		fetch: async () => {
			fetchCalls += 1;
			return jsonResponse(successPayload);
		},
	});
	await assert.rejects(judge.judge(request), /API key is not configured/);
	assert.equal(fetchCalls, 0);
	ok("credential 없음은 network 전에 실패");
}

{
	let fetchCalls = 0;
	const judge = new VercelJudge({
		apiKey: "your-fixture-key",
		fetch: async () => {
			fetchCalls += 1;
			return jsonResponse({ echoedSecret: "your-fixture-key" }, 503);
		},
	});
	await assert.rejects(
		judge.judge(request),
		error => error instanceof Error && error.message.includes("HTTP 503") && !error.message.includes("your-fixture-key"),
	);
	assert.equal(fetchCalls, 1);
	ok("non-2xx는 body·secret 없이 한 번만 실패");
}

{
	let fetchCalls = 0;
	const judge = new VercelJudge({
		apiKey: "your-fixture-key",
		timeoutMs: 10,
		fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
			fetchCalls += 1;
			return await new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		},
	});
	await assert.rejects(judge.judge(request), error => error instanceof Error && error.name === "TimeoutError");
	assert.equal(fetchCalls, 1);
	ok("timeout은 한 요청에서 종료");
}

{
	const malformed = [
		{
			name: "answer id 불일치",
			payload: { ...successPayload, answers: { ...successPayload.answers, extra: { type: "boolean", probability: 0.5 } } },
		},
		{
			name: "choice type 불일치",
			payload: { ...successPayload, answers: { ...successPayload.answers, route: { type: "boolean", probability: 0.5 } } },
		},
		{
			name: "확률 범위 초과",
			payload: { ...successPayload, answers: { ...successPayload.answers, retry: { type: "boolean", probability: 1.1 } } },
		},
		{
			name: "distribution 합 불일치",
			payload: { ...successPayload, answers: { ...successPayload.answers, route: { type: "choice", choice: "new", probabilities: { existing: 0.3, new: 0.3 } } } },
		},
		{
			name: "score weighted mean 불일치",
			payload: { ...successPayload, answers: { ...successPayload.answers, severity: { type: "score", score: 0.1, probabilities: { "0": 0.2, "1": 0.3, "2": 0.5 } } } },
		},
		{
			name: "confidence 누락",
			payload: { ...successPayload, providerMetadata: { typesafe: { confidence: { route: 0.8 } } } },
		},
		{
			name: "usage malformed",
			payload: { ...successPayload, usage: { inputTokens: -1, outputTokens: 2 } },
		},
	];
	for (const scenario of malformed) {
		const judge = new VercelJudge({ apiKey: "your-fixture-key", fetch: async () => jsonResponse(scenario.payload) });
		await assert.rejects(judge.judge(request), /Vercel judgment response/);
		ok(`malformed 거부: ${scenario.name}`);
	}
}

/** explicit vercel 선택과 후보 pool 호출 수를 함께 세는 registry stub. */
function vercelHarness(options: { fetch: typeof fetch; onUsage?: (usage: unknown) => void }) {
	const counters = { fetch: 0, pool: 0 };
	const settings = {
		get: (path: string) => (path === "providers.judgmentProvider" ? "vercel" : undefined),
	};
	const registry = {
		authStorage: {
			keys: {
				resolver(provider: string) {
					assert.equal(provider, VERCEL_JUDGMENT_AUTH_PROVIDER);
					return "fixture-key";
				},
			},
		},
		getAvailable() {
			counters.pool += 1;
			return [];
		},
		resolver() {
			counters.pool += 1;
			return undefined;
		},
		getApiKey() {
			counters.pool += 1;
			return undefined;
		},
	};
	const judge = resolveJudge({
		settings: settings as never,
		registry: registry as never,
		sessionId: "fixture-session",
		fetch: options.fetch,
		onUsage: options.onUsage as never,
	});
	return { judge, counters };
}

{
	const usages: Array<Record<string, unknown>> = [];
	const { judge, counters } = vercelHarness({
		fetch: async () => {
			counters.fetch += 1;
			return jsonResponse(successPayload);
		},
		onUsage: usage => usages.push(usage as Record<string, unknown>),
	});
	const kinds: string[] = [];
	const result = await judge.withCandidate((candidate, kind) => {
		kinds.push(kind);
		return candidate.judge(request);
	});
	assert.deepEqual(kinds, ["native"]);
	assert.equal(counters.fetch, 1);
	assert.equal(counters.pool, 0);
	assert.equal(usages.length, 1);
	assert.equal(usages[0]?.role, VERCEL_JUDGMENT_PROVIDER);
	assert.equal(usages[0]?.provider, VERCEL_JUDGMENT_AUTH_PROVIDER);
	assert.equal(usages[0]?.stopReason, "stop");
	assert.deepEqual(result.answers.retry, { type: "noul", noul: 0.75 });
	ok("explicit vercel은 withCandidate에서 native 분류로 한 번 실행되고 후보 pool을 보지 않는다");
}

{
	const { judge, counters } = vercelHarness({
		fetch: async () => {
			counters.fetch += 1;
			return jsonResponse({}, 500);
		},
	});
	await assert.rejects(judge.withCandidate(candidate => candidate.judge(request)), /HTTP 500/);
	assert.equal(counters.fetch, 1);
	assert.equal(counters.pool, 0);
	ok("explicit vercel 실패는 tiny·smol·default·session fallback 0건으로 caller에 전파");
}

{
	const { judge, counters } = vercelHarness({
		fetch: async () => {
			counters.fetch += 1;
			return jsonResponse(successPayload);
		},
	});
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		judge.withCandidate(candidate => candidate.judge(request, { signal: controller.signal })),
		error => (error as Error | undefined)?.name === "AbortError",
	);
	assert.equal(counters.fetch, 0);
	ok("abort는 요청 전에 caller로 전파");
}

{
	// `auto`(그 밖의 값)는 upstream role chain 이다. 후보가 없으면 chain 이 실패하고 Vercel
	// adapter 는 fetch 를 한 번도 부르지 않는다.
	let fetchCalls = 0;
	const judge = resolveJudge({
		settings: { get: (path: string) => (path === "providers.judgmentProvider" ? "auto" : undefined) } as never,
		registry: { getAvailable: () => [] } as never,
		fetch: async () => {
			fetchCalls += 1;
			return jsonResponse(successPayload);
		},
	});
	let autoError: unknown;
	try {
		await judge.withCandidate(candidate => candidate.judge(request));
	} catch (error) {
		autoError = error;
	}
	assert.ok(autoError !== undefined, "후보 없는 auto chain은 실패해야 한다");
	assert.equal(fetchCalls, 0);
	ok("auto는 upstream judge role chain으로 가고 Vercel adapter를 쓰지 않는다");
}

{
	// 실제 Settings 로딩을 한 번 통과시킨다. mock settings.get 은 migration 결함을 못 잡는다:
	// 18.2.7 의 legacy migration 은 `providers.judgmentProvider` 를 삭제하고 judge role chain 을
	// 주입하므로, vercel 선택이 살아남는지와 뜻밖의 주입이 없는지를 여기서 본다.
	const root = mkdtempSync(join(tmpdir(), "omp-judgment-provider-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const load = (value: string) => {
		const file = join(root, `config-${value}.yml`);
		writeFileSync(file, `providers:\n  judgmentProvider: ${value}\nmodelRoles:\n  default: openai-codex/gpt-6-astra\n`, "utf8");
		return Settings.loadIsolated({ inMemory: true, cwd, agentDir, configFiles: [file] });
	};

	const vercel = await load("vercel");
	assert.equal(vercel.get("providers.judgmentProvider"), "vercel");
	assert.equal(vercel.get("modelRoles").judge, undefined);
	assert.equal(vercel.get("retry.fallbackChains").judge, undefined);
	ok("실제 Settings 로딩에서 vercel이 남고 legacy judge role이 주입되지 않는다");

	const typesafe = await load("typesafe");
	assert.equal(typesafe.get("providers.judgmentProvider"), "auto");
	assert.equal(typesafe.get("modelRoles").judge, "typesafe/jev-latest");
	assert.deepEqual(typesafe.get("retry.fallbackChains").judge, ["@tiny", "@smol", "@default"]);
	ok("upstream migration은 typesafe 입력에서 그대로 동작한다");

	const auto = await load("auto");
	assert.equal(auto.get("providers.judgmentProvider"), "auto");
	assert.equal(auto.get("modelRoles").judge, undefined);
	assert.equal(auto.get("retry.fallbackChains").judge, undefined);
	ok("auto 입력은 키 유지도 legacy judge 주입도 하지 않는다");

	rmSync(root, { recursive: true, force: true });
}

console.log(`결과 ${pass} pass`);
