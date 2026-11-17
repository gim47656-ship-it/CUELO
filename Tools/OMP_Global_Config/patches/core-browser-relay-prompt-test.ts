// ego lite PC의 브라우저 작업 기본은 별도 ego TaskSpace(2026-10-31 사용자 결정 「스페이스공간 따로 만들어서 그쪽에다 하는 건
// 기본으로 두자 하네스정책상」). 실행:
//   OMP_CORE_PATCH_TARGET=<patched-core copy> bun run patches/core-browser-relay-prompt-test.ts
import assert from "node:assert/strict";

const core = process.env.OMP_CORE_PATCH_TARGET;
if (!core) throw new Error("OMP_CORE_PATCH_TARGET required (scratch core only)");
const { createBrowserPreludeDefinition } = await import(`${core}/src/tools/browser/prelude-definition.ts`);
const { Settings } = await import(`${core}/src/config/settings.ts`);

const host = { invoke: async () => undefined, status: () => undefined };
// 18.22.1 reads browser settings through the config registry, so a bare object no longer stands in for Settings.
const session = { settings: Settings.isolated({}) };
const render = (relayFallback?: unknown): string | undefined =>
	createBrowserPreludeDefinition(session, { ...host, relayFallback }).guidance;

console.log("[2] connected 갈래는 cdpUrl 비밀을 가린다");
const connected = render({ kind: "connected", cdpUrl: "http://user:secret@127.0.0.1:9222/json?token=abc" })!;
assert.ok(!connected.includes("secret") && !connected.includes("abc"), "userinfo and token stay redacted");
console.log("  PASS");

console.log("[3] relay가 꺼지면 relay 안내가 없다");
// 18.22.1 always sends the user-session safety block; only the relay section depends on a relay fallback.
const userSession = Bun.file(`${core}/src/prompts/system/browser-user-session.md`);
if (await userSession.exists()) {
	const relayLead = (await Bun.file(`${core}/src/prompts/system/browser-relay.md`).text()).split("\n").find(line => line.trim())!;
	const off = render(undefined)!;
	assert.ok(off.startsWith("# Browser user sessions") && !off.includes(relayLead.trim()), "safety block only, no relay section");
} else {
	assert.equal(render(undefined), undefined);
}
console.log("  PASS");
