// 실행 중 사용자 steering·follow-up 이 auto 강도를 다시 판정하는지 실제 AgentSession 으로 본다.
//   bun run patches/core-steer-auto-thinking-test.ts (OMP_CORE_PATCH_TARGET 지정 시 그 사본)
//
// 2026-10-04 사용자 결정: auto 는 새 사용자 턴에서만 분류했기 때문에, 실행 중에 목표를 더해도 강도가 그대로였다.
// 이제 사용자가 보낸 steer·follow-up 은 이번 턴 요청에 이어 붙여 다시 판정하고, 같은 턴 안에서는 올리기만 한다.
// agent 가 넣은 메시지·synthetic 메시지·auto 가 아닌 세션은 그대로다.
//
// 분류기(judge)는 부르지 않는다. 입력에 ultrathink 가 있으면 auto 는 분류 없이 모델 최대 강도로 가므로, 그 값이
// 실제로 반영되는지로 "이 입력이 재판정을 일으켰는가"를 본다. 매 단계는 고정 low 로 턴을 시작해 턴 시작 분류도
// 건너뛰고, 스트리밍 중(before-model-call 훅)에 auto 로 바꾼 뒤 입력을 넣는다. 내림이 없다는 raise-only 계약은
// core-agent-thinking-test.ts [raise-only] 가 분류기 경로로 본다.
// 모델 호출은 하지 않는다: 훅이 provider 요청 직전에 예외로 turn 을 끊는다. 세션·모델 설정은 임시 cwd·agentDir 에만
// 쓰므로 운영자의 실제 `~/.omp` 는 읽지도 쓰지도 않는다.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	if (env) return join(env, "src").replace(/\\/g, "/");
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = [
		join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"),
		join(root, "@oh-my-pi/pi-coding-agent"),
	];
	const hit = candidates.find(p => existsSync(join(p, "src/registry/agent-registry.ts")));
	if (!hit) throw new Error(`CUELO 전역 설치를 찾지 못했다: ${candidates.join(", ")}`);
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`[env] core=${CORE}`);

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

const sdk = await import(`${CORE}/sdk.ts`); // 정적 import 불가: 대상 core 경로가 실행 시점에 정해진다.

const workdir = mkdtempSync(join(tmpdir(), "omp-steer-auto-session-"));
const agentDir = mkdtempSync(join(tmpdir(), "omp-steer-auto-agentdir-"));
// baseUrl 은 닫힌 포트이고 모델 호출은 훅이 그 직전에 끊는다. apiKey 는 더미다(비밀 아님).
const FIXTURE_PROVIDER = "fixture-steer";
const FIXTURE_MODEL_ID = "steer-auto";
writeFileSync(
	join(agentDir, "models.yml"),
	[
		"providers:",
		`  ${FIXTURE_PROVIDER}:`,
		"    baseUrl: http://127.0.0.1:9/v1",
		"    api: openai-completions",
		'    apiKey: "example"',
		"    models:",
		`      - id: ${FIXTURE_MODEL_ID}`,
		"        reasoning: true",
		"        thinking:",
		"          mode: effort",
		"          efforts: [low, medium, high, xhigh, max]",
		"          defaultLevel: medium",
		"",
	].join("\n"),
	"utf8",
);
writeFileSync(join(agentDir, "config.yml"), `modelRoles:\n  default: ${FIXTURE_PROVIDER}/${FIXTURE_MODEL_ID}\n`, "utf8");

const created = await sdk.createAgentSession({ cwd: workdir, agentDir, disableExtensionDiscovery: true });
const session = created.session;
const agent = session.agent;
const sessionModel = session.model as { provider?: string; id?: string } | undefined;
check(
	"세션 모델은 임시 agentDir 의 fixture 다",
	sessionModel?.provider === FIXTURE_PROVIDER && sessionModel?.id === FIXTURE_MODEL_ID,
	`model=${JSON.stringify(sessionModel)}`,
);

type Entry = { type: string; thinkingLevel?: string | null; configured?: string | null };
const autoMaxEntries = () =>
	(session.sessionManager.getEntries() as Entry[]).filter(
		e => e.type === "thinking_level_change" && e.configured === "auto" && e.thinkingLevel === "max",
	).length;
const levelEvents: string[] = [];
session.subscribe((event: { type: string; thinkingLevel?: string }) => {
	if (event.type === "thinking_level_changed" && event.thinkingLevel) levelEvents.push(event.thinkingLevel);
});
// 판정은 분류를 기다리지 않고 뒤에서 돈다. ultrathink 경로는 즉시 끝나지만 이벤트 루프를 한 번 넘긴다.
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 20));

type Phase = "steer" | "followUp" | "fixed" | "quiet";
let phase: Phase = "quiet";
const seen: Record<string, unknown> = {};

agent.addBeforeModelCallHook(async () => {
	const current = phase;
	phase = "quiet";
	if (current === "quiet") throw new Error("smoke: no provider call");
	seen[`${current}:streaming`] = session.isStreaming;
	if (current === "steer") {
		session.setThinkingLevel("auto");
		seen.provisional = session.thinkingLevel;
		const entriesBefore = autoMaxEntries();
		// IRC·Main 지시처럼 agent 가 넣은 steer 는 사용자 목표 추가가 아니다.
		await session.steer("ultrathink 하위 에이전트 보고", undefined, { attribution: "agent" });
		await flush();
		seen.afterAgentSteer = session.thinkingLevel;
		// CUELO 화면의 실행 중 입력과 같은 경로: prompt(..., { streamingBehavior: "steer" }).
		const eventsBefore = levelEvents.length;
		await session.prompt("ultrathink 범위도 같이 늘려", { streamingBehavior: "steer" });
		await flush();
		seen.afterUserSteer = session.thinkingLevel;
		seen.steerEntries = autoMaxEntries() - entriesBefore;
		seen.steerEvents = levelEvents.slice(eventsBefore);
		seen.steerQueued = JSON.stringify(agent.peekSteeringQueue()).includes("범위도 같이 늘려");
	} else if (current === "followUp") {
		session.setThinkingLevel("auto");
		await session.followUp("ultrathink 숨은 실행 지시", undefined, { synthetic: true });
		await flush();
		seen.afterSyntheticFollowUp = session.thinkingLevel;
		await session.prompt("ultrathink 끝나면 이것도 해", { streamingBehavior: "followUp" });
		await flush();
		seen.afterUserFollowUp = session.thinkingLevel;
	} else if (current === "fixed") {
		await session.prompt("ultrathink 고정 강도 세션의 steer", { streamingBehavior: "steer" });
		await flush();
		seen.fixedAuto = session.isAutoThinking;
		seen.afterFixedSteer = session.thinkingLevel;
	}
	throw new Error("smoke: no provider call");
});

const watchdog = setTimeout(() => {
	console.log(`\nWATCHDOG: phase=${phase} seen=${JSON.stringify(seen)}`);
	process.exit(2);
}, Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000));

async function runPhase(next: Phase, start: "low" | "high", prompt: string): Promise<void> {
	session.setThinkingLevel(start);
	phase = next;
	try {
		await session.prompt(prompt);
	} catch {
		// 모델 없는 turn 은 실패로 끝난다. 관측값은 훅 안에서 이미 기록했다.
	}
	await agent.waitForIdle();
	await flush();
}

console.log("\n[1] 실행 중 사용자 steer 는 auto 강도를 올리고, agent steer 는 건드리지 않는다");
await runPhase("steer", "low", "로그 파서를 고쳐");
check("[1] 입력 시점에 턴이 스트리밍 중이었다", seen["steer:streaming"] === true);
check("[1] auto 전환 직후 강도는 max 가 아니다", seen.provisional !== undefined && seen.provisional !== "max", `provisional=${seen.provisional}`);
check("[1] agent 가 넣은 steer 는 강도를 바꾸지 않는다", seen.afterAgentSteer === seen.provisional, `after=${seen.afterAgentSteer}`);
check("[1] 사용자 steer 는 강도를 올린다", seen.afterUserSteer === "max", `after=${seen.afterUserSteer}`);
check("[1] 올린 강도는 세션 기록에 한 번 남는다", seen.steerEntries === 1, `entries=${seen.steerEntries}`);
check(
	"[1] thinking_level_changed 이벤트로 알린다",
	Array.isArray(seen.steerEvents) && (seen.steerEvents as string[]).includes("max"),
	JSON.stringify(seen.steerEvents),
);
check("[1] steer 메시지는 그대로 큐에 들어간다", seen.steerQueued === true);

console.log("\n[2] 실행 중 사용자 follow-up 도 같고, synthetic follow-up 은 건드리지 않는다");
await runPhase("followUp", "low", "테스트를 돌려");
check("[2] 입력 시점에 턴이 스트리밍 중이었다", seen["followUp:streaming"] === true);
check(
	"[2] synthetic follow-up 은 강도를 바꾸지 않는다",
	seen.afterSyntheticFollowUp !== undefined && seen.afterSyntheticFollowUp !== "max",
	`after=${seen.afterSyntheticFollowUp}`,
);
check("[2] 사용자 follow-up 은 강도를 올린다", seen.afterUserFollowUp === "max", `after=${seen.afterUserFollowUp}`);

console.log("\n[3] auto 가 아닌 세션은 steer 가 와도 강도가 그대로다");
await runPhase("fixed", "high", "문서를 정리해");
check("[3] 입력 시점에 턴이 스트리밍 중이었다", seen["fixed:streaming"] === true);
check("[3] 고정 강도 세션은 auto 가 아니다", seen.fixedAuto === false);
check("[3] 고정 강도는 사용자 steer 뒤에도 high 다", seen.afterFixedSteer === "high", `after=${seen.afterFixedSteer}`);

await session.dispose?.();
// Windows 는 dispose 직후에도 agent.db 를 잠깐 잡고 있다. 정리 실패는 검사 결과가 아니므로 남기고 넘어간다.
for (const dir of [workdir, agentDir]) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch (error) {
		console.log(`  (정리 보류 ${dir}: ${String(error).slice(0, 60)})`);
	}
}
clearTimeout(watchdog);
console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
