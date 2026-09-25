// Native task effort와 Astra configuration_update의 실제 요청 직렬화 회귀.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-agent-thinking-test.ts
// 대상 설치/격리 사본의 모듈 로딩 경계가 검사 대상이므로 runtime-selected path로 import한다.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
const candidates = process.env.OMP_CORE_PATCH_TARGET
	? [process.env.OMP_CORE_PATCH_TARGET]
	: [join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
const core = candidates.find(candidate => existsSync(join(candidate, "src/task/executor.ts")));
if (!core) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
const packages = resolve(core, "..").replace(/\\/g, "/");
const { resolveTaskEffortLevel } = await import(`${packages}/pi-tui/src/thinking.ts`);
const { getBundledModels } = await import(`${packages}/pi-catalog/src/models.ts`);
const { buildTransformedCodexRequestBody } = await import(`${packages}/pi-ai/src/providers/openai-codex-responses.ts`);

// Devin OAuth discovery에서 관측한 SWE-2의 지원 ladder. 별도 auto-floor patch는 필요 없다.
const swe2 = {
	provider: "devin", id: "swe-2", reasoning: true,
	thinking: { mode: "effort", efforts: ["medium", "high", "max"], defaultLevel: "medium" },
};
assert.deepEqual(["lo", "med", "hi"].map(hint => resolveTaskEffortLevel(swe2, hint, "max")), ["medium", "high", "max"]);
assert.equal(resolveTaskEffortLevel(swe2, "hi", "high"), "high");
console.log("  PASS  native task lo/med/hi는 SWE-2 medium/high/max이며 ceiling을 지킨다");

const astra = getBundledModels("openai-codex").find(model => model.id === "gpt-6-astra");
assert.ok(astra, "bundled Astra 모델이 필요하다");
assert.equal(astra.compat.supportsConfigurationUpdate, true);
const providerSessionState = new Map();
const sessionId = "your-astra-cache-regression";
const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
const messages = [user("첫 번째 요청", 1)];
const body = (reasoning: string, id = sessionId, input = messages) => buildTransformedCodexRequestBody(
	astra, { systemPrompt: "동일한 시스템 지시", messages: input },
	{ reasoning, sessionId: id, providerSessionState }, id,
);
const first = await body("low");
messages.push(user("두 번째 요청", 2));
const high = await body("high");
assert.equal(high.reasoning.effort, first.reasoning.effort);
assert.equal(high.instructions, first.instructions);
assert.equal(high.prompt_cache_key, first.prompt_cache_key);
assert.deepEqual(high.input.slice(0, first.input.length), first.input);
assert.deepEqual(high.input.at(-2), { type: "configuration_update", reasoning: { effort: "high" } });
assert.deepEqual(await body("high"), high, "같은 요청 재시도는 update를 중복 삽입하지 않는다");
console.log("  PASS  Astra low→high에서 request effort·기존 prefix는 그대로이고 변경만 뒤에 붙는다");

messages.push(user("세 번째 요청", 3));
const medium = await body("medium");
assert.equal(medium.reasoning.effort, first.reasoning.effort);
assert.deepEqual(medium.input.slice(0, high.input.length), high.input);
assert.deepEqual(medium.input.at(-2), { type: "configuration_update", reasoning: { effort: "medium" } });
const independent = await body("high", "another-session");
assert.equal(independent.reasoning.effort, "high");
assert.equal(independent.input.some(item => item.type === "configuration_update"), false);
console.log("  PASS  후속 변경은 기존 update 위치를 보존하며 다른 세션으로 baseline이 새지 않는다");

const compacted = await body("medium", sessionId, [user("압축 후 새 이력", 4)]);
assert.equal(compacted.reasoning.effort, "medium");
assert.equal(compacted.input.some(item => item.type === "configuration_update"), false);
console.log("  PASS  짧아진 이력에서는 이전 update를 버리고 새 baseline을 잡는다");
console.log("결과 4 pass");
