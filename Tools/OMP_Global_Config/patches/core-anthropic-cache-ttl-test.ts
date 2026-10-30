// Anthropic API 키 경로도 프롬프트 캐시 1시간(2026-10-31 사용자 결정 "API 키도 1시간 캐시"). 실행:
//   OMP_CORE_PATCH_TARGET=<patched-core copy> bun run patches/core-anthropic-cache-ttl-test.ts
// 로컬 HTTP fixture 가 실제 요청의 anthropic-beta 헤더와 본문 cache_control 을 읽는다. cache warmer 의 tier 도 같은 답이어야 한다.
// [1] API 키 + 1시간 보존 지원 모델: ttl 1h, extended-cache-ttl beta 있음, warmer long.
// [2] OAuth: ttl 1h 그대로, beta 없음(OAuth 는 beta 없이 1h 를 받는다).
// [3] 1시간 보존 미지원 모델: ttl 없음(5분), beta 없음, warmer short.
// [4] 명시 cacheRetention "short" 와 PI_CACHE_RETENTION=short 는 여전히 이긴다: ttl 없음, beta 없음.
// [5] beta 를 거절하는 경로(compat.extendedCacheTtlBeta: false): ttl 1h, beta 없음.
// 네트워크·`~/.omp` 접근 없음(임시 폴더, 127.0.0.1 fixture).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const core = process.env.OMP_CORE_PATCH_TARGET;
if (!core) throw new Error("OMP_CORE_PATCH_TARGET required (scratch core only)");
const ai = `${core}/../pi-ai/src`;
const { streamAnthropic } = await import(`${ai}/providers/anthropic.ts`);
const { getBundledModel } = await import(`${core}/../pi-catalog/src/models.ts`);
const { resolvePromptCacheTier } = await import(`${core}/src/session/cache-warmer.ts`);
const { setAgentDir } = await import(`${core}/../pi-utils/src/dirs.ts`);
const temp = mkdtempSync(join(tmpdir(), "cache-ttl-"));
setAgentDir(join(temp, "agent"));
const BETA = "extended-cache-ttl-2025-04-11";

let last: { betas: string[]; ttls: (string | undefined)[] } | undefined;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const body = await request.json();
		const ttls: (string | undefined)[] = [];
		const walk = (value: unknown) => {
			if (Array.isArray(value)) return value.forEach(walk);
			if (!value || typeof value !== "object") return;
			for (const [key, child] of Object.entries(value)) {
				if (key === "cache_control") ttls.push(child && typeof child === "object" && "ttl" in child && typeof child.ttl === "string" ? child.ttl : undefined);
				else walk(child);
			}
		};
		walk(body);
		last = { betas: (request.headers.get("anthropic-beta") ?? "").split(",").map(beta => beta.trim()), ttls };
		const events = [
			{ type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
			{ type: "message_stop" },
		];
		return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	},
});
const bundled = getBundledModel("anthropic", "claude-opus-5-5");
const model = { ...bundled, baseUrl: `http://127.0.0.1:${server.port}` };
assert.equal(model.compat.supportsLongCacheRetention, true, "fixture model supports 1h retention");

async function send(target: typeof model, apiKey: string, options: Record<string, unknown> = {}) {
	last = undefined;
	const result = await streamAnthropic(target, { systemPrompt: "fixture", messages: [{ role: "user", content: "cache ttl probe", timestamp: Date.now() }] }, {
		apiKey, maxTokens: 32, maxRetries: 0, ...options,
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.ok(last && last.ttls.length > 0, "the request carries cache breakpoints");
	return last;
}
const API_KEY = "fixture-api";
const OAUTH = "sk-ant-oat01-fixture";

try {
	console.log("[1] API 키 + 1시간 보존 지원 모델: ttl 1h 와 beta");
	let seen = await send(model, API_KEY);
	assert.deepEqual([...new Set(seen.ttls)], ["1h"], "every API-key breakpoint asks for the 1h tier");
	assert.ok(seen.betas.includes(BETA), "the API-key request carries the extended-cache-ttl beta");
	assert.equal(resolvePromptCacheTier(model, undefined, false), "long", "the warmer agrees with the request");

	console.log("[2] OAuth: ttl 1h, beta 없음");
	seen = await send(model, OAUTH);
	assert.deepEqual([...new Set(seen.ttls)], ["1h"], "OAuth keeps the 1h tier");
	assert.ok(!seen.betas.includes(BETA), "OAuth never adds the beta");
	assert.equal(resolvePromptCacheTier(model, undefined, true), "long");

	console.log("[3] 1시간 보존 미지원 모델: 5분");
	const shortOnly = { ...model, compat: { ...model.compat, supportsLongCacheRetention: false } };
	seen = await send(shortOnly, API_KEY);
	assert.deepEqual([...new Set(seen.ttls)], [undefined], "no ttl means the 5m default");
	assert.ok(!seen.betas.includes(BETA));
	assert.equal(resolvePromptCacheTier(shortOnly, undefined, false), "short");

	console.log("[4] 명시 short 와 PI_CACHE_RETENTION=short 가 이긴다");
	seen = await send(model, API_KEY, { cacheRetention: "short" });
	assert.deepEqual([...new Set(seen.ttls)], [undefined], "explicit short keeps 5m");
	assert.ok(!seen.betas.includes(BETA));
	assert.equal(resolvePromptCacheTier(model, { cacheRetention: "short" }, false), "short");
	process.env.PI_CACHE_RETENTION = "short";
	try {
		seen = await send(model, API_KEY);
		assert.deepEqual([...new Set(seen.ttls)], [undefined], "PI_CACHE_RETENTION=short keeps 5m");
		assert.equal(resolvePromptCacheTier(model, undefined, false), "short");
	} finally {
		delete process.env.PI_CACHE_RETENTION;
	}

	console.log("[5] beta 를 거절하는 경로: ttl 1h, beta 없음");
	const noBeta = { ...model, compat: { ...model.compat, extendedCacheTtlBeta: false } };
	seen = await send(noBeta, API_KEY);
	assert.deepEqual([...new Set(seen.ttls)], ["1h"]);
	assert.ok(!seen.betas.includes(BETA), "a route that refuses the beta never receives it");
	console.log("PASS core-anthropic-cache-ttl-test");
} finally {
	server.stop(true);
	rmSync(temp, { recursive: true, force: true });
}
