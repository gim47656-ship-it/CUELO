// Codex native turn lane 이 실행 중 `response.steer` 를 일반 error 프레임
// (code=unsupported_native_inflight_message)으로 거절해도 턴이 죽지 않고 입력이 유실되지 않는지
// 로컬 WebSocket 서버 fixture 와 실제 provider 로 관찰한다. 유료 호출은 없다.
//   bun run patches/core-native-inflight-test.ts (OMP_CORE_PATCH_TARGET 지정 시 그 사본)
// 18.5.0: 패치 전 core 에서는 [1] 이 RED(스트림 error), 패치 후 전부 GREEN 이다.
// 18.5.1: upstream #13705 가 같은 거절을 재시도 가능 오류로 복구하고 세션 단위로 steer 를 끈다(P48 RETIRE).
// 이 시험은 그 upstream 보장(턴이 죽지 않음, 입력 유실 없음)을 같은 fixture 로 계속 지킨다.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveCoreRoot(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	if (env) return join(env, "..").replace(/\\/g, "/");
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = [
		join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"),
		join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"),
		join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"),
		join(root, "@oh-my-pi/pi-coding-agent"),
	];
	const hit = candidates.find(p => existsSync(join(p, "src/registry/agent-registry.ts")));
	if (!hit) throw new Error(`CUELO 전역 설치를 찾지 못했다: ${candidates.join(", ")}`);
	return join(hit, "..").replace(/\\/g, "/");
}

const CORE_ROOT = resolveCoreRoot();
// 정적 import 불가: 대상 core 경로가 OMP_CORE_PATCH_TARGET 로 실행 시점에 정해진다.
const { streamOpenAICodexResponses } = await import(`${CORE_ROOT}/pi-ai/src/providers/openai-codex-responses.ts`);
const { getBundledModel } = await import(`${CORE_ROOT}/pi-catalog/src/models.ts`);
const { Agent } = await import(`${CORE_ROOT}/pi-agent-core/src/index.ts`);

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

function errorFrame(code: string) {
	return {
		type: "error",
		status: 400,
		error: {
			type: "invalid_request_error",
			code,
			message:
				"The experimental native turn lane cannot accept stateful WebSocket messages while a native turn is running. Start a new independent response.create turn instead.",
		},
	};
}

type Mode = "native-lane" | "steer-accepted" | "steer-failed" | "stray-inflight" | "other-error-on-steer" | "text-then-native-lane";
let mode: Mode = "native-lane";
let hangRecovery = false;
let received: string[] = [];
let created = 0;
let creates: string[] = [];
const server = Bun.serve({
	port: 0,
	fetch(req, srv) {
		if (srv.upgrade(req)) return undefined;
		return new Response("ws only", { status: 426 });
	},
	websocket: {
		message(ws, raw) {
			const frame = JSON.parse(String(raw)) as { type: string; previous_response_id?: string };
			received.push(frame.type);
			if (frame.type === "response.create") {
				created++;
				creates.push(String(raw));
				const id = `resp_${created}`;
				ws.send(JSON.stringify({ type: "response.created", response: { id } }));
				if (mode === "stray-inflight") ws.send(JSON.stringify(errorFrame("unsupported_native_inflight_message")));
				// text-then-native-lane: 첫 응답은 보이는 commentary 를 내보낸 뒤 끝나지 않고(steer 거절을 기다린다),
				// 이후 응답은 짧은 답을 하고 끝난다. 거절 뒤 서버가 첫 응답을 더 보내지 않는 관측 형태다.
				if (mode === "text-then-native-lane") {
					const msg = { type: "message", id: `msg_${id}`, role: "assistant", content: [] };
					const text = creates.length === 1 ? "VISIBLE_COMMENTARY" : "NEXT_ANSWER";
					const send = (out: unknown) => ws.readyState === 1 && ws.send(JSON.stringify(out));
					send({ type: "response.output_item.added", output_index: 0, item: msg });
					send({ type: "response.content_part.added", output_index: 0, item_id: msg.id, content_index: 0, part: { type: "output_text", text: "" } });
					send({ type: "response.output_text.delta", output_index: 0, item_id: msg.id, content_index: 0, delta: text });
					if (creates.length > 1 && !hangRecovery) {
						const done = { ...msg, content: [{ type: "output_text", text }] };
						setTimeout(() => send({ type: "response.output_item.done", output_index: 0, item: done }), 20);
						setTimeout(
							() =>
								send({
									type: "response.completed",
									response: { id, status: "completed", output: [done], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
								}),
							40,
						);
					}
					return;
				}
				// 스트리밍 중인 턴: steer 가 도착한 뒤에 끝낸다.
				setTimeout(
					() =>
						ws.send(
							JSON.stringify({
								type: "response.completed",
								response: {
									id,
									status: "completed",
									output: [],
									usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
								},
							}),
						),
					600,
				);
			} else if (frame.type === "response.steer") {
				const steer = { id: `steer_${received.length}`, previous_response_id: frame.previous_response_id };
				if (mode === "native-lane" || mode === "text-then-native-lane")
					ws.send(JSON.stringify(errorFrame("unsupported_native_inflight_message")));
				else if (mode === "other-error-on-steer") ws.send(JSON.stringify(errorFrame("invalid_request_error")));
				else if (mode === "steer-accepted") ws.send(JSON.stringify({ type: "response.steer.accepted", steer }));
				else if (mode === "steer-failed")
					ws.send(
						JSON.stringify({
							type: "response.steer.failed",
							steer,
							error: { code: "response_not_running", message: "done" },
						}),
					);
			}
		},
	},
});

const claims = { rejected: 0, accepted: 0, claimed: 0 };
function liveSteering(active: boolean) {
	if (!active) return undefined;
	let delivered = false;
	return {
		async wait(signal: AbortSignal) {
			if (delivered) {
				if (signal.aborted) return;
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			}
		},
		async claim() {
			if (delivered) return undefined;
			delivered = true;
			claims.claimed++;
			return {
				messages: [{ role: "user", content: "중간에 끼어든 메시지", timestamp: Date.now() }],
				accept: () => void claims.accepted++,
				reject: () => void claims.rejected++,
			};
		},
	};
}

function fakeJwt(): string {
	const claim = { "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } };
	return `h.${Buffer.from(JSON.stringify(claim)).toString("base64")}.s`;
}

async function runTurn(providerSessionState: Map<string, unknown>, sessionId: string, steering: boolean, signal?: AbortSignal) {
	const model = fixtureModel();
	const events: string[] = [];
	const stream = streamOpenAICodexResponses(
		model,
		{ messages: [{ role: "user", content: "시작", timestamp: Date.now() }] },
		{ apiKey: fakeJwt(), sessionId, providerSessionState, signal, liveSteering: liveSteering(steering) },
	);
	let result: { stopReason?: string; errorMessage?: string } | undefined;
	try {
		for await (const event of stream) events.push(event.type);
		result = await stream.result();
	} catch (error) {
		result = { stopReason: "error", errorMessage: String(error) };
	}
	return { events, result };
}

function fixtureModel() {
	// 18.7.0 번들에서 openai-codex/gpt-5.5 가 빠졌다. 두 판에 모두 있고 compat 이 가장 가까운 Codex 모델을 쓴다.
	const base = getBundledModel("openai-codex", "gpt-5.6-sol");
	return {
		...base,
		baseUrl: `http://127.0.0.1:${server.port}/codex`,
		preferWebsockets: true,
		compat: { ...base.compat, supportsSteering: true },
	};
}

function reset(next: Mode): void {
	mode = next;
	received = [];
	creates = [];
	claims.rejected = 0;
	claims.accepted = 0;
	claims.claimed = 0;
}
const failed = (r: { result?: { stopReason?: string } }) => r.result?.stopReason === "error";
const why = (r: { result?: { stopReason?: string; errorMessage?: string } }) =>
	`${r.result?.stopReason} ${r.result?.errorMessage ?? ""}`;
const steerFrames = () => received.filter(type => type === "response.steer").length;

try {
	console.log("[1] native lane 이 실행 중 steer 를 일반 error 프레임으로 거절");
	reset("native-lane");
	const pool = new Map<string, unknown>();
	const first = await runTurn(pool, "native-inflight-1", true);
	check("서버가 response.steer 를 실제로 받았다", steerFrames() === 1, JSON.stringify(received));
	check("턴이 error 없이 완료된다", !failed(first), why(first));
	check("거절된 입력은 claim.reject 로 정확히 한 번 되돌아온다", claims.rejected === 1 && claims.accepted === 0, JSON.stringify(claims));

	console.log("[2] 같은 소켓의 다음 턴은 steer 를 다시 보내지 않고 입력을 일반 경로로 돌려준다");
	const second = await runTurn(pool, "native-inflight-1", true);
	check("다음 턴도 error 없이 완료된다", !failed(second), why(second));
	check("response.steer 는 더 전송되지 않았다", steerFrames() === 1, JSON.stringify(received));
	// 18.5.0(P48)은 같은 소켓에서 claim 한 뒤 바로 reject 하고, 18.5.1 은 세션 단위로 steer pump 를 띄우지 않아
	// claim 자체가 없다. 어느 쪽이든 claim 된 입력은 전부 reject 로 되돌아와 다음 경계의 일반 경로에 남아야 한다.
	check(
		"두 번째 입력도 수락·유실 없이 일반 경로로 남는다",
		claims.accepted === 0 && claims.rejected === claims.claimed && claims.claimed >= 1,
		JSON.stringify(claims),
	);

	console.log("[3] 표준 steer.accepted 는 그대로 수락된다");
	reset("steer-accepted");
	const accepted = await runTurn(new Map(), "native-inflight-3", true);
	check("error 없이 완료된다", !failed(accepted), why(accepted));
	check("claim.accept 한 번, reject 없음", claims.accepted === 1 && claims.rejected === 0, JSON.stringify(claims));

	console.log("[4] 표준 steer.failed 는 기존처럼 거절된다");
	reset("steer-failed");
	const steerFailed = await runTurn(new Map(), "native-inflight-4", true);
	check("error 없이 완료된다", !failed(steerFailed), why(steerFailed));
	check("claim.reject 한 번", claims.rejected === 1 && claims.accepted === 0, JSON.stringify(claims));

	console.log("[5] steer 대기자가 없는 같은 코드의 error 는 숨기지 않는다");
	reset("stray-inflight");
	const stray = await runTurn(new Map(), "native-inflight-5", false);
	check("스트림 error 로 노출된다", failed(stray) && why(stray).includes("unsupported_native_inflight_message"), why(stray));

	console.log("[6] steer 대기 중 다른 코드의 error 는 숨기지 않는다");
	reset("other-error-on-steer");
	const other = await runTurn(new Map(), "native-inflight-6", true);
	check("스트림 error 로 노출된다", failed(other) && why(other).includes("invalid_request_error"), why(other));

	console.log("[7] 새 연결(새 소켓)은 지원을 다시 한 번 시도한다 — 전역 disable 없음");
	reset("native-lane");
	await runTurn(new Map(), "native-inflight-7a", true);
	await runTurn(new Map(), "native-inflight-7b", true);
	check("소켓마다 response.steer 를 1회씩 전송했다", steerFrames() === 2, JSON.stringify(received));

	console.log("[8] 거절 직후 abort 는 inflight 오류가 아니라 aborted 로 끝난다");
	reset("native-lane");
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 300);
	const aborted = await runTurn(new Map(), "native-inflight-8", true, controller.signal);
	check("stopReason 이 aborted 이다", aborted.result?.stopReason === "aborted", why(aborted));
	check("inflight 오류 문구가 나오지 않는다", !why(aborted).includes("unsupported_native_inflight_message"), why(aborted));
	check("입력은 claim.reject 로 한 번 되돌아왔다", claims.rejected === 1 && claims.accepted === 0, JSON.stringify(claims));

	console.log("[9] 실제 Agent 루프: 거절된 사용자 입력은 다음 일반 response.create 에 정확히 한 번 실린다");
	reset("native-lane");
	const STEER_TEXT = "중간에 끼어든 실제 사용자 문구";
	const agentPool = new Map<string, unknown>();
	const agent = new Agent({
		initialState: { model: fixtureModel(), systemPrompt: "", tools: [], messages: [] },
		sessionId: "native-inflight-agent",
		streamFn: (model, context, options) =>
			streamOpenAICodexResponses(model, context, { ...options, apiKey: fakeJwt(), providerSessionState: agentPool }),
	});
	const agentRun = agent.prompt("시작");
	setTimeout(() => agent.steer({ role: "user", content: STEER_TEXT, timestamp: Date.now() }), 200);
	await agentRun;
	await agent.waitForIdle();
	const occurrences = (text: string) => text.split(STEER_TEXT).length - 1;
	const assistants = agent.state.messages.filter(m => m.role === "assistant") as Array<{ stopReason?: string }>;
	check("서버가 response.steer 를 받았고 response.create 는 두 번이다", steerFrames() === 1 && creates.length === 2, JSON.stringify(received));
	check("첫 response.create 에는 입력이 없다", occurrences(creates[0] ?? "") === 0);
	check("두 번째 일반 response.create 에 정확히 한 번 실린다", occurrences(creates[1] ?? "") === 1, String(occurrences(creates[1] ?? "")));
	check("대화 기록에도 한 번만 남는다", agent.state.messages.filter(m => m.role === "user" && JSON.stringify(m).includes(STEER_TEXT)).length === 1);
	// P55: 첫 응답은 보이는 출력 없이 거절 steer 를 받았으므로 버려지고 같은 run 에서 다시 요청한다.
	check(
		"버린 첫 응답은 기록되지 않고 다시 요청한 응답 하나가 error 없이 끝난다",
		assistants.length === 1 && assistants[0]?.stopReason === "stop",
		JSON.stringify(assistants.map(m => m.stopReason)),
	);

	console.log("[10] 실제 Agent 루프: 보인 commentary 뒤 native 거절 — 입력·보인 출력이 각각 한 번씩 남고 오류로 끝나지 않는다");
	reset("text-then-native-lane");
	const partialPool = new Map<string, unknown>();
	const partialAgent = new Agent({
		initialState: { model: fixtureModel(), systemPrompt: "", tools: [], messages: [] },
		sessionId: "native-inflight-partial",
		streamFn: (model, context, options) =>
			streamOpenAICodexResponses(model, context, { ...options, apiKey: fakeJwt(), providerSessionState: partialPool }),
	});
	let commentarySeen = false;
	partialAgent.subscribe(event => {
		if (event.type !== "message_update" || commentarySeen) return;
		if (JSON.stringify(event.message).includes("VISIBLE_COMMENTARY")) {
			commentarySeen = true;
			partialAgent.steer({ role: "user", content: STEER_TEXT, timestamp: Date.now() });
		}
	});
	const partialRun = partialAgent.prompt("시작");
	const partialDeadline = Bun.sleep(5000).then(() => "timeout" as const);
	const partialOutcome = await Promise.race([partialRun.then(() => partialAgent.waitForIdle()).then(() => "idle" as const), partialDeadline]);
	if (partialOutcome === "timeout") {
		partialAgent.abort();
		await partialAgent.waitForIdle();
	}
	const partialAssistants = partialAgent.state.messages.filter(m => m.role === "assistant") as Array<{ stopReason?: string; errorMessage?: string }>;
	const partialHistory = JSON.stringify(partialAgent.state.messages);
	const secondCreate = creates[1] ?? "";
	check("run 이 완료된다", partialOutcome === "idle", partialOutcome);
	check("response.steer 는 한 번만 시도됐다", steerFrames() === 1, JSON.stringify(received));
	check("거절 오류가 사용자 오류로 남지 않는다", partialAssistants.every(m => m.stopReason !== "error"), JSON.stringify(partialAssistants));
	check("steer 입력이 다음 일반 response.create 에 정확히 한 번 실린다", creates.length === 2 && secondCreate.split(STEER_TEXT).length - 1 === 1, String(creates.length));
	check(
		"이미 보인 commentary 는 다음 요청에 한 번, 입력보다 앞에 실린다",
		secondCreate.split("VISIBLE_COMMENTARY").length - 1 === 1 && secondCreate.indexOf("VISIBLE_COMMENTARY") < secondCreate.indexOf(STEER_TEXT),
	);
	check("이미 보인 commentary 는 대화 기록에 한 번만 있다", partialHistory.split("VISIBLE_COMMENTARY").length - 1 === 1);
	check("steer 입력도 대화 기록에 한 번만 있다", partialHistory.split(STEER_TEXT).length - 1 === 1);
	check("거절된 응답을 이어 받은 새 응답이 기록되고 둘 다 stop 이다", partialAssistants.length === 2 && partialAssistants.every(m => m.stopReason === "stop"), JSON.stringify(partialAssistants));

	console.log("[11] 보인 commentary 뒤 거절이 일어나고 재요청이 나간 뒤 abort 하면 aborted 로 끝나고 오류 문구가 없다");
	// 재요청(두 번째 response.create)은 거절을 처리한 뒤에만 나간다. 그 응답을 끝내지 않고 재요청 도착을 기다린 뒤 abort 하므로
	// abort 는 거절보다 앞설 수 없다(타이머 경쟁 없음).
	reset("text-then-native-lane");
	hangRecovery = true;
	const abortAgent = new Agent({
		initialState: { model: fixtureModel(), systemPrompt: "", tools: [], messages: [] },
		sessionId: "native-inflight-partial-abort",
		streamFn: (model, context, options) =>
			streamOpenAICodexResponses(model, context, { ...options, apiKey: fakeJwt(), providerSessionState: new Map() }),
	});
	let abortArmed = false;
	abortAgent.subscribe(event => {
		if (event.type !== "message_update" || abortArmed) return;
		if (JSON.stringify(event.message).includes("VISIBLE_COMMENTARY")) {
			abortArmed = true;
			abortAgent.steer({ role: "user", content: STEER_TEXT, timestamp: Date.now() });
			void (async () => {
				while (creates.length < 2) await Bun.sleep(5);
				abortAgent.abort();
			})();
		}
	});
	const abortRun = abortAgent.prompt("시작");
	const abortOutcome = await Promise.race([abortRun.then(() => abortAgent.waitForIdle()).then(() => "idle" as const), Bun.sleep(5000).then(() => "timeout" as const)]);
	if (abortOutcome === "timeout") {
		abortAgent.abort();
		await abortAgent.waitForIdle();
	}
	const abortAssistants = abortAgent.state.messages.filter(m => m.role === "assistant") as Array<{ stopReason?: string; errorMessage?: string }>;
	check("run 이 abort 로 끝난다", abortOutcome === "idle" && abortAssistants.at(-1)?.stopReason === "aborted", `${abortOutcome} ${JSON.stringify(abortAssistants.map(m => m.stopReason))}`);
	check("inflight 오류 문구가 기록에 없다", !JSON.stringify(abortAgent.state.messages).includes("unsupported_native_inflight_message"));
	check("거절은 abort 전에 일어났다: steer 프레임 1개 뒤 재요청이 나갔다", steerFrames() === 1 && creates.length === 2, JSON.stringify(received));
	check("steer 입력은 재요청에 정확히 한 번 실렸다", (creates[1] ?? "").split(STEER_TEXT).length - 1 === 1);
} finally {
	hangRecovery = false;
	server.stop(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
