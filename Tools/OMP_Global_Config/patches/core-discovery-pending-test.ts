// 조회 provider의 "조회 중" 판정 회귀. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-discovery-pending-test.ts
// 미패치 core에서는 [3]이 FAIL(RED) — 조회 캐시의 모든 모델이 복원 불가 헤더로 걸러져 시작 상태가
// `cached`·모델 0개인데도 조회 중으로 보지 않아, 시작 시 fallback 체인 검사가 곧 온라인 조회가
// 채울 모델을 unknown model로 경고한다(2026-09-29 b-ai 실측). 패치 core에서는 전부 PASS(GREEN)다.
// 실제 ModelRegistry 두 개를 같은 scratch models.db로 띄운다: 첫째가 mock `/v1/models` 조회로 캐시를
// 쓰고, 둘째(다음 시작)가 그 캐시로 만든 상태를 본다. 실제 네트워크·`~/.omp` 접근 없음.
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
const { AuthStorage } = await import(join(CORE, "..", "..", "pi-ai", "src", "auth-storage.ts").replace(/\\/g, "/"));

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

// HEADERED는 설정 apiKey만 있고 authHeader가 없어 조회 모델이 복원 불가 헤더로 캐시된다(b-ai와 같은
// 조건). RESTORABLE은 authHeader: true라 헤더를 다시 만들 수 있어 캐시에서 복원된다(진짜 unknown
// 경고를 숨기지 않는 경계).
const HEADERED = "fixture-headered";
const RESTORABLE = "fixture-restorable";
const MISSING = "fixture-nocache";

const workdir = mkdtempSync(join(tmpdir(), "omp-discovery-pending-"));
const auth = await AuthStorage.create(join(workdir, "auth.db"));
const modelsYml = join(workdir, "models.yml");
const cacheDb = join(workdir, "models.db");
// 더미 키(비밀 아님). mock fetch 전용이며 네트워크에 나가지 않는다.
const provider = (name: string, authHeader: boolean) => [
	`  ${name}:`,
	"    baseUrl: http://127.0.0.1:9/v1",
	"    api: openai-completions",
	'    apiKey: "example"',
	...(authHeader ? ["    authHeader: true"] : []),
	"    discovery:",
	"      type: openai-models-list",
];
writeFileSync(modelsYml, ["providers:", ...provider(HEADERED, false), ...provider(RESTORABLE, true), ""].join("\n"), "utf8");
const listing = { data: [{ id: "probe-model", object: "model" }] };
const mockFetch = (async () =>
	new Response(JSON.stringify(listing), { status: 200, headers: { "content-type": "application/json" } })) as never;
const settings = createSettingsTestScope(() => undefined) as never;
const open = () => new ModelRegistry(auth, modelsYml, { cacheDbPath: cacheDb, fetch: mockFetch, settings });

const seeded = open();
await seeded.refresh("online");
check("[0] 온라인 조회는 두 provider 모델을 모두 채운다", seeded.find(HEADERED, "probe-model") !== undefined && seeded.find(RESTORABLE, "probe-model") !== undefined);

// 다음 시작: 같은 캐시로 새 레지스트리를 만든다(온라인 조회 전 상태).
const restarted = open();
const headeredState = restarted.getProviderDiscoveryState(HEADERED);
check("[1] 복원 불가 헤더 모델은 시작 카탈로그에 없다", restarted.find(HEADERED, "probe-model") === undefined);
check(
	"[2] 그 provider 상태는 cached·모델 0개",
	headeredState?.status === "cached" && headeredState.models.length === 0,
	JSON.stringify(headeredState),
);
check("[3] 모델이 하나도 복원되지 않은 cached provider는 조회 중이다", restarted.isProviderDiscoveryPending(HEADERED) === true);
check("[4] 모델이 복원된 cached provider는 조회 중이 아니다", restarted.find(RESTORABLE, "probe-model") !== undefined && restarted.isProviderDiscoveryPending(RESTORABLE) === false);
check("[5] 선언되지 않은 provider는 조회 중이 아니다", restarted.isProviderDiscoveryPending(MISSING) === false);

// Windows는 열린 sqlite 핸들이 남아 있으면 임시 폴더 삭제가 EBUSY로 실패한다. 검증 결과와 무관한 정리다.
try {
	rmSync(workdir, { recursive: true, force: true });
} catch {}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
