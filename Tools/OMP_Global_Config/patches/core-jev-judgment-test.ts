// Jev typed judgment regression after the Vercel judge mode was retired (2026-10-17).
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-jev-judgment-test.ts
// 판정은 upstream judge role chain(modelRoles.judge, 권장 openrouter/typesafe/jev-1.14) 하나뿐이다. 옛 설정 `providers.judgmentProvider: vercel`
// 이 남은 설치도 upstream 18.11.3 의 legacy migration 이 받아 죽지 않고, Vercel endpoint 는 어떤 경로로도 호출되지 않는다.
// 실제 외부 호출은 없으며 모든 fetch·registry·Settings 입력은 메모리 fixture 이거나 임시 디렉터리 파일이다.
// 라이브 프로필·credential·HTTP 는 건드리지 않는다.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

function resolveCore(): string {
	const override = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = override
		? [override]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(candidate => existsSync(join(candidate, "src/judgment/index.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const judgment = await import(`${CORE}/judgment/index.ts`);
const { resolveJudge } = judgment;
const { lookup } = await import(`${CORE}/config/registry.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);

let pass = 0;
function ok(name: string): void {
	pass += 1;
	console.log(`  PASS  ${name}`);
}

assert.equal(judgment.VercelJudge, undefined);
assert.equal(
	Object.keys(judgment).some(name => name.startsWith("VERCEL_")),
	false,
);
assert.equal(lookup("providers.judgmentProvider"), undefined);
ok("Vercel adapter export와 providers.judgmentProvider 설정 항목이 없다");

const request = {
	state: { task: "structured-summary", attempts: 1 },
	questions: {
		retry: {
			type: "noul" as const,
			instructions: "Should this retry?",
			criteria: { true: "Retry", false: "Stop" },
		},
	},
};


{
	// 실제 Settings 로딩을 한 번 통과시킨다. mock settings.get 은 migration 결함을 못 잡는다.
	// `vercel` 은 이제 upstream legacy migration 이 읽는 비-auto 선택자다: judge role 이 없으면 typesafe/jev-latest chain 을 주입하고
	// 키는 지우며 던지지 않는다. 이미 judge role 이 있는 CUELO 프로필(openrouter/typesafe/jev-1.14)은 그대로다.
	const root = mkdtempSync(join(tmpdir(), "omp-judgment-provider-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const modelRoles = lookup("modelRoles")!;
	const fallbackChains = lookup("retry.fallbackChains")!;
	const load = (value: string, extraRoles = "") => {
		const file = join(root, `config-${value}-${extraRoles ? "judge" : "plain"}.yml`);
		writeFileSync(
			file,
			`providers:\n  judgmentProvider: ${value}\nmodelRoles:\n  default: openai-codex/gpt-6-astra\n${extraRoles}`,
			"utf8",
		);
		return Settings.loadIsolated({ inMemory: true, cwd, agentDir, configFiles: [file] });
	};

	const vercel = await load("vercel");
	assert.equal(modelRoles.get(vercel).judge, "typesafe/jev-latest");
	assert.deepEqual(fallbackChains.get(vercel).judge, ["@tiny", "@smol", "@default"]);
	ok("옛 vercel 설정은 upstream migration 이 받아 던지지 않고 typesafe judge chain 으로 옮긴다");

	const pinned = await load("vercel", "  judge: openrouter/typesafe/jev-1.14\n");
	assert.equal(modelRoles.get(pinned).judge, "openrouter/typesafe/jev-1.14");
	ok("이미 judge role 이 있는 프로필은 vercel 값이 남아도 그 judge 를 바꾸지 않는다");

	const typesafe = await load("typesafe");
	assert.equal(modelRoles.get(typesafe).judge, "typesafe/jev-latest");
	assert.deepEqual(fallbackChains.get(typesafe).judge, ["@tiny", "@smol", "@default"]);
	ok("upstream migration 은 typesafe 입력에서 그대로 동작한다");

	const auto = await load("auto");
	assert.equal(modelRoles.get(auto).judge, undefined);
	assert.equal(fallbackChains.get(auto).judge, undefined);
	ok("auto 입력은 legacy judge 주입을 하지 않는다");

	// 옛 vercel 설정을 migration 으로 통과한 판정은 judge role chain 으로만 간다. 후보가 없으면 withCandidate·judge() 모두 chain 실패이고
	// fetch 는 한 번도 나가지 않는다(Vercel endpoint 포함).
	const realFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		throw new Error("fixture: network must not be reached");
	}) as unknown as typeof fetch;
	try {
		const judge = resolveJudge({ settings: vercel, registry: { getAvailable: () => [] } as never });
		const run = (candidate: { judge: (input: typeof request) => Promise<unknown> }) => candidate.judge(request);
		await assert.rejects(judge.withCandidate(run), /no judge model available/);
		await assert.rejects(judge.judge(request), /no judge model available/);
		assert.equal(fetchCalls, 0);
	} finally {
		globalThis.fetch = realFetch;
	}
	ok("옛 vercel 설정 프로필의 판정은 role chain 으로만 가고 withCandidate·judge() 모두 외부 호출 0건");

	rmSync(root, { recursive: true, force: true });
}

console.log(`결과 ${pass} pass`);
