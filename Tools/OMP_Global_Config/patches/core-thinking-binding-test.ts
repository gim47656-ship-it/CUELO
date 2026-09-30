// Opus 5.5 preserved-thinking prefix binding 회귀. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-thinking-binding-test.ts
// 공식 문서(platform.claude.com/docs/en/build-with-claude/preserved-thinking)상 Opus 5.5도 thinking 서명을 앞선
// system·tools·messages에 묶는다. 미패치 core에서는 [0]·[1]·[2]·[4]가 FAIL(RED)이다: catalog가 Opus 5.5의
// prefixBinding을 빠뜨리고, modelOverrides의 thinking이 규칙이 채운 prefixBinding을 통째로 덮어써서 Sonnet 5.5도
// 잃는다. 그러면 prefix가 바뀐 요청이 drop_block 없이 나가 신규 계정에서 400이 된다. 패치 core에서는 전부 PASS다.
// 실제 ModelRegistry와 Anthropic 요청 builder를 쓰고, 요청은 loopback mock이 받는다. 네트워크·`~/.omp` 접근 없음.
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

// 실제 요청 builder가 Opus 5.5에 drop_block과 binding beta를 싣는지 본다. mock은 첫 요청만 기록하고 400으로 끝낸다.
let captured: { beta: string; thinking: { block_binding?: { prefix_mismatch_behavior?: string } } } | undefined;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		const body = (await req.json()) as { thinking: { block_binding?: { prefix_mismatch_behavior?: string } } };
		captured ??= { beta: req.headers.get("anthropic-beta") ?? "", thinking: body.thinking };
		return Response.json({ type: "error", error: { type: "invalid_request_error", message: "fixture" } }, { status: 400 });
	},
});
try {
	// 더미 키(비밀 아님). loopback mock 전용이다.
	const stream = streamAnthropic(
		{ ...opus55, baseUrl: `http://127.0.0.1:${server.port}` },
		{ messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] },
		{ apiKey: "sk-ant-api03-fixture", thinkingEnabled: true, maxRetries: 0 },
	);
	for await (const _event of stream) {
		// 끝까지 소비해야 요청이 나간다.
	}
} finally {
	server.stop(true);
}
check(
	"[4] Opus 5.5 요청은 drop_block과 thinking-binding-controls beta를 보낸다",
	captured?.thinking.block_binding?.prefix_mismatch_behavior === "drop_block" &&
		captured.beta.split(",").includes("thinking-binding-controls-2026-08-01"),
	JSON.stringify(captured),
);

// Windows는 열린 sqlite 핸들이 남아 있으면 임시 폴더 삭제가 EBUSY로 실패한다. 검증 결과와 무관한 정리다.
try {
	rmSync(workdir, { recursive: true, force: true });
} catch {}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
