// 재시작 뒤 부활하는 child 의 taskDepth 회귀. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-revive-depth-test.ts
// 미패치 core 에서는 depth 계산 함수가 없어 케이스가 실행되지 못하고 실패(RED)한다. 패치 core 에서는 top-level 별칭(`Main#3`)이
// parent 여도 literal `Main` 직속 child 와 같은 depth 를 낸다. 실제 AgentRegistry 만 쓰고 모델·설치본·프로필은 건드리지 않는다.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live core");
const CORE = resolve(target, "src").replace(/\\/g, "/");
if (!existsSync(join(CORE, "task/persisted-revive.ts"))) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
const { AgentRegistry } = await import(`${CORE}/registry/agent-registry.ts`);
const { revivedTaskDepth: depth } = await import(`${CORE}/task/persisted-revive.ts`);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name}`);
	}
}

const registry = new AgentRegistry();
const add = (id: string, kind: "main" | "sub", parentId?: string) =>
	registry.register({ id, displayName: id, kind, parentId, session: null, status: kind === "main" ? "idle" : "parked" });
add("Main", "main");
add("Main#3", "main");
add("Maker", "sub", "Main#3");
add("Nested", "sub", "Maker");
add("Cycle1", "sub", "Cycle2");
add("Cycle2", "sub", "Cycle1");

check("literal Main 직속 child 는 depth 1", depth({ parentId: "Main" }, registry) === 1);
check("부모가 없는 ref 는 depth 1", depth({}, registry) === 1);
check("Main#3 직속 child 도 depth 1(registry 의 실제 parent 를 그대로 쓴다)", depth({ parentId: "Main#3" }, registry) === 1);
check("깊은 child 는 단계 수만큼 센다(Main#3 > Maker > Nested)", depth({ parentId: "Maker" }, registry) === 2);
check("registry 에 없는 parent 는 기존처럼 한 단계로 센다", depth({ parentId: "Gone" }, registry) === 2);
check("순환 parent 는 끝난다", depth({ parentId: "Cycle1" }, registry) === 3);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
