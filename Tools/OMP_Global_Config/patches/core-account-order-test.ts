// Anthropic 계정 선택 회귀(OMP 18.4.x namespaced auth). 2026-10-02 사용자 정책 두 가지를 실제 경로에서 본다.
// [순서] 새/cold 선택: 오늘 몫 안쪽 계정 중 required drain(남은 주간 비율 ÷ 리셋까지 남은 시간)이 큰 계정 먼저,
//        몫을 넘은 계정은 그 뒤(둘 다 넘으면 덜 넘은 쪽), 동률은 저장 순서. 실제 AuthStorage.keys.get 경로.
// [상속] summon marker 없는 일반 maker child는 부모 세션의 Anthropic pin(warm·exact)을 물려받지 않는다.
//        summon child는 지정 위치 exact pin, 다른 provider 상속과 maker 아닌 child 상속은 그대로다.
//        실제 runSubprocess → createAgentSession 경로(task 도구는 structured-subagent 가 credentialSourceSessionId 를 넣는다).
// patch는 임시 source fixture에만 적용하고, Bun은 fixture에 있는 patched .ts 만 설치본 대신 읽는다.
// 이미 patch된 target이면 OMP_CORE_PATCH_BACKUP(그 target의 pristine 사본)에서 원본을 복사한다.
// ACCOUNT_ORDER_BASELINE=1 이면 target 설치본 파일을 그대로 읽는다(수정 전 RED 확인용).
// 실제 credential·네트워크·과금 호출은 없다: fixture SQLite, usage resolver fixture, provider 요청 전 abort.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// runSubprocess 는 agentDir·세션 파일을 쓰므로 HOME·TEMP 를 격리한 자식 프로세스에서 돈다.
// SDK DB 핸들이 열린 자식에서 지우지 않고, 종료를 기다린 부모가 이 실행의 fixture만 지운다.
if (!process.env.OMP_ACCOUNT_ORDER_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-account-order-"));
	const home = join(root, "home");
	const temp = join(root, "temp");
	mkdirSync(home);
	mkdirSync(temp);
	let exitCode = 1;
	try {
		const child = Bun.spawnSync([process.execPath, import.meta.path], {
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				TEMP: temp,
				TMP: temp,
				TMPDIR: temp,
				PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_ACCOUNT_ORDER_ROOT: root,
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
const core = process.env.OMP_CORE_PATCH_TARGET ?? [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent")].find(dir => existsSync(dir)) ?? join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent");
const script = resolve(import.meta.dirname, "apply-core-patch.mjs");
const characterVoice = resolve(import.meta.dirname, "../agent/extensions/character-voice.ts");
const source = readFileSync(script, "utf8");
const temp = process.env.OMP_ACCOUNT_ORDER_ROOT;
const fixture = join(temp, "target");
const patchHome = join(temp, "patch-home");
const toUrl = (path: string) => path.replace(/\\/g, "/");
const aiRoot = join(dirname(core), "pi-ai/src");
const baseline = process.env.ACCOUNT_ORDER_BASELINE === "1";
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

// Import resolution stays anchored to the installed packages; only the contents of
// .ts files that the fixture patched come from the throwaway copy.
// The fixture mirrors the patch layout: <fixture>/src/... is pi-coding-agent, <fixture>/../<pkg>/... the siblings.
const corePackage = basename(core);
Bun.plugin({
	name: "account-order-fixture",
	setup(build) {
		build.onLoad({ filter: /[/\\]@oh-my-pi[/\\][\w-]+[/\\].+\.ts$/ }, args => {
			const [pkg, ...rest] = toUrl(args.path).split("/@oh-my-pi/").at(-1)!.split("/");
			const patched = pkg === corePackage ? join(fixture, ...rest) : join(fixture, "..", pkg!, ...rest);
			const useOriginal = baseline || !existsSync(patched);
			return { contents: readFileSync(useOriginal ? args.path : patched, "utf8"), loader: "ts" };
		});
	},
});
// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET, so these cannot be static imports.
const { setAgentDir } = await import(toUrl(join(dirname(core), "pi-utils/src/dirs.ts")));
setAgentDir(join(process.env.HOME!, ".omp", "agent"));
const { AuthStorage } = await import(toUrl(join(aiRoot, "auth-storage.ts")));
const { claudeRankingStrategy } = await import(toUrl(join(aiRoot, "usage/claude.ts")));
const { runSubprocess } = await import(toUrl(join(core, "src/task/executor.ts")));
const { Settings } = await import(toUrl(join(core, "src/config/settings.ts")));
const { ModelRegistry } = await import(toUrl(join(core, "src/config/model-registry.ts")));

const future = Date.now();
const window = (provider: string, id: string, fraction: number | undefined, resetHours: number | null, tier?: string) => ({
	id: tier ? `${provider}:${tier}:7d` : `${provider}:${id}`,
	label: tier ? `${tier} weekly` : id,
	scope: { provider, windowId: id, ...(tier ? { tier } : { shared: true }) },
	window: { id, label: id, durationMs: (id === "5h" ? 5 : 168) * 3_600_000, ...(resetHours === null ? {} : { resetsAt: future + resetHours * 3_600_000 }) },
	amount: fraction === undefined || Number.isNaN(fraction)
		? { unit: "unknown" as const }
		: {
				used: fraction * 100,
				limit: 100,
				remaining: 100 - fraction * 100,
				usedFraction: fraction,
				remainingFraction: 1 - fraction,
				unit: "percent" as const,
			},
	status: fraction === undefined || Number.isNaN(fraction)
		? "unknown" as const
		: fraction >= 1 ? "exhausted" as const : "ok" as const,
});
type Fractions = {
	five?: number;
	weekly?: number;
	tier?: number;
	report?: boolean;
	/** Hours until the shared 7d window resets; null = no reset clock. */
	weeklyReset?: number | null;
	/** Hours until the 5h window resets; null = no reset clock (parser shape for an idle 0% window). */
	fiveReset?: number | null;
};
const makeReport = (provider: string, values: Fractions) => ({
	provider,
	fetchedAt: Date.now(),
	limits: [
		window(provider, "5h", values.five, values.fiveReset === undefined ? 4 : values.fiveReset),
		window(provider, "7d", values.weekly, values.weeklyReset === undefined ? 150 : values.weeklyReset),
		...(values.tier === undefined ? [] : [window(provider, "7d", values.tier, 130, "fable")]),
	],
});
async function selected(tag: string, opts: {
	rin?: Fractions;
	mio?: Fractions;
	provider?: string;
	modelId?: string;
	pin?: "warm" | "cold" | "exact";
	block?: boolean;
	rinReservePct?: number;
}) {
	const provider = opts.provider ?? "anthropic";
	// 2026-09-26 Main 관측 모양: RIN 7d 81%·약 2일 뒤 reset, MIO 7d 3%·약 7일 뒤 reset.
	const rin: Fractions = { five: 0, weekly: 0.81, weeklyReset: 46, ...opts.rin };
	const mio: Fractions = { five: 0.1, weekly: 0.03, weeklyReset: 160, ...opts.mio };
	const reports = {
		[`rin-${tag}`]: makeReport(provider, rin),
		[`mio-${tag}`]: makeReport(provider, mio),
	};
	if (rin.fiveReset === null) {
		const fiveHour = reports[`rin-${tag}`].limits[0]!;
		check(
			"0% 5h fixture는 parser처럼 status ok, amount 0, resetsAt 필드 부재",
			fiveHour.status === "ok" &&
				fiveHour.amount.usedFraction === 0 &&
				!("resetsAt" in fiveHour.window),
			JSON.stringify(fiveHour),
		);
	}
	const auth = await AuthStorage.create(join(temp, `${tag}.db`), {
		usageProviderResolver: (current: string) => current === provider ? {
			id: current,
			fetchUsage: async ({ credential }: { credential: { accessToken?: string } }) => {
				const token = credential.accessToken ?? "";
				const values = token.startsWith("rin-") ? rin : mio;
				return values.report === false ? null : reports[token] ?? null;
			},
		} : undefined,
		rankingStrategyResolver: (current: string) => current === provider ? claudeRankingStrategy : undefined,
		...(opts.rinReservePct === undefined
			? {}
			: { accountPolicies: [{ provider, account: { accountId: `rin-${tag}` }, reservePct: opts.rinReservePct }] }),
	});
	try {
		for (const identity of ["rin", "mio"]) await auth.credentials.upsert(provider, {
			type: "oauth",
			access: `${identity}-${tag}`,
			refresh: `refresh-${identity}-${tag}`,
			expires: Date.now() + 86_400_000,
			accountId: `${identity}-${tag}`,
		});
		const accounts = auth.oauth.accounts(provider);
		const sessionId = `session-${tag}`;
		if (opts.pin) auth.sessions.pin(provider, sessionId, accounts[1]!.credentialId, {
			...(opts.pin === "cold" ? { restoredAtMs: Date.now() - 2 * 3_600_000 } : {}),
			...(opts.pin === "exact" ? { exactLabel: "MIO" } : {}),
		});
		if (opts.block) await auth.limits.markReached(provider, sessionId, {
			credentialId: accounts[0]!.credentialId,
			retryAfterMs: 3_600_000,
		});
		return await auth.keys.get(provider, sessionId, { modelId: opts.modelId ?? "claude-opus-5" });
	} finally {
		auth.close();
	}
}

console.log("[순서] 7d 168h 창의 오늘 몫 = (지난 날 수 + 1) / 7. drain = (1 - 사용률) / 남은 시간(h)");
// reset 150h 뒤 → 18h 경과 → 1/7(14.3%), 145h → 23h → 1/7, 143h → 25h → 2/7(28.6%),
// 100h → 68h → 3/7, 46h → 122h → 6/7(85.7%), 20h → 148h → 7/7.
const cases = [
	["둘 다 몫 안: 리셋 임박·잔량 많은 위치 1(MIO 50%·20h, drain .025)이 RIN(10%·150h, .006)보다 앞", "mio", { rin: { weekly: 0.1, weeklyReset: 150 }, mio: { weekly: 0.5, weeklyReset: 20 } }],
	["관측 모양(RIN 81%·46h .0041, MIO 3%·160h .0061): 둘 다 몫 안이면 drain 큰 MIO", "mio", {}],
	["둘 다 몫 안: drain 큰 RIN(10%·20h, .045)이 앞", "rin", { rin: { weekly: 0.1, weeklyReset: 20 } }],
	["같은 drain(20%·100h)이면 5h가 더 차 있어도 저장 순서 RIN", "rin", { rin: { five: 0.3, weekly: 0.2, weeklyReset: 100 }, mio: { five: 0.1, weekly: 0.2, weeklyReset: 100 } }],
	["RIN 20%가 첫날 몫 14.3%를 넘으면 drain이 커도(.0055 > .0043) 몫 안 MIO", "mio", { rin: { weekly: 0.2, weeklyReset: 145 }, mio: { weekly: 0.8, weeklyReset: 46 } }],
	["날이 바뀌어 몫이 28.6%가 되면 같은 20%의 RIN이 다시 앞(drain .0056)", "rin", { rin: { weekly: 0.2, weeklyReset: 143 }, mio: { weekly: 0.8, weeklyReset: 46 } }],
	["MIO가 몫을 넘으면 drain이 커도 몫 안 RIN", "rin", { rin: { weekly: 0.85, weeklyReset: 46 }, mio: { weekly: 0.2, weeklyReset: 150 } }],
	["둘 다 넘으면 덜 넘은 MIO", "mio", { rin: { weekly: 0.5, weeklyReset: 150 }, mio: { weekly: 0.3, weeklyReset: 160 } }],
	["둘 다 넘으면 덜 넘은 RIN", "rin", { rin: { weekly: 0.2, weeklyReset: 150 }, mio: { weekly: 0.5, weeklyReset: 160 } }],
	["RIN 5h 0%·리셋시각 없음도 측정된 후보: 몫 초과 RIN은 몫 안 MIO 뒤", "mio", { rin: { fiveReset: null, weekly: 0.2, weeklyReset: 150 }, mio: { weekly: 0.85, weeklyReset: 46 } }],
	["RIN 7d 소진이면 제외하고 MIO", "mio", { rin: { weekly: 1 } }],
	["RIN 5h 소진(hard limit)이면 MIO", "mio", { rin: { five: 1 } }],
	["RIN 5h 90%(upstream hot guard)면 drain이 커도 기존 랭킹 MIO", "mio", { rin: { five: 0.9, weekly: 0.1, weeklyReset: 20 } }],
	["RIN 차단이면 drain이 커도 MIO", "mio", { block: true, rin: { weekly: 0.1, weeklyReset: 20 } }],
	["RIN이 reserve 정책 안이면 drain이 커도 MIO", "mio", { rinReservePct: 25, rin: { weekly: 0.8, weeklyReset: 20 } }],
	["RIN 7d 미측정이면 재배열 없이 upstream 순서(RIN) 그대로", "rin", { rin: { weekly: undefined } }],
	["RIN 7d reset 시각 없음이면 추정 없이 기존 랭킹 MIO", "mio", { rin: { weeklyReset: null } }],
	["RIN 5h 미측정이면 기존 랭킹 MIO", "mio", { rin: { five: undefined } }],
	["RIN 사용량 조회 실패면 기존 랭킹 MIO", "mio", { rin: { report: false } }],
	["MIO 사용량 조회 실패면 기존 랭킹 그대로 RIN", "rin", { mio: { report: false } }],
	["Fable tier 7d 미측정이면 기존 랭킹 MIO", "mio", { modelId: "claude-fable-5", rin: { tier: Number.NaN }, mio: { tier: 0.4 } }],
	["Fable tier 7d 소진이면 제외하고 MIO", "mio", { modelId: "claude-fable-5", rin: { tier: 1 }, mio: { tier: 0.4 } }],
	["cold MIO pin은 drain 큰 RIN으로 재선택", "rin", { pin: "cold", rin: { weekly: 0.1, weeklyReset: 20 } }],
	["warm MIO pin은 drain이 낮아도 그대로 유지", "mio", { pin: "warm", rin: { weekly: 0.1, weeklyReset: 20 } }],
	["exact MIO summon은 drain이 낮아도 그대로 유지", "mio", { pin: "exact", rin: { weekly: 0.1, weeklyReset: 20 } }],
	["타 provider는 몫 규칙 없이 기존 랭킹(drain 큰 RIN)", "rin", { provider: "openai-codex", modelId: undefined, rin: { weekly: 0.2, weeklyReset: 150 }, mio: { weekly: 0.85, weeklyReset: 46 } }],
] as const;
for (let index = 0; index < cases.length; index++) {
	const [label, expected, options] = cases[index]!;
	const actual = await selected(`case-${index}`, options);
	check(label, actual === `${expected}-case-${index}`, `expected=${expected}-case-${index} actual=${actual}`);
}

console.log("[상속] 부모 pin → child session(runSubprocess). 위치는 저장 순서(0=RIN, 1=MIO)");
const ANTHROPIC_MODEL = "anthropic/claude-opus-5-5";
const RIN_MARKER = `[character-summon alias="RIN(린)" model="${ANTHROPIC_MODEL}" oauth-position="0"]`;
type Snapshot = { phase: string; anthropic: number | null; codex: number | null; exact: string | null };
async function childAccounts(tag: string, opts: { parent: "warm" | "exact"; agentName?: string; summon?: boolean }) {
	const dir = join(temp, `inherit-${tag}`);
	const work = join(dir, "work");
	mkdirSync(work, { recursive: true });
	const out = join(dir, "accounts.jsonl");
	const probe = join(dir, "probe-extension.ts");
	writeFileSync(
		probe,
		`import { appendFileSync } from "node:fs";
export default function (pi) {
	const snapshot = (phase, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const auth = ctx.modelRegistry.authStorage;
		const active = provider => auth.oauth.accounts(provider, sessionId).find(account => account.active)?.position ?? null;
		const row = { phase, anthropic: active("anthropic"), codex: active("openai-codex"), exact: auth.sessions.exactLabel("anthropic", sessionId) ?? null };
		appendFileSync(${JSON.stringify(out)}, JSON.stringify(row) + "\\n");
	};
	pi.on("session_start", async (_event, ctx) => snapshot("start", ctx));
	pi.on("before_provider_request", async (_event, ctx) => {
		snapshot("request", ctx);
		// Hold the request; the harness aborts once it is recorded, so nothing is sent.
		await Promise.withResolvers().promise;
	});
}
`,
	);
	const rows = (): Snapshot[] => existsSync(out)
		? readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
		: [];
	// usage resolver 없음: ranking 이 provider usage API 를 부르지 않는다.
	const auth = await AuthStorage.create(join(dir, "auth.db"), { usageProviderResolver: () => undefined });
	try {
		for (const provider of ["anthropic", "openai-codex"]) {
			for (const identity of ["first", "second"]) await auth.credentials.upsert(provider, {
				type: "oauth",
				access: `${provider}-${identity}-${tag}`,
				refresh: `refresh-${provider}-${identity}-${tag}`,
				expires: Date.now() + 86_400_000,
				accountId: `${provider}-${identity}-${tag}`,
			});
		}
		const parent = `parent-${tag}`;
		const anthropic = auth.oauth.accounts("anthropic");
		const codex = auth.oauth.accounts("openai-codex");
		auth.sessions.pin("anthropic", parent, anthropic[1]!.credentialId, opts.parent === "exact" ? { exactLabel: "MIO(미오)" } : { restoredAtMs: Date.now() });
		auth.sessions.pin("openai-codex", parent, codex[1]!.credentialId, { restoredAtMs: Date.now() });
		const registry = new ModelRegistry(auth, undefined, {
			cacheDbPath: join(dir, "models.db"),
			fetch: (async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as never,
		});
		const controller = new AbortController();
		const poll = setInterval(() => {
			if (rows().some(row => row.phase === "request")) controller.abort();
		}, 20);
		const timeout = setTimeout(() => controller.abort(), 60_000);
		await runSubprocess({
			cwd: work,
			agent: { name: opts.agentName ?? "maker", description: "account probe", systemPrompt: "account probe", tools: ["read"], model: ANTHROPIC_MODEL, source: "project" },
			task: opts.summon ? `${RIN_MARKER}\naccount probe` : "account probe",
			index: 0,
			id: `AccountProbe-${tag}`,
			settings: Settings.isolated({}),
			modelRegistry: registry,
			credentialSourceSessionId: parent,
			preloadedExtensionPaths: [characterVoice, probe],
			enableMCP: false,
			enableLsp: false,
			signal: controller.signal,
		}).catch(() => undefined);
		clearInterval(poll);
		clearTimeout(timeout);
		controller.abort();
		const recorded = rows();
		return { start: recorded.find(row => row.phase === "start"), request: recorded.find(row => row.phase === "request") };
	} finally {
		auth.close();
	}
}
const show = (value: unknown) => JSON.stringify(value);
{
	const { start, request } = await childAccounts("warm-maker", { parent: "warm" });
	check("부모 warm MIO pin: 일반 maker child는 Anthropic pin 없이 시작", start !== undefined && start.anthropic === null, show(start));
	check("부모 warm openai-codex pin(위치 1)은 일반 maker child에 그대로 상속", start?.codex === 1, show(start));
	check("일반 maker child의 첫 요청은 exact 아님(새 선택)", request !== undefined && request.exact === null, show(request));
}
{
	const { start, request } = await childAccounts("exact-maker", { parent: "exact" });
	check("부모 exact MIO pin(교체 세션): 일반 maker child는 Anthropic pin 없이 시작", start !== undefined && start.anthropic === null && start.exact === null, show(start));
	check("일반 maker child 첫 요청은 MIO exact를 물려받지 않음", request !== undefined && request.exact === null, show(request));
}
{
	const { request } = await childAccounts("exact-summon", { parent: "exact", summon: true });
	check("부모 exact MIO + ‘린 호출’ summon child는 위치 0 RIN exact pin", request?.exact === "RIN(린)" && request.anthropic === 0, show(request));
}
{
	const { start } = await childAccounts("warm-other", { parent: "warm", agentName: "reviewer" });
	check("maker가 아닌 child는 부모 warm Anthropic pin(위치 1)을 그대로 상속", start?.anthropic === 1, show(start));
}
console.log(`결과: ${passes} pass, ${failures} fail`);
process.exit(failures > 0 ? 1 : 0);
