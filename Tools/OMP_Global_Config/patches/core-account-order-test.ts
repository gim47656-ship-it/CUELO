// Anthropic account selection regression (2026-11-18): fresh sessions prefer the lowest measured weekly
// usage, skipping 5h >=85% while cooler measured accounts exist; unmeasured follows measured.
// Ties use auth.accountPolicies priority, then storage order. Healthy serving pins remain unchanged.
// Login, pool reordering, restart and idle time must not change a working session's credential identity.
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
	// 캐릭터 summon의 OAuth 좌석은 2026-11-06부터 PC 설정(`config.yml` `characterSeats`)에서 온다.
	// 이 fixture는 임시 HOME을 쓰므로, summon 테스트가 위치 0/1을 보도록 좌석을 여기에 심는다.
	mkdirSync(join(home, ".omp", "agent"), { recursive: true });
	writeFileSync(join(home, ".omp", "agent", "config.yml"), 'characterSeats:\n  "RIN(린)": 0\n  "MIO(미오)": 1\n');
	let exitCode = 1;
	try {
		const child = Bun.spawnSync([process.execPath, import.meta.path], {
			cwd: process.cwd(),
			env: {
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
const core = process.env.OMP_CORE_PATCH_TARGET ?? [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(process.env.CUELO_REAL_HOME ?? homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent")].find(dir => existsSync(dir)) ?? join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent");
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

// Upgrade an independently preserved 0.10.259..0.10.316 selection body in the isolated fixture.
if (!baseline) {
	const selectionPath = join(fixture, "../pi-ai/src/auth/select.ts");
	const patchedSelection = readFileSync(selectionPath, "utf8");
	const prioritySelection = `		// CUELO: fresh Anthropic sessions follow configured account priority, then storage order.
		// Accounts that cannot serve (blocked, expired, ineligible, reserve, limit reached) keep upstream slots.
		if (provider === "anthropic" && shouldRank && strategy) {
			const nowMs = Date.now();
			const usable = candidates.map(candidate => {
				const credential = candidate.selection.credential;
				if (
					candidate.inReserve === true ||
					(credential.refresh.trim().length === 0 && nowMs + OAUTH_REFRESH_SKEW_MS >= credential.expires) ||
					this.#deps.blocks.isBlocked(provider, providerKey, candidate.selection.index, blockScopes) ||
					(planGate && planGate(candidate.usage) === false)
				) return false;
				const usage = candidate.usage;
				return !(usage && isUsageLimitReached(reserveUsageLimits(strategy, usage, rankingContext)));
			});
			const slots = candidates.flatMap((_candidate, pos) => usable[pos] ? [pos] : []);
			const preferred = [...slots].sort((left, right) => {
				const a = candidates[left]!;
				const b = candidates[right]!;
				return (b.accountPriority ?? 0) - (a.accountPriority ?? 0) || a.selection.index - b.selection.index;
			}).map(pos => candidates[pos]!);
			slots.forEach((pos, order) => { candidates[pos] = preferred[order]!; });
		}
		const preflightFailures = new Set<OAuthCandidate>();`;
	const weeklyBody = /\t\t\/\/ CUELO: fresh Anthropic sessions prefer the lowest measured weekly usage\.[\s\S]*?\t\tconst preflightFailures = new Set<OAuthCandidate>\(\);/;
	if (!weeklyBody.test(patchedSelection)) throw new Error("Missing weekly selection upgrade target");
	writeFileSync(selectionPath, patchedSelection.replace(weeklyBody, prioritySelection));
	const runPatch = (args: string[]) => spawnSync("node", [script, ...args], {
		encoding: "utf8",
		env: { ...process.env, OMP_CORE_PATCH_TARGET: fixture, HOME: patchHome, USERPROFILE: patchHome },
	});
	const legacy = runPatch(["--check"]);
	check("priority-body upgrade: --check reports legacy", legacy.status === 1 && /legacy\s+\.\.\/pi-ai\/src\/auth\/select\.ts/.test(legacy.stdout), legacy.stdout + legacy.stderr);
	const upgraded = runPatch([]);
	check("priority-body upgrade: apply restores the weekly body byte-for-byte",
		upgraded.status === 0 && readFileSync(selectionPath, "utf8") === patchedSelection, upgraded.stdout + upgraded.stderr);
	const reapplied = runPatch([]);
	const checked = runPatch(["--check"]);
	check("weekly apply is idempotent and --check is clean",
		reapplied.status === 0 && checked.status === 0 && readFileSync(selectionPath, "utf8") === patchedSelection,
		reapplied.stdout + reapplied.stderr + checked.stdout + checked.stderr);
	const reverted = runPatch(["--revert"]);
	if (reverted.status !== 0) throw new Error(reverted.stdout + reverted.stderr);
	const pristineSelection = readFileSync(selectionPath, "utf8");
	writeFileSync(selectionPath, patchedSelection.replace(weeklyBody, prioritySelection));
	const legacyReverted = runPatch(["--revert"]);
	check("priority-body direct revert matches the pristine selection bytes",
		legacyReverted.status === 0 && readFileSync(selectionPath, "utf8") === pristineSelection,
		legacyReverted.stdout + legacyReverted.stderr);
	const restored = runPatch([]);
	check("re-apply after priority-body revert restores weekly selection",
		restored.status === 0 && readFileSync(selectionPath, "utf8") === patchedSelection,
		restored.stdout + restored.stderr);
}
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
			const contents = readFileSync(useOriginal ? args.path : patched, "utf8");
			// Runtime `.d.ts` imports are only ever `with { type: "text" }` (18.5.1 archive/browser/computer preludes);
			// a "ts" loader would turn the declaration source into an empty module with no default export. onLoad has
			// no "text" loader, so hand back the same shape: the source string as the default export.
			if (args.path.endsWith(".d.ts")) return { exports: { default: contents }, loader: "object" };
			return { contents, loader: "ts" };
		});
	},
});
// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET, so these cannot be static imports.
const { setAgentDir } = await import(toUrl(join(dirname(core), "pi-utils/src/dirs.ts")));
setAgentDir(join(process.env.HOME!, ".omp", "agent"));
const { AuthStorage } = await import(toUrl(join(aiRoot, "auth-storage.ts")));
const { claudeRankingStrategy } = await import(toUrl(join(aiRoot, "usage/claude.ts")));
const { registerOAuthProvider, unregisterOAuthProvider } = await import(toUrl(join(aiRoot, "registry/oauth/index.ts")));
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
	tierKind?: string;
	tierReset?: number;
};
const makeReport = (provider: string, values: Fractions) => ({
	provider,
	fetchedAt: Date.now(),
	limits: [
		window(provider, "5h", values.five, values.fiveReset === undefined ? 4 : values.fiveReset),
		window(provider, "7d", values.weekly, values.weeklyReset === undefined ? 150 : values.weeklyReset),
		...(values.tier === undefined ? [] : [window(provider, "7d", values.tier, values.tierReset ?? 130, values.tierKind ?? "fable")]),
	],
});
async function selected(tag: string, opts: {
	rin?: Fractions;
	mio?: Fractions;
	third?: Fractions;
	pinAccount?: number;
	provider?: string;
	modelId?: string;
	pin?: "warm" | "automatic" | "cold" | "exact";
	block?: boolean;
	blockAccount?: number;
	authFailure?: boolean;
	rinReservePct?: number;
	/** auth.accountPolicies priority per fixture account (reservePct 0, as in the profile config). */
	priority?: Partial<Record<"rin" | "mio" | "third", number>>;
	pinBlock?: boolean;
}) {
	const provider = opts.provider ?? "anthropic";
	// 2026-09-26 Main 관측 모양: RIN 7d 81%·약 2일 뒤 reset, MIO 7d 3%·약 7일 뒤 reset.
	const rin: Fractions = { five: 0, weekly: 0.81, weeklyReset: 46, ...opts.rin };
	const mio: Fractions = { five: 0.1, weekly: 0.03, weeklyReset: 160, ...opts.mio };
	const reports = {
		[`rin-${tag}`]: makeReport(provider, rin),
		[`mio-${tag}`]: makeReport(provider, mio),
		...(opts.third ? { [`third-${tag}`]: makeReport(provider, opts.third) } : {}),
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
		...(opts.authFailure ? {
			refreshOAuthCredential: async (_provider: unknown, _id: unknown, value: { access: string; refresh: string; expires: number }) => {
				if (value.access.startsWith("third-")) throw new Error("invalid_grant");
				return value;
			},
		} : {}),
		usageProviderResolver: (current: string) => current === provider ? {
			id: current,
			fetchUsage: async ({ credential }: { credential: { accessToken?: string } }) => {
				const token = credential.accessToken ?? "";
				const values = token.startsWith("rin-") ? rin : token.startsWith("third-") ? opts.third! : mio;
				return values.report === false ? null : reports[token] ?? null;
			},
		} : undefined,
		rankingStrategyResolver: (current: string) => current === provider
			? (provider === "anthropic" ? claudeRankingStrategy : { ...claudeRankingStrategy, stickyWarmMs: 60 * 60_000 })
			: undefined,
		...(opts.rinReservePct === undefined
			? opts.priority === undefined
				? {}
				: {
						accountPolicies: Object.entries(opts.priority).map(([identity, priority]) => ({
							provider, account: { accountId: `${identity}-${tag}` }, priority, reservePct: 0,
						})),
					}
			: { defaultReservePct: opts.pin ? 25 : 0, accountPolicies: [{ provider, account: { accountId: `rin-${tag}` }, reservePct: opts.rinReservePct }] }),
	});
	try {
		for (const identity of ["rin", "mio", ...(opts.third ? ["third"] : [])]) await auth.credentials.upsert(provider, {
			type: "oauth",
			access: `${identity}-${tag}`,
			refresh: `refresh-${identity}-${tag}`,
			expires: Date.now() + 86_400_000,
			accountId: `${identity}-${tag}`,
		});
		const accounts = auth.oauth.accounts(provider);
		const sessionId = `session-${tag}`;
		if (opts.pin) auth.sessions.pin(provider, sessionId, accounts[opts.pinAccount ?? 1]!.credentialId, {
			...(opts.pin === "cold" ? { restoredAtMs: Date.now() - 2 * 3_600_000 } : {}),
			...(opts.pin === "automatic" ? { restoredAtMs: Date.now() } : {}),
			...(opts.pin === "exact" ? { exactLabel: "MIO" } : {}),
		});
		if (opts.pinBlock) await auth.limits.markReached(provider, sessionId, {
			credentialId: accounts[opts.pinAccount ?? 1]!.credentialId,
			retryAfterMs: 3_600_000,
		});
		if (opts.block || opts.blockAccount !== undefined) await auth.limits.markReached(provider, sessionId, {
			credentialId: accounts[opts.blockAccount ?? 0]!.credentialId,
			retryAfterMs: 3_600_000,
		});
		return await auth.keys.get(provider, sessionId, { modelId: opts.modelId ?? "claude-opus-5", ...(opts.authFailure ? { forceRefresh: true } : {}) });
	} finally {
		auth.close();
	}
}

console.log("[Selection] Lowest measured weekly, 5h-hot behind cool, unmeasured last; priority/storage ties.");
const RIN3_FIRST = { third: 30, rin: 20, mio: 10 } as const;
const cases = [
	["lowest weekly beats storage order", "mio", { rin: { weekly: 0.81 }, mio: { weekly: 0.03 } }],
	["reset urgency does not override lowest weekly", "mio", { rin: { weekly: 0.9, weeklyReset: 20 }, mio: { weekly: 0.1, weeklyReset: 150 } }],
	["weekly beats configured priority", "rin", { priority: RIN3_FIRST, third: { five: 0.2, weekly: 0.7 }, rin: { weekly: 0.01 }, mio: { weekly: 0.02 } }],
	["weekly tie uses priority", "mio", { priority: { mio: 30, rin: 10 }, rin: { weekly: 0.2 }, mio: { weekly: 0.2 } }],
	["weekly and priority tie uses storage order", "rin", { rin: { weekly: 0.2 }, mio: { weekly: 0.2 } }],
	["5h 85% skips lowest weekly", "mio", { rin: { five: 0.85, weekly: 0.01 } }],
	["5h below 85% keeps lowest weekly", "rin", { rin: { five: 0.8499, weekly: 0.01 } }],
	["all 5h-hot falls back to lowest weekly", "mio", { priority: RIN3_FIRST, third: { five: 0.9, weekly: 0.4 }, rin: { five: 0.85, weekly: 0.3 }, mio: { five: 0.99, weekly: 0.2 } }],
	["observed 83/43/blocked 100 selects 43", "mio", { priority: RIN3_FIRST, blockAccount: 2, rin: { five: 0.67, weekly: 0.83 }, mio: { five: 0.11, weekly: 0.43 }, third: { five: 0.1, weekly: 1 } }],
	["reservePct 0 permits lowest weekly above 90%", "third", { priority: RIN3_FIRST, third: { five: 0.1, weekly: 0.95 }, rin: { weekly: 0.97 }, mio: { weekly: 0.99 } }],
	["top 5h exhausted uses lowest available weekly", "mio", { priority: RIN3_FIRST, third: { five: 1, weekly: 0.2 }, mio: { weekly: 0.01 } }],
	["top weekly exhausted uses lowest available weekly", "mio", { priority: RIN3_FIRST, third: { five: 0.1, weekly: 1 }, mio: { weekly: 0.01 } }],
	["top two exhausted uses remaining account", "mio", { priority: RIN3_FIRST, third: { five: 0.1, weekly: 1 }, rin: { five: 1 }, mio: { weekly: 0.9 } }],
	["blocked lowest account skipped", "mio", { priority: { rin: 30, mio: 20 }, block: true, rin: { weekly: 0.01 } }],
	["unmeasured high priority follows measured", "rin", { priority: RIN3_FIRST, third: { report: false }, rin: { weekly: 0.01 } }],
	["all unmeasured uses priority", "mio", { priority: { rin: 10, mio: 30 }, rin: { report: false }, mio: { report: false } }],
	["all unmeasured and equal priority uses storage", "rin", { rin: { report: false }, mio: { report: false } }],
	["clockless measured 0% 5h remains eligible", "rin", { rin: { fiveReset: null, weekly: 0.2 }, mio: { weekly: 0.85 } }],
	["clockless measured weekly remains eligible", "rin", { rin: { weekly: 0.02, weeklyReset: null } }],
	["exhausted weekly excluded", "mio", { rin: { weekly: 1 } }],
	["exhausted 5h excluded", "mio", { rin: { five: 1 } }],
	["blocked account excluded", "mio", { block: true, rin: { weekly: 0.01 } }],
	["reserve policy still applies at start", "mio", { rinReservePct: 25, rin: { weekly: 0.8 }, mio: { weekly: 0.9 } }],
	["unknown weekly follows measured", "mio", { rin: { weekly: undefined } }],
	["unknown 5h follows measured", "mio", { rin: { five: undefined, weekly: 0.01 } }],
	["failed measurement follows measured", "mio", { rin: { report: false } }],
	["measured 5h-hot still before unmeasured", "rin", { rin: { five: 0.9 }, mio: { report: false } }],
	["Fable exhausted tier excluded", "mio", { modelId: "claude-fable-5", rin: { tier: 1 }, mio: { tier: 0.4 } }],
	["Fable ignores irrelevant exhausted Sonnet tier", "rin", { modelId: "claude-fable-5", rin: { weekly: 0.01, tier: 1, tierKind: "sonnet" }, mio: { weekly: 0.4 } }],
	["idle >1h keeps original account", "mio", { pin: "cold", rin: { weekly: 0.01 }, mio: { weekly: 0.9 } }],
	["idle >1h near 5h limit keeps original account", "mio", { pin: "cold", rin: { weekly: 0.01 }, mio: { five: 0.99, weekly: 0.9 } }],
	["reserve does not evict idle serving account", "mio", { pin: "cold", rinReservePct: 0, rin: { weekly: 0.01 }, mio: { weekly: 0.99 } }],
	["idle >1h real 5h exhaustion switches", "rin", { pin: "cold", mio: { five: 1 } }],
	["idle >1h real weekly exhaustion switches", "rin", { pin: "cold", mio: { weekly: 1 } }],
	["idle >1h real block switches", "rin", { pin: "cold", pinBlock: true, mio: { report: false } }],
	["three accounts: exhausted 5h pin falls to lowest weekly, not priority", "mio", { pin: "cold", pinAccount: 2, priority: RIN3_FIRST, rin: { five: 0.1, weekly: 0.9 }, mio: { five: 0.1, weekly: 0.1 }, third: { five: 1, weekly: 0.2 } }],
	["three accounts: exhausted weekly automatic pin falls to lowest weekly, not priority", "mio", { pin: "automatic", pinAccount: 2, priority: RIN3_FIRST, rin: { five: 0.1, weekly: 0.9 }, mio: { five: 0.1, weekly: 0.1 }, third: { five: 0.1, weekly: 1 } }],
	["explicit user pin exhaustion retains existing priority fallback", "rin", { pin: "warm", pinAccount: 2, priority: RIN3_FIRST, rin: { five: 0.1, weekly: 0.9 }, mio: { five: 0.1, weekly: 0.1 }, third: { five: 0.1, weekly: 1 } }],
	["three accounts: blocked pin falls to lowest weekly, not priority", "rin", { pin: "cold", pinAccount: 2, pinBlock: true, priority: { mio: 30, rin: 20, third: 10 }, rin: { weekly: 0.1 }, mio: { five: 0.1, weekly: 0.9 }, third: { report: false } }],
	["healthy automatic pin stays despite lower weekly sibling", "third", { pin: "automatic", pinAccount: 2, priority: RIN3_FIRST, rin: { five: 0.1, weekly: 0.9 }, mio: { five: 0.1, weekly: 0.1 }, third: { five: 0.1, weekly: 0.2 } }],
	["three accounts: auth-failed automatic pin falls to lowest weekly, not priority", "mio", { pin: "automatic", pinAccount: 2, authFailure: true, priority: RIN3_FIRST, rin: { five: 0.1, weekly: 0.9 }, mio: { five: 0.1, weekly: 0.1 }, third: { five: 0.1, weekly: 0.2 } }],
	["definitive auth failure removes explicit pin and selects fresh by lowest weekly", "mio", { pin: "warm", pinAccount: 2, authFailure: true, priority: RIN3_FIRST, rin: { five: 0.1, weekly: 0.9 }, mio: { five: 0.1, weekly: 0.1 }, third: { five: 0.1, weekly: 0.2 } }],
	["warm pin remains", "mio", { pin: "warm", rin: { weekly: 0.01 } }],
	["exact summon remains", "mio", { pin: "exact", rin: { weekly: 0.01 } }],
	["other provider still reranks idle pin", "rin", { provider: "openai-codex", pin: "cold", rin: { weekly: 0.2, weeklyReset: 20 }, mio: { weekly: 0.85, weeklyReset: 150 } }],
] as const;
for (let index = 0; index < cases.length; index++) {
	const [label, expected, options] = cases[index]!;
	const actual = await selected(`case-${index}`, options);
	check(label, actual === `${expected}-case-${index}`, `expected=${expected}-case-${index} actual=${actual}`);
}

console.log("[Recovery] One auth store: lowest weekly serves, block switches by weekly, recovery only affects new sessions.");
{
	const provider = "anthropic";
	const tag = "recovery";
	let thirdWeekly = 0.1;
	const auth = await AuthStorage.create(join(temp, `${tag}.db`), {
		usageProviderResolver: (current: string) => current === provider ? {
			id: current,
			fetchUsage: async ({ credential }: { credential: { accessToken?: string } }) =>
				makeReport(provider, { five: 0.1, weekly: credential.accessToken?.startsWith("third-") ? thirdWeekly : credential.accessToken?.startsWith("mio-") ? 0.2 : 0.8 }),
		} : undefined,
		rankingStrategyResolver: (current: string) => current === provider ? claudeRankingStrategy : undefined,
		accountPolicies: Object.entries(RIN3_FIRST).map(([identity, priority]) => ({
			provider, account: { accountId: `${identity}-${tag}` }, priority, reservePct: 0,
		})),
	});
	try {
		for (const identity of ["rin", "mio", "third"]) await auth.credentials.upsert(provider, {
			type: "oauth",
			access: `${identity}-${tag}`,
			refresh: `refresh-${identity}-${tag}`,
			expires: Date.now() + 86_400_000,
			accountId: `${identity}-${tag}`,
		});
		const top = auth.oauth.accounts(provider)[2]!;
		const pick = (session: string) => auth.keys.get(provider, session, { modelId: "claude-opus-5" });
		const first = await pick("recovery-a");
		check("recovery: lowest weekly serves first", first === `third-${tag}`, `actual=${first}`);
		await auth.limits.markReached(provider, "recovery-a", { credentialId: top.credentialId, retryAfterMs: 500 });
		const blocked = await pick("recovery-a");
		check("recovery: serving block switches to lowest weekly, not next priority", blocked === `mio-${tag}`, `actual=${blocked}`);
		await Bun.sleep(800);
		const recovered = await pick("recovery-c");
		check("recovery: new session returns to lowest weekly once its block ended", recovered === `third-${tag}`, `actual=${recovered}`);
		const serving = await pick("recovery-a");
		check("recovery: existing session keeps its replacement after sibling recovers", serving === `mio-${tag}`, `actual=${serving}`);
		thirdWeekly = 1;
		await auth.usage.invalidate(provider);
		const exhausted = await pick("recovery-c");
		check("same-store weekly exhaustion: automatically selected serving account switches by lowest weekly",
			exhausted === `mio-${tag}`, `actual=${exhausted}`);
	} finally {
		auth.close();
	}
}

console.log("[Lifecycle] Login, durable resume, removal, disable and auth failure.");
async function lifecycle(tag: string, mutation: "append" | "before" | "remove" | "disable" | "auth-failure" | "resume" | "relogin", provider = "anthropic") {
	const db = join(temp, `lifecycle-${tag}.db`);
	const credential = (name: string) => ({
		type: "oauth" as const, accountId: name, access: name, refresh: `refresh-${name}`,
		expires: Date.now() + 86_400_000,
	});
	const loginProvider = `fixture-login-${tag}`;
	registerOAuthProvider({
		id: loginProvider, name: "Isolated login", storeCredentialsAs: provider,
		login: async () => credential(mutation === "before" ? "earlier" : "new"),
	});
	const options = {
		usageProviderResolver: (current: string) => current === provider ? {
			id: current,
			fetchUsage: async ({ credential }: { credential: { accessToken?: string } }) =>
				makeReport(provider, { five: 0.1, weekly: credential.accessToken?.startsWith("original") ? 0.8 : 0.01 }),
		} : undefined,
		rankingStrategyResolver: () => claudeRankingStrategy,
		refreshOAuthCredential: async (_provider: unknown, _id: unknown, value: { access: string; refresh: string; expires: number }) => {
			if (mutation === "auth-failure" && value.access === "original") throw new Error("invalid_grant");
			return value;
		},
	};
	let auth = await AuthStorage.create(db, options);
	try {
		if (mutation === "before") {
			await auth.credentials.upsert(provider, credential("earlier"));
			await auth.credentials.disable(auth.oauth.accounts(provider)[0]!.credentialId, "invalid_grant");
		}
		await auth.credentials.upsert(provider, credential("original"));
		const originalId = auth.oauth.accounts(provider).find(a => a.accountId === "original")!.credentialId;
		const sessionId = `lifecycle-${tag}`;
		// An actual resolve records automatic (not explicit user) affinity.
		await auth.keys.get(provider, sessionId, { modelId: "claude-opus-5-5" });
		const before = auth.credentials.list(provider).map(row => row.id);
		if (mutation === "resume") {
			auth.close();
			auth = await AuthStorage.create(db, options);
		}
		await auth.oauth.login(loginProvider, { onAuth: () => {}, onPrompt: async () => "" });
		if (mutation === "relogin") await auth.credentials.upsert(provider, { ...credential("original-2"), accountId: "original" });
		if (mutation === "before") {
			const after = auth.credentials.list(provider).map(row => row.id);
			check("R1-ANT-5: serving row really shifts from pool index 0 to 1",
				before.indexOf(originalId) === 0 && after.indexOf(originalId) === 1,
				JSON.stringify({ before, after, originalId }));
			console.log(`  R1-ANT-5 pool order: ${auth.credentials.list(provider).map(row => row.credential.accountId).join(", ")}`);
		}
		if (mutation === "remove") await auth.credentials.removeById(provider, originalId);
		if (mutation === "disable") await auth.credentials.disable(originalId, "invalid_grant");
		// Exercise the failing pin's refresh even against the old login-clears-pins implementation.
		if (mutation === "auth-failure") auth.sessions.pin(provider, sessionId, originalId, { restoredAtMs: Date.now() });
		const actual = await auth.keys.get(provider, sessionId, {
			modelId: "claude-opus-5-5",
			...(mutation === "auth-failure" ? { forceRefresh: true } : {}),
		});
		const keep = provider === "anthropic" && ["append", "before", "resume", "relogin"].includes(mutation);
		check(`${tag}: ${keep ? "keeps original row" : "selects healthy sibling"}`,
			actual === (keep ? mutation === "relogin" ? "original-2" : "original" : mutation === "before" ? "earlier" : "new"), `actual=${actual}`);
		if (keep) check(`${tag}: durable id stays stable across position changes`,
			auth.oauth.accounts(provider, sessionId).find(a => a.active)?.credentialId === originalId,
			JSON.stringify(auth.oauth.accounts(provider, sessionId).map(a => ({ id: a.credentialId, active: a.active }))));
		if (mutation === "auth-failure") check("definitive auth failure disables original row",
			!auth.credentials.list(provider).some(row => row.id === originalId),
			JSON.stringify(auth.credentials.list(provider).map(row => row.id)));
	} finally {
		auth.close();
		unregisterOAuthProvider(loginProvider);
	}
}
for (const mutation of ["append", "before", "remove", "disable", "auth-failure", "resume", "relogin"] as const)
	await lifecycle(mutation, mutation);
await lifecycle("codex-reset-unchanged", "append", "openai-codex");

console.log("[Weekly chooser] Existing strategy pressure choice stays unchanged.");
for (const kind of ["opus", "sonnet", "fable"]) {
	const report = makeReport("anthropic", { five: 0.1, weekly: 0.7, weeklyReset: 20, tier: 0.1, tierKind: kind, tierReset: 167 });
	const secondary = claudeRankingStrategy.findWindowLimits(report, { modelId: `claude-${kind}-5` }).secondary;
	console.log(`  ${kind}: shared=0.7 tier=0.1 secondary=${secondary?.id} used=${secondary?.amount.usedFraction}`);
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
	// Measured usage ensures maker children select fresh rather than inherit the parent.
	const auth = await AuthStorage.create(join(dir, "auth.db"), {
		usageProviderResolver: provider => provider === "anthropic" ? {
			id: provider,
			fetchUsage: async ({ credential }) => makeReport(provider, {
				five: 0.1, weekly: credential.accessToken?.includes("-first-") ? 0.01 : 0.8,
			}),
		} : undefined,
	});
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
	check("maker selects fresh by lowest weekly (position 0), not parent's account", request?.anthropic === 0, show(request));
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
