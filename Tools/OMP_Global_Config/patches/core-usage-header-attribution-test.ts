// 응답 rate-limit 헤더의 사용량을 그 요청을 실제로 보낸 계정에 귀속하는지 본다(OMP 18.3.x).
// 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-usage-header-attribution-test.ts
// 2026-09-28 실장애: MIO(position 1)로 보낸 요청이 도는 사이 RIN으로 교체(pin)하자, 응답 헤더의
// MIO 5시간·7일 사용률이 RIN 캐시 항목에 RIN 이메일로 기록돼 사용량 패널이 두 계정을 섞어 보였다.
// upstream `usage.ingestHeaders` 는 응답 도착 시점의 세션 활성 계정(affinity.activeOAuth)을 다시
// 고르기 때문이다. 미패치 core 에서는 [1]이 RED, [2](계정을 모르는 호출자 fallback)는 GREEN 이다.
// 네트워크·유료 호출·실제 자격증명 변경 없음(scratch SQLite + mock provider).
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(candidate => existsSync(join(candidate, "src/session/session-stats.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
const AI_ROOT = join(CORE, "..", "..", "pi-ai", "src").replace(/\\/g, "/");
console.log(`대상 ${CORE}`);
// 정적 import 불가: 대상 core 경로가 OMP_CORE_PATCH_TARGET 로 실행 시점에 정해진다.
const { SessionStatsTracker } = await import(`${CORE}/session/session-stats.ts`);
const { AuthStorage } = await import(`${AI_ROOT}/auth-storage.ts`);
const { streamSimple } = await import(`${AI_ROOT}/stream.ts`);
const { createMockModel, registerMockApi } = await import(`${AI_ROOT}/providers/mock.ts`);
registerMockApi();

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = ""): void {
	if (condition) {
		pass += 1;
		console.log(`  PASS  ${name}`);
	} else {
		fail += 1;
		console.log(`  FAIL  ${name} ${detail}`);
	}
}

const workdir = mkdtempSync(join(tmpdir(), "omp-usage-header-attribution-"));
const fixtureCredential = (tag: string) => ({
	type: "oauth" as const,
	access: `fixture-access-${tag}`,
	refresh: `fixture-refresh-${tag}`,
	expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
	email: `${tag}@example.test`,
	accountId: `fixture-${tag}`,
});
const resetSec = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
const headers = (sevenDay: number) => ({
	"anthropic-ratelimit-unified-5h-utilization": "0.05",
	"anthropic-ratelimit-unified-5h-reset": String(resetSec),
	"anthropic-ratelimit-unified-7d-utilization": String(sevenDay),
	"anthropic-ratelimit-unified-7d-reset": String(resetSec),
});

type Auth = InstanceType<typeof AuthStorage>;
const opened: Auth[] = [];
async function makeAuth(tag: string): Promise<{ auth: Auth; dbPath: string; ids: number[] }> {
	const dbPath = join(workdir, `${tag}.db`);
	const auth = await AuthStorage.create(dbPath);
	opened.push(auth);
	for (let index = 0; index < 2; index += 1) {
		await auth.credentials.upsert("anthropic", fixtureCredential(`${tag}-${index}`));
	}
	return { auth, dbPath, ids: auth.oauth.accounts("anthropic").map(account => account.credentialId) };
}

/** 저장된 헤더 보고서의 7일 사용률을 계정 email 별로 읽는다. */
function sevenDayByEmail(dbPath: string): Map<string, number> {
	const db = new Database(dbPath, { readonly: true });
	try {
		const out = new Map<string, number>();
		const rows = db.query("SELECT value FROM cache WHERE key LIKE 'usage_cache:%'").all() as { value: string }[];
		for (const row of rows) {
			const parsed = JSON.parse(row.value);
			const report = parsed?.value ?? parsed;
			const email = report?.metadata?.email;
			const limit = (report?.limits ?? []).find((entry: { id?: string }) => entry.id === "anthropic:7d");
			const used = limit?.amount?.usedFraction;
			if (typeof email === "string" && typeof used === "number") out.set(email, used);
		}
		return out;
	} finally {
		db.close();
	}
}

/** 실제 세션 경로: streamSimple(resolver) → onResponse → SessionStatsTracker.ingestProviderUsageHeaders. */
async function run(auth: Auth, sessionId: string, options: {
	resolve: () => string | { apiKey: string; credentialId: number };
	duringRequest?: () => void;
	sevenDay: number;
}): Promise<void> {
	const stats = new SessionStatsTracker({
		modelRegistry: { authStorage: auth, getProviderBaseUrl: () => undefined },
		agent: { sessionId },
	} as never);
	const mock = createMockModel({
		id: "claude-opus-5",
		provider: "anthropic",
		handler: async () => {
			// 요청은 이미 resolver 가 고른 계정으로 나갔다. 응답이 오기 전에 세션 pin 이 바뀐다.
			options.duringRequest?.();
			return { content: ["ok"], stopReason: "stop", responseHeaders: headers(options.sevenDay) };
		},
	});
	await streamSimple(
		mock as never,
		{ messages: [{ role: "user", content: "안녕", timestamp: Date.now() }] } as never,
		{
			apiKey: options.resolve,
			sessionId,
			onResponse: (response: unknown, model: unknown) => stats.ingestProviderUsageHeaders(response, model),
		} as never,
	).result();
}

try {
	console.log("\n[1] 요청 중 pin 교체 — 헤더는 요청을 보낸 계정(MIO)에 기록된다");
	{
		const { auth, dbPath, ids } = await makeAuth("switch");
		const [rin, mio] = ids as [number, number];
		const sessionId = "session-switch";
		auth.sessions.pin("anthropic", sessionId, mio);
		await run(auth, sessionId, {
			resolve: () => ({ apiKey: "fixture-access-switch-1", credentialId: mio }),
			duringRequest: () => auth.sessions.pin("anthropic", sessionId, rin),
			sevenDay: 0.42,
		});
		const usage = sevenDayByEmail(dbPath);
		check("MIO 캐시에 MIO 요청의 7일 사용률이 남는다", usage.get("switch-1@example.test") === 0.42, JSON.stringify([...usage]));
		check("RIN 캐시에는 MIO 사용률이 섞이지 않는다", !usage.has("switch-0@example.test"), JSON.stringify([...usage]));
	}

	console.log("\n[2] 계정을 모르는 호출자(정적 키) — 세션 활성 계정 fallback 은 그대로다");
	{
		const { auth, dbPath, ids } = await makeAuth("fallback");
		const [rin] = ids as [number, number];
		const sessionId = "session-fallback";
		auth.sessions.pin("anthropic", sessionId, rin);
		await run(auth, sessionId, { resolve: () => "fixture-access-fallback-0", sevenDay: 0.3 });
		const usage = sevenDayByEmail(dbPath);
		check("credentialId 없는 응답은 세션 pin 계정에 기록된다", usage.get("fallback-0@example.test") === 0.3, JSON.stringify([...usage]));
	}
} finally {
	for (const auth of opened) auth.close?.();
	try {
		rmSync(workdir, { recursive: true, force: true });
	} catch {
		// Windows SQLite 핸들 정리는 지연될 수 있으며 계약 판정과 무관하다.
	}
}

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
