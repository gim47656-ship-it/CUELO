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
	s.seats.rin = seat(0, 0.05, 168);
	s.seats.mio = seat(0, 0.02, 168);
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

console.log("[cumulative daily allowance]");
for (const [tag, left, right, expected] of [
	["daily-equal", 1 / 7, 1 / 7, "api"],
	["daily-above", 0.2, 0.3, "api"],
	["daily-one-below", 0.1, 0.3, "oauth"],
] as const) {
	const s = await scenario(tag, { rin: seat(0.1, left, 164), mio: seat(0.1, right, 164), key: "file" });
	const value = await s.get();
	check(tag, expected === "api" ? value === FILE_KEY : isOAuth(value, tag), `actual=${show(value)}`);
	if (expected === "api") {
		check(`${tag}: no false OAuth attribution`, identityOf(s.auth, s.sessionId) === undefined, "unexpected identity");
		clockOffsetMs += 24 * HOUR;
		for (const v of Object.values(s.seats)) v.fiveResetAt = Date.now() + HOUR;
		const recovered = await s.get();
		check(`${tag}: next allowance resumes OAuth`, isOAuth(recovered, tag), `actual=${show(recovered)}`);
		clockOffsetMs -= 24 * HOUR;
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
		if (s.hooks.weeklyReports === 2) clockOffsetMs += 24 * HOUR;
		return report;
	};
	check(tag, isOAuth(await s.get(), tag), "recheck must reject decision crossing daily allowance boundary");
	clockOffsetMs -= 24 * HOUR;
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
	// Reports refresh after at most 6.25 minutes; Anthropic automatic affinity remains warm for 60.
	s.seats.rin.weekly = 0.2;
	s.seats.mio.weekly = 0.3;
	clockOffsetMs += 10 * 60_000;
	const paid = await s.get();
	check(`${tag}: still-warm OAuth yields to daily API fallback`, paid === FILE_KEY, `actual=${show(paid)}`);
	check(`${tag}: paid request has no OAuth identity`, identityOf(s.auth, s.sessionId) === undefined, "incorrect OAuth attribution");
	s.seats.rin.weekly = 0.01;
	clockOffsetMs += 10 * 60_000;
	const recovered = await s.get();
	check(`${tag}: same session recovers to below-budget OAuth`, recovered === `rin-${tag}`, `actual=${show(recovered)}`);
	check(`${tag}: recovered identity is OAuth again`, identityOf(s.auth, s.sessionId) === recovered, "stale paid marker");
	clockOffsetMs -= 20 * 60_000;
	s.auth.close();
}

console.log(`결과: ${passes} pass, ${failures} fail`);
process.exit(failures > 0 ? 1 : 0);
