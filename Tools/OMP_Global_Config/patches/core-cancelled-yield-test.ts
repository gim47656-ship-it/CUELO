// 실제 취소(caller·shutdown·runtime timeout) 뒤에 끝난 yield 가 성공으로 바뀌거나 이미 수용된
// <id>.md/<id>.json 을 덮어쓰지 않는지 실제 executor·YieldTool 로 확인한다(2026-10-23 late-result-audit D1).
// 실행: OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-cancelled-yield-test.ts
// provider 호출 없음. 가짜 AgentSession 은 Promise gate 로 yield 시작 → abort 요청 → yield 끝 순서를 고정한다.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.env.OMP_CANCELLED_YIELD_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-cancelled-yield-"));
	const home = join(root, "home");
	mkdirSync(home);
	let exitCode = 1;
	try {
		const child = Bun.spawnSync([process.execPath, import.meta.path], {
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_CANCELLED_YIELD_ROOT: root,
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
if (!existsSync(join(CORE, "task/executor.ts"))) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET (isolated unpatched/patched copies).
const { YieldTool } = await import(`${CORE}/tools/yield.ts`);
const { runSubagentFollowUpTurn, attachIrcWakeTurnMonitor } = await import(`${CORE}/task/executor.ts`);
const { AgentRegistry } = await import(`${CORE}/registry/agent-registry.ts`);
const { ASYNC_JOB_MANAGER_SHUTDOWN_REASON } = await import(`${CORE}/async/job-manager.ts`);
// CUELO's activity watch hooks the session's real Agent; its disposers are released before exit.
const { Agent } = await import(`${CORE}/../../pi-agent-core/src/agent.ts`);
const disposers: (() => void)[] = [];

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
};

type Listener = (event: unknown) => void;
const USAGE = { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } };
const SCHEMA = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };
const ORIGINAL_MD = "ORIGINAL-ACCEPTED-REPORT";
const ORIGINAL_JSON = '{\n  "summary": "ORIGINAL-ACCEPTED"\n}\n';
const agent = { name: "maker", description: "d", systemPrompt: "s", source: "bundled" } as never;

/** One scripted turn: usage-bearing assistant message, then a real yield whose end waits on `yieldGate`. */
class FakeSession {
	listeners = new Set<Listener>();
	isStreaming = false;
	servingModel = undefined;
	model = undefined;
	asyncJobManager: unknown = undefined;
	agent = new Agent();
	sessionManager = { getSessionId: () => "cyf-fixture" };
	turnEnd = Promise.withResolvers<void>();
	yieldStarted = Promise.withResolvers<void>();
	yieldGate = Promise.withResolvers<void>();
	yieldEnded = Promise.withResolvers<void>();
	abortCalled = Promise.withResolvers<void>();
	abortGate = Promise.withResolvers<void>();
	toolSignal = new AbortController();
	yieldTool = new YieldTool({} as never);
	secondGate = Promise.withResolvers<void>();
	secondEnded = Promise.withResolvers<void>();
	/** Set when a second, independently gated yield call follows the first one in the same turn. */
	second = false;
	constructor(readonly payload: string) {}
	subscribe(l: Listener) {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}
	subscribeRunState() { return () => {}; }
	isAdvisorActive() { return false; }
	isParentIrcSteer() { return false; }
	async setWorkPoolYieldItems() {}
	getToolByName() { return undefined; }
	hasPendingAsyncWork() { return false; }
	async settleAsyncWork() {}
	getAsyncJobSnapshot() { return undefined; }
	getLastAssistantMessage() { return undefined; }
	trackIrcReply() {}
	addDisposer(dispose: () => void) { disposers.push(dispose); }
	observer: ((records: unknown[], bracket?: unknown) => (error?: unknown) => Promise<void>) | undefined;
	setIrcWakeTurnObserver(o: typeof this.observer) { this.observer = o; }
	waitForIdle() { return this.isStreaming ? this.turnEnd.promise : Promise.resolve(); }
	async abort() {
		this.toolSignal.abort(new Error("session.abort()"));
		this.abortCalled.resolve();
		await this.abortGate.promise;
		this.turnEnd.resolve();
	}
	emit(event: unknown) { for (const l of [...this.listeners]) l(event); }
	/** The turn body shared by the follow-up prompt and the IRC wake bracket. */
	async runYield() {
		this.emit({ type: "message_start", message: { role: "assistant" } });
		this.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "toolUse", usage: USAGE } });
		const data = { summary: this.payload };
		const second = { summary: `${this.payload}-2` };
		this.emit({ type: "tool_execution_start", toolName: "yield", toolCallId: "y1", args: { data } });
		if (this.second) this.emit({ type: "tool_execution_start", toolName: "yield", toolCallId: "y2", args: { data: second } });
		this.yieldStarted.resolve();
		await this.yieldGate.promise;
		const result = await this.yieldTool.execute("y1", { data }, this.toolSignal.signal);
		this.emit({ type: "tool_execution_end", toolName: "yield", toolCallId: "y1", isError: false, args: { data }, result });
		this.yieldEnded.resolve();
		if (!this.second) return;
		await this.secondGate.promise;
		const late = await this.yieldTool.execute("y2", { data: second }, this.toolSignal.signal);
		this.emit({ type: "tool_execution_end", toolName: "yield", toolCallId: "y2", isError: false, args: { data: second }, result: late });
		this.secondEnded.resolve();
	}
	async prompt() {
		this.isStreaming = true;
		try {
			await this.runYield();
			await this.turnEnd.promise;
		} finally {
			this.isStreaming = false;
		}
	}
}

type Cancel = "none" | "caller" | "shutdown" | "timeout" | "caller-after-yield" | "second-yield-after-cancel";
const seed = (dir: string) => {
	writeFileSync(join(dir, "X.md"), ORIGINAL_MD);
	writeFileSync(join(dir, "X.json"), ORIGINAL_JSON);
};
const artifacts = (dir: string) => ({ md: readFileSync(join(dir, "X.md"), "utf8"), json: existsSync(join(dir, "X.json")) ? readFileSync(join(dir, "X.json"), "utf8") : "(missing)" });
const cancelReason = (kind: Cancel) => (kind === "shutdown" ? ASYNC_JOB_MANAGER_SHUTDOWN_REASON : new Error("Cancelled by caller"));

/** Orders the turn: yield starts, the cancellation (if any) reaches session.abort(), then the yield ends. */
async function orchestrate(session: FakeSession, kind: Cancel, cancel: () => void) {
	await session.yieldStarted.promise;
	if (kind === "none" || kind === "caller-after-yield" || kind === "second-yield-after-cancel") {
		session.yieldGate.resolve();
		await session.yieldEnded.promise; // terminal yield -> requestAbort("terminate") -> session.abort()
		await session.abortCalled.promise;
		if (kind !== "none") cancel(); // cancel lands while the accepted yield's abort cleanup runs
		if (kind === "second-yield-after-cancel") {
			// requestAbort upgrades terminate to signal here; a later yield must not turn the accepted result into a cancellation.
			session.secondGate.resolve();
			await session.secondEnded.promise;
		}
		session.abortGate.resolve();
		return;
	}
	if (kind !== "timeout") cancel();
	await session.abortCalled.promise; // caller / shutdown signal or the runtime timer reached session.abort()
	session.yieldGate.resolve(); // the in-flight yield now finishes with an already-aborted tool signal
	await session.yieldEnded.promise;
	session.abortGate.resolve();
}

async function followUp(kind: Cancel) {
	const dir = mkdtempSync(join(tmpdir(), "cyf-follow-"));
	seed(dir);
	const session = new FakeSession(`LATE-${kind}`);
	session.second = kind === "second-yield-after-cancel";
	AgentRegistry.global().register({ id: "X", displayName: "X", kind: "sub", session: session as never, sessionFile: null, status: "idle" });
	const ctl = new AbortController();
	const turn = runSubagentFollowUpTurn({
		id: "X", agent, message: "rework", artifactsDir: dir, structured: true, outputSchema: SCHEMA,
		...(kind === "timeout" ? { maxRuntimeMs: 40 } : { signal: ctl.signal }),
	});
	await orchestrate(session, kind, () => ctl.abort(cancelReason(kind)));
	const result = await turn;
	session.turnEnd.resolve();
	const files = artifacts(dir);
	rmSync(dir, { recursive: true, force: true });
	AgentRegistry.resetGlobalForTests();
	return { result, files };
}

async function ircWake(kind: Cancel) {
	const dir = mkdtempSync(join(tmpdir(), "cyf-wake-"));
	seed(dir);
	const session = new FakeSession(`LATE-WAKE-${kind}`);
	session.second = kind === "second-yield-after-cancel";
	const job = new AbortController();
	let outcome: Promise<unknown> | undefined;
	session.asyncJobManager = {
		register: (_type: string, _id: string, run: (ctx: { signal: AbortSignal; reportProgress: () => Promise<void> }) => Promise<unknown>) => {
			outcome = run({ signal: job.signal, reportProgress: async () => {} }).catch(error => ({ rejected: error instanceof Error ? error.message : String(error) }));
			return "job-X";
		},
		getJob: () => undefined,
		publishCompleted: () => {},
	};
	AgentRegistry.global().register({ id: "X", displayName: "X", kind: "sub", parentId: "Owner", session: session as never, sessionFile: null, status: "idle" });
	const frames: Array<{ status?: string }> = [];
	attachIrcWakeTurnMonitor(session as never, {
		id: "X", agent, artifactsDir: dir, outputSchema: SCHEMA, structured: true,
		eventBus: { emit: (_c: string, data: unknown) => frames.push(data as { status?: string }) } as never,
		...(kind === "timeout" ? { maxRuntimeMs: 40 } : {}),
	});
	const finish = session.observer?.([{ role: "custom", content: "please revise", details: { from: "Owner", message: "please revise", id: "m1" } }]);
	const body = session.runYield();
	await orchestrate(session, kind, () => job.abort(cancelReason(kind)));
	await body;
	await finish?.(undefined);
	const status = frames.findLast(frame => frame.status && frame.status !== "started")?.status;
	const settled = await Promise.race([outcome ?? Promise.resolve("(no job)"), Bun.sleep(2000).then(() => "(pending)")]);
	const files = artifacts(dir);
	rmSync(dir, { recursive: true, force: true });
	AgentRegistry.resetGlobalForTests();
	return { status, settled, files };
}

console.log(`target ${CORE}`);
console.log("\n[follow-up] runSubagentFollowUpTurn");
for (const kind of ["caller", "shutdown", "timeout"] as const) {
	const { result, files } = await followUp(kind);
	const late = `LATE-${kind}`;
	check(`${kind}: cancelled late yield stays aborted with a nonzero exit`, result.aborted === true && result.exitCode !== 0, `aborted=${result.aborted} exit=${result.exitCode} reason=${result.abortReason}`);
	check(`${kind}: accepted <id>.md and <id>.json are not replaced`, files.md === ORIGINAL_MD && files.json === ORIGINAL_JSON && result.outputPath === undefined, `md=${JSON.stringify(files.md)} json=${JSON.stringify(files.json)} outputPath=${result.outputPath}`);
	check(`${kind}: late payload and usage stay as diagnostics`, result.output.includes(late) && result.usage?.totalTokens === 18 && result.usage?.cost.total === 0.25, `output=${JSON.stringify(result.output)} usage=${result.usage?.totalTokens}`);
}
for (const kind of ["none", "caller-after-yield", "second-yield-after-cancel"] as const) {
	const { result, files } = await followUp(kind);
	const late = `LATE-${kind}`;
	check(`${kind}: accepted yield stays a success`, result.aborted === false && result.exitCode === 0, `aborted=${result.aborted} exit=${result.exitCode}`);
	check(`${kind}: accepted yield republishes <id>.md and <id>.json`, files.md.includes(late) && files.json.includes(late) && result.outputPath !== undefined, `md=${JSON.stringify(files.md)} json=${JSON.stringify(files.json)}`);
}

console.log("\n[irc-wake] attachIrcWakeTurnMonitor");
for (const kind of ["caller", "shutdown", "timeout"] as const) {
	const { status, settled, files } = await ircWake(kind);
	check(`${kind}: cancelled wake-turn yield ends aborted, job not resolved as success`, status === "aborted" && typeof settled === "object" && settled !== null && "rejected" in settled, `status=${status} settled=${JSON.stringify(settled)}`);
	check(`${kind}: accepted <id>.md and <id>.json are not replaced`, files.md === ORIGINAL_MD && files.json === ORIGINAL_JSON, `md=${JSON.stringify(files.md)} json=${JSON.stringify(files.json)}`);
}
for (const kind of ["none", "second-yield-after-cancel"] as const) {
	const { status, files } = await ircWake(kind);
	check(`${kind}: wake-turn yield stays completed and republishes`, status === "completed" && files.md.includes(`LATE-WAKE-${kind}`) && files.json.includes(`LATE-WAKE-${kind}`), `status=${status} md=${JSON.stringify(files.md)}`);
}

for (const dispose of disposers) dispose();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAIL`}`);
process.exit(failures === 0 ? 0 : 1);
