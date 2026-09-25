// 명시 캐릭터 summon의 Anthropic exact-account 경계 회귀 (OMP 18.3.0 namespaced AuthStorage).
// 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-character-affinity-test.ts
// exact pin은 `authStorage.sessions.pin(provider, sessionId, credentialId, { exactLabel })` 이다.
// 18.3.0 upstream `pin()` 은 이미 explicit 이라 ranking·reserve 재선택으로는 빠지지 않지만
// (auth/affinity.ts:216-227), usage-limit·인증 실패·transport 실패의 sibling 회전과 model fallback 은
// 막지 않는다. 미패치 core 에서는 exactLabel 옵션이 무시되어 exact 절이 RED, 일반 비교 절은 GREEN 이다.
// 네트워크·유료 호출·실제 자격증명 변경 없음(scratch SQLite + local model registry + mock provider).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(candidate => existsSync(join(candidate, "src/session/turn-recovery.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
const AI_ROOT = join(CORE, "..", "..", "pi-ai", "src").replace(/\\/g, "/");
console.log(`대상 ${CORE}`);
const { TurnRecovery } = await import(`${CORE}/session/turn-recovery.ts`);
const { ModelRegistry } = await import(`${CORE}/config/model-registry.ts`);
const { AuthStorage } = await import(`${AI_ROOT}/auth-storage.ts`);
const AIError = await import(`${AI_ROOT}/error/index.ts`);
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

const workdir = mkdtempSync(join(tmpdir(), "omp-character-affinity-"));
const fixtureCredential = (tag: string) => ({
	type: "oauth" as const,
	access: `fixture-access-${tag}`,
	refresh: `fixture-refresh-${tag}`,
	expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
	email: `${tag}@example.test`,
	accountId: `fixture-${tag}`,
});

type Auth = InstanceType<typeof AuthStorage>;
async function makeAuth(tag: string, count = 2): Promise<Auth> {
	const auth = await AuthStorage.create(join(workdir, `${tag}.db`));
	for (let index = 0; index < count; index += 1) {
		await auth.credentials.upsert("anthropic", fixtureCredential(`${tag}-${index}`));
	}
	return auth;
}
const activeCredentialId = (auth: Auth, sessionId: string): number | undefined =>
	auth.oauth.accounts("anthropic", sessionId).find(account => account.active)?.credentialId;
async function keyError(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

const fallbackSelector = "b-ai/deepseek-v4.1-flash:max";
function makeSettings() {
	const chains = {
		"anthropic/claude-opus-5": [fallbackSelector],
		"anthropic/claude-opus-5:high": [fallbackSelector],
	};
	return {
		getGroup: (name: string) =>
			name === "retry"
				? {
						enabled: true,
						maxRetries: 2,
						baseDelayMs: 1,
						maxDelayMs: 100,
						modelFallback: true,
						waitForUsageReset: false,
					}
				: {},
		get: (key: string) =>
			key === "retry.fallbackChains" ? chains : key === "retry.usageAwareFallback" ? false : undefined,
		getModelRole: () => undefined,
		getModelRoles: () => ({}),
		getStorage: () => undefined,
	} as never;
}

function makeRegistry(auth: Auth, tag: string) {
	const dir = mkdtempSync(join(workdir, `${tag}-models-`));
	const modelsYml = join(dir, "models.yml");
	writeFileSync(
		modelsYml,
		[
			"providers:",
			"  b-ai:",
			"    baseUrl: http://127.0.0.1:9/v1",
			"    api: openai-completions",
			"    apiKey: example",
			"    models:",
			"      - id: deepseek-v4.1-flash",
			"",
		].join("\n"),
		"utf8",
	);
	return new ModelRegistry(auth, modelsYml, {
		cacheDbPath: join(dir, "models.db"),
		fetch: (async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as never,
		settings: makeSettings(),
	});
}

interface RecoveryHarness {
	recovery: InstanceType<typeof TurnRecovery>;
	agent: { state: { messages: unknown[] } };
	switches: string[];
	continues: string[];
	events: Array<{ type: string; [key: string]: unknown }>;
	model: { provider: string; id: string; api: string };
}

function makeRecoveryHarness(registry: InstanceType<typeof ModelRegistry>, sessionId: string): RecoveryHarness {
	const anthropic = registry.find("anthropic", "claude-opus-5");
	if (!anthropic) throw new Error("fixture registry에서 anthropic/claude-opus-5를 찾지 못했다");
	let current = anthropic;
	const switches: string[] = [];
	const continues: string[] = [];
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const agent = {
		state: { messages: [] as unknown[] },
		replaceMessages(next: unknown[]) {
			agent.state.messages = next;
		},
		appendMessage() {},
	};
	const host = {
		agent,
		sessionManager: {
			getBranch: () => [],
			appendModelChange: () => {},
			getLastModelChangeRole: () => undefined,
			getSessionId: () => sessionId,
		},
		settings: makeSettings(),
		modelRegistry: registry,
		configWarnings: [] as string[],
		model: () => current,
		contextFitsModel: () => true,
		textOutputCommitted: () => false,
		thinkingLevel: () => "high",
		configuredThinkingLevel: () => "high",
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 1,
		sessionId: () => sessionId,
		emitSessionEvent: async (event: { type: string; [key: string]: unknown }) => {
			events.push(event);
		},
		scheduleAgentContinue: (options: { source: string }) => {
			continues.push(options.source);
		},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		persistedAssistantEntryId: () => undefined,
		sessionMessageAlreadyPersisted: () => true,
		setModelWithProviderSessionReset: async (model: typeof anthropic) => {
			current = model;
			switches.push(`${model.provider}/${model.id}`);
		},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => false,
		resolveActiveEditMode: () => "replace",
		syncAfterModelChange: async () => {},
		runAutoCompaction: async () => ({ deferredHandoff: false, continuationScheduled: false }),
		withBashBranchTransition: (operation: () => unknown) => operation(),
	};
	return { recovery: new TurnRecovery(host as never), agent, switches, continues, events, model: anthropic };
}

function seedError(harness: RecoveryHarness, errorMessage: string, errorId: number) {
	const message = {
		role: "assistant",
		stopReason: "error",
		provider: "anthropic",
		model: "claude-opus-5",
		api: harness.model.api,
		errorMessage,
		errorId,
		timestamp: Date.now(),
		content: [],
	};
	harness.agent.state.messages.push(message);
	return message;
}
const USAGE_LIMIT_TEXT = "usage limit reached for this account; retry after 3600 seconds";
const usageLimitError = () => Object.assign(new Error(USAGE_LIMIT_TEXT), { status: 429 });
const authFailure = () => Object.assign(new Error("401 Unauthorized: invalid authentication credentials"), { status: 401 });
const TRANSPORT_TEXT = "The socket connection was closed unexpectedly. For more information, pass `verbose: true`";

/** ApiKeyResolution 은 문자열 또는 { apiKey, credentialId } 다(auth-retry.ts). */
type Resolution = string | { apiKey?: string; credentialId?: number } | undefined;
const bearer = (resolution: Resolution) => (typeof resolution === "string" ? resolution : resolution?.apiKey);

/** 같은 fixture 로 exact 와 일반 pin 을 나란히 만든다. 차이는 exactLabel 하나뿐이다. */
async function pinned(tag: string, exact: boolean) {
	const auth = await makeAuth(tag);
	opened.push(auth);
	const accounts = auth.oauth.accounts("anthropic");
	const target = accounts[0]!;
	const sibling = accounts[1]!;
	const sessionId = `session-${tag}`;
	const ok = auth.sessions.pin("anthropic", sessionId, target.credentialId, exact ? { exactLabel: "RIN(린)" } : undefined);
	return { auth, target, sibling, sessionId, ok };
}

const opened: Auth[] = [];
try {
	console.log("\n[1] exact pin 성립과 blocked 계정 preflight — 재선택 해제 없이 alias 실패");
	{
		const { auth, target, sibling, sessionId, ok } = await pinned("exact-block", true);
		const outcome = await auth.limits.markReached("anthropic", sessionId, {
			credentialId: target.credentialId,
			retryAfterMs: 60 * 60 * 1000,
		});
		check("RIN position N exact pin이 성립한다", ok && activeCredentialId(auth, sessionId) === target.credentialId);
		check(
			"blocked RIN은 sibling을 usable switch로 보고하지 않는다",
			outcome.switched === false && outcome.retryAtMs === undefined,
			`switched=${outcome.switched} retryAtMs=${outcome.retryAtMs} sibling=${sibling.credentialId}`,
		);
		check(
			"usage-aware reselection(sessions.release)도 exact pin을 해제하지 않는다",
			auth.sessions.release("anthropic", sessionId) === false && activeCredentialId(auth, sessionId) === target.credentialId,
		);
		const preflightError = await keyError(() => auth.keys.get("anthropic", sessionId, { modelId: "claude-opus-5" }));
		check(
			"pre-blocked exact 계정은 provider 호출 전 alias 실패로 끝난다",
			preflightError.includes("RIN(린)") && preflightError.includes("지정 OAuth 계정"),
			preflightError,
		);
	}

	console.log("\n[2] usage-limit — limits.rotate 의 usage-limit 분기는 exact pin 을 sibling 으로 넘기지 않는다");
	{
		const exact = await pinned("rotate-usage-exact", true);
		const exactRotated = await exact.auth.limits.rotate("anthropic", exact.sessionId, {
			error: usageLimitError(),
			credentialId: exact.target.credentialId,
		});
		const exactKeyError = await keyError(() => exact.auth.keys.get("anthropic", exact.sessionId, { modelId: "claude-opus-5" }));
		check("exact: rotate 는 false 다", exactRotated === false, `rotated=${exactRotated}`);
		check(
			"exact: 다음 선택은 sibling 이 아니라 alias 실패다",
			exactKeyError.includes("RIN(린)") && !exactKeyError.includes(exact.sibling.credentialId.toString()),
			exactKeyError || "key resolved",
		);
		const ordinary = await pinned("rotate-usage-ordinary", false);
		const ordinaryRotated = await ordinary.auth.limits.rotate("anthropic", ordinary.sessionId, {
			error: usageLimitError(),
			credentialId: ordinary.target.credentialId,
		});
		const ordinaryKey = await ordinary.auth.keys.get("anthropic", ordinary.sessionId, { modelId: "claude-opus-5" });
		check("비교(upstream 그대로): 일반 pin 은 usage-limit 에서 sibling 으로 회전한다", ordinaryRotated === true && ordinaryKey === "fixture-access-rotate-usage-ordinary-1", `rotated=${ordinaryRotated} key=${ordinaryKey}`);
	}

	console.log("\n[3] 인증 실패 — resolver 의 lastChance 회전(stream.ts auth-retry step c)이 exact 계정을 바꾸지 않는다");
	{
		const exact = await pinned("auth-exact", true);
		const exactRegistry = makeRegistry(exact.auth, "auth-exact");
		const model = exactRegistry.find("anthropic", "claude-opus-5")!;
		const exactResolver = exactRegistry.resolver(model, exact.sessionId);
		const exactFirst = (await exactResolver({ lastChance: false, error: undefined })) as Resolution;
		const exactNext = (await exactResolver({ lastChance: true, error: authFailure(), previousKey: bearer(exactFirst) })) as Resolution;
		check("exact: 첫 bearer 는 지정 계정이다", bearer(exactFirst) === "fixture-access-auth-exact-0", `first=${bearer(exactFirst)}`);
		check("exact: 401 뒤 재해석도 지정 계정 그대로다(sibling bearer 없음)", bearer(exactNext) === "fixture-access-auth-exact-0", `next=${bearer(exactNext)}`);
		check("exact: pin 이 그대로 남는다", activeCredentialId(exact.auth, exact.sessionId) === exact.target.credentialId);

		const ordinary = await pinned("auth-ordinary", false);
		const ordinaryRegistry = makeRegistry(ordinary.auth, "auth-ordinary");
		const ordinaryResolver = ordinaryRegistry.resolver(ordinaryRegistry.find("anthropic", "claude-opus-5")!, ordinary.sessionId);
		const ordinaryFirst = (await ordinaryResolver({ lastChance: false, error: undefined })) as Resolution;
		const ordinaryNext = (await ordinaryResolver({ lastChance: true, error: authFailure(), previousKey: bearer(ordinaryFirst) })) as Resolution;
		check(
			"비교(upstream 그대로): 일반 pin 은 401 뒤 sibling bearer 로 넘어간다",
			bearer(ordinaryFirst) === "fixture-access-auth-ordinary-0" && bearer(ordinaryNext) === "fixture-access-auth-ordinary-1",
			`first=${bearer(ordinaryFirst)} next=${bearer(ordinaryNext)}`,
		);
	}

	console.log("\n[4] transport 실패 — 계정 회전도 model fallback 도 만들지 않는다");
	{
		const exact = await pinned("transport-exact", true);
		const exactRotated = await exact.auth.limits.rotate("anthropic", exact.sessionId, {
			error: new Error(TRANSPORT_TEXT),
			credentialId: exact.target.credentialId,
		});
		const exactKey = await exact.auth.keys.get("anthropic", exact.sessionId, { modelId: "claude-opus-5" });
		check("exact: transport 오류 rotate 는 false 다", exactRotated === false, `rotated=${exactRotated}`);
		check("exact: 지정 계정이 suspect/block 되지 않고 그대로 선택된다", exactKey === "fixture-access-transport-exact-0", `key=${exactKey}`);
		const exactRecovery = makeRecoveryHarness(makeRegistry(exact.auth, "transport-exact"), exact.sessionId);
		const exactMessage = seedError(exactRecovery, TRANSPORT_TEXT, AIError.create(AIError.Flag.Transient));
		await exactRecovery.recovery.handleRetryableError(exactMessage as never, { allowModelFallback: true });
		check("exact: transport 재시도가 다른 모델로 바뀌지 않는다", exactRecovery.switches.length === 0, `switches=${exactRecovery.switches.join(",")}`);

		const ordinary = await pinned("transport-ordinary", false);
		const ordinaryRecovery = makeRecoveryHarness(makeRegistry(ordinary.auth, "transport-ordinary"), ordinary.sessionId);
		const ordinaryMessage = seedError(ordinaryRecovery, TRANSPORT_TEXT, AIError.create(AIError.Flag.Transient));
		await ordinaryRecovery.recovery.handleRetryableError(ordinaryMessage as never, { allowModelFallback: true });
		check(
			"비교(upstream 그대로): 일반 세션의 transport 오류는 fallback chain 으로 간다",
			ordinaryRecovery.switches[0] === "b-ai/deepseek-v4.1-flash",
			`switches=${ordinaryRecovery.switches.join(",")}`,
		);
	}

	console.log("\n[5] model fallback — 요청 중 usage-limit 은 alias terminal error 로 끝난다");
	{
		const exact = await pinned("fallback-exact", true);
		const harness = makeRecoveryHarness(makeRegistry(exact.auth, "fallback-exact"), exact.sessionId);
		const message = seedError(harness, USAGE_LIMIT_TEXT, AIError.create(AIError.Flag.UsageLimit));
		await harness.recovery.recordUsageLimitOutcome(message as never);
		const retried = await harness.recovery.handleRetryableError(message as never, { allowModelFallback: true });
		check("exact: sibling credential 재시도를 예약하지 않는다", retried === false && harness.continues.length === 0, `retried=${retried} continues=${harness.continues.join(",")}`);
		check("exact: 다른 모델로 바뀌지 않는다", harness.switches.length === 0, `switches=${harness.switches.join(",")}`);
		check("exact: terminal error 가 선택 alias 를 명시한다", message.errorMessage.includes("RIN(린)"), message.errorMessage);
		check("exact: fallback 적용 이벤트가 없다", !harness.events.some(event => event.type === "retry_fallback_applied"), harness.events.map(event => event.type).join(","));

		const single = await makeAuth("fallback-ordinary", 1);
		opened.push(single);
		const sessionId = "session-fallback-ordinary";
		single.sessions.pin("anthropic", sessionId, single.oauth.accounts("anthropic")[0]!.credentialId);
		const ordinary = makeRecoveryHarness(makeRegistry(single, "fallback-ordinary"), sessionId);
		const ordinaryMessage = seedError(ordinary, USAGE_LIMIT_TEXT, AIError.create(AIError.Flag.UsageLimit));
		await ordinary.recovery.recordUsageLimitOutcome(ordinaryMessage as never);
		await ordinary.recovery.handleRetryableError(ordinaryMessage as never, { allowModelFallback: true });
		check(
			"비교(upstream 그대로): 일반 세션은 sibling 이 없으면 fallback model 로 전환한다",
			ordinary.switches[0] === "b-ai/deepseek-v4.1-flash",
			`switches=${ordinary.switches.join(",")}`,
		);
	}

	console.log("\n[6] 정상 RIN/MIO summon 의 assistant credentialId — upstream stream.ts 스탬프가 지정 계정을 남긴다");
	// 옛 core patch #119~#122(stampAssistantCredentialId)는 RETIRE 됐다. 18.3.0은 resolver 가 고른
	// credentialId 를 streamSimple 이 결과 메시지에 찍는다(pi-ai/src/stream.ts:1549-1594).
	{
		const auth = await makeAuth("exact-stamp");
		opened.push(auth);
		const accounts = auth.oauth.accounts("anthropic");
		const registry = makeRegistry(auth, "exact-stamp");
		const mock = createMockModel({ id: "claude-opus-5", provider: "anthropic", handler: { content: ["ok"], stopReason: "stop" } });
		const stamp = async (label: string, credentialId: number) => {
			const sessionId = `session-stamp-${credentialId}`;
			auth.sessions.pin("anthropic", sessionId, credentialId, { exactLabel: label });
			const result = await streamSimple(
				mock as never,
				{ messages: [{ role: "user", content: "안녕", timestamp: Date.now() }] } as never,
				{ apiKey: registry.resolver("anthropic", { sessionId, modelId: "claude-opus-5" }) } as never,
			).result();
			return result.credentialId as number | undefined;
		};
		const rin = await stamp("RIN(린)", accounts[N]!.credentialId);
		const mio = await stamp("MIO(미오)", accounts[N]!.credentialId);
		check("정상 RIN summon 결과는 position N credentialId 를 싣는다", rin === accounts[N]!.credentialId, `got=${rin}`);
		check("정상 MIO summon 결과는 position N credentialId 를 싣는다", mio === accounts[N]!.credentialId, `got=${mio}`);
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
