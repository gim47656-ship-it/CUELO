// 교훈 자동 저장 알림의 LLM 문맥 제외 회귀. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-autolearn-notice-test.ts
// `[교훈 자동 저장]` 알림(customType `autolearn-saved`)은 사람이 보는 세션 기록이다. 미패치 core에서는 [0]이
// FAIL(RED)이다: 알림이 이후 모든 요청의 LLM 문맥에 user 메시지로 실려 대화를 계속 따라다녔다(2026-09-30 사용자
// 지적). 다른 custom 메시지는 그대로 문맥에 남아야 한다([1]). 실제 convertToLlm을 부른다. 네트워크·`~/.omp` 접근 없음.
// 동적 import 예외: core-bai-retry-test.ts와 같은 이유(지정한 사본만 검증).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 전역 npm 위치는 PC마다 다르다. apply-core-patch.mjs와 같은 순서로 찾는다. */
function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(p => existsSync(join(p, "src/session/messages.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	// 동적 import는 URL로 해석되므로 역슬래시를 쓰면 안 된다.
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const { convertToLlm } = await import(`${CORE}/session/messages.ts`);

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

const now = Date.now();
const custom = (customType: string, content: string) => ({ role: "custom", customType, content, display: true, attribution: "agent", timestamp: now });
const llm = convertToLlm([
	{ role: "user", content: "질문", attribution: "user", timestamp: now },
	custom("autolearn-saved", "[교훈 자동 저장] 1건\n- 교훈: fixture"),
	custom("fixture-notice", "다른 custom 메시지"),
]) as { content: unknown }[];
const text = JSON.stringify(llm);

check("[0] 교훈 자동 저장 알림은 LLM 문맥에 없다", !text.includes("[교훈 자동 저장]"), text);
check("[1] 다른 custom 메시지는 LLM 문맥에 남는다", text.includes("다른 custom 메시지"), text);

console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
