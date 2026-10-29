// Gemini 도구 스키마 토큰 추정(doc/history/2026/10/29-recall-bottlenecks). 실행:
//   OMP_CORE_PATCH_TARGET=<patched-core copy> bun run patches/core-tool-schema-prune-test.ts
// pruning applies only to native wire specs; owned dialects carry full definitions in-band.
// 추정(상태줄·압축 기준·응답에 기록하는 toolSchemaTokens)도 그 wire 와 같아야 하고, 꺼진 세션은 /context 의 도구 항목 합과 같은 옛 값 그대로다.
// 네트워크·`~/.omp` 접근 없음(임시 HOME, 가짜 키, 요청 없음). 동적 import 는 OMP_CORE_PATCH_TARGET 이 고른 core 사본을 읽기 위해서다.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET required (scratch core only)");
const root = mkdtempSync(join(tmpdir(), "tool-schema-prune-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.HOME = root;
const core = resolve(target, "src");
const { setAgentDir } = await import(`${core}/../../pi-utils/src/dirs.ts`);
setAgentDir(root);
const { createAgentSession, resolveDialect } = await import(`${core}/sdk.ts`);
const { Settings } = await import(`${core}/config/settings.ts`);
const { getBundledModel } = await import(`${core}/../../pi-catalog/src/models.ts`);
const { normalizeTools } = await import(`${core}/../../pi-agent-core/src/agent-loop.ts`);
const { SessionStatsTracker } = await import(`${core}/session/session-stats.ts`);
const usage = await import(Bun.resolveSync("@oh-my-pi/pi-tui/status-line/context-usage", core));
const { cfgToolsFormat } = await import(`${core}/session/context-settings.ts`);
const { cfgInlineToolDescriptors } = await import(`${core}/session/settings.ts`);
const { buildSessionContextView } = await import(`${core}/session/context-view.ts`);
const { createAssistantMessageEventStream } = await import(`${core}/../../pi-ai/src/utils/event-stream.ts`);
const { renderInbandToolPrompt } = await import(`${core}/../../pi-ai/src/dialect/index.ts`);

type WireTool = { name: string; description: string; parameters: unknown };
const open = async (provider: string, id: string) =>
	(
		await createAgentSession({
			cwd: root, agentDir: root, bindProcessState: false,
			model: getBundledModel(provider, id), getApiKey: () => "fixture",
			settings: Settings.isolated({}), enableMCP: false, enableLsp: false,
			skipPythonPreflight: true, disableExtensionDiscovery: true,
			skills: [], rules: [], contextFiles: [], toolNames: ["read", "bash", "edit", "grep"],
		})
	).session;

try {
	// ── Gemini: pruned wire ────────────────────────────────────────────────
	const gemini = await open("google", "gemini-4-argon");
	try {
		const tokenizer = gemini.agent.tokenizer;
		const tools = gemini.agent.state.tools;
		const rev = gemini.settings.revision;
		assert.equal(gemini.agent.pruneToolDescriptions, true, "fixture: Gemini session prunes wire tool descriptions");
		const wire = (prune: boolean) =>
			tokenizer.countTokens(
				(normalizeTools(tools, { injectIntent: false, pruneDescriptions: prune }) as WireTool[]).flatMap(t =>
					[t.name, t.description, JSON.stringify(t.parameters)].filter(s => s !== ""),
				),
			);
		const wirePruned = wire(true);
		assert.ok(wirePruned < wire(false) / 2, `fixture: descriptions dominate the full spec (${wirePruned} vs ${wire(false)})`);

		const breakdown = usage.computeNonMessageBreakdown(gemini, tokenizer, rev);
		assert.equal(breakdown.toolsTokens, wirePruned, "pruned estimate counts what the wire carries (name + description-stripped schema)");
		assert.equal(
			usage.computeNonMessageTokens(gemini, tokenizer, rev),
			tokenizer.countTokens(gemini.systemPrompt) + wirePruned,
			"non-message total = system prompt (holds the inlined catalog) + pruned schemas, no double count",
		);

		// The tokens recorded with each response must use the same basis as nonMessageTokens.
		const tracker = new SessionStatsTracker({ session: gemini, agent: gemini.agent } as never);
		assert.equal(tracker.nonMessageSnapshot().toolSchemaTokens, wirePruned, "recorded toolSchemaTokens follows the pruned wire");

		// The roster cache is keyed on the prune flag, so the same roster and tokenizer answer both ways.
		const model = gemini.model;
		const full = usage.estimateContextToolSchemaTokens(tools, tokenizer, model, rev, false);
		assert.equal(usage.estimateContextToolSchemaTokens(tools, tokenizer, model, rev, true), wirePruned, "pruned after full on one roster");
		assert.equal(usage.estimateContextToolSchemaTokens(tools, tokenizer, model, rev, false), full, "full again after pruned");
		assert.ok(full > wirePruned);

		// A model switch that turns pruning off must not reuse the pruned non-message total.
		gemini.agent.pruneToolDescriptions = false;
		assert.equal(usage.computeNonMessageBreakdown(gemini, tokenizer, rev).toolsTokens, full, "prune flag change invalidates the cached breakdown");
		assert.equal(usage.computeNonMessageTokens(gemini, tokenizer, rev), tokenizer.countTokens(gemini.systemPrompt) + full);
		console.log(JSON.stringify({ model: "google/gemini-4-argon", pruned: wirePruned, full }));
	} finally {
		await gemini.dispose();
	}

	// ── Claude: not pruned, estimate unchanged ────────────────────────────
	const claude = await open("anthropic", "claude-opus-5-5");
	try {
		const tokenizer = claude.agent.tokenizer;
		const tools = claude.agent.state.tools;
		assert.equal(claude.agent.pruneToolDescriptions, false, "fixture: Claude session sends descriptions on the wire");
		// /context lists each tool with toolSchemaFragments; without pruning the category total is their sum, as before.
		const perTool = tokenizer.countTokens(tools.flatMap((tool: never) => usage.toolSchemaFragments(tool).fragments));
		assert.equal(usage.computeNonMessageBreakdown(claude, tokenizer, claude.settings.revision).toolsTokens, perTool);
		const tracker = new SessionStatsTracker({ session: claude, agent: claude.agent } as never);
		assert.equal(tracker.nonMessageSnapshot().toolSchemaTokens, perTool);
		console.log(JSON.stringify({ model: "anthropic/claude-opus-5-5", estimate: perTool }));
	} finally {
		await claude.dispose();
	}
	// Exercise the real agent loop with a local stream, never a provider request.
	const dialectSession = await open("google", "gemini-4-argon");
	const originalEnv = process.env.PI_DIALECT;
	try {
		const agent = dialectSession.agent;
		const nativeModel = agent.state.model;
		const tokenizer = agent.tokenizer;
		const tools = agent.state.tools;
		let sent: { tools?: WireTool[]; systemPrompt?: string[] } | undefined;
		agent.streamFn = (model: { api: string; provider: string; id: string }, context: typeof sent) => {
			sent = context;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		};
		let failed = 0;
		for (const [label, format, native, rawPrune, owned] of [
			["native-pruned", "native", true, true, false],
			["explicit-owned", "glm", true, true, true],
			["auto-nonnative", "auto", false, true, true],
			["auto-native-again", "auto", true, true, false],
			["native-full", "native", true, false, false],
			["environment-owned", "native", true, true, true],
		] as const) {
			try {
				delete process.env.PI_DIALECT;
				if (label === "environment-owned") process.env.PI_DIALECT = "glm";
				cfgToolsFormat.set(dialectSession.settings, format);
				cfgInlineToolDescriptors.set(dialectSession.settings, rawPrune ? "on" : "off");
				agent.setModel({ ...nativeModel, supportsTools: native });
				agent.pruneToolDescriptions = rawPrune;
				agent.clearMessages();
				await agent.prompt("local wire probe");
				const pruned = rawPrune && !owned;
				const wire = normalizeTools(tools, { injectIntent: agent.intentTracing, pruneDescriptions: pruned });
				if (owned) {
					assert.equal(sent?.tools, undefined);
					assert(sent?.systemPrompt?.includes(renderInbandToolPrompt(wire, resolveDialect(format, agent.state.model) ?? "glm")), "actual loop sends full in-band definitions");
				} else {
					const spec = (entries: WireTool[] | undefined) => entries?.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
					assert.deepEqual(spec(sent?.tools), spec(wire), "actual loop native definitions match expected pruning");
				}
				const expected = usage.estimateContextToolSchemaTokens(tools, tokenizer, agent.state.model, dialectSession.settings.revision, pruned);
				const actual = usage.computeNonMessageBreakdown(dialectSession, tokenizer, dialectSession.settings.revision).toolsTokens;
				assert.equal(actual, expected, `${label}: aggregate follows wire dialect`);
				assert.equal(new SessionStatsTracker({ session: dialectSession, agent } as never).nonMessageSnapshot().toolSchemaTokens, expected);
				const view = buildSessionContextView(dialectSession);
				const toolEntries = view.categories.filter((c: { id: string }) => ["built-in-tools", "custom-tools"].includes(c.id)).flatMap((c: { entries: Array<{ tokens: number }> }) => c.entries);
				const perTool = tools.reduce((sum: number, tool: never) => sum + usage.estimateToolSchemaTokens([tool], tokenizer, 0, pruned), 0);
				assert.equal(toolEntries.reduce((sum: number, e: { tokens: number }) => sum + e.tokens, 0), perTool, `${label}: context-view follows wire`);
				console.log(JSON.stringify({ label, rawPrune, owned, actual, expected }));
			} catch (error) { failed++; console.error(`FAIL ${label}: ${error}`); }
		}
		assert.equal(failed, 0, "all real-loop dialect scenarios match estimates");
	} finally {
		if (originalEnv === undefined) delete process.env.PI_DIALECT; else process.env.PI_DIALECT = originalEnv;
		await dialectSession.dispose();
	}
	console.log("PASS core-tool-schema-prune-test");
} finally {
	rmSync(root, { recursive: true, force: true });
}
