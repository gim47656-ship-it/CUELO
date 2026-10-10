// autolearn capture 사용량 계측 회귀(2026-10-10 Hermes 비교 M1, 방법 A). 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-autolearn-usage-test.ts
// 실제 createAutoLearnCaptureRunner 가 실제 Agent(루프·도구 실행·abort)를 돌린다. 모델 호출만 결정적 fake stream 으로
// 대체하므로 외부 provider·유료 호출·설치본은 건드리지 않는다. 미패치 core 에서는 [0]이 FAIL(RED)이다: 사용량 로그가 없다.
// 계약: capture 한 번이 끝날 때 logger.info 한 줄(`Auto-learn capture usage`)이 나온다. 새로 만든 assistant 응답만 합산하고,
// 응답 중 하나라도 보고하지 않은 필드의 합계는 0이 아니라 null(미상)이다. 본문·도구 인자·저장한 교훈 내용은 남지 않고,
// 저장 알림(onCaptured)·원본 대화·던져진 오류·기능 꺼짐(호출 0)은 그대로다.
// HOME·TEMP 는 import 전에 격리한다(logger 가 로그 파일을 쓴다). core-yield-terminal-test.ts 와 같은 방식이다.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (!process.env.OMP_USAGE_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-autolearn-usage-"));
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
				OMP_USAGE_FIXTURE_ROOT: root,
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
if (!existsSync(join(CORE, "sdk.ts"))) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
const PACKAGES = resolve(dirname(CORE), "..").replace(/\\/g, "/");
console.log(`[env] core=${CORE}`);

// 대상 core 경로가 실행 시점에 정해져 정적 import 를 쓸 수 없다.
const { createAutoLearnCaptureRunner } = await import(`${CORE}/sdk.ts`);
const { Agent } = await import(`${PACKAGES}/pi-agent-core/src/index.ts`);
const { createAssistantMessageEventStream } = await import(`${PACKAGES}/pi-ai/src/utils/event-stream.ts`);
const { registerLogSink } = await import(`${PACKAGES}/pi-utils/src/logger.ts`);
const { getBundledModel } = await import(`${PACKAGES}/pi-catalog/src/models.ts`);

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

const model = getBundledModel("openai", "gpt-4o-mini");
assert.ok(model, "bundled model 이 필요하다");

type LogEvent = { level: string; message: string; context?: Record<string, unknown> };
const events: LogEvent[] = [];
registerLogSink((event: LogEvent) => events.push({ level: event.level, message: event.message, context: event.context }));
const rowsOf = () => events.filter(e => e.level === "info" && e.message === "Auto-learn capture usage");

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): Usage => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

type Step =
	| { kind: "tool"; id: string; memory: string; usage: Usage; abortRun?: boolean }
	| { kind: "text"; text: string; usage: Usage; delayMs?: number }
	| { kind: "error"; usage: Usage; errorMessage: string };

const assistant = (content: unknown[], stopReason: string, u: Usage, extra: Record<string, unknown> = {}) => ({
	role: "assistant" as const,
	content,
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: u,
	stopReason,
	timestamp: Date.now(),
	...extra,
});

/** 결정적 fake transport: 단계별로 도구 호출·텍스트·오류 응답을 낸다. abort 는 aborted 오류 이벤트로 닫는다. */
function fakeStream(steps: Step[], onCall: () => void) {
	let index = 0;
	return (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
		const stream = createAssistantMessageEventStream();
		const step = steps[index++];
		onCall();
		const abortedMessage = () => assistant([], "aborted", usage(0, 0, 0, 0, 0), { errorMessage: "aborted" });
		queueMicrotask(async () => {
			if (options?.signal?.aborted) {
				stream.push({ type: "error", reason: "aborted", error: abortedMessage() });
				stream.end();
				return;
			}
			if (!step) {
				stream.fail(new Error(`unexpected provider request #${index}`));
				return;
			}
			if (step.kind === "tool") {
				const toolCall = { type: "toolCall" as const, id: step.id, name: "learn", arguments: { memory: step.memory } };
				const message = assistant([toolCall], "toolUse", step.usage);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
			} else if (step.kind === "text") {
				if (step.delayMs) await Bun.sleep(step.delayMs);
				const message = assistant([{ type: "text", text: step.text }], "stop", step.usage);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			} else {
				const message = assistant([], "error", step.usage, { errorMessage: step.errorMessage });
				stream.push({ type: "start", partial: message });
				stream.push({ type: "error", reason: "error", error: message });
			}
			stream.end();
		});
		return stream;
	};
}

interface RunOptions {
	signal?: AbortSignal;
	controller?: AbortController;
	/** 실행 뒤 prompt 가 던질 오류. */
	throwAfter?: Error;
	/** 실행 뒤 usage 를 읽으면 던지는 응답을 state 에 덧붙인다(관찰 실패 주입). */
	poison?: boolean;
	tools?: boolean;
}

const SOURCE_CANARY = "SOURCE-CANARY-DO-NOT-LOG";

async function run(steps: Step[], opts: RunOptions = {}) {
	const reports: string[][] = [];
	const warns: LogEvent[] = [];
	const rowsBefore = rowsOf().length;
	const eventsBefore = events.length;
	let calls = 0;
	let created = 0;
	let captureAgent: InstanceType<typeof Agent> | undefined;
	const source = {
		state: {
			model,
			messages: [
				{ role: "user", content: SOURCE_CANARY },
				assistant([{ type: "text", text: "앞 턴 답" }], "stop", usage(99999, 88888, 77777, 66666, 55)),
			], systemPrompt: [`SYSTEM-${SOURCE_CANARY}`],
			thinkingLevel: "off",
			disableReasoning: false,
		},
		getApiKey: () => undefined,
		metadataForProvider: () => undefined,
	};
	const before = JSON.stringify(source.state.messages);
	const sourceAssistants = source.state.messages.filter(m => m.role === "assistant").length;
	const learnTool = {
		name: "learn",
		label: "learn",
		description: "fixture",
		parameters: { type: "object", properties: { memory: { type: "string" } }, required: ["memory"] },
		execute: async (_id: string, params: { memory: string }) => {
			const abortRun = steps.some(s => s.kind === "tool" && s.abortRun && s.memory === params.memory);
			if (abortRun) opts.controller?.abort(new Error("user stop"));
			return { content: [{ type: "text", text: "saved" }] };
		},
	};
	const runner = createAutoLearnCaptureRunner({
		sourceAgent: source as never,
		captureTools: () => (opts.tools === false ? [] : [learnTool]) as never,
		onCaptured: (saved: string[]) => reports.push(saved),
		createAgent: (options: Record<string, unknown>) => {
			created++;
			const agent = new Agent({ ...options, streamFn: fakeStream(steps, () => calls++) as never } as never);
			captureAgent = agent;
			if (!opts.throwAfter && !opts.poison) return agent as never;
			return {
				get state() {
					return agent.state;
				},
				setMetadataResolver: (resolver: never) => agent.setMetadataResolver(resolver),
				abort: (reason?: unknown) => agent.abort(reason),
				prompt: async (message: never) => {
					await agent.prompt(message);
					if (opts.poison) {
						(agent.state.messages as unknown[]).push({
							role: "assistant",
							content: [],
							stopReason: "stop",
							get usage(): never {
								throw new Error("SECRET-OBSERVATION-ERROR sk-live-0123456789");
							},
						});
					}
					if (opts.throwAfter) throw opts.throwAfter;
				},
			} as never;
		},
	});
	const error = await runner("nudge", opts.signal).then(
		() => undefined,
		(err: Error) => err,
	);
	const emitted = events.slice(eventsBefore);
	for (const event of emitted) if (event.level === "warn") warns.push(event);
	const assistantsInState = captureAgent
		? (captureAgent.state.messages as Array<{ role: string }>).filter(m => m.role === "assistant").length - sourceAssistants
		: 0;
	return {
		rows: rowsOf().slice(rowsBefore).map(e => e.context ?? {}),
		reports,
		warns,
		emitted,
		error,
		calls,
		created,
		assistantsInState,
		sourceUnchanged: JSON.stringify(source.state.messages) === before,
	};
}

const near = (value: unknown, expected: number) => typeof value === "number" && Math.abs(value - expected) < 1e-9;
const ROW_KEYS = ["cacheRead", "cacheWrite", "costUsd", "elapsedMs", "incompleteRequests", "input", "model", "outcome", "output", "provider", "requests"];

console.log("\n[0] 정상 capture — 새 응답만 합산한 한 줄, 알림·원본·호출 수는 그대로");
{
	const r = await run([
		{ kind: "tool", id: "c1", memory: "배포 뒤 재시작이 필요하다. SECRET-MEMORY-BODY 세부.", usage: usage(1000, 50, 400, 30, 0.0125) },
		{ kind: "text", text: "끝", usage: usage(1100, 20, 900, 0, 0.0041), delayMs: 40 },
	]);
	const row = r.rows[0] ?? {};
	check("capture 한 번에 사용량 한 줄", r.rows.length === 1, `rows=${r.rows.length}`);
	check("provider·model·outcome", row.provider === model.provider && row.model === model.id && row.outcome === "completed", JSON.stringify(row));
	check(
		"요청 수는 이 capture 가 만든 assistant 응답 수이고 실제 provider 호출 수와 같다",
		row.requests === 2 && row.requests === r.assistantsInState && r.calls === 2 && row.incompleteRequests === 0,
		`row=${row.requests} state=${r.assistantsInState} calls=${r.calls}`,
	);
	check(
		"입력·출력·캐시·비용은 새 응답만 합산한다(원본 스냅샷의 99999 등은 없다)",
		row.input === 2100 && row.output === 70 && row.cacheRead === 1300 && row.cacheWrite === 30 && near(row.costUsd, 0.0166),
		JSON.stringify(row),
	);
	check("경과 시간은 정수 ms 이고 fake 지연 이상이다", Number.isInteger(row.elapsedMs) && (row.elapsedMs as number) >= 30, `elapsedMs=${row.elapsedMs}`);
	check("필드는 정해진 목록뿐이고 본문·도구 인자·교훈·원본 내용이 없다", JSON.stringify(Object.keys(row).sort()) === JSON.stringify(ROW_KEYS) && !JSON.stringify(row).includes("SECRET") && !JSON.stringify(row).includes(SOURCE_CANARY), JSON.stringify(row));
	check("저장 알림은 그대로 한 번, 교훈은 첫 문장만", JSON.stringify(r.reports) === JSON.stringify([["교훈: 배포 뒤 재시작이 필요하다."]]), JSON.stringify(r.reports));
	check("원본 대화는 바뀌지 않고 경고도 없다", r.sourceUnchanged && r.warns.length === 0, JSON.stringify(r.warns));
}

console.log("\n[1] 한 응답이라도 필드를 보고하지 않으면 그 합계는 미상(null)이다");
{
	const r = await run([
		{ kind: "tool", id: "c1", memory: "교훈 하나.", usage: usage(1000, 50, 400, 30, 0.0125) },
		// 두 번째 응답은 input/output 만 보고하고 캐시·비용은 없다.
		{ kind: "text", text: "끝", usage: { input: 10, output: 5, totalTokens: 15 } },
	]);
	const row = r.rows[0] ?? {};
	check(
		"보고한 필드는 합산하고 빠진 필드는 0 이 아니라 null",
		row.requests === 2 && row.input === 1010 && row.output === 55 && row.cacheRead === null && row.cacheWrite === null && row.costUsd === null,
		JSON.stringify(row),
	);
}

console.log("\n[2] 마지막 응답이 stopReason=error 로 끝나도 한 줄을 남기고, 앞서 저장한 교훈은 한 번 알린다");
{
	const r = await run([
		{ kind: "tool", id: "c1", memory: "먼저 저장한 교훈. 세부.", usage: usage(1000, 50, 400, 30, 0.0125) },
		{ kind: "error", usage: usage(0, 0, 0, 0, 0), errorMessage: "SECRET-PROVIDER-ERROR" },
	]);
	const row = r.rows[0] ?? {};
	check("outcome=failed, 불완전 요청 1, 요청 수는 응답 수와 같다", r.rows.length === 1 && row.outcome === "failed" && row.requests === 2 && row.incompleteRequests === 1 && row.requests === r.assistantsInState, `row=${JSON.stringify(row)} state=${r.assistantsInState}`);
	check("오류 응답의 usage 도 보고한 값으로 합산한다(첫 응답 1000 + 0)", row.input === 1000 && row.output === 50, JSON.stringify(row));
	check("오류 문구는 로그에 없다", !JSON.stringify(row).includes("SECRET"), JSON.stringify(row));
	check("취소·실패 전에 저장한 교훈은 정확히 한 번 알린다", JSON.stringify(r.reports) === JSON.stringify([["교훈: 먼저 저장한 교훈."]]), JSON.stringify(r.reports));
}

console.log("\n[3] 저장한 뒤 취소 — outcome=aborted, 저장 알림 한 번, 추가 provider 요청 없음");
{
	const controller = new AbortController();
	const r = await run(
		[
			{ kind: "tool", id: "c1", memory: "취소 전에 저장한 교훈. 세부.", usage: usage(1000, 50, 400, 30, 0.0125), abortRun: true },
			{ kind: "text", text: "취소 뒤에는 나오면 안 된다", usage: usage(5, 5, 5, 5, 1) },
		],
		{ signal: controller.signal, controller },
	);
	const row = r.rows[0] ?? {};
	check("outcome=aborted 한 줄", r.rows.length === 1 && row.outcome === "aborted", JSON.stringify(row));
	check("요청 수는 실제 응답 수와 같고 두 번째 provider 요청은 본문을 만들지 못했다", row.requests === r.assistantsInState && !JSON.stringify(row).includes("나오면"), `row=${row.requests} state=${r.assistantsInState} calls=${r.calls}`);
	check("취소 전에 저장한 교훈은 정확히 한 번 알린다", JSON.stringify(r.reports) === JSON.stringify([["교훈: 취소 전에 저장한 교훈."]]), JSON.stringify(r.reports));
	check("취소는 오류로 던져지지 않는다", r.error === undefined, String(r.error));
}

console.log("\n[4] prompt 가 던지면 원래 오류를 그대로 던지고 outcome=failed, 알림은 한 번");
{
	const original = new Error("provider 끊김");
	const r = await run([{ kind: "tool", id: "c1", memory: "던지기 전 저장한 교훈. 세부.", usage: usage(1000, 50, 400, 30, 0.0125) }, { kind: "text", text: "끝", usage: usage(1, 1, 1, 1, 0.001) }], { throwAfter: original });
	const row = r.rows[0] ?? {};
	check("같은 오류 객체가 그대로 던져진다", r.error === original, String(r.error));
	check("outcome=failed 한 줄", r.rows.length === 1 && row.outcome === "failed" && row.requests === 2, JSON.stringify(row));
	check("저장 알림은 한 번", JSON.stringify(r.reports) === JSON.stringify([["교훈: 던지기 전 저장한 교훈."]]), JSON.stringify(r.reports));
}

console.log("\n[5] 계측 읽기가 실패해도 원래 오류·저장 알림·정리는 영향받지 않는다");
{
	const original = new Error("provider 끊김");
	const r = await run([{ kind: "tool", id: "c1", memory: "관찰 실패 전 저장. 세부.", usage: usage(1000, 50, 400, 30, 0.0125) }, { kind: "text", text: "끝", usage: usage(1, 1, 1, 1, 0.001) }], { throwAfter: original, poison: true });
	check("원래 오류가 그대로 던져지고 사용량 줄은 없다", r.error === original && r.rows.length === 0, `error=${String(r.error)} rows=${r.rows.length}`);
	check("실패는 정적 경고 한 줄로만 남는다(오류 객체·문구를 싣지 않는다)", r.warns.length === 1 && r.warns[0]!.message === "Failed to record auto-learn capture usage" && r.warns[0]!.context === undefined, JSON.stringify(r.warns));
	check("이 실행이 낸 모든 로그에 관찰 오류의 비밀 같은 문구가 없다", !JSON.stringify(r.emitted).includes("SECRET") && !JSON.stringify(r.emitted).includes("sk-live"), JSON.stringify(r.emitted));
	check("저장 알림은 그래도 한 번", JSON.stringify(r.reports) === JSON.stringify([["교훈: 관찰 실패 전 저장."]]), JSON.stringify(r.reports));
}

console.log("\n[6] capture 를 시작하지 않으면 줄도 provider 호출도 없다");
{
	const controller = new AbortController();
	controller.abort(new Error("이미 취소"));
	const early = await run([{ kind: "text", text: "나오면 안 된다", usage: usage(1, 1, 1, 1, 1) }], { signal: controller.signal });
	check("이미 취소된 signal: agent 도 줄도 호출도 없다", early.created === 0 && early.rows.length === 0 && early.calls === 0 && early.error === undefined, `created=${early.created} rows=${early.rows.length} calls=${early.calls}`);
	const off = await run([{ kind: "text", text: "나오면 안 된다", usage: usage(1, 1, 1, 1, 1) }], { tools: false });
	check("capture 도구가 없으면(기능 꺼짐) agent 도 줄도 호출도 없다", off.created === 0 && off.rows.length === 0 && off.calls === 0 && off.reports.length === 0, `created=${off.created} rows=${off.rows.length} calls=${off.calls}`);
}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
