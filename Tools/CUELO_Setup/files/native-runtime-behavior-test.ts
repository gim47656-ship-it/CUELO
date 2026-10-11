// CUELO native runtime 행동 테스트: 한 프로세스의 여러 top-level 세션이 각자 async job manager를 갖는 계약.
// 실행(runtime-transaction.ps1이 stage 코어에 대해 자동 실행한다):
//   $env:OMP_CORE_PATCH_TARGET = '<stage cuelo>\node_modules\@oh-my-pi\pi-coding-agent'
//   bun run files/native-runtime-behavior-test.ts
//
// core 18.8.9까지는 native-runtime-patch.js가 sdk.ts를 고쳐 이 계약을 만들었고, core 18.9.0(#15229)부터는
// upstream이 같은 계약을 직접 준다(native-runtime-patch.js는 그 줄의 존재만 확인한다). 그래서 여기서는 실제
// createAgentSession()으로 세션을 세우고 실제 dispose로 정리하며 네 가지 계약을 행동으로 본다. 모델 호출은
// 하지 않는다(prompt 없음, MCP·LSP·extension 탐색 끔). 프로필·세션 파일은 임시 HOME 아래에만 생긴다.
//   [1] 두 번째 top-level 세션도 자기 async manager를 가진다(sync fallback 없음).
//   [2] 첫 세션(A)이 dispose되어도 B의 manager와 job은 살아 있고 등록도 계속된다.
//   [3] B의 자식(과 손자)은 부모가 넘긴 B의 manager를 쓰고, 자식 dispose가 그 manager를 닫지 않는다.
//   [4] 첫 process singleton은 뒤에 만든 top-level이 덮어쓰지 않고, owner dispose 때 비워진다.
// 18.9.1 의미 변화(의도된 것): 부모 manager를 받지 않은 자식은 manager가 없다(18.8.9 CUELO 패치는 singleton
// 으로 폴백했다). core·CUELO 어디에도 그렇게 자식을 만드는 호출 자리는 없다.
//
// 동적 import 예외: 정적 import는 `@oh-my-pi/pi-coding-agent`를 bun 전역 캐시의 미패치
// 사본으로 해석한다. CUELO이 실제로 적재하는 사본만 검증해야 하므로 디스크 경로를 고정한다.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function resolveCore(): string {
	const argIndex = process.argv.indexOf("--target");
	const target = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.OMP_CORE_PATCH_TARGET;
	if (!target) throw new Error("--target <pi-coding-agent dir> 또는 OMP_CORE_PATCH_TARGET이 필요하다");
	if (!existsSync(join(target, "src/sdk.ts"))) throw new Error(`pi-coding-agent 소스가 없다: ${target}`);
	// 동적 import는 URL로 해석되므로 역슬래시를 쓰면 안 된다.
	return join(target, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();

// SDK는 첫 프로필 아래에 프로세스 전역 저장소를 연다. 사용자 HOME을 건드리지 않도록 임시 HOME으로 자신을
// 다시 띄우고, 끝나면 OS가 핸들을 놓은 뒤 부모가 그 트리를 지운다(Windows 파일 잠금).
const WORKER = "--behavior-worker";
if (!process.argv.includes(WORKER)) {
	const root = mkdtempSync(join(tmpdir(), "cuelo-native-behavior-"));
	let exitCode = 1;
	try {
		const home = join(root, "home");
		mkdirSync(home);
		exitCode = Bun.spawnSync([process.execPath, ...process.execArgv, import.meta.path, ...process.argv.slice(2), WORKER, root], {
			env: { ...process.env, HOME: home, USERPROFILE: home, OMP_CORE_PATCH_TARGET: join(CORE, "..") },
			stdout: "inherit",
			stderr: "inherit",
		}).exitCode;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	process.exit(exitCode);
}
const fixtureRoot = process.argv[process.argv.indexOf(WORKER) + 1]!;

console.log(`대상 ${CORE}`);
const { AsyncJobManager } = await import(`${CORE}/async/job-manager.ts`);
const { AgentRegistry } = await import(`${CORE}/registry/agent-registry.ts`);
const { createAgentSession } = await import(`${CORE}/sdk.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
const { getBundledModel } = await import(`${CORE}/../../pi-catalog/src/models.ts`);
const { closeModelCache } = await import(`${CORE}/../../pi-catalog/src/model-cache.ts`);
const { initThemeSync } = await import(`${CORE}/../../pi-tui/src/theme/theme.ts`);
initThemeSync();

type Manager = InstanceType<typeof AsyncJobManager>;
type Session = { asyncJobManager: Manager | undefined; isDisposed: boolean; dispose(): Promise<void> };

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

const cwd = join(fixtureRoot, "work");
const profile = join(fixtureRoot, "profile");
mkdirSync(cwd);
mkdirSync(profile);
// 연결되지 않는 주소: 세션 생성은 모델을 부르지 않으며, 부르면 즉시 실패한다.
writeFileSync(
	join(profile, "models.yml"),
	"providers:\n  behavior-fixture:\n    baseUrl: http://127.0.0.1:9\n    api: anthropic-messages\n    apiKey: example\n    models:\n      - id: claude-opus-5-5\n",
);
AgentRegistry.resetGlobalForTests();
AsyncJobManager.resetForTests();

const sessions: Session[] = [];
async function make(agentId: string, child?: { parentAgentId: string; asyncJobManager: Manager | undefined }): Promise<Session> {
	const { session } = await createAgentSession({
		model: { ...getBundledModel("anthropic", "claude-opus-5-5"), provider: "behavior-fixture", baseUrl: "http://127.0.0.1:9" },
		getApiKey: async () => "example",
		cwd,
		agentDir: profile,
		thinkingLevel: "off",
		disableExtensionDiscovery: true,
		settings: Settings.isolated({ "launch.enabled": false }),
		agentId,
		...(child
			? {
					parentTaskPrefix: agentId,
					parentAgentId: child.parentAgentId,
					taskDepth: 1,
					...(child.asyncJobManager ? { asyncJobManager: child.asyncJobManager } : {}),
				}
			: {}),
		enableLsp: false,
		enableMCP: false,
		skipPythonPreflight: true,
		toolNames: [],
		restrictToolNames: true,
		requireYieldTool: false,
	});
	sessions.push(session as Session);
	return session as Session;
}

try {
	console.log("\n[1] 두 번째 top-level 세션도 async manager를 가진다");
	const a = await make("Main");
	const b = await make("Main#2");
	const aManager = a.asyncJobManager;
	const bManager = b.asyncJobManager;
	check("A는 manager를 가진다", aManager !== undefined);
	check("B(secondary top-level)도 manager를 가진다(undefined → sync fallback 아님)", bManager !== undefined);
	check("A와 B의 manager는 서로 다른 인스턴스다", aManager !== bManager);

	console.log("\n[4] 첫 process singleton은 덮어쓰이지 않는다");
	check("singleton은 A의 manager다", AsyncJobManager.instance() === aManager);
	const c = await make("Main#3");
	check("C를 만들어도 singleton은 A 그대로다", AsyncJobManager.instance() === aManager, `instance is ${AsyncJobManager.instance() === c.asyncJobManager ? "C" : "other"}`);

	console.log("\n[3] 자식은 부모가 넘긴 manager를 쓰고 소유하지 않는다");
	const childB = await make("B-child", { parentAgentId: "Main#2", asyncJobManager: bManager });
	check("B의 자식은 B의 manager를 본다(singleton A가 아니다)", childB.asyncJobManager === bManager && childB.asyncJobManager !== AsyncJobManager.instance());
	const grandB = await make("B-grand", { parentAgentId: "B-child", asyncJobManager: childB.asyncJobManager });
	check("B의 손자도 B의 manager를 본다", grandB.asyncJobManager === bManager);
	const orphan = await make("orphan", { parentAgentId: "ghost", asyncJobManager: undefined });
	check("부모 manager를 받지 않은 자식은 manager가 없다(18.9.1 upstream 의미)", orphan.asyncJobManager === undefined);
	await grandB.dispose();
	await childB.dispose();
	await orphan.dispose();
	check("자식 dispose 뒤에도 B의 manager는 열려 있다", bManager !== undefined && bManager.atCapacity === false && !b.isDisposed);

	console.log("\n[2] A dispose 뒤에도 B의 manager와 job은 정상이다");
	let releaseJob!: () => void;
	const gate = new Promise<void>(resolveGate => {
		releaseJob = resolveGate;
	});
	const delivered: string[] = [];
	// B 세션 자신의 sink(agentId)가 아니라 테스트 owner의 sink로 받는다: 결과가 B 대화에 follow-up으로 들어가
	// 모델 호출을 일으키지 않게 한다.
	const unregisterSink = bManager!.registerDeliverySink("behavior-owner", async (_jobId: string, text: string) => {
		delivered.push(text);
	});
	const bJobId = bManager!.register(
		"task",
		"B background task",
		async ({ signal }: { signal: AbortSignal }) => {
			await gate;
			if (signal.aborted) throw new Error("aborted");
			return "B-RESULT";
		},
		{ ownerId: "behavior-owner" },
	);
	check("B의 job이 실행 중이다", bManager!.getJob(bJobId)?.status === "running");

	await a.dispose();
	let sharedRegisterError = "";
	try {
		aManager!.register("task", "would-be shared task", async () => "never", { ownerId: "behavior-owner" });
	} catch (error) {
		sharedRegisterError = error instanceof Error ? error.message : String(error);
	}
	check("disposed된 A manager는 register를 거부한다(첫 manager 공유안이 깨지는 지점)", /disposed/.test(sharedRegisterError), sharedRegisterError);
	check("A dispose 뒤 B의 job은 여전히 running이다", bManager!.getJob(bJobId)?.status === "running", `status=${bManager!.getJob(bJobId)?.status}`);
	releaseJob();
	await bManager!.getJob(bJobId)!.promise;
	check("B의 job은 취소되지 않고 완료된다", bManager!.getJob(bJobId)?.status === "completed", `status=${bManager!.getJob(bJobId)?.status}`);
	await bManager!.drainDeliveries({ timeoutMs: 1_000, filter: { ownerId: "behavior-owner" } });
	check("B의 결과는 그 owner의 delivery sink로만 전달된다", delivered.length === 1 && delivered[0] === "B-RESULT", JSON.stringify(delivered));
	try {
		const secondId = bManager!.register("task", "B second task", async () => "B-SECOND", { ownerId: "behavior-owner" });
		await bManager!.getJob(secondId)!.promise;
		check("A dispose 뒤 B는 새 job을 등록·완료할 수 있다", bManager!.getJob(secondId)?.status === "completed");
	} catch (error) {
		check("A dispose 뒤 B는 새 job을 등록·완료할 수 있다", false, error instanceof Error ? error.message : String(error));
	}
	check("B의 manager는 capacity가 남아 있다(disposed 아님)", bManager!.atCapacity === false);
	unregisterSink();

	console.log("\n[4b] owner가 singleton을 놓은 뒤 새 top-level이 이어받고 B는 영향이 없다");
	check("A dispose 뒤 singleton은 비어 있다", AsyncJobManager.instance() === undefined);
	const d = await make("Main#4");
	check("새 top-level D가 singleton을 채택한다", AsyncJobManager.instance() === d.asyncJobManager && d.asyncJobManager !== undefined);
	const lateB = await make("B-late", { parentAgentId: "Main#2", asyncJobManager: b.asyncJobManager });
	check("B의 자식은 여전히 B의 manager를 본다", lateB.asyncJobManager === bManager);
	const childD = await make("D-child", { parentAgentId: "Main#4", asyncJobManager: d.asyncJobManager });
	check("D의 자식은 D의 manager를 본다", childD.asyncJobManager === d.asyncJobManager);
} catch (error) {
	check("시나리오가 예외 없이 끝난다", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
	for (const session of sessions.reverse()) {
		if (!session.isDisposed) await session.dispose().catch(() => {});
	}
	closeModelCache();
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.resetForTests();
}

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
