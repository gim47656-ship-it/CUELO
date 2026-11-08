// Codex whitespace-only tool-call argument loop: session recovery and the opt-in fallback, on a real AgentSession.
// Run: OMP_CORE_PATCH_TARGET=<isolated core copy>/node_modules/@oh-my-pi/pi-coding-agent bun run patches/core-codex-whitespace-recovery-test.ts
// Observed 2026-11-08 on gpt-6-astra: visible text, then a function call whose arguments were 256 whitespace-only
// deltas. The provider breaker dropped the call, refused its own replay (text was already shown) and finalized
// errorId 0, so the session stopped on the error with no retry or fallback.
// Real path: AgentSession + Agent loop + streamOpenAICodexResponses to a local fake Codex server over SSE and over
// WebSocket (live Codex prefers WebSocket), TurnRecovery, the configured retry.fallbackChains walk. Fake boundary:
// the Codex server frames, the fallback model's stream (fixture-alt) and the probe tool body. Not proven: real Codex
// sampling, real fallback-model quality, billing.
// RED on a core without the 2026-11-08 entries: [observed/*], [bounded-off], [fallback-text/*], [replay-*],
// [tool-then-loop/*]. [transport-denied], [quoted-denied], [suffix-denied], [text-only-denied] and [abort] are
// controls that pass on both; the denied cases failed on the earlier, looser breaker regex (review R1/R2-OAI-1).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (!process.env.OMP_CODEX_WS_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-codex-ws-fixture-"));
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
				OMP_CODEX_WS_FIXTURE_ROOT: root,
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
if (!existsSync(join(CORE, "session/agent-session.ts"))) throw new Error(`core copy not found: ${CORE}`);
const PACKAGES = resolve(dirname(CORE), "..").replace(/\\/g, "/");
const fixtureRoot = process.env.OMP_CODEX_WS_FIXTURE_ROOT!;
console.log(`[env] core=${CORE}`);
// Dynamic imports: the core copy is chosen at run time by OMP_CORE_PATCH_TARGET.
const { setAgentDir } = await import(`${PACKAGES}/pi-utils/src/dirs.ts`);
setAgentDir(join(fixtureRoot, "home", ".omp", "agent"));
const { createAgentSession } = await import(`${CORE}/sdk.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
const { createAssistantMessageEventStream } = await import(`${PACKAGES}/pi-ai/src/utils/event-stream.ts`);
const { streamOpenAICodexResponses } = await import(`${PACKAGES}/pi-ai/src/providers/openai-codex-responses.ts`);
const { getBundledModel } = await import(`${PACKAGES}/pi-catalog/src/models.ts`);

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` - ${detail}`}`);
	if (!ok) failures++;
}

const VISIBLE = "I will now read the measurement contract and then prepare the HTML report data for the next step of this run.";
const LOOP_MESSAGE = /Interrupted OpenAI Codex response after \d+ consecutive whitespace-only tool-call argument delta events/;
const REMINDER = "Continue exactly where it stopped";

// ── fake Codex SSE server ─────────────────────────────────────────────────────
type Behavior = "text-loop" | "loop" | "tool-then-loop" | "text-close" | "text-quoted-fail" | "text-slow-loop" | "ok";
let script: Behavior[] = [];
let codexBodies: string[] = [];
function frames(id: string, behavior: Behavior): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [{ type: "response.created", response: { id } }];
	const reasoning = { type: "reasoning", id: `rs_${id}`, summary: [], encrypted_content: `SIG_${id}` };
	out.push({ type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: undefined } });
	out.push({ type: "response.output_item.done", output_index: 0, item: reasoning });
	const msg = { type: "message", id: `msg_${id}`, role: "assistant", content: [] as unknown[] };
	const text = (index: number, value: string) => {
		out.push({ type: "response.output_item.added", output_index: index, item: msg });
		out.push({ type: "response.content_part.added", output_index: index, item_id: msg.id, content_index: 0, part: { type: "output_text", text: "" } });
		out.push({ type: "response.output_text.delta", output_index: index, item_id: msg.id, content_index: 0, delta: value });
		out.push({ type: "response.output_item.done", output_index: index, item: { ...msg, content: [{ type: "output_text", text: value }] } });
	};
	const whitespaceCall = (index: number, count: number) => {
		const call = { type: "function_call", id: `fc_loop_${id}`, call_id: `call_loop_${id}`, name: "probe_tool", arguments: "" };
		out.push({ type: "response.output_item.added", output_index: index, item: call });
		for (let i = 0; i < count; i++) {
			out.push({ type: "response.function_call_arguments.delta", output_index: index, item_id: call.id, delta: i % 2 ? " " : "\n" });
		}
	};
	if (behavior === "ok") {
		text(1, `DONE_${id}`);
		out.push({
			type: "response.completed",
			response: {
				id,
				status: "completed",
				output: [reasoning, { ...msg, content: [{ type: "output_text", text: `DONE_${id}` }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		});
	} else if (behavior === "text-loop" || behavior === "text-slow-loop") {
		text(1, VISIBLE);
		whitespaceCall(2, 300);
	} else if (behavior === "loop") {
		whitespaceCall(1, 300);
	} else if (behavior === "tool-then-loop") {
		const call = { type: "function_call", id: `fc_a_${id}`, call_id: `call_a_${id}`, name: "probe_tool", arguments: "" };
		out.push({ type: "response.output_item.added", output_index: 1, item: call });
		out.push({ type: "response.function_call_arguments.delta", output_index: 1, item_id: call.id, delta: '{"n":1}' });
		out.push({ type: "response.output_item.done", output_index: 1, item: { ...call, arguments: '{"n":1}' } });
		whitespaceCall(2, 300);
	} else if (behavior === "text-close") {
		text(1, VISIBLE);
	} else if (behavior === "text-quoted-fail") {
		// A different, non-retryable failure that only quotes the breaker text (review R1-OAI-1).
		text(1, VISIBLE);
		out.push({
			type: "response.failed",
			response: {
				id,
				status: "failed",
				error: {
					code: "invalid_prompt",
					message: "Unrelated failure; prior diagnostic: Interrupted OpenAI Codex response after 256 consecutive whitespace-only tool-call argument delta events",
				},
			},
		});
	}
	return out;
}
// Transport per Codex request ("sse" | "ws"), so a WebSocket case can prove it never fell back to SSE.
let transports: string[] = [];
function nextBehavior(): Behavior {
	return script.length > 1 ? script.shift()! : script[0];
}
const server = Bun.serve({
	port: 0,
	async fetch(req, srv) {
		// Live Codex runs on WebSocket (preferWebsockets: true); same pattern as core-native-inflight-test.ts.
		if (srv.upgrade(req)) return undefined;
		const body = await req.text();
		codexBodies.push(body);
		transports.push("sse");
		const behavior = nextBehavior();
		const id = `resp_${codexBodies.length}`;
		const all = frames(id, behavior);
		const encoder = new TextEncoder();
		// The client cuts loops (provider breaker) and the abort case (user cancel) mid-stream; stop writing then.
		let cancelled = false;
		const stream = new ReadableStream({
			async start(controller) {
				for (const [index, frame] of all.entries()) {
					// The abort case streams the loop slowly so the user can cancel mid-stream.
					if (behavior === "text-slow-loop" && index > 8) await Bun.sleep(15);
					if (cancelled) return;
					controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
				}
				// text-close ends without a terminal event, like a dropped Codex stream.
				controller.close();
			},
			cancel() {
				cancelled = true;
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
	websocket: {
		// The WebSocket transport sends the same Codex events as JSON text frames, one response per response.create.
		async message(ws, raw) {
			const frame = JSON.parse(String(raw)) as { type: string };
			if (frame.type !== "response.create") return;
			codexBodies.push(String(raw));
			transports.push("ws");
			const id = `resp_${codexBodies.length}`;
			for (const event of frames(id, nextBehavior())) {
				if (ws.readyState !== 1) return; // the client closed the socket (breaker or abort)
				ws.send(JSON.stringify(event));
				await Bun.sleep(0);
			}
		},
	},
});
const jwt = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture_ws" } })).toString("base64")}.s`;

// ── one session per case ─────────────────────────────────────────────────────
const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const astra = { ...getBundledModel("openai-codex", "gpt-6-astra"), baseUrl: `http://127.0.0.1:${server.port}/codex`, preferWebsockets: false };
const flagKnown = (() => {
	try {
		Settings.isolated({ "retry.codexWhitespaceLoopFallback": true });
		return true;
	} catch {
		return false;
	}
})();
console.log(`[env] retry.codexWhitespaceLoopFallback registered=${flagKnown}`);

type Msg = { role: string; stopReason?: string; errorMessage?: string; content?: unknown; toolCallId?: string; details?: Record<string, unknown> };
// inject: the Codex call returns this assistant error (visible text kept, errorId 0) instead of hitting the server.
// It probes admission boundaries the real provider cannot produce, since it wraps every other failure text.
async function runCase(name: string, opts: { behaviors: Behavior[]; flag: boolean; maxRetries?: number; abortAfterText?: boolean; inject?: string; ws?: boolean }) {
	const root = mkdtempSync(join(fixtureRoot, `${name}-`));
	const work = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(work);
	mkdirSync(agentDir);
	// Placeholder keys (not secrets) so the registry treats both models as usable; without the openai-codex one the
	// session swaps to the chain before the first request. Traffic only reaches the fake server or the in-process stream.
	writeFileSync(join(agentDir, "models.yml"), ["providers:", "  openai-codex:", '    apiKey: "example"', "  fixture-alt:", "    baseUrl: http://127.0.0.1:9/v1", "    api: openai-completions", '    apiKey: "example"', "    models:", "      - id: alt-model", ""].join("\n"));
	script = [...opts.behaviors];
	codexBodies = [];
	transports = [];
	const altContexts: Msg[][] = [];
	const probeRuns: string[] = [];
	const created = await createAgentSession({
		cwd: work,
		agentDir,
		agentId: `CodexWs-${name}`,
		model: astra,
		thinkingLevel: "off",
		getApiKey: () => "example",
		toolNames: ["probe_tool"],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		settings: Settings.isolated({
			"retry.enabled": true,
			"retry.maxRetries": opts.maxRetries ?? 1,
			"retry.baseDelayMs": 1,
			"retry.modelFallback": true,
			"retry.fallbackOn": "usage-limit",
			"retry.fallbackRevertPolicy": "never",
			"retry.fallbackChains": { "openai-codex/gpt-6-astra": ["fixture-alt/alt-model"] },
			...(opts.flag && flagKnown ? { "retry.codexWhitespaceLoopFallback": true } : {}),
		}),
		extensions: [
			(pi: { registerTool: (tool: unknown) => void }) => {
				pi.registerTool({
					name: "probe_tool",
					label: "Probe",
					loadMode: "essential",
					description: "Counts executions",
					parameters: { type: "object", properties: { n: { type: "number" } } },
					async execute(id: string) {
						probeRuns.push(id);
						return { content: [{ type: "text", text: `PROBE_RAN ${id}` }], details: {} };
					},
				});
			},
		] as never,
	});
	const session = created.session;
	session.setTextOutputCommitted(true); // the user's main session renders text as it streams
	session.agent.streamFn = ((model: { provider: string; api: string; id: string }, context: { messages: Msg[] }, options: Record<string, unknown>) => {
		if (model.provider === "openai-codex" && opts.inject !== undefined) {
			const stream = createAssistantMessageEventStream();
			const failed = { role: "assistant" as const, content: [{ type: "text" as const, text: VISIBLE }], api: "openai-codex-responses", provider: model.provider, model: model.id, usage: usage(), stopReason: "error" as const, errorMessage: opts.inject, errorId: 0, timestamp: Date.now() };
			queueMicrotask(() => {
				stream.push({ type: "start", partial: failed });
				stream.push({ type: "error", reason: "error", error: failed });
				stream.end(failed);
			});
			return stream;
		}
		if (model.provider === "openai-codex") {
			return streamOpenAICodexResponses({ ...astra, ...model, baseUrl: astra.baseUrl, preferWebsockets: opts.ws === true }, context, { ...options, apiKey: jwt, providerSessionState: new Map() });
		}
		altContexts.push(structuredClone(context.messages));
		const stream = createAssistantMessageEventStream();
		const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "ALT_OK" }], api: model.api, provider: model.provider, model: model.id, usage: usage(), stopReason: "stop" as const, timestamp: Date.now() };
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		});
		return stream;
	}) as never;
	const events: Array<{ type: string; attempt?: number; success?: boolean }> = [];
	const ends: Msg[] = [];
	// agent_end.isTerminal is !willContinue: the UI shows the turn as finished only on the terminal settle.
	const agentEnds: boolean[] = [];
	const unsubscribe = session.subscribe((event: { type: string; attempt?: number; success?: boolean; message?: Msg; assistantMessageEvent?: { type: string }; isTerminal?: boolean }) => {
		if (event.type === "auto_retry_start" || event.type === "auto_retry_end") events.push({ type: event.type, attempt: event.attempt, success: event.success });
		if (event.type === "agent_end") agentEnds.push(event.isTerminal === true);
		if (event.type === "message_end" && event.message?.role === "assistant") ends.push(event.message);
		if (opts.abortAfterText && event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			void session.abort();
		}
	});
	const settle = (async () => {
		await session.prompt("prepare the report data");
		await session.waitForIdle();
	})();
	let timedOut = false;
	await Promise.race([settle, Bun.sleep(30_000).then(() => { timedOut = true; })]);
	unsubscribe();
	check(
		`[${name}] every agent_end before the last continues (willContinue), only the last is terminal`,
		agentEnds.length > 0 && agentEnds.at(-1) === true && agentEnds.slice(0, -1).every(terminal => !terminal),
		JSON.stringify(agentEnds),
	);
	const messages = structuredClone(session.agent.state.messages) as Msg[];
	const result = {
		timedOut,
		codexRequests: codexBodies.length,
		transports: [...transports],
		altContexts,
		probeRuns,
		events,
		ends,
		messages,
		model: `${session.model?.provider}/${session.model?.id}`,
		last: ends.at(-1),
	};
	await session.dispose();
	return result;
}
const textOf = (m: Msg) => JSON.stringify(m.content ?? "");
const failedVisibleTurns = (ms: Msg[]) => ms.filter(m => m.role === "assistant" && m.stopReason === "error" && textOf(m).includes(VISIBLE)).length;
const reminders = (ms: Msg[]) => ms.filter(m => m.role === "developer" && textOf(m).includes(REMINDER)).length;
const summary = (r: { codexRequests: number; transports: string[]; altContexts: unknown[]; model: string; last?: Msg; events: unknown[]; timedOut: boolean }) =>
	`codex=${r.codexRequests} via=${[...new Set(r.transports)].join("+")} alt=${r.altContexts.length} model=${r.model} last=${r.last?.stopReason}:${(r.last?.errorMessage ?? textOf(r.last ?? { role: "" })).slice(0, 90)} events=${JSON.stringify(r.events)} timedOut=${r.timedOut}`;
// Live Codex prefers WebSocket; SSE is its HTTP fallback. The observed, fallback and tool cases run on both.
const TRANSPORTS = ["sse", "ws"] as const;

try {
	for (const transport of TRANSPORTS) {
		console.log(`\n[observed/${transport}] visible text then whitespace loop, flag off: same-model continuation keeps the text`);
		const r = await runCase(`observed-${transport}`, { behaviors: ["text-loop", "ok"], flag: false, ws: transport === "ws" });
		console.log(`  ${summary(r)}`);
		check(`every Codex request used ${transport}`, r.transports.length > 0 && r.transports.every(t => t === transport), JSON.stringify(r.transports));
		check("first failure surfaces as the whitespace-loop error with visible text kept", LOOP_MESSAGE.test(r.ends[0]?.errorMessage ?? "") && textOf(r.ends[0] ?? { role: "" }).includes(VISIBLE));
		check("the degenerate tool call never reaches the message", !textOf(r.ends[0] ?? { role: "" }).includes("toolCall"));
		check("session continues on the same model (2 Codex requests, no fallback)", r.codexRequests === 2 && r.altContexts.length === 0 && r.model === "openai-codex/gpt-6-astra");
		check("turn completes", r.last?.stopReason === "stop" && !r.timedOut);
		check("committed text stays in history once and a resume reminder follows it", failedVisibleTurns(r.messages) === 1 && reminders(r.messages) === 1);
		check("continuation request carries the visible text exactly once", (codexBodies.at(-1) ?? "").split(VISIBLE).length - 1 === 1);
		check("no tool ran", r.probeRuns.length === 0);
	}

	console.log("\n[bounded-off] the loop repeats, flag off: 3 continuations, then the error surfaces with no fallback");
	{
		const r = await runCase("bounded-off", { behaviors: ["text-loop"], flag: false });
		console.log(`  ${summary(r)}`);
		check("4 Codex requests (1 + 3 stall continuations)", r.codexRequests === 4);
		check("no fallback model request and model unchanged", r.altContexts.length === 0 && r.model === "openai-codex/gpt-6-astra");
		check("final turn is the honest whitespace-loop error", r.last?.stopReason === "error" && LOOP_MESSAGE.test(r.last?.errorMessage ?? "") && !r.timedOut);
	}

	for (const transport of TRANSPORTS) {
		console.log(`\n[fallback-text/${transport}] the loop repeats after visible text, flag on: continuations spent, then the configured chain`);
		const r = await runCase(`fallback-text-${transport}`, { behaviors: ["text-loop"], flag: true, ws: transport === "ws" });
		console.log(`  ${summary(r)}`);
		check(`every Codex request used ${transport}`, r.transports.length > 0 && r.transports.every(t => t === transport), JSON.stringify(r.transports));
		const alt = r.altContexts[0] ?? [];
		check("same-model continuations spent first (4 Codex requests)", r.codexRequests === 4);
		check("switched to the configured fallback and finished there", r.altContexts.length === 1 && r.model === "fixture-alt/alt-model" && r.last?.stopReason === "stop" && !r.timedOut);
		check("fallback request keeps every committed failed turn and ends in a resume reminder", failedVisibleTurns(alt) === 4 && alt.at(-1)?.role === "developer" && textOf(alt.at(-1)!).includes(REMINDER));
		check("retry saga opened once and closed successfully", JSON.stringify(r.events) === JSON.stringify([{ type: "auto_retry_start", attempt: 1 }, { type: "auto_retry_end", attempt: 1, success: true }]), JSON.stringify(r.events));
		check("no tool ran", r.probeRuns.length === 0);
	}

	console.log("\n[replay-on] no visible output, flag on: retry budget on Astra, then the configured chain");
	{
		const r = await runCase("replay-on", { behaviors: ["loop"], flag: true, maxRetries: 1 });
		console.log(`  ${summary(r)}`);
		// Each session attempt is 3 provider requests: the provider's own 2 whitespace replays happen first.
		check("2 session attempts on Astra (6 Codex requests)", r.codexRequests === 6);
		check("then fallback finished the turn", r.altContexts.length === 1 && r.model === "fixture-alt/alt-model" && r.last?.stopReason === "stop" && !r.timedOut);
		check("failed thinking-only turns were replayed, not kept", (r.altContexts[0] ?? []).every(m => m.role !== "assistant"));
		check("retry events: two starts, one successful end", r.events.filter(e => e.type === "auto_retry_start").length === 2 && JSON.stringify(r.events.at(-1)) === JSON.stringify({ type: "auto_retry_end", attempt: 1, success: true }), JSON.stringify(r.events));
	}

	console.log("\n[replay-off] no visible output, flag off: bounded same-model retries, then an honest exhausted error");
	{
		const r = await runCase("replay-off", { behaviors: ["loop"], flag: false, maxRetries: 1 });
		console.log(`  ${summary(r)}`);
		check("2 session attempts on Astra (6 Codex requests), no fallback", r.codexRequests === 6 && r.altContexts.length === 0 && r.model === "openai-codex/gpt-6-astra");
		check("error reports the spent budget and the original cause", r.last?.stopReason === "error" && /Retry budget exhausted after 1 retry: Interrupted OpenAI Codex response/.test(r.last?.errorMessage ?? "") && !r.timedOut);
		check("retry saga closed unsuccessfully", r.events.at(-1)?.type === "auto_retry_end" && r.events.at(-1)?.success === false, JSON.stringify(r.events));
	}

	for (const transport of TRANSPORTS) {
		console.log(`\n[tool-then-loop/${transport}] a finished call, then the loop, flag off: preserved turn, nothing re-executed`);
		const r = await runCase(`tool-then-loop-${transport}`, { behaviors: ["tool-then-loop", "ok"], flag: false, ws: transport === "ws" });
		console.log(`  ${summary(r)}`);
		check(`every Codex request used ${transport}`, r.transports.length > 0 && r.transports.every(t => t === transport), JSON.stringify(r.transports));
		const results = r.messages.filter(m => m.role === "toolResult" && (m.toolCallId ?? "").includes("call_a_"));
		check("continuation after the failed turn (2 Codex requests) and the turn completes", r.codexRequests === 2 && r.last?.stopReason === "stop" && !r.timedOut);
		check("the finished call has exactly one result", results.length === 1, JSON.stringify(results.map(m => m.details)));
		check("the failed turn's call did not run twice", r.probeRuns.length <= 1 && (r.probeRuns.length === 0) === (results[0]?.details?.executed === false), `runs=${r.probeRuns.length}`);
	}

	console.log("\n[transport-denied] (control) visible text then an ordinary premature close, flag on: no fallback");
	{
		const r = await runCase("transport-denied", { behaviors: ["text-close"], flag: true });
		console.log(`  ${summary(r)}`);
		check("existing stall continuations only (4 Codex requests)", r.codexRequests === 4);
		check("ordinary transport error never walks the chain under fallbackOn usage-limit", r.altContexts.length === 0 && r.model === "openai-codex/gpt-6-astra" && r.last?.stopReason === "error" && !r.timedOut);
	}

	console.log("\n[quoted-denied] (boundary) a different error that quotes the breaker text, flag on: no fallback");
	{
		const r = await runCase("quoted-denied", { behaviors: ["text-quoted-fail"], flag: true });
		console.log(`  ${summary(r)}`);
		check("the failure is not the breaker error itself", r.ends[0]?.stopReason === "error" && !/^Interrupted OpenAI Codex response/.test(r.ends[0]?.errorMessage ?? ""), r.ends[0]?.errorMessage);
		check("only the breaker error may bypass fallbackOn usage-limit", r.altContexts.length === 0 && r.model === "openai-codex/gpt-6-astra" && r.last?.stopReason === "error" && !r.timedOut);
	}

	const breakerText = "Interrupted OpenAI Codex response after 256 consecutive whitespace-only tool-call argument delta events (839 chars, sequence 1990..2245) for item fc_fixture.";
	console.log("\n[suffix-denied] (boundary) breaker text followed by another failure, flag on: no fallback");
	{
		const r = await runCase("suffix-denied", { behaviors: ["ok"], flag: true, inject: `${breakerText.slice(0, -1)}; current failure: invalid_prompt` });
		console.log(`  ${summary(r)}`);
		check("not admitted: no stall continuation, no fallback", r.altContexts.length === 0 && r.model === "openai-codex/gpt-6-astra" && r.last?.stopReason === "error" && r.ends.length === 1 && !r.timedOut, `ends=${r.ends.length}`);
	}

	console.log("\n[text-only-denied] (boundary) the exact breaker text without the breaker class (errorId 0), flag on: no fallback");
	{
		const r = await runCase("text-only-denied", { behaviors: ["ok"], flag: true, inject: breakerText });
		console.log(`  ${summary(r)}`);
		check("not admitted without the class identity", r.altContexts.length === 0 && r.model === "openai-codex/gpt-6-astra" && r.last?.stopReason === "error" && r.ends.length === 1 && !r.timedOut, `ends=${r.ends.length}`);
	}

	console.log("\n[abort] (control) the user cancels during the loop, flag on: no retry, no fallback");
	{
		const r = await runCase("abort", { behaviors: ["text-slow-loop"], flag: true, abortAfterText: true });
		console.log(`  ${summary(r)}`);
		check("one Codex request, no fallback", r.codexRequests === 1 && r.altContexts.length === 0 && r.model === "openai-codex/gpt-6-astra");
		check("turn ends aborted with no reminder and no retry saga", r.last?.stopReason === "aborted" && reminders(r.messages) === 0 && r.events.length === 0 && !r.timedOut);
	}
} finally {
	server.stop(true);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAIL`}`);
process.exit(failures === 0 ? 0 : 1);
