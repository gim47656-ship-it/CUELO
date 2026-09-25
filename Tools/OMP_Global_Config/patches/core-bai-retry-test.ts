// BAI socket/stream 이송 오류 회귀: 첫 오류는 같은 모델 재시도, 예산 소진·실제 quota·타 provider 는 기존 fallback.
// 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-bai-retry-test.ts
// 미패치 core 에서는 [1] 이 FAIL(RED) — 첫 socket 오류에서 곧바로 모델이 바뀐다.
// 패치 core 에서는 전부 PASS(GREEN). 실제 TurnRecovery.handleRetryableError 를 호스트 스텁으로
// 구동하고 관측 가능한 결과(모델 전환·재시도 예약·세션 이벤트·보존된 실패 턴)만 본다.
// 네트워크·유료 호출·설정 변경 없음(mock fetch + scratch registry).
// 동적 import 예외: core-task-model-test.ts 와 같은 이유(지정한 사본만 검증).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	const hit = candidates.find(p => existsSync(join(p, "src/session/turn-recovery.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	// 동적 import 는 URL 로 해석되므로 역슬래시를 쓰면 안 된다.
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const { TurnRecovery } = await import(`${CORE}/session/turn-recovery.ts`);
const { ModelRegistry } = await import(`${CORE}/config/model-registry.ts`);
// pi-ai 는 coding-agent 의 형제 패키지다(전역 설치·isolated 사본 모두 같은 상대 위치).
const AI_ERROR_PATH = join(CORE, "..", "..", "pi-ai", "src", "error", "index.ts").replace(/\\/g, "/");
if (!existsSync(AI_ERROR_PATH)) throw new Error(`pi-ai error 모듈을 찾지 못했다: ${AI_ERROR_PATH}`);
const AIError = await import(AI_ERROR_PATH);
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

// 실제 관측 문구 그대로(ArenaRuntime.jsonl 364 errorMessage).
const SOCKET_TEXT =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const USAGE_LIMIT_TEXT = "GoUsageLimitError: usage limit reached for this account, resets at 2026-09-14T12:00:00Z";
const SERVER_ERROR_TEXT = "500 status code (no body)";

const BAI_MODEL_SELECTOR = "b-ai/deepseek-v4.1-flash:max";
const MUSE_MODEL_SELECTOR = "opencode-go/muse-spark-1.3-contributor:xhigh";
const CHAINS = {
	impl: [MUSE_MODEL_SELECTOR],
	"b-ai/deepseek-v4.1-flash": [MUSE_MODEL_SELECTOR],
	"b-ai/deepseek-v4.1-flash:max": [MUSE_MODEL_SELECTOR],
	"opencode-go/muse-spark-1.3-contributor": [BAI_MODEL_SELECTOR],
	"opencode-go/muse-spark-1.3-contributor:xhigh": [BAI_MODEL_SELECTOR],
};
const ROLES = { impl: BAI_MODEL_SELECTOR };
// 더미 키(비밀 아님). mock fetch·scratch registry 전용이며 네트워크에 나가지 않는다.
const fixtureApiKey = "example";

const workdir = mkdtempSync(join(tmpdir(), "omp-bai-retry-"));
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

function makeSettings(maxRetries: number) {
	const retry: Record<string, unknown> = {
		enabled: true,
		maxRetries,
		baseDelayMs: 1,
		maxDelayMs: 0,
		modelFallback: true,
		waitForUsageReset: false,
		fallbackChains: CHAINS,
		usageAwareFallback: false,
	};
	return Object.assign(
		// 18.3.1은 retry.* 를 개별 설정 키로 읽고(retry.maxRetries 기본 10), 18.3.0은 getGroup("retry")로 읽는다.
		createSettingsTestScope(key => (key.startsWith("retry.") ? retry[key.slice("retry.".length)] : undefined)),
		{
			getGroup: (name: string) => (name === "retry" ? retry : {}),
			getModelRole: (role: string) => (ROLES as Record<string, string>)[role],
			getModelRoles: () => ROLES,
			getStorage: () => undefined,
		},
	) as never;
}

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
			`    apiKey: ${JSON.stringify(fixtureApiKey)}`,
			"    models:",
			"      - id: deepseek-v4.1-flash",
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
		settings: makeSettings(2),
	});
}

/** 실패 턴 하나와 필요하면 쌍을 이루는 synthetic tool result 를 세션 상태에 넣는다. */
function seedFailedTurn(agent: { state: { messages: unknown[] } }, options: {
	provider: string;
	model: string;
	api: string;
	errorMessage: string;
	errorId?: number;
	content?: unknown[];
	syntheticResult?: boolean;
}) {
	const message = {
		role: "assistant",
		stopReason: "error",
		provider: options.provider,
		model: options.model,
		api: options.api,
		errorMessage: options.errorMessage,
		errorId: options.errorId,
		timestamp: Date.now(),
		content: options.content ?? [
			{ type: "thinking", thinking: "probe the failing path" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "x" } },
		],
	};
	agent.state.messages.push(message);
	if (options.syntheticResult !== false) {
		agent.state.messages.push({
			role: "toolResult",
			toolCallId: "call_1",
			content: [{ type: "text", text: "not executed" }],
			isError: true,
			details: { __synthetic: true, executed: false },
		});
	}
	return message;
}

function makeHarness(options: { maxRetries: number; currentModel: unknown; textCommitted?: boolean }) {
	const registry = makeRegistry(`h${Math.round(Math.random() * 1e9)}`);
	let current = options.currentModel;
	const switches: string[] = [];
	const continues: Array<{ source: string }> = [];
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
			getSessionId: () => "bai-retry-test",
		},
		settings: makeSettings(options.maxRetries),
		modelRegistry: registry,
		configWarnings: [] as string[],
		model: () => current,
		contextFitsModel: () => true,
		textOutputCommitted: () => options.textCommitted === true,
		thinkingLevel: () => "max",
		configuredThinkingLevel: () => "max",
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 1,
		sessionId: () => "bai-retry-test",
		emitSessionEvent: async (event: { type: string }) => {
			events.push(event);
		},
		scheduleAgentContinue: (o: { source: string }) => {
			continues.push(o);
		},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		persistedAssistantEntryId: () => undefined,
		sessionMessageAlreadyPersisted: () => true,
		setModelWithProviderSessionReset: async (model: { provider: string; id: string }) => {
			current = model;
			switches.push(`${model.provider}/${model.id}`);
		},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => false,
		// 18.2.1 은 fallback 교체 전에 활성 edit mode 를 붙잡아 시스템 프롬프트를 다시
		// 동기화한다(issue #11983). 이 하네스가 보는 것은 모델 전환·재시도 예약이므로
		// 고정된 모드를 돌려주고 재동기화는 no-op 으로 둔다.
		resolveActiveEditMode: () => "replace",
		syncAfterModelChange: async () => {},
		runAutoCompaction: async () => ({ deferredHandoff: false, continuationScheduled: false }),
		withBashBranchTransition: (op: () => unknown) => op(),
	};
	const recovery = new TurnRecovery(host as never);
	return {
		recovery,
		switches,
		continues,
		events,
		agent,
		activeModel: () => current as { provider: string; id: string; api: string },
		eventTypes: () => events.map(e => e.type).join(","),
	};
}

try {
	const registry = makeRegistry("models");
	const baiModel = registry.find("b-ai", "deepseek-v4.1-flash");
	const museModel = registry.find("opencode-go", "muse-spark-1.3-contributor");
	if (!baiModel || !museModel) throw new Error("fixture 모델을 registry 에서 찾지 못했다");

	console.log("\n[1] b-ai + socket close, 재시도 예산 남음 → 같은 모델 재시도");
	{
		const h = makeHarness({ maxRetries: 2, currentModel: baiModel });
		const turn = seedFailedTurn(h.agent, {
			provider: "b-ai",
			model: "deepseek-v4.1-flash",
			api: baiModel.api,
			errorMessage: SOCKET_TEXT,
		});
		const retried = await h.recovery.handleRetryableError(turn as never, { allowModelFallback: true });
		check("모델이 바뀌지 않는다", h.switches.length === 0, `switches=${h.switches.join(",")}`);
		check(
			"재시도가 예약되고 fallback 이벤트가 없다",
			retried === true && h.continues.length === 1 && !h.events.some(e => e.type === "retry_fallback_applied"),
			`retried=${retried} continues=${h.continues.length} events=${h.eventTypes()}`,
		);
		check(
			"auto_retry_start 1회차가 기록된다",
			h.events.some(e => e.type === "auto_retry_start" && e.attempt === 1),
			h.eventTypes(),
		);
		check("실패 턴이 보존된다(재실행 방지)", h.agent.state.messages.length === 2, `len=${h.agent.state.messages.length}`);
	}

	console.log("\n[2] b-ai + socket close, 재시도 예산 소진 → 기존 fallback 유지");
	{
		const h = makeHarness({ maxRetries: 2, currentModel: baiModel });
		for (let attempt = 1; attempt <= 3 && h.switches.length === 0; attempt++) {
			const current = h.activeModel();
			const turn = seedFailedTurn(h.agent, {
				provider: current.provider,
				model: current.id,
				api: current.api,
				errorMessage: SOCKET_TEXT,
			});
			await h.recovery.handleRetryableError(turn as never, { allowModelFallback: true });
		}
		check(
			"예산 소진 뒤 체인 후보로 전환된다",
			h.switches[0] === "opencode-go/muse-spark-1.3-contributor",
			`switches=${h.switches.join(",")}`,
		);
		check("전환이 retry_fallback_applied 로 보고된다", h.events.some(e => e.type === "retry_fallback_applied"), h.eventTypes());
	}

	console.log("\n[3] b-ai + 실제 UsageLimit → 기존 즉시 fallback");
	{
		const h = makeHarness({ maxRetries: 2, currentModel: baiModel });
		const turn = seedFailedTurn(h.agent, {
			provider: "b-ai",
			model: "deepseek-v4.1-flash",
			api: baiModel.api,
			errorMessage: USAGE_LIMIT_TEXT,
			errorId: AIError.create(AIError.Flag.UsageLimit),
		});
		await h.recovery.handleRetryableError(turn as never, { allowModelFallback: true });
		check(
			"UsageLimit 은 즉시 체인 후보로 전환된다",
			h.switches[0] === "opencode-go/muse-spark-1.3-contributor",
			`switches=${h.switches.join(",")}`,
		);
	}

	console.log("\n[4] 다른 provider + socket close → 기존 즉시 fallback");
	{
		const h = makeHarness({ maxRetries: 2, currentModel: museModel });
		const turn = seedFailedTurn(h.agent, {
			provider: "opencode-go",
			model: "muse-spark-1.3-contributor",
			api: museModel.api,
			errorMessage: SOCKET_TEXT,
		});
		await h.recovery.handleRetryableError(turn as never, { allowModelFallback: true });
		check(
			"b-ai 가 아니면 즉시 전환된다",
			h.switches[0] === "b-ai/deepseek-v4.1-flash",
			`switches=${h.switches.join(",")}`,
		);
	}

	console.log("\n[5] b-ai + socket/stream 문구가 아닌 transient → 기존 즉시 fallback");
	{
		const h = makeHarness({ maxRetries: 2, currentModel: baiModel });
		const turn = seedFailedTurn(h.agent, {
			provider: "b-ai",
			model: "deepseek-v4.1-flash",
			api: baiModel.api,
			errorMessage: SERVER_ERROR_TEXT,
		});
		await h.recovery.handleRetryableError(turn as never, { allowModelFallback: true });
		check(
			"게이트는 socket/stream 문구에만 걸린다",
			h.switches[0] === "opencode-go/muse-spark-1.3-contributor",
			`switches=${h.switches.join(",")}`,
		);
	}

	console.log("\n[6] b-ai + 커밋된 텍스트가 있는 socket close → 재시도 의미는 기존 그대로");
	{
		const h = makeHarness({ maxRetries: 2, currentModel: baiModel, textCommitted: true });
		const turn = seedFailedTurn(h.agent, {
			provider: "b-ai",
			model: "deepseek-v4.1-flash",
			api: baiModel.api,
			errorMessage: SOCKET_TEXT,
			content: [
				{ type: "text", text: "already streamed paragraph" },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "x" } },
			],
			syntheticResult: false,
		});
		const retried = await h.recovery.handleRetryableError(turn as never, { allowModelFallback: true });
		check("모델이 바뀌지 않는다", h.switches.length === 0, `switches=${h.switches.join(",")}`);
		check(
			"실패 턴은 기존 재시도 규칙대로 정리되고 재시도가 예약된다",
			retried === true && h.agent.state.messages.length === 0 && h.continues.length === 1,
			`retried=${retried} len=${h.agent.state.messages.length} continues=${h.continues.length}`,
		);
	}

	console.log(`\n결과 ${pass} pass / ${fail} fail`);
	process.exitCode = fail === 0 ? 0 : 1;
} finally {
	auth.close();
	rmSync(workdir, { recursive: true, force: true });
}
