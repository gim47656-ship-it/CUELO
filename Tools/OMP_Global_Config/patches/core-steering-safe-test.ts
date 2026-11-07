// 응답 생성 중 사용자 스티어링이 와도 steeringSafe 도구(목표 레인 lab_goal)는 실행되고 나머지 호출만 건너뛰는 실제 AgentSession 회귀.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-steering-safe-test.ts
// 가짜 경계: provider 전송(fake stream)과 lab_goal 본문(인라인 확장). 실제 경로: 확장 registerTool → RegisteredToolAdapter →
// ExtensionToolWrapper → Agent loop 스티어링 분기 → executeToolCalls, 내장 read 도구, AgentSession steer 큐.
// 미증명: 실제 goal-lane 플러그인 본문의 판정 품질, 실제 provider 의 스티어링 타이밍.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// SDK DB 핸들이 열려 있는 자식에서 지우지 않고, 종료를 기다린 부모가 이 실행의 fixture만 지운다. HOME/TEMP도 import 전에 격리한다.
if (!process.env.OMP_STEERING_SAFE_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-steering-safe-fixture-"));
	const home = join(root, "home");
	const temp = join(root, "temp");
	mkdirSync(home);
	mkdirSync(temp);
	let exitCode = 1;
	try {
		const child = Bun.spawnSync([process.execPath, import.meta.path], {
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				TEMP: temp,
				TMP: temp,
				TMPDIR: temp,
				PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_STEERING_SAFE_FIXTURE_ROOT: root,
			},
			stdout: "inherit",
			stderr: "inherit",
		});
		exitCode = child.exitCode ?? 1;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	process.exit(exitCode);
}

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live core");
const CORE = resolve(target, "src").replace(/\\/g, "/");
if (!existsSync(join(CORE, "session/agent-session.ts"))) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
const PACKAGES = resolve(dirname(CORE), "..").replace(/\\/g, "/");
const fixtureRoot = process.env.OMP_STEERING_SAFE_FIXTURE_ROOT!;
// 정적 import 불가: 대상 core 경로가 OMP_CORE_PATCH_TARGET 로 실행 시점에 정해진다.
const { setAgentDir } = await import(`${PACKAGES}/pi-utils/src/dirs.ts`);
setAgentDir(join(fixtureRoot, "home", ".omp", "agent"));

const { createAgentSession } = await import(`${CORE}/sdk.ts`);
const { createAssistantMessageEventStream } = await import(`${PACKAGES}/pi-ai/src/utils/event-stream.ts`);
const { getBundledModel } = await import(`${PACKAGES}/pi-catalog/src/models.ts`);
// 임시 agentDir의 ModelRegistry preflight만 통과시키는 비밀 아닌 placeholder다. fake stream이 전송을 대체한다.
process.env.OPENAI_API_KEY = "<probe>";
const model = getBundledModel("openai", "gpt-4o-mini");
assert.ok(model, "fake transport용 bundled model이 필요하다");

// 패치가 다른 호출에 붙이는 건너뜀 문구. 이 회귀는 이 문구가 바뀌지 않았는지도 본다.
const SKIP_TEXT =
	"실행하지 않음: 이 호출이 실행되기 전에 사용자 메시지가 도착했다. 턴은 끝나지 않았다. 먼저 사용자에게 한두 문장으로 답하고, 같은 응답에서 아직 필요한 도구 호출을 다시 낸다. 사용자의 승인이나 결정이 필요할 때만 글만 남기고 턴을 끝낸다.";
const STEER_TEXT = "사용자-응답중-새-지시";
const READ_MARKER = "READ-FILE-CONTENT-MUST-NOT-APPEAR";

const usage = () => ({
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

type Call = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type ToolResult = { role: "toolResult"; toolCallId: string; toolName: string; isError?: boolean; details?: { __synthetic?: boolean }; content: Array<{ type: string; text?: string }> };

async function steeredTurn(name: string, order: Array<"lab_goal" | "read">) {
	const root = mkdtempSync(join(fixtureRoot, `steering-safe-${name}-`));
	const work = join(root, "work");
	mkdirSync(work);
	const readPath = join(work, "note.txt");
	writeFileSync(readPath, READ_MARKER);
	const executed: string[] = [];
	const hookSeen: string[] = [];
	const providerContexts: string[] = [];
	const calls: Call[] = order.map((tool, index) => tool === "lab_goal"
		? { type: "toolCall", id: `goal-${index}`, name: "lab_goal", arguments: { op: "frame", i: "Framing goal" } }
		: { type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: readPath, i: "Reading note" } });
	const lastCallVisible = Promise.withResolvers<void>();
	const continueGeneration = Promise.withResolvers<void>();
	const created = await createAgentSession({
		cwd: work,
		agentDir: join(root, "agent"),
		agentId: `SteeringSafe-${name}`,
		model,
		getApiKey: () => "example",
		toolNames: ["read", "lab_goal"],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		extensions: [
			(pi: { on: (event: string, handler: (event: { toolName: string }) => void) => void; registerTool: (tool: unknown) => void }) => {
				pi.on("tool_call", event => {
					hookSeen.push(event.toolName);
				});
				pi.registerTool({
					name: "lab_goal",
					label: "Goal lane fixture",
					loadMode: "essential",
					description: "Goal lane bookkeeping fixture",
					parameters: { type: "object", properties: { op: { type: "string" } }, required: ["op"] },
					steeringSafe: true,
					async execute(id: string, params: { op: string }) {
						executed.push(id);
						return { content: [{ type: "text", text: `GOAL-FRAME-RECORDED ${params.op}` }], details: {} };
					},
				});
			},
		] as never,
	});
	const session = created.session;
	let providerCalls = 0;
	session.agent.streamFn = ((_model: unknown, context: { messages: unknown[] }) => {
		const stream = createAssistantMessageEventStream();
		const turn = ++providerCalls;
		providerContexts.push(JSON.stringify(context.messages));
		void (async () => {
			const content = turn === 1 ? calls : [{ type: "text" as const, text: "새 지시를 먼저 받았습니다." }];
			const message = {
				role: "assistant" as const, content,
				api: model.api, provider: model.provider, model: model.id,
				usage: usage(), stopReason: turn === 1 ? "toolUse" as const : "stop" as const, timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: message });
			if (turn === 1) {
				for (const [contentIndex, call] of calls.entries()) {
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
				}
				await continueGeneration.promise;
			}
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
		})();
		return stream;
	}) as never;
	const executionEnds: Array<{ id: string; isError: boolean }> = [];
	const unsubscribe = session.agent.subscribe((event: {
		type: string; toolCallId?: string; isError?: boolean;
		assistantMessageEvent?: { type: string; toolCall?: { id: string } };
	}) => {
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "toolcall_end" && event.assistantMessageEvent.toolCall?.id === calls.at(-1)!.id) {
			lastCallVisible.resolve();
		}
		if (event.type === "tool_execution_end") executionEnds.push({ id: event.toolCallId!, isError: event.isError === true });
	});
	const run = session.prompt("목표를 잡고 파일을 읽어 줘");
	await lastCallVisible.promise;
	await session.steer(STEER_TEXT);
	continueGeneration.resolve();
	await run;
	unsubscribe();
	const toolResults = session.agent.state.messages.filter((m: { role: string }) => m.role === "toolResult") as ToolResult[];
	await session.dispose();
	return { calls, executed, hookSeen, providerContexts, toolResults, executionEnds, providerCalls };
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
}

for (const [name, order] of [["goal-first", ["lab_goal", "read"]], ["read-first", ["read", "lab_goal"]]] as const) {
	console.log(`\n[${name}] 생성 중 사용자 steer, 호출 순서 ${order.join(" → ")}`);
	const r = await steeredTurn(name, [...order]);
	const goalId = r.calls.find(call => call.name === "lab_goal")!.id;
	const readId = r.calls.find(call => call.name === "read")!.id;
	const goal = r.toolResults.find(m => m.toolCallId === goalId);
	const read = r.toolResults.find(m => m.toolCallId === readId);
	check("steeringSafe lab_goal 은 건너뛰지 않고 실제로 실행된다", r.executed.join(",") === goalId, `executed=${JSON.stringify(r.executed)} goalResult=${JSON.stringify(goal?.content[0]?.text)}`);
	check("lab_goal 결과는 실제 실행 결과다(합성 아님, 오류 아님)",
		goal?.details?.__synthetic !== true && goal?.isError !== true && goal?.content[0]?.text === "GOAL-FRAME-RECORDED frame",
		JSON.stringify(goal));
	check("확장 tool_call 훅이 lab_goal 에 대해 평소처럼 돈다", r.hookSeen.includes("lab_goal") && !r.hookSeen.includes("read"), `hookSeen=${JSON.stringify(r.hookSeen)}`);
	check("lab_goal 의 tool_execution_end 가 성공으로 나간다", r.executionEnds.some(e => e.id === goalId && !e.isError), JSON.stringify(r.executionEnds));
	check("read 는 기존 건너뜀 자리표시를 같은 문구로 받는다",
		read?.details?.__synthetic === true && read?.isError === true && read?.content.some(part => part.text?.includes(SKIP_TEXT)) === true,
		JSON.stringify(read));
	check("도구 결과가 assistant 의 호출 순서를 따른다",
		r.toolResults.map(m => m.toolCallId).join(",") === r.calls.map(call => call.id).join(","),
		r.toolResults.map(m => m.toolCallId).join(","));
	const next = r.providerContexts[1] ?? "";
	check("다음 provider 요청이 lab_goal 결과와 사용자 steer 를 함께 본다(턴이 끝나지 않음)",
		r.providerCalls === 2 && next.includes("GOAL-FRAME-RECORDED frame") && next.includes(STEER_TEXT),
		`providerCalls=${r.providerCalls}`);
	check("read 는 실제로 실행되지 않았다(파일 내용이 문맥에 없다)", !r.providerContexts.some(context => context.includes(READ_MARKER)));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
