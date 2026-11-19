// Run against a physical core. Every provider stream in this test is synthetic.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const core = process.env.OMP_CORE_PATCH_TARGET;
if (!core) throw new Error("OMP_CORE_PATCH_TARGET is required");
const fixture = await mkdtemp(join(tmpdir(), "cuelo-refusal-"));
const agentDir = join(fixture, "agent");
await mkdir(agentDir);
try {
	// The SDK target is runtime-selected so the fixture also works on the unpatched v19 baseline.
	const path = (file: string) => pathToFileURL(resolve(core, "src", file)).href;
	const { createAgentSession } = await import(path("sdk.ts"));
	const { Settings } = await import(path("config/settings.ts"));
	const { createAssistantMessageEventStream } = await import(path("../../pi-ai/src/utils/event-stream.ts"));
	const { getBundledModel } = await import(path("../../pi-catalog/src/models.ts"));
	const { SessionManager } = await import(path("session/session-manager.ts"));
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-6");
	assert.ok(bundled, "bundled fixture model");
	const model = { ...bundled, baseUrl: "http://127.0.0.1:9" };
	const selector = `${model.provider}/${model.id}`;
	const { session } = await createAgentSession({
		cwd: fixture,
		agentDir,
		model,
		getApiKey: () => "synthetic-fixture-only",
		thinkingLevel: "off",
		toolNames: [],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		sessionManager: SessionManager.create(fixture, fixture),
		settings: Settings.isolated({
			"retry.enabled": true, "retry.maxRetries": 2, "retry.baseDelayMs": 1,
			"retry.modelFallback": true, "retry.fallbackChains": { [selector]: ["anthropic/claude-opus-4-6"] },
			"compaction.enabled": false,
		}),
	});
	session.modelRegistry.authStorage.keys.setConfig("anthropic", "synthetic-fixture-only");
	const requests: string[] = [];
	let stop: string | undefined;
	session.agent.streamFn = (selected: typeof model) => {
		const stream = createAssistantMessageEventStream();
		requests.push(`${selected.provider}/${selected.id}`);
		const message = {
			role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(),
			content: [{ type: "text", text: stop ? "PARTIAL-STOPPED" : "FRESH-ANSWER" }],
			stopReason: stop ? "error" : "stop",
			stopDetails: stop === "classifier" ? { type: "refusal", category: "reasoning_extraction" } : undefined,
			errorMessage: stop === "classifier" ? "fixture provider safety refusal" : stop,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		queueMicrotask(() => {
			stream.push(stop ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message });
			stream.end(message);
		});
		return stream;
	};
	try {
		for (const error of ["classifier", "incomplete: content_filter"]) {
			stop = error;
			const before = requests.length;
			await session.prompt("Synthetic refusal fixture.");
			await session.waitForRunEnd();
			assert.deepEqual(requests.slice(before), [selector], `${error}: no same-model retry or alternate route`);
			assert.match(session.getLastAssistantMessage()?.errorMessage ?? "", /refusal|content_filter/);
			const branch = JSON.stringify(session.sessionManager.getBranch());
			assert.match(branch, /provider_refusal/);
			assert.match(branch, /Send a new message to continue/);
			const note = session.sessionManager.getBranch().findLast(entry => entry.type === "custom_message" && entry.customType === "cuelo-provider-safety-stop");
			assert.ok(note, "refusal notice persisted as a custom_message");
			assert.equal(await session.retry(), false, "retry cannot replay the refusal");
			await session.deliverIrcMessage({ id: "fixture-peer", from: "Peer", to: "Main", ts: Date.now(), body: "Peer follow-up." });
			await assert.rejects(() => session.followUp("Synthetic queued follow-up.", undefined, { synthetic: true }), /Send a new message/);
			await session.waitForIdle();
			await assert.rejects(() => session.resume(), /Send a new message/);
			await assert.rejects(() => session.prompt("synthetic continuation", { synthetic: true }), /Send a new message/);
			assert.equal(requests.length, before + 1);
			stop = undefined;
			await session.prompt("New human input for the fixture.");
			await session.waitForRunEnd();
			assert.deepEqual(requests.slice(before), [selector, selector]);
			const human = session.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user");
			assert.ok(human?.type === "message" && human.message.role === "user");
			assert.equal(human.message.attribution, "user");
			console.log(`${error}: stop entry=${note.type}/${note.customType}; fresh entry attribution=${human.message.attribution}; requests=${requests.length - before} (original and fresh only)`);
			assert.equal(session.getLastAssistantMessage()?.stopReason, "stop");
		}
		console.log("Classifier and content-filter stops retained their refusal records, blocked continuation, and accepted fresh human input.");
	} finally {
		await session.dispose();
		session.modelRegistry.authStorage.close();
	}
} finally {
	await rm(fixture, { recursive: true, force: true });
}
