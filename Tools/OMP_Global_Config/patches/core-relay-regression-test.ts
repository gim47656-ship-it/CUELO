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
// 18.4.2 는 기본 모델을 고를 때 환경 변수 키가 있는 provider(OPENAI_API_KEY 등)를 fixture 보다 앞에 둔다.
// 운영자 환경이 끼지 않도록 fixture 모델을 기본 역할로 고정한다.
writeFileSync(join(agentDir, "config.yml"), `modelRoles:\n  default: ${FIXTURE_PROVIDER}/${FIXTURE_MODEL_ID}\n`, "utf8");

/** 부모는 진짜 세션이 필요 없다. 관심사는 "무엇이, 어느 turn 에 도착했는가" 뿐이다.
 *  `turnSeq` 는 도착 시점까지 실제로 시작된 agent turn 수다(`agent_start` 이벤트).
 *  건수만 세면 "소비한 turn 이 답했다"와 "그 다음 turn 이 대신 답했다"가 구분되지
 *  않으므로 함께 기록한다. provider 재시도(auto_retry)는 같은 turn 안의 사건이라
 *  훅 호출 횟수로는 turn 을 셀 수 없다. */
const parentInbox: Array<{ from: string; body: string; wakeRelay?: boolean; channel?: "job"; turnSeq: number }> = [];
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
/** 동시에 열려 있던 bracket 의 최댓값. 관찰자 시작은 공유 yield 상태를 지우므로(executor resetYieldTurnState)
 *  한 turn 에 둘이 겹치면 먼저 연 monitor 의 yield 판정이 깨진다. 어느 구간에서도 1을 넘으면 안 된다. */
let maxOpenBrackets = 0;
/** 경합 창 구간([6]~[8])마다 따로 잰 최댓값. 누적값만 보면 앞 구간의 겹침이 뒤 구간 실패로 보인다. */
let sectionMaxOpenBrackets = 0;
const installObserver = session.setIrcWakeTurnObserver.bind(session);
session.setIrcWakeTurnObserver = (observer: never): void => {
	if (observer === undefined) return installObserver(undefined);
	installObserver(((records: never, bracket?: never) => {
		const entry: Bracket = { streamingAtOpen: session.isStreaming, hookAtOpen: hookHits, closed: false };
		brackets.push(entry);
		maxOpenBrackets = Math.max(maxOpenBrackets, brackets.filter(b => !b.closed).length);
		sectionMaxOpenBrackets = Math.max(sectionMaxOpenBrackets, brackets.filter(b => !b.closed).length);
		if (trace) console.log(`    [bracket open] streaming=${entry.streamingAtOpen} hook=${entry.hookAtOpen}`);
		// 세션이 넘긴 bracket 표시(이미 돌던 turn 의 입양 등)도 그대로 전달한다. 빼면 executor 가 다른 판정을 한다.
		const finish = (observer as unknown as (r: never, b?: never) => unknown)(records, bracket) as
			| ((error?: unknown, suppressRelay?: boolean, adoptedRecords?: unknown[]) => void | Promise<void>)
			| undefined;
		if (finish === undefined) {
			entry.closed = true;
			return undefined;
		}
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

// 부모 Main 앞으로 등록된 owner job 의 전달을 받는 자리. 실제 Main 세션이 같은 manager 에 거는 sink 와 같은 역할이며,
// 없으면 그 전달은 dead-letter 로 버려져 "부모가 받은 답"에서 빠진다(job-manager registerDeliverySink).
const jobManager = session.asyncJobManager;
check("세션에 owner job 전달을 받을 async job manager 가 있다", jobManager !== undefined);
jobManager?.registerDeliverySink(MAIN_AGENT_ID, (_jobId: string, text: string) => {
	parentInbox.push({ from: "Sol", body: text, channel: "job", turnSeq: turnCount });
	if (trace) console.log(`    [parent<-job] turn=${turnCount} ${text.slice(0, 90).replace(/\n/g, " ")}`);
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
/** 훅이 부모 steer 를 꽂은 turn. 답이 "그 steer 를 남긴 turn"이 아니라 "이어받은 turn"에서 나왔는지 가른다. */
let injectedAtTurn = 0;
/** provider 요청 직전(스트리밍 중) 훅. 여기서 부모 steer 를 꽂고 예외로 turn 을 끝낸다.
 *  모델 호출은 이 지점 다음이므로 네트워크로는 아무것도 나가지 않는다. */
session.agent.addBeforeModelCallHook(async () => {
	hookHits++;
	if (trace) console.log(`    [hook ${hookHits}] phase=${phase} streaming=${session.isStreaming}`);
	if (phase === "consume" || phase === "strand") {
		const current = phase;
		phase = "quiet";
		injectedAtTurn = turnCount;
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
// 18.6.1 부터 부모 레코드로 연 wake·continuation bracket 은 부모에게 IRC relay 대신 owner job(부모 `wait`·async 결과
// 전달)으로 답하고, relay 는 그 부모를 건너뛴다(executor attachIrcWakeTurnMonitor). 그래서 "부모가 받은 답"은 두 경로를
// 합쳐 센다: 어느 쪽이든 부모 steer 하나당 정확히 1건이어야 하고, 0건(누락)·2건(중복) 모두 실패다.
const relays = () => parentInbox.filter(m => m.wakeRelay === true || m.channel === "job");
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
const hookBeforeStrand = hookHits;
await session.prompt("두 번째 turn 시작").catch(() => {});
await settle(1500);
check(
	"stranded steer 에 대해 부모는 정확히 1건만 받는다",
	relays().length === beforeStrand + 1,
	`relays=${relays().length - beforeStrand}`,
);
// 남긴 steer 는 그 turn 의 몫이 아니다. 빚 하나당 정산도 하나여야 하는데, 그 하나가 어디서 나오는지는 실행 중 turn 에
// 처음부터 관찰이 있었느냐로 갈린다.
//  - 관찰 없음(18.6.1까지: 사용자 prompt 는 관찰되지 않는다): 실행 중 turn 을 입양한 bracket 은 "억제"로 닫히고,
//    그것을 실제로 이어받은 다음 bracket 하나가 답한다. 이 구간의 bracket 은 정확히 둘이다.
//  - 관찰 있음(18.6.3 #14428: 사용자 prompt 도 관찰된다. 스트리밍 전에 열린다): 그 관찰은 settle 까지 열린 채
//    이어받은 turn 을 보므로 두 번째 monitor 를 열지 않고, 이어받은 turn 이 소비한 steer 를 adopted 로 함께 정산한다.
//    이 구간의 bracket 은 정확히 하나이고 억제 없이 adopted 1건으로 닫힌다.
// 어느 쪽이든 답은 steer 를 남긴 turn 이 아니라 그것을 이어받은 turn 의 것이어야 한다.
const strandBrackets = brackets.slice(bracketsBeforeStrand);
const strandTurn = injectedAtTurn;
const promptObserved = strandBrackets[0]?.streamingAtOpen === false && strandBrackets[0]?.hookAtOpen === hookBeforeStrand;
check(
	promptObserved
		? "남긴 steer 는 관찰된 prompt 의 정산 하나가 이어받은 turn 뒤 adopted 로 답한다"
		: "남긴 steer 는 그 turn 이 억제로 닫고 이어받은 turn 하나가 답한다",
	promptObserved
		? strandBrackets.length === 1 &&
				strandBrackets[0]?.closed === true &&
				strandBrackets[0]?.suppress === false &&
				strandBrackets[0]?.adopted === 1
		: strandBrackets.length === 2 &&
				strandBrackets.every(b => b.closed) &&
				strandBrackets[0]?.suppress === true &&
				strandBrackets[1]?.suppress === false,
	`brackets=${JSON.stringify(strandBrackets)}`,
);
check(
	"그 답은 steer 를 남긴 turn 이 아니라 이어받은 turn 에서 나온다",
	(relays().at(-1)?.turnSeq ?? 0) > strandTurn,
	`answerTurn=${relays().at(-1)?.turnSeq} strandTurn=${strandTurn}`,
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

console.log("\n[5] wake 정산(settle)이 바로 끝나는 세션에서도, 이어받은 continuation 이 소비한 부모 steer 답을 놓치지 않는다");
// 18.5.1(#13703)부터 wake turn 은 endInFlight() 뒤 settleAsyncWork() 를 기다린 다음 관찰자를 닫고, 그 구간의 turn 은
// 같은 관찰자가 본다. stranded 부모 steer 를 이어받는 continuation 은 endInFlight() 안의 drain 에서 동기적으로
// #beginInFlight 까지 들어가므로 언제나 열린 wake bracket 아래에서 시작한다(자기 bracket 을 열지 않는다).
// AsyncJobManager 나 agentId 가 없는 세션은 settleAsyncWork 가 즉시 끝나, 그 continuation 이 agent.continue 전
// await(maybeRestoreRetryFallbackPrimary 등)에 있는 동안 관찰자가 닫힐 수 있다. settle 을 그 조기 반환으로 바꾸고
// agent.continue 를 늦춰 continuation 을 그 창 안에 붙든다. 18.5.0 은 settle 없이 wake 를 drain 전에 닫으므로
// 같은 입력에서 continuation 이 자기 bracket 으로 답한다(두 판 모두 부모 1건).
phase = "strand";
const beforeRaceParent = relays().length;
const beforeRaceNova = novaRelays().length;
const raceAgent = session.agent as unknown as { continue: (...args: unknown[]) => Promise<unknown> };
const raceHost = session as unknown as { settleAsyncWork?: () => Promise<void> };
const originalContinue = raceAgent.continue;
const originalSettle = raceHost.settleAsyncWork;
raceAgent.continue = async function (this: unknown, ...args: unknown[]) {
	await settle(1200);
	return await originalContinue.apply(this, args);
};
if (originalSettle) {
	// `if (!manager || !this.#agentId) return;` 와 같은 조기 반환.
	raceHost.settleAsyncWork = async () => {};
}
await bus.send({ from: "Nova", to: "Sol", body: "형제 wake 3" });
const raceDeadline = Date.now() + 20_000;
while (Date.now() < raceDeadline && (relays().length < beforeRaceParent + 1 || novaRelays().length < beforeRaceNova + 1)) {
	await settle(200);
}
// 늦게 오는 중복까지 본다.
await settle(2500);
Reflect.deleteProperty(raceAgent, "continue");
if (originalSettle) Reflect.deleteProperty(raceHost, "settleAsyncWork");
check(
	"형제는 이번 turn 에서 정확히 1건 받는다",
	novaRelays().length === beforeRaceNova + 1,
	`n=${novaRelays().length - beforeRaceNova}`,
);
check(
	"창 안에서 이어받은 turn 이 소비한 부모 steer 도 정확히 1건 답을 받는다",
	relays().length === beforeRaceParent + 1,
	`n=${relays().length - beforeRaceParent}`,
);
check("어느 구간에서도 bracket 은 동시에 하나만 열린다", maxOpenBrackets === 1, `max=${maxOpenBrackets}`);

/**
 * 경합 창: 남긴 부모 steer 를 이어받는 continuation 은 #beginInFlight 와 agent.continue 사이의 await
 * (maybeRestoreRetryFallbackPrimary·사전 compaction 검사)에서 bracket 을 연 채 아직 스트리밍하지 않는다. 그 창에 끼어드는
 * 입력을 agent.continue 를 붙들어 재현한다. 형제 wake 는 agent.state.isStreaming 만 보므로 그 창에서 turn 을 시작하려 들고,
 * 사용자 prompt 는 in-flight 를 포함한 세션 isStreaming 에 걸려 큐로 간다. 붙드는 것은 steering 큐에 남긴 steer 가 있을
 * 때의 첫 continue 하나뿐이다(그 steer 를 이어받는 continuation).
 */
async function gapScenario(start: () => Promise<unknown>, intrude: () => Promise<void>, novaExpected: number) {
	phase = "strand";
	const before = { parent: relays().length, nova: novaRelays().length, brackets: brackets.length };
	sectionMaxOpenBrackets = 0;
	let intruded = false;
	raceAgent.continue = async function (this: unknown, ...args: unknown[]) {
		if (!intruded && session.agent.peekSteeringQueue().length > 0) {
			intruded = true;
			await intrude();
			await settle(400);
		}
		return await originalContinue.apply(this, args);
	};
	await start().catch(() => {});
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && (relays().length < before.parent + 1 || novaRelays().length < before.nova + novaExpected)) {
		await settle(200);
	}
	// 늦게 오는 중복까지 본다.
	await settle(3000);
	Reflect.deleteProperty(raceAgent, "continue");
	return {
		intruded,
		parent: relays().length - before.parent,
		nova: novaRelays().length - before.nova,
		brackets: brackets.slice(before.brackets),
		maxOpen: sectionMaxOpenBrackets,
	};
}
const novaWake = (body: string) => async () => {
	await bus.send({ from: "Nova", to: "Sol", body });
};

console.log("\n[6] 관찰된 사용자 prompt 가 남긴 부모 steer 를 이어받는 continuation 창에 형제 wake 가 들어와도, 부모·형제 모두 정확히 1건 받는다");
// 18.6.3 은 사용자 prompt 를 관찰하고, 그 관찰은 settle 까지 열려 있다. 부모 steer 는 그 관찰에 adopted 로 실려 있다.
const userGap = await gapScenario(() => session.prompt("사용자 turn (창)"), novaWake("형제 wake (사용자 창)"), 1);
check("창 안에 끼어들었다(남긴 steer 를 이어받는 continue 를 붙들었다)", userGap.intruded);
check("부모는 남긴 steer 에 정확히 1건 받는다(adopted 답이 빠지지 않는다)", userGap.parent === 1, `n=${userGap.parent} brackets=${JSON.stringify(userGap.brackets)}`);
check("창 안에 들어온 형제 wake 도 정확히 1건 받는다", userGap.nova === 1, `n=${userGap.nova}`);
check("이 구간에서도 bracket 은 동시에 하나만 열린다", userGap.maxOpen === 1, `max=${userGap.maxOpen}`);

console.log("\n[7] 관찰 없는 turn 이 남긴 부모 steer 를 이어받는 continuation 이 자기 bracket 을 연 창에 형제 wake 가 들어와도, 부모·형제 모두 정확히 1건 받는다");
// 에이전트 귀속 prompt 는 관찰되지 않는다. 실행 중 turn 은 입양 bracket 이 억제로 닫고, 이어받는 continuation 이 자기
// bracket(#beginIrcSteerContinuationObservation)을 연 채 창에 머문다.
const agentGap = await gapScenario(() => session.prompt("에이전트 turn (창)", { attribution: "agent" }), novaWake("형제 wake (에이전트 창)"), 1);
check("창 안에 끼어들었다(남긴 steer 를 이어받는 continue 를 붙들었다)", agentGap.intruded);
check("부모는 남긴 steer 에 정확히 1건 받는다", agentGap.parent === 1, `n=${agentGap.parent} brackets=${JSON.stringify(agentGap.brackets)}`);
check("창 안에 들어온 형제 wake 도 정확히 1건 받는다", agentGap.nova === 1, `n=${agentGap.nova}`);
check("이 구간에서도 bracket 은 동시에 하나만 열린다", agentGap.maxOpen === 1, `max=${agentGap.maxOpen}`);

console.log("\n[8] 같은 continuation 창에 사용자 prompt 가 들어오면 큐로 가고, 부모는 정확히 1건 받으며 bracket 은 겹치지 않는다");
const promptGap = await gapScenario(
	() => session.prompt("에이전트 turn (사용자 창)", { attribution: "agent" }),
	async () => {
		void session.prompt("사용자 끼어듦", { streamingBehavior: "followUp" }).catch(() => {});
	},
	0,
);
check("창 안에 끼어들었다(남긴 steer 를 이어받는 continue 를 붙들었다)", promptGap.intruded);
check("부모는 남긴 steer 에 정확히 1건 받는다", promptGap.parent === 1, `n=${promptGap.parent} brackets=${JSON.stringify(promptGap.brackets)}`);
check("형제에게는 아무것도 가지 않는다", promptGap.nova === 0, `n=${promptGap.nova}`);
check("이 구간에서도 bracket 은 동시에 하나만 열린다", promptGap.maxOpen === 1, `max=${promptGap.maxOpen}`);

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
