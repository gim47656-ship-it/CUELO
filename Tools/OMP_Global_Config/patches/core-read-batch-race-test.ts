// 같은 응답 묶음에서 형제 호출이 막 만들 파일을 read가 먼저 읽어 "not found"가 나던 회귀(2026-11-09 점검: 7일 read 경로 없음 23건 중 6건).
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-read-batch-race-test.ts
// 가짜 경계: provider 전송(fake stream)과 파일을 늦게 쓰는 형제 도구(인라인 확장, bash가 캡처를 쓰는 자리). 실제 경로: AgentSession →
// agent loop 묶음 스케줄러(concurrency) → 내장 ReadTool.
// 미증명: 실제 bash 도구 출력 타이밍, 디스크가 느린 NTFS 경로.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// SDK DB 핸들이 열려 있는 자식에서 지우지 않고, 종료를 기다린 부모가 이 실행의 fixture만 지운다. HOME/TEMP도 import 전에 격리한다.
if (!process.env.OMP_READ_RACE_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-read-race-fixture-"));
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
				OMP_READ_RACE_FIXTURE_ROOT: root,
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
if (!existsSync(join(CORE, "session/agent-session.ts"))) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
const PACKAGES = resolve(dirname(CORE), "..").replace(/\\/g, "/");
const fixtureRoot = process.env.OMP_READ_RACE_FIXTURE_ROOT!;
// 정적 import 불가: 대상 core 경로가 OMP_CORE_PATCH_TARGET 로 실행 시점에 정해진다.
const { setAgentDir } = await import(`${PACKAGES}/pi-utils/src/dirs.ts`);
setAgentDir(join(fixtureRoot, "home", ".omp", "agent"));
const { createAgentSession } = await import(`${CORE}/sdk.ts`);
const { createAssistantMessageEventStream } = await import(`${PACKAGES}/pi-ai/src/utils/event-stream.ts`);
const { getBundledModel } = await import(`${PACKAGES}/pi-catalog/src/models.ts`);
// 임시 agentDir의 ModelRegistry preflight만 통과시키는 비밀 아닌 placeholder다. fake stream이 전송을 대체한다.
process.env.OPENAI_API_KEY = "<probe>";
const model = getBundledModel("openai", "gpt-4o-mini");
assert.ok(model, "fake transport용 bundled model이 필요하다");

const usage = () => ({
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
type Call = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type ToolResult = { role: "toolResult"; toolCallId: string; isError?: boolean; content: Array<{ type: string; text?: string }> };

/** 한 묶음의 호출을 실제 AgentSession에서 돌리고 결과와 도구 시작·끝 시각을 돌려준다. */
async function runBatch(name: string, work: string, calls: Call[]) {
	const created = await createAgentSession({
		cwd: work,
		agentDir: join(fixtureRoot, `agent-${name}`),
		agentId: `ReadRace-${name}`,
		model,
		getApiKey: () => "example",
		toolNames: ["read", "make_file"],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		extensions: [
			(pi: { registerTool: (tool: unknown) => void }) => {
				pi.registerTool({
					name: "make_file",
					label: "Late writer fixture",
					loadMode: "essential",
					description: "Writes a file after a delay, like bash saving a capture",
					parameters: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"] },
					async execute(_id: string, params: { path: string; text: string }) {
						await Bun.sleep(60);
						writeFileSync(join(work, params.path), params.text);
						return { content: [{ type: "text", text: "written" }], details: {} };
					},
				});
			},
		] as never,
	});
	const session = created.session;
	let providerCalls = 0;
	session.agent.streamFn = (() => {
		const stream = createAssistantMessageEventStream();
		const turn = ++providerCalls;
		void (async () => {
			const content = turn === 1 ? calls : [{ type: "text" as const, text: "done" }];
			const message = {
				role: "assistant" as const, content,
				api: model.api, provider: model.provider, model: model.id,
				usage: usage(), stopReason: turn === 1 ? "toolUse" as const : "stop" as const, timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: message });
			if (turn === 1) {
				for (const [contentIndex, call] of calls.entries()) {
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
				}
			}
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
		})();
		return stream;
	}) as never;
	const spans = new Map<string, { start: number; end?: number }>();
	const unsubscribe = session.agent.subscribe((event: { type: string; toolCallId?: string }) => {
		if (event.type === "tool_execution_start") spans.set(event.toolCallId!, { start: performance.now() });
		if (event.type === "tool_execution_end") spans.get(event.toolCallId!)!.end = performance.now();
	});
	await session.prompt("파일을 만들고 읽어 줘");
	unsubscribe();
	const results = session.agent.state.messages.filter((m: { role: string }) => m.role === "toolResult") as ToolResult[];
	await session.dispose();
	return { results, spans };
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
}
const text = (r: ToolResult | undefined) => r?.content.map(part => part.text ?? "").join("\n") ?? "";

console.log("\n[race] 같은 묶음: make_file(60ms 뒤 쓰기) → read 같은 파일");
{
	const work = mkdtempSync(join(fixtureRoot, "race-"));
	const r = await runBatch("race", work, [
		{ type: "toolCall", id: "make", name: "make_file", arguments: { path: "capture.txt", text: "FRESH-CAPTURE", i: "Writing capture" } },
		{ type: "toolCall", id: "readNew", name: "read", arguments: { path: "capture.txt", i: "Reading capture" } },
	]);
	const read = r.results.find(m => m.toolCallId === "readNew");
	check("형제가 막 만든 파일을 read가 찾아 읽는다", read?.isError !== true && text(read).includes("FRESH-CAPTURE"), JSON.stringify(text(read).slice(0, 200)));
	check("그 read는 형제 호출이 끝난 뒤 시작한다", (r.spans.get("readNew")?.start ?? 0) >= (r.spans.get("make")?.end ?? Infinity), JSON.stringify([...r.spans]));
}

console.log("\n[parallel] 이미 있는 파일 두 개의 read는 지금처럼 겹쳐 돈다");
{
	const work = mkdtempSync(join(fixtureRoot, "parallel-"));
	writeFileSync(join(work, "a.txt"), "AAA");
	writeFileSync(join(work, "b.txt"), "BBB");
	const r = await runBatch("parallel", work, [
		{ type: "toolCall", id: "make", name: "make_file", arguments: { path: "late.txt", text: "x", i: "Writing late" } },
		{ type: "toolCall", id: "readA", name: "read", arguments: { path: "a.txt:1", i: "Reading a" } },
		{ type: "toolCall", id: "readB", name: "read", arguments: { path: "b.txt", i: "Reading b" } },
	]);
	check("있는 파일 read 두 건이 모두 성공한다", ["readA", "readB"].every(id => r.results.find(m => m.toolCallId === id)?.isError !== true));
	check("있는 파일 read는 늦게 쓰는 형제를 기다리지 않는다(형제가 끝나기 전에 시작)",
		(r.spans.get("readA")?.start ?? Infinity) < (r.spans.get("make")?.end ?? 0) && (r.spans.get("readB")?.start ?? Infinity) < (r.spans.get("make")?.end ?? 0),
		JSON.stringify([...r.spans]));
}

console.log("\n[missing] 끝까지 없는 경로는 기다린 뒤 원래 not-found 오류를 그대로 낸다");
{
	const work = mkdtempSync(join(fixtureRoot, "missing-"));
	const r = await runBatch("missing", work, [
		{ type: "toolCall", id: "readGone", name: "read", arguments: { path: "never.txt", i: "Reading never" } },
	]);
	const read = r.results.find(m => m.toolCallId === "readGone");
	check("없는 파일은 여전히 not found 오류다", read?.isError === true && /Path 'never\.txt' not found/.test(text(read)), JSON.stringify(text(read).slice(0, 200)));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
