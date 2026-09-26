// CUELO native runtime 행동 테스트: sdk.ts session-scoped AsyncJobManager 패치.
// 실행(runtime-transaction.ps1이 stage 코어에 대해 자동 실행한다):
//   $env:OMP_CORE_PATCH_TARGET = '<stage cuelo>\node_modules\@oh-my-pi\pi-coding-agent'
//   bun run files/native-runtime-behavior-test.ts
//
// 검증 대상은 `resolveSessionAsyncJobManager()` 하나다. createAgentSession()은 모델·
// 자격증명 없이 세울 수 없으므로(OMP_Global_Config/patches/core-1811-regression-test.ts의
// 같은 판단) 패치가 그 결정을 export 헬퍼로 분리했고, 여기서는 실제 AsyncJobManager와
// AgentRegistry로 네 가지 계약을 행동으로 본다:
//   [1] 두 번째 top-level 세션도 자기 async manager를 가진다(sync fallback 없음).
//   [2] 첫 세션(A)이 dispose되어도 B의 manager와 job은 살아 있고 등록도 계속된다.
//   [3] B의 자식(과 손자)은 singleton이 아니라 B의 manager를 상속한다.
//   [4] 첫 process singleton은 뒤에 만든 top-level이 덮어쓰지 않는다.
//
// 동적 import 예외: 정적 import는 `@oh-my-pi/pi-coding-agent`를 bun 전역 캐시의 미패치
// 사본으로 해석한다. CUELO이 실제로 적재하는 사본만 검증해야 하므로 디스크 경로를 고정한다.
import { existsSync } from "node:fs";
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
console.log(`대상 ${CORE}`);
const { AsyncJobManager } = await import(`${CORE}/async/job-manager.ts`);
const { AgentRegistry } = await import(`${CORE}/registry/agent-registry.ts`);
const sdk = await import(`${CORE}/sdk.ts`);
const resolve = sdk.resolveSessionAsyncJobManager as (
	options: { parentTaskPrefix?: string; parentAgentId?: string },
	agentRegistry: InstanceType<typeof AgentRegistry>,
	maxRunningJobs: number,
) => { owned: InstanceType<typeof AsyncJobManager> | undefined; scoped: InstanceType<typeof AsyncJobManager> | undefined };

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

// AgentRef.session 자리에 들어가는 최소 세션: 헬퍼는 `.asyncJobManager`만 읽는다.
const sessionWith = (manager: unknown) => ({ asyncJobManager: manager }) as never;

check("패치가 resolveSessionAsyncJobManager를 export한다", typeof resolve === "function");
if (typeof resolve !== "function") {
	console.log(`\n결과: ${pass} pass, ${fail} fail`);
	process.exit(1);
}

const registry = new AgentRegistry();
AsyncJobManager.resetForTests();

console.log("\n[1] 두 번째 top-level 세션도 async manager를 가진다");
const a = resolve({}, registry, 4);
const b = resolve({}, registry, 4);
check("A는 manager를 소유한다", a.owned !== undefined);
check("A의 scoped는 자기 owned다", a.scoped === a.owned);
check("B(secondary top-level)도 manager를 소유한다", b.owned !== undefined);
check("B의 scoped는 자기 owned다(undefined → sync fallback 아님)", b.scoped === b.owned && b.scoped !== undefined);
check("A와 B의 manager는 서로 다른 인스턴스다", a.owned !== b.owned);

console.log("\n[4] 첫 process singleton은 덮어쓰이지 않는다");
check("singleton은 A의 manager다", AsyncJobManager.instance() === a.owned);
const c = resolve({}, registry, 4);
check("C를 만들어도 singleton은 A 그대로다", AsyncJobManager.instance() === a.owned, `instance is ${AsyncJobManager.instance() === c.owned ? "C" : "other"}`);

console.log("\n[3] 자식은 부모 세션의 manager를 상속한다");
registry.register({ id: "Main", displayName: "main", kind: "main", session: sessionWith(a.owned) });
registry.register({ id: "Main#2", displayName: "main", kind: "main", session: sessionWith(b.owned) });
const childA = resolve({ parentTaskPrefix: "A-child", parentAgentId: "Main" }, registry, 4);
const childB = resolve({ parentTaskPrefix: "B-child", parentAgentId: "Main#2" }, registry, 4);
check("자식은 manager를 소유하지 않는다", childA.owned === undefined && childB.owned === undefined);
check("A의 자식은 A의 manager를 본다", childA.scoped === a.owned);
check("B의 자식은 B의 manager를 본다(singleton A가 아니다)", childB.scoped === b.owned && childB.scoped !== AsyncJobManager.instance());
registry.register({ id: "B-child", displayName: "sub", kind: "sub", parentId: "Main#2", session: sessionWith(childB.scoped) });
const grandB = resolve({ parentTaskPrefix: "B-grand", parentAgentId: "B-child" }, registry, 4);
check("B의 손자도 B의 manager를 본다", grandB.scoped === b.owned);
const orphan = resolve({ parentTaskPrefix: "orphan", parentAgentId: "ghost" }, registry, 4);
check("부모 ref가 없는 자식은 singleton으로 폴백한다", orphan.scoped === AsyncJobManager.instance());
registry.register({ id: "Parked", displayName: "main", kind: "main", session: null, status: "parked" });
const revived = resolve({ parentTaskPrefix: "revived", parentAgentId: "Parked" }, registry, 4);
check("부모 세션이 detached(null)면 singleton으로 폴백한다", revived.scoped === AsyncJobManager.instance());
const noParent = resolve({ parentTaskPrefix: "no-parent" }, registry, 4);
check("parentAgentId가 없는 자식은 singleton으로 폴백한다", noParent.scoped === AsyncJobManager.instance());

console.log("\n[2] A dispose 뒤에도 B의 manager와 job은 정상이다");
const bManager = b.owned!;
const aManager = a.owned!;
let releaseJob!: () => void;
const gate = new Promise<void>(resolveGate => {
	releaseJob = resolveGate;
});
const delivered: string[] = [];
const unregisterSink = bManager.registerDeliverySink("Main#2", async (_jobId: string, text: string) => {
	delivered.push(text);
});
const bJobId = bManager.register(
	"task",
	"B background task",
	async ({ signal }: { signal: AbortSignal }) => {
		await gate;
		if (signal.aborted) throw new Error("aborted");
		return "B-RESULT";
	},
	{ ownerId: "Main#2" },
);
check("B의 job이 실행 중이다", bManager.getJob(bJobId)?.status === "running");

// AgentSession.#disposeOwnedAsyncJobs가 owning 세션 A에서 하는 일: 자기 manager dispose,
// singleton이 자기 것이면 해제. B는 자기 manager를 소유하므로 여기에 걸리지 않아야 한다.
await aManager.dispose({ timeoutMs: 200 });
if (AsyncJobManager.instance() === aManager) AsyncJobManager.setInstance(undefined);
let sharedRegisterError = "";
try {
	aManager.register("task", "would-be shared task", async () => "never", { ownerId: "Main#2" });
} catch (error) {
	sharedRegisterError = error instanceof Error ? error.message : String(error);
}
check("disposed된 A manager는 register를 거부한다(첫 manager 공유안이 깨지는 지점)", /disposed/.test(sharedRegisterError), sharedRegisterError);
check("A dispose 뒤 B의 job은 여전히 running이다", bManager.getJob(bJobId)?.status === "running", `status=${bManager.getJob(bJobId)?.status}`);
releaseJob();
await bManager.getJob(bJobId)!.promise;
check("B의 job은 취소되지 않고 완료된다", bManager.getJob(bJobId)?.status === "completed", `status=${bManager.getJob(bJobId)?.status}`);
await bManager.drainDeliveries({ timeoutMs: 1_000, filter: { ownerId: "Main#2" } });
check("B의 결과는 B의 delivery sink로만 전달된다", delivered.length === 1 && delivered[0] === "B-RESULT", JSON.stringify(delivered));
let secondRegisterError = "";
try {
	const secondId = bManager.register("task", "B second task", async () => "B-SECOND", { ownerId: "Main#2" });
	await bManager.getJob(secondId)!.promise;
	check("A dispose 뒤 B는 새 job을 등록·완료할 수 있다", bManager.getJob(secondId)?.status === "completed");
} catch (error) {
	secondRegisterError = error instanceof Error ? error.message : String(error);
	check("A dispose 뒤 B는 새 job을 등록·완료할 수 있다", false, secondRegisterError);
}
check("B의 manager는 capacity가 남아 있다(disposed 아님)", bManager.atCapacity === false);
unregisterSink();

console.log("\n[4b] owner가 singleton을 놓은 뒤 새 top-level이 이어받고 B는 영향이 없다");
check("A dispose 뒤 singleton은 비어 있다", AsyncJobManager.instance() === undefined);
const d = resolve({}, registry, 4);
check("새 top-level D가 singleton을 채택한다", AsyncJobManager.instance() === d.owned);
check("B의 자식은 여전히 B의 manager를 본다", resolve({ parentTaskPrefix: "B-late", parentAgentId: "Main#2" }, registry, 4).scoped === b.owned);
check("D의 자식은 D의 manager를 본다", (() => {
	registry.register({ id: "Main#3", displayName: "main", kind: "main", session: sessionWith(d.owned) });
	return resolve({ parentTaskPrefix: "D-child", parentAgentId: "Main#3" }, registry, 4).scoped === d.owned;
})());

for (const manager of [bManager, c.owned!, d.owned!]) await manager.dispose({ timeoutMs: 200 });
AsyncJobManager.resetForTests();

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
