// Terminal yield 뒤 passive aside 가 새 provider turn 을 열지 않는 실제 AgentSession 회귀.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-yield-terminal-test.ts
// 모델 호출은 fake stream transport 로 대체한다. real YieldTool, Agent loop, AgentSession
// settle/IRC aside 경계를 그대로 타며 설치본과 외부 provider 는 건드리지 않는다.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live core");
const CORE = resolve(target, "src").replace(/\\/g, "/");
if (!existsSync(join(CORE, "session/agent-session.ts"))) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
const PACKAGES = resolve(dirname(CORE), "..").replace(/\\/g, "/");

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
	const root = mkdtempSync(join(tmpdir(), `omp-yield-terminal-${name}-`));
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
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// Windows may keep the isolated models.db handle until process exit.
			}
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

try {
	await terminalAsideCase();
	await queuedSteerCase();
	await incrementalCase();
	await errorRetryCase();
	await ordinaryIdleAsideCase();
	console.log("결과 5 pass");
} finally {
	if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = previousOpenAiKey;
}
