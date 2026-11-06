// subagent worker thread 배치 회귀(18.17+). CUELO `omp` 래퍼(Tools/CUELO_Setup/wsl/bin/omp)는 패치된 src/cli.ts를 실행해
// worker host가 되지만, CUELO core 패치는 worker 쪽 RPC 대역(registry rootOf, session hasPendingAsyncWork, MCP 상태,
// IRC send 옵션)이 없어 worker에서 깨진다. 그래서 기본은 18.16처럼 모든 subagent를 main thread에 두고, 명시 설정만
// upstream worker 배치를 켠다.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-worker-threads-test.ts
// 미패치 18.17 core는 기본값 4라 [1]이 실패(RED)한다. worker 설정이 없는 core(18.16 이하)는 건너뛴다.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createSettingsTestScope } from "./core-test-settings";

const core = process.env.OMP_CORE_PATCH_TARGET;
if (!core) throw new Error("OMP_CORE_PATCH_TARGET 이 필요하다");
const workerModule = join(core, "src/thread/subagent-worker.ts");
if (!existsSync(workerModule)) {
	console.log("subagent worker thread가 없는 core: 건너뜀");
	process.exit(0);
}
const { declareWorkerHostEntry, workerHostEntry } = await import(join(core, "..", "pi-utils/src/worker-host.ts"));
const { subagentWorkerPool } = await import(workerModule);

let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` ${detail}`}`);
	if (!cond) fail++;
}

// 래퍼처럼 이 프로세스를 CLI worker host로 선언한다.
declareWorkerHostEntry();
check("[0] worker host가 선언됐다", workerHostEntry() !== null);

const defaults = createSettingsTestScope(() => undefined);
check("[1] 설정이 없으면 worker pool이 없어 subagent가 main thread에 머문다", subagentWorkerPool(defaults as never) === undefined);

const optIn = createSettingsTestScope(key => (key === "task.workerThreads" ? 4 : undefined));
const pool = subagentWorkerPool(optIn as never);
check("[2] task.workerThreads를 명시하면 upstream worker pool이 켜진다", pool !== undefined);
pool?.dispose();

console.log(fail === 0 ? "\n전부 PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
