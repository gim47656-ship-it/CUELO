// Run with OMP_CORE_PATCH_TARGET pointing at the isolated patched core used by CI.
// Exercise the real AgentSession, Google request builders and retry chain. No live auth or network.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const target = process.env.OMP_CORE_PATCH_TARGET;
assert(target, "OMP_CORE_PATCH_TARGET is required");
if (process.argv[2] !== "--isolated") {
	const root = mkdtempSync(join(tmpdir(), "omp-vertex-fallback-"));
	try {
		const result = Bun.spawnSync([process.execPath, import.meta.path, "--isolated"], {
			env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, "agent"),
				TMPDIR: root, TMP: root, TEMP: root, OMP_PROFILE: "", PI_PROFILE: "", GOOGLE_VERTEX_LOCATION: "global" },
			stdout: "inherit", stderr: "inherit",
		});
		process.exitCode = result.exitCode ?? 1;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
} else {
	// The core package path is selected by the test environment, not the repository imports.
	const core = resolve(target, "src").replaceAll("\\", "/");
	const pkgs = resolve(core, "../..").replaceAll("\\", "/");
	const { createAgentSession } = await import(`${core}/sdk.ts`);
	const { Settings } = await import(`${core}/config/settings.ts`);
	const { getBundledModel } = await import(`${pkgs}/pi-catalog/src/models.ts`);
	const { streamSimple } = await import(`${pkgs}/pi-ai/src/stream.ts`);
	const { createAssistantMessageEventStream } = await import(`${pkgs}/pi-ai/src/utils/event-stream.ts`);
	const vertex = getBundledModel("google-vertex", "gemini-4-hydrogen");
	const argon = getBundledModel("google-vertex", "gemini-4-argon");
	const google = getBundledModel("google", "gemini-3.5-flash");
	const fallback = "openai-codex/gpt-6.2-sol";
	const priorityHeader = "X-Vertex-AI-LLM-Shared-Request-Type";
	const fixtureKey = "vertex-test-key";
	// This quota description is retryable, not UsageLimit, in the unpatched core.
	const transientQuota = "Online prediction concurrent requests quota exceeded";
	const reject = (status: string, http = 429, message = transientQuota) => () => Response.json(
		{ error: { code: http, status, message } },
		{ status: http, headers: { "retry-after": "1" } },
	);
	const googleSuccess = () => new Response(`data: ${JSON.stringify({
		candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	})}\n\n`, { headers: { "content-type": "text/event-stream" } });

	async function scenario(
		name: string, model: typeof vertex, failure: () => Response, expected: string[],
		settings: { chain?: boolean; retry?: boolean; cooledFallback?: boolean } = {},
	) {
		const work = join(process.env.HOME!, name);
		const agentDir = join(work, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "models.yml"), `providers:
  google-vertex:
    apiKey: ${fixtureKey}
  google:
    apiKey: ${fixtureKey}
  openai-codex:
    baseUrl: http://127.0.0.1:9
    api: openai-codex-responses
    apiKey: ${fixtureKey}
    models:
      - id: gpt-6.2-sol
`);
		const primary = `${model.provider}/${model.id}`;
		const { session } = await createAgentSession({
			cwd: work, agentDir, model, getApiKey: () => fixtureKey, thinkingLevel: "off",
			toolNames: [], disableExtensionDiscovery: true, enableMCP: false, enableLsp: false,
			skipPythonPreflight: true, skills: [], rules: [], contextFiles: [],
			settings: Settings.isolated({
				"retry.enabled": settings.retry ?? true, "retry.maxRetries": 10, "retry.baseDelayMs": 1,
				"retry.fallbackOn": "usage-limit", "retry.fallbackRevertPolicy": "never",
				"retry.fallbackChains": { [primary]: settings.chain === false ? [] : [fallback] },
			}),
		});
		const requests: string[] = [];
		const tiers: Array<string | null> = [];
		const delays: number[] = [];
		session.subscribe((event: { type: string; delayMs?: number }) => {
			if (event.type === "auto_retry_start" && event.delayMs !== undefined) {
				delays.push(event.delayMs);
				if (settings.cooledFallback && delays.length === 1) session.modelRegistry.clearSuppressedSelector(fallback);
			}
		});
		session.agent.streamFn = (selected: typeof model, context: Parameters<typeof streamSimple>[1], options: Record<string, unknown>) => {
			const route = `${selected.provider}/${selected.id}`;
			if (route === fallback) {
				requests.push(route);
				const stream = createAssistantMessageEventStream();
				const message = { role: "assistant", api: selected.api, provider: selected.provider, model: selected.id,
					content: [{ type: "text", text: "FALLBACK_OK" }], stopReason: "stop", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
				return stream;
			}
			assert.equal(route, primary, "fixture must not call another network route");
			return streamSimple(selected, context, { ...options, apiKey: fixtureKey,
				fetch: async (url: string, request: RequestInit) => {
					requests.push(route);
					tiers.push(new Headers(request.headers).get(priorityHeader));
					if (selected.provider === "google-vertex") assert.equal(new URL(url).hostname, "aiplatform.googleapis.com");
					if (settings.cooledFallback && requests.length === 1) {
						session.modelRegistry.suppressSelector(fallback, Date.now() + 60_000);
					}
					return requests.length <= (settings.cooledFallback ? 2 : 1) ? failure() : googleSuccess();
				},
			});
		};
		try {
			await session.prompt("Reply OK.");
			await ("waitForRunEnd" in session ? session.waitForRunEnd() : session.waitForIdle());
			const settledModel = `${session.model?.provider}/${session.model?.id}`;
			const stopReason = session.getLastAssistantMessage()?.stopReason;
			console.log(JSON.stringify({ name, requests, tiers, delays, settledModel, stopReason }));
			assert.deepEqual(requests, expected);
			assert.deepEqual(tiers, expected.filter(route => route !== fallback).map(() => model === vertex ? "priority" : null));
			assert.equal(settledModel, expected.at(-1));
			assert.equal(stopReason, settings.retry === false ? "error" : "stop");
			if (settledModel === fallback) {
				assert.deepEqual(delays, settings.cooledFallback ? [1_000, 0] : [0], "fallback should not inherit a retry-after delay");
				await session.prompt("Reply again.");
				await ("waitForRunEnd" in session ? session.waitForRunEnd() : session.waitForIdle());
				assert.equal(requests.at(-1), fallback, "fallbackRevertPolicy: never must remain in effect");
			}
		} finally {
			await session.dispose();
		}
	}

	const h = `${vertex.provider}/${vertex.id}`;
	const a = `${argon.provider}/${argon.id}`;
	const g = `${google.provider}/${google.id}`;
	await scenario("vertex-429", vertex, reject("RESOURCE_EXHAUSTED"), [h, fallback]);
	await scenario("vertex-argon-429", argon, reject("RESOURCE_EXHAUSTED"), [a, fallback]);
	await scenario("vertex-429-no-chain", vertex, reject("RESOURCE_EXHAUSTED"), [h, h], { chain: false });
	await scenario("vertex-429-other-status", vertex, reject("UNAVAILABLE", 429, "Too many requests, please retry"), [h, h]);
	await scenario("vertex-503", vertex, reject("RESOURCE_EXHAUSTED", 503, "Service unavailable"), [h, h]);
	await scenario("google-other-provider", google, reject("RESOURCE_EXHAUSTED"), [g, g]);
	await scenario("google-socket-drop", google, () => { throw new Error("The socket connection was closed unexpectedly"); }, [g, g]);
	await scenario("vertex-retry-disabled", vertex, reject("RESOURCE_EXHAUSTED"), [h], { retry: false });
	await scenario("vertex-array-error", vertex, () => Response.json(
		[{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: transientQuota } }],
		{ status: 429, headers: { "retry-after": "1" } },
	), [h, fallback]);
	await scenario("vertex-cooldown-clears", vertex, reject("RESOURCE_EXHAUSTED"), [h, h, fallback], { cooledFallback: true });
	let explicitHeader: string | null | undefined;
	const explicitTier = await streamSimple(vertex, {
		messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }],
	}, {
		apiKey: fixtureKey, serviceTier: "flex",
		fetch: async (_url: string, request: RequestInit) => {
			explicitHeader = new Headers(request.headers).get(priorityHeader);
			return googleSuccess();
		},
	}).result();
	console.log(JSON.stringify({ name: "vertex-explicit-flex", header: explicitHeader }));
	assert.equal(explicitHeader, null);
	assert.equal(explicitTier.stopReason, "stop");
	console.log("11 Vertex priority/fallback scenarios passed");
}
