/** 실제 AgentSession 을 띄워 kept-alive continuation relay 계약을 배선 그대로 확인한다.
 *
 * core-patch-test.ts [9] 는 IrcBridge·IrcBus·executor 를 진짜로 쓰지만 세션 쪽은 하네스가
 * 흉내 낸다. 이 스모크는 그 빈칸을 메운다: sdk.createAgentSession 이 만든 진짜
 * AgentSession 에 executor 의 attachIrcWakeTurnMonitor 로 관찰자를 설치하고, 진짜 turn 이
 * 도는 동안 IrcBus 로 부모 steer 를 꽂아, 관찰자 설치 시점과 정산 시점을 실제 배선으로
 * 판정한다.
 *
 * 모델 호출은 하지 않는다. agent-core 의 addBeforeModelCallHook 은 provider 요청 직전,
 * isStreaming=true 인 상태에서 실행된다. 그 안에서 steer 를 주입한 뒤 예외를 던지면 turn 은
 * 실패로 끝나고 네트워크 요청은 한 번도 나가지 않는다. 실패 turn 도 부모에게 정확히 1건을
 * 알려야 하므로(r3 계약) 판정에는 오히려 유리하다.
 *
 * 실행: OMP_CORE_PATCH_TARGET=<사본> bun run patches/core-relay-regression-test.ts
 * 미패치 사본에서는 RED, 패치 사본에서는 GREEN 이다.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// 격리 근거. AgentRegistry·IrcBus 는 모듈 전역 싱글턴이고 broker·소켓·IPC 가 없으므로
// (irc/bus.ts 의 `static global()`, registry/agent-registry.ts 의 `static global()`),
// 이 프로세스의 등록/라우팅은 살아 있는 다른 omp 프로세스에 닿지 않는다. 세션 상태도
// 아래의 임시 cwd 로 갈리고, 모델·인증 설정은 아래의 임시 agentDir 하나로만 들어오므로
// 운영자의 실제 `~/.omp` 는 읽지도 쓰지도 않는다. 예전에는 agentDir 를 기본값으로 둬
// 운영자의 실제 모델·인증 설정에 의존했고, 그래서 HOME 을 임시 폴더로 갈아 돌리면
// 모델이 없어 turn 이 시작조차 못 했다(실측 18.2.5/18.2.6: 모델 호출 훅 0회 →
// 13검사 중 8건 FAIL). 그 환경 결합을 없앤 자리가 아래 fixture agentDir 다.

function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	if (env) return join(env, "src");
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

const { AgentRegistry, MAIN_AGENT_ID } = await import(`${CORE}/registry/agent-registry.ts`);
const { IrcBus } = await import(`${CORE}/irc/bus.ts`);
const { attachIrcWakeTurnMonitor } = await import(`${CORE}/task/executor.ts`);
const sdk = await import(`${CORE}/sdk.ts`);

const workdir = mkdtempSync(join(tmpdir(), "omp-relay-session-"));
const artifactsDir = mkdtempSync(join(tmpdir(), "omp-relay-artifacts-"));

// 모델·인증 설정의 유일한 출처. provider 는 pi-ai `serviceProviderMap` 밖의 가상
// 이름이라 env 별칭이 걸리지 않고, baseUrl 은 닫힌 포트다. 모델 호출은 아래
// addBeforeModelCallHook 이 그 직전에 예외로 끊으므로 실제로 열리지도 않는다.
// 더미 키(비밀 아님).
const FIXTURE_PROVIDER = "b-ai";
const FIXTURE_MODEL_ID = "deepseek-v4.1-flash";
// ModelRegistry 는 models.db 핸들을 닫는 API 가 없어 이 프로세스가 살아 있는 동안
// agentDir 삭제가 Windows 에서 EBUSY 로 실패할 수 있다. 그래서 이전 실행이 남긴 것을
// 시작할 때 한 번 쓸어 낸다(핸들이 이미 없으므로 지워진다). 새 이름은 계속 고유하게
// 잡아 동시 실행끼리 서로의 디렉터리를 지우지 않는다.
for (const entry of readdirSync(tmpdir())) {
	if (!entry.startsWith("omp-relay-agentdir-")) continue;
	try {
		rmSync(join(tmpdir(), entry), { recursive: true, force: true });
	} catch {
		// 다른 실행이 아직 쥐고 있는 디렉터리다. 그 실행이 정리한다.
	}
}
const agentDir = mkdtempSync(join(tmpdir(), "omp-relay-agentdir-"));
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

/** 부모는 진짜 세션이 필요 없다. 관심사는 "무엇이, 어느 turn 에 도착했는가" 뿐이다.
 *  `turnSeq` 는 도착 시점까지 실제로 시작된 agent turn 수다(`agent_start` 이벤트).
 *  건수만 세면 "소비한 turn 이 답했다"와 "그 다음 turn 이 대신 답했다"가 구분되지
 *  않으므로 함께 기록한다. provider 재시도(auto_retry)는 같은 turn 안의 사건이라
 *  훅 호출 횟수로는 turn 을 셀 수 없다. */
const parentInbox: Array<{ from: string; body: string; wakeRelay?: boolean; turnSeq: number }> = [];
let turnCount = 0;
const parentSession = {
	isStreaming: () => false,
	deliverIrcMessage: async (m: { from: string; body: string; wakeRelay?: boolean }) => {
		parentInbox.push({ from: m.from, body: m.body, wakeRelay: m.wakeRelay, turnSeq: turnCount });
		if (process.env.SMOKE_TRACE === "1") {
			console.log(
				`    [parent<-] turn=${turnCount} wakeRelay=${m.wakeRelay} ${m.body.slice(0, 90).replace(/\n/g, " ")}`,
			);
		}
		return "injected" as const;
	},
} as never;

/** 형제 peer. 이 에이전트를 깨우는 쪽이 부모만은 아니다: 형제의 wake 가 turn 을 열고
 *  그 turn 도중에 부모 steer 가 도착하는 경우가 실제 배선에서 가장 흔하다. */
const novaInbox: Array<{ from: string; body: string; wakeRelay?: boolean; turnSeq: number }> = [];
const novaSession = {
	isStreaming: () => false,
	deliverIrcMessage: async (m: { from: string; body: string; wakeRelay?: boolean }) => {
		novaInbox.push({ from: m.from, body: m.body, wakeRelay: m.wakeRelay, turnSeq: turnCount });
		if (process.env.SMOKE_TRACE === "1") {
			console.log(`    [nova<-] turn=${turnCount} wakeRelay=${m.wakeRelay} ${m.body.slice(0, 60).replace(/\n/g, " ")}`);
		}
		return "injected" as const;
	},
} as never;

const registry = AgentRegistry.global();
const bus = IrcBus.global();

console.log(`[env] core=${CORE}`);
const created = await sdk.createAgentSession({ cwd: workdir, agentDir, disableExtensionDiscovery: true });
const session = created.session;

// 실제 배선: 부모는 top-level main, 서브는 그 자식이며 세션은 진짜 AgentSession 이다.
for (const ref of registry.list()) {
	if (ref.session === session) registry.unregister(ref.id);
}
registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: parentSession });
registry.register({ id: "Sol", displayName: "sub", kind: "sub", parentId: MAIN_AGENT_ID, session });
registry.register({ id: "Nova", displayName: "sibling", kind: "sub", parentId: MAIN_AGENT_ID, session: novaSession });
session.setAgentIdentity?.("Sol", "sub");

check("실제 AgentSession 이 만들어졌다", typeof session.deliverIrcMessage === "function");
check(
	"관찰자는 처음에는 설치돼 있지 않다",
	(session as unknown as { setIrcWakeTurnObserver: unknown }).setIrcWakeTurnObserver !== undefined,
);
// hermetic 전제의 관측값. 이것이 깨지면 turn 은 모델 없이 시작조차 못 하고 아래 8검사가
// 한꺼번에 무너지므로(실측된 옛 실패 모습), 원인을 여기서 이름으로 드러낸다.
const sessionModel = session.model as { provider?: string; id?: string } | undefined;
check(
	"세션 모델은 임시 agentDir 의 fixture 다(운영자 설정에 의존하지 않는다)",
	sessionModel?.provider === FIXTURE_PROVIDER && sessionModel?.id === FIXTURE_MODEL_ID,
	`model=${JSON.stringify(sessionModel)}`,
);

// 관찰자(bracket)가 "언제" 열리고 어떻게 닫혔는지는 이 계약의 핵심 관측값이다.
// 실행 중 turn 이 채택되면 bracket 은 그 turn 이 스트리밍 중일 때 열리고, 그 turn 이
// steer 를 소비했으면 suppress=false 로 닫혀 그 turn 의 결과가 부모 답이 된다.
// 소비하지 않았으면 suppress=true 로 조용히 닫히고, 이어받는 continuation 이 따로 연다.
// executor 의 정본 관찰자를 감싸기만 하며 동작은 바꾸지 않는다.
type Bracket = {
	streamingAtOpen: boolean;
	hookAtOpen: number;
	suppress?: boolean;
	closed: boolean;
	/** 이 turn 도중에 도착해 이 turn 이 소비한, 같은 정산이 함께 답해야 하는 steer 수. */
	adopted?: number;
};
const brackets: Bracket[] = [];
const installObserver = session.setIrcWakeTurnObserver.bind(session);
session.setIrcWakeTurnObserver = (observer: never): void => {
	if (observer === undefined) return installObserver(undefined);
	installObserver(((records: never) => {
		const entry: Bracket = { streamingAtOpen: session.isStreaming, hookAtOpen: hookHits, closed: false };
		brackets.push(entry);
		if (trace) console.log(`    [bracket open] streaming=${entry.streamingAtOpen} hook=${entry.hookAtOpen}`);
		const finish = (observer as unknown as (r: never) => unknown)(records) as
			| ((error?: unknown, suppressRelay?: boolean, adoptedRecords?: unknown[]) => void | Promise<void>)
			| undefined;
		if (finish === undefined) return undefined;
		return async (error?: unknown, suppressRelay?: boolean, adoptedRecords?: unknown[]) => {
			entry.suppress = suppressRelay === true;
			entry.adopted = adoptedRecords?.length ?? 0;
			entry.closed = true;
			if (trace) console.log(`    [bracket finish] suppress=${entry.suppress} adopted=${entry.adopted}`);
			return await finish(error, suppressRelay, adoptedRecords);
		};
	}) as never);
};

// executor 정본 경로로 관찰자를 설치한다. 이 설치 자체가 "spawn job 은 이미 정산됐고
// 이제부터의 결과는 job 이 전달하지 못한다"는 조건이다.
attachIrcWakeTurnMonitor(session, {
	id: "Sol",
	index: 0,
	agent: { name: "maker", source: "smoke", prompt: "", description: "smoke" } as never,
	artifactsDir,
});

// turn 경계는 세션 이벤트가 정본이다. provider 오류로 인한 auto_retry 는 같은 turn
// 안에서 모델 호출만 다시 하므로, 훅 호출 횟수와 turn 수는 다르다.
session.subscribe((event: { type: string }) => {
	if (event.type === "agent_start") turnCount++;
	if (trace && (event.type === "agent_start" || event.type === "agent_end" || event.type === "auto_retry_start")) {
		console.log(`    [event] ${event.type} turn=${turnCount}`);
	}
});

type Phase = "idle" | "consume" | "strand" | "quiet";
let phase: Phase = "idle";
let hookHits = 0;
/** provider 요청 직전(스트리밍 중) 훅. 여기서 부모 steer 를 꽂고 예외로 turn 을 끝낸다.
 *  모델 호출은 이 지점 다음이므로 네트워크로는 아무것도 나가지 않는다. */
session.agent.addBeforeModelCallHook(async () => {
	hookHits++;
	if (trace) console.log(`    [hook ${hookHits}] phase=${phase} streaming=${session.isStreaming}`);
	if (phase === "consume" || phase === "strand") {
		const current = phase;
		phase = "quiet";
		await bus.send({ from: MAIN_AGENT_ID, to: "Sol", body: `${current} 지시` });
		if (current === "consume") {
			// 실행 중 turn 이 steering 큐를 실제로 읽어 간 것과 같은 상태를 만든다:
			// agent-core 의 공개 큐 API 로 그 메시지를 큐에서 뺀다.
			const before = session.agent.peekSteeringQueue().length;
			session.agent.replaceQueues([], [...session.agent.peekFollowUpQueue()]);
			if (trace) {
				console.log(
					`    [queue] steering ${before} -> ${session.agent.peekSteeringQueue().length}, followUp=${session.agent.peekFollowUpQueue().length}`,
				);
			}
		}
	}
	throw new Error("smoke: no provider call");
});

const trace = process.env.SMOKE_TRACE === "1";
/** 실 세션은 실패한 turn 을 스스로 이어가므로, 스모크는 반드시 자기 시한을 가진다.
 *  unref 하지 않는다: 끝까지 간 실행은 아래에서 clearTimeout 으로 직접 닫고, 그
 *  전에 멈춘 실행은 이 타이머가 확실히 깨워 종료 코드 2 로 끝낸다. */
const watchdog = setTimeout(() => {
	console.log(`\nWATCHDOG: hookHits=${hookHits} phase=${phase} relays=${relays().length}`);
	console.log(parentInbox.map(m => m.body.slice(0, 80)).join("\n"));
	process.exit(2);
}, Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000));

// 18.2.1 부터 wake turn relay 의 본문은 yield 로 끝난 성공 turn 만 `<task-result>` 봉투이고,
// 실패·취소 turn 은 실패 원인 + `history://<id>` 포인터를 담은 통지다(executor
// `buildWakeRelayBody`). 이 스모크의 turn 은 provider 가 없어 전부 실패하므로, "부모가 정확히
// 1건 답을 받았는가"는 봉투가 아니라 relay 자체로 세고 본문은 아래에서 따로 본다.
const relays = () => parentInbox.filter(m => m.wakeRelay === true);
const novaRelays = () => novaInbox.filter(m => m.wakeRelay === true);

async function settle(ms = 900): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms));
}

console.log("\n[1] 실행 중 turn 이 부모 steer 를 소비하면 그 turn 이 정확히 1건 답한다");
phase = "consume";
const beforeConsume = relays().length;
const bracketsBeforeConsume = brackets.length;
await session.prompt("실행 중 turn 시작").catch(() => {});
await settle();
check("훅이 실제 turn 안에서 실행됐다", hookHits > 0, `hits=${hookHits}`);
const consumeBody = relays().at(-1)?.body ?? "";
check(
	"소비한 turn 이 부모에게 정확히 1건 답한다",
	relays().length === beforeConsume + 1,
	`relays=${relays().length - beforeConsume} inbox=${JSON.stringify(parentInbox.map(m => m.body.slice(0, 60)))}`,
);
check(
	"실패한 turn 의 통지는 그 원인과 이 에이전트의 history 포인터를 담고 결과를 주장하지 않는다",
	consumeBody.includes("smoke: no provider call") &&
		consumeBody.includes("history://Sol") &&
		!consumeBody.includes("<task-result"),
	consumeBody.slice(0, 200),
);
// 건수만으로는 부족하다. 누가 답의 주인이었는지가 이 계약이다. 실행 중 turn 이 steer 를
// 소비했으면 그 turn 을 감싼 bracket 이 "억제하지 않음"으로 닫혀야 한다. (turn 수로는
// 셀 수 없다: provider 실패 재시도마다 agent_start 가 다시 나온다.)
// 그리고 하나의 빚에는 bracket 도 하나다. 관찰자 하나가 곧 run monitor 하나·lifecycle
// "started" 하나·정산 artifact 하나이므로, 같은 빚으로 둘이 열리면 부모 통보가 1건인
// 것과 무관하게 정산이 두 번 돈다.
const consumeBrackets = brackets.slice(bracketsBeforeConsume);
check(
	"소비한 turn 의 bracket 은 정확히 1개이고 억제 없이 닫혀 그 turn 이 답의 주인이 된다",
	consumeBrackets.length === 1 && consumeBrackets[0]?.closed === true && consumeBrackets[0]?.suppress === false,
	`brackets=${JSON.stringify(consumeBrackets)}`,
);

console.log("\n[2] 소비하지 않고 남긴 steer 는 이 turn 이 답하지 않고 다음 turn 몫이다");
phase = "strand";
const beforeStrand = relays().length;
const bracketsBeforeStrand = brackets.length;
await session.prompt("두 번째 turn 시작").catch(() => {});
await settle(1500);
check(
	"stranded steer 에 대해 부모는 정확히 1건만 받는다",
	relays().length === beforeStrand + 1,
	`relays=${relays().length - beforeStrand}`,
);
// 남긴 steer 는 그 turn 의 몫이 아니다: 실행 중 turn 의 bracket 은 "억제"로 닫히고,
// 그것을 실제로 이어받은 다음 bracket 하나가 답한다. 빚 하나당 정산도 하나여야 하므로
// 이 구간의 bracket 은 정확히 둘 - 억제로 닫힌 것 하나, 답한 것 하나 - 이다.
const strandBrackets = brackets.slice(bracketsBeforeStrand);
check(
	"남긴 steer 는 그 turn 이 억제로 닫고 이어받은 turn 하나가 답한다",
	strandBrackets.length === 2 &&
		strandBrackets.every(b => b.closed) &&
		strandBrackets[0]?.suppress === true &&
		strandBrackets[1]?.suppress === false,
	`brackets=${JSON.stringify(strandBrackets)}`,
);

console.log("\n[3] 형제 wake turn 도중 부모 steer 가 도착해 그 turn 이 소비하면, 한 번의 정산이 형제와 부모 모두에게 1건씩 답한다");
phase = "consume";
const beforeSibParent = relays().length;
const beforeSibNova = novaRelays().length;
const bracketsBeforeSib = brackets.length;
await bus.send({ from: "Nova", to: "Sol", body: "형제 wake" });
await settle(2000);
const sibBrackets = brackets.slice(bracketsBeforeSib);
check(
	"형제 wake 는 정산 하나짜리 turn 을 연다",
	sibBrackets.length === 1 && sibBrackets[0]?.closed === true && sibBrackets[0]?.suppress === false,
	`brackets=${JSON.stringify(sibBrackets)}`,
);
check(
	"형제는 이 turn 의 결과를 정확히 1건 받는다",
	novaRelays().length === beforeSibNova + 1,
	`n=${novaRelays().length - beforeSibNova}`,
);
check(
	"도중에 소비된 부모 steer 도 같은 정산에서 정확히 1건 답을 받는다",
	relays().length === beforeSibParent + 1,
	`n=${relays().length - beforeSibParent}`,
);

console.log("\n[4] 형제 wake turn 도중 도착했지만 소비되지 않은 부모 steer 는 형제 답을 막지 않고 다음 turn 몫이다");
phase = "strand";
const beforeSib2Parent = relays().length;
const beforeSib2Nova = novaRelays().length;
await bus.send({ from: "Nova", to: "Sol", body: "형제 wake 2" });
await settle(2500);
check(
	"형제는 이번 turn 에서 정확히 1건 받는다",
	novaRelays().length === beforeSib2Nova + 1,
	`n=${novaRelays().length - beforeSib2Nova}`,
);
check(
	"남긴 부모 steer 는 이어받은 turn 이 정확히 1건 답한다",
	relays().length === beforeSib2Parent + 1,
	`n=${relays().length - beforeSib2Parent}`,
);

/** 정리 단계가 어디서 멈추는지 남긴다. 실 세션은 워커·파일 핸들을 들고 있어
 *  dispose 나 임시 폴더 삭제가 Windows 에서 오래 걸릴 수 있다. */
function stage(label: string, startedAt: number, outcome: string): void {
	console.log(`  [cleanup] ${label}=${outcome} ${Date.now() - startedAt}ms`);
}

const disposeStarted = Date.now();
console.log("\n[cleanup] dispose 시작");
const disposeOutcome = await Promise.race([
	Promise.resolve()
		.then(() => session.dispose?.())
		.then(() => "done" as const)
		.catch(error => `throw:${String(error).slice(0, 80)}`),
	new Promise<string>(resolve => setTimeout(() => resolve("deadline"), 8_000)),
]);
stage("dispose", disposeStarted, disposeOutcome);

for (const [label, dir] of [
	["rm-workdir", workdir],
	["rm-artifacts", artifactsDir],
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
