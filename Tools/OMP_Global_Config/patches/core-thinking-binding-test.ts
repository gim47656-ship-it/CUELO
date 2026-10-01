// Opus 5.5 preserved-thinking prefix binding 회귀. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-thinking-binding-test.ts
// 공식 문서(platform.claude.com/docs/en/build-with-claude/preserved-thinking)상 Opus 5.5도 thinking 서명을 앞선
// system·tools·messages에 묶는다. 미패치 core에서는 [0]·[1]·[2]·[4]가 FAIL(RED)이다: catalog가 Opus 5.5의
// prefixBinding을 빠뜨리고, modelOverrides의 thinking이 규칙이 채운 prefixBinding을 통째로 덮어써서 Sonnet 5.5도
// 잃는다. 그러면 prefix가 바뀐 요청이 drop_block 없이 나가 신규 계정에서 400이 된다. 패치 core에서는 전부 PASS다.
// [5]~[7]은 binding controls의 provider 범위다: 18.4.5 upstream은 Vertex의 400(`block_binding: Extra inputs are not
// permitted`)으로 Sonnet 5.5 규칙을 Claude API·Cloudflare로 좁혔다. Opus 5.5 규칙이 Vertex를 포함하면 [6]·[7]이 FAIL이다.
// 실제 ModelRegistry·catalog buildModel과 Anthropic 요청 builder를 쓰고, 요청은 loopback mock이 받는다. 네트워크·`~/.omp` 접근 없음.
// 동적 import 예외: core-bai-retry-test.ts와 같은 이유(지정한 사본만 검증).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsTestScope } from "./core-test-settings";

/** 전역 npm 위치는 PC마다 다르다. apply-core-patch.mjs와 같은 순서로 찾는다. */
function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(p => existsSync(join(p, "src/config/model-registry.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	// 동적 import는 URL로 해석되므로 역슬래시를 쓰면 안 된다.
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const { ModelRegistry } = await import(`${CORE}/config/model-registry.ts`);
// pi-ai는 coding-agent의 형제 패키지다(전역 설치·isolated 사본 모두 같은 상대 위치).
const PI_AI = join(CORE, "..", "..", "pi-ai", "src").replace(/\\/g, "/");
const { AuthStorage } = await import(`${PI_AI}/auth-storage.ts`);
const { streamAnthropic } = await import(`${PI_AI}/providers/anthropic.ts`);

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

const workdir = mkdtempSync(join(tmpdir(), "omp-thinking-binding-"));
const auth = await AuthStorage.create(join(workdir, "auth.db"));
const settings = createSettingsTestScope(() => undefined) as never;
const offline = (async () => new Response("offline", { status: 503 })) as never;
const registry = (name: string, yml: string) => {
	const file = join(workdir, `${name}.yml`);
	writeFileSync(file, yml, "utf8");
	return new ModelRegistry(auth, file, { cacheDbPath: join(workdir, `${name}.db`), fetch: offline, settings });
};
const thinking = ["        thinking:", "          mode: anthropic-adaptive", "          efforts: [low, medium, high, xhigh]", "          supportsDisplay: true"];
// 미러 models.yml과 같은 모양: thinking ladder만 좁힌다. binding controls는 core catalog가 켜야 한다.
const overridden = registry(
	"overridden",
	[
		"providers:",
		"  anthropic:",
		"    modelOverrides:",
		"      claude-opus-5-5:",
		...thinking,
		"      claude-sonnet-5-5:",
		...thinking,
		"      claude-opus-5:",
		...thinking,
		"",
	].join("\n"),
);
const plain = registry("plain", "providers: {}\n");
const opus55 = overridden.find("anthropic", "claude-opus-5-5");

check("[0] override가 있는 Opus 5.5는 prefixBinding을 유지한다", opus55?.thinking?.prefixBinding === true, JSON.stringify(opus55?.thinking));
check("[1] override가 없는 Opus 5.5도 prefixBinding이다", plain.find("anthropic", "claude-opus-5-5")?.thinking?.prefixBinding === true);
check("[2] Sonnet 5.5 thinking override도 prefixBinding을 지우지 않는다", overridden.find("anthropic", "claude-sonnet-5-5")?.thinking?.prefixBinding === true);
check("[3] prefix 검사를 하지 않는 Opus 5는 prefixBinding이 아니다", overridden.find("anthropic", "claude-opus-5")?.thinking?.prefixBinding !== true);

// 실제 요청 builder가 싣는 thinking·beta를 본다. mock은 첫 요청만 기록하고 400으로 끝낸다.
type Captured = { beta: string; thinking: { block_binding?: { prefix_mismatch_behavior?: string } } };
async function captureRequest(model: typeof opus55): Promise<Captured | undefined> {
	let captured: Captured | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { thinking: Captured["thinking"] };
			captured ??= { beta: req.headers.get("anthropic-beta") ?? "", thinking: body.thinking };
			return Response.json({ type: "error", error: { type: "invalid_request_error", message: "fixture" } }, { status: 400 });
		},
	});
	try {
		// 더미 키(비밀 아님). loopback mock 전용이다.
		const stream = streamAnthropic(
			{ ...model, baseUrl: `http://127.0.0.1:${server.port}` },
			{ messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] },
			{ apiKey: "sk-ant-api03-fixture", thinkingEnabled: true, maxRetries: 0 },
		);
		for await (const _event of stream) {
			// 끝까지 소비해야 요청이 나간다.
		}
	} finally {
		server.stop(true);
	}
	return captured;
}
const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const opusRequest = await captureRequest(opus55);
check(
	"[4] Opus 5.5 요청은 drop_block과 thinking-binding-controls beta를 보낸다",
	opusRequest?.thinking.block_binding?.prefix_mismatch_behavior === "drop_block" &&
		opusRequest.beta.split(",").includes(BINDING_BETA),
	JSON.stringify(opusRequest),
);

// binding controls의 provider 범위는 그 버전 upstream Sonnet 5.5 규칙과 같다. 18.4.5 upstream은 Vertex가
// `thinking.adaptive.block_binding`을 400으로 거절해 Sonnet 규칙에서 Vertex를 뺐다. 구워진 models.json 행과 규칙으로
// 새로 만든 모델(discovery 경로 buildModel)이 같은 답을 내야 하고, Vertex 요청에는 binding controls가 없어야 한다.
const PI_CATALOG = join(CORE, "..", "..", "pi-catalog", "src").replace(/\\/g, "/");
const { buildModel } = await import(`${PI_CATALOG}/build.ts`);
const ruleBuilt = (provider: string, baseUrl: string) =>
	buildModel({
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	}) as typeof opus55;
const sonnetRule = (provider: string) =>
	buildModel({ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", api: "anthropic-messages", provider, baseUrl: "https://example.invalid", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }) as typeof opus55;
const bakedAnthropic = plain.find("anthropic", "claude-opus-5-5");
const ruleAnthropic = ruleBuilt("anthropic", "https://api.anthropic.com");
check(
	"[5] Claude API Opus 5.5: 구워진 행과 규칙 생성 모델이 prefixBinding·binding controls 모두 켜짐으로 같다",
	bakedAnthropic?.thinking?.prefixBinding === true &&
		bakedAnthropic.compat.supportsThinkingBindingControls === true &&
		ruleAnthropic.thinking?.prefixBinding === true &&
		ruleAnthropic.compat.supportsThinkingBindingControls === true,
	JSON.stringify({ baked: [bakedAnthropic?.thinking?.prefixBinding, bakedAnthropic?.compat.supportsThinkingBindingControls], rule: [ruleAnthropic.thinking?.prefixBinding, ruleAnthropic.compat.supportsThinkingBindingControls] }),
);
const ruleCloudflare = ruleBuilt("cloudflare-ai-gateway", "https://gateway.ai.cloudflare.com/v1/fixture/fixture/anthropic");
check(
	"[6] Opus 5.5 binding controls 범위는 이 버전 Sonnet 5.5 규칙과 provider마다 같다(Claude API·Cloudflare·Vertex)",
	["anthropic", "cloudflare-ai-gateway", "google-vertex"].every(
		provider => ruleBuilt(provider, "https://example.invalid").compat.supportsThinkingBindingControls === sonnetRule(provider).compat.supportsThinkingBindingControls,
	) && ruleCloudflare.compat.supportsThinkingBindingControls === true,
	JSON.stringify(["anthropic", "cloudflare-ai-gateway", "google-vertex"].map(provider => [provider, ruleBuilt(provider, "https://example.invalid").compat.supportsThinkingBindingControls, sonnetRule(provider).compat.supportsThinkingBindingControls])),
);
const bakedVertex = plain.find("google-vertex", "claude-opus-5-5@default");
const ruleVertex = ruleBuilt("google-vertex", "https://us-east5-aiplatform.googleapis.com");
for (const [label, model] of [["구워진 행", bakedVertex], ["규칙 생성", ruleVertex]] as const) {
	const request = model ? await captureRequest(model) : undefined;
	check(
		`[7] Vertex Opus 5.5(${label}) 요청에는 block_binding·binding beta가 없다`,
		model?.compat.supportsThinkingBindingControls !== true &&
			request !== undefined &&
			request.thinking?.block_binding === undefined &&
			!request.beta.split(",").includes(BINDING_BETA),
		JSON.stringify({ found: model !== undefined, binding: model?.compat.supportsThinkingBindingControls, request }),
	);
}

// Windows는 열린 sqlite 핸들이 남아 있으면 임시 폴더 삭제가 EBUSY로 실패한다. 검증 결과와 무관한 정리다.
try {
	rmSync(workdir, { recursive: true, force: true });
} catch {}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
