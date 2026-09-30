// Codex native turn lane 이 실행 중 `response.steer` 를 일반 error 프레임
// (code=unsupported_native_inflight_message)으로 거절해도 턴이 죽지 않고 입력이 유실되지 않는지
// 로컬 WebSocket 서버 fixture 와 실제 provider 로 관찰한다. 유료 호출은 없다.
//   bun run patches/core-native-inflight-test.ts (OMP_CORE_PATCH_TARGET 지정 시 그 사본)
// 패치 전 core 에서는 [1] 이 RED(스트림 error), 패치 후 전부 GREEN 이다.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveCoreRoot(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	if (env) return join(env, "..").replace(/\\/g, "/");
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = [
		join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"),
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

type Mode = "native-lane" | "steer-accepted" | "steer-failed" | "stray-inflight" | "other-error-on-steer";
let mode: Mode = "native-lane";
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
				if (mode === "native-lane") ws.send(JSON.stringify(errorFrame("unsupported_native_inflight_message")));
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

const claims = { rejected: 0, accepted: 0 };
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
	const base = getBundledModel("openai-codex", "gpt-5.5");
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
	check("두 번째 입력도 claim.reject 로 정확히 한 번 되돌아온다", claims.rejected === 2 && claims.accepted === 0, JSON.stringify(claims));

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
	check("모든 assistant 응답이 error 없이 끝난다", assistants.length === 2 && assistants.every(m => m.stopReason !== "error"), JSON.stringify(assistants.map(m => m.stopReason)));
} finally {
	server.stop(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
