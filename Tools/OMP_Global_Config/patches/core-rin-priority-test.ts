// Anthropic 주간 reset 우선 정책을 실제 AuthStorage 선택 경로에서 본다(OMP 18.3.x namespaced auth).
// patch는 임시 source fixture에만 적용하고, Bun은 그 fixture의 patched pi-ai auth 모듈(auth-storage.ts,
// auth/*.ts)만 설치본 대신 읽는다. 실제 credential·네트워크는 쓰지 않는다.
// 이미 patch된 target이면 OMP_CORE_PATCH_BACKUP(그 target의 core-patch-backup)에서 pristine 사본을 복사한다.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
const core = process.env.OMP_CORE_PATCH_TARGET ?? [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent")].find(dir => existsSync(dir)) ?? join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent");
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
	const pristine = process.env.OMP_CORE_PATCH_BACKUP;
	for (const path of new Set([...source.matchAll(/^\s*file: "([^"]+)",\s*$/gm)].map(match => match[1]!))) {
		const backup = pristine ? join(pristine, path) : undefined;
		const original = backup && existsSync(backup) ? backup : join(core, path);
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
		// upstream required-drain은 MIO(0.97/160h)를 RIN(0.19/46h)보다 앞에 둔다.
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
			const access = await auth.keys.get(provider, sessionId, { modelId: opts.modelId ?? "claude-opus-5" });
			return access;
		} finally {
			auth.close();
		}
	}

	const cases = [
		["관측 재현: RIN 7d 81%·46h 뒤 reset이 MIO 3%·160h보다 빠르면 RIN", "rin", {}],
		["MIO 주간 reset이 더 빠르면 RIN 사용량이 낮아도 MIO", "mio", { rin: { weekly: 0.1, weeklyReset: 150 }, mio: { weekly: 0.5, weeklyReset: 20 } }],
		["RIN 5h 0%·리셋시각 없음이어도 주간 reset 빠른 RIN", "rin", { rin: { fiveReset: null } }],
		["reset 동률이면 남은 quota가 큰 MIO", "mio", { rin: { weekly: 0.3, weeklyReset: 46 }, mio: { weekly: 0.1, weeklyReset: 46 } }],
		["reset이 30초라도 빠르면 동률 허용 없이 RIN", "rin", { rin: { weekly: 0.5, weeklyReset: 46 }, mio: { weekly: 0.2, weeklyReset: 46 + 30 / 3600 } }],
		["완전 동률이면 기존 순서 RIN", "rin", { rin: { five: 0.1, weekly: 0.3, weeklyReset: 46 }, mio: { five: 0.1, weekly: 0.3, weeklyReset: 46 } }],
		["RIN 7d 소진이면 제외하고 MIO", "mio", { rin: { weekly: 1 } }],
		["RIN 5h 소진(hard limit)이면 MIO", "mio", { rin: { five: 1 } }],
		["RIN 5h 90%(upstream hot guard)면 기존 랭킹 MIO", "mio", { rin: { five: 0.9 } }],
		["RIN 차단이면 MIO", "mio", { block: true }],
		["RIN이 reserve 정책 안이면 MIO", "mio", { rinReservePct: 25 }],
		["RIN 7d 미측정이면 재배열 없이 upstream 순서(RIN) 그대로", "rin", { rin: { weekly: undefined } }],
		["RIN 7d reset 시각 없음이면 추정 없이 기존 랭킹 MIO", "mio", { rin: { weeklyReset: null } }],
		["RIN 5h 미측정이면 기존 랭킹 MIO", "mio", { rin: { five: undefined } }],
		["RIN 사용량 조회 실패면 기존 랭킹 MIO", "mio", { rin: { report: false } }],
		["MIO 사용량 조회 실패면 기존 랭킹 그대로 RIN", "rin", { mio: { report: false } }],
		["Fable tier 7d 미측정이면 기존 랭킹 MIO", "mio", { modelId: "claude-fable-5", rin: { tier: Number.NaN }, mio: { tier: 0.4 } }],
		["Fable tier 7d 소진이면 제외하고 MIO", "mio", { modelId: "claude-fable-5", rin: { tier: 1 }, mio: { tier: 0.4 } }],
		["cold MIO pin은 주간 reset 빠른 RIN으로 재선택", "rin", { pin: "cold" }],
		["warm MIO pin은 그대로 유지", "mio", { pin: "warm" }],
		["exact MIO summon은 그대로 유지", "mio", { pin: "exact" }],
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
