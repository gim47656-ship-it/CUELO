// Anthropic position N policy at the real AuthStorage selection path (OMP 18.3.0 namespaced auth).
// The patch runs against a throwaway source fixture; Bun loads only its patched
// pi-ai auth modules (auth-storage.ts, auth/*.ts) in place of the installed ones. No real credentials/network.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
const core = process.env.OMP_CORE_PATCH_TARGET ?? join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent");
const script = resolve(import.meta.dirname, "apply-core-patch.mjs");
const source = readFileSync(script, "utf8");
const temp = mkdtempSync(join(tmpdir(), "omp-rin-priority-"));
const fixture = join(temp, "target");
const home = join(temp, "home");
const aiRoot = join(dirname(core), "pi-ai/src");
const aiSource = join(aiRoot, "auth-storage.ts");
let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — ${detail}`}`);
	ok ? passes++ : failures++;
}

try {
	if (!existsSync(aiSource)) throw new Error(`코어 원본을 찾지 못했다: ${aiSource}`);
	// Copy only declared patch targets. The source install and its credentials stay untouched.
	for (const path of new Set([...source.matchAll(/^\s*file: "([^"]+)",\s*$/gm)].map(match => match[1]!))) {
		const original = join(core, path);
		if (!existsSync(original)) continue;
		const target = join(fixture, path);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(original, target);
	}
	mkdirSync(home, { recursive: true });
	const applied = spawnSync("node", [script], {
		encoding: "utf8",
		env: { ...process.env, OMP_CORE_PATCH_TARGET: fixture, HOME: home, USERPROFILE: home },
	});
	if (applied.status !== 0) throw new Error(`격리 패치 실패 (${applied.status}):\n${applied.stdout}\n${applied.stderr}`);
	console.log(`격리 패치 exit ${applied.status}`);

	// The loader keeps import resolution anchored to the actual installed package;
	// only the patched pi-ai auth modules' contents come from the throwaway fixture.
	// 18.3.0 split selection into auth/select.ts·affinity.ts·rotation.ts, so the fixture swap covers them all.
	const fixtureAiRoot = join(fixture, "../pi-ai/src");
	Bun.plugin({
		name: "rin-priority-fixture",
		setup(build) {
			build.onLoad({ filter: /[/\\]pi-ai[/\\]src[/\\](auth-storage|auth[/\\][\w-]+)\.ts$/ }, args => {
				const relative = args.path.replace(/\\/g, "/").split("/pi-ai/src/")[1]!;
				const patched = join(fixtureAiRoot, relative);
				const useOriginal = process.env.RIN_PRIORITY_BASELINE === "1" || !existsSync(patched);
				return { contents: readFileSync(useOriginal ? args.path : patched, "utf8"), loader: "ts" };
			});
		},
	});
	const { AuthStorage } = await import(`${aiSource.replace(/\\/g, "/")}`);
	const { claudeRankingStrategy } = await import(`${join(dirname(aiSource), "usage/claude.ts").replace(/\\/g, "/")}`);
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
		status: fraction === undefined || Number.isNaN(fraction) ? "unknown" as const : "ok" as const,
	});
	type Fractions = { five?: number; weekly?: number; tier?: number; report?: boolean };
	const makeReport = (provider: string, values: Fractions, quickReset: boolean, noFiveReset = false) => ({
		provider,
		fetchedAt: Date.now(),
		limits: [
			window(provider, "5h", values.five, noFiveReset ? null : 4),
			window(provider, "7d", values.weekly, quickReset ? 1 : 150),
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
		noFiveReset?: boolean;
	}) {
		const provider = opts.provider ?? "anthropic";
		const rin = opts.rin ?? { five: 0, weekly: 0.23 };
		const mio = opts.mio ?? { five: 0.1, weekly: 0.45 };
		const reports = {
			[`rin-${tag}`]: makeReport(provider, rin, false, opts.noFiveReset),
			[`mio-${tag}`]: makeReport(provider, mio, true),
		};
		if (opts.noFiveReset) {
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
			const access = await auth.keys.get(provider, sessionId, { modelId: opts.modelId ?? "claude-opus-5" });
			return access;
		} finally {
			auth.close();
		}
	}

	const cases = [
		["RIN 5h 0%, 7d 23%이면 MIO의 빠른 리셋보다 RIN 우선", "rin", {}],
		["RIN 5h 0%·리셋시각 없음, 7d 23%이면 RIN 우선", "rin", { noFiveReset: true }],
		["cold MIO pin은 RIN 여유 시 재선택", "rin", { pin: "cold" }],
		["warm MIO pin은 그대로 유지", "mio", { pin: "warm" }],
		["exact MIO summon은 그대로 유지", "mio", { pin: "exact" }],
		["RIN 5h·7d 79%는 엄격한 경계 아래", "rin", { rin: { five: 0.79, weekly: 0.79 } }],
		["RIN 5h 80%에서는 기존 랭킹 MIO", "mio", { rin: { five: 0.8, weekly: 0.23 } }],
		["RIN 7d 80%에서는 기존 랭킹 MIO", "mio", { rin: { five: 0, weekly: 0.8 } }],
		["Fable tier 7d 79%이면 RIN 여유로 선택", "rin", { modelId: "claude-fable-5", rin: { five: 0, weekly: 0.23, tier: 0.79 }, mio: { five: 0.1, weekly: 0.45, tier: 0.4 } }],
		["Fable tier 7d 80%에서는 기존 랭킹 MIO", "mio", { modelId: "claude-fable-5", rin: { five: 0, weekly: 0.23, tier: 0.8 }, mio: { five: 0.1, weekly: 0.45, tier: 0.4 } }],
		["Fable tier 7d 미측정이면 기존 랭킹 MIO", "mio", { modelId: "claude-fable-5", rin: { five: 0, weekly: 0.23, tier: Number.NaN }, mio: { five: 0.1, weekly: 0.45, tier: 0.4 } }],
		["RIN 7d 미측정이면 기존 랭킹 MIO", "mio", { rin: { five: 0, weekly: undefined } }],
		["RIN 5h 미측정이면 기존 랭킹 MIO", "mio", { rin: { five: undefined, weekly: 0.23 } }],
		["RIN 사용량 조회 실패면 기존 랭킹 MIO", "mio", { rin: { five: 0, weekly: 0.23, report: false } }],
		["RIN 차단 시 기존 랭킹 MIO", "mio", { block: true }],
		["타 provider는 기존 랭킹 MIO", "mio", { provider: "openai-codex", modelId: undefined }],
	] as const;
	for (let index = 0; index < cases.length; index++) {
		const [label, expected, options] = cases[index]!;
		const actual = await selected(`case-${index}`, options);
		check(label, actual === `${expected}-case-${index}`, `expected=${expected}-case-${index} actual=${actual}`);
	}
	console.log(`결과: ${passes} pass, ${failures} fail`);
	if (failures > 0) process.exitCode = 1;
} finally {
	rmSync(temp, { recursive: true, force: true });
}
