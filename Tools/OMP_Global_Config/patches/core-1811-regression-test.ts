// OMP 18.0.11 회귀 하네스. 실행:
//   bun run ~/.omp/core-1811-regression-test.ts
//
// core-patch-test.ts 는 우리 패치를 검증한다. 이 파일은 반대로 upstream 18.0.11 이
// 고친 계약이 유지되는지 본다. omp-web 을 업데이트하거나 되돌리면 조용히 사라질 수
// 있는 지점만 고르고, 네트워크·자격증명·프로필 상태는 건드리지 않는다.
//
//   [1] HTTP 402 청구 캡 분류와 모델 폴백 전 형제 자격 회전
//   [2] pull 진단의 타임아웃·실패를 clean 으로 접지 않는 lsp diagnostics
//   [3] 상대 API 주소와 로컬 이미지 경로의 붙여넣기 분류
//   [4] 공유 headless 브라우저 타깃 소유권 등록과 수확 경계
//   [5] 무효화된 작업기억이 recall 후보 슬롯을 잡지 않는 Mnemopi
//
// 미포함(호출 가능한 seam 이 없어 여기서 검증하지 않는 18.0.11 항목):
//   - SubAgent 확장 컨텍스트의 `ctx.getContextUsage()`/`ctx.compact()` 대상 세션.
//     실제 결함은 `src/task/executor.ts` 의 SubAgent 전용 contextActions 리터럴에
//     있고, 그 클로저는 살아 있는 자식 AgentSession(모델·자격증명 필요) 없이는
//     세울 수 없다. ExtensionRunner 만 세워 확인하면 "넘긴 함수를 그대로 노출한다"
//     라는, 애초에 깨진 적 없는 배선만 보게 되므로 약한 테스트를 두지 않는다.
//   - 손상된 이미지 입력의 영구 차단 해제, MCP OAuth 중첩 경로 discovery,
//     tool call 이후 transport 재시도: 각각 실제 provider·OAuth 서버·스트림이 필요하다.
//
// 동적 import 예외: 정적 import 는 `@oh-my-pi/*` 를 bun 전역 캐시의 다른 사본으로
// 해석한다. omp-web 이 실제로 적재하는 사본만 검증해야 하므로 디스크 경로를 고정한다
// (core-patch-test.ts 와 같은 모듈 로딩 경계 이유).
//
// 종료 코드: 0 통과, 1 실패, 2 CUELO 전역 설치 없음. setup.ps1 / verify.ps1 은
// 2 를 실패가 아니라 SKIP 으로 읽는다.
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// 이름이 `...SessionId` 로 끝나면 verify.ps1 의 자격 스캔 heuristic 이 따옴표 값을
// 자격증명으로 읽는다. 값은 세션 이름일 뿐이므로 이름만 그 형태를 피한다.
const HARNESS_SESSION = "omp-1811-harness-session";
const HARNESS_MODEL_ID = "harness-model";
const PRIMARY_SLOT = "primary-slot-value";
const SIBLING_SLOT = "sibling-slot-value";

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

async function section(title: string, body: () => Promise<void>): Promise<void> {
	console.log(`\n${title}`);
	try {
		await body();
	} catch (error) {
		fail += 1;
		console.log(`  FAIL  섹션 실행 실패: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const NPM_MODULES = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");

/** 동적 import 는 URL 로 해석되므로 역슬래시를 쓰면 안 된다. */
function importBase(directory: string): string {
	return directory.replace(/\\/g, "/");
}

/** 전역 npm 위치는 PC 마다 다르다. apply-core-patch.mjs 와 같은 순서로 찾는다. */
function resolveCorePackage(): string | undefined {
	const override = process.env.OMP_CORE_PATCH_TARGET;
	const candidates = override
		? [override]
		: [
				join(NPM_MODULES, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(NPM_MODULES, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"),
				join(NPM_MODULES, "@oh-my-pi/pi-coding-agent"),
			];
	return candidates.find(directory => existsSync(join(directory, "src/registry/agent-registry.ts")));
}

/** 같은 스코프의 형제 패키지. npm 이 hoist 한 위치와 중첩 위치를 모두 본다. */
function resolveScopePackage(corePackage: string, name: string, probe: string): string | undefined {
	const candidates = [
		join(corePackage, "node_modules/@oh-my-pi", name),
		join(dirname(corePackage), name),
		join(NPM_MODULES, "@oh-my-pi", name),
	];
	return candidates.find(directory => existsSync(join(directory, probe)));
}

const CORE_PACKAGE = resolveCorePackage();
if (CORE_PACKAGE === undefined) {
	console.log("CUELO 전역 설치를 찾지 못했다. 18.0.11 회귀 검증을 건너뛴다.");
	process.exit(2);
}
const CORE = `${importBase(CORE_PACKAGE)}/src`;
console.log(`대상 ${CORE}`);

// ---------------------------------------------------------------------------
// [1] HTTP 402 — 청구 캡 본문 분류와 모델 폴백 전 형제 자격 회전
//
// 18.0.11 은 402 를 두 갈래로 나눈다. 지불/비활성화/잔액 소진 또는 불투명 본문은
// 계정 청구 캡이라 형제 자격으로 회전하고, 정보성 비-쿼터 402(구독 안내 등)는
// 쿼터 소진으로 오분류하지 않는다. 회전 결정 지점은 createApiKeyResolver 의
// lastChance 분기이므로, 자격 풀을 대역으로 세워 실제 분기를 태운다.
//
// 한계: 여기서 검증하는 것은 "분류 결과가 회전 요청과 재해석으로 이어지는가" 다.
// 실제 AuthStorage.rotateSessionCredential(브로커 왕복, 계정 상태 갱신)은 자격증명이
// 필요해 이 하네스 범위 밖이며, 이 섹션이 그것을 증명하지는 않는다.
// ---------------------------------------------------------------------------
await section("[1] HTTP 402 청구 캡 분류와 형제 자격 회전", async () => {
	const aiPackage = resolveScopePackage(CORE_PACKAGE, "pi-ai", "src/error/rate-limit.ts");
	check("pi-ai 소스를 찾는다", aiPackage !== undefined, "@oh-my-pi/pi-ai 가 설치본에 없다");
	if (aiPackage === undefined) return;
	const errors = await import(`${importBase(aiPackage)}/src/error/index.ts`);
	const { createApiKeyResolver } = await import(`${CORE}/config/api-key-resolver.ts`);
	const { ProviderHttpError, is402BillingCapBody, isConcurrencyCapExclusion, isUsageLimit, isUsageLimitOutcome } = errors;

	const SUBSCRIPTION_402 = "A subscription is required for this endpoint";
	const CONCURRENT_402 = "Too many concurrent requests";
	const provider402 = (message: string) => new ProviderHttpError(message, 402);

	check("본문 없는 402 는 청구 캡", is402BillingCapBody(undefined) === true);
	check("상태 숫자만 있는 402 본문은 청구 캡", is402BillingCapBody("402") === true);
	check("payment required 본문은 청구 캡", is402BillingCapBody("HTTP 402: payment required") === true);
	check("deactivated_workspace 본문은 청구 캡", is402BillingCapBody("deactivated_workspace") === true);
	check("Insufficient Balance 본문은 청구 캡", is402BillingCapBody("Insufficient Balance") === true);
	check("구독 안내 402 본문은 청구 캡이 아니다", is402BillingCapBody(SUBSCRIPTION_402) === false);

	check("402 payment required 는 회전 대상", isUsageLimitOutcome(402, "HTTP 402: payment required") === true);
	check("402 구독 안내는 회전 대상이 아니다", isUsageLimitOutcome(402, SUBSCRIPTION_402) === false);
	check("402 동시 요청 캡은 회전 대상", isUsageLimitOutcome(402, CONCURRENT_402) === true);
	check("429 동시 요청 캡은 회전 대상이 아니다", isUsageLimitOutcome(429, CONCURRENT_402) === false);
	check("동시 캡 제외 규칙은 402 를 비켜간다", isConcurrencyCapExclusion(402, CONCURRENT_402) === false);
	check("동시 캡 제외 규칙은 429 에 적용된다", isConcurrencyCapExclusion(429, CONCURRENT_402) === true);

	check("402 청구 캡 에러는 usage limit 으로 분류된다", isUsageLimit(provider402("HTTP 402: payment required")) === true);
	check("402 구독 안내 에러는 usage limit 이 아니다", isUsageLimit(provider402(SUBSCRIPTION_402)) === false);

	interface AuthPoolState {
		active: string;
		rotations: number;
		resolves: Array<Record<string, unknown>>;
		lastRotation?: Record<string, unknown>;
	}

	/** 형제 자격이 있으면 회전 시 활성 자격이 바뀌는, 최소한의 자격 풀 대역. */
	function authPool(options: { hasSibling: boolean }) {
		const state: AuthPoolState = { active: PRIMARY_SLOT, rotations: 0, resolves: [] };
		const registry = {
			// 18.3.0: resolver는 getApiKeyWithCredentialForProvider(문자열도 허용)를 부르고, 회전은 authStorage.limits.rotate다.
			getApiKeyWithCredentialForProvider: async (
				_provider: string,
				_session?: string,
				resolveOptions?: Record<string, unknown>,
			): Promise<string> => {
				state.resolves.push(resolveOptions ?? {});
				return state.active;
			},
			authStorage: {
				limits: {
					rotate: async (
						_provider: string,
						_session: string | undefined,
						request: Record<string, unknown>,
					): Promise<boolean> => {
						state.rotations += 1;
						state.lastRotation = request;
						if (!options.hasSibling) return false;
						state.active = SIBLING_SLOT;
						return true;
					},
				},
			},
		};
		return { registry, state };
	}

	const initial = authPool({ hasSibling: true });
	const initialResolver = createApiKeyResolver(initial.registry, "harness-provider", { modelId: HARNESS_MODEL_ID });
	const initialKey = await initialResolver({ lastChance: false });
	check("첫 해석은 회전 없이 현재 자격을 쓴다", initialKey === PRIMARY_SLOT && initial.state.rotations === 0);
	check("첫 해석은 강제 갱신을 요구하지 않는다", initial.state.resolves[0]?.forceRefresh === undefined);

	const refresh = authPool({ hasSibling: true });
	const refreshResolver = createApiKeyResolver(refresh.registry, "harness-provider");
	const refreshKey = await refreshResolver({ lastChance: false, error: provider402("HTTP 402: payment required") });
	check(
		"마지막 기회 전 재시도는 같은 계정을 강제 갱신한다",
		refreshKey === PRIMARY_SLOT && refresh.state.resolves[0]?.forceRefresh === true && refresh.state.rotations === 0,
	);

	const withSibling = authPool({ hasSibling: true });
	const siblingResolver = createApiKeyResolver(withSibling.registry, "harness-provider", { modelId: HARNESS_MODEL_ID });
	const billingError = provider402("HTTP 402: payment required");
	const rotatedKey = await siblingResolver({ lastChance: true, error: billingError, previousKey: PRIMARY_SLOT });
	check(
		"402 청구 캡은 모델 폴백 전에 형제 자격으로 회전한다",
		withSibling.state.rotations === 1 && rotatedKey === SIBLING_SLOT,
		`rotations=${withSibling.state.rotations} key=${String(rotatedKey)}`,
	);
	check(
		"회전 요청에 실패 에러와 모델이 함께 전달된다",
		withSibling.state.lastRotation?.error === billingError && withSibling.state.lastRotation?.modelId === HARNESS_MODEL_ID,
	);

	const noSibling = authPool({ hasSibling: false });
	const noSiblingResolver = createApiKeyResolver(noSibling.registry, "harness-provider");
	const exhausted = await noSiblingResolver({
		lastChance: true,
		error: provider402("HTTP 402: payment required"),
		previousKey: PRIMARY_SLOT,
	});
	check(
		"형제가 없는 402 청구 캡은 백오프에 넘기려고 멈춘다",
		noSibling.state.rotations === 1 && exhausted === undefined,
		`key=${String(exhausted)}`,
	);

	const informative = authPool({ hasSibling: false });
	const informativeResolver = createApiKeyResolver(informative.registry, "harness-provider");
	const informativeKey = await informativeResolver({
		lastChance: true,
		error: provider402(SUBSCRIPTION_402),
		previousKey: PRIMARY_SLOT,
	});
	check(
		"정보성 비-쿼터 402 는 쿼터 소진으로 오분류하지 않는다",
		informative.state.rotations === 1 && informativeKey === PRIMARY_SLOT,
		`key=${String(informativeKey)}`,
	);
});

// ---------------------------------------------------------------------------
// [2] lsp diagnostics — pull 실패를 clean 으로 접지 않는다
//
// 18.0.11 은 project-aware pull 서버의 진단이 타임아웃·RPC 실패로 끝났을 때
// waitForDiagnostics 가 빈 배열(= 파일 정상)로 접히지 않고 예외로 알리게 고쳤다.
// 실제 서버 프로세스 없이도 stdin sink 만 대역으로 세우면 그 분기를 그대로 태운다.
// ---------------------------------------------------------------------------
await section("[2] lsp diagnostics pull 실패의 정직성", async () => {
	const { waitForDiagnostics } = await import(`${CORE}/lsp/diagnostics.ts`);
	const FILE_URI = "file:///harness/one.ts";
	const DIAGNOSTIC = {
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		message: "harness diagnostic",
		severity: 1,
	};

	interface FakePending {
		resolve: (value: unknown) => void;
		reject: (error: unknown) => void;
		method: string;
	}
	interface FakeClient {
		pendingRequests: Map<number | string, FakePending>;
		diagnostics: Map<string, { diagnostics: unknown[]; version: number | null }>;
		diagnosticsVersion: number;
		[extra: string]: unknown;
	}

	function decodeFrame(chunk: string): { id?: number; method?: string } | undefined {
		const split = chunk.indexOf("\r\n\r\n");
		if (split < 0) return undefined;
		try {
			return JSON.parse(chunk.slice(split + 4)) as { id?: number; method?: string };
		} catch {
			return undefined;
		}
	}

	/** LspClient 최소 형태. pull 능력, 전송 실패, 응답 주입만 바꿔 끼운다. */
	function fakeClient(options: {
		pull: boolean;
		writeError?: string;
		answer?: (client: FakeClient, frame: { id?: number; method?: string }) => void;
	}): FakeClient {
		const client: FakeClient = {
			name: "harness-lsp",
			cwd: "/harness",
			config: {},
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map<number | string, FakePending>(),
			messageBuffer: new Uint8Array(0),
			isReading: true,
			status: "ready",
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set<string | number>(),
			projectLoaded: Promise.resolve(),
			resolveProjectLoaded: () => {},
			serverCapabilities: options.pull ? { diagnosticProvider: {} } : undefined,
			proc: {
				stdin: {
					write(chunk: string): number {
						if (options.writeError !== undefined) throw new Error(options.writeError);
						const frame = decodeFrame(chunk);
						if (frame !== undefined) options.answer?.(client, frame);
						return chunk.length;
					},
					flush(): void {},
				},
				kill(): void {},
			},
		};
		return client;
	}

	const stalled = fakeClient({ pull: true });
	let stalledMessage = "";
	try {
		await waitForDiagnostics(stalled as never, FILE_URI, { timeoutMs: 150 });
	} catch (error) {
		stalledMessage = error instanceof Error ? error.message : String(error);
	}
	check("pull 이 타임아웃하면 빈 결과가 아니라 예외로 알린다", stalledMessage.includes("timed out"), stalledMessage);

	const broken = fakeClient({ pull: true, writeError: "harness transport down" });
	let brokenMessage = "";
	try {
		await waitForDiagnostics(broken as never, FILE_URI, { timeoutMs: 120 });
	} catch (error) {
		brokenMessage = error instanceof Error ? error.message : String(error);
	}
	check("pull 이 전송 단계에서 실패해도 clean 으로 접히지 않는다", brokenMessage.includes("harness transport down"), brokenMessage);

	const answered = fakeClient({
		pull: true,
		answer: (client, frame) => {
			if (frame.method !== "textDocument/diagnostic" || frame.id === undefined) return;
			const id = frame.id;
			queueMicrotask(() => client.pendingRequests.get(id)?.resolve({ kind: "full", items: [DIAGNOSTIC] }));
		},
	});
	const answeredItems = (await waitForDiagnostics(answered as never, FILE_URI, { timeoutMs: 1000 })) as Array<{
		message?: string;
	}>;
	check(
		"정상 pull 응답은 그대로 진단으로 돌아온다",
		answeredItems.length === 1 && answeredItems[0]?.message === DIAGNOSTIC.message,
		`items=${answeredItems.length}`,
	);
	check(
		"정상 pull 결과는 클라이언트 캐시에 반영된다",
		answered.diagnostics.get(FILE_URI)?.diagnostics.length === 1 && answered.diagnosticsVersion === 1,
	);

	// 반대 방향 통제: 서버가 실제로 답한 빈 진단은 여전히 clean 이어야 한다.
	const pushOnly = fakeClient({ pull: false });
	pushOnly.diagnostics.set(FILE_URI, { diagnostics: [], version: 7 });
	const cleanItems = (await waitForDiagnostics(pushOnly as never, FILE_URI, {
		timeoutMs: 300,
		expectedDocumentVersion: 7,
	})) as unknown[];
	check("push 전용 서버의 버전 일치 publish 는 clean 으로 인정한다", cleanItems.length === 0, `items=${cleanItems.length}`);
});

// ---------------------------------------------------------------------------
// [3] 붙여넣기 분류 — 상대 API 주소 vs 로컬 이미지 경로
//
// 18.0.11 은 이름이 이미지 확장자로 끝나는 상대 API 주소를 "없는 로컬 이미지 파일"
// 로 넘기지 않고 텍스트로 붙이게 고쳤다. 앵커 없는 상대 주소는 경로로 인정하지
// 않고, 진짜 앵커가 있는 경로는 그대로 인정하는 양방향을 함께 고정한다.
// ---------------------------------------------------------------------------
await section("[3] 상대 API 주소와 로컬 이미지 경로 분류", async () => {
	// 18.2.5 에서 custom-editor 가 pi-coding-agent/src/modes/components 에서
	// pi-tui/src/prompt 로 옮겨갔다. 집(18.2.4)·사무실(18.2.5) 양쪽에서 돌아야 한다.
	const legacyEditor = join(CORE_PACKAGE, "src/modes/components/custom-editor.ts");
	const tuiPackage = resolveScopePackage(CORE_PACKAGE, "pi-tui", "src/prompt/custom-editor.ts");
	const editorPath = existsSync(legacyEditor)
		? legacyEditor
		: tuiPackage === undefined
			? undefined
			: join(tuiPackage, "src/prompt/custom-editor.ts");
	if (editorPath === undefined) {
		throw new Error("custom-editor.ts 를 두 배치(core/modes/components, pi-tui/prompt) 모두에서 찾지 못했다");
	}
	const editor = await import(importBase(editorPath));
	const { extractBracketedImagePastePaths, extractImagePastePathsFromText, extractImagePathFromText } = editor;

	check("앵커 없는 상대 API 주소는 이미지 경로가 아니다", extractImagePathFromText("v1/assets/logo.png") === undefined);
	check("중첩 상대 API 주소도 이미지 경로가 아니다", extractImagePathFromText("api/v2/users/avatar.jpeg") === undefined);
	check("상대 API 주소 묶음은 경로 목록이 아니다", extractImagePastePathsFromText("api/v2/users/avatar.jpeg") === undefined);
	check("URI 스킴이 붙은 주소는 이미지 경로가 아니다", extractImagePathFromText("https://example.invalid/logo.png") === undefined);
	check(
		"bracketed paste 로 온 상대 API 주소도 텍스트로 남는다",
		extractBracketedImagePastePaths("\x1b[200~v1/assets/logo.png\x1b[201~") === undefined,
	);

	check("절대 POSIX 경로는 이미지 경로로 인정한다", extractImagePathFromText("/tmp/shot.png") === "/tmp/shot.png");
	check("점 앵커 상대 경로는 이미지 경로로 인정한다", extractImagePathFromText("./assets/shot.png") === "./assets/shot.png");
	check("상위 앵커 상대 경로는 이미지 경로로 인정한다", extractImagePathFromText("../assets/shot.png") === "../assets/shot.png");
	check(
		"윈도 드라이브 경로는 이미지 경로로 인정한다",
		extractImagePathFromText("C:\\Users\\me\\shot.png") === "C:\\Users\\me\\shot.png",
	);
	check(
		"file 스킴 URL 은 로컬 경로로 환원한다",
		extractImagePathFromText("file:///tmp/shot.png")?.endsWith("shot.png") === true,
	);
	check(
		"이미지 확장자가 아닌 절대 경로는 이미지가 아니다",
		extractImagePathFromText("/tmp/notes.txt") === undefined,
	);
	check(
		"bracketed paste 로 온 절대 이미지 경로는 인정한다",
		extractBracketedImagePastePaths("\x1b[200~/tmp/shot.png\x1b[201~")?.join(",") === "/tmp/shot.png",
	);
});

// ---------------------------------------------------------------------------
// [4] 공유 headless 브라우저 타깃 소유권 등록과 수확 경계
//
// 18.0.11 은 세션이 비정상 종료해도 남는 page/iframe/worker 를 지우기 위해
// 소유권을 디스크에 남기고, 죽은 소유자의 타깃만 수확한다. 살아 있는 세션의 탭을
// 뺏지 않는 쪽이 더 중요한 계약이므로 자기 파일·생존 소유자·grace 창을 함께 본다.
// pid 조회와 CDP 는 주입 seam / 대역으로 대체하므로 실제 브라우저는 뜨지 않는다.
// ---------------------------------------------------------------------------
await section("[4] 공유 브라우저 타깃 소유권과 수확 경계", async () => {
	const registryModule = await import(`${CORE}/tools/browser/orphan-registry.ts`);
	const { closeCdpTarget, collectOrphanTargets, forgetSharedTarget, recordSharedTarget, resetOrphanRegistryForTest } =
		registryModule;
	const { daemonRuntimeDir } = await import(`${CORE}/launch/paths.ts`);

	// 실재하지 않는 임시 프로젝트 경로라 해시 디렉터리가 어떤 실제 프로젝트와도 겹치지 않는다.
	const projectDir = join(tmpdir(), `omp-1811-harness-${process.pid}-${Date.now().toString(36)}`);
	const daemonName = "omp.browser.harness";
	const scope = { projectDir, daemonName };
	const runtimeDir = daemonRuntimeDir(projectDir) as string;
	const registryDir = join(runtimeDir, `${daemonName}.targets`);
	const deadPid = 0x7ff0_0000;

	function cdpStub(options: { closed?: boolean; closeThrows?: boolean; targets?: string[]; queryThrows?: boolean }) {
		const session = {
			async send(method: string): Promise<Record<string, unknown>> {
				if (method === "Target.closeTarget") {
					if (options.closeThrows === true) throw new Error("harness CDP close failed");
					return { success: options.closed === true };
				}
				if (method === "Target.getTargets") {
					if (options.queryThrows === true) throw new Error("harness CDP query failed");
					return { targetInfos: (options.targets ?? []).map(targetId => ({ targetId })) };
				}
				return {};
			},
			async detach(): Promise<void> {},
		};
		return { target: () => ({ createCDPSession: async () => session }) };
	}

	try {
		resetOrphanRegistryForTest();
		await recordSharedTarget(scope, "harness-target-1");
		const ownFile = join(registryDir, `${process.pid}.json`);
		check("공유 브라우저 타깃 소유권이 디스크에 남는다", existsSync(ownFile), ownFile);

		const selfScan = await collectOrphanTargets(scope, {
			isAlive: () => false,
			now: () => Date.now() + 3_600_000,
			graceMs: 0,
		});
		check("자기 프로세스가 만든 타깃은 절대 수확하지 않는다", selfScan.owners.length === 0);

		await fsp.writeFile(
			join(registryDir, `${deadPid}.json`),
			JSON.stringify({ pid: deadPid, updatedAt: Date.now() - 60_000, targets: ["harness-orphan-1", "harness-orphan-2"] }),
			"utf8",
		);

		const liveScan = await collectOrphanTargets(scope, { isAlive: () => true, graceMs: 15_000 });
		check("살아 있는 소유자의 타깃은 남긴다", liveScan.owners.length === 0);

		const graceScan = await collectOrphanTargets(scope, { isAlive: pid => pid !== deadPid, graceMs: 600_000 });
		check("죽은 소유자도 grace 창 안이면 아직 수확하지 않는다", graceScan.owners.length === 0);

		const orphanScan = await collectOrphanTargets(scope, { isAlive: pid => pid !== deadPid, graceMs: 15_000 });
		const orphanOwner = orphanScan.owners[0];
		check(
			"죽은 소유자의 타깃만 소유자 단위로 모인다",
			orphanScan.owners.length === 1 && orphanOwner?.pid === deadPid && orphanOwner?.targetIds.length === 2,
			`owners=${orphanScan.owners.length}`,
		);

		await forgetSharedTarget(scope, "harness-target-1");
		check("정상 종료한 타깃은 소유권 파일에서 사라진다", !existsSync(ownFile));

		check(
			"CDP 가 close 성공을 확인하면 수확 완료로 센다",
			(await closeCdpTarget(cdpStub({ closed: true }) as never, "harness-orphan-1")) === true,
		);
		check(
			"close 가 실패했지만 타깃이 이미 없으면 수확 완료로 센다",
			(await closeCdpTarget(cdpStub({ closeThrows: true, targets: [] }) as never, "harness-orphan-1")) === true,
		);
		check(
			"close 도 조회도 실패하면 재시도용으로 남긴다",
			(await closeCdpTarget(cdpStub({ closeThrows: true, queryThrows: true }) as never, "harness-orphan-1")) === false,
		);
		check(
			"타깃이 아직 살아 있으면 재시도용으로 남긴다",
			(await closeCdpTarget(cdpStub({ targets: ["harness-orphan-1"] }) as never, "harness-orphan-1")) === false,
		);
		const unopenableBrowser = {
			target: () => ({
				createCDPSession: async () => {
					throw new Error("harness CDP session unavailable");
				},
			}),
		};
		check(
			"CDP 세션을 못 열면 재시도용으로 남긴다",
			(await closeCdpTarget(unopenableBrowser as never, "harness-orphan-1")) === false,
		);
	} finally {
		resetOrphanRegistryForTest();
		await fsp.rm(registryDir, { recursive: true, force: true }).catch(() => undefined);
		await fsp.rmdir(runtimeDir).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// [5] Mnemopi 작업기억 recall — 무효화된 행이 후보 슬롯을 잡지 않는다
//
// 18.0.9 는 superseded 행, 18.0.11 은 valid_until 로 무효화된 행이 FTS LIMIT 슬롯을
// 차지해 살아 있는 행을 밀어내는 문제를 고쳤다. 후보 한도는 max(topK*3, 50) 이므로
// 무효화 행 60개를 먼저 넣고(id 순서상 앞선다) 살아 있는 행 3개를 뒤에 둔다.
// 가시성 필터가 FTS 안에서 걸리지 않으면 살아 있는 행은 한 건도 후보에 못 든다.
// 저장소는 :memory: 라 사용자의 실제 기억 DB 를 읽지도 바꾸지도 않는다.
// ---------------------------------------------------------------------------
await section("[5] Mnemopi 무효화 후 작업기억 recall", async () => {
	const mnemopiPackage = resolveScopePackage(CORE_PACKAGE, "pi-mnemopi", "src/core/beam/index.ts");
	check("pi-mnemopi 소스를 찾는다", mnemopiPackage !== undefined, "@oh-my-pi/pi-mnemopi 가 설치본에 없다");
	if (mnemopiPackage === undefined) return;
	// 임베딩과 프로액티브 링킹은 외부 provider 를 건드릴 수 있어 이 프로세스 안에서만 끈다.
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
	process.env.MNEMOPI_PROACTIVE_LINKING = "0";

	const { BeamMemory } = await import(`${importBase(mnemopiPackage)}/src/core/beam/index.ts`);
	const RECALL_MARKER = "zzqqharness";
	const stamp = new Date().toISOString();
	const beam = new BeamMemory({
		sessionId: HARNESS_SESSION,
		dbPath: ":memory:",
		// 가중치를 명시해 사용자 mnemopi 설정이 점수에 끼어들지 않게 한다.
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			maxEpisodeChars: 100_000,
			useCloud: false,
			localLlmEnabled: false,
			proactiveLinking: false,
		},
	});
	const recallOptions = { queryEmbedding: null, useSynonyms: false, updateRecallCounts: false };

	try {
		const invalidated: string[] = [];
		for (let index = 0; index < 60; index += 1) {
			const id = `a${String(index).padStart(4, "0")}`;
			// 모든 행의 토큰 수가 같아야 bm25 순위가 같아지고, 정렬은 id 순서로 결정된다.
			beam.remember(`${RECALL_MARKER} alpha ${id}`, { memoryId: id, timestamp: stamp });
			invalidated.push(id);
		}
		const live = ["z0000", "z0001", "z0002"];
		for (const id of live) {
			beam.remember(`${RECALL_MARKER} alpha ${id}`, { memoryId: id, timestamp: stamp });
		}
		await beam.flushExtractions();

		const beforeInvalidation = (await beam.recall(RECALL_MARKER, 3, recallOptions)) as Array<{ id?: string }>;
		check("무효화 전에는 marker 로 후보가 잡힌다", beforeInvalidation.length === 3, `results=${beforeInvalidation.length}`);

		let invalidatedCount = 0;
		for (const id of invalidated) {
			if (beam.invalidate(id) === true) invalidatedCount += 1;
		}
		check("무효화 호출이 대상 행 전부에 적용된다", invalidatedCount === invalidated.length, `applied=${invalidatedCount}`);

		const afterInvalidation = (await beam.recall(RECALL_MARKER, 3, recallOptions)) as Array<{ id?: string }>;
		const returned = afterInvalidation.map(row => String(row.id)).sort();
		check(
			"무효화된 행이 후보 한도를 채워도 살아 있는 행이 돌아온다",
			returned.length === live.length && returned.join(",") === live.join(","),
			`returned=${returned.join(",")}`,
		);
		check("무효화된 행은 결과에 섞이지 않는다", returned.every(id => !invalidated.includes(id)));

		// 반대 방향 통제: 가시성 필터 자체가 살아 있는지 확인한다.
		for (const id of live) beam.invalidate(id);
		const allInvalidated = (await beam.recall(RECALL_MARKER, 3, recallOptions)) as unknown[];
		check("전부 무효화되면 결과가 없다", allInvalidated.length === 0, `results=${allInvalidated.length}`);
	} finally {
		beam.close();
	}
});

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
