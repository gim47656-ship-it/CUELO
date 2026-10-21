// Terminal yield 뒤 passive aside 가 새 provider turn 을 열지 않는 실제 AgentSession 회귀.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-yield-terminal-test.ts
// 모델 호출은 fake stream transport 로 대체한다. real YieldTool, Agent loop, AgentSession
// settle/IRC aside 경계를 그대로 타며 설치본과 외부 provider 는 건드리지 않는다.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// SDK DB 핸들이 열려 있는 자식에서 삭제하지 않고, 종료를 기다린 부모가
// 이 실행에서 만든 fixture만 지운다. HOME/TEMP도 import 전에 격리된다.
if (!process.env.OMP_YIELD_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-yield-fixture-"));
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
				OMP_YIELD_FIXTURE_ROOT: root,
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
// options.agentDir만 바꾸면 session-paths의 전역 registry는 실제 프로필을 가리킨다.
// 부모가 SDK import 전에 정한 독립 홈과 같은 resolver를 사용한다.
const fixtureRoot = process.env.OMP_YIELD_FIXTURE_ROOT!;
const { setAgentDir } = await import(`${CORE}/../../pi-utils/src/dirs.ts`);
setAgentDir(join(fixtureRoot, "home", ".omp", "agent"));

// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET so the test can compare
// isolated unpatched/patched copies without ever importing the live installation.
const { createAgentSession } = await import(`${CORE}/sdk.ts`);
const { createAssistantMessageEventStream } = await import(`${PACKAGES}/pi-ai/src/utils/event-stream.ts`);
const { getBundledModel } = await import(`${PACKAGES}/pi-catalog/src/models.ts`);
// 임시 agentDir의 ModelRegistry preflight만 통과시키는 비밀 아닌 placeholder다.
// fake stream이 provider transport를 완전히 대체하므로 외부 요청에는 쓰이지 않는다.
const previousOpenAiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = "<probe>";
const model = getBundledModel("openai", "gpt-4o-mini");
assert.ok(model, "fake transport용 bundled model이 필요하다");

const usage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

type ProviderStep =
	| { kind: "yield"; args: Record<string, unknown> }
	| { kind: "text"; text: string; inspect?: (messages: unknown[]) => void };

function assistantYield(callId: string, args: Record<string, unknown>) {
	const toolCall = { type: "toolCall" as const, id: callId, name: "yield", arguments: args };
	return {
		role: "assistant" as const,
		content: [toolCall],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
}

function assistantText(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function fakeStream(steps: ProviderStep[], onCall: (count: number) => void) {
	let index = 0;
	return (_model: unknown, context: { messages: unknown[] }) => {
		const stream = createAssistantMessageEventStream();
		const step = steps[index++];
		onCall(index);
		queueMicrotask(() => {
			if (!step) {
				stream.fail(new Error(`unexpected provider continuation #${index}`));
				return;
			}
			if (step.kind === "yield") {
				const message = assistantYield(`yield-${index}`, step.args);
				const toolCall = message.content[0]!;
				stream.push({ type: "start", partial: message });
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end();
				return;
			}
			step.inspect?.(context.messages);
			const message = assistantText(step.text);
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
		});
		return stream;
	};
}

async function createSession(
	name: string,
	steps: ProviderStep[],
	asideOnTerminal = false,
	queueSteerOnTerminal = false,
) {
	const root = mkdtempSync(join(fixtureRoot, `omp-yield-terminal-${name}-`));
	const work = join(root, "work");
	const agentDir = join(root, "agent");
	let calls = 0;
	const created = await createAgentSession({
		cwd: work,
		agentDir,
		agentId: `YieldTerminal-${name}`,
		agentName: "maker",
		agentDisplayName: "maker",
		model,
		getApiKey: () => "example",
		requireYieldTool: true,
		toolNames: ["yield"],
		restrictToolNames: true,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
	});
	if (asideOnTerminal || queueSteerOnTerminal) {
		const yieldTool = created.session.getToolByName("yield") as {
			execute: (...args: unknown[]) => Promise<{ details?: Record<string, unknown>; isError?: boolean }>;
		};
		const executeYield = yieldTool.execute.bind(yieldTool);
		yieldTool.execute = async (...args: unknown[]) => {
			const result = await executeYield(...args);
			const type = result.details?.type;
			const incremental = Array.isArray(type) && type.length > 0;
			if (!result.isError && result.details?.status === "success" && !incremental) {
				if (asideOnTerminal) {
					// 실제 Jev pre-retry advisory처럼 yield tool 실행 도중 passive aside를
					// 넣는다. execute가 반환된 뒤 AgentSession의 terminal hook/settle이 이어진다.
					await created.session.sendCustomMessage(
						{
							customType: "terminal-yield-probe-aside",
							content: "PASSIVE-ASIDE-AFTER-TERMINAL-YIELD",
							display: false,
							attribution: "agent",
						},
						{ deliverAs: "aside" },
					);
				}
				if (queueSteerOnTerminal) {
					await created.session.steer("QUEUED-STEER-DURING-TERMINAL");
				}
			}
			return result;
		};
	}
	created.session.agent.streamFn = fakeStream(steps, count => {
		calls = count;
	}) as never;
	return {
		session: created.session,
		calls: () => calls,
		cleanup: async () => {
			await created.session.dispose();
		},
	};
}

async function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 25);
	await promise;
}

async function terminalAsideCase(): Promise<void> {
	let explicitTurnSawAside = false;
	const fixture = await createSession(
		"aside",
		[
			{ kind: "yield", args: { data: { terminal: true } } },
			{
				kind: "text",
				text: "explicit user turn completed",
				inspect: messages => {
					explicitTurnSawAside = JSON.stringify(messages).includes("PASSIVE-ASIDE-AFTER-TERMINAL-YIELD");
				},
			},
		],
		true,
	);
	try {
		await fixture.session.prompt("terminal yield probe");
		await settle();
		assert.equal(fixture.calls(), 1, "terminal yield 뒤 passive aside가 provider continuation을 열면 안 된다");
		assert.equal(
			fixture.session.agent.state.messages.some((message: { role?: string; content?: unknown }) =>
				message.role === "custom" && JSON.stringify(message.content).includes("PASSIVE-ASIDE-AFTER-TERMINAL-YIELD"),
			),
			false,
			"억제된 passive aside는 terminal turn transcript에 조기 소비되면 안 된다",
		);
		await fixture.session.prompt("explicit next user turn");
		assert.equal(fixture.calls(), 2, "다음 explicit user prompt는 정상 provider turn을 연다");
		assert.equal(explicitTurnSawAside, true, "보존한 passive aside는 다음 explicit prompt의 step boundary에서 소비된다");
		console.log("PASS terminal yield는 passive aside wake를 억제하고 다음 explicit prompt가 보존 aside를 소비한다");
	} finally {
		await fixture.cleanup();
	}
}

async function queuedSteerCase(): Promise<void> {
	let queuedSteerWasConsumed = false;
	let queuedSteerContext = "";
	const fixture = await createSession(
		"queued-steer",
		[
			{ kind: "yield", args: { data: { terminal: true } } },
			{
				kind: "text",
				text: "queued steer completed",
				inspect: messages => {
					queuedSteerContext = JSON.stringify(messages);
					queuedSteerWasConsumed = queuedSteerContext.includes("QUEUED-STEER-DURING-TERMINAL");
				},
			},
		],
		false,
		true,
	);
	try {
		await fixture.session.prompt("terminal yield with queued steer probe");
		await fixture.session.waitForIdle();
		await settle();
		assert.equal(fixture.calls(), 2, "명시적으로 queued 된 user steer는 terminal sticky 뒤에도 provider turn을 연다");
		assert.equal(queuedSteerWasConsumed, true, `queued user steer가 다음 turn 입력으로 소비된다: ${queuedSteerContext}`);
		console.log("PASS terminal yield 뒤 명시적 queued user steer는 정상 drain된다");
	} finally {
		await fixture.cleanup();
	}
}

async function incrementalCase(): Promise<void> {
	const fixture = await createSession("incremental", [
		{ kind: "yield", args: { type: ["section"], data: { part: 1 } } },
		{ kind: "yield", args: { data: { done: true } } },
	]);
	try {
		await fixture.session.prompt("incremental yield probe");
		await settle();
		assert.equal(fixture.calls(), 2, "incremental yield는 다음 provider step을 계속해야 한다");
		console.log("PASS incremental yield는 continuation을 유지하고 뒤 terminal yield에서 멈춘다");
	} finally {
		await fixture.cleanup();
	}
}

async function errorRetryCase(): Promise<void> {
	const fixture = await createSession("error-retry", [
		{ kind: "yield", args: { type: "result" } },
		{ kind: "yield", args: { data: { corrected: true } } },
	]);
	try {
		await fixture.session.prompt("yield error retry probe");
		await settle();
		assert.equal(fixture.calls(), 2, "실패한 yield는 수정된 terminal yield를 위한 provider retry를 허용해야 한다");
		console.log("PASS yield 오류는 retry를 유지하고 수정된 terminal yield에서 멈춘다");
	} finally {
		await fixture.cleanup();
	}
}

async function ordinaryIdleAsideCase(): Promise<void> {
	const fixture = await createSession("ordinary-idle", [
		{
			kind: "text",
			text: "ordinary idle aside handled",
			inspect: messages => {
				assert.ok(JSON.stringify(messages).includes("ORDINARY-IDLE-ASIDE"));
			},
		},
	]);
	try {
		await fixture.session.sendCustomMessage(
			{
				customType: "ordinary-idle-aside",
				content: "ORDINARY-IDLE-ASIDE",
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "aside" },
		);
		await fixture.session.waitForIdle();
		await settle();
		assert.equal(fixture.calls(), 1, "terminal sticky가 없는 일반 idle aside는 기존처럼 wake turn을 연다");
		console.log("PASS 일반 idle aside wake 계약은 유지된다");
	} finally {
		await fixture.cleanup();
	}
}

// 계약(실제 AgentSession 스케줄러·context 조립 증명): 한 assistant 메시지의 두 tool call 중 뒤의 호출이 먼저 끝나도
// 다음 provider 요청에 원래 두 id가 각자 맞는 결과로 정확히 한 번씩 실리고, system prompt와 thinking/text 구분이 유지된다.
// 가짜 경계: streamFn(provider 전송)과 tool 본문. 미증명: 실제 provider의 id 규칙, 모델 품질, 청구 사용량.
async function reversedToolResultsCase(): Promise<void> {
	const root = mkdtempSync(join(fixtureRoot, "omp-yield-terminal-reversed-"));
	const gate = Promise.withResolvers<void>();
	const bothStarted = Promise.withResolvers<void>();
	const started: string[] = [];
	const tool = (name: string, label: string, waitsForGate: boolean) => ({
		name,
		label: name,
		description: `local fixture tool ${name}`,
		parameters: { type: "object", properties: {} },
		async execute() {
			started.push(name);
			if (started.length === 2) bothStarted.resolve();
			// 첫 호출은 둘째의 tool_execution_end가 gate를 열 때까지 기다린다. 둘이 동시에 실행 중일 때만 풀린다.
			await (waitsForGate ? gate.promise : bothStarted.promise);
			return { content: [{ type: "text" as const, text: label }], details: {} };
		},
	});
	const created = await createAgentSession({
		cwd: join(root, "work"),
		agentDir: join(root, "agent"),
		model,
		getApiKey: () => "example",
		requireYieldTool: false,
		toolNames: ["slow_first", "fast_second"],
		restrictToolNames: true,
		allowRestrictedCustomTools: true,
		customTools: [tool("slow_first", "RESULT-OF-FIRST", true), tool("fast_second", "RESULT-OF-SECOND", false)],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
	});
	const requests: Array<{ systemPrompt: unknown; messages: Array<Record<string, unknown>> }> = [];
	const base = { api: model.api, provider: model.provider, model: model.id, usage: usage(), timestamp: Date.now() };
	created.session.agent.streamFn = ((_model: unknown, context: { systemPrompt: unknown; messages: Array<Record<string, unknown>> }) => {
		const stream = createAssistantMessageEventStream();
		requests.push({ systemPrompt: JSON.parse(JSON.stringify(context.systemPrompt)), messages: structuredClone(context.messages) });
		const count = requests.length;
		queueMicrotask(() => {
			if (count > 2) {
				stream.fail(new Error("unexpected provider continuation"));
				return;
			}
			const content =
				count === 1
					? [
							{ type: "thinking" as const, thinking: "THINKING-TEXT" },
							{ type: "text" as const, text: "VISIBLE-TEXT" },
							{ type: "toolCall" as const, id: "call-first", name: "slow_first", arguments: {} },
							{ type: "toolCall" as const, id: "call-second", name: "fast_second", arguments: {} },
						]
					: [{ type: "text" as const, text: "done" }];
			const stopReason = count === 1 ? ("toolUse" as const) : ("stop" as const);
			const message = { ...base, role: "assistant" as const, content, stopReason };
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: stopReason, message });
			stream.end();
		});
		return stream;
	}) as never;
	// 완료 순서는 tool 본문이 아니라 스케줄러가 내보낸 tool_execution_end 이벤트로 잰다. gate도 그 이벤트가 연다.
	const endedIds: string[] = [];
	const unsubscribe = created.session.subscribe((event: { type: string; toolCallId?: string }) => {
		if (event.type !== "tool_execution_end" || !event.toolCallId) return;
		endedIds.push(event.toolCallId);
		if (event.toolCallId === "call-second") gate.resolve();
	});
	let timer: NodeJS.Timeout | undefined;
	try {
		// 스케줄러가 두 호출을 직렬화하면 첫 호출이 gate에서 영원히 기다리므로 멈춤 대신 실패로 만든다.
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("두 tool이 동시에 실행되지 않았다")), 5000);
		});
		await Promise.race([created.session.prompt("reversed tool completion probe"), timeout]);
		await created.session.waitForIdle();
		assert.deepEqual(endedIds, ["call-second", "call-first"], "스케줄러가 낸 tool_execution_end 순서가 뒤 호출 먼저여야 한다");
		assert.equal(requests.length, 2, "tool 결과 뒤 provider 요청은 정확히 한 번 더 나간다");
		const [firstRequest, nextRequest] = requests;
		assert.deepEqual(nextRequest!.systemPrompt, firstRequest!.systemPrompt, "다음 요청도 같은 system prompt를 유지한다");
		const results = nextRequest!.messages.filter(message => message.role === "toolResult") as Array<{ toolCallId: string; content: Array<{ text: string }> }>;
		assert.equal(results.length, 2, `toolResult는 호출당 정확히 하나: ${JSON.stringify(results)}`);
		const byId = Object.fromEntries(results.map(result => [result.toolCallId, result.content.map(part => part.text).join("")]));
		assert.deepEqual(byId, { "call-first": "RESULT-OF-FIRST", "call-second": "RESULT-OF-SECOND" }, "각 id는 자기 결과에 연결된다");
		const assistant = nextRequest!.messages.find(message => message.role === "assistant") as { content: Array<{ type: string; thinking?: string; text?: string; id?: string }> };
		assert.deepEqual(
			assistant.content.map(part => [part.type, part.thinking ?? part.text ?? part.id]),
			[["thinking", "THINKING-TEXT"], ["text", "VISIBLE-TEXT"], ["toolCall", "call-first"], ["toolCall", "call-second"]],
			"thinking과 text는 구분된 블록으로 남고 tool call id가 보존된다",
		);
		console.log("PASS 뒤 tool이 먼저 끝나도 다음 provider 요청에 두 결과가 id별로 정확히 한 번씩 실린다");
	} finally {
		// 직렬화 회귀로 gate가 안 풀려도 dispose가 멈추지 않도록 대기 중인 tool을 모두 풀고 타이머를 지운다.
		clearTimeout(timer);
		gate.resolve();
		bothStarted.resolve();
		unsubscribe();
		await created.session.dispose();
	}
}

try {
	await terminalAsideCase();
	await queuedSteerCase();
	await incrementalCase();
	await errorRetryCase();
	await ordinaryIdleAsideCase();
	await reversedToolResultsCase();
	console.log("결과 6 pass");
} finally {
	if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = previousOpenAiKey;
}
