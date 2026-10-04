// Anthropic 계정 자리·인증 복구 회귀(2026-10-04 KYS 실측 모양). 같은 org의 두 계정 cld1(자리 0, RIN)·cld2(자리 1, MIO)에서
// cld1이 refresh 만료로 비활성화되면 upstream은 활성 배열 index를 position으로 써서 cld2가 자리 0(RIN)으로 당겨졌고,
// 재로그인은 새 행을 만들어 [cld2, cld1]로 뒤집혔다. omp usage는 org만 같은 다른 사람의 tombstone을 숨겼다.
// [자리] 비활성 계정의 자리는 비고 뒤 계정은 그대로다. 프로세스를 새로 열어도 같다. 빈 자리를 고르면 다른 계정으로 대체하지 않는다.
// [복구] 같은 identity 재로그인은 같은 credential id·자리로 돌아오고 그 id의 block은 그대로다. 같은 org 다른 email은 되살리지 않는다.
// [반납] 로그아웃(deleted by user)한 계정은 자리를 반납한다.
// [표시] omp usage는 같은 org 다른 email의 인증 실패를 보여 주고, 같은 identity가 다시 활성이면 숨긴다.
// patch는 임시 source fixture에만 적용한다. AUTH_RECOVERY_BASELINE=1 이면 target 설치본 원본을 읽는다(수정 전 RED 확인용).
// 실제 credential·네트워크 호출은 없다: fixture SQLite에 가짜 OAuth 행만 쓴다.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

if (!process.env.OMP_AUTH_RECOVERY_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-auth-recovery-"));
	const home = join(root, "home");
	mkdirSync(home);
	let exitCode = 1;
	try {
		const child = Bun.spawnSync([process.execPath, import.meta.path], {
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_AUTH_RECOVERY_ROOT: root,
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
const temp = process.env.OMP_AUTH_RECOVERY_ROOT;
const fixture = join(temp, "target");
const patchHome = join(temp, "patch-home");
const toUrl = (path: string) => path.replace(/\\/g, "/");
const aiRoot = join(dirname(core), "pi-ai/src");
const baseline = process.env.AUTH_RECOVERY_BASELINE === "1";
let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail: unknown): void {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
	ok ? passes++ : failures++;
}

if (!existsSync(join(aiRoot, "auth-storage.ts"))) throw new Error(`코어 원본을 찾지 못했다: ${aiRoot}`);
const source = readFileSync(script, "utf8");
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
	name: "auth-recovery-fixture",
	setup(build) {
		build.onLoad({ filter: /[/\\]@oh-my-pi[/\\][\w-]+[/\\].+\.ts$/ }, args => {
			const [pkg, ...rest] = toUrl(args.path).split("/@oh-my-pi/").at(-1)!.split("/");
			const patched = pkg === corePackage ? join(fixture, ...rest) : join(fixture, "..", pkg!, ...rest);
			const contents = readFileSync(baseline || !existsSync(patched) ? args.path : patched, "utf8");
			if (args.path.endsWith(".d.ts")) return { exports: { default: contents }, loader: "object" };
			return { contents, loader: "ts" };
		});
	},
});
// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET, so these cannot be static imports.
const { setAgentDir } = await import(toUrl(join(dirname(core), "pi-utils/src/dirs.ts")));
setAgentDir(join(process.env.HOME!, ".omp", "agent"));
const { AuthStorage } = await import(toUrl(join(aiRoot, "auth-storage.ts")));
const { formatUsageBreakdown } = await import(toUrl(join(core, "src/cli/usage-cli.ts")));
const { matchSessionPinAccounts, toSessionPinAccounts } = await import(toUrl(join(core, "src/slash-commands/helpers/session-pin.ts")));

const provider = "anthropic";
const ORG = "org-shared-fixture";
const EXPIRED = 'oauth refresh failed: Error: 400 {"error":"invalid_grant","error_description":"Refresh token expired"}';
const login = (who: string, token = who) => ({
	type: "oauth" as const,
	access: `access-${token}`,
	refresh: `refresh-${token}`,
	expires: Date.now() + 86_400_000,
	email: `${who}@example.test`,
	accountId: `acct-${who}`,
	orgId: ORG,
});
type Account = { position: number; credentialId: number; email?: string };
const seats = (auth: { oauth: { accounts(provider: string): Account[] } }) =>
	auth.oauth.accounts(provider).map(account => ({ email: account.email?.split("@")[0], id: account.credentialId, position: account.position }));

const dbPath = join(temp, "auth.db");
const auth = await AuthStorage.create(dbPath);
try {
	await auth.credentials.upsert(provider, login("cld1"));
	await auth.credentials.upsert(provider, login("cld2"));
	const [cld1, cld2] = auth.oauth.accounts(provider) as Account[];
	const id1 = cld1!.credentialId;
	const id2 = cld2!.credentialId;
	check("초기 자리: cld1 0, cld2 1", cld1!.position === 0 && cld2!.position === 1, seats(auth));
	const MANUAL_UNTIL = Date.now() + 10 * 365 * 86_400_000;
	auth.blocks.upsert({ credentialId: id1, providerKey: `${provider}:oauth`, blockScope: "", blockedUntilMs: MANUAL_UNTIL });

	// [자리] cld1 refresh 만료.
	await auth.credentials.disable(id1, EXPIRED);
	const afterDisable = auth.oauth.accounts(provider) as Account[];
	check(
		"cld1 비활성: 활성 목록은 cld2 하나이고 cld2는 자리 1을 유지",
		afterDisable.length === 1 && afterDisable[0]!.credentialId === id2 && afterDisable[0]!.position === 1,
		seats(auth),
	);
	check("빈 자리 0을 고르면 계정이 없다(cld2로 대체하지 않음)", afterDisable.find(account => account.position === 0) === undefined, seats(auth));
	const pinTargets = toSessionPinAccounts(afterDisable);
	check(
		"/session pin 1은 고를 계정이 없고 2는 cld2",
		matchSessionPinAccounts(pinTargets, "1").length === 0 && matchSessionPinAccounts(pinTargets, "2")[0]?.credentialId === id2,
		{ one: matchSessionPinAccounts(pinTargets, "1").map((a: Account) => a.credentialId), two: matchSessionPinAccounts(pinTargets, "2").map((a: Account) => a.credentialId) },
	);
	check("credentials.oauthSeatIds는 비활성 cld1 자리를 포함", JSON.stringify(auth.credentials.oauthSeatIds?.(provider)) === JSON.stringify([id1, id2]), auth.credentials.oauthSeatIds?.(provider));
	const reopened = await AuthStorage.create(dbPath);
	try {
		await reopened.credentials.reload();
		check("새 프로세스로 다시 열어도 cld2는 자리 1", (reopened.oauth.accounts(provider) as Account[])[0]?.position === 1, seats(reopened));
	} finally {
		reopened.close();
	}

	// 같은 org의 다른 사람 로그인은 cld1 tombstone을 되살리지 않는다.
	await auth.credentials.upsert(provider, login("cld3"));
	const cld3 = (auth.oauth.accounts(provider) as Account[]).find(account => account.email === "cld3@example.test");
	const tombstones = await auth.credentials.listDisabled(provider);
	check(
		"같은 org 다른 email(cld3)은 새 행·새 자리 2이고 cld1 tombstone은 남는다",
		cld3 !== undefined && cld3.credentialId !== id1 && cld3.position === 2 && tombstones.some((row: { id: number }) => row.id === id1),
		{ seats: seats(auth), tombstones: tombstones.map((row: { id: number }) => row.id) },
	);

	// [복구] cld1 재로그인(새 토큰, 같은 identity).
	await auth.credentials.upsert(provider, login("cld1", "cld1-relogin"));
	const relogged = auth.oauth.accounts(provider) as Account[];
	const back = relogged.find(account => account.email === "cld1@example.test");
	check(
		"cld1 재로그인: 같은 credential id·자리 0, cld2 1, cld3 2",
		back?.credentialId === id1 && back.position === 0
			&& relogged.find(account => account.credentialId === id2)?.position === 1
			&& relogged.find(account => account.credentialId === cld3?.credentialId)?.position === 2,
		seats(auth),
	);
	check("재로그인 뒤 cld1 tombstone은 없다", !(await auth.credentials.listDisabled(provider)).some((row: { id: number }) => row.id === id1), await auth.credentials.listDisabled(provider));
	check(
		"재로그인은 그 id의 수동 OFF block을 해제하지 않는다",
		auth.blocks.list([id1]).some((block: { blockScope: string; blockedUntilMs: number }) => block.blockScope === "" && block.blockedUntilMs === MANUAL_UNTIL),
		auth.blocks.list([id1]),
	);

	// [반납] cld3 로그아웃.
	await auth.credentials.removeById(provider, cld3!.credentialId);
	check("로그아웃한 cld3은 자리를 반납한다", JSON.stringify(seats(auth).map(row => row.position)) === "[0,1]" && seats(auth).length === 2, seats(auth));
} finally {
	auth.close();
}

// [표시] omp usage의 tombstone 판정(formatUsageBreakdown → isActionableDisable).
const active = (who: string) => ({ provider, type: "oauth" as const, email: `${who}@example.test`, accountId: `acct-${who}`, orgId: ORG });
const tombstone = { id: 9, provider, type: "oauth" as const, cause: EXPIRED, email: "cld1@example.test", accountId: "acct-cld1", orgId: ORG };
const otherMember = formatUsageBreakdown([], [active("cld2")], Date.now(), undefined, [tombstone]);
check("같은 org 다른 email의 인증 실패는 omp usage에 보인다", otherMember.includes("cld1@example.test"), otherMember);
const sameIdentity = formatUsageBreakdown([], [active("cld1")], Date.now(), undefined, [tombstone]);
check("같은 identity가 다시 활성이면 tombstone은 숨긴다", !sameIdentity.includes("Refresh token expired"), sameIdentity);

console.log(`\n결과: ${passes} pass, ${failures} fail`);
process.exit(failures === 0 ? 0 : 1);
