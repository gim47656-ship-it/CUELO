// genuine steering 이 진행 중 모델 스트림을 끊지 않는지 실제 AgentSession 으로 관찰한다.
//   bun run patches/core-steer-stream-test.ts (OMP_CORE_PATCH_TARGET 지정 시 그 사본)
//
// 2026-09-20 배포본의 steer 분기는 immediate 모드이고 스트리밍 중이며 실행 중 tool call 이
// 없을 때 `agent.abort()` 로 현재 run 을 중단했다. 사용자는 steer 직후 진행 중이던 답변이
// 끊기는 것(정지)을 관측했다. 이 스모크가 고정하는 계약은 관측 가능한 세 가지다.
//   - steer 는 실제로 steering 큐에 들어간다(다음 step 이 처리한다),
//   - 그 시점에 run 은 abort 되지 않는다(진행 중 stream 생존),
//   - 이미 실행 중인 tool call 은 그대로 남는다.
//
// 이후 복구 경로가 내보내는 재시도 표시(auto_retry_start)는 이 스모크의 검사가 아니다:
// 모델 없는 하네스라 turn 이 주입 훅 예외로 끝나 그 경로에 도달하지 않는다.
// abort 항목이 있는 core 에서는 RED, 원복된 core 에서는 GREEN 이다.
// 모델 호출은 하지 않는다: before-model-call 훅이 provider 요청 직전에 예외로 turn 을 끊는다.
// 세션 상태·모델·인증 설정은 임시 cwd·agentDir 하나로만 들어가므로 운영자의 실제 `~/.omp` 는
// 읽지도 쓰지도 않는다.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	if (env) return join(env, "src").replace(/\\/g, "/");
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = [
		join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"),
		join(root, "@oh-my-pi/pi-coding-agent"),
	];
	const hit = candidates.find(p => existsSync(join(p, "src/registry/agent-registry.ts")));
	if (!hit) throw new Error(`omp-web 전역 설치를 찾지 못했다: ${candidates.join(", ")}`);
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

const sdk = await import(`${CORE}/sdk.ts`); // 정적 import 불가: 대상 core 경로가 OMP_CORE_PATCH_TARGET 로 실행 시점에 정해진다.

const workdir = mkdtempSync(join(tmpdir(), "omp-steer-session-"));
const agentDir = mkdtempSync(join(tmpdir(), "omp-steer-agentdir-"));
// 이 실행이 만든 두 경로만 정리한다. tmpdir 를 훑어 지우면 동시에 도는 다른 실행의
// 디렉터리까지 지울 수 있다.
// provider 는 실제 b-ai id 를 쓰되 baseUrl 이 닫힌 포트라 열리지 않고, 모델 호출은 아래 훅이
// 그 직전에 예외로 끊는다. apiKey 는 더미다(비밀 아님).
const FIXTURE_PROVIDER = "b-ai";
const FIXTURE_MODEL_ID = "deepseek-v4.1-flash";
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
		"",
	].join("\n"),
	"utf8",
);

const created = await sdk.createAgentSession({ cwd: workdir, agentDir, disableExtensionDiscovery: true });
const session = created.session;
const agent = session.agent;

check("실제 AgentSession 이 만들어졌다", typeof session.steer === "function");

const sessionModel = session.model as { provider?: string; id?: string } | undefined;
check(
	"세션 모델은 임시 agentDir 의 fixture 다(운영자 설정에 의존하지 않는다)",
	sessionModel?.provider === FIXTURE_PROVIDER && sessionModel?.id === FIXTURE_MODEL_ID,
	`model=${JSON.stringify(sessionModel)}`,
);

// abort 는 실제 객체에 그대로 전달하고 호출만 센다. steer 분기가 run 을 끊었는지의 직접 관측이다.
const abortCalls: unknown[] = [];
const realAbort = agent.abort.bind(agent);
agent.abort = (reason?: unknown) => {
	abortCalls.push(reason);
	return realAbort(reason);
};

type Observation = {
	streamingBefore: boolean;
	queued: number;
	queuedText: string;
	aborting: boolean;
	abortedBySteer: number;
	pendingToolsBefore: number;
	pendingToolsAfter: number;
};
const observations: Observation[] = [];
const PENDING_TOOL_ID = "smoke-in-flight-tool";
let phase: "plain" | "tool" | "quiet" = "plain";

/** provider 요청 직전(스트리밍 중) 훅. 여기서 genuine steer 를 꽂고 예외로 turn 을 끝낸다. */
agent.addBeforeModelCallHook(async () => {
	if (phase === "quiet") throw new Error("smoke: no provider call");
	const current = phase;
	phase = "quiet";
	if (current === "tool") agent.state.pendingToolCalls.add(PENDING_TOOL_ID);
	const queuedBefore = agent.peekSteeringQueue().length;
	const pendingToolsBefore = agent.state.pendingToolCalls.size;
	const streamingBefore = session.isStreaming;
	const abortCallsBefore = abortCalls.length;
	await session.steer("방향 바꿔");
	const queue = agent.peekSteeringQueue();
	observations.push({
		streamingBefore,
		queued: queue.length - queuedBefore,
		queuedText: JSON.stringify(queue[queue.length - 1]?.content ?? null),
		aborting: agent.isAborting,
		abortedBySteer: abortCalls.length - abortCallsBefore,
		pendingToolsBefore,
		pendingToolsAfter: agent.state.pendingToolCalls.size,
	});
	throw new Error("smoke: no provider call");
});

const watchdog = setTimeout(() => {
	console.log(`\nWATCHDOG: observations=${observations.length} phase=${phase}`);
	process.exit(2);
}, Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000));

async function settle(ms = 1_200): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	await promise;
}

async function runPhase(next: "plain" | "tool", prompt: string): Promise<void> {
	phase = next;
	try {
		await session.prompt(prompt);
	} catch {
		// 모델 없는 turn 은 실패로 끝난다. 관측값은 훅 안에서 이미 기록했다.
	}
	await settle();
}

console.log("\n[1] 스트리밍 중 genuine steer");
await runPhase("plain", "상태를 확인해");
console.log("\n[2] 실행 중 tool call 이 있는 상태의 genuine steer");
await runPhase("tool", "도구를 돌려줘");

const plain = observations[0];
const withTool = observations[1];
check("스트리밍 중 steer 를 관측했다", plain !== undefined, `observations=${observations.length}`);
if (plain) {
	check("steer 시점에 run 이 스트리밍 중이었다", plain.streamingBefore === true, `streaming=${plain.streamingBefore}`);
	check(
		"steer 는 실제 steering 큐에 들어간다(다음 step 이 처리한다)",
		plain.queued === 1 && plain.queuedText.includes("방향 바꿔"),
		`queued=${plain.queued} text=${plain.queuedText}`,
	);
	check(
		"steer 는 진행 중 run 을 abort 하지 않는다",
		plain.abortedBySteer === 0 && plain.aborting === false,
		`abortedBySteer=${plain.abortedBySteer} isAborting=${plain.aborting}`,
	);
}
check("tool call 이 있는 상태의 steer 도 관측했다", withTool !== undefined, `observations=${observations.length}`);
if (withTool) {
	check(
		"이미 실행 중인 tool call 은 steer 뒤에도 그대로 남는다",
		withTool.pendingToolsBefore === 1 && withTool.pendingToolsAfter === 1,
		`before=${withTool.pendingToolsBefore} after=${withTool.pendingToolsAfter}`,
	);
	check(
		"tool 실행 중 steer 도 run 을 abort 하지 않는다",
		withTool.abortedBySteer === 0 && withTool.aborting === false,
		`abortedBySteer=${withTool.abortedBySteer} isAborting=${withTool.aborting}`,
	);
}

const abortedMessages = agent.state.messages.filter(
	message => message.role === "assistant" && (message as { stopReason?: string }).stopReason === "aborted",
);
check(
	"steer 때문에 끊긴 partial assistant 메시지가 커밋되지 않는다",
	abortedMessages.length === 0,
	`aborted=${abortedMessages.length}`,
);

/** 정리 단계가 어디서 멈추는지 남긴다. 실 세션은 워커·파일 핸들을 들고 있어 dispose 나
 *  임시 폴더 삭제가 Windows 에서 오래 걸릴 수 있다. */
function stage(label: string, startedAt: number, outcome: string): void {
	console.log(`  [cleanup] ${label}=${outcome} ${Date.now() - startedAt}ms`);
}

console.log("\n[cleanup] dispose 시작");
const disposeStarted = Date.now();
const disposeDeadline = Promise.withResolvers<string>();
setTimeout(() => disposeDeadline.resolve("deadline"), 8_000);
const disposeOutcome = await Promise.race([
	Promise.resolve()
		.then(() => session.dispose?.())
		.then(() => "done" as const)
		.catch(error => `throw:${String(error).slice(0, 80)}`),
	disposeDeadline.promise,
]);
stage("dispose", disposeStarted, disposeOutcome);

for (const [label, dir] of [
	["rm-workdir", workdir],
	["rm-agentdir", agentDir],
] as const) {
	const started = Date.now();
	try {
		rmSync(dir, { recursive: true, force: true });
		stage(label, started, "done");
	} catch (error) {
		stage(label, started, `throw:${String(error).slice(0, 80)}`);
	}
}

clearTimeout(watchdog);
console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
