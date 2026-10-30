// ego lite PC의 브라우저 작업 기본은 별도 ego TaskSpace(2026-10-31 사용자 결정 「스페이스공간 따로 만들어서 그쪽에다 하는 건
// 기본으로 두자 하네스정책상」). 실행:
//   OMP_CORE_PATCH_TARGET=<patched-core copy> bun run patches/core-browser-relay-prompt-test.ts
// relay가 켜진 세션에 실리는 browser 안내(prompts/system/browser-relay.md)를 코어가 실제로 렌더한 결과로 본다.
// [1] relay 뒤 대체 경로 네 갈래(headless·connected·tern·cmux) 모두 TaskSpace 문장이 한 번 실리고, 갈래별 기존 문장은 그대로다.
// [2] connected 갈래는 cdpUrl의 사용자 정보·토큰을 여전히 가린다. 템플릿 괄호가 남지 않는다.
// [3] relay가 꺼져 대체 경로가 없으면 안내 자체가 없다(이전과 같음).
// [4] system-prompt # 5. Verify 의 웹 줄(browserEnabled 갈래)은 ego lite PC에서 ego TaskSpace(`ego_browser`, 검증 프로필)를 먼저 알리고
//     그 밖에는 `browser.open` 문구를 그대로 둔다. Main·subagent 렌더 모두 같고, browser 가 꺼지면 줄이 없다.
import assert from "node:assert/strict";

const core = process.env.OMP_CORE_PATCH_TARGET;
if (!core) throw new Error("OMP_CORE_PATCH_TARGET required (scratch core only)");
const { createBrowserPreludeDefinition } = await import(`${core}/src/tools/browser/prelude-definition.ts`);
const { prompt } = await import(`${core}/../pi-utils/src/index.ts`);

const SENTENCE =
	"Where ego lite is installed (the `ego_browser` tool runs), browser work, headless checks included, runs in its own ego TaskSpace through `ego_browser`; use `browser.open` through the relay only for a tab the user named, passing it as `app.target`.";
const host = { invoke: async () => undefined, status: () => undefined };
const session = { settings: {} };
const render = (relayFallback?: unknown): string | undefined =>
	createBrowserPreludeDefinition(session, { ...host, relayFallback }).guidance;

console.log("[1] 대체 경로 네 갈래 모두 TaskSpace 문장 + 갈래별 기존 문장");
const branches: [string, unknown, string][] = [
	["headless", { kind: "headless", headless: true }, "Pass `app: { relay: false }` for a throwaway managed browser."],
	["connected", { kind: "connected", cdpUrl: "http://user:secret@127.0.0.1:9222/json?token=abc" }, "Pass `app: { relay: false }` to open in the browser at `browser.cdpUrl`"],
	["tern", { kind: "tern" }, "Pass `app: { relay: false }` for omp's own Tern picture-in-picture instead."],
	["cmux", { kind: "cmux" }, "Pass `app: { relay: false }` for omp's own cmux browser surface instead."],
];
for (const [name, fallback, branchText] of branches) {
	const text = render(fallback);
	assert.ok(text, `${name}: relay guidance is rendered`);
	assert.ok(text.includes("The browser relay is on: `browser.open` without `app` drives the user's own Chrome"), `${name}: relay sentence kept`);
	assert.ok(text.includes(branchText), `${name}: its own fallback sentence is kept`);
	assert.equal(text.split(SENTENCE).length - 1, 1, `${name}: the ego TaskSpace sentence appears exactly once`);
	assert.ok(!text.includes("{{"), `${name}: no template braces left`);
	console.log(`  PASS ${name}`);
}

console.log("[2] connected 갈래는 cdpUrl 비밀을 가린다");
const connected = render(branches[1]![1])!;
assert.ok(!connected.includes("secret") && !connected.includes("abc"), "userinfo and token stay redacted");
console.log("  PASS");

console.log("[3] relay가 꺼지면 안내가 없다");
assert.equal(render(undefined), undefined);
console.log("  PASS");

console.log("[4] system-prompt Verify 웹 줄");
const WEB =
	"  - Web: on an ego lite PC (the `ego_browser` tool runs), an ego TaskSpace via `ego_browser` (`profile: \"verify\"` for CUELO screens); elsewhere `browser.open` tab, direct helpers for actions, `tab.run` for custom JS; visual proof; `tab.close`. No tests unless existing suite breaks.";
const template = await Bun.file(`${core}/src/prompts/system/system-prompt.md`).text();
for (const subagent of [false, true]) {
	const on = prompt.render(template, { browserEnabled: true, subagent });
	assert.equal(on.split(WEB).length - 1, 1, `subagent=${subagent}: the ego-aware web line renders exactly once`);
	assert.ok(!on.includes("  - Web: `browser.open` tab"), `subagent=${subagent}: the browser.open-only web line is gone`);
	const off = prompt.render(template, { browserEnabled: false, subagent });
	assert.ok(!off.includes("  - Web:"), `subagent=${subagent}: no web line without the browser`);
	console.log(`  PASS subagent=${subagent}`);
}
