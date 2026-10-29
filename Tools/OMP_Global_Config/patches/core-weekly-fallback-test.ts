// Anthropic 구독 주간 한도 소진 시 API 키 폴백(2026-10-13 사용자 결정: "주간 한도만", 충전 사용 없음).
// 두 OAuth 좌석이 모두 주간(7d) 한도로 막히고 `<agentDir>/anthropic-fallback-api-key` 파일에 키가 있을 때만 그 키로 넘어가고,
// reset 뒤에는 OAuth 로 돌아온다. 키 출처는 그 파일 하나뿐이라 env·config fallback 키가 있어도 파일이 없으면 upstream 그대로다.
// 키는 env 에 들어가지 않고, 폴백 중인 세션은 OAuth account 귀속에서 빠진다. 5h 단독 소진·파일 없음/빈 파일/못 읽는 파일·
// exact summon(캐릭터 pin)·한 좌석만 소진은 오늘 동작 그대로다. 429 lastChance 재시도도 같은 판정을 낸다.
// patch는 임시 source fixture에만 적용하고, Bun은 fixture에 있는 patched .ts 만 설치본 대신 읽는다.
// WEEKLY_FALLBACK_BASELINE=1 이면 target 설치본 파일을 그대로 읽는다(수정 전 RED 확인용).
// 실제 credential·네트워크·과금 호출은 없다: fixture SQLite, usage resolver fixture, 격리 HOME 의 가짜 키 파일.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// HOME·TEMP 를 격리한 자식 프로세스에서 돈다. 실제 키가 env 나 ~/.env 로 새어 들어오지 않게 Anthropic 키 변수를 지운다.
if (!process.env.OMP_WEEKLY_FALLBACK_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-weekly-fallback-"));
	const home = join(root, "home");
	const temp = join(root, "temp");
	mkdirSync(home);
	mkdirSync(temp);
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		CUELO_REAL_HOME: homedir(),
		USERPROFILE: home,
		TEMP: temp,
		TMP: temp,
		TMPDIR: temp,
		PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_WEEKLY_FALLBACK_ROOT: root,
	};
	for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_FOUNDRY_API_KEY", "CLAUDE_CODE_USE_FOUNDRY"]) delete env[name];
	let exitCode = 1;
	try {
		const child = Bun.spawnSync([process.execPath, import.meta.path], {
			cwd: process.cwd(),
			env,
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
const source = readFileSync(script, "utf8");
const temp = process.env.OMP_WEEKLY_FALLBACK_ROOT;
const fixture = join(temp, "target");
const patchHome = join(temp, "patch-home");
const toUrl = (path: string) => path.replace(/\\/g, "/");
const aiRoot = join(dirname(core), "pi-ai/src");
const baseline = process.env.WEEKLY_FALLBACK_BASELINE === "1";
let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — ${detail}`}`);
	ok ? passes++ : failures++;
}

if (!existsSync(join(aiRoot, "auth-storage.ts"))) throw new Error(`코어 원본을 찾지 못했다: ${aiRoot}`);
// Copy only declared patch targets. The source install and its credentials stay untouched.
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
	name: "weekly-fallback-fixture",
	setup(build) {
		build.onLoad({ filter: /[/\\]@oh-my-pi[/\\][\w-]+[/\\].+\.ts$/ }, args => {
			const [pkg, ...rest] = toUrl(args.path).split("/@oh-my-pi/").at(-1)!.split("/");
			const patched = pkg === corePackage ? join(fixture, ...rest) : join(fixture, "..", pkg!, ...rest);
			const useOriginal = baseline || !existsSync(patched);
			const contents = readFileSync(useOriginal ? args.path : patched, "utf8");
			if (args.path.endsWith(".d.ts")) return { exports: { default: contents }, loader: "object" };
			return { contents, loader: "ts" };
		});
	},
});

// Blocks, usage-cache expiry and report freshness all read Date.now(); a clock offset stands in for "the reset passed".
const realNow = Date.now.bind(Date);
let clockOffsetMs = 0;
Date.now = () => realNow() + clockOffsetMs;

// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET, so these cannot be static imports.
const { setAgentDir } = await import(toUrl(join(dirname(core), "pi-utils/src/dirs.ts")));
setAgentDir(join(process.env.HOME!, ".omp", "agent"));
const { $env } = await import(toUrl(join(dirname(core), "pi-utils/src/env.ts")));
const { AuthStorage } = await import(toUrl(join(aiRoot, "auth-storage.ts")));
const { claudeRankingStrategy } = await import(toUrl(join(aiRoot, "usage/claude.ts")));
const { getEnvApiKey } = await import(toUrl(join(aiRoot, "env-api-key.ts")));
const { isUsageLimitOutcome } = await import(toUrl(join(aiRoot, "error/rate-limit.ts")));
const { createApiKeyResolver } = await import(toUrl(join(core, "src/config/api-key-resolver.ts")));
const { streamSimple } = await import(toUrl(join(aiRoot, "stream.ts")));
const { getBundledModel } = await import(toUrl(join(dirname(core), "pi-catalog/src/models.ts")));
const { registerLogSink } = await import(toUrl(join(dirname(core), "pi-utils/src/logger.ts")));
// Load after the fixture plugin so the extension's core imports use the isolated patched modules.
const { default: characterVoice } = await import("../agent/extensions/character-voice.ts");

function voicePayload(auth: InstanceType<typeof AuthStorage>, sessionId: string) {
	type Handler = (event: unknown, ctx: unknown) => unknown;
	const handlers = new Map<string, Handler>();
	characterVoice({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as never);
	return handlers.get("before_provider_request")!(
		{ payload: { system: "fixture contract", messages: [] } },
		{ model: { provider: "anthropic", id: "claude-opus-5-5" },
			modelRegistry: { authStorage: auth }, sessionManager: { getSessionId: () => sessionId } },
	) as { system?: string } | undefined;
}

const HOUR = 3_600_000;
const FILE_KEY = "fake-fallback-key-file";
const FILE_KEY_ROTATED = "fake-fallback-key-file-rotated";
const CONFIG_KEY = "fake-fallback-key-config";
const ENV_KEY = "fake-fallback-key-env";
const KEY_FILE = join(process.env.HOME!, ".omp", "agent", "anthropic-fallback-api-key");
const MODEL = "claude-opus-5-5";
const usageLimitError = Object.assign(new Error("429"), { status: 429 });

// "env"/"config": no key file, but that other tier is configured. "dir": the path exists but cannot be read as a file.
type KeySource = "file" | "empty" | "dir" | "env" | "config";
// Surrounding whitespace and the trailing newline prove the file is trimmed.
function writeKeySource(key: KeySource | undefined): void {
	rmSync(KEY_FILE, { force: true, recursive: true });
	mkdirSync(dirname(KEY_FILE), { recursive: true });
	if (key === "file") writeFileSync(KEY_FILE, `  ${FILE_KEY}\n`);
	if (key === "empty") writeFileSync(KEY_FILE, " \n");
	if (key === "dir") mkdirSync(KEY_FILE);
	delete $env.ANTHROPIC_API_KEY;
	if (key === "env") $env.ANTHROPIC_API_KEY = ENV_KEY;
}

/** Seam into the selector's weekly check: counts its usage reads and may rewrite or fail them. */
type WeeklyHooks = { weeklyReport?: (token: string, report: unknown) => unknown; weeklyReports: number };

type Seat = { five: number; weekly: number; fiveResetAt: number; weeklyResetAt: number };
const limit = (id: "5h" | "7d", fraction: number, resetsAt: number) => ({
	id: `anthropic:${id}`,
	label: id,
	scope: { provider: "anthropic", windowId: id, shared: true },
	window: { id, label: id, durationMs: (id === "5h" ? 5 : 168) * HOUR, resetsAt },
	amount: {
		used: fraction * 100,
		limit: 100,
		remaining: 100 - fraction * 100,
		usedFraction: fraction,
		remainingFraction: 1 - fraction,
		unit: "percent" as const,
	},
	status: fraction >= 1 ? ("exhausted" as const) : ("ok" as const),
});
const seat = (five: number, weekly: number, weeklyResetHours = 30): Seat => ({
	five,
	weekly,
	fiveResetAt: Date.now() + 2 * HOUR,
	weeklyResetAt: Date.now() + weeklyResetHours * HOUR,
});

async function scenario(tag: string, opts: { rin: Seat; mio: Seat; key?: KeySource; exactPin?: boolean }) {
	const seats: Record<string, Seat> = { rin: opts.rin, mio: opts.mio };
	const auth = await AuthStorage.create(join(temp, `${tag}.db`), {
		usageProviderResolver: (provider: string) =>
			provider === "anthropic"
				? {
						id: provider,
						fetchUsage: async ({ credential }: { credential: { accessToken?: string } }) => {
							const value = seats[(credential.accessToken ?? "").split("-")[0]!];
							if (!value) return null;
							return {
								provider,
								fetchedAt: Date.now(),
								limits: [limit("5h", value.five, value.fiveResetAt), limit("7d", value.weekly, value.weeklyResetAt)],
							};
						},
					}
				: undefined,
		rankingStrategyResolver: (provider: string) => (provider === "anthropic" ? claudeRankingStrategy : undefined),
		// A forced re-mint (401 recovery) keeps the fixture token: no network refresh.
		refreshOAuthCredential: async (_provider: string, _id: number, credential: object) => ({ ...credential, expires: Date.now() + 30 * 86_400_000 }),
	});
	for (const identity of ["rin", "mio"]) {
		await auth.credentials.upsert("anthropic", {
			type: "oauth",
			access: `${identity}-${tag}`,
			refresh: `refresh-${identity}-${tag}`,
			expires: Date.now() + 30 * 86_400_000,
			accountId: `${identity}-${tag}`,
		});
	}
	writeKeySource(opts.key);
	if (opts.key === "config") auth.keys.setConfig("anthropic", CONFIG_KEY, { fallback: true });
	const sessionId = `session-${tag}`;
	const accounts = auth.oauth.accounts("anthropic");
	if (opts.exactPin) auth.sessions.pin("anthropic", sessionId, accounts[1]!.credentialId, { exactLabel: "MIO(미오)" });
	// Ranking and last-resort usage reads stay real. auth.usage is the UsageService instance the selector holds, and
	// the weekly check's frame is on the stack when it calls report().
	const hooks: WeeklyHooks = { weeklyReports: 0 };
	const usageApi = auth.usage as unknown as { report: (...args: unknown[]) => Promise<unknown> };
	const report = usageApi.report.bind(usageApi);
	usageApi.report = async (...args: unknown[]) => {
		const inWeeklyCheck = new Error().stack?.includes("cueloWeeklyExhausted") === true;
		const result = await report(...args);
		if (!inWeeklyCheck) return result;
		hooks.weeklyReports++;
		const credential = args[1] as { access?: string; accessToken?: string };
		return hooks.weeklyReport ? hooks.weeklyReport(String(credential.access ?? credential.accessToken ?? ""), result) : result;
	};
	const get = async () => {
		try {
			return await auth.keys.get("anthropic", sessionId, { modelId: MODEL });
		} catch (error) {
			return `THROW ${error instanceof Error ? error.message : String(error)}`;
		}
	};
	return { auth, seats, sessionId, get, hooks };
}
const isOAuth = (value: unknown, tag: string) => value === `rin-${tag}` || value === `mio-${tag}`;
const show = (value: unknown) => JSON.stringify(value);

const identityOf = (auth: { oauth: { identity(provider: string, sessionId?: string): { accountId?: string } | undefined } }, sessionId: string) =>
	auth.oauth.identity("anthropic", sessionId)?.accountId;

console.log(`[환경] fixture env key 없음 확인: ${getEnvApiKey("anthropic") === undefined}`);
check("자식 프로세스에는 실제 Anthropic env 키가 없다", getEnvApiKey("anthropic") === undefined, "env key leaked into fixture");
check("429 fixture 오류는 usage-limit 으로 분류된다", isUsageLimitOutcome(429, "429"), "fixture error not classified as usage limit");

console.log("[초기 resolve] 두 좌석 상태 × 키 출처");
{
	const tag = "a";
	const s = await scenario(tag, { rin: seat(0.2, 1), mio: seat(0.1, 1), key: "file" });
	const value = await s.get();
	check("(a) 두 좌석 주간 소진 + 키 파일 → 파일 키(trim)", value === FILE_KEY, `actual=${show(value)}`);
	check(
		"(a) 키는 process env 로 들어가지 않는다",
		$env.ANTHROPIC_API_KEY === undefined && process.env.ANTHROPIC_API_KEY === undefined && getEnvApiKey("anthropic") === undefined,
		"key reached the environment",
	);
	const identity = identityOf(s.auth, s.sessionId);
	check("(a) 폴백 중인 세션은 OAuth account 귀속에서 빠진다", identity === undefined, `identity=${show(identity)}`);
	check("(a) first API request uses the default RIN voice", voicePayload(s.auth, s.sessionId)?.system?.includes('alias="RIN(린)"') === true, "missing default voice");
	s.auth.close();
}
for (const [tag, key, label] of [
	["c1", undefined, "키 파일 없음"],
	["c2", "empty", "빈 키 파일"],
	["c3", "dir", "읽을 수 없는 키 경로(디렉터리)"],
	["r1", "env", "키 파일 없음 + env 키"],
	["g", "config", "키 파일 없음 + config fallback 키"],
] as const) {
	const s = await scenario(tag, { rin: seat(0.2, 1), mio: seat(0.1, 1), key });
	const value = await s.get();
	check(`(${tag}) 두 좌석 주간 소진 + ${label} → 막힌 OAuth 좌석(upstream 그대로)`, isOAuth(value, tag), `actual=${show(value)}`);
	if (key === undefined || key === "env" || key === "config") {
		check(`(${tag}) 키 파일이 없으면 주간 판정 자체를 돌리지 않는다`, s.hooks.weeklyReports === 0, `weekly reports=${s.hooks.weeklyReports}`);
	}
	s.auth.close();
}
writeKeySource(undefined);
{
	const tag = "b";
	const s = await scenario(tag, { rin: seat(1, 0.5), mio: seat(1, 0.4), key: "file" });
	const value = await s.get();
	check("(b) 두 좌석 5h만 소진 + 키 파일 → 막힌 OAuth 좌석(오늘 동작)", isOAuth(value, tag), `actual=${show(value)}`);
	s.auth.close();
}
{
	const tag = "d";
	const s = await scenario(tag, { rin: seat(0.2, 1), mio: seat(0.1, 1), key: "file", exactPin: true });
	const value = await s.get();
	check(
		"(d) exact summon(MIO) + 주간 소진 + 키 파일 → 키로 넘어가지 않고 CharacterSummonRuntime 거절",
		typeof value === "string" && value.startsWith("THROW [CharacterSummonRuntime]"),
		`actual=${show(value)}`,
	);
	s.auth.close();
}
{
	const tag = "f";
	const s = await scenario(tag, { rin: seat(0.2, 1), mio: seat(0.1, 0.3), key: "file" });
	const value = await s.get();
	check("(f) RIN만 주간 소진, MIO 여유 + 키 파일 → MIO OAuth", value === `mio-${tag}`, `actual=${show(value)}`);
	const fresh = identityOf(s.auth, "session-f-unpinned");
	check("(f) 키 파일이 있어도 pin 없는 세션의 OAuth 귀속은 그대로다", typeof fresh === "string" && fresh.length > 0, `identity=${show(fresh)}`);
	s.auth.close();
}
{
	const tag = "e";
	const s = await scenario(tag, { rin: seat(0.2, 1, 2), mio: seat(0.1, 1, 2), key: "file" });
	const before = await s.get();
	check("(e1) reset 전: 두 좌석 주간 소진 + 키 파일 → 파일 키", before === FILE_KEY, `actual=${show(before)}`);
	writeFileSync(KEY_FILE, `${FILE_KEY_ROTATED}\n`);
	const rotated = await s.get();
	check("(e1) 키 파일은 판정마다 다시 읽는다(캐시 없음)", rotated === FILE_KEY_ROTATED, `actual=${show(rotated)}`);
	clockOffsetMs = 3 * HOUR;
	// New week, 8h in (pace 4.76 %): both seats are under the over-pace chip.
	s.seats.rin = seat(0, 0.03, 160);
	s.seats.mio = seat(0, 0.02, 160);
	const after = await s.get();
	const identity = identityOf(s.auth, s.sessionId);
	clockOffsetMs = 0;
	check("(e2) 주간 reset 시각이 지나면 다음 resolve 는 다시 OAuth", isOAuth(after, tag), `actual=${show(after)}`);
	check("(e2) OAuth 로 돌아오면 그 좌석 귀속도 돌아온다", identity === after, `identity=${show(identity)} key=${show(after)}`);
	s.auth.close();
}
{
	// R2: MIO's block (until its 1h weekly reset) ends while RIN's report is awaited. MIO's report still reads as an
	// exhausted week, so only the post-loop block re-check can notice.
	const tag = "r2";
	const s = await scenario(tag, { rin: seat(0.2, 1), mio: seat(0.1, 1, 1), key: "file" });
	const first = await s.get();
	s.hooks.weeklyReport = (token, report) => {
		if (token.startsWith("rin-")) {
			clockOffsetMs = 2 * HOUR;
			return report;
		}
		return { ...(report as object), limits: [limit("5h", 0.1, Date.now() + 2 * HOUR), limit("7d", 1, Date.now() + 30 * HOUR)] };
	};
	const value = await s.get();
	s.hooks.weeklyReport = undefined;
	clockOffsetMs = 0;
	check("(r2) 사전 조건: 두 좌석이 막혀 있을 때는 파일 키", first === FILE_KEY, `actual=${show(first)}`);
	check("(r2) 판정 도중 한 좌석의 block 이 끝나면 폴백하지 않는다", isOAuth(value, tag), `actual=${show(value)}`);
	s.auth.close();
}
{
	// R3: the fallback mark changes only when a key or an OAuth bearer is actually returned.
	const tag = "r3";
	const s = await scenario(tag, { rin: seat(0.2, 1), mio: seat(0.1, 1), key: "file" });
	const first = await s.get();
	const pending = s.get();
	const during = identityOf(s.auth, s.sessionId);
	const second = await pending;
	s.hooks.weeklyReport = () => {
		throw new Error("weekly probe failure");
	};
	const failed = await s.get();
	s.hooks.weeklyReport = undefined;
	const afterFailure = identityOf(s.auth, s.sessionId);
	check("(r3) 사전 조건: 연속 resolve 두 번 모두 파일 키", first === FILE_KEY && second === FILE_KEY, `first=${show(first)} second=${show(second)}`);
	check("(r3) 진행 중인 resolve 동안에도 폴백 표식이 유지된다", during === undefined, `identity=${show(during)}`);
	check(
		"(r3) 실패한 resolve 는 이전 폴백 표식을 바꾸지 않는다",
		String(failed).startsWith("THROW") && afterFailure === undefined,
		`failed=${show(failed)} identity=${show(afterFailure)}`,
	);
	s.auth.close();
}

{
	// R5: both weeks reset (1h) while the last report is awaited, but the 5h windows (2h) keep both seats blocked.
	// Only the fresh post-loop weekly re-check can notice.
	const tag = "r5";
	const s = await scenario(tag, { rin: seat(1, 1, 1), mio: seat(1, 1, 1), key: "file" });
	const first = await s.get();
	s.hooks.weeklyReport = (token, report) => {
		if (token.startsWith("mio-")) clockOffsetMs = 1.5 * HOUR;
		return report;
	};
	const value = await s.get();
	s.hooks.weeklyReport = undefined;
	clockOffsetMs = 0;
	check("(r5) 사전 조건: 5h·주간 모두 소진이면 파일 키", first === FILE_KEY, `actual=${show(first)}`);
	check("(r5) 판정 도중 주간 reset 이 지나면(5h block 은 남아도) 폴백하지 않는다", isOAuth(value, tag), `actual=${show(value)}`);
	s.auth.close();
}
for (const change of ["added", "removed"] as const) {
	// R6: the eligible pool changes while RIN's report is awaited. A usable seat appears, or MIO disappears while
	// RIN stays blocked and weekly-exhausted; either way the decision belongs to the next resolve.
	const tag = change === "added" ? "r6" : "r6b";
	const s = await scenario(tag, { rin: seat(0.2, 1), mio: seat(0.1, 1), key: "file" });
	const first = await s.get();
	const mioId = s.auth.oauth.accounts("anthropic")[1]!.credentialId;
	s.seats.yui = seat(0, 0.1);
	s.hooks.weeklyReport = async (token, report) => {
		if (!token.startsWith("rin-")) return report;
		s.hooks.weeklyReport = undefined;
		if (change === "added") {
			await s.auth.credentials.upsert("anthropic", {
				type: "oauth",
				access: `yui-${tag}`,
				refresh: `refresh-yui-${tag}`,
				expires: Date.now() + 30 * 86_400_000,
				accountId: `yui-${tag}`,
			});
		} else {
			await s.auth.credentials.removeById("anthropic", mioId);
		}
		return report;
	};
	const value = await s.get();
	s.hooks.weeklyReport = undefined;
	const label = change === "added" ? "새 OAuth 좌석이 생기면" : "좌석 하나가 빠지면(남은 좌석은 막힌 채)";
	check(`(${tag}) 사전 조건: 두 좌석이 막혀 있을 때는 파일 키`, first === FILE_KEY, `actual=${show(first)}`);
	check(
		`(${tag}) 판정 도중 ${label} 폴백하지 않는다(OAuth)`,
		value === `rin-${tag}` || value === `mio-${tag}` || value === `yui-${tag}`,
		`actual=${show(value)}`,
	);
	s.auth.close();
}

console.log("[429 lastChance] 요청 뒤 usage-limit, sibling 없음");
async function lastChance(
	tag: string,
	rin: Seat,
	mio: Seat,
	via: "registry" | "cascade",
	key: KeySource | undefined,
	arm?: (hooks: WeeklyHooks) => void,
) {
	// Key absent first: today's ladder marks both blocks and returns the blocked seat the request went out on.
	const s = await scenario(tag, { rin, mio });
	const sent = await s.get();
	writeKeySource(key);
	arm?.(s.hooks);
	const resolver =
		via === "registry"
			? createApiKeyResolver(
					{
						getApiKeyWithCredentialForProvider: (provider: string, sessionId?: string, options?: object) =>
							s.auth.keys.getWithCredential(provider, sessionId, options),
						authStorage: s.auth,
					},
					"anthropic",
					{ sessionId: s.sessionId, modelId: MODEL },
				)
			: s.auth.keys.resolver("anthropic", { sessionId: s.sessionId, modelId: MODEL });
	let resolved: unknown;
	try {
		resolved = await resolver({ lastChance: true, error: usageLimitError, previousKey: String(sent) });
	} catch (error) {
		resolved = `THROW ${String(error)}`;
	}
	const identity = identityOf(s.auth, s.sessionId);
	s.auth.close();
	writeKeySource(undefined);
	return { sent, identity, apiKey: typeof resolved === "object" && resolved !== null && "apiKey" in resolved ? resolved.apiKey : resolved };
}
{
	const tag = "h1";
	const { sent, apiKey, identity } = await lastChance(tag, seat(0.2, 1), seat(0.1, 1), "registry", "file");
	check("(h1) 사전 조건: 키 없을 때 요청은 막힌 OAuth 좌석으로 나갔다", isOAuth(sent, tag), `sent=${show(sent)}`);
	check("(h1) coding-agent resolver lastChance: 두 좌석 주간 소진 + 키 파일 → 같은 요청에서 파일 키", apiKey === FILE_KEY, `actual=${show(apiKey)}`);
	check("(h1) lastChance 로 파일 키를 돌려주면 OAuth 귀속에서도 빠진다", identity === undefined, `identity=${show(identity)}`);
}
{
	const tag = "h2";
	const { apiKey } = await lastChance(tag, seat(0.2, 1), seat(0.1, 1), "cascade", "file");
	check("(h2) KeyCascade.resolver lastChance: 두 좌석 주간 소진 + 키 파일 → 파일 키", apiKey === FILE_KEY, `actual=${show(apiKey)}`);
}
for (const [tag, key, label] of [
	["h3", "empty", "빈 키 파일"],
	["h4", "env", "키 파일 없음 + env 키"],
] as const) {
	const { apiKey } = await lastChance(tag, seat(0.2, 1), seat(0.1, 1), "registry", key);
	check(`(${tag}) lastChance: 주간 소진 + ${label} → undefined(upstream 그대로)`, apiKey === undefined, `actual=${show(apiKey)}`);
}
{
	const tag = "i";
	const { apiKey } = await lastChance(tag, seat(1, 0.5), seat(1, 0.4), "registry", "file");
	check("(i) lastChance: 5h만 소진이면 키 파일이 있어도 undefined(오늘 동작: 외부 재시도 층이 기다린다)", apiKey === undefined, `actual=${show(apiKey)}`);
}
{
	// R4: the file disappears while the weekly decision is still being made → no key, and never an OAuth bearer.
	const tag = "r4a";
	const { apiKey } = await lastChance(tag, seat(0.2, 1), seat(0.1, 1), "registry", "file", hooks => {
		hooks.weeklyReport = (_token, report) => {
			rmSync(KEY_FILE, { force: true });
			return report;
		};
	});
	check("(r4a) lastChance: 주간 판정 중에 키 파일이 사라지면 undefined", apiKey === undefined, `actual=${show(apiKey)}`);
}
{
	// R4: the file disappears only on a second weekly decision (a re-resolve). The helper reads the file once, so the
	// answer is that key; a re-resolve that lost the file would hand back an ordinary OAuth bearer instead.
	const tag = "r4b";
	const { apiKey } = await lastChance(tag, seat(0.2, 1), seat(0.1, 1), "registry", "file", hooks => {
		hooks.weeklyReport = (_token, report) => {
			if (hooks.weeklyReports > 2) rmSync(KEY_FILE, { force: true });
			return report;
		};
	});
	check("(r4b) lastChance 는 OAuth bearer 를 돌려주지 않는다(파일은 한 번만 읽는다)", apiKey === FILE_KEY, `actual=${show(apiKey)}`);
}

// 2026-10-29 user decision: API fallback follows the usage panel's over-pace chip
// (ResourcePanel paceOf: used − elapsed share of the 7d window ≥ 0.5 %p), not a stepped daily allowance.
// Fixtures sit 4h into a 168h window: pace 2.38 %, chip at 2.88 %, while the stepped allowance would be 14.3 %.
console.log("[over-pace allowance]");
for (const [tag, left, right, expected] of [
	["pace-over-inside-day", 0.05, 0.05, "api"],
	["pace-chip-edge", 0.031, 0.3, "api"],
	["pace-above", 0.2, 0.3, "api"],
	["pace-under-chip", 0.027, 0.3, "oauth"],
	["pace-one-below", 0.02, 0.3, "oauth"],
] as const) {
	const s = await scenario(tag, { rin: seat(0.1, left, 164), mio: seat(0.1, right, 164), key: "file" });
	const value = await s.get();
	check(tag, expected === "api" ? value === FILE_KEY : isOAuth(value, tag), `actual=${show(value)}`);
	if (expected === "api") {
		check(`${tag}: no false OAuth attribution`, identityOf(s.auth, s.sessionId) === undefined, "unexpected identity");
		// 48h later the pace is 30.95 %, ahead of every left-seat usage above.
		clockOffsetMs += 48 * HOUR;
		for (const v of Object.values(s.seats)) v.fiveResetAt = Date.now() + HOUR;
		const recovered = await s.get();
		check(`${tag}: pace catching up resumes OAuth`, isOAuth(recovered, tag), `actual=${show(recovered)}`);
		clockOffsetMs -= 48 * HOUR;
	}
	await s.auth.close();
}
for (const tag of ["daily-unknown", "daily-stale", "daily-unsupported", "daily-pin", "daily-no-key"] as const) {
	const s = await scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.3, 164), key: tag === "daily-no-key" ? undefined : "file", exactPin: tag === "daily-pin" });
	s.hooks.weeklyReport = (_token, report) => {
		if (tag === "daily-unknown") return null;
		const usage = report as { fetchedAt: number; limits: unknown[] };
		if (tag === "daily-stale") return { ...usage, fetchedAt: Date.now() - 86_400_000 };
		if (tag === "daily-unsupported") return { ...usage, limits: [] };
		return report;
	};
	const value = await s.get();
	check(tag, isOAuth(value, tag), `actual=${show(value)}`);
	await s.auth.close();
}

{
	const tag = "daily-short-window-blocked";
	const s = await scenario(tag, { rin: seat(1, 0.2, 164), mio: seat(1, 0.3, 164), key: "file" });
	check(tag, await s.get() === FILE_KEY, "daily budget fallback must also work when short windows are blocked");
	s.auth.close();
}

for (const key of ["empty", "dir"] as const) {
	const tag = `daily-${key}`;
	const s = await scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.3, 164), key });
	check(tag, isOAuth(await s.get(), tag), "unusable file must preserve OAuth");
	s.auth.close();
}
{
	const tag = "daily-disabled";
	const s = await scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.01, 164), key: "file" });
	await s.auth.credentials.disable(s.auth.oauth.accounts("anthropic")[1]!.credentialId, "fixture");
	check(tag, await s.get() === FILE_KEY, "disabled below-budget account must not block fallback");
	s.auth.close();
}
{
	const tag = "daily-restricted";
	const s = await scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.3, 164), key: "file" });
	s.auth.sessions.restrict("anthropic", s.sessionId, [`rin-${tag}`]);
	check(tag, await s.get() !== FILE_KEY, "restricted session must not use paid fallback");
	s.auth.close();
}
for (const tier of ["opus", "sonnet"] as const) {
	const tag = `daily-scope-${tier}`;
	const s = await scenario(tag, { rin: seat(0.1, 0.01, 164), mio: seat(0.1, 0.01, 164), key: "file" });
	s.hooks.weeklyReport = (_token, report) => {
		const usage = report as { limits: unknown[] };
		const scoped = limit("7d", 0.3, Date.now() + 164 * HOUR);
		return { ...usage, limits: [...usage.limits, { ...scoped, id: `anthropic:7d:${tier}`, scope: { provider: "anthropic", windowId: "7d", shared: false, tier } }] };
	};
	const value = await s.get();
	check(tag, tier === "opus" ? value === FILE_KEY : isOAuth(value, tag), `actual=${show(value)}`);
	s.auth.close();
}
{
	const tag = "daily-slot-during-await";
	const s = await scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.2, 164), key: "file" });
	s.hooks.weeklyReport = (_token, report) => {
		if (s.hooks.weeklyReports === 2) clockOffsetMs += 48 * HOUR;
		return report;
	};
	check(tag, isOAuth(await s.get(), tag), "recheck must reject decision crossing the pace boundary");
	clockOffsetMs -= 48 * HOUR;
	s.auth.close();
}

{
	const tag = "daily-usage-recovery";
	const s = await scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.3, 164), key: "file" });
	check(`${tag}: initial API`, await s.get() === FILE_KEY, "expected fallback");
	s.seats.rin.weekly = 0.01;
	clockOffsetMs += 10 * 60_000;
	const value = await s.get();
	check(`${tag}: fresh below-budget report`, value === `rin-${tag}`, `actual=${show(value)}`);
	check(`${tag}: OAuth attribution restored`, identityOf(s.auth, s.sessionId) === `rin-${tag}`, "stale API mark");
	clockOffsetMs -= 10 * 60_000;
	s.auth.close();
}

{
	const tag = "daily-warm-oauth-api-oauth";
	const s = await scenario(tag, { rin: seat(0.1, 0.01, 164), mio: seat(0.1, 0.02, 164), key: "file" });
	const initial = await s.get();
	check(`${tag}: successful OAuth establishes automatic affinity`, isOAuth(initial, tag) && identityOf(s.auth, s.sessionId) === initial, `actual=${show(initial)}`);
	const initialVoice = voicePayload(s.auth, s.sessionId)?.system;
	check(`${tag}: OAuth voice identifies A`, initialVoice?.includes('alias="RIN(린)"') === true, `voice=${show(initialVoice)}`);
	// Reports refresh after at most 6.25 minutes; Anthropic automatic affinity remains warm for 60.
	s.seats.rin.weekly = 0.2;
	s.seats.mio.weekly = 0.3;
	clockOffsetMs += 10 * 60_000;
	const paid = await s.get();
	check(`${tag}: still-warm OAuth yields to daily API fallback`, paid === FILE_KEY, `actual=${show(paid)}`);
	check(`${tag}: paid request has no OAuth identity`, identityOf(s.auth, s.sessionId) === undefined, "incorrect OAuth attribution");
	const paidVoice = voicePayload(s.auth, s.sessionId)?.system;
	check(`${tag}: API preserves A voice`, paidVoice === initialVoice && paidVoice !== undefined, `voice=${show(paidVoice)}`);
	console.log(JSON.stringify({ phase: "paid-character-probe", accounts: s.auth.oauth.accounts("anthropic", s.sessionId).map(({ credentialId, active, position }) => ({ credentialId, active, position })), hasVoice: paidVoice !== undefined }));
	s.seats.rin.weekly = 0.01;
	clockOffsetMs += 10 * 60_000;
	const recovered = await s.get();
	check(`${tag}: same session recovers to below-budget OAuth`, recovered === `rin-${tag}`, `actual=${show(recovered)}`);
	check(`${tag}: recovered identity is OAuth again`, identityOf(s.auth, s.sessionId) === recovered, "stale paid marker");
	check(`${tag}: recovered OAuth keeps A voice`, voicePayload(s.auth, s.sessionId)?.system === initialVoice, "voice changed on recovery");
	clockOffsetMs -= 20 * 60_000;
	s.auth.close();
}

// 2026-10-29 user decisions: a usage report the usage service still serves from its cache counts as current; the
// OAuth/API answer is fixed per user turn (KeyCascade.cueloBeginTurn, announced by the coding-agent at each user
// prompt); a turn boundary with unknown usage keeps the session's previous turn answer, and a first turn stays OAuth.
console.log("[turn fixation]");
type TurnKeys = { cueloBeginTurn?: (sessionId: string) => void; cueloEndSession?: (sessionId: string) => void };
const beginTurn = (s: { auth: { keys: unknown }; sessionId: string }) => (s.auth.keys as TurnKeys).cueloBeginTurn?.(s.sessionId);
// Usage reports are cached for at most 6.25 minutes; ten minutes guarantees a refetch from the scenario seats.
const nextReport = () => {
	clockOffsetMs += 10 * 60_000;
};
{
	// (a) usage.ts serves a cached success until TTL + 25% jitter (up to 6.25 min old) as current.
	const tag = "fresh-cached-5m30";
	const s = await scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.3, 164), key: "file" });
	s.hooks.weeklyReport = (_token, report) => ({ ...(report as object), fetchedAt: Date.now() - 5.5 * 60_000 });
	const value = await s.get();
	check(`${tag}: a 5.5-minute-old cached report over pace -> API key`, value === FILE_KEY, `actual=${show(value)}`);
	s.auth.close();
}
{
	// (b) one turn keeps its auth through pace changes and unknown reports; the next boundary decides afresh.
	const tag = "turn-fixed";
	const s = await scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.3, 164), key: "file" });
	beginTurn(s);
	const first = await s.get();
	s.seats.rin.weekly = 0.01;
	nextReport();
	const caughtUp = await s.get();
	s.hooks.weeklyReport = () => null;
	nextReport();
	const unknown = await s.get();
	s.hooks.weeklyReport = undefined;
	check(`${tag}: turn 1 starts on the API key`, first === FILE_KEY, `actual=${show(first)}`);
	check(`${tag}: turn 1 keeps the API key after pace catches up mid-turn`, caughtUp === FILE_KEY, `actual=${show(caughtUp)}`);
	check(`${tag}: turn 1 keeps the API key when a mid-turn report is unknown`, unknown === FILE_KEY, `actual=${show(unknown)}`);
	beginTurn(s);
	nextReport();
	const second = await s.get();
	s.seats.rin.weekly = 0.2;
	nextReport();
	const overAgain = await s.get();
	check(`${tag}: turn 2 boundary with a seat under pace -> OAuth`, second === `rin-${tag}`, `actual=${show(second)}`);
	check(`${tag}: turn 2 keeps OAuth after both seats go over pace mid-turn`, overAgain === `rin-${tag}`, `actual=${show(overAgain)}`);
	beginTurn(s);
	nextReport();
	const third = await s.get();
	check(`${tag}: turn 3 boundary over pace -> API key`, third === FILE_KEY, `actual=${show(third)}`);
	s.auth.close();
}
for (const unknown of ["null", "stale", "unsupported"] as const) {
	// (c) usage cannot be judged at the boundary: keep the previous turn's auth; a first turn stays OAuth.
	const tag = `turn-unknown-${unknown}`;
	const s = await scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.3, 164), key: "file" });
	beginTurn(s);
	const first = await s.get();
	s.hooks.weeklyReport = (_token, report) => {
		if (unknown === "null") return null;
		const usage = report as { fetchedAt: number };
		return unknown === "stale" ? { ...usage, fetchedAt: Date.now() - 30 * 60_000 } : { ...usage, limits: [] };
	};
	beginTurn(s);
	nextReport();
	const next = await s.get();
	check(`${tag}: previous turn API`, first === FILE_KEY, `actual=${show(first)}`);
	check(`${tag}: unknown usage at the next boundary keeps the API key`, next === FILE_KEY, `actual=${show(next)}`);
	const fresh = { ...s, sessionId: `${s.sessionId}-new` };
	beginTurn(fresh);
	const firstTurn = await s.auth.keys.get("anthropic", fresh.sessionId, { modelId: MODEL });
	check(`${tag}: a first turn with unknown usage stays OAuth`, isOAuth(firstTurn, tag), `actual=${show(firstTurn)}`);
	(s.auth.keys as TurnKeys).cueloEndSession?.(s.sessionId);
	beginTurn(s);
	const afterEnd = await s.get();
	check(`${tag}: an ended session starts again without a previous answer (OAuth)`, isOAuth(afterEnd, tag), `actual=${show(afterEnd)}`);
	s.hooks.weeklyReport = undefined;
	s.auth.close();
}
{
	// An under-pace report from a seat removed while the boundary check awaits is unknown, not an OAuth verdict.
	const tag = "turn-pool-change";
	const s = await scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.3, 164), key: "file" });
	beginTurn(s);
	const first = await s.get();
	const rinId = s.auth.oauth.accounts("anthropic")[0]!.credentialId;
	s.hooks.weeklyReport = async (token, report) => {
		if (!token.startsWith("rin-")) return report;
		s.hooks.weeklyReport = undefined;
		await s.auth.credentials.removeById("anthropic", rinId);
		return { ...(report as object), limits: [limit("5h", 0.1, Date.now() + 2 * HOUR), limit("7d", 0.01, Date.now() + 164 * HOUR)] };
	};
	beginTurn(s);
	nextReport();
	const next = await s.get();
	s.hooks.weeklyReport = undefined;
	check(`${tag}: previous turn API`, first === FILE_KEY, `actual=${show(first)}`);
	check(`${tag}: a removed seat's under-pace report keeps the API key`, next === FILE_KEY, `actual=${show(next)}`);
	s.auth.close();
}
{
	// The turn lock never pins a rejected key: a 401 recovery resolve (forceRefresh) decides per request as before.
	const tag = "turn-auth-recovery";
	const s = await scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.3, 164), key: "file" });
	beginTurn(s);
	const first = await s.get();
	s.seats.rin.weekly = 0.01;
	nextReport();
	const resolver = createApiKeyResolver(
		{
			getApiKeyWithCredentialForProvider: (provider: string, sessionId?: string, options?: object) =>
				s.auth.keys.getWithCredential(provider, sessionId, options),
			authStorage: s.auth,
		},
		"anthropic",
		{ sessionId: s.sessionId, modelId: MODEL },
	);
	const recovered = (await resolver({ error: Object.assign(new Error("401"), { status: 401 }), previousKey: FILE_KEY })) as { apiKey?: string } | undefined;
	const after = await s.get();
	check(`${tag}: turn starts on the API key`, first === FILE_KEY, `actual=${show(first)}`);
	check(`${tag}: 401 recovery with a seat under pace -> OAuth, not the locked key`, isOAuth(recovered?.apiKey, tag), `actual=${show(recovered?.apiKey)}`);
	check(`${tag}: the rest of the turn follows the recovered OAuth`, isOAuth(after, tag), `actual=${show(after)}`);
	s.auth.close();
}

// 2026-10-29 user decision: Anthropic rejecting the fallback key for billing (credits used up, spend limit or tier cap
// reached) parks that key for an hour; the same request finishes on OAuth through the stream retry -> resolver path and
// later turns stay on OAuth until the park ends. Wording: platform.claude.com/docs/en/api/errors and /api/rate-limits.
// The park is process-wide and keyed on the key value, so every case below writes its own key into the file.
console.log("[billing park]");
const anthropicError = (status: number, type: string, message: string, details?: object) =>
	({ status, body: { type: "error", error: { type, message, ...(details ? { details } : {}) }, request_id: "req_fixture" } });
const BILLING = {
	"credit-400": anthropicError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."),
	"spend-limit-400": anthropicError(400, "invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."),
	"tier-cap-429": anthropicError(429, "rate_limit_error", "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-11-01 at 00:00 UTC.", { error_code: "enforced_spend_limit_reached" }),
	"billing-402": anthropicError(402, "billing_error", "There is an issue with your billing or payment information."),
};
const NOT_BILLING = {
	"rate-limit-429": anthropicError(429, "rate_limit_error", "This request would exceed the rate limit for your organization of 30,000 input tokens per minute."),
	"api-error-500": anthropicError(500, "api_error", "Internal server error"),
	// Billing wording counts only on a billing status (400/402/429); a server error never parks the key.
	"billing-wording-500": anthropicError(500, "api_error", "Your credit balance is too low to access the Anthropic API."),
};
// Local Anthropic Messages endpoint: a bearer listed in `reject` gets that error, every other bearer streams "ok".
const reject = new Map<string, { status: number; body: object }>();
const sentKeys: string[] = [];
const fakeAnthropic = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
	const bearer = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	sentKeys.push(bearer);
	const failure = reject.get(bearer);
	if (failure) return Response.json(failure.body, { status: failure.status });
	const events = [
		{ type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
const fakeModel = { ...getBundledModel("anthropic", MODEL), baseUrl: `http://127.0.0.1:${fakeAnthropic.port}` };
const warnings: string[] = [];
const disposeSink = registerLogSink((event: { level: string; message: string }) => {
	if (event.level === "warn" && event.message.includes("fallback API key")) warnings.push(event.message);
});
const registryResolver = (s: { auth: InstanceType<typeof AuthStorage>; sessionId: string }) =>
	createApiKeyResolver(
		{ getApiKeyWithCredentialForProvider: (provider: string, sessionId?: string, options?: object) => s.auth.keys.getWithCredential(provider, sessionId, options), authStorage: s.auth },
		"anthropic",
		{ sessionId: s.sessionId, modelId: MODEL },
	);
// One real streamSimple request through the stream retry driver and the anthropic provider.
async function request(apiKey: unknown) {
	const before = sentKeys.length;
	const result = await streamSimple(fakeModel, { systemPrompt: "fixture", messages: [{ role: "user", content: "probe", timestamp: Date.now() }] }, { apiKey, maxTokens: 32 }).result();
	return { stopReason: result.stopReason as string, errorMessage: result.errorMessage as string | undefined, sent: sentKeys.slice(before) };
}
// Over pace on both seats (4h into the week): a turn boundary picks the fallback key.
const overPace = (tag: string) => scenario(tag, { rin: seat(0.1, 0.2, 164), mio: seat(0.1, 0.3, 164), key: "file" });
const useKey = (key: string) => writeFileSync(KEY_FILE, `${key}\n`);
for (const [name, failure] of Object.entries(BILLING)) {
	// (a) credit balance, (b) spend limit / tier cap / 402: the same request finishes on OAuth, later turns stay OAuth.
	const tag = `park-${name}`;
	const key = `fake-fallback-key-${tag}`;
	const s = await overPace(tag);
	useKey(key);
	reject.set(key, failure);
	const warned = warnings.length;
	beginTurn(s);
	const result = await request(registryResolver(s));
	check(`${tag}: the turn's first request went out on the fallback key`, result.sent[0] === key, `sent=${show(result.sent)}`);
	check(`${tag}: the same request finishes on an OAuth seat`, result.stopReason === "stop" && result.sent.length === 2 && isOAuth(result.sent[1], tag), `stop=${result.stopReason} sent=${show(result.sent)} error=${result.errorMessage}`);
	check(`${tag}: one warn line, without the key`, warnings.length - warned === 1 && !warnings.at(-1)!.includes(key), `warnings=${show(warnings.slice(warned))}`);
	const midTurn = await s.get();
	beginTurn(s);
	nextReport();
	const nextTurn = await s.get();
	check(`${tag}: the rest of the turn and the next over-pace turn stay on OAuth`, isOAuth(midTurn, tag) && isOAuth(nextTurn, tag), `mid=${show(midTurn)} next=${show(nextTurn)}`);
	check(`${tag}: OAuth attribution is back`, identityOf(s.auth, s.sessionId) === nextTurn, `identity=${show(identityOf(s.auth, s.sessionId))}`);
	if (name === "credit-400") {
		// (d) the park lasts an hour; after it the next over-pace turn may try the key again.
		clockOffsetMs += 45 * 60_000;
		beginTurn(s);
		const stillParked = await s.get();
		clockOffsetMs += 16 * 60_000;
		beginTurn(s);
		const reprobe = await s.get();
		clockOffsetMs -= 61 * 60_000 + 10 * 60_000;
		check(`${tag}: within the hour the key stays parked`, isOAuth(stillParked, tag), `actual=${show(stillParked)}`);
		check(`${tag}: after the hour the next over-pace turn tries the key again`, reprobe === key, `actual=${show(reprobe)}`);
		// A different key in the file is not the rejected one.
		useKey(`${key}-replaced`);
		beginTurn(s);
		nextReport();
		const replaced = await s.get();
		clockOffsetMs -= 10 * 60_000;
		check(`${tag}: a replaced key in the file is not parked`, replaced === `${key}-replaced`, `actual=${show(replaced)}`);
	} else {
		clockOffsetMs -= 10 * 60_000;
	}
	reject.delete(key);
	s.auth.close();
}
{
	// (c) while parked, the weekly-exhausted path (selector pass and the lastChance helper) never hands out the key.
	const tag = "park-weekly";
	const key = `fake-fallback-key-${tag}`;
	const s = await scenario(tag, { rin: seat(0.2, 1), mio: seat(0.1, 1), key: "file" });
	useKey(key);
	const first = await s.get();
	const retried = (await registryResolver(s)({ lastChance: false, error: Object.assign(new Error(`400 ${JSON.stringify(BILLING["credit-400"].body)}`), { status: 400 }), previousKey: key })) as { apiKey?: string } | undefined;
	const after = await s.get();
	const helper = await s.auth.keys.cueloWeeklyApiKeyFallback?.("anthropic", s.sessionId, { modelId: MODEL });
	check(`${tag}: weekly exhaustion first served the key`, first === key, `actual=${show(first)}`);
	check(`${tag}: the rejected request resolves to an OAuth seat, not the key`, isOAuth(retried?.apiKey, tag), `actual=${show(retried?.apiKey)}`);
	check(`${tag}: weekly selection and the lastChance helper skip the parked key`, isOAuth(after, tag) && helper === undefined, `after=${show(after)} helper=${show(helper)}`);
	s.auth.close();
}
{
	// Each rejected key keeps its own hour: A rejected, the file moves to B, B rejected, the file goes back to A.
	const tag = "park-two-keys";
	const [keyA, keyB] = [`fake-fallback-key-${tag}-a`, `fake-fallback-key-${tag}-b`];
	const s = await overPace(tag);
	const credit = Object.assign(new Error(`400 ${JSON.stringify(BILLING["credit-400"].body)}`), { status: 400 });
	const served: unknown[] = [];
	for (const key of [keyA, keyB, keyA]) {
		useKey(key);
		beginTurn(s);
		nextReport();
		const value = await s.get();
		served.push(value);
		if (value === key) await registryResolver(s)({ lastChance: false, error: credit, previousKey: key });
	}
	clockOffsetMs -= 30 * 60_000;
	check(`${tag}: A and B were each served once, then A stays parked`, served[0] === keyA && served[1] === keyB && isOAuth(served[2], tag), `served=${show(served)}`);
	s.auth.close();
}
for (const [name, failure] of Object.entries(NOT_BILLING)) {
	// (e) a transient rate limit or a server error on the key neither retries onto OAuth nor parks the key.
	const tag = `no-park-${name}`;
	const key = `fake-fallback-key-${tag}`;
	const s = await overPace(tag);
	useKey(key);
	reject.set(key, failure);
	const warned = warnings.length;
	beginTurn(s);
	const result = await request(registryResolver(s));
	const error = Object.assign(new Error(`${failure.status} ${JSON.stringify(failure.body)}`), { status: failure.status });
	const retried = (await s.auth.keys.resolver("anthropic", { sessionId: s.sessionId, modelId: MODEL })({ lastChance: true, error, previousKey: key })) as { apiKey?: string } | string | undefined;
	beginTurn(s);
	const next = await s.get();
	check(`${tag}: the request fails on the key without an OAuth retry`, result.stopReason === "error" && result.sent.every(sent => sent === key), `stop=${result.stopReason} sent=${show(result.sent)}`);
	check(`${tag}: the key is not parked and nothing is logged`, next === key && warnings.length === warned, `next=${show(next)} retried=${show(retried)} warnings=${warnings.length - warned}`);
	reject.delete(key);
	s.auth.close();
}
{
	// Any bearer other than the fallback key file's key keeps the upstream classification: no retry for a credit 400.
	const other = "fake-other-api-key";
	reject.set(other, BILLING["credit-400"]);
	const resolves: string[] = [];
	const result = await request(({ error }: { error: unknown }) => {
		resolves.push(error === undefined ? "initial" : "retry");
		return other;
	});
	check("non-fallback api key: a credit-balance 400 is not retried", result.stopReason === "error" && result.sent.length === 1 && resolves.join() === "initial", `stop=${result.stopReason} sent=${show(result.sent)} resolves=${show(resolves)}`);
	reject.delete(other);
}
disposeSink();
fakeAnthropic.stop(true);

console.log(`결과: ${passes} pass, ${failures} fail`);
process.exit(failures > 0 ? 1 : 0);
