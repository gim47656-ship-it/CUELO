// 폴백 쿨다운·복귀 정책 회귀. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-policy-reapply-test.ts
// 미패치 core 에서는 [1] 이 FAIL(RED) — 설정 변경이 부르는 정책 재적용이 `refresh()` 를 그대로
// 불러 재시도 폴백 쿨다운을 지운다(2026-09-16 실측). 패치 core 에서는 전부 PASS(GREEN)다.
// 실제 ModelRegistry / TurnRecovery 를 호스트 스텁으로 구동하고 관측 가능한 결과(억제 여부·
// 카탈로그 재구성·모델 전환)만 본다. 네트워크·유료 호출·설정 변경 없음(mock fetch + scratch registry).
// 동적 import 예외: core-bai-retry-test.ts 와 같은 이유(지정한 사본만 검증).
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsTestScope } from "./core-test-settings";

/** 전역 npm 위치는 PC마다 다르다. apply-core-patch.mjs 와 같은 순서로 찾는다. */
function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(p => existsSync(join(p, "src/config/model-registry.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	// 동적 import 는 URL 로 해석되므로 역슬래시를 쓰면 안 된다.
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const { ModelRegistry } = await import(`${CORE}/config/model-registry.ts`);
const { TurnRecovery } = await import(`${CORE}/session/turn-recovery.ts`);
// pi-ai 는 coding-agent 의 형제 패키지다(전역 설치·isolated 사본 모두 같은 상대 위치).
const AUTH_STORAGE_PATH = join(CORE, "..", "..", "pi-ai", "src", "auth-storage.ts").replace(/\\/g, "/");
if (!existsSync(AUTH_STORAGE_PATH)) throw new Error(`pi-ai auth-storage 모듈을 찾지 못했다: ${AUTH_STORAGE_PATH}`);
const { AuthStorage } = await import(AUTH_STORAGE_PATH);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name} ${detail}`);
	}
}

// 폴백 체인은 effort 없는 selector 로 둔다. fixture 모델에는 thinking 설정이 없어 effort 를
// 붙이면 clamp·정규화가 끼어들고, 이 회귀가 보려는 것(억제와 복귀)이 흐려진다.
const PRIMARY_SELECTOR = "b-ai/deepseek-v4.1-flash";
const PRIMARY = { provider: "b-ai", id: "deepseek-v4.1-flash" };
const FALLBACK = { provider: "opencode-go", id: "muse-spark-1.3-contributor" };
const FALLBACK_SELECTOR = `${FALLBACK.provider}/${FALLBACK.id}`;
// 더미 키(비밀 아님). mock fetch·scratch registry 전용이며 네트워크에 나가지 않는다.
const fixtureApiKey = "example";

const workdir = mkdtempSync(join(tmpdir(), "omp-policy-reapply-"));
// 손으로 나열한 auth 스텁은 상류가 메서드를 늘릴 때마다 조용히 낡아 TypeError 로 죽는다
// (실측 18.2.5/18.2.6: `this.authStorage.setConfigValueResolver is not a function`).
// 그래서 실물 AuthStorage 를 scratch sqlite 로 띄운다. hermetic 근거: 저장소는 이 임시
// 디렉터리의 빈 db 뿐이고(자격증명 0건), fixture provider 는 pi-ai `serviceProviderMap`
// 밖의 가상 이름이라 env 별칭도 걸리지 않으며, 키는 models.yml 의 `apiKey` 를
// ModelRegistry 가 `setConfigApiKey` 로 심는 경로 하나로만 들어온다. 네트워크 호출은
// 주입한 mockFetch 뿐이고 실제 `~/.omp` 는 읽지도 쓰지도 않는다.
const auth = await AuthStorage.create(join(workdir, "auth.db"));
const mockFetch = (async () => ({
	ok: true,
	status: 200,
	json: async () => ({ data: [] }),
})) as never;

function modelsYmlText(extraModel: boolean): string {
	return [
		"providers:",
		`  ${PRIMARY.provider}:`,
		"    baseUrl: http://127.0.0.1:9/v1",
		"    api: openai-completions",
		`    apiKey: ${JSON.stringify(fixtureApiKey)}`,
		"    models:",
		`      - id: ${PRIMARY.id}`,
		...(extraModel ? ["      - id: deepseek-v4.1-probe"] : []),
		`  ${FALLBACK.provider}:`,
		"    baseUrl: http://127.0.0.1:9/v1",
		"    api: openai-responses",
		`    apiKey: ${JSON.stringify(fixtureApiKey)}`,
		"    models:",
		`      - id: ${FALLBACK.id}`,
		"",
	].join("\n");
}

function makeSettings(revertPolicy: string | undefined) {
	return Object.assign(
		createSettingsTestScope(key => (key === "retry.fallbackRevertPolicy" ? revertPolicy : undefined)),
		{
			getGroup: (name: string) =>
				name === "retry"
					? {
							enabled: true,
							maxRetries: 2,
							baseDelayMs: 1,
							maxDelayMs: 0,
							modelFallback: true,
							waitForUsageReset: false,
						}
					: {},
			getModelRole: () => undefined,
			getModelRoles: () => ({}),
			getStorage: () => undefined,
		},
	) as never;
}

// fixture 파일의 mtime 을 고정 정수 초로 둔다. 정수 초는 FS 가 그대로 저장하므로 쓰기 뒤 같은
// 값으로 되돌리면 정적 재로드의 mtime 게이트가 실제로 닫힌다(재적용의 게이트 우회를 검증하기 위함).
const FIXED_MTIME_SECONDS = 1_700_000_000;

function makeRegistry(tag: string) {
	const dir = mkdtempSync(join(workdir, `${tag}-`));
	const modelsYml = join(dir, "models.yml");
	writeFileSync(modelsYml, modelsYmlText(false), "utf8");
	utimesSync(modelsYml, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);
	const registry = new ModelRegistry(auth, modelsYml, {
		cacheDbPath: join(dir, "models.db"),
		fetch: mockFetch,
		settings: makeSettings(undefined),
	});
	return { registry, modelsYml };
}

/** 폴백으로 내려간 세션을 만들고 쿨다운 만료 뒤의 자동 복귀만 관측한다. */
async function restoreAfterCooldown(revertPolicy: string, suppressedUntilMs: number) {
	const { registry } = makeRegistry(`revert-${revertPolicy}-${Math.round(Math.random() * 1e9)}`);
	const fallback = registry.find(FALLBACK.provider, FALLBACK.id);
	if (!fallback) throw new Error("fixture fallback 모델을 registry 에서 찾지 못했다");
	registry.suppressSelector(PRIMARY_SELECTOR, suppressedUntilMs);
	let current: unknown = fallback;
	const switches: string[] = [];
	const host = {
		sessionManager: {
			getSessionId: () => "policy-reapply-test",
			appendModelChange: () => {},
			getLastModelChangeRole: () => undefined,
		},
		settings: makeSettings(revertPolicy),
		modelRegistry: registry,
		configWarnings: [] as string[],
		model: () => current,
		sessionId: () => "policy-reapply-test",
		thinkingLevel: () => "max",
		configuredThinkingLevel: () => "max",
		setThinkingLevel: () => {},
		resolveActiveEditMode: () => "replace",
		syncAfterModelChange: async () => {},
		setModelWithProviderSessionReset: async (model: { provider: string; id: string }) => {
			current = model;
			switches.push(`${model.provider}/${model.id}`);
		},
	};
	// startup 이 폴백을 골라 둔 상태를 재현한다(pinned 아님 = 쿨다운 복귀 대상).
	const recovery = new TurnRecovery(host as never, {
		initialRetryFallback: {
			role: PRIMARY_SELECTOR,
			originalSelector: PRIMARY_SELECTOR,
			originalThinkingLevel: "max",
		},
	});
	const restored = await recovery.maybeRestoreRetryFallbackPrimary();
	return { restored, switches };
}

try {
	console.log("\n[1] 설정 변경이 부르는 정책 재적용은 폴백 쿨다운을 지우지 않는다");
	{
		const { registry, modelsYml } = makeRegistry("keep");
		registry.suppressSelector(PRIMARY_SELECTOR, Date.now() + 60_000);
		check("재적용 전 쿨다운이 걸려 있다", registry.isSelectorSuppressed(PRIMARY_SELECTOR));

		// 재적용이 카탈로그를 실제로 다시 만드는지도 함께 본다. models.yml 을 mtime 이 그대로인
		// 채로(mtime 게이트가 닫힌 채로) 고쳐 두면, 게이트를 넘기는 `#lastStaticLoadMtime = null`
		// 이 살아 있어야만 새 모델이 보인다.
		const gateMtimeMs = statSync(modelsYml).mtimeMs;
		writeFileSync(modelsYml, modelsYmlText(true), "utf8");
		utimesSync(modelsYml, FIXED_MTIME_SECONDS, FIXED_MTIME_SECONDS);

		await registry.reapplyModelPolicies();
		check(
			"정책 재적용이 쿨다운을 보존한다",
			registry.isSelectorSuppressed(PRIMARY_SELECTOR),
			`suppressed=${registry.isSelectorSuppressed(PRIMARY_SELECTOR)}`,
		);
		check(
			"정책 재적용은 정적 재로드를 그대로 수행한다(mtime 게이트를 넘긴다)",
			registry.find(PRIMARY.provider, "deepseek-v4.1-probe") !== undefined,
			`gateClosed=${statSync(modelsYml).mtimeMs === gateMtimeMs}`,
		);
	}

	console.log("\n[2] 만료·수동 선택·명시적 refresh 의 기존 계약은 그대로다");
	{
		const { registry } = makeRegistry("clear");
		registry.suppressSelector(PRIMARY_SELECTOR, Date.now() - 1);
		check("만료된 쿨다운은 억제로 읽히지 않는다", registry.isSelectorSuppressed(PRIMARY_SELECTOR) === false);

		registry.suppressSelector(PRIMARY_SELECTOR, Date.now() + 60_000);
		await registry.reapplyModelPolicies();
		registry.clearSuppressedSelector(PRIMARY_SELECTOR);
		check(
			"수동 모델 선택 경로가 그 selector 의 쿨다운을 지운다",
			registry.isSelectorSuppressed(PRIMARY_SELECTOR) === false,
		);

		registry.suppressSelector(PRIMARY_SELECTOR, Date.now() + 60_000);
		registry.suppressSelector(FALLBACK_SELECTOR, Date.now() + 60_000);
		await registry.refreshProvider(FALLBACK.provider, "offline");
		check(
			"provider 범위 refresh 는 그 provider 의 쿨다운만 지운다",
			registry.isSelectorSuppressed(FALLBACK_SELECTOR) === false &&
				registry.isSelectorSuppressed(PRIMARY_SELECTOR) === true,
			`primary=${registry.isSelectorSuppressed(PRIMARY_SELECTOR)} fallback=${registry.isSelectorSuppressed(FALLBACK_SELECTOR)}`,
		);

		await registry.refresh("offline");
		check("명시적 refresh 는 기존 계약대로 전부 지운다", registry.isSelectorSuppressed(PRIMARY_SELECTOR) === false);
	}

	console.log("\n[3] retry.fallbackRevertPolicy=never 는 폴백 뒤 자동 primary 복귀를 막는다");
	{
		const control = await restoreAfterCooldown("cooldown-expiry", Date.now() - 1);
		check(
			"cooldown-expiry 는 쿨다운이 끝나면 primary 로 복귀한다(대조군)",
			control.restored === true && control.switches.join(",") === PRIMARY_SELECTOR,
			`restored=${control.restored} switches=${control.switches.join(",")}`,
		);
		const expired = await restoreAfterCooldown("never", Date.now() - 1);
		check(
			"never 는 쿨다운이 끝나도 primary 로 복귀하지 않는다",
			expired.restored === false && expired.switches.length === 0,
			`restored=${expired.restored} switches=${expired.switches.join(",")}`,
		);
		const cooling = await restoreAfterCooldown("never", Date.now() + 60_000);
		check(
			"never 는 쿨다운이 남아 있는 동안에도 복귀하지 않는다",
			cooling.switches.length === 0,
			`switches=${cooling.switches.join(",")}`,
		);
	}

	console.log(`\n결과 ${pass} pass / ${fail} fail`);
	process.exitCode = fail === 0 ? 0 : 1;
} finally {
	auth.close();
	rmSync(workdir, { recursive: true, force: true });
}
