// BAI root 회귀 스모크: cold discovery registry 에서 요청 BAI 가 scoped preflight 로
// 살아나는지, provider 미도달 때는 승인 후보가 그대로 보존되는지. 실행:
//   OMP_CORE_PATCH_TARGET=<scratch 패치 사본> bun run patches/core-bai-preflight-test.ts
// 동적 import 예외: core-patch-test.ts 와 같은 이유(모듈 로딩 경계 테스트).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsTestScope } from "./core-test-settings";

function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	if (!env) throw new Error("OMP_CORE_PATCH_TARGET(패치 사본 또는 전역 설치)이 필요하다");
	const hit = existsSync(join(env, "src/registry/agent-registry.ts")) ? env : null;
	if (!hit) throw new Error(`core 를 찾지 못했다: ${env}`);
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const { ModelRegistry } = await import(`${CORE}/config/model-registry.ts`);
const {
	resolveConfiguredModelPatterns,
	resolveModelOverrideWithAuthFallback,
} = await import(`${CORE}/config/model-resolver.ts`);
const { refreshSubagentUnresolvedDiscovery, selectSubagentApprovedModel } = await import(
	`${CORE}/task/executor.ts`
);
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

const MUSE_SELECTOR = "opencode-go/muse-spark-1.3-contributor:xhigh";
const BAI_PATTERNS = ["b-ai/deepseek-v4.1-flash:max"];
const CHAINS = {
	impl: [MUSE_SELECTOR],
	"b-ai/deepseek-v4.1-flash": [MUSE_SELECTOR],
	"b-ai/deepseek-v4.1-flash:max": [MUSE_SELECTOR],
	"opencode-go/muse-spark-1.3-contributor": [],
};
const ROLES = { impl: "b-ai/deepseek-v4.1-flash:max" };
const settingsStub = Object.assign(
	createSettingsTestScope(key => (key === "retry.fallbackChains" ? CHAINS : undefined)),
	{
		getModelRoles: () => ROLES,
		getModelRole: (role: string) => (ROLES as Record<string, string>)[role],
	},
) as never;
// 더미 키(비밀 아님). mock fetch·scratch registry 전용이며 네트워크에 나가지 않는다.
const fixtureApiKey = "example";

const workdir = mkdtempSync(join(tmpdir(), "omp-bai-preflight-"));
// 손으로 나열한 auth 스텁은 상류가 메서드를 늘릴 때마다 조용히 낡아 TypeError 로 죽는다
// (실측 18.2.5/18.2.6: `this.authStorage.setConfigValueResolver is not a function`).
// 그래서 실물 AuthStorage 를 scratch sqlite 로 띄운다. hermetic 근거: 저장소는 이 임시
// 디렉터리의 빈 db 뿐이고(자격증명 0건), fixture provider 는 pi-ai `serviceProviderMap`
// 밖의 가상 이름이라 env 별칭도 걸리지 않으며, 키는 models.yml 의 `apiKey` 를
// ModelRegistry 가 `setConfigApiKey` 로 심는 경로 하나로만 들어온다. 네트워크 호출은
// 주입한 mockFetch 뿐이고 실제 `~/.omp` 는 읽지도 쓰지도 않는다.
const auth = await AuthStorage.create(join(workdir, "auth.db"));
let fetchMode: "ok" | "down" | "hang" = "ok";
let releaseHungFetch: (() => void) | undefined;
const fetchUrls: string[] = [];
const okModelsResponse = () => ({
	ok: true,
	status: 200,
	json: async () => ({ data: [{ id: "deepseek-v4.1-flash" }] }),
});
const mockFetch = (async (url: unknown) => {
	fetchUrls.push(String(url));
	if (fetchMode === "down") throw new Error("mock network unreachable");
	if (fetchMode === "hang") {
		await new Promise<void>(resolve => {
			releaseHungFetch = resolve;
		});
		releaseHungFetch = undefined;
	}
	return okModelsResponse();
}) as never;

function makeRegistry(tag: string) {
	const dir = mkdtempSync(join(workdir, `${tag}-`));
	const modelsYml = join(dir, "models.yml");
	writeFileSync(
		modelsYml,
		[
			"providers:",
			"  b-ai:",
			"    baseUrl: http://127.0.0.1:9/v1",
			"    api: openai-completions",
			// validation 이 custom provider 에 apiKey(auth 기본값)를 요구하므로 더미를
			// 둔다. 비밀 아님. 이 값이 곧 AuthStorage 의 config override 로 들어가
			// 발견 Bearer·사용성 판정까지 같은 더미 하나로 결정된다.
			`    apiKey: ${JSON.stringify(fixtureApiKey)}`,
			"    discovery:",
			"      type: openai-models-list",
			"  opencode-go:",
			"    baseUrl: http://127.0.0.1:9/v1",
			"    api: openai-responses",
			`    apiKey: ${JSON.stringify(fixtureApiKey)}`,
			"    models:",
			"      - id: muse-spark-1.3-contributor",
			"",
		].join("\n"),
		"utf8",
	);
	return new ModelRegistry(auth, modelsYml, {
		cacheDbPath: join(dir, "models.db"),
		fetch: mockFetch,
		settings: settingsStub,
	});
}

const selectionArgs = (requestedModel: unknown, patterns: string[]) => ({
	requestedModel,
	requestedThinkingLevel: "max",
	requestedExplicitThinkingLevel: true,
	authFallbackUsed: false,
	parentActiveModelPattern: undefined,
	modelPatterns: patterns,
	role: "impl",
	settings: settingsStub,
	modelRegistry: undefined as never,
});

try {
	console.log("\n[1] cold registry 재현 — 첫 resolve 는 미해결, 기존 선택은 Muse 로 대체된다");
	fetchUrls.length = 0;
	const cold = makeRegistry("cold");
	const configured = resolveConfiguredModelPatterns(BAI_PATTERNS, settingsStub);
	check("요청 패턴이 그대로 유지된다", JSON.stringify(configured) === JSON.stringify(BAI_PATTERNS), configured.join(","));
	const first = await resolveModelOverrideWithAuthFallback(BAI_PATTERNS, undefined, cold, settingsStub, "smoke");
	check("cold registry 에서 BAI 는 미해결이다", first.model === undefined, `model=${first.model?.id}`);
	check("미해결 때 네트워크에 나가지 않았다", fetchUrls.length === 0, fetchUrls.join(","));
	const bugDemo = selectSubagentApprovedModel({ ...selectionArgs(undefined, BAI_PATTERNS), modelRegistry: cold });
	check(
		"preflight 없이는 승인 후보 Muse 로 대체된다(버그 재현)",
		bugDemo.substituted && bugDemo.reason === "approved-candidate" && bugDemo.model?.id === "muse-spark-1.3-contributor",
		`reason=${bugDemo.reason} id=${bugDemo.model?.id}`,
	);

	console.log("\n[2] preflight — cold registry 에서 요청 BAI 가 BAI 로 살아난다");
	fetchMode = "ok";
	fetchUrls.length = 0;
	const recovered = await refreshSubagentUnresolvedDiscovery({
		model: first.model,
		modelPatterns: BAI_PATTERNS,
		configuredModelPatterns: configured,
		parentActiveModelPattern: undefined,
		modelRegistry: cold,
		settings: settingsStub,
		sessionId: "example",
	});
	check("preflight 가 재해결 결과를 돌려준다", recovered?.model?.id === "deepseek-v4.1-flash", `id=${recovered?.model?.id}`);
	check("복구된 provider 는 b-ai 다", recovered?.model?.provider === "b-ai", `provider=${recovered?.model?.provider}`);
	check(
		"요청은 오직 /v1/models 1건에만 나갔다",
		fetchUrls.length === 1 && fetchUrls[0].endsWith("/v1/models"),
		fetchUrls.join(","),
	);
	const kept = selectSubagentApprovedModel({
		...selectionArgs(recovered?.model, BAI_PATTERNS),
		modelRegistry: cold,
	});
	check(
		"복구된 BAI 는 대체 없이 그대로 간다",
		!kept.substituted && kept.reason === "ok" && kept.model?.id === "deepseek-v4.1-flash",
		`reason=${kept.reason} substituted=${kept.substituted}`,
	);

	console.log("\n[3] provider 미도달 — 승인 후보가 그대로 보존된다");
	fetchMode = "down";
	fetchUrls.length = 0;
	const cold2 = makeRegistry("cold-down");
	const first2 = await resolveModelOverrideWithAuthFallback(BAI_PATTERNS, undefined, cold2, settingsStub, "smoke");
	check("미도달 cold registry 에서 BAI 는 미해결이다", first2.model === undefined, `model=${first2.model?.id}`);
	const recovered2 = await refreshSubagentUnresolvedDiscovery({
		model: first2.model,
		modelPatterns: BAI_PATTERNS,
		configuredModelPatterns: resolveConfiguredModelPatterns(BAI_PATTERNS, settingsStub),
		parentActiveModelPattern: undefined,
		modelRegistry: cold2,
		settings: settingsStub,
		sessionId: "example",
	});
	check("미도달 때도 preflight 는 던지지 않는다", recovered2?.model === undefined, `id=${recovered2?.model?.id}`);
	const fallback = selectSubagentApprovedModel({
		...selectionArgs(recovered2?.model, BAI_PATTERNS),
		modelRegistry: cold2,
	});
	check(
		"미도달 때는 승인 후보 Muse 가 보존된다",
		fallback.substituted && fallback.reason === "approved-candidate" && fallback.model?.id === "muse-spark-1.3-contributor",
		`reason=${fallback.reason} id=${fallback.model?.id}`,
	);

	console.log("\n[4] 정상 dispatch·무관 provider — 네트워크에 나가지 않는다");
	fetchMode = "ok";
	fetchUrls.length = 0;
	const staticOnly = await resolveModelOverrideWithAuthFallback(
		["opencode-go/muse-spark-1.3-contributor:xhigh"],
		undefined,
		cold2,
		settingsStub,
		"smoke",
	);
	const noopResolved = await refreshSubagentUnresolvedDiscovery({
		model: staticOnly.model,
		modelPatterns: ["opencode-go/muse-spark-1.3-contributor:xhigh"],
		configuredModelPatterns: ["opencode-go/muse-spark-1.3-contributor:xhigh"],
		parentActiveModelPattern: undefined,
		modelRegistry: cold2,
		settings: settingsStub,
		sessionId: "example",
	});
	check("해결된 요청은 preflight 없이 끝난다", noopResolved === undefined, `got=${JSON.stringify(noopResolved?.model?.id)}`);
	const noopUnknown = await refreshSubagentUnresolvedDiscovery({
		model: undefined,
		modelPatterns: ["nope/nothing:max"],
		configuredModelPatterns: ["nope/nothing:max"],
		parentActiveModelPattern: undefined,
		modelRegistry: cold2,
		settings: settingsStub,
		sessionId: "example",
	});
	check("discovery 제공자가 아니면 손대지 않는다", noopUnknown === undefined, `got=${JSON.stringify(noopUnknown?.model?.id)}`);
	check("이 절에서 네트워크 호출이 없다", fetchUrls.length === 0, fetchUrls.join(","));

	console.log("\n[5] refresh 대기 중 abort — fetch 완료를 기다리지 않고 취소된다");
	// 호출부 awaitAbortable 과 같은 계약(pre-check + race)으로 재현한다. 실제
	// ToolAbortError 클래스를 core 에서 가져오므로 타입 판정이 허구가 아니다.
	const { ToolAbortError } = await import(`${CORE}/tools/tool-errors.ts`);
	fetchMode = "hang";
	fetchUrls.length = 0;
	const cold3 = makeRegistry("cold-hang");
	const pending = refreshSubagentUnresolvedDiscovery({
		model: undefined,
		modelPatterns: BAI_PATTERNS,
		configuredModelPatterns: resolveConfiguredModelPatterns(BAI_PATTERNS, settingsStub),
		parentActiveModelPattern: undefined,
		modelRegistry: cold3,
		settings: settingsStub,
		sessionId: "example",
	});
	const { promise: tick, resolve: releaseTick } = Promise.withResolvers<void>();
	setTimeout(releaseTick, 60);
	await tick;
	check("refresh 가 fetch 에서 대기 중이다", fetchUrls.length === 1 && releaseHungFetch !== undefined, fetchUrls.join(","));
	const controller = new AbortController();
	const abortRejection = new Promise<never>((_, reject) => {
		if (controller.signal.aborted) reject(new ToolAbortError());
		else controller.signal.addEventListener("abort", () => reject(new ToolAbortError()), { once: true });
	});
	controller.abort();
	let cancelled = false;
	const raced = await Promise.race([
		pending.then(() => "recovered"),
		abortRejection.catch(error => {
			if (error instanceof ToolAbortError) {
				cancelled = true;
				return "cancelled";
			}
			throw error;
		}),
	]);
	check("대기 중 abort 는 fetch 완료 전에 취소로 끝난다", cancelled && raced === "cancelled", `raced=${raced}`);
	check("취소 시점에 fetch 는 아직 풀리지 않았다", releaseHungFetch !== undefined, "");
	releaseHungFetch?.();
	const late = await pending;
	check("늦게 끝난 refresh 성공은 무해하다(호출자는 이미 취소됨)", late?.model?.id === "deepseek-v4.1-flash", `id=${late?.model?.id}`);
	fetchMode = "ok";
	console.log(`\n결과: ${pass} pass, ${fail} fail`);
} finally {
	auth.close();
	rmSync(workdir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
