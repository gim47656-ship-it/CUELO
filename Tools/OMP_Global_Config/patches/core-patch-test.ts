// 교차 세션 IRC 라우팅 패치 검증. 실행:
//   bun run ~/.omp/core-patch-test.ts
// 동적 import 예외: 정적 import는 `@oh-my-pi/pi-coding-agent`를 bun 전역 캐시의
// 미패치 사본으로 해석한다. 이 테스트는 omp-web이 실제로 적재하는 사본만 검증해야
// 하므로 디스크 경로를 고정한다(모듈 로딩 경계 테스트).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import steeringReplyGate from "../agent/extensions/steering-reply-gate";
import { createSettingsTestScope, settingsLike } from "./core-test-settings";

/** 전역 npm 위치는 PC마다 다르다. apply-core-patch.mjs 와 같은 순서로 찾는다. */
function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(p => existsSync(join(p, "src/registry/agent-registry.ts")));
	if (!hit) throw new Error(`CUELO 전역 설치를 찾지 못했다: ${candidates.join(", ")}`);
	// 동적 import 는 URL 로 해석되므로 역슬래시를 쓰면 안 된다.
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const { AgentRegistry, MAIN_AGENT_ID } = await import(`${CORE}/registry/agent-registry.ts`);
const { IrcBus } = await import(`${CORE}/irc/bus.ts`);
const { acquireTab, getTabsMapForTest, runInTab } = await import(`${CORE}/tools/browser/tab-supervisor.ts`);

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

const reg = new AgentRegistry();
const fakeSession = () => ({ isStreaming: false }) as never;

// 세션 A: Main + 서브 둘
reg.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: fakeSession() });
reg.register({ id: "A1", displayName: "sub", kind: "sub", parentId: MAIN_AGENT_ID, session: fakeSession() });
reg.register({ id: "A2", displayName: "sub", kind: "sub", parentId: "A1", session: fakeSession() });

// 세션 B: 두 번째 top-level (패치가 Main#2를 할당하는 상황을 재현)
reg.register({ id: "Main#2", displayName: "main", kind: "main", session: fakeSession() });
reg.register({ id: "B1", displayName: "sub", kind: "sub", parentId: "Main#2", session: fakeSession() });

console.log("\n[1] rootOf — 계보 추적");
check("A2 -> Main", reg.rootOf("A2") === MAIN_AGENT_ID, `got ${reg.rootOf("A2")}`);
check("A1 -> Main", reg.rootOf("A1") === MAIN_AGENT_ID, `got ${reg.rootOf("A1")}`);
check("B1 -> Main#2", reg.rootOf("B1") === "Main#2", `got ${reg.rootOf("B1")}`);
check("Main -> Main", reg.rootOf(MAIN_AGENT_ID) === MAIN_AGENT_ID);
check("미등록 id는 자기 자신", reg.rootOf("ghost") === "ghost");

console.log("\n[2] listVisibleTo — 세션 스코프");
const visA1 = reg.listVisibleTo("A1").map(r => r.id).sort();
const visB1 = reg.listVisibleTo("B1").map(r => r.id).sort();
check("A1은 자기 트리만 본다", JSON.stringify(visA1) === JSON.stringify(["A2", MAIN_AGENT_ID]), `got ${JSON.stringify(visA1)}`);
check("A1에게 B 트리는 안 보인다", !visA1.includes("B1") && !visA1.includes("Main#2"));
check("B1은 자기 트리만 본다", JSON.stringify(visB1) === JSON.stringify(["Main#2"]), `got ${JSON.stringify(visB1)}`);
check("B1에게 A 트리는 안 보인다", !visB1.includes("A1") && !visB1.includes(MAIN_AGENT_ID));

console.log("\n[3] 사이클 방어");
const cyc = new AgentRegistry();
cyc.register({ id: "X", displayName: "s", kind: "sub", parentId: "Y", session: null });
cyc.register({ id: "Y", displayName: "s", kind: "sub", parentId: "X", session: null });
check("순환 parentId에서 멈춘다", ["X", "Y"].includes(cyc.rootOf("X")));

console.log("\n[4] IrcBus — to:'Main' 별칭 해석과 교차 세션 차단");
const bus = new IrcBus(reg);
const r1 = await bus.send({ from: "B1", to: MAIN_AGENT_ID, body: "ping" });
check("B1의 to:Main은 A의 Main으로 가지 않는다", r1.to !== MAIN_AGENT_ID, `to=${r1.to}`);
check("B1의 to:Main은 Main#2로 재해석된다", r1.to === "Main#2", `to=${r1.to}`);

const r2 = await bus.send({ from: "B1", to: "A1", body: "ping" });
check("B1 -> A1 교차 세션은 거절된다", r2.outcome === "failed", `outcome=${r2.outcome}`);
check("거절 사유가 다른 세션임을 밝힌다", (r2.error ?? "").includes("different top-level session"), `err=${r2.error}`);

const r3 = await bus.send({ from: "A2", to: "A1", body: "ping" });
check("같은 트리 내 전송은 차단되지 않는다", r3.outcome !== "failed" || !(r3.error ?? "").includes("different top-level session"), `outcome=${r3.outcome} err=${r3.error}`);

console.log("\n[5] subagent roster — 로스터 스코프 (collectIrcPeerRoster)");
// 18.3.0은 `hub list` 를 없앴고, SubAgent 는 spawn 시점 시스템 프롬프트 roster 로 피어를 본다.
// 그 live 행은 listVisibleTo 를 쓰므로 rootOf 범위 항목이 그대로 덮는다(parked 는 이름 없이 수만).
const { collectIrcPeerRoster } = await import(`${CORE}/task/executor.ts`);
const rosterIds = (id: string) => collectIrcPeerRoster(reg, id).peers.map((p: { id: string }) => p.id).sort();
const rosterB1 = rosterIds("B1");
check("B1 로스터에 A 트리가 없다", !rosterB1.includes("A1") && !rosterB1.includes("A2"), JSON.stringify(rosterB1));
check("B1 로스터에 A의 Main이 없다", !rosterB1.includes(MAIN_AGENT_ID), JSON.stringify(rosterB1));
const rosterA1 = rosterIds("A1");
check("A1 로스터에 B 트리가 없다", !rosterA1.includes("Main#2") && !rosterA1.includes("B1"), JSON.stringify(rosterA1));
check("A1 로스터에 자기 트리는 있다", rosterA1.includes("A2"), JSON.stringify(rosterA1));

console.log("\n[6] read proc:// · wait — 실행 중 SubAgent 스코프 (runningAgentsOutsideJobs)");
// job 이 없는 실행 중 SubAgent 목록. 18.3.0은 이 함수를 async/job-control.ts 로 옮겼고
// `read proc://` 목록·`/kill` 대상 탐색·빈 `wait` 가 모두 이것을 쓴다.
const { runningAgentsOutsideJobs } = await import(`${CORE}/async/job-control.ts`);
const asSession = (id: string) => ({ agentRegistry: reg, getAgentId: () => id, asyncJobManager: undefined }) as never;
const jobsA1 = runningAgentsOutsideJobs(asSession("A1")).map((a: { id: string }) => a.id).sort();
const jobsB1 = runningAgentsOutsideJobs(asSession("B1")).map((a: { id: string }) => a.id).sort();
check("A1의 목록에 B 트리가 없다", !jobsA1.includes("B1"), `got ${JSON.stringify(jobsA1)}`);
check("A1의 목록에 자기 트리는 있다", jobsA1.includes("A2"), `got ${JSON.stringify(jobsA1)}`);
check("B1의 목록에 A 트리가 없다", !jobsB1.includes("A1") && !jobsB1.includes("A2"), `got ${JSON.stringify(jobsB1)}`);


console.log("\n[7] browser tab worker — 종료 후 abort 전송 예외 격리");
// 실제 장애 순서를 최소 재현한다. run 메시지는 받아 둔 뒤 워커가 terminate 된 것처럼
// abort 메시지에서 InvalidStateError 를 던진다. AbortSignal 리스너의 예외는
// AbortController.abort() 호출자에게 동기 전파되므로 격리되지 않으면 여기서 즉시 실패한다.
// 18.1.17 에서는 그 격리가 우리 EDITS(try/catch)였고, 18.1.18 은 같은 자리를 upstream 의
// safeSend(state 가드 + try/catch, issue #11707)로 옮겼다. 패치 항목에서 뺀 이유가 그것이며,
// 이 검사는 이제 "설치본이 그 보장을 지키는가"를 구현 주체와 무관하게 본다: 호출자에게
// 던지지 않고, 전송이 실패해도 pending tool call 정리를 계속한다.
const tabs = getTabsMapForTest() as Map<string, unknown>;
const pendingRuns = new Map<string, {
	resolve(value: { displays: []; returnValue: unknown; screenshots: [] }): void;
	toolCalls: Map<string, { abort(reason?: unknown): void }>;
}>();
let toolCallAborted = false;
const { promise: runDispatched, resolve: markRunDispatched } = Promise.withResolvers<void>();
const deadWorkerTab = {
	name: "dead-worker-abort-test",
	state: "alive",
	backend: "worker",
	pending: pendingRuns,
	worker: {
		mode: "worker",
		send(message: { type: string }): void {
			if (message.type === "run") markRunDispatched();
			if (message.type === "abort") throw new DOMException("Worker has been terminated", "InvalidStateError");
		},
	},
};
tabs.set(deadWorkerTab.name, deadWorkerTab);
const abortController = new AbortController();
const runPromise = runInTab(deadWorkerTab.name, {
	code: "await wait(60_000)",
	timeoutMs: 60_000,
	signal: abortController.signal,
	session: { settings: settingsLike({ get: () => undefined }) } as never,
});
await runDispatched;
const pendingRun = [...pendingRuns.values()][0]!;
pendingRun.toolCalls.set("in-flight", { abort: () => { toolCallAborted = true; } });
let abortThrew = false;
try {
	abortController.abort();
} catch {
	abortThrew = true;
}
check("종료된 워커 abort 전송이 호출자까지 던지지 않는다", !abortThrew);
check("전송 실패 뒤에도 pending tool call을 abort한다", toolCallAborted);
pendingRun.resolve({ displays: [], returnValue: undefined, screenshots: [] });
await runPromise;
tabs.delete(deadWorkerTab.name);

console.log("\n[8] browser.open Relay 기본값 — 사용자 탭을 빼앗지 않는다");
// 검사 대상인 buildInitPayload 는 모듈 내부 함수라 acquireTab 으로 관찰한다.
// 가짜 브라우저의 target id 조회에서 일부러 던져 워커 생성 직전에 멈추므로,
// 실제 Chrome·워커 없이 "워커에게 넘길 페이지로 무엇을 골랐는가"만 남는다.
// 그 페이지가 곧 opts.url 로 goto 될 페이지다.
// tab-supervisor 는 이미 위에서 한 번 import 했다(같은 모듈 인스턴스를 써야 한다).
const SENTINEL = "stop-before-worker";
const picked: string[] = [];
let createdCount = 0;

function makeFakePage(id: string, url: string, title: string, visible: boolean) {
	const target = {
		type: () => "page",
		page: async () => page,
		// 여기까지 온 페이지가 워커에 넘겨질 페이지다. id 만 남기고 멈춘다.
		createCDPSession: async () => {
			picked.push(id);
			throw new Error(SENTINEL);
		},
	};
	const page = {
		id,
		url: () => url,
		title: async () => title,
		evaluate: async () => visible,
		target: () => target,
	};
	return page;
}

const ompweb = makeFakePage("user-ompweb", "http://127.0.0.1:5199/session", "CUELO", true);
const erp = makeFakePage("user-erp", "https://erp.example.com/work", "ERP 작업", false);
const fakeBrowser = {
	connected: false,
	wsEndpoint: () => "ws://127.0.0.1:9224/devtools/browser/fake",
	targets: () => [ompweb.target(), erp.target()],
	pages: async () => [ompweb, erp],
	newPage: async () => {
		createdCount++;
		return makeFakePage(`created-${createdCount}`, "about:blank", "", true);
	},
};
const handleBase = {
	browser: fakeBrowser,
	cdpUrl: "http://127.0.0.1:9224",
	// 0 이 되면 dispose 로 들어간다. 이 테스트는 handle 을 계속 쓴다.
	refCount: 1,
	stealth: { browserSession: null, override: null },
};
const relayHandle = { ...handleBase, key: "fake-relay", kind: { kind: "relay" } } as never;
const connectedHandle = { ...handleBase, key: "fake-connected", kind: { kind: "connected" } } as never;

async function openAndCatch(name: string, handle: never, opts: Record<string, unknown>): Promise<string> {
	try {
		await acquireTab(name, handle, { timeoutMs: 5_000, ...opts });
		return "no-throw";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

// 각 케이스는 "이번 open이 탭을 새로 만들었는가"만 본다. 누적값을 박아 두면 앞
// 케이스의 실패가 뒤 케이스까지 빨갛게 만들어 원인이 흐려진다.
let createdBefore = createdCount;
const openDefault = await openAndCatch("relay-default", relayHandle, { url: "https://example.com/docs" });
check("target 없는 Relay open은 새 탭을 만든다", createdCount === createdBefore + 1, `delta=${createdCount - createdBefore} err=${openDefault}`);
check("작업은 새로 만든 탭에서 진행된다", picked.at(-1)?.startsWith("created-") === true, `picked=${JSON.stringify(picked)}`);
check("사용자가 보던 탭을 채택하지 않는다", !picked.some(id => id.startsWith("user-")), `picked=${JSON.stringify(picked)}`);

createdBefore = createdCount;
const openTargeted = await openAndCatch("relay-target", relayHandle, { url: "https://example.com/docs", target: "erp" });
check("명시 target은 기존 탭을 그대로 고른다", picked.at(-1) === "user-erp", `picked=${JSON.stringify(picked)} err=${openTargeted}`);
check("명시 target일 때는 새 탭을 만들지 않는다", createdCount === createdBefore, `delta=${createdCount - createdBefore}`);

createdBefore = createdCount;
const openNoMatch = await openAndCatch("relay-nomatch", relayHandle, { target: "없는-탭-이름" });
check("일치하는 target이 없으면 새 탭 없이 실패한다", createdCount === createdBefore && openNoMatch.includes("No page target matched"), `delta=${createdCount - createdBefore} err=${openNoMatch}`);

createdBefore = createdCount;
const openConnected = await openAndCatch("cdp-default", connectedHandle, { url: "https://example.com/docs" });
check("connected(CDP)는 기존대로 보이는 탭을 채택한다", picked.at(-1) === "user-ompweb", `picked=${JSON.stringify(picked)} err=${openConnected}`);
check("connected는 새 탭을 만들지 않는다", createdCount === createdBefore, `delta=${createdCount - createdBefore}`);

// 같은 이름 재개방: 새 탭을 또 만들지 않고 살아있는 탭을 재사용한다(기존 계약).
tabs.set("relay-reuse", {
	name: "relay-reuse",
	browser: relayHandle,
	state: "alive",
	backend: "worker",
	kindTag: "relay",
	targetId: "created-1",
	dialogPolicy: undefined,
	pending: new Map(),
	worker: {},
	info: { url: "about:blank", viewport: { width: 800, height: 600 }, targetId: "created-1" },
});
createdBefore = createdCount;
const reused = await acquireTab("relay-reuse", relayHandle, { timeoutMs: 5_000 });
check("같은 이름 재개방은 기존 작업 탭을 재사용한다", reused.created === false, `created=${reused.created}`);
check("재사용은 새 탭을 만들지 않는다", createdCount === createdBefore, `delta=${createdCount - createdBefore}`);
tabs.delete("relay-reuse");
console.log("\n[9] 살아 있는 SubAgent 의 최종 yield — 부모에게 정확히 한 번 전달된다");
// 2026-09-12 실장애 재현. idle 배달은 monitored wake turn 이 되어 relay 가 나갔지만
// (00:50:20 도착), 실행 중 배달은 steer 로 꽂혀 관찰자 없는 continuation turn 이 되고
// 그 turn 의 최종 yield(00:54:47)는 부모에게 어떤 알림도 내지 않았다. 최초 spawn 의 job
// row 는 이미 정산됐으므로 자동 전달 경로가 둘 다 비어 38m14s 를 잃었다.
//
// 여기서는 진짜 배선을 태운다: 진짜 IrcBus/AgentRegistry/IrcBridge 로 배달 분기를 고르고,
// executor 의 attachIrcWakeTurnMonitor 관찰자 + 진짜 yield subprocess 핸들러 +
// finalizeRunResult 로 turn 을 정산한다. 모델 호출은 없다. 세션 자리(관찰자 설치·turn
// 이벤트·continuation 시작)만 fixture 이며, 그 세션 쪽 배선이 실제로 설치됐는지는
// apply-core-patch.mjs --check 의 marker 가 본다.
const { IrcBridge } = await import(`${CORE}/session/irc-bridge.ts`);
const { attachIrcWakeTurnMonitor } = await import(`${CORE}/task/executor.ts`);
const artifactsDir = mkdtempSync(join(tmpdir(), "omp-relay-repro-"));
const globalReg = AgentRegistry.global();
const globalBus = IrcBus.global();

/** 부모(Main)와 남의 트리(Main#2). 받은 것만 기록하는 수신함이다. */
const inbox: Record<string, { from: string; to: string; body: string; replyTo?: string; wakeRelay?: boolean }[]> = {
	[MAIN_AGENT_ID]: [],
	"Main#2": [],
};
const mailboxSession = (id: string) =>
	({
		deliverIrcMessage: async (m: (typeof inbox)[string][number]) => {
			inbox[id]!.push(m);
			return "injected";
		},
		// executeSend await(true)의 종료 감시(awaitTarget)가 대상 세션을 구독한다.
		// 이 하네스의 수신함은 종료 이벤트를 내지 않으므로 no-op 구독으로 충분하다.
		subscribe: () => () => {},
	}) as never;
globalReg.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: mailboxSession(MAIN_AGENT_ID) });
globalReg.register({ id: "Main#2", displayName: "main", kind: "main", session: mailboxSession("Main#2") });
globalReg.register({ id: "Zeta", displayName: "sub", kind: "sub", parentId: "Main#2", session: mailboxSession("Main#2") });

// SubAgent 쪽: IrcBridgeHost 와 AgentSession 은 실제로도 서로 다른 객체다
// (AgentSession 이 어댑터 리터럴을 만들어 IrcBridge 에 넘긴다). 같은 상태를 공유한다.
let streaming = false;
let lastAssistant: unknown = undefined;
const steered: unknown[] = [];
const listeners = new Set<(event: unknown) => void>();
const ircReplies: Promise<void>[] = [];
let wakeObserver: ((records: unknown[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
let wokenRecords: unknown[] | undefined;

/** 실행 중 turn 에 꽂힌 부모 steer 는 bridge 가 세션에게 "지금 도는 turn 을 채택하라"고
 *  알려야 한다. 그 판정 자체는 세션 내부(#adoptParentSteerForRunningTurn)라 실제
 *  AgentSession 스모크가 보고, 여기서는 bridge → 세션 호출 계약만 관찰한다. */
let adoptRequests = 0;
const host = {
	agent: { steer: (m: unknown) => steered.push(m) },
	sessionManager: { appendCustomMessageEntry: () => {} },
	settings: settingsLike({ get: () => false }),
	isDisposed: () => false,
	isStreaming: () => streaming,
	planModeEnabled: () => false,
	emitSessionEvent: async () => {},
	wakeForIrc: (records: unknown[]) => {
		wokenRecords = records;
	},
	adoptParentSteerForRunningTurn: () => {
		adoptRequests++;
	},
	runEphemeralTurn: async () => ({ replyText: "" }),
} as never;
const bridge = new IrcBridge(host);

const subSession = {
	deliverIrcMessage: (m: unknown, o: unknown) => bridge.deliver(m, o),
	setIrcWakeTurnObserver: (o: typeof wakeObserver) => {
		wakeObserver = o;
	},
	trackIrcReply: (p: Promise<void>) => {
		ircReplies.push(p);
	},
	subscribe: (cb: (event: unknown) => void) => {
		listeners.add(cb);
		return () => listeners.delete(cb);
	},
	getLastAssistantMessage: () => lastAssistant,
	isAdvisorActive: () => false,
	servingModel: undefined,
	hasPendingAsyncWork: () => false,
	abort: async () => {},
	waitForIdle: async () => {},
	// 18.2.1 의 wake 관찰자는 turn 시작마다 세션의 yield 툴 상태를 초기화한다
	// (`resetYieldTurnState(session.getToolByName("yield"))`). 이 하네스는 yield 를
	// subprocess 핸들러로 직접 태우므로 세션 툴을 모델링하지 않는다 - 관찰자가 요구하는
	// 세션 표면만 채운다(`resetYieldTurnState` 는 undefined 를 받아들이는 계약이다).
	getToolByName: () => undefined,
} as never;
globalReg.register({ id: "Sol", displayName: "maker", kind: "sub", parentId: MAIN_AGENT_ID, session: subSession });

// 최초 run 이 끝난 뒤 executor 가 거는 관찰자(installIrcWakeTurnMonitor 와 같은 호출).
attachIrcWakeTurnMonitor(subSession, {
	id: "Sol",
	agent: { name: "maker", source: "project", description: "harness" },
	artifactsDir,
});

/** yield 로 끝나는 turn 하나. 진짜 yield subprocess 핸들러가 종료를 판정한다. */
async function runYieldTurn(text: string): Promise<void> {
	streaming = true;
	const emit = (event: unknown) => {
		for (const l of [...listeners]) l(event);
	};
	emit({ type: "message_start", message: { role: "assistant" } });
	emit({ type: "tool_execution_start", toolName: "yield", toolCallId: "y", args: {} });
	emit({
		type: "tool_execution_end",
		toolName: "yield",
		toolCallId: "y",
		args: {},
		isError: false,
		result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success", data: { text } } },
	});
	lastAssistant = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
	streaming = false;
}

/** yield 없이 오류로 끝나는 turn. 실제 실패와 같은 자리(마지막 assistant 의
 *  stopReason="error")를 태워 executor 가 실패 결과를 정산하게 한다. */
async function runFailedTurn(): Promise<void> {
	streaming = true;
	for (const l of [...listeners]) l({ type: "message_start", message: { role: "assistant" } });
	lastAssistant = {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		stopReason: "error",
		errorMessage: "provider stream failed",
	};
	streaming = false;
}

/** yield 없이 중단으로 끝나는 turn. stopReason="aborted"를 태워 executor 가
 *  aborted 플래그로 정산(취소 봉투)하게 한다. error 경로와 다른 분기다. */
async function runAbortedTurn(): Promise<void> {
	streaming = true;
	for (const l of [...listeners]) l({ type: "message_start", message: { role: "assistant" } });
	lastAssistant = {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		stopReason: "aborted",
	};
	streaming = false;
}

/** 실제 turn 은 분 단위라 relay 억제 판정(bus.sentSince)이 turn 시작 시각과 명확히
 *  갈리지만, 하네스는 같은 밀리초 안에서 끝난다. turn 경계마다 벽시계를 실제로
 *  넘겨 두 turn 이 시간상 겹치지 않게 한다. */
function nextTurnBoundary(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 5);
	return promise;
}

/** AgentSession#wakeForIrc 의 계약: 관찰자를 열고 turn 을 돌린 뒤 settle 에서 닫는다. */
async function driveWakeTurn(records: unknown[], text: string): Promise<void> {
	await nextTurnBoundary();
	const finish = wakeObserver?.(records);
	await runYieldTurn(text);
	await finish?.(undefined);
	await Promise.all(ircReplies.splice(0));
}

/** 패치가 IrcBridge 에 더하는 계약 접근자. 패치 전 사본에는 아예 없어서 relay 가
 *  0건이 되고, 그것이 곧 재현하려는 결함이다(에러가 아니라 RED 로 나온다). */
type SteerRelayEntry = { steered: unknown; record: unknown };
type SteerRelayApi = {
	takeParentSteerRelays?: (monitored: boolean) => SteerRelayEntry[];
	reconcileParentSteerRelays?: (queued: readonly unknown[]) => void;
	queueParentSteerRelay?: (...entries: SteerRelayEntry[]) => void;
};
const relayApi = bridge as unknown as SteerRelayApi;
const takeSteerRelays = (monitored: boolean): SteerRelayEntry[] => relayApi.takeParentSteerRelays?.(monitored) ?? [];

/** `steered` 는 이 하네스의 agent-core steering 큐다: bridge 가 실제로 `agent.steer`
 *  로 밀어 넣은 그 객체가 그대로 쌓이고, turn 이 읽어 가면 앞에서부터 빠진다. */
function consumeSteeringQueue(count: number | "all" = "all"): unknown[] {
	return count === "all" ? steered.splice(0) : steered.splice(0, count);
}

/** 패치된 AgentSession#scheduleAgentContinue 와 같은 순서다: 관찰자 유무를 먼저 읽어
 *  그대로 bridge 에 넘기고, 소비할지 남길지는 실제 bridge 코드가 정한다. 하네스가
 *  먼저 꺼내 보는 식으로 순서를 뒤집으면 결함이 숨으므로 이 순서를 고정한다.
 *  `opts.consume` 은 이 turn 이 steering 큐에서 실제로 읽어 간 개수(기본 전부),
 *  `opts.failWith` 는 turn 이 yield 없이 실패로 끝났는지, `opts.abortTurn` 은
 *  turn 이 yield 없이 중단(stopReason="aborted")으로 끝났는지, `duringTurn` 은 turn 안에서
 *  에이전트가 직접 하는 행동(예: 부모에게 직접 답장)이다. */
async function driveSteerContinuation(
	text: string,
	opts: { consume?: number | "all"; failWith?: unknown; abortTurn?: boolean; duringTurn?: () => Promise<unknown> } = {},
): Promise<void> {
	await nextTurnBoundary();
	const observer = wakeObserver;
	const entries = takeSteerRelays(observer !== undefined);
	const finish =
		observer !== undefined && entries.length > 0 ? observer(entries.map(entry => entry.record)) : undefined;
	consumeSteeringQueue(opts.consume ?? "all");
	await opts.duringTurn?.();
	if (opts.abortTurn) await runAbortedTurn();
	else if (opts.failWith === undefined) await runYieldTurn(text);
	else await runFailedTurn();
	await finish?.(opts.abortTurn ? undefined : opts.failWith);
	await Promise.all(ircReplies.splice(0));
	settleTurn();
}

/** 패치된 AgentSession#drainStrandedQueuedMessages 의 정산 한 줄 그대로:
 *  `this.#irc.reconcileParentSteerRelays(this.agent.peekSteeringQueue())`.
 *  큐의 실제 내용(어느 메시지 객체가 남았는지)만으로 판정하며, 하네스는 boolean 을
 *  대신 넘기지 않는다. */
function settleTurn(): void {
	relayApi.reconcileParentSteerRelays?.(steered);
}

const relays = () => inbox[MAIN_AGENT_ID]!.filter(m => m.wakeRelay === true);
const results = () => relays().filter(m => m.body.includes("<task-result"));
// 실패·취소 turn 의 relay 본문은 `<task-result>` 봉투가 아니라 실패 원인 +
// `history://<id>` 포인터를 담은 통지다(18.2.1 executor `buildWakeRelayBody`).
// 봉투를 싣는 것은 yield 로 끝난 turn 뿐이므로 그 계약은 본문 자체로 확인한다.

// (1) idle 배달 → monitored wake turn → relay 1건. 실제로 동작하던 대조군이다.
const wake = await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "1차 지시" });
check("idle 배달은 wake 로 접수된다", wake.outcome === "woken", `outcome=${wake.outcome}`);
await driveWakeTurn(wokenRecords ?? [], "첫 산출물");
check("wake turn 의 yield 는 부모에게 전달된다", results().length === 1, `relays=${results().length}`);
check(
	"전달된 것은 task-result 봉투다",
	(results()[0]?.body ?? "").includes('id="Sol"') && (results()[0]?.body ?? "").includes('status="completed"'),
	(results()[0]?.body ?? "").slice(0, 120),
);

// (2) 실행 중 배달 → steer. 이 turn 은 마지막 poll 을 놓쳐 steering 큐에 남긴다.
streaming = true;
const steer = await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "이어서 마무리해라" });
streaming = false;
check("실행 중 배달은 steer 로 꽂힌다", steer.outcome === "injected", `outcome=${steer.outcome}`);
check("steer 는 실제 steering 큐에 들어간다", steered.length === 1, `queued=${steered.length}`);
check(
	"실행 중 배달은 지금 도는 turn 을 채택하라고 세션에 알린다",
	adoptRequests === 1,
	`requests=${adoptRequests}`,
);
settleTurn();

// (3) 밀린 steer 를 잇는 continuation turn 의 최종 yield. 이것이 실장애에서 사라진 결과다.
const before = results().length;
await driveSteerContinuation("최종 산출물");
check("steer 연속 turn 의 최종 yield 도 부모에게 전달된다", results().length === before + 1, `relays=${results().length}`);
check(
	"연속 turn 의 봉투도 같은 id/상태를 싣는다",
	(results()[1]?.body ?? "").includes('id="Sol"') && (results()[1]?.body ?? "").includes('status="completed"'),
	(results()[1]?.body ?? "").slice(0, 120),
);
check("중복 전달은 없다", results().length === 2, `relays=${results().length}`);
check("relay 는 등록된 부모에게만 간다", relays().every(m => m.to === MAIN_AGENT_ID && m.from === "Sol"));
check("남의 트리는 아무것도 받지 않는다", inbox["Main#2"]!.length === 0, `n=${inbox["Main#2"]!.length}`);

// (4) turn 안에서 스스로 답한 경우는 중복으로 또 보내지 않는다(기존 sentSince 억제).
streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "상태 알려라" });
streaming = false;
settleTurn();
const beforeSelfAnswer = results().length;
await driveSteerContinuation("직접 답한 뒤의 yield", {
	duringTurn: () => globalBus.send({ from: "Sol", to: MAIN_AGENT_ID, body: "직접 답한다" }),
});
check("직접 답한 turn 은 relay 를 덧붙이지 않는다", results().length === beforeSelfAnswer, `relays=${results().length}`);

// (5) 최초 run 이 아직 job 소유(관찰자 미설치)면 relay 를 만들지 않고, 빚도 소모하지 않는다.
const monitorObserver = wakeObserver;
subSession.setIrcWakeTurnObserver(undefined);
streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "최초 run 중 지시" });
streaming = false;
settleTurn();
const beforeJobOwned = relays().length;
await driveSteerContinuation("최초 run 의 yield", { consume: 0 });
check("job 이 소유한 run 에는 relay 를 겹치지 않는다", relays().length === beforeJobOwned, `relays=${relays().length}`);
check("소비되지 않은 부모 steer 는 큐에 그대로 남는다", steered.length === 1, `queued=${steered.length}`);

// (5b) 그 빚은 사라지지 않는다: job 이 정산돼 관찰자가 붙으면 그것을 소비하는
//      continuation 이 정확히 1건 답한다.
subSession.setIrcWakeTurnObserver(monitorObserver);
const beforeHandover = results().length;
await driveSteerContinuation("job 정산 뒤 이어받은 yield");
check(
	"job 소유 중 밀린 steer 는 관찰자가 붙은 뒤 정확히 1건 답한다",
	results().length === beforeHandover + 1,
	`relays=${results().length}`,
);

// (6) 반대로 job turn 이 그 steer 를 실제로 소비했으면 빚은 그 자리에서 사라진다.
//     이후 관찰자가 붙고 무관한 continuation 이 돌아도 relay 는 0건이다.
subSession.setIrcWakeTurnObserver(undefined);
streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "job turn 이 소비한 지시" });
streaming = false;
consumeSteeringQueue();
settleTurn();
subSession.setIrcWakeTurnObserver(monitorObserver);
const beforeUnrelated = relays().length;
await driveSteerContinuation("무관한 continuation 의 yield");
check(
	"정산된 job 의 steer 는 무관한 뒤 continuation 으로 새지 않는다",
	relays().length === beforeUnrelated,
	`relays=${relays().length}`,
);

// (6b) 혼합 큐. 부모 steer 는 소비됐고 advisor card·follow-up 만 큐에 남았다.
//      "큐가 비었나" boolean 으로 정산하면 여기서 이미 답한 빚이 살아남아,
//      다음 무관한 continuation 이 남의 결과를 부모 답으로 보낸다.
streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "혼합 큐 지시" });
streaming = false;
consumeSteeringQueue();
const advisorTail = { role: "user", content: [{ type: "text", text: "advisor card" }], attribution: "advisor" };
steered.push(advisorTail);
settleTurn();
const beforeMixed = relays().length;
await driveSteerContinuation("혼합 큐 뒤 continuation 의 yield");
check(
	"소비된 부모 steer 는 무관한 큐 잔여물 때문에 살아남지 않는다",
	relays().length === beforeMixed,
	`relays=${relays().length}`,
);

// (6c) 반대 방향. 부모 steer 자체가 큐 tail 로 남아 있으면 정확히 1건 답한다.
streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "먼저 온 지시" });
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "뒤에 온 지시" });
streaming = false;
consumeSteeringQueue(1);
settleTurn();
check("tail 로 남은 부모 steer 는 큐에 그대로다", steered.length === 1, `queued=${steered.length}`);
const beforeTail = results().length;
await driveSteerContinuation("남은 부모 tail 의 yield");
check("큐에 남은 부모 steer 는 정확히 1건 답한다", results().length === beforeTail + 1, `relays=${results().length}`);

// (7) 세션 경계. 전환이 큐를 비우면 빚도 함께 물러나고, 롤백하면 함께 되살아난다.
streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "전환 직전 지시" });
streaming = false;
settleTurn();
const ircSnapshot = bridge.clearPending();
const queuedSnapshot = steered.splice(0);
const beforeCleared = relays().length;
await driveSteerContinuation("전환 뒤 turn 의 yield");
check("세션 전환이 지운 steer 는 relay 되지 않는다", relays().length === beforeCleared, `relays=${relays().length}`);
bridge.restorePending(ircSnapshot);
steered.push(...queuedSnapshot);
const beforeRestored = results().length;
await driveSteerContinuation("롤백 뒤 turn 의 yield");
check("롤백된 전환은 relay 빚도 되살린다", results().length === beforeRestored + 1, `relays=${results().length}`);

// (8) turn 이 실제로 돌지 않은 경우(outcome skipped)는 빚을 재무장해 다음 turn 이 답한다.
streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "skipped 직전 지시" });
streaming = false;
relayApi.queueParentSteerRelay?.(...takeSteerRelays(true));
settleTurn();
const beforeRearm = results().length;
await driveSteerContinuation("재무장 뒤의 yield");
check("skipped 로 재무장된 빚은 다음 turn 이 정확히 1건 답한다", results().length === beforeRearm + 1, `relays=${results().length}`);

// (9) 실패로 끝난 continuation. job 도 없고 yield 도 없지만 부모는 종료를 알아야 한다.
//     18.2.1 은 본문을 `<task-result>` 봉투가 아니라 실패 원인 + `history://<id>` 포인터로
//     만든다. artifact 없이 끝난 실패를 봉투로 보고하지 않는다는 그 계약을 함께 고정한다.
streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "실패할 지시" });
streaming = false;
settleTurn();
const beforeFailure = relays().length;
await driveSteerContinuation("", { failWith: new Error("provider stream failed") });
const failureBody = relays()[relays().length - 1]?.body ?? "";
check(
	"실패한 continuation 도 부모에게 정확히 1건 알린다",
	relays().length === beforeFailure + 1,
	`relays=${relays().length - beforeFailure}`,
);
check(
	"실패 통지는 실패 원인과 추적 포인터를 담고 결과 artifact 를 주장하지 않는다",
	failureBody.includes("provider stream failed") &&
		failureBody.includes("history://Sol") &&
		!failureBody.includes("<task-result"),
	failureBody.slice(0, 200),
);

// (10) 실패했더라도 그 turn 안에서 부모에게 직접 답했으면 그 답을 되풀이하지 않는다.
//      완료 turn 은 `sentSince` 로 억제되지만 실패 turn 은 "보냈다"와 "답했다"를 구분할 수
//      없어 통지가 한 건 더 간다(18.2.1 설계). 그 통지가 답을 복사하지 않는지가 계약이다.
streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "실패 전에 직접 답할 지시" });
streaming = false;
settleTurn();
const beforeFailureSelfAnswer = relays().length;
await driveSteerContinuation("", {
	failWith: new Error("provider stream failed"),
	duringTurn: () => globalBus.send({ from: "Sol", to: MAIN_AGENT_ID, body: "실패 전 직접 보고" }),
});
const selfAnsweredFailureBody = relays()[relays().length - 1]?.body ?? "";
check(
	"직접 답한 실패 turn 의 통지는 그 답을 되풀이하지 않는다",
	relays().length === beforeFailureSelfAnswer + 1 &&
		selfAnsweredFailureBody.includes("provider stream failed") &&
		!selfAnsweredFailureBody.includes("실패 전 직접 보고"),
	`relays=${relays().length - beforeFailureSelfAnswer} body=${selfAnsweredFailureBody.slice(0, 200)}`,
);

// (9b) 중단으로 끝난 continuation. error 가 아니라 stopReason="aborted"이며, executor 는
//      aborted 플래그로 취소 통지를 만든다. 실패 경로와 다른 분기이므로 별도로 고정한다.
streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "중단될 지시" });
streaming = false;
settleTurn();
const beforeAbort = relays().length;
await driveSteerContinuation("", { abortTurn: true });
const abortBody = relays()[relays().length - 1]?.body ?? "";
check(
	"중단된 continuation 도 부모에게 정확히 1건 알린다",
	relays().length === beforeAbort + 1,
	`relays=${relays().length - beforeAbort}`,
);
check(
	"중단 통지는 취소 사실과 추적 포인터를 담는다",
	/cancelled/i.test(abortBody) && abortBody.includes("history://Sol") && !abortBody.includes("<task-result"),
	abortBody.slice(0, 200),
);

// (9c) 사용자 steer 는 부모 빚과 steering 큐를 공유하지만 의무를 만들지도 깨뜨리지도 않는다.
//      advisor card 혼합(6b)의 사용자 버전이다.
streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "사용자 혼합 지시" });
streaming = false;
consumeSteeringQueue();
const userTail = { role: "user", content: "사용자 후속", attribution: "user" };
steered.push(userTail);
settleTurn();
const beforeUserMixed = relays().length;
await driveSteerContinuation("사용자 혼합 뒤 continuation 의 yield");
check(
	"소비된 부모 steer 는 사용자 잔여물 때문에 살아남지 않는다",
	relays().length === beforeUserMixed,
	`relays=${relays().length}`,
);

streaming = true;
await globalBus.send({ from: MAIN_AGENT_ID, to: "Sol", body: "사용자와 함께 온 지시" });
streaming = false;
steered.push({ role: "user", content: "사용자 끼어듦", attribution: "user" });
settleTurn();
const beforeUserLive = results().length;
await driveSteerContinuation("사용자 혼합 속 부모 tail 의 yield");
check("큐에 남은 부모 steer 는 사용자 혼합 속에서도 정확히 1건 답한다", results().length === beforeUserLive + 1, `relays=${results().length}`);

// (9d) 옛 `send await:true` barrier 검사는 18.3.0에서 대상이 사라졌다(`write agent://` 는 비차단이고
//      replyTo·await 가 없다, irc/messaging.ts:43-100). 사용자 steer 잡음이 부모 빚을 만들거나
//      깨뜨리지 않는다는 계약은 (9c)가 계속 지킨다.
steered.splice(0);

console.log("\n[10] wait 결과 — job 없이 실행 중인 SubAgent 도 보인다");
// 사건의 2차 결함: job 이 이미 정산된 뒤 되살아나 일하는 SubAgent 는 어떤 job 행에도
// 없어서, 부모가 받은 bare `wait` 결과에 아예 나타나지 않았다. 18.3.0 `wait`(top-level 전용,
// tools/wait.ts)는 창 없이 첫 사건에 돌아오므로, job 종료로 깬 결과와 미전달 결과 즉시 회수
// 두 반환 지점이 모두 `read proc://` 와 같은 로스터를 싣는지 본다.
const { WaitTool } = await import(`${CORE}/tools/wait.ts`);
const { AsyncJobManager } = await import(`${CORE}/async/job-manager.ts`);
const waitManager = new AsyncJobManager({});
const jobGate = Promise.withResolvers<void>();
waitManager.register("bash", "long job", async () => {
	await jobGate.promise;
	return "done";
}, { ownerId: "A1" });
const waitSession = {
	agentRegistry: reg,
	getAgentId: () => "A1",
	asyncJobManager: waitManager,
	settings: settingsLike({ get: () => undefined }),
} as never;
const waitPending = new WaitTool(waitSession).execute("t", {} as never);
setTimeout(() => jobGate.resolve(), 50);
const waitOut = await waitPending;
const waitText = JSON.stringify(waitOut.content ?? "");
check("job 종료로 깬 wait 결과에 job 없는 실행 중 SubAgent 가 실린다", waitText.includes("A2"), waitText.slice(0, 200));
check("job 행 자체도 실린다", waitText.includes("long job"), waitText.slice(0, 200));
check("남의 트리는 결과에 없다", !waitText.includes("B1"), waitText.slice(0, 200));

// 두 번째 반환 지점: 이미 정산됐으나 전달되지 않은 결과를 즉시 회수하는 경로.
waitManager.register("bash", "short job", async () => "done", { ownerId: "A1" });
await Promise.all(waitManager.getAllJobs({ ownerId: "A1" }).map((job: { promise: Promise<unknown> }) => job.promise));
const settledOut = await new WaitTool(waitSession).execute("t", {} as never);
const settledText = JSON.stringify(settledOut.content ?? "");
check("미전달 결과 즉시 회수에도 실린다", settledText.includes("A2") && settledText.includes("short job"), settledText.slice(0, 200));
check("취소 목록으로 잘못 실리지 않는다", !settledText.includes("Cancelled"), settledText.slice(0, 200));

waitManager.cancelAll();
(waitManager as unknown as { dispose?: () => void }).dispose?.();

console.log("\n[11] 두 root 세션 — `write agent://Main` 은 보내는 쪽 root 로 풀리고, 관찰 카드와 차단은 자기 트리에 머문다");
// 한 프로세스에 top-level 세션이 둘 있으면(Main, Main#2) 도구 계약이 문서화한 상수 `Main` 은
// 보내는 쪽에서 실제 root 로 번역돼야 한다(bus.#deliver). 18.3.0의 유일한 메시징 진입점
// `write agent://<id>` 는 irc/messaging.ts `executeSend` 를 탄다(internal-urls/agent-protocol.ts:60-88).
// 옛 await·`wait from:"Main"` 다리는 18.3.0에 없다. 모델 호출은 없다.
const { executeSend } = await import(`${CORE}/irc/messaging.ts`);

// 앞 절들이 등록해 둔 전역 상태와 섞이면 경로가 흐려진다. 정본 리셋 훅으로 비운다.
AgentRegistry.resetGlobalForTests();
IrcBus.resetGlobalForTests();
const reg11 = AgentRegistry.global();
const bus11 = IrcBus.global();

type Incoming = { id: string; from: string; to: string; body: string };
/** 받은 것과 UI 관찰 카드를 기록하는 테스트 세션. */
class RoundTripSession {
	readonly received: Incoming[] = [];
	readonly uiRelays: string[] = [];
	isStreaming = true;
	constructor(readonly id: string) {}
	async deliverIrcMessage(m: Incoming): Promise<"injected"> {
		this.received.push(m);
		return "injected";
	}
	subscribe(): () => void {
		return () => {};
	}
	subscribeRunState(): () => void {
		return () => {};
	}
	emitIrcRelayObservation(record: { content: string }): void {
		this.uiRelays.push(record.content);
	}
}

const mainA = new RoundTripSession(MAIN_AGENT_ID);
const mainB = new RoundTripSession("Main#2");
const solA = new RoundTripSession("Sol");
const solA2 = new RoundTripSession("Sol#b");
const zetaB = new RoundTripSession("Zeta");
const zetaB2 = new RoundTripSession("Zeta#b");
const registerRoundTrip = (session: RoundTripSession, kind: "main" | "sub", parentId?: string): void => {
	reg11.register({ id: session.id, displayName: kind, kind, parentId, session: session as never });
};
registerRoundTrip(mainA, "main");
registerRoundTrip(mainB, "main");
registerRoundTrip(solA, "sub", MAIN_AGENT_ID);
registerRoundTrip(solA2, "sub", MAIN_AGENT_ID);
registerRoundTrip(zetaB, "sub", "Main#2");
registerRoundTrip(zetaB2, "sub", "Main#2");
const deps11 = (senderId: string) => ({ registry: reg11, senderId });

// (1) 두 root 의 자식이 각자 `Main` 에게 보내면 각자의 root 가 받는다.
const sendA = await executeSend(deps11("Sol"), { to: "Main", message: "A 질문" });
const sendB = await executeSend(deps11("Zeta"), { to: "Main", message: "B 질문" });
check("root A 자식의 `Main` 은 root A 가 받는다", mainA.received.some(m => m.body === "A 질문"), JSON.stringify(sendA.content).slice(0, 160));
check(
	"root B 자식의 `Main` 은 root B(Main#2)가 받는다",
	mainB.received.some(m => m.body === "B 질문"),
	JSON.stringify(sendB.content).slice(0, 160),
);
check(
	"남의 root 는 상대 요청을 받지 않는다",
	!mainA.received.some(m => m.body === "B 질문") && !mainB.received.some(m => m.body === "A 질문"),
	`a=${mainA.received.length} b=${mainB.received.length}`,
);

// (2) 관찰 UI. 자식끼리의 전달은 그 트리의 main 화면에만 떠야 한다.
mainA.uiRelays.length = 0;
mainB.uiRelays.length = 0;
await executeSend(deps11("Zeta"), { to: "Zeta#b", message: "root B 내부 전달" });
check(
	"root B 내부 전달은 root B 의 UI 에만 뜬다",
	mainB.uiRelays.length === 1 && mainA.uiRelays.length === 0,
	`a=${mainA.uiRelays.length} b=${mainB.uiRelays.length}`,
);
await executeSend(deps11("Sol"), { to: "Sol#b", message: "root A 내부 전달" });
check(
	"root A 내부 전달은 root A 의 UI 에만 뜬다",
	mainA.uiRelays.length === 1 && mainB.uiRelays.length === 1,
	`a=${mainA.uiRelays.length} b=${mainB.uiRelays.length}`,
);

// (3) 교차 세션 차단: 모델이 보는 결과 문장도 실패여야 한다.
const crossTree = await executeSend(deps11("Zeta"), { to: "Sol", message: "남의 트리로" });
const crossText = JSON.stringify(crossTree.content);
check("교차 세션 전송은 거부된다", crossText.includes("different top-level session"), crossText.slice(0, 200));
check("남의 트리 수신함은 비어 있다", solA.received.length === 0, `n=${solA.received.length}`);

// (4) 브로드캐스트도 자기 트리의 live peer 에게만 간다(listVisibleTo).
const beforeBroadcast = { a: mainA.received.length, sol: solA.received.length, b: mainB.received.length };
await executeSend(deps11("Zeta"), { to: "all", message: "B 브로드캐스트" });
check(
	"브로드캐스트는 남의 트리에 닿지 않는다",
	mainA.received.length === beforeBroadcast.a && solA.received.length === beforeBroadcast.sol,
	`a=${mainA.received.length} sol=${solA.received.length}`,
);
check("브로드캐스트는 자기 root 에 닿는다", mainB.received.length === beforeBroadcast.b + 1, `b=${mainB.received.length}`);

console.log("\n[12] wait 대기 근거 — 남의 트리 실행 중 에이전트가 이 세션의 wait 를 붙잡지 않는다");
// 18.3.0 `wait` 는 job 이 없어도 실행 중 peer 가 있으면 첫 사건까지(최대 30분) 막는다
// (tools/wait.ts:83-88). 그 peer 판정은 listVisibleTo 라 범위가 없으면 다른 세션의
// 실행 중 SubAgent 가 이 세션을 붙잡는다(HubMigrationMap 실행 증거 X1).
const lonelyRoot = new RoundTripSession("Main#3");
registerRoundTrip(lonelyRoot, "main");
const lonelyOut = await Promise.race([
	new WaitTool({ agentRegistry: reg11, getAgentId: () => "Main#3", asyncJobManager: undefined, settings: settingsLike({ get: () => undefined }) } as never).execute(
		"t",
		{} as never,
	),
	new Promise<{ content: unknown }>(resolve => setTimeout(() => resolve({ content: "BLOCKED" }), 2_000)),
]);
const lonelyText = JSON.stringify(lonelyOut.content ?? "");
check("자기 트리에 대기 대상이 없으면 즉시 돌아온다", lonelyText.includes("No running background jobs"), lonelyText.slice(0, 200));
reg11.unregister("Main#3");

console.log("\n[14] 실행 전 모델 계약 — 요청 모델, 승인 후보, 아니면 첫 프롬프트 전 거부");
const { selectSubagentApprovedModel } = await import(`${CORE}/task/executor.ts`);
const { SessionManager } = await import(`${CORE}/session/session-manager.ts`);
const MUSE_SELECTOR = "opencode-go/muse-spark-1.3-contributor:xhigh";
const mrMuse = { provider: "opencode-go", id: "muse-spark-1.3-contributor", api: "openai-responses" };
const mrBai = { provider: "b-ai", id: "deepseek-v4.1-flash", api: "openai-completions" };
const mrOpus = { provider: "anthropic", id: "claude-opus-4-6", api: "anthropic-messages" };
const mrCatalog = [mrMuse, mrBai, mrOpus];
const MR_CHAINS = {
	impl: [MUSE_SELECTOR],
	"b-ai/deepseek-v4.1-flash": [MUSE_SELECTOR],
	review: [],
	"opencode-go/muse-spark-1.3-contributor": [],
};
// HANDOFF 63-81 재현: b-ai 자격증명 없음, Muse·Opus 는 인증 있음.
const MR_AUTHED = ["opencode-go/muse-spark-1.3-contributor", "anthropic/claude-opus-4-6"];
const MR_ROLES = { impl: "b-ai/deepseek-v4.1-flash:max", review: "anthropic/claude-opus-4-6:xhigh" };
function mrSelectionArgs({ chains, authed, requestedModel, authFallbackUsed = false, patterns }) {
	const authedSet = new Set(authed);
	return {
		requestedModel,
		requestedThinkingLevel: "max",
		requestedExplicitThinkingLevel: true,
		authFallbackUsed,
		parentActiveModelPattern: "anthropic/claude-opus-4-6:xhigh",
		modelPatterns: patterns,
		role: "impl",
		settings: settingsLike({
			get: key => (key === "retry.fallbackChains" ? chains : undefined),
			getModelRoles: () => MR_ROLES,
			getModelRole: role => MR_ROLES[role],
		}),
		modelRegistry: {
			getAvailable: () => mrCatalog,
			find: (provider, id) => mrCatalog.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => mrCatalog.some(model => model.provider === provider),
			hasConfiguredAuth: model => authedSet.has(`${model.provider}/${model.id}`),
		},
	};
}
const BAI_PATTERN = ["b-ai/deepseek-v4.1-flash:max"];
const OPUS_PATTERN = ["anthropic/claude-opus-4-6:xhigh"];
const mrNormal = selectSubagentApprovedModel(
	mrSelectionArgs({ chains: MR_CHAINS, authed: MR_AUTHED, requestedModel: mrOpus, patterns: OPUS_PATTERN }),
);
check(
	"정상 경로: 요청 모델이 인증되면 대체 0(후보를 써도 결과가 바뀌지 않는다)",
	mrNormal.reason === "ok" && !mrNormal.substituted && mrNormal.model?.id === "claude-opus-4-6",
	`got ${JSON.stringify({ reason: mrNormal.reason, substituted: mrNormal.substituted, id: mrNormal.model?.id })}`,
);
const mrUnusable = selectSubagentApprovedModel(
	mrSelectionArgs({ chains: MR_CHAINS, authed: MR_AUTHED, requestedModel: mrBai, patterns: BAI_PATTERN }),
);
check(
	"primary 무인증(authFallbackUsed=false)도 승인 후보로 간다",
	mrUnusable.reason === "approved-candidate" &&
		mrUnusable.substituted &&
		mrUnusable.model?.id === "muse-spark-1.3-contributor",
	`got ${JSON.stringify({ reason: mrUnusable.reason, id: mrUnusable.model?.id })}`,
);
check(
	"승인 후보의 :xhigh 가 실제 선택에 살아 있다(Maker 의 :max 로 덮이지 않는다)",
	mrUnusable.thinkingLevel === "xhigh" && mrUnusable.explicitThinkingLevel === true,
	`got ${JSON.stringify({ level: mrUnusable.thinkingLevel, explicit: mrUnusable.explicitThinkingLevel })}`,
);
const mrParentSub = selectSubagentApprovedModel(
	mrSelectionArgs({ chains: MR_CHAINS, authed: MR_AUTHED, requestedModel: mrOpus, patterns: BAI_PATTERN, authFallbackUsed: true }),
);
check(
	"코어가 부모 모델로 대체해 온 경우에도 부모가 아니라 승인 후보를 쓴다",
	mrParentSub.reason === "approved-candidate" &&
		mrParentSub.model?.id === "muse-spark-1.3-contributor" &&
		mrParentSub.parentSubstituted === undefined,
	`got ${JSON.stringify({ reason: mrParentSub.reason, id: mrParentSub.model?.id })}`,
);
const mrUnresolved = selectSubagentApprovedModel(
	mrSelectionArgs({ chains: MR_CHAINS, authed: MR_AUTHED, requestedModel: undefined, patterns: BAI_PATTERN }),
);
check(
	"모델 해석 실패도 부모가 아니라 승인 후보로 간다",
	mrUnresolved.reason === "approved-candidate" && mrUnresolved.model?.id === "muse-spark-1.3-contributor",
	`got ${JSON.stringify({ reason: mrUnresolved.reason, id: mrUnresolved.model?.id })}`,
);
const mrNoApproved = selectSubagentApprovedModel(
	mrSelectionArgs({ chains: {}, authed: MR_AUTHED, requestedModel: mrBai, patterns: BAI_PATTERN }),
);
check(
	"승인 후보가 없으면 거부 조건을 돌려준다(호출자가 세션 생성 전에 throw)",
	mrNoApproved.reason === "unusable" && !mrNoApproved.substituted && mrNoApproved.approved.length === 0,
	`got ${JSON.stringify({ reason: mrNoApproved.reason, approved: mrNoApproved.approved })}`,
);
const mrUnauth = selectSubagentApprovedModel(
	mrSelectionArgs({ chains: MR_CHAINS, authed: ["anthropic/claude-opus-4-6"], requestedModel: mrBai, patterns: BAI_PATTERN, authFallbackUsed: true }),
);
check(
	"승인 후보가 모두 인증 불가면 부모 대체 대신 거부 조건 + 후보 목록",
	mrUnauth.reason === "auth-fallback" &&
		mrUnauth.substituted === false &&
		mrUnauth.approved[0] === MUSE_SELECTOR &&
		mrUnauth.parentSubstituted === "anthropic/claude-opus-4-6:xhigh",
	`got ${JSON.stringify({ reason: mrUnauth.reason, approved: mrUnauth.approved })}`,
);
const { mkdtempSync: mrMkdtemp, readdirSync: mrReaddir, readFileSync: mrReadFile, rmSync: rmTemp } = await import("node:fs");
const { join: joinPath } = await import("node:path");
const { tmpdir: mrTmpdir } = await import("node:os");
const mrSessionDir = mrMkdtemp(joinPath(mrTmpdir(), "omp-model-change-"));
try {
	const mrManager = SessionManager.create(mrSessionDir, mrSessionDir);
	if (typeof mrManager.ensureOnDisk === "function") mrManager.ensureOnDisk();
	// 대체 실행(요청은 b-ai, 실제는 Muse) / 정상 실행 / 미관측 호출 세 가지를 영속시킨다.
	mrManager.appendModelChange("opencode-go/muse-spark-1.3-contributor", undefined, true, "b-ai/deepseek-v4.1-flash:max");
	mrManager.appendModelChange("anthropic/claude-opus-4-6", undefined, undefined, "anthropic/claude-opus-4-6:xhigh");
	mrManager.appendModelChange("anthropic/claude-opus-4-6");
	const file = mrReaddir(mrSessionDir).find(name => name.endsWith(".jsonl"));
	const mrEntries = file
		? mrReadFile(joinPath(mrSessionDir, file), "utf8")
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line))
				.filter(entry => entry.type === "model_change")
		: [];
	check(
		"영속 JSONL 에 요청/실제/대체 삼상이 그대로 남는다",
		mrEntries.length === 3 &&
			mrEntries[0].model === "opencode-go/muse-spark-1.3-contributor" &&
			mrEntries[0].requestedModel === "b-ai/deepseek-v4.1-flash:max" &&
			mrEntries[0].resolvedModelIsFallback === true,
		`got ${JSON.stringify(mrEntries[0] ?? null)}`,
	);
	check(
		"정상 실행은 대체 표시 없이 요청 selector 만 남는다",
		mrEntries[1]?.model === "anthropic/claude-opus-4-6" &&
			mrEntries[1]?.requestedModel === "anthropic/claude-opus-4-6:xhigh" &&
			mrEntries[1]?.resolvedModelIsFallback === undefined,
		`got ${JSON.stringify(mrEntries[1] ?? null)}`,
	);
	const lacksFallbackField = entry => Object.prototype.hasOwnProperty.call(entry, "resolvedModelIsFallback") === false;
	const lacksRequestedField = entry => Object.prototype.hasOwnProperty.call(entry, "requestedModel") === false;
	check(
		"미관측 3인수 호출은 false 로 굳지 않고 필드가 비어 있다",
		mrEntries[2] !== undefined && lacksFallbackField(mrEntries[2]) && lacksRequestedField(mrEntries[2]),
		"got " + JSON.stringify(mrEntries[2] ?? null),
	);
} finally {
	rmTemp(mrSessionDir, { recursive: true, force: true });
}

console.log("\n[15] TodoTracker — 정본 목록의 모든 변경이 todo_changed 로 나온다 (전이·clear·브랜치 재수화)");
// 사용자 불만의 실제 원인: 정본 목록은 트래커가 들고 있는데 그것이 바뀌었다고 알리는 이벤트가
// 없었다. `todo` 툴 결과는 transcript 에 남지만 `/todo`, RPC set_todos, TUI 조정, 브랜치 재수화는
// 모두 AgentSession.setTodoPhases → tracker.setPhases 를 타면서 아무 기록도 남기지 않으므로,
// 구독자(웹 표시줄)는 bootstrap 스냅샷 이후의 변화를 모른 채 멈춘다. 실제 패치본 TodoTracker 를
// 그대로 만들어 발신 지점과 그 위임 경로를 본다. 패치 전 사본에는 이벤트가 아예 없어서 아래
// 검사가 예외가 아니라 RED 로 나온다(문자열 단언이 아니라 실제 발신 객체를 본다).
const { TodoTracker } = await import(`${CORE}/session/todo-tracker.ts`);
const { USER_TODO_EDIT_CUSTOM_TYPE } = await import(`${CORE}/tools/todo.ts`);

type TodoPhaseShape = { name: string; tasks: { content: string; status: string }[] };
const todoEmitted: { type: string; phases?: TodoPhaseShape[] }[] = [];
const todoBranch: unknown[] = [];
const todoHost = {
	agent: { state: { messages: [] } },
	sessionManager: { getBranch: () => todoBranch },
	settings: settingsLike({ get: () => undefined }),
	model: () => undefined,
	agentKind: () => "main",
	emitSessionEvent: async (event: { type: string; phases?: TodoPhaseShape[] }) => {
		todoEmitted.push(event);
	},
	scheduleAgentContinue: () => {},
	promptGeneration: () => 0,
	hasPendingAsyncWake: () => false,
	getActiveToolNames: () => [],
	getEnabledToolNames: () => [],
	toolRegistry: () => new Map(),
	planModeEnabled: () => false,
	prewalkWillHandoff: () => false,
	consumeLastServedToolChoiceLabel: () => undefined,
};
const todoTracker = new TodoTracker(todoHost as never);
/** 관찰한 마지막 이벤트. 파일 전체가 이 정의 하나로 "방금 나간 발신"을 가리킨다. */
const todoLastEvent = () => todoEmitted.at(-1);

// (1) 완료/진행/대기 세 상태를 한 번에. payload 는 정본 목록 그대로이고 발신은 정확히 한 번이다.
const threeStates: TodoPhaseShape[] = [
	{
		name: "검증",
		tasks: [
			{ content: "완료 항목", status: "completed" },
			{ content: "진행 항목", status: "in_progress" },
			{ content: "대기 항목", status: "pending" },
		],
	},
];
todoTracker.setPhases(threeStates as never);
check(
	"setPhases 가 todo_changed 를 낸다",
	todoEmitted.length === 1 && todoLastEvent()?.type === "todo_changed",
	`types=${JSON.stringify(todoEmitted.map(e => e.type))}`,
);
check(
	"payload 가 세 상태를 그대로 담는다",
	JSON.stringify(todoLastEvent()?.phases) === JSON.stringify(threeStates),
	`phases=${JSON.stringify(todoLastEvent()?.phases ?? null)}`,
);
check("변경 한 번에 이벤트도 한 번이다(자기 발신으로 다시 돌지 않는다)", todoEmitted.length === 1, `count=${todoEmitted.length}`);

// (2) 상태 전이: 같은 항목이 pending → in_progress → completed 로 갈 때마다 그 시점 상태가 나온다.
const transition = (status: string): TodoPhaseShape[] => [{ name: "검증", tasks: [{ content: "대기 항목", status }] }];
const seenStatuses: string[] = [];
const beforeTransitions = todoEmitted.length;
for (const status of ["pending", "in_progress", "completed"]) {
	todoTracker.setPhases(transition(status) as never);
	seenStatuses.push(todoLastEvent()?.phases?.[0]?.tasks[0]?.status ?? "NONE");
}
check(
	"전이마다 그 시점의 상태가 그대로 나온다",
	JSON.stringify(seenStatuses) === JSON.stringify(["pending", "in_progress", "completed"]),
	`got ${JSON.stringify(seenStatuses)}`,
);
check(
	"전이 3회에 이벤트도 3건(누락·중복 없음)",
	todoEmitted.length - beforeTransitions === 3,
	`delta=${todoEmitted.length - beforeTransitions}`,
);

// (3) 빈 목록은 권위 있는 clear 다. "무변화라 이벤트 없음"이 아니라 빈 배열을 담은 이벤트가 나온다.
todoTracker.setPhases([] as never);
check("clear 도 todo_changed 로 나온다", todoLastEvent()?.type === "todo_changed", `types=${JSON.stringify(todoEmitted.map(e => e.type))}`);
check(
	"clear 의 payload 는 빈 배열이다(스냅샷이 목록 없음의 권위다)",
	Array.isArray(todoLastEvent()?.phases) && todoLastEvent()!.phases!.length === 0,
	`phases=${JSON.stringify(todoLastEvent()?.phases ?? null)}`,
);
check("clear 뒤 트래커도 비어 있다", todoTracker.phases.length === 0, `phases=${JSON.stringify(todoTracker.phases)}`);

// (4) payload 는 정본과 분리된 복제본이다. 호출자가 넘긴 배열이든 구독자가 받은 payload 든
//     나중에 고쳐도 트래커 상태는 그대로여야 한다(스냅샷 불변성).
const inputAlias: TodoPhaseShape[] = [{ name: "p", tasks: [{ content: "c", status: "pending" }] }];
todoTracker.setPhases(inputAlias as never);
const payloadAlias = todoLastEvent()?.phases;
inputAlias[0]!.tasks[0]!.status = "completed";
check(
	"호출자가 넘긴 배열을 나중에 고쳐도 트래커는 그대로다",
	todoTracker.phases[0]?.tasks[0]?.status === "pending",
	`tracker=${todoTracker.phases[0]?.tasks[0]?.status}`,
);
check(
	"호출자가 넘긴 배열을 나중에 고쳐도 이미 나간 payload 는 그대로다",
	payloadAlias?.[0]?.tasks[0]?.status === "pending",
	`payload=${payloadAlias?.[0]?.tasks[0]?.status}`,
);
if (payloadAlias) payloadAlias[0]!.tasks[0]!.status = "abandoned";
check(
	"구독자가 받은 payload 를 고쳐도 트래커 상태는 그대로다",
	todoTracker.phases[0]?.tasks[0]?.status === "pending",
	`tracker=${todoTracker.phases[0]?.tasks[0]?.status}`,
);
check(
	"정본 getter 는 같은 값을 준다",
	JSON.stringify(todoTracker.phases) === JSON.stringify([{ name: "p", tasks: [{ content: "c", status: "pending" }] }]),
	`got ${JSON.stringify(todoTracker.phases)}`,
);

// (5) 브랜치 재수화는 같은 문을 그대로 지난다(세션 재로드·히스토리 재작성·압축 후 재부착).
const branchPhases: TodoPhaseShape[] = [{ name: "브랜치", tasks: [{ content: "재수화 항목", status: "in_progress" }] }];
todoBranch.push({ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases: branchPhases } });
const beforeSync = todoEmitted.length;
todoTracker.syncFromBranch();
check(
	"브랜치 재수화도 todo_changed 로 나온다",
	todoEmitted.length - beforeSync === 1 && todoLastEvent()?.type === "todo_changed",
	`delta=${todoEmitted.length - beforeSync}`,
);
check(
	"재수화한 목록이 payload 에 담긴다",
	JSON.stringify(todoLastEvent()?.phases) === JSON.stringify(branchPhases),
	`phases=${JSON.stringify(todoLastEvent()?.phases ?? null)}`,
);
// 브랜치에 남은 목록이 빈 배열이면 그것도 그대로 반영된다: clear 가 "무변화"로 굳지 않는다.
todoBranch.push({ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases: [] } });
const beforeBranchClear = todoEmitted.length;
todoTracker.syncFromBranch();
check(
	"브랜치의 빈 목록도 clear 이벤트로 나온다",
	todoEmitted.length - beforeBranchClear === 1 &&
		todoLastEvent()?.type === "todo_changed" &&
		todoLastEvent()!.phases!.length === 0 &&
		todoTracker.phases.length === 0,
	`phases=${JSON.stringify(todoLastEvent()?.phases ?? null)} tracker=${JSON.stringify(todoTracker.phases)}`,
);


console.log("\n[15b] RPC Subagent snapshot — 원래 업무는 고정하고 현재 follow-up 단계만 갱신한다");
const { RpcSubagentRegistry } = await import(`${CORE}/modes/rpc/rpc-subagents.ts`);
const rpcBus = { on: () => () => {} };
const rpcFrames: unknown[] = [];
const rpcSubagents = new RpcSubagentRegistry(rpcBus as never, frame => rpcFrames.push(frame));
rpcSubagents.handleLifecycle({
	id: "stable-card",
	index: 0,
	agent: "maker",
	agentSource: "project",
	status: "started",
	sessionFile: "C:/tmp/stable-card.jsonl",
	parentToolCallId: "task-parent",
	description: "원래 업무 제목",
} as never);
const rpcProgressPayload = (
	task: string,
	assignment?: string,
	description = task === "follow-up hub DM" ? "현재 후속 제목" : "원래 업무 제목",
) => ({
	index: 0,
	agent: "maker",
	agentSource: "project",
	task,
	assignment,
	sessionFile: "C:/tmp/stable-card.jsonl",
	parentToolCallId: "task-parent",
	progress: {
		index: 0,
		id: "stable-card",
		agent: "maker",
		agentSource: "project",
		description,
		status: "running",
		task,
		assignment,
		lastIntent: task === "follow-up hub DM" ? "focused 검증 실행" : undefined,
		currentTool: task === "follow-up hub DM" ? "bash" : undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	},
});
const originalAssignment = "TASK_TITLE: 원래 담당업무\nTODO_TASKS: [\"focused 검증\"]";
rpcSubagents.handleProgress(rpcProgressPayload("initial rendered task", originalAssignment) as never);
rpcSubagents.handleProgress(rpcProgressPayload("follow-up hub DM") as never);
const stableSnapshot = rpcSubagents.getSubagents()[0];
check(
	"후속 hub DM 뒤에도 snapshot task/assignment/description은 최초 업무다",
	stableSnapshot?.task === "initial rendered task" &&
		stableSnapshot.assignment === originalAssignment &&
		stableSnapshot.description === "원래 업무 제목",
	`task=${JSON.stringify(stableSnapshot?.task)} assignment=${JSON.stringify(stableSnapshot?.assignment)} description=${JSON.stringify(stableSnapshot?.description)}`,
);
check(
	"현재 단계는 progress description/lastIntent/currentTool과 follow-up task로 갱신된다",
	stableSnapshot?.progress?.task === "follow-up hub DM" &&
		stableSnapshot.progress.description === "현재 후속 제목" &&
		stableSnapshot.progress.lastIntent === "focused 검증 실행" &&
		stableSnapshot.progress.currentTool === "bash",
	`progress=${JSON.stringify(stableSnapshot?.progress)}`,
);
rpcSubagents.handleLifecycle({
	id: "stable-card",
	index: 0,
	agent: "maker",
	agentSource: "project",
	status: "completed",
	sessionFile: "C:/tmp/stable-card.jsonl",
	parentToolCallId: "task-parent",
} as never);
check("완료한 작업은 활성 snapshot에서 빠진다", rpcSubagents.getSubagents().length === 0);
rpcSubagents.handleLifecycle({
	id: "stable-card",
	index: 0,
	agent: "maker",
	agentSource: "project",
	status: "started",
	sessionFile: "C:/tmp/stable-card.jsonl",
	parentToolCallId: "hub-parent",
	description: "현재 follow-up 제목",
} as never);
rpcSubagents.handleProgress({
	...rpcProgressPayload("follow-up hub DM"),
	parentToolCallId: "hub-parent",
} as never);
const revivedSnapshot = rpcSubagents.getSubagents()[0];
check(
	"완료 뒤 hub가 같은 세션을 깨워도 원래 업무와 새 진행 상태를 함께 보존한다",
	revivedSnapshot?.task === "initial rendered task" &&
		revivedSnapshot.assignment === originalAssignment &&
		revivedSnapshot.description === "원래 업무 제목" &&
		revivedSnapshot.parentToolCallId === "hub-parent" &&
		revivedSnapshot.progress?.description === "현재 후속 제목" &&
		revivedSnapshot.progress.lastIntent === "focused 검증 실행",
	`task=${JSON.stringify(revivedSnapshot?.task)} assignment=${JSON.stringify(revivedSnapshot?.assignment)} description=${JSON.stringify(revivedSnapshot?.description)} progress=${JSON.stringify(revivedSnapshot?.progress)}`,
);
rpcSubagents.handleLifecycle({
	id: "stable-card", index: 0, agent: "maker", agentSource: "project", status: "completed",
	sessionFile: "C:/tmp/stable-card.jsonl", parentToolCallId: "hub-parent",
} as never);
rpcSubagents.handleLifecycle({
	id: "stable-card", index: 0, agent: "maker", agentSource: "project", status: "started",
	sessionFile: "C:/tmp/different-card.jsonl", parentToolCallId: "new-task-parent",
	description: "새 세션 업무 제목",
} as never);
check(
	"같은 이름의 다른 세션은 이전 업무를 상속하지 않는다",
	rpcSubagents.getSubagents()[0]?.task === undefined &&
		rpcSubagents.getSubagents()[0]?.assignment === undefined &&
		rpcSubagents.getSubagents()[0]?.description === "새 세션 업무 제목",
);
rpcSubagents.clear();
rpcSubagents.handleLifecycle({
	id: "stable-card", index: 0, agent: "maker", agentSource: "project", status: "started",
	sessionFile: "C:/tmp/stable-card.jsonl", parentToolCallId: "after-clear",
	description: "clear 뒤 새 업무 제목",
} as never);
check(
	"명시적으로 비운 registry는 예전 업무를 되살리지 않는다",
	rpcSubagents.getSubagents()[0]?.task === undefined &&
		rpcSubagents.getSubagents()[0]?.assignment === undefined &&
		rpcSubagents.getSubagents()[0]?.description === "clear 뒤 새 업무 제목",
);
rpcSubagents.handleProgress({
	...rpcProgressPayload("dispose initial task", "dispose assignment", "진행 중 다른 제목"),
	parentToolCallId: "after-clear",
} as never);
rpcSubagents.handleLifecycle({
	id: "stable-card", index: 0, agent: "maker", agentSource: "project", status: "completed",
	sessionFile: "C:/tmp/stable-card.jsonl", parentToolCallId: "after-clear",
} as never);
rpcSubagents.dispose();
rpcSubagents.handleLifecycle({
	id: "stable-card", index: 0, agent: "maker", agentSource: "project", status: "started",
	sessionFile: "C:/tmp/stable-card.jsonl", parentToolCallId: "after-dispose",
	description: "dispose 뒤 새 업무 제목",
} as never);
check(
	"dispose한 registry는 예전 업무를 되살리지 않는다",
	rpcSubagents.getSubagents()[0]?.task === undefined &&
		rpcSubagents.getSubagents()[0]?.assignment === undefined &&
		rpcSubagents.getSubagents()[0]?.description === "dispose 뒤 새 업무 제목",
);
rpcSubagents.dispose();

const boundedRpcSubagents = new RpcSubagentRegistry(rpcBus as never, frame => rpcFrames.push(frame));
const boundedRpcProgressPayload = (index: number) => ({
	index,
	agent: "maker",
	agentSource: "project",
	task: `bounded task ${index}`,
	assignment: `bounded assignment ${index}`,
	sessionFile: `C:/tmp/bounded-${index}.jsonl`,
	parentToolCallId: `bounded-parent-${index}`,
	progress: {
		index,
		id: `bounded-${index}`,
		agent: "maker",
		agentSource: "project",
		description: `bounded description ${index}`,
		status: "running",
		task: `bounded task ${index}`,
		assignment: `bounded assignment ${index}`,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	},
});
for (let index = 0; index <= 256; index++) {
	boundedRpcSubagents.handleLifecycle({
		id: `bounded-${index}`, index, agent: "maker", agentSource: "project", status: "started",
		sessionFile: `C:/tmp/bounded-${index}.jsonl`, parentToolCallId: `bounded-parent-${index}`,
	} as never);
	boundedRpcSubagents.handleProgress(boundedRpcProgressPayload(index) as never);
	boundedRpcSubagents.handleLifecycle({
		id: `bounded-${index}`, index, agent: "maker", agentSource: "project", status: "completed",
		sessionFile: `C:/tmp/bounded-${index}.jsonl`, parentToolCallId: `bounded-parent-${index}`,
	} as never);
}
boundedRpcSubagents.handleLifecycle({
	id: "bounded-0", index: 0, agent: "maker", agentSource: "project", status: "started",
	sessionFile: "C:/tmp/bounded-0.jsonl", parentToolCallId: "bounded-revive-0",
	description: "evicted identity replacement",
} as never);
boundedRpcSubagents.handleLifecycle({
	id: "bounded-256", index: 256, agent: "maker", agentSource: "project", status: "started",
	sessionFile: "C:/tmp/bounded-256.jsonl", parentToolCallId: "bounded-revive-256",
	description: "retained identity replacement",
} as never);
const evictedBoundedSnapshot = boundedRpcSubagents.getSubagents().find(snapshot => snapshot.id === "bounded-0");
const retainedBoundedSnapshot = boundedRpcSubagents.getSubagents().find(snapshot => snapshot.id === "bounded-256");
check(
	"retained identity도 transcript reference와 같은 256개 한도로 정리된다",
	evictedBoundedSnapshot?.task === undefined &&
		evictedBoundedSnapshot?.assignment === undefined &&
		evictedBoundedSnapshot?.description === "evicted identity replacement" &&
		retainedBoundedSnapshot?.task === "bounded task 256" &&
		retainedBoundedSnapshot?.assignment === "bounded assignment 256" &&
		retainedBoundedSnapshot?.description === "bounded description 256",
);
boundedRpcSubagents.dispose();

console.log("\n[16] 대화 기록의 계정 귀속 — assistant 항목이 그 턴을 처리한 계정을 남긴다");
// 사용자 요구의 뿌리: 세션 JSONL 의 assistant 항목은 무엇이 답했는지(api·provider·model)만
// 남기고 누구 계정으로 답했는지는 남기지 않았다. 그래서 한 provider 에 계정이 둘 이상이면
// 대화 화면에는 Usage 탭과 같은 얼굴·별칭을 붙일 근거가 아예 없었다.
// 문자열이 아니라 실제로 기록된 파일을 본다: mock provider 로 진짜 한 턴을 돌리고 그
// 세션 파일을 다시 읽는다. 18.3.0은 이 귀속을 upstream 이 직접 한다(pi-ai/src/stream.ts:1549-1594
// 가 resolver 로 고른 credentialId 를 partial/done/error 에 찍는다). 옛 core patch #119~#122
// (stampAssistantCredentialId) 는 RETIRE 됐고, 여기서는 그 upstream 경로가 실제 세션 파일에
// "이 세션이 쓴 계정"을 남기는지만 본다.
const {
	mkdirSync: csMkdir,
	mkdtempSync: csMkdtemp,
	readFileSync: csReadFile,
	writeFileSync: csWriteFile,
	rmSync: csRmSync,
} = await import("node:fs");
const { dirname: csDirname, join: csJoin } = await import("node:path");
const { tmpdir: csTmpdir } = await import("node:os");

// `../pi-ai/src` 는 EDITS 가 이미 쓰는 것과 같은 상대 위치다.
const CS_AI = csJoin(csDirname(csDirname(CORE)), "pi-ai/src").replace(/\\/g, "/");
const { AuthStorage: CsAuthStorage } = await import(`${CS_AI}/auth-storage.ts`);
const { createMockModel: csCreateMockModel, registerMockApi: csRegisterMockApi } = await import(`${CS_AI}/providers/mock.ts`);
const CS_CATALOG = csJoin(csDirname(csDirname(CORE)), "pi-catalog/src").replace(/\\/g, "/");
const { buildModel: csBuildModel } = await import(`${CS_CATALOG}/build.ts`);
const { streamOpenAICompletions: csStreamOpenAICompletions } = await import(`${CS_AI}/providers/openai-completions.ts`);
const { loadSessionFile: csLoadSessionFile } = await import(`${CORE}/session/session-loader.ts`);
const { createAgentSession: csCreateAgentSession } = await import(`${CORE}/sdk.ts`);
csRegisterMockApi();

const csRoot = csMkdtemp(csJoin(csTmpdir(), "omp-credential-stamp-"));
const csAgentDir = csJoin(csRoot, "agent");
const csCwd = csJoin(csRoot, "work");
csMkdir(csAgentDir, { recursive: true });
csMkdir(csCwd, { recursive: true });

// 격리된 자격증명 저장소. 실제 ~/.omp 의 계정은 읽지도 쓰지도 않는다.
const csAuth = await CsAuthStorage.create(csJoin(csAgentDir, "auth.db"));
for (const tag of ["A", "B"]) {
	await csAuth.credentials.upsert("anthropic", {
		type: "oauth",
		access: `stamp-access-${tag}`,
		refresh: `stamp-refresh-${tag}`,
		expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
		email: `stamp-${tag.toLowerCase()}@example.test`,
		accountId: `stamp-acct-${tag}`,
	});
}
const csAccounts = csAuth.oauth.accounts("anthropic");

const csSessionOptions = (provider: string) => ({
	cwd: csCwd,
	agentDir: csAgentDir,
	authStorage: csAuth,
	systemPrompt: "credential stamp probe",
	tools: [],
	skills: [],
	rules: [],
	contextFiles: [],
	disableExtensionDiscovery: true,
	model: csCreateMockModel({
		id: "stamp-mock",
		provider,
		responses: [{ content: ["ok"], stopReason: "stop" }],
		handler: { content: ["ok"], stopReason: "stop" },
	}),
});

type CsPersistedMessage = { role?: string; provider?: string; credentialId?: number };
function csAssistantMessages(file: string): CsPersistedMessage[] {
	return csReadFile(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line: string) => JSON.parse(line) as { type?: string; message?: CsPersistedMessage })
		.filter(entry => entry.type === "message" && entry.message?.role === "assistant")
		.map(entry => entry.message as CsPersistedMessage);
}

// (1) 계정이 확인된 턴. 일부러 provider 의 "첫" 계정이 아니라 두 번째를 이 세션에 붙여서,
//     스탬프가 추정("provider 의 유일/첫 계정")이 아니라 이 세션이 실제로 쓴 계정을
//     읽는지 구분한다.
const { session: csSession } = await csCreateAgentSession(csSessionOptions("anthropic"));
const csTarget = csAccounts[1]!;
csAuth.sessions.pin("anthropic", csSession.sessionId, csTarget.credentialId);
await csSession.prompt("안녕");
const csKnown = csAssistantMessages(csSession.sessionManager.getSessionFile()!);
check("계정이 확인되면 assistant 항목에 credentialId 가 남는다", csKnown.length === 1 && csKnown[0]!.credentialId !== undefined, `keys=${JSON.stringify(Object.keys(csKnown[0] ?? {}))}`);
check(
	"기록된 계정은 이 세션이 실제로 쓴 계정이다(첫 계정으로 추정하지 않는다)",
	csKnown[0]?.credentialId === csTarget.credentialId && csTarget.credentialId !== csAccounts[0]!.credentialId,
	`got=${csKnown[0]?.credentialId} want=${csTarget.credentialId} first=${csAccounts[0]!.credentialId}`,
);

// (2) 계정을 모르는 턴. OAuth 가 아니라 환경변수 API 키로 인증하면 그 세션에는 active
//     계정이 없다. 이때 0/-1/null 을 찍지 않고 필드를 아예 만들지 않아야, 읽는 쪽이
//     "필드 없음 = 미상"만 알면 되고 어느 sentinel 인지 알 필요가 없다.
const csPreviousOpenAiKey = process.env.OPENAI_API_KEY;
// 이 테스트는 값의 형식을 보지 않고 "env 키가 설정돼 있다"만 본다. 그래서 값은
// `patches/content-scan.ps1` 의 PlaceholderPattern(`<.*>`)에 맞는 모양으로 둔다.
// 실제 키처럼 생긴 값을 쓰면 Secret Scan 이 credential-like assignment 로 잡아 setup 을 막는다.
process.env.OPENAI_API_KEY = "<probe>";
const { session: csUnknownSession } = await csCreateAgentSession(csSessionOptions("openai"));
await csUnknownSession.prompt("안녕");
if (csPreviousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
else process.env.OPENAI_API_KEY = csPreviousOpenAiKey;
const csUnknown = csAssistantMessages(csUnknownSession.sessionManager.getSessionFile()!);
check("계정을 모르면 sentinel 이 아니라 필드 자체가 없다", csUnknown.length === 1 && !("credentialId" in csUnknown[0]!), `keys=${JSON.stringify(Object.keys(csUnknown[0] ?? {}))}`);
check("계정을 몰라도 턴 자체는 그대로 기록된다", csUnknown[0]?.provider === "openai", `msg=${JSON.stringify(csUnknown[0] ?? null)}`);

// (3) 헬퍼 실패 내성 검사는 옛 stampAssistantCredentialId 전용이었다. upstream 스탬프는
//     resolver 가 고른 숫자 id 만 쓰므로(stream.ts:1558-1565) 따로 고정할 표면이 없다.

// (4) 뒤로 호환. 이 필드가 생기기 전에 기록된 항목은 그대로 읽혀야 한다. 정식 로더로
//     읽어 malformed 0 을 확인한다.
const csLegacyPath = csJoin(csRoot, "legacy-session.jsonl");
csWriteFile(
	csLegacyPath,
	[
		JSON.stringify({ type: "session", version: 3, id: "01a0b48e-998d-76c7-872d-efd26ee50314", timestamp: "2026-09-18T12:47:19.437Z", cwd: csCwd }),
		JSON.stringify({ type: "message", id: "aaaaaaaa", parentId: null, timestamp: "2026-09-18T12:48:46.773Z", message: { role: "user", content: "안녕", attribution: "user", timestamp: 1789735724538 } }),
		JSON.stringify({ type: "message", id: "bbbbbbbb", parentId: "aaaaaaaa", timestamp: "2026-09-18T12:48:49.088Z", message: { role: "assistant", content: [{ type: "text", text: "예전 형식" }], api: "anthropic-messages", provider: "anthropic", model: "fable-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1789735726769, duration: 880, completedAt: 1789735729045 } }),
	].join("\n") + "\n",
	"utf8",
);
const csLegacy = await csLoadSessionFile(csLegacyPath);
const csLegacyAssistants = csAssistantMessages(csLegacyPath);
check("이 필드 이전에 기록된 세션도 그대로 파싱된다", csLegacy.entries.length === 3 && (csLegacy.malformedRecords ?? 0) === 0 && csLegacy.invalidHeader === false, `entries=${csLegacy.entries.length} malformed=${csLegacy.malformedRecords} invalidHeader=${csLegacy.invalidHeader}`);
check("옛 항목은 credentialId 없이 읽힌다", csLegacyAssistants.length === 1 && !("credentialId" in csLegacyAssistants[0]!), `keys=${JSON.stringify(Object.keys(csLegacyAssistants[0] ?? {}))}`);

// SQLite·세션 파일 핸들이 아직 열려 있을 수 있다. 임시 디렉터리 청소 실패가 검사
// 결과를 뒤집어서는 안 된다.
csAuth.close?.();
try {
	csRmSync(csRoot, { recursive: true, force: true });
} catch {
	// 남은 임시 파일은 OS 가 정리한다.
}

console.log("\n[17] WEB6 provider 요청은 현재 OMP sessionId를 전용 헤더로 운반한다");
const csWeb6Model = csBuildModel({
	id: "gpt-6-pro",
	name: "ChatGPT 6 Pro (web)",
	api: "openai-completions",
	provider: "web6",
	baseUrl: "http://web6.invalid/v1",
	reasoning: false,
	input: ["text"],
	supportsTools: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 100,
});
const csWeb6Context = {
	messages: [{ role: "user", content: "상담", timestamp: Date.now() }],
	tools: [],
};
const csSse = [
	'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"gpt-6-pro","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
	'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"gpt-6-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
	"data: [DONE]",
	"",
].join("\n\n");
let csObservedSessionHeader: string | null = null;
const csWeb6Stream = csStreamOpenAICompletions(csWeb6Model, csWeb6Context, {
	apiKey: "your-unused-api-key",
	sessionId: "your-session-provider-carrier",
	headers: { "X-OMP-Session-Id": "your-spoofed-session" },
	fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
		csObservedSessionHeader = new Headers(init?.headers).get("X-OMP-Session-Id");
		return new Response(csSse, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	},
});
await csWeb6Stream.result();
check(
	"WEB6 wire 요청에 현재 sessionId가 정확히 실린다",
	csObservedSessionHeader === "your-session-provider-carrier",
	`header=${JSON.stringify(csObservedSessionHeader)}`,
);

let csMissingSessionFetchCalled = false;
const csMissingSessionStream = csStreamOpenAICompletions(csWeb6Model, csWeb6Context, {
	apiKey: "your-unused-api-key",
	fetch: async () => {
		csMissingSessionFetchCalled = true;
		return new Response(csSse, { status: 200, headers: { "content-type": "text/event-stream" } });
	},
});
let csMissingSessionFailed = false;
let csMissingSessionError = "";
try {
	const result = await csMissingSessionStream.result();
	csMissingSessionError = typeof result.errorMessage === "string" ? result.errorMessage : "";
	csMissingSessionFailed = result.stopReason === "error";
} catch (error) {
	csMissingSessionFailed = true;
	csMissingSessionError = error instanceof Error ? error.message : String(error);
}
check(
	"sessionId가 없으면 WEB6 network 호출 전에 fail closed한다",
	csMissingSessionFailed && !csMissingSessionFetchCalled,
	`failed=${csMissingSessionFailed} fetchCalled=${csMissingSessionFetchCalled} error=${JSON.stringify(csMissingSessionError)}`,
);

console.log("\n[18] eval completion bridge — exact WEB6 선택과 sessionId 전달");
const {
	runEvalCompletion: csRunEvalCompletion,
	getCompletionHandle: csGetCompletionHandle,
	releaseCompletionHandles: csReleaseCompletionHandles,
} = await import(`${CORE}/eval/completion-bridge.ts`);

let csSmolFails = false;
let csWeb6Fails = false;
const csCompletionModels = {
	smol: csCreateMockModel({
		id: "smol",
		provider: "tier",
		handler: () =>
			csSmolFails
				? { content: [], stopReason: "error", errorMessage: "smol primary failed" }
				: { content: ["smol ok"], stopReason: "stop" },
	}),
	default: csCreateMockModel({
		id: "default",
		provider: "tier",
		handler: { content: ["default ok"], stopReason: "stop" },
	}),
	slow: csCreateMockModel({
		id: "slow",
		provider: "tier",
		reasoning: true,
		handler: { content: ["slow ok"], stopReason: "stop" },
	}),
	smolFallback: csCreateMockModel({
		id: "smol-fallback",
		provider: "tier",
		reasoning: true,
		handler: { content: ["smol fallback ok"], stopReason: "stop" },
	}),
	web6: csCreateMockModel({
		id: "gpt-6-pro",
		provider: "web6",
		handler: () =>
			csWeb6Fails
				? { content: [], stopReason: "error", errorMessage: "web6 primary failed" }
				: { content: ["web6 ok"], stopReason: "stop" },
	}),
	web6Fallback: csCreateMockModel({
		id: "web6-fallback",
		provider: "tier",
		handler: { content: ["web6 fallback must not run"], stopReason: "stop" },
	}),
};
const csAvailableCompletionModels = Object.values(csCompletionModels);
// 명시 effort 검증용 지원 범위: slow는 low..high, smol-fallback은 low만 노출한다.
Object.assign(csCompletionModels.slow, { thinking: { efforts: ["low", "medium", "high"] } });
Object.assign(csCompletionModels.smolFallback, { thinking: { efforts: ["low"] } });
const csCompletionRoles: Record<string, string> = {
	smol: "tier/smol",
	default: "tier/default",
	slow: "tier/slow",
};
const csCompletionFallbackChains = {
	smol: ["tier/smol-fallback"],
	"web6/gpt-6-pro": ["tier/web6-fallback"],
};
const csCompletionSettings = settingsLike({
	get(key: string) {
		if (key === "disabledProviders") return [];
		if (key === "retry.fallbackChains") return csCompletionFallbackChains;
		if (key === "modelProviderOrder") return [];
		return undefined;
	},
	getGroup(group: string) {
		if (group === "retry") return { enabled: true, modelFallback: true, maxRetries: 3 };
		return {};
	},
	getModelRole(role: string) {
		return csCompletionRoles[role];
	},
	getModelRoles() {
		return csCompletionRoles;
	},
});
const csCompletionRegistry = {
	getAvailable: () => csAvailableCompletionModels,
	find: (provider: string, id: string) =>
		csAvailableCompletionModels.find(model => model.provider === provider && model.id === id),
	hasProvider: (provider: string) => csAvailableCompletionModels.some(model => model.provider === provider),
	getApiKey: async () => "completion-test-key",
	resolver: () => () => "completion-test-key",
};
const csCompletionSession = {
	modelRegistry: csCompletionRegistry,
	settings: csCompletionSettings,
	getActiveModelString: () => "tier/default",
	getModelString: () => "tier/default",
	getSessionId: () => "session-eval-web6",
	getAgentId: () => "completion-bridge-test",
};

async function csComplete(model: string, effort?: string) {
	const { id } = await csRunEvalCompletion(
		{ prompt: "completion bridge probe", model, ...(effort === undefined ? {} : { effort }) },
		{ session: csCompletionSession as never },
	);
	const entry = csGetCompletionHandle(id);
	if (!entry) throw new Error(`completion handle disappeared: ${id}`);
	await entry.promise;
	return entry;
}

for (const tier of ["smol", "default", "slow"] as const) {
	const entry = await csComplete(tier);
	check(
		`기존 ${tier} tier 선택은 그대로다`,
		entry.error === undefined &&
			entry.result?.details.tier === tier &&
			entry.result.details.model === `tier/${tier}`,
		`error=${JSON.stringify(entry.error)} details=${JSON.stringify(entry.result?.details)}`,
	);
}

const csExactWeb6 = await csComplete("web6/gpt-6-pro");
check(
	"exact WEB6 target은 web6/gpt-6-pro를 정확히 선택한다",
	csExactWeb6.error === undefined &&
		csExactWeb6.result?.details.model === "web6/gpt-6-pro" &&
		csExactWeb6.result.details.tier === undefined,
	`error=${JSON.stringify(csExactWeb6.error)} details=${JSON.stringify(csExactWeb6.result?.details)}`,
);
check(
	"eval completion이 현재 sessionId를 provider option으로 전달한다",
	csCompletionModels.web6.calls.at(-1)?.options?.sessionId === "session-eval-web6",
	`sessionId=${JSON.stringify(csCompletionModels.web6.calls.at(-1)?.options?.sessionId)}`,
);

let csArbitrarySelectorRejected = false;
try {
	await csRunEvalCompletion(
		{ prompt: "arbitrary selector probe", model: "tier/not-allowed" },
		{ session: csCompletionSession as never },
	);
} catch (error) {
	csArbitrarySelectorRejected =
		error instanceof Error && error.message.includes("completion() received invalid arguments");
}
check("임의 exact selector는 schema에서 거부한다", csArbitrarySelectorRejected);

csWeb6Fails = true;
csCompletionModels.web6.reset();
csCompletionModels.web6Fallback.reset();
const csFailedExactWeb6 = await csComplete("web6/gpt-6-pro");
check(
	"exact WEB6 실패는 일반 fallback 후보를 실행하지 않는다",
	typeof csFailedExactWeb6.error === "string" &&
		csCompletionModels.web6.calls.length === 1 &&
		csCompletionModels.web6Fallback.calls.length === 0,
	`error=${JSON.stringify(csFailedExactWeb6.error)} primary=${csCompletionModels.web6.calls.length} fallback=${csCompletionModels.web6Fallback.calls.length}`,
);

csSmolFails = true;
csCompletionModels.smol.reset();
csCompletionModels.smolFallback.reset();
const csTierFallback = await csComplete("smol");
check(
	"기존 tier는 configured fallback chain을 계속 사용한다",
	csTierFallback.error === undefined &&
		csTierFallback.result?.details.model === "tier/smol-fallback" &&
		csCompletionModels.smol.calls.length === 1 &&
		csCompletionModels.smolFallback.calls.length === 1,
	`error=${JSON.stringify(csTierFallback.error)} details=${JSON.stringify(csTierFallback.result?.details)} primary=${csCompletionModels.smol.calls.length} fallback=${csCompletionModels.smolFallback.calls.length}`,
);

// 명시 effort는 primary·fallback 모두에 같은 요청값으로 전달되고 모델별 clamp를 거친다.
const csEffortLow = await csComplete("slow", "low");
check(
	"명시 effort는 tier 기본값을 덮어 요청값을 그대로 전달한다",
	csEffortLow.error === undefined && csCompletionModels.slow.calls.at(-1)?.options?.reasoning === "low",
	`reasoning=${JSON.stringify(csCompletionModels.slow.calls.at(-1)?.options?.reasoning)}`,
);

const csEffortMax = await csComplete("slow", "max");
check(
	"모델이 지원하지 않는 effort는 지원 범위로 clamp된다",
	csEffortMax.error === undefined && csCompletionModels.slow.calls.at(-1)?.options?.reasoning === "high",
	`reasoning=${JSON.stringify(csCompletionModels.slow.calls.at(-1)?.options?.reasoning)}`,
);

const csEffortOff = await csComplete("slow", "off");
check(
	"effort=off는 reasoning을 끄는 경로로 간다",
	csEffortOff.error === undefined &&
		csCompletionModels.slow.calls.at(-1)?.options?.reasoning === undefined &&
		csCompletionModels.slow.calls.at(-1)?.options?.disableReasoning === true,
	`options=${JSON.stringify(csCompletionModels.slow.calls.at(-1)?.options)}`,
);

const csEffortFallback = await csComplete("smol", "medium");
check(
	"명시 effort는 fallback candidate에도 같은 요청값으로 clamp된다",
	csEffortFallback.error === undefined &&
		csCompletionModels.smol.calls.at(-1)?.options?.reasoning === undefined &&
		csCompletionModels.smolFallback.calls.at(-1)?.options?.reasoning === "low",
	`primary=${JSON.stringify(csCompletionModels.smol.calls.at(-1)?.options?.reasoning)} fallback=${JSON.stringify(csCompletionModels.smolFallback.calls.at(-1)?.options?.reasoning)}`,
);

let csAutoEffortRejected = false;
try {
	await csRunEvalCompletion(
		{ prompt: "auto effort probe", model: "slow", effort: "auto" },
		{ session: csCompletionSession as never },
	);
} catch (error) {
	csAutoEffortRejected =
		error instanceof Error && error.message.includes("completion() received invalid arguments");
}
check("auto는 공개 effort enum에서 거부한다", csAutoEffortRejected);
csReleaseCompletionHandles("completion-bridge-test");

console.log("\n[19] Mnemopi 안내 — effective autoRetain 과 모델 안내 문장이 일치한다");
// 사용자 요구의 뿌리: `mnemopi.autoRetain: false` 로 자동 턴 저장을 껐는데도 주입되는 memory
// 안내는 "완료된 턴이 자동 저장된다"고 단정했다. 안내는 실제로 회수를 결정하는 값(state 의
// config, state 가 없으면 settings)을 따라야 하고, 같은 정적 블록을 recall 스테이징과 함께
// 예산에 넣는 두 번째 소비자의 slice 오프셋도 같은 문자열에서 나와야 한다.
// 동적 import 예외: 검사 대상은 이 파일이 이미 고정한 설치 사본(`${CORE}`)이고, 정적 import 는
// bun 전역 캐시의 다른 사본으로 해석된다(파일 첫머리의 같은 이유).
const { mnemopiBackend } = await import(`${CORE}/mnemopi/backend.ts`);
const { setMnemopiSessionState } = await import(`${CORE}/mnemopi/state.ts`);
const mnemopiSettings = (autoRetain: boolean, injectionTokenLimit = 5000) =>
	settingsLike({
		get: (key: string) =>
			key === "mnemopi.autoRetain"
				? autoRetain
				: key === "mnemopi.injectionTokenLimit"
					? injectionTokenLimit
					: undefined,
	}) as never;
/** 실제 state 는 `config` 를 항상 들고 있다. 세션 symbol 슬롯에 꽂아 두 소비자만 태운다. */
const mnemopiSession = (options: { stateAutoRetain?: boolean; settingsAutoRetain: boolean; context?: string }) => {
	// 18.3.1 backend는 안내 문구의 도구 참조를 session.getXdevToolEntries()에서 만든다(xdev 없으면 []).
	const session = { settings: mnemopiSettings(options.settingsAutoRetain), getXdevToolEntries: () => [] } as never;
	if (options.stateAutoRetain === undefined) return session;
	setMnemopiSessionState(session, {
		config: { autoRetain: options.stateAutoRetain },
		beforeAgentStartPrompt: async () => ({ context: options.context ?? "", commit: () => true }),
	} as never);
	return session;
};
const mnemopiGuidance = async (options: { stateAutoRetain?: boolean; settingsAutoRetain: boolean }) =>
	(await mnemopiBackend.buildDeveloperInstructions(
		"",
		mnemopiSettings(options.settingsAutoRetain),
		options.stateAutoRetain === undefined ? undefined : mnemopiSession(options),
	)) ?? "";

const mnemopiGuidanceOn = await mnemopiGuidance({ settingsAutoRetain: true });
const mnemopiGuidanceOff = await mnemopiGuidance({ settingsAutoRetain: false });
check(
	"autoRetain true 안내는 자동 저장을 알린다",
	mnemopiGuidanceOn.includes("retained automatically"),
	`tail=${JSON.stringify(mnemopiGuidanceOn.slice(-120))}`,
);
check(
	"autoRetain false 안내는 자동 저장을 주장하지 않는다",
	!mnemopiGuidanceOff.includes("retained automatically"),
	`tail=${JSON.stringify(mnemopiGuidanceOff.slice(-120))}`,
);
check(
	"autoRetain false 안내는 의도적 retain/learn 만 남는다고 밝힌다",
	mnemopiGuidanceOff.includes("explicit `retain`") && mnemopiGuidanceOff.includes("`learn`"),
	`tail=${JSON.stringify(mnemopiGuidanceOff.slice(-160))}`,
);
check(
	"설정과 무관한 공통 안내 줄은 그대로다",
	["# Memory", "`<memories>` blocks injected", "Use `recall` proactively", "Use `retain` to store durable facts", "Use `reflect`"].every(
		line => mnemopiGuidanceOn.includes(line) && mnemopiGuidanceOff.includes(line),
	),
);
check(
	"state 의 config 가 있으면 settings 보다 우선한다",
	!(await mnemopiGuidance({ stateAutoRetain: false, settingsAutoRetain: true })).includes("retained automatically") &&
		(await mnemopiGuidance({ stateAutoRetain: true, settingsAutoRetain: false })).includes("retained automatically"),
);

const MNEMOPI_RECALL = "RECALL-CONTEXT-SENTINEL";
for (const stateAutoRetain of [true, false]) {
	const preparation = await mnemopiBackend.beforeAgentStartPrompt(
		mnemopiSession({ stateAutoRetain, settingsAutoRetain: !stateAutoRetain, context: MNEMOPI_RECALL }),
		"지난 결정이 뭐였지",
	);
	check(
		`beforeAgentStartPrompt(state=${stateAutoRetain}) 가 정적 블록만 정확히 걷어낸다`,
		preparation?.context === MNEMOPI_RECALL,
		`context=${JSON.stringify(preparation?.context ?? null)}`,
	);
}

console.log("\n[20] 생성 중 사용자 스티어링 — 현재 toolCall보다 지시가 먼저 도착한다");
const agentCoreRoot = join(CORE, "../../pi-agent-core/src").replace(/\\/g, "/");
const piAiRoot = join(CORE, "../../pi-ai/src").replace(/\\/g, "/");
const piCatalogRoot = join(CORE, "../../pi-catalog/src").replace(/\\/g, "/");
const { Agent: SteeringAgent } = await import(`${agentCoreRoot}/agent.ts`);
const { createAssistantMessageEventStream: createSteeringStream } = await import(`${piAiRoot}/utils/event-stream.ts`);
const { getBundledModel: getSteeringModel } = await import(`${piCatalogRoot}/models.ts`);
const steeringModel = getSteeringModel("openai", "gpt-4o-mini")!;
const steeringUsage = () => ({
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
async function runGenerationSteer(
	queued: "user" | "agent" | "none" | "agent-then-user",
	speculative = false,
	trailing = false,
	capturePending = false,
) {
	const generationReady = Promise.withResolvers<void>();
	const continueGeneration = Promise.withResolvers<void>();
	const speculativeStarted = Promise.withResolvers<void>();
	const finishSpeculation = Promise.withResolvers<void>();
	const captureStarted = Promise.withResolvers<void>();
	const finishCapture = Promise.withResolvers<void>();
	const executed: string[] = [];
	const speculativeCalls: string[] = [];
	const seenContexts: string[] = [];
	let providerCalls = 0;
	const tool = {
		name: "steering_probe",
		label: "steering_probe",
		description: "Fixture probe",
		parameters: { type: "object", properties: {} },
		async execute(id: string) {
			executed.push(id);
			return { content: [{ type: "text", text: `ordinary ${id}` }], details: {} };
		},
		...(speculative ? {
			speculation: {
				finalized: {
					assess: () => ({ eligible: true, effect: { kind: "pure" } }),
					execute: async ({ toolCall }: { toolCall: { id: string } }) => {
						speculativeCalls.push(toolCall.id);
						speculativeStarted.resolve();
						await finishSpeculation.promise;
						return { kind: "result" as const, result: { content: [{ type: "text" as const, text: `speculative ${toolCall.id}` }], details: {} }, isError: false };
					},
				},
			},
		} : {}),
	};
	const streamFn = (_model: unknown, context: { messages: unknown[] }) => {
		const response = createSteeringStream();
		const turn = ++providerCalls;
		seenContexts.push(JSON.stringify(context.messages));
		void (async () => {
			const calls = turn === 1
				? [
					{ type: "toolCall" as const, id: "steering-1", name: "steering_probe", arguments: {} },
					{ type: "toolCall" as const, id: "steering-2", name: "steering_probe", arguments: {} },
				]
				: [];
			const message = {
				role: "assistant" as const,
				content: calls.length ? calls : [{ type: "text" as const, text: "변경된 지시를 반영했습니다." }],
				api: steeringModel.api, provider: steeringModel.provider, model: steeringModel.id,
				usage: steeringUsage(), stopReason: calls.length ? "toolUse" as const : "stop" as const,
				timestamp: Date.now(),
			};
			response.push({ type: "start", partial: message });
			if (turn === 1) {
				for (const [contentIndex, call] of calls.entries()) {
					response.push({ type: "toolcall_start", contentIndex, partial: message });
					response.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
				}
				generationReady.resolve();
				await continueGeneration.promise;
			}
			if (!trailing || turn !== 1) response.push({ type: "done", reason: message.stopReason, message });
			response.end(message);
		})();
		return response;
	};
	const agent = new SteeringAgent({
		initialState: { systemPrompt: [], model: steeringModel, tools: [tool], messages: [] },
		streamFn: streamFn as never,
		speculativeToolExecution: speculative ? {
			enabled: true, maxInFlight: 1,
			...(capturePending ? { host: {
				authorize: () => ({ allowed: true }),
				captureEvidence: async () => {
					captureStarted.resolve();
					await finishCapture.promise;
					return true;
				},
			} } : {}),
		} : undefined,
	});
	const unsubscribe = agent.subscribe(event => {
		if (event.type === "message_end" && event.message.role === "assistant" && providerCalls === 1) {
			finishSpeculation.resolve();
		}
	});
	const run = agent.prompt("먼저 할 일");
	await generationReady.promise;
	if (speculative) await (capturePending ? captureStarted.promise : speculativeStarted.promise);
	const steer = (attribution: "agent" | "user", text: string) => agent.steer({
		role: "user", content: text, steering: true, attribution, timestamp: Date.now(),
	});
	if (queued === "user") steer("user", "사용자-새 지시");
	if (queued === "agent") steer("agent", "에이전트-알림");
	if (queued === "agent-then-user") {
		agent.setSteeringMode("one-at-a-time");
		steer("agent", "에이전트-알림");
		steer("user", "사용자-뒤쪽 지시");
	}
	finishCapture.resolve();
	continueGeneration.resolve();
	await run;
	unsubscribe();
	return { agent, executed, speculativeCalls, seenContexts };
}
const generatedUser = await runGenerationSteer("user");
const userToolResults = generatedUser.agent.state.messages.filter((m: { role: string }) => m.role === "toolResult") as Array<{ toolCallId: string; details?: { __synthetic?: boolean }; content: Array<{ text?: string }> }>;
check("생성 중 user steer는 두 toolCall 모두 실행하지 않는다", generatedUser.executed.length === 0, `executed=${generatedUser.executed}`);
check("각 toolCall에 건너뜀 결과를 붙인다", userToolResults.length === 2 && userToolResults.every(m => m.details?.__synthetic));
const generatedAgent = await runGenerationSteer("agent");
check("agent steer는 기존 도구 실행을 유지한다", generatedAgent.executed.length === 2, `executed=${generatedAgent.executed}`);
const generatedPlain = await runGenerationSteer("none");
check("steer가 없으면 기존 도구 실행을 유지한다", generatedPlain.executed.length === 2, `executed=${generatedPlain.executed}`);
const generatedBehindAgent = await runGenerationSteer("agent-then-user");
check("one-at-a-time 큐의 agent steer 뒤 user steer도 찾아 기존 도구를 차단한다", generatedBehindAgent.executed.length === 0 && generatedBehindAgent.seenContexts.some((context, i) => i > 1 && context.includes("사용자-뒤쪽 지시")));
const generatedSpeculative = await runGenerationSteer("user", true);
const speculativeResults = generatedSpeculative.agent.state.messages.filter((m: { role: string }) => m.role === "toolResult") as Array<{ toolCallId: string; details?: { __synthetic?: boolean }; content: Array<{ text?: string }> }>;
check("이미 시작한 speculative 도구는 실제 결과를 기다리고 재실행하지 않는다", generatedSpeculative.speculativeCalls.join(",") === "steering-1" && generatedSpeculative.executed.length === 0 && speculativeResults.find(m => m.toolCallId === "steering-1")?.content[0]?.text === "speculative steering-1");
check("아직 시작하지 않은 speculative 도구만 건너뛴다", speculativeResults.find(m => m.toolCallId === "steering-2")?.details?.__synthetic === true);
const generatedCapturePending = await runGenerationSteer("user", true, false, true);
const captureResults = generatedCapturePending.agent.state.messages.filter((m: { role: string }) => m.role === "toolResult") as Array<{ toolCallId: string; details?: { __synthetic?: boolean } }>;
check("증거 캡처 중 실제 실행 전 steer는 speculative 도구를 시작하지 않는다", generatedCapturePending.speculativeCalls.length === 0 && captureResults.length === 2 && captureResults.every(m => m.details?.__synthetic === true));
const generatedTrailing = await runGenerationSteer("user", false, true);
check("terminal done 이벤트 없이 끝난 응답도 사용자 steer보다 도구를 앞세우지 않는다", generatedTrailing.executed.length === 0 && generatedTrailing.seenContexts.some((context, i) => i > 0 && context.includes("사용자-새 지시")));

console.log("\n[21] steering reply extension — 답 없이 시작한 도구는 막지 않고 안내만 끼운다");
function replyGateHarness() {
	const listeners = new Map<string, Array<(event: unknown) => unknown>>();
	const sent: unknown[] = [];
	steeringReplyGate({
		on: (name: string, listener: (event: unknown) => unknown) => {
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
		},
		sendMessage: (message: unknown) => { sent.push(message); },
	} as never);
	const emit = (name: string, event: unknown) => listeners.get(name)?.map(listener => listener(event)).at(-1);
	return { emit, sent };
}
for (const content of [[], [{ type: "thinking", thinking: "진행" }], [{ type: "text", text: "   " }]]) {
	const gate = replyGateHarness();
	gate.emit("message_start", { message: { role: "user", content: "방향 바꿔", steering: true, attribution: "user" } });
	gate.emit("message_start", { message: { role: "assistant", content } });
	const first = gate.emit("tool_call", { toolName: "read", toolCallId: "first", input: {} }) as { block?: boolean } | undefined;
	gate.emit("tool_call", { toolName: "read", toolCallId: "second", input: {} });
	check("답 없이 시작한 도구도 막지 않고 안내를 한 번만 끼운다", first?.block !== true && gate.sent.length === 1);
}
// 2026-09-25 실사례: 도구 앞 답은 서명에 "narration"이 든 빈 thinking 블록으로 온다. 이걸 답으로 인정해야 한다.
const narrated = replyGateHarness();
narrated.emit("message_start", { message: { role: "user", content: "방향 바꿔", steering: true, attribution: "user" } });
narrated.emit("tool_call", {
	toolName: "read", toolCallId: "first", input: {},
	assistantMessage: { role: "assistant", content: [
		{ type: "thinking", thinking: "", thinkingSignature: Buffer.from("\u0008thinking").toString("base64") },
		{ type: "thinking", thinking: "", thinkingSignature: Buffer.from("\u0008narration").toString("base64") },
		{ type: "toolCall" },
	] },
});
check("서명된 narration 블록을 앞선 답으로 인정한다", narrated.sent.length === 0);
const replied = replyGateHarness();
replied.emit("message_start", { message: { role: "user", content: "방향 바꿔", steering: true, attribution: "user" } });
replied.emit("message_start", { message: { role: "assistant", content: [] } });
replied.emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: "새 지시를 반영하겠습니다." }] } });
check("스트리밍 텍스트로 먼저 답하면 도구가 통과한다", replied.emit("tool_call", { toolName: "read", toolCallId: "first", input: {} }) === undefined);
// 2026-09-25 실사례: 도구가 스트리밍 중 미리 실행돼 message_update 전에 tool_call이 판정되면, 같은 응답의 앞선 답을
// 못 보고 막았다. core patch가 tool_call 이벤트에 싣는 assistantMessage만으로 통과해야 한다.
const raced = replyGateHarness();
raced.emit("message_start", { message: { role: "user", content: "방향 바꿔", steering: true, attribution: "user" } });
raced.emit("message_start", { message: { role: "assistant", content: [] } });
check(
	"이벤트 순서와 무관하게 도구 호출 메시지의 앞선 답을 인정한다",
	raced.emit("tool_call", {
		toolName: "read", toolCallId: "first", input: {},
		assistantMessage: { role: "assistant", content: [{ type: "text", text: "확인할게요." }, { type: "toolCall" }] },
	}) === undefined,
);
const agentGate = replyGateHarness();
agentGate.emit("message_start", { message: { role: "user", content: "완료 통지", steering: true, attribution: "agent" } });
check("agent steer는 답변 게이트를 열지 않는다", agentGate.emit("tool_call", { toolName: "read", toolCallId: "first", input: {} }) === undefined);

console.log("\n[22] IRC wake 턴 — yield 없는 산문 답장은 완료된 SubAgent 를 failed 로 뒤집지 않는다");
// 2026-09-24 실사례(NovaVoice): yield 로 정상 완료한 maker 가 형제의 "고마워요"에 산문으로 답하는
// wake 턴을 돌자 카드가 failed 로 바뀌었다(transcript 는 stopReason stop, 오류 없음). outputSchema 가
// 있는 에이전트의 missing-yield 를 finalizeSubprocessOutput 이 exitCode 1 로 만들기 때문이다.
// 오류로 끝난 wake 턴은 여전히 failed 여야 한다.
const wakeFrames: Array<{ status?: string }> = [];
const wakeBus = { emit: (_channel: string, data: unknown) => wakeFrames.push(data as { status?: string }) } as never;
let wakeLast: unknown;
const wakeListeners = new Set<(event: unknown) => void>();
let novaObserver: ((records: unknown[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
const novaReplies: Promise<void>[] = [];
const novaSession = {
	setIrcWakeTurnObserver: (o: typeof novaObserver) => {
		novaObserver = o;
	},
	trackIrcReply: (p: Promise<void>) => novaReplies.push(p),
	subscribe: (cb: (event: unknown) => void) => {
		wakeListeners.add(cb);
		return () => wakeListeners.delete(cb);
	},
	getLastAssistantMessage: () => wakeLast,
	isAdvisorActive: () => false,
	servingModel: undefined,
	hasPendingAsyncWork: () => false,
	abort: async () => {},
	waitForIdle: async () => {},
	getToolByName: () => undefined,
} as never;
globalReg.register({ id: "Nova", displayName: "maker", kind: "sub", parentId: MAIN_AGENT_ID, session: novaSession });
attachIrcWakeTurnMonitor(novaSession, {
	id: "Nova",
	agent: { name: "maker", source: "project", description: "harness" },
	artifactsDir,
	eventBus: wakeBus,
	outputSchema: { properties: { summary: { type: "string" } } },
});
async function driveNovaWakeTurn(assistant: { content: unknown[]; stopReason: string; errorMessage?: string }): Promise<string | undefined> {
	await nextTurnBoundary();
	const before = wakeFrames.length;
	const finish = novaObserver?.([{ role: "custom", content: "고마워요", details: { message: "고마워요" } }]);
	for (const l of [...wakeListeners]) l({ type: "message_start", message: { role: "assistant" } });
	wakeLast = { role: "assistant", ...assistant };
	for (const l of [...wakeListeners]) l({ type: "message_end", message: wakeLast });
	await finish?.(undefined);
	await Promise.all(novaReplies.splice(0));
	return wakeFrames.slice(before).findLast(frame => frame.status && frame.status !== "started")?.status;
}
const proseStatus = await driveNovaWakeTurn({ content: [{ type: "text", text: "저도 고마워요!" }], stopReason: "stop" });
check("schema 가진 SubAgent 의 산문 wake 답장은 completed 로 끝난다", proseStatus === "completed", `status=${proseStatus}`);
const errorStatus = await driveNovaWakeTurn({ content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "provider stream failed" });
check("provider 오류로 끝난 wake 턴은 여전히 failed 다", errorStatus === "failed", `status=${errorStatus}`);
const abortedStatus = await driveNovaWakeTurn({ content: [{ type: "text", text: "" }], stopReason: "aborted" });
check("중단된 wake 턴은 여전히 aborted 다", abortedStatus === "aborted", `status=${abortedStatus}`);
rmSync(artifactsDir, { recursive: true, force: true });

// 2026-09-25 실장애: CUELO 셸이 `next start`의 NODE_ENV=production·PORT=30141·NEXT_* 를 물려받아
// 셸에서 띄운 `next dev`가 CSS 파싱에 실패했다. 자식 셸 env 를 만드는 실제 함수로 확인한다.
console.log("\nCUELO Next 서버 env 를 자식 셸에 넘기지 않는다");
{
	const { filterChildShellEnv } = await import(`${CORE}/../../pi-utils/src/env.ts`);
	const envCwd = mkdtempSync(join(tmpdir(), "hanse-shell-env-"));
	const serverEnv = {
		KEEP_ME: "1",
		NODE_ENV: "production",
		PORT: "30141",
		NEXT_RUNTIME: "nodejs",
		NEXT_DEPLOYMENT_ID: "",
		NEXT_PRIVATE_START_TIME: "1790334741693",
		__NEXT_PRIVATE_ORIGIN: "http://localhost:30141",
	};
	const stripped = filterChildShellEnv({ ...serverEnv, CUELO_SHELL_ENV_BASELINE: "{}" }, envCwd);
	const leaked = ["NODE_ENV", "PORT", "NEXT_RUNTIME", "NEXT_DEPLOYMENT_ID", "NEXT_PRIVATE_START_TIME", "__NEXT_PRIVATE_ORIGIN", "CUELO_SHELL_ENV_BASELINE"].filter(key => key in stripped);
	check("Next 서버 안: 서버 변수를 지우고 무관한 변수는 둔다", leaked.length === 0 && stripped.KEEP_ME === "1", `leaked=${leaked.join(",")}`);
	const restored = filterChildShellEnv({ ...serverEnv, CUELO_SHELL_ENV_BASELINE: JSON.stringify({ NODE_ENV: "test", PORT: "4000" }) }, envCwd);
	check("런처 기준값이 있으면 NODE_ENV·PORT 를 그 값으로 되돌린다", restored.NODE_ENV === "test" && restored.PORT === "4000", `NODE_ENV=${restored.NODE_ENV} PORT=${restored.PORT}`);
	const plain = filterChildShellEnv({ KEEP_ME: "1", NODE_ENV: "development", PORT: "5173" }, envCwd);
	check("Next 서버 밖(TUI)에서는 NODE_ENV·PORT 를 그대로 둔다", plain.NODE_ENV === "development" && plain.PORT === "5173", `NODE_ENV=${plain.NODE_ENV} PORT=${plain.PORT}`);
	// native 셸은 sessionEnv 를 부모 env 위에 덧씌우기만 한다. 배포 뒤에도 셸에 값이 남았던 것이 그
	// 때문이라, 실제 executeBash 를 서버 env 를 가진 별도 프로세스에서 돌려 셸 안의 값을 본다.
	// 셸 설정은 프로세스 수명 동안 캐시되므로 이 테스트 프로세스에서 env 를 바꿔서는 볼 수 없다.
	const probeHome = mkdtempSync(join(tmpdir(), "hanse-shell-home-"));
	const probe = `const { executeBash } = await import(${JSON.stringify(`${CORE}/exec/bash-executor.ts`)});
const result = await executeBash('echo "NODE_ENV=\${NODE_ENV-unset} PORT=\${PORT-unset} NEXT_RUNTIME=\${NEXT_RUNTIME-unset} ORIGIN=\${__NEXT_PRIVATE_ORIGIN-unset} KEEP_ME=\${KEEP_ME-unset}"', { cwd: ${JSON.stringify(envCwd)} });
console.log(result.output.trim());
process.exit(0);`;
	const child = Bun.spawnSync([process.execPath, "-e", probe], {
		cwd: envCwd,
		env: { ...process.env, ...serverEnv, CUELO_SHELL_ENV_BASELINE: "{}", HOME: probeHome, USERPROFILE: probeHome },
	});
	const shellLine = child.stdout.toString().trim().split(/\r?\n/).pop() ?? "";
	check(
		"실제 bash 도구 셸에 서버 변수가 새지 않는다",
		shellLine === "NODE_ENV=unset PORT=unset NEXT_RUNTIME=unset ORIGIN=unset KEEP_ME=1",
		`shell=${shellLine} stderr=${child.stderr.toString().trim().slice(0, 300)}`,
	);
	rmSync(probeHome, { recursive: true, force: true });
	rmSync(envCwd, { recursive: true, force: true });
}

// 사용자 메시지로 보류한 호출의 결과가 "the assistant ended its turn" 으로 시작해 턴이 끝난 것처럼
// 읽혔다. 사유가 있는 skipped 는 그 문장만, 사유 없는 skipped(턴이 실제로 끝남)는 upstream 문구다.
console.log("\n사유가 있는 skipped 결과는 턴 종료 문구를 붙이지 않는다");
{
	const { createSyntheticToolResultMessage } = await import(`${CORE}/../../pi-agent-core/src/agent-loop.ts`);
	const call = { type: "toolCall", id: "call-skip", name: "read", arguments: {} } as never;
	const steered = createSyntheticToolResultMessage(call, "skipped", "Not executed: a user message arrived before this call ran.").content[0]?.text;
	check("보류 사유가 있으면 그 문장만 남는다", steered === "Not executed: a user message arrived before this call ran.", `text=${steered}`);
	const ended = String(createSyntheticToolResultMessage(call, "skipped").content[0]?.text);
	check("사유 없는 skipped 는 턴 종료 문구를 유지한다", ended.includes("ended its turn"), `text=${ended}`);
}

// `learn`/`retain` 원문 1건에서 파생된 fact 가 원문과 함께 `<memories>`·`recall` 에 실렸다(2026-09-26 CUELO
// 은행 `sed` 교훈 1건이 3줄). 원문이 결과에 있으면 파생 fact 는 빠지고, 원문이 없는 fact 는 남아야 한다.
// 파생 fact 는 LLM 추출 대신 추출기가 쓰는 것과 같은 행(facts.source_msg_id = 원문 id)으로 넣는다.
console.log("\n[23] Mnemopi 회수 — 원문이 실린 기억의 파생 fact 는 중복으로 싣지 않는다");
{
	const { Mnemopi } = await import(`${CORE}/../../pi-mnemopi/src/index.ts`);
	const memDir = mkdtempSync(join(tmpdir(), "hanse-mnemopi-"));
	const bank = "dedupe";
	const memory = new Mnemopi({ dbPath: join(memDir, "m.db"), bank, sessionId: bank, channelId: bank, embeddings: false, llm: false, reconcile: false });
	try {
		const origin = memory.remember(
			"omp bash 도구의 `sed`는 셸 내장 `sed 0.1.1`이다. `\\b`(단어 경계)를 지원하지 않는데 오류 없이 매치 0으로 끝난다.",
			{ source: "coding-agent-learn", importance: 0.8, scope: "bank" },
		);
		const addFact = (factId: string, object: string, sourceId: string) =>
			memory.beam.db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, source_msg_id, confidence) VALUES (?, ?, 'fact', 'entity', ?, ?, ?, 0.8)",
				[factId, bank, object, new Date().toISOString(), sourceId],
			);
		addFact("derived-1", "omp bash 도구의 `sed`는 셸 내장 `sed 0.1.1`이다", origin);
		addFact("derived-2", "셸 내장 `sed 0.1.1`은 `\\b`(단어 경계)를 지원하지 않는다", origin);
		addFact("orphan", "sed 단어 경계 대신 perl 을 쓸 수 있다", "gone-origin");
		const results = (await memory.recallEnhanced("sed 단어 경계", 8, { includeFacts: true, channelId: bank })) as Array<{ id: string; source_memory_id?: unknown }>;
		const ids = results.map(result => result.id);
		check("원문 기억은 그대로 실린다", ids.includes(origin), `ids=${ids.join(",")}`);
		check("원문이 실린 기억의 파생 fact 는 빠진다", !ids.includes("derived-1") && !ids.includes("derived-2"), `ids=${ids.join(",")}`);
		const orphan = results.find(result => result.id === "orphan");
		check("원문이 결과에 없는 fact 는 남고 원문 id 를 싣는다", orphan?.source_memory_id === "gone-origin", `ids=${ids.join(",")}`);
	} finally {
		memory.close();
		rmSync(memDir, { recursive: true, force: true });
	}
}

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
