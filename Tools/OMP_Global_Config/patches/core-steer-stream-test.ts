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
// [3]–[11]은 P55(2026-10-01): 보이는 출력이 아직 없는 요청에 genuine steer 가 오면 그 요청만 끊고 같은 run 에서
// 다시 요청한다(run abort 아님). 실제 Agent 루프와 Codex provider 를 로컬 가짜 서버에 붙여 wire 까지 본다.
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
// 18.4.2 는 기본 모델을 고를 때 환경 변수 키가 있는 provider(OPENAI_API_KEY 등)를 fixture 보다 앞에 둔다.
// 운영자 환경이 끼지 않도록 fixture 모델을 기본 역할로 고정한다.
writeFileSync(join(agentDir, "config.yml"), `modelRoles:\n  default: ${FIXTURE_PROVIDER}/${FIXTURE_MODEL_ID}\n`, "utf8");

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
// "wire": [12] 의 실제 provider 호출은 그대로 통과시킨다.
let phase: "plain" | "tool" | "quiet" | "wire" = "plain";

/** provider 요청 직전(스트리밍 중) 훅. 여기서 genuine steer 를 꽂고 예외로 turn 을 끝낸다. */
agent.addBeforeModelCallHook(async () => {
	if (phase === "wire") return;
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

// ── P55: 보이는 출력이 아직 없는 요청에 들어온 genuine steer ─────────────────────────────
// 실제 Agent 루프 + 실제 Codex provider(WebSocket·SSE)를 로컬 가짜 서버에 붙인다. 첫 응답은 reasoning
// 항목 하나를 보낸 뒤 끝나지 않는다(정지한 provider). steer 가 그 요청을 끝까지 기다리지 않고 새 요청에서
// 소비되는지, 버린 partial 이 listener·context·wire 에 남지 않는지, 보존해야 할 경우(native accept, 이미 보인
// text, 내부 agent steer, follow-up)는 그대로인지 본다. 패치 전 core 에서는 정지 응답 경우가 시간 초과로 RED 다.
const { streamOpenAICodexResponses } = await import(`${CORE}/../../pi-ai/src/providers/openai-codex-responses.ts`);
const { getBundledModel } = await import(`${CORE}/../../pi-catalog/src/models.ts`);
const { Agent } = await import(`${CORE}/../../pi-agent-core/src/index.ts`);
const { convertToLlm, wrapSteeringForModel } = await import(`${CORE}/session/messages.ts`);

type WireMode = "hang" | "visible-text" | "late-created" | "accept";
let wireMode: WireMode = "hang";
let wireCreates: string[] = [];
let wireSteerFrames = 0;
const wireCompleted = (id: string, output: unknown[] = []) => ({
	type: "response.completed",
	response: { id, status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
});
type WireFrame = { type: string; [key: string]: unknown };
/** 요청 하나가 보낼 frame 과 보낼 시각(ms). 같은 run 의 첫 요청만 모드를 따르고, 나머지는 짧은 답을 하고 끝난다. */
function wireFrames(id: string, first: boolean): Array<[number, WireFrame]> {
	if (!first) {
		// 빈 응답이면 세션의 빈-응답 복구가 끼어든다.
		const msg = { type: "message", id: `msg_${id}`, role: "assistant", content: [] };
		return [
			[0, { type: "response.created", response: { id } }],
			[5, { type: "response.output_item.added", output_index: 0, item: msg }],
			[6, { type: "response.content_part.added", output_index: 0, item_id: msg.id, content_index: 0, part: { type: "output_text", text: "" } }],
			[10, { type: "response.output_text.delta", output_index: 0, item_id: msg.id, content_index: 0, delta: "OK" }],
			[20, wireCompleted(id, [{ ...msg, content: [{ type: "output_text", text: "OK" }] }])],
		];
	}
	const created = wireMode === "late-created" ? 150 : 0;
	const frames: Array<[number, WireFrame]> = [[created, { type: "response.created", response: { id } }]];
	if (wireMode === "accept") return [...frames, [700, wireCompleted(id)]];
	const reasoning = { type: "reasoning", id: `rs_${id}`, summary: [], encrypted_content: `DISCARDED_SIG_${id}` };
	frames.push([created + 20, { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: undefined } }]);
	frames.push([created + 40, { type: "response.output_item.done", output_index: 0, item: reasoning }]);
	if (wireMode === "visible-text") {
		const msg = { type: "message", id: `msg_${id}`, role: "assistant", content: [] };
		frames.push([60, { type: "response.output_item.added", output_index: 1, item: msg }]);
		frames.push([61, { type: "response.content_part.added", output_index: 1, item_id: msg.id, content_index: 0, part: { type: "output_text", text: "" } }]);
		frames.push([70, { type: "response.output_text.delta", output_index: 1, item_id: msg.id, content_index: 0, delta: "VISIBLE_ANSWER" }]);
		frames.push([900, wireCompleted(id, [reasoning, { ...msg, content: [{ type: "output_text", text: "VISIBLE_ANSWER" }] }])]);
	}
	return frames; // hang·late-created: 끝나지 않는다
}
const wireServer = Bun.serve({
	port: 0,
	async fetch(req, srv) {
		if (srv.upgrade(req)) return undefined;
		const body = await req.text();
		wireCreates.push(body);
		const frames = wireFrames(`resp_${wireCreates.length}`, wireCreates.length === 1);
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			async start(controller) {
				let at = 0;
				for (const [delay, frame] of frames) {
					await Bun.sleep(delay - at);
					at = delay;
					try {
						controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
					} catch {
						return; // 클라이언트가 요청을 끊었다
					}
				}
				if (frames.at(-1)?.[1].type === "response.completed") controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
	websocket: {
		message(ws, raw) {
			const frame = JSON.parse(String(raw)) as { type: string; previous_response_id?: string };
			if (frame.type === "response.create") {
				wireCreates.push(String(raw));
				for (const [delay, out] of wireFrames(`resp_${wireCreates.length}`, wireCreates.length === 1)) {
					setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify(out)), delay);
				}
			} else if (frame.type === "response.steer") {
				wireSteerFrames++;
				const steer = { id: `steer_${wireSteerFrames}`, previous_response_id: frame.previous_response_id };
				ws.send(
					JSON.stringify(
						wireMode === "accept"
							? { type: "response.steer.accepted", steer }
							: {
									type: "error",
									status: 400,
									error: { type: "invalid_request_error", code: "unsupported_native_inflight_message", message: "native lane" },
								},
					),
				);
			}
		},
	},
});

function wireJwt(): string {
	return `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } })).toString("base64")}.s`;
}
const genuineSteer = (text: string, extra: Record<string, unknown> = {}) => ({
	role: "user",
	content: [{ type: "text", text }],
	steering: true,
	attribution: "user",
	timestamp: Date.now(),
	...extra,
});

type WireResult = { outcome: "idle" | "timeout"; events: string[]; agent: InstanceType<typeof Agent>; creates: string[] };
async function wireRun(
	mode: WireMode,
	opts: { websocket: boolean; supportsSteering?: boolean; at?: number; deadlineMs?: number },
	inject: (agent: InstanceType<typeof Agent>) => void,
): Promise<WireResult> {
	wireMode = mode;
	wireCreates = [];
	wireSteerFrames = 0;
	const base = getBundledModel("openai-codex", "gpt-5.5");
	const model = {
		...base,
		baseUrl: `http://127.0.0.1:${wireServer.port}/codex`,
		preferWebsockets: opts.websocket,
		compat: { ...base.compat, supportsSteering: opts.supportsSteering ?? true },
	};
	const pool = new Map<string, unknown>();
	const agent = new Agent({
		initialState: { model, systemPrompt: "", tools: [], messages: [] },
		sessionId: `p55-${mode}-${opts.websocket ? "ws" : "sse"}-${Date.now()}`,
		convertToLlm,
		transformContext: async (messages: unknown[]) => wrapSteeringForModel(messages),
		streamFn: (m: unknown, context: unknown, options: Record<string, unknown>) =>
			streamOpenAICodexResponses(m, context, { ...options, apiKey: wireJwt(), providerSessionState: pool }),
	});
	const events: string[] = [];
	let textSeen = false;
	agent.subscribe((event: { type: string; message?: { role: string; content?: Array<{ type: string; text?: string }> } }) => {
		if (event.type === "message_start") textSeen = false;
		if (event.type === "message_update" && !textSeen && event.message?.content?.some(b => b.type === "text" && b.text?.trim())) {
			textSeen = true;
			events.push("visible-text");
		}
		if (event.type === "message_start" || event.type === "message_end") events.push(`${event.type}:${event.message?.role}`);
	});
	const done = agent.prompt("시작").then(() => agent.waitForIdle()).then(() => "idle" as const);
	setTimeout(() => inject(agent), opts.at ?? 200);
	const { promise: deadline, resolve } = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => resolve("timeout"), opts.deadlineMs ?? 5_000);
	const outcome = await Promise.race([done, deadline]);
	clearTimeout(timer);
	if (outcome === "timeout") {
		agent.abort();
		await agent.waitForIdle();
	}
	return { outcome, events, agent, creates: [...wireCreates] };
}
const assistantsOf = (r: WireResult) => r.agent.state.messages.filter((m: { role: string }) => m.role === "assistant") as Array<{ stopReason?: string; content: Array<{ type: string }> }>;
const occurrences = (body: string | undefined, text: string) => (body ?? "").split(text).length - 1;
const inputItems = (body: string | undefined): Array<{ type?: string; role?: string }> => {
	const parsed = JSON.parse(body ?? "{}");
	return parsed.input ?? parsed.response?.input ?? [];
};
/** 첫 assistant 응답(다음 message_start 전까지)이 listener 에 text 를 보였는가. */
const firstResponseShowedText = (events: string[]): boolean => {
	const start = events.indexOf("message_start:assistant");
	const next = events.indexOf("message_start:assistant", start + 1);
	return events.slice(start, next === -1 ? undefined : next).includes("visible-text");
};
/** 정지한 첫 응답을 기다리지 않고 steer 를 소비했는가: 새 create 1개, 거기에만 steer, 버린 partial 흔적 없음. */
function checkRestarted(label: string, r: WireResult, steer: string): void {
	check(`${label}: 첫 응답이 끝나지 않아도 run 이 완료된다`, r.outcome === "idle", r.outcome);
	check(`${label}: steer 는 두 번째 create 에 정확히 한 번 실린다`, r.creates.length === 2 && occurrences(r.creates[1], steer) === 1, `creates=${r.creates.length}`);
	check(
		`${label}: 두 번째 create 에 버린 응답의 assistant·reasoning·responseId 가 없다`,
		!inputItems(r.creates[1]).some(item => item.role === "assistant" || item.type === "reasoning") &&
			occurrences(r.creates[1], "DISCARDED_SIG") === 0 &&
			occurrences(r.creates[1], "resp_1") === 0,
		JSON.stringify(inputItems(r.creates[1])),
	);
	const assistants = assistantsOf(r);
	check(`${label}: 기록에는 새 응답 하나만 남는다(aborted partial 없음)`, assistants.length === 1 && assistants[0]?.stopReason === "stop", JSON.stringify(assistants.map(a => a.stopReason)));
	check(`${label}: 버린 partial 은 message_end 없이 사라진다`, r.events.filter(e => e === "message_end:assistant").length === 1, r.events.join(" "));
	check(`${label}: 버린 partial 에서 보이는 text 가 나간 적이 없다`, !firstResponseShowedText(r.events), r.events.join(" "));
}

try {
	console.log("\n[3] WebSocket native lane 거절 + 정지한 응답");
	const wsReject = await wireRun("hang", { websocket: true }, a => a.steer(genuineSteer("STEER_WS")));
	check("[3] response.steer 를 한 번 시도했다", wireSteerFrames === 1, String(wireSteerFrames));
	checkRestarted("[3]", wsReject, "STEER_WS");

	console.log("\n[4] SSE(pump 없음) + 정지한 응답");
	checkRestarted("[4]", await wireRun("hang", { websocket: false }, a => a.steer(genuineSteer("STEER_SSE"))), "STEER_SSE");

	console.log("\n[5] live steering 미지원 provider + 정지한 응답");
	checkRestarted("[5]", await wireRun("hang", { websocket: true, supportsSteering: false }, a => a.steer(genuineSteer("STEER_NOLIVE"))), "STEER_NOLIVE");

	console.log("\n[6] response.created 이전 steer");
	checkRestarted("[6]", await wireRun("late-created", { websocket: true, at: 100 }, a => a.steer(genuineSteer("STEER_EARLY"))), "STEER_EARLY");

	console.log("\n[7] genuine steer 두 개가 연달아 온다");
	const two = await wireRun("hang", { websocket: false }, a => {
		a.steer(genuineSteer("STEER_ONE"));
		setTimeout(() => a.steer(genuineSteer("STEER_TWO")), 5);
	});
	check("[7] run 이 완료된다", two.outcome === "idle", two.outcome);
	check(
		"[7] 두 steer 모두 마지막 create 에 정확히 한 번씩 실린다",
		occurrences(two.creates.at(-1), "STEER_ONE") === 1 && occurrences(two.creates.at(-1), "STEER_TWO") === 1,
		`creates=${two.creates.length}`,
	);
	check(
		"[7] 대화 기록에도 한 번씩만 남는다",
		["STEER_ONE", "STEER_TWO"].every(t => two.agent.state.messages.filter((m: { role: string }) => m.role === "user" && JSON.stringify(m).includes(t)).length === 1),
	);

	console.log("\n[8] native accept 는 진행 중 요청을 살린다");
	const accepted = await wireRun("accept", { websocket: true }, a => a.steer(genuineSteer("STEER_ACCEPT")));
	check("[8] response.steer 가 수락됐다", wireSteerFrames === 1, String(wireSteerFrames));
	check("[8] 첫 응답이 끝까지 진행해 기록된다", assistantsOf(accepted).length === 2 && assistantsOf(accepted).every(a => a.stopReason === "stop"), JSON.stringify(assistantsOf(accepted).map(a => a.stopReason)));

	console.log("\n[9] 이미 text 가 보인 요청은 끊지 않는다");
	const visible = await wireRun("visible-text", { websocket: false }, a => a.steer(genuineSteer("STEER_AFTER_TEXT")));
	const visibleAssistants = assistantsOf(visible);
	check("[9] 보인 답이 그대로 기록된다", visibleAssistants[0]?.stopReason === "stop" && visibleAssistants[0]?.content.some(b => b.type === "text") === true, JSON.stringify(visibleAssistants.map(a => a.content.map(b => b.type))));
	check("[9] steer 는 그 답 뒤 다음 create 에 실린다", visible.creates.length === 2 && occurrences(visible.creates[1], "VISIBLE_ANSWER") === 1 && occurrences(visible.creates[1], "STEER_AFTER_TEXT") === 1);

	console.log("\n[10] text chunk 와 steer 가 같은 순간에 온다");
	const race = await wireRun("visible-text", { websocket: true, at: 70 }, a => a.steer(genuineSteer("STEER_RACE")));
	const raceTextCommitted = assistantsOf(race).some(a => JSON.stringify(a).includes("VISIBLE_ANSWER"));
	check(
		"[10] 보인 text 는 지워지지 않는다(보였으면 기록되고, 버렸으면 보인 적이 없다)",
		race.outcome === "idle" && firstResponseShowedText(race.events) === raceTextCommitted,
		`${race.outcome} ${race.events.join(" ")}`,
	);

	console.log("\n[11] 내부 agent steer 와 follow-up 은 진행 중 요청을 끊지 않는다");
	const internal = await wireRun("hang", { websocket: false, deadlineMs: 1_200 }, a => a.steer(genuineSteer("AGENT_STEER", { attribution: "agent" })));
	check("[11] agent steer: 요청이 그대로 남는다(새 create 없음)", internal.outcome === "timeout" && internal.creates.length === 1, `${internal.outcome} creates=${internal.creates.length}`);
	const followUp = await wireRun("hang", { websocket: false, deadlineMs: 1_200 }, a => a.followUp(genuineSteer("FOLLOW_UP", { steering: undefined })));
	check("[11] follow-up: 요청이 그대로 남는다(새 create 없음)", followUp.outcome === "timeout" && followUp.creates.length === 1, `${followUp.outcome} creates=${followUp.creates.length}`);

	console.log("\n[12] 실제 AgentSession: 버린 partial 은 세션 기록·agent_end 에 남지 않는다");
	// 위 실제 세션의 provider 호출만 같은 가짜 Codex(SSE)로 돌린다. persist 는 AgentSession 의 message_end 경로다.
	wireMode = "hang";
	wireCreates = [];
	const sessionBase = getBundledModel("openai-codex", "gpt-5.5");
	const sessionCodex = { ...sessionBase, baseUrl: `http://127.0.0.1:${wireServer.port}/codex`, preferWebsockets: false };
	const realStreamFn = agent.streamFn;
	agent.streamFn = (_m: unknown, context: unknown, options: Record<string, unknown>) =>
		streamOpenAICodexResponses(sessionCodex, context, { ...options, apiKey: wireJwt(), providerSessionState: new Map() });
	const agentEndMessages: unknown[][] = [];
	const unsubscribeSession = session.subscribe((event: { type: string; messages?: unknown[] }) => {
		if (event.type === "agent_end") agentEndMessages.push(event.messages ?? []);
	});
	phase = "wire";
	const entriesBefore = session.sessionManager.getEntries().length;
	const sessionDone = session.prompt("세션 시작").then(() => agent.waitForIdle()).then(() => "idle" as const);
	setTimeout(() => void session.steer("STEER_SESSION"), 200);
	const { promise: sessionDeadline, resolve: sessionTimeout } = Promise.withResolvers<"timeout">();
	const sessionTimer = setTimeout(() => sessionTimeout("timeout"), 5_000);
	const sessionOutcome = await Promise.race([sessionDone, sessionDeadline]);
	clearTimeout(sessionTimer);
	if (sessionOutcome === "timeout") {
		agent.abort();
		await agent.waitForIdle();
	}
	phase = "quiet";
	agent.streamFn = realStreamFn;
	unsubscribeSession();
	const sessionEntries = session.sessionManager.getEntries().slice(entriesBefore) as Array<{ type: string; message?: { role: string; stopReason?: string } }>;
	const sessionAssistants = sessionEntries.filter(e => e.type === "message" && e.message?.role === "assistant");
	check("[12] 첫 응답이 끝나지 않아도 세션 run 이 완료된다", sessionOutcome === "idle", sessionOutcome);
	check(
		"[12] 세션 기록의 assistant 는 다시 요청한 응답 하나뿐이다",
		sessionAssistants.length === 1 && sessionAssistants[0]?.message?.stopReason === "stop",
		JSON.stringify(sessionAssistants.map(e => e.message?.stopReason)),
	);
	check("[12] 세션 기록에 버린 reasoning signature 가 없다", !JSON.stringify(sessionEntries).includes("DISCARDED_SIG"));
	check(
		"[12] steer 는 세션 기록에 한 번 남는다",
		sessionEntries.filter(e => e.type === "message" && e.message?.role === "user" && JSON.stringify(e).includes("STEER_SESSION")).length === 1,
	);
	check(
		"[12] agent_end 메시지 목록에도 버린 partial 이 없다",
		agentEndMessages.length > 0 && agentEndMessages.every(list => !JSON.stringify(list).includes("DISCARDED_SIG")),
		`agent_end=${agentEndMessages.length}`,
	);
	check("[12] wire: 두 번째 create 에 steer 가 한 번 실리고 버린 흔적이 없다", wireCreates.length === 2 && occurrences(wireCreates[1], "STEER_SESSION") === 1 && occurrences(wireCreates[1], "DISCARDED_SIG") === 0, `creates=${wireCreates.length}`);

	console.log("\n[13] 실제 AgentSession: restart 경계에서 오류가 나도 버린 partial 은 오류 메시지가 되지 않는다");
	// 버린 partial 은 Agent 의 마지막 snapshot 으로 남아 있다. 경계의 steering dequeue 가 던지거나(AgentSession
	// usage preflight 가 실제로 던지는 형태) 비고 다음 요청이 start 전에 실패하면, 그 오류가 partial 을 내용으로
	// 삼아 signature 째 persist 되면 안 된다. 원래 오류 문구는 그대로 남아야 한다.
	async function sessionRestartFailure(label: string, arm: () => () => void, expectedError: string): Promise<void> {
		wireMode = "hang";
		wireCreates = [];
		const assistantEnds: Array<{ stopReason?: string; errorMessage?: string; raw: string }> = [];
		const unsubscribe = session.subscribe((event: { type: string; message?: { role: string; stopReason?: string; errorMessage?: string } }) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				assistantEnds.push({ stopReason: event.message.stopReason, errorMessage: event.message.errorMessage, raw: JSON.stringify(event.message) });
			}
		});
		agent.streamFn = (_m: unknown, context: unknown, options: Record<string, unknown>) =>
			streamOpenAICodexResponses(sessionCodex, context, { ...options, apiKey: wireJwt(), providerSessionState: new Map() });
		const disarm = arm();
		phase = "wire";
		const before = session.sessionManager.getEntries().length;
		const done = session.prompt(`${label} 시작`).catch(() => undefined).then(() => agent.waitForIdle()).then(() => "idle" as const);
		setTimeout(() => void session.steer(`STEER_${label}`), 200);
		const { promise: deadline, resolve } = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => resolve("timeout"), 5_000);
		const outcome = await Promise.race([done, deadline]);
		clearTimeout(timer);
		if (outcome === "timeout") {
			agent.abort();
			await agent.waitForIdle();
		}
		phase = "quiet";
		disarm();
		agent.streamFn = realStreamFn;
		unsubscribe();
		const entries = JSON.stringify(session.sessionManager.getEntries().slice(before));
		const errored = assistantEnds.find(end => end.errorMessage === expectedError);
		check(`[13] ${label}: run 이 오류로 끝난다(멈추지 않는다)`, outcome === "idle", outcome);
		check(`[13] ${label}: 원래 오류가 assistant 오류로 남는다`, errored?.stopReason === "error", JSON.stringify(assistantEnds.map(end => [end.stopReason, end.errorMessage])));
		check(`[13] ${label}: 그 오류 메시지에 버린 signature 가 없다`, errored !== undefined && !errored.raw.includes("DISCARDED_SIG"));
		check(`[13] ${label}: 세션 기록에 버린 signature 가 없다`, !entries.includes("DISCARDED_SIG"));
		check(`[13] ${label}: Agent 상태에도 버린 signature 가 없다`, !JSON.stringify(agent.state.messages).includes("DISCARDED_SIG"));
	}
	await sessionRestartFailure(
		"DEQUEUE_THROWS",
		() =>
			agent.addBeforeQueuedMessageDequeueHook(() => {
				if (phase === "wire" && agent.peekSteeringQueue().length > 0) throw new DOMException("Usage preflight cancelled", "AbortError");
			}),
		"Usage preflight cancelled",
	);
	let preStartCalls = 0;
	await sessionRestartFailure(
		"EMPTY_THEN_PRESTART",
		() => {
			const detachDequeue = agent.addBeforeQueuedMessageDequeueHook(() => {
				if (phase === "wire" && agent.peekSteeringQueue().length > 0) agent.clearSteeringQueue();
			});
			const detachModelCall = agent.addBeforeModelCallHook(() => {
				if (phase === "wire" && ++preStartCalls === 2) throw new Error("pre-start failure");
			});
			return () => {
				detachDequeue();
				detachModelCall();
			};
		},
		"pre-start failure",
	);
} finally {
	wireServer.stop(true);
}

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
