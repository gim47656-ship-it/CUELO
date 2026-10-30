// eval 코드의 MCP 접근(`mcp` prelude) 실제 AgentSession + 실제 stdio MCP transport + 실제 eval worker 회귀.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-mcp-eval-test.ts
// 모델은 fake stream이고 요청별 MCP 선택은 CUELO 확장(mcp-selection.ts)에 결정적 판정기를 넣어 돌린다. MCP 서버는 이
// 테스트가 만든 로컬 stdio stub이며 spawn·tools/call마다 로그 한 줄을 남긴다.
// 미패치 core에서는 eval 안에 `mcp` 전역이 없어 [1]부터 실패(RED)한다.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (!process.env.OMP_MCP_EVAL_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-mcp-eval-"));
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
				OMP_MCP_EVAL_FIXTURE_ROOT: root,
			},
			stdout: "inherit",
			stderr: "inherit",
		});
		exitCode = child.exitCode ?? 1;
	} finally {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {}
	}
	process.exit(exitCode);
}

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live core");
const CORE = resolve(target, "src").replace(/\\/g, "/");
if (!existsSync(join(CORE, "eval/preludes.ts"))) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
const PACKAGES = resolve(dirname(CORE), "..").replace(/\\/g, "/");
const fixtureRoot = process.env.OMP_MCP_EVAL_FIXTURE_ROOT!;
const agentDir = join(fixtureRoot, "home", ".omp", "agent");
const { setAgentDir } = await import(`${PACKAGES}/pi-utils/src/dirs.ts`);
setAgentDir(agentDir);
mkdirSync(agentDir, { recursive: true });

// 런타임 선택 경로라 정적 import가 불가능하다(OMP_CORE_PATCH_TARGET 사본만 검증).
const { createAgentSession } = await import(`${CORE}/sdk.ts`);
const { createAssistantMessageEventStream } = await import(`${PACKAGES}/pi-ai/src/utils/event-stream.ts`);
const { getBundledModel } = await import(`${PACKAGES}/pi-catalog/src/models.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
const { createMCPToolName } = await import(`${CORE}/mcp/tool-bridge.ts`);
const { createMcpSelection } = await import(
	resolve(import.meta.dir, "../agent/extensions/mcp-selection.ts").replace(/\\/g, "/")
);
// 비밀 아닌 placeholder. fake stream이 provider transport를 대체한다.
process.env.OPENAI_API_KEY = "<probe>";
const model = getBundledModel("openai", "gpt-4o-mini");
assert.ok(model, "fake transport용 bundled model이 필요하다");

// ---------------------------------------------------------------------------
// 로컬 stdio MCP stub: tool 1개. 시작마다 "spawn <name>", tools/call마다 "call <name>"을 로그에 남긴다.
// tools/call은 큰 원문(PAYLOAD 표지)과 structuredContent를 돌려준다. 코드가 걸러 출력한 것만 대화에 남는지 본다.
// ---------------------------------------------------------------------------
const log = join(fixtureRoot, "mcp.log");
writeFileSync(log, "");
const stubPath = join(fixtureRoot, "stub-mcp.ts");
writeFileSync(
	stubPath,
	`import { appendFileSync } from "node:fs";
const [name, log, tool] = process.argv.slice(2);
appendFileSync(log, "spawn " + name + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		const request = JSON.parse(line);
		if (request.id === undefined) continue;
		const reply = result => send({ jsonrpc: "2.0", id: request.id, result });
		if (request.method === "initialize") reply({ protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } });
		else if (request.method === "tools/list") reply({ tools: [{ name: tool, description: "Fetch rows from the " + name + " table.", inputSchema: { type: "object", properties: { limit: { type: "number" } } } }] });
		else if (request.method === "tools/call") {
			appendFileSync(log, "call " + name + "\\n");
			const limit = Number(request.params?.arguments?.limit ?? 3);
			const rows = Array.from({ length: limit }, (_, i) => ({ id: i + 1, note: "PAYLOAD-" + name + "-" + (i + 1) }));
			reply({ content: [{ type: "text", text: JSON.stringify(rows) }], structuredContent: { rows } });
		}
		else if (request.method === "ping") reply({});
		else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } });
	}
});
`,
);
const stub = (name: string, tool: string, extra: Record<string, unknown> = {}) => ({
	command: process.execPath,
	args: [stubPath, name, log, tool],
	...extra,
});
const logLines = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
const count = (line: string) => logLines().filter(item => item === line).length;

const work = join(fixtureRoot, "work");
mkdirSync(join(work, ".omp"), { recursive: true });
writeFileSync(
	join(work, ".omp", "mcp.json"),
	JSON.stringify({
		mcpServers: {
			"data-stub": stub("data-stub", "fetch_rows"),
			"off-stub": stub("off-stub", "fetch_rows", { enabled: false }),
		},
	}),
);

// ---------------------------------------------------------------------------
// fake provider + 결정적 판정기(어떤 서버도 필요 없다고 답한다)
// ---------------------------------------------------------------------------
const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
type ProviderContext = { systemPrompt?: unknown; messages: unknown[]; tools?: Array<{ name: string; description?: string }> };
type Step = { tool?: { name: string; args: Record<string, unknown> } };

function fakeStream(steps: Step[], seen: ProviderContext[]) {
	let index = 0;
	return (_model: unknown, context: ProviderContext) => {
		const stream = createAssistantMessageEventStream();
		const step = steps[index++];
		queueMicrotask(() => {
			if (!step) {
				stream.fail(new Error(`unexpected provider call #${index}`));
				return;
			}
			seen.push(
				structuredClone({
					systemPrompt: context.systemPrompt,
					messages: context.messages,
					tools: context.tools?.map(tool => ({ name: tool.name, description: tool.description })),
				}),
			);
			const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, usage: usage(), timestamp: Date.now() };
			if (step.tool) {
				const toolCall = { type: "toolCall" as const, id: `call-${index}`, name: step.tool.name, arguments: step.tool.args };
				const message = { ...base, content: [toolCall], stopReason: "toolUse" as const };
				stream.push({ type: "start", partial: message });
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
			} else {
				const message = { ...base, content: [{ type: "text" as const, text: "ok" }], stopReason: "stop" as const };
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			}
			stream.end();
		});
		return stream;
	};
}
// 판정 실패 스위치: 켜면 판정기가 실패해 선택 확장이 결정 없이 돌아온다(기존 노출 유지 경로).
const judgeFails = { on: false };
let judgeCalls = 0;
const notNeeded = async () => ({
	judge: async (request: { state: { servers: Array<{ id: string }> } }) => {
		judgeCalls++;
		if (judgeFails.on) throw new Error("judge provider unavailable");
		return { answers: Object.fromEntries(request.state.servers.map(server => [server.id, { type: "choice", choice: "not-needed" }])) };
	},
});

async function open(options: { settings?: Record<string, unknown>; enableMCP?: boolean; mcpManager?: unknown } = {}) {
	return createAgentSession({
		cwd: work,
		agentDir,
		settings: Settings.isolated({ "mcp.selection": "per-request", ...options.settings }),
		model,
		getApiKey: () => "example",
		hasUI: false,
		disableExtensionDiscovery: true,
		extensions: [createMcpSelection({ agentDir, resolveJudge: notNeeded })],
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		...(options.enableMCP === false ? { enableMCP: false } : {}),
		...(options.mcpManager ? { mcpManager: options.mcpManager } : {}),
	});
}
/** 한 요청: 첫 provider 호출이 eval cell을 부르고, 두 번째 호출이 끝낸다. 각 호출의 context를 돌려준다. */
async function evalTurn(session: { agent: { streamFn: unknown }; prompt(text: string): Promise<unknown> }, prompt: string, language: "js" | "py", code: string) {
	const seen: ProviderContext[] = [];
	session.agent.streamFn = fakeStream([{ tool: { name: "eval", args: { language, code } } }, {}], seen) as never;
	await session.prompt(prompt);
	return seen;
}
async function plainTurn(session: { agent: { streamFn: unknown }; prompt(text: string): Promise<unknown> }, prompt: string) {
	const seen: ProviderContext[] = [];
	session.agent.streamFn = fakeStream([{}], seen) as never;
	await session.prompt(prompt);
	return seen;
}
/** MCP 도구는 top-level 도구나 system prompt·대화 안의 xd:// 장치 목록으로 모델에 보인다. 셋 모두에서 이름을 찾는다. */
const mcpNames = (context: ProviderContext | undefined) => {
	if (!context) return [];
	const text = JSON.stringify([context.systemPrompt, context.tools ?? [], context.messages]);
	return [...new Set(text.match(/mcp__[A-Za-z0-9_-]+/g) ?? [])].sort();
};
/** 마지막 eval tool 결과 본문(대화에 실제로 들어간 것). */
const evalOutput = (context: ProviderContext | undefined) => {
	const results = (context?.messages ?? []).filter(
		(message): message is { role: string; toolName?: string; content: Array<{ type: string; text?: string }> } =>
			typeof message === "object" && message !== null && (message as { role?: string }).role === "toolResult",
	);
	return (results.at(-1)?.content ?? []).map(block => block.text ?? "").join("");
};
const marked = (text: string, mark: string) => {
	const line = text.split("\n").find(item => item.includes(mark));
	return line ? JSON.parse(line.slice(line.indexOf(mark) + mark.length)) : undefined;
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail: unknown = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
	}
}
const evidence: Record<string, unknown> = {};

// [1] 요청별 선택: MCP가 필요 없는 요청. 모델 도구 목록에는 MCP가 없지만 eval cell은 서버를 찾고 도구를 불러 결과를 코드에서 쓴다.
const a = await open();
check("[1a] 시작 직후 MCP 프로세스 0", logLines().length === 0, logLines());
const listCode = `
const before = await mcp.servers();
const tools = await mcp.tools("data-stub");
const result = await mcp.call("data-stub", "fetch_rows", { limit: 40 });
const after = await mcp.servers();
console.log("RESULT=" + JSON.stringify({
	before: before.map(s => ({ name: s.name, status: s.status, exposed: s.exposed })),
	after: after.map(s => ({ name: s.name, status: s.status, exposed: s.exposed })),
	tools: tools.map(t => ({ name: t.name, schema: Object.keys(t.inputSchema?.properties ?? {}) })),
	isError: result.isError,
	rows: result.structured.rows.length,
	lastId: result.structured.rows.at(-1).id,
}));
`;
const [first, second] = await evalTurn(a.session, "README 오타만 고쳐줘", "js", listCode);
const out1 = evalOutput(second);
const r1 = marked(out1, "RESULT=");
evidence.evalOutput = out1;
evidence.firstRequestMcpNames = mcpNames(first);
evidence.afterEvalRequestMcpNames = mcpNames(second);
check("[1b] 첫 provider 요청에 MCP 도구 0", mcpNames(first).length === 0, mcpNames(first));
check(
	"[1c] eval: 연결 전 deferred로 보이고 꺼진 서버는 목록에 없다",
	JSON.stringify(r1?.before) === JSON.stringify([{ name: "data-stub", status: "deferred", exposed: false }]),
	r1?.before ?? out1,
);
check("[1d] eval: 도구 이름과 입력 schema를 읽는다", JSON.stringify(r1?.tools) === JSON.stringify([{ name: "fetch_rows", schema: ["limit"] }]), r1?.tools);
check("[1e] eval: 실제 stdio tool 호출 결과(structured)를 코드에서 쓴다", r1?.isError === false && r1?.rows === 40 && r1?.lastId === 40, r1);
check("[1f] eval이 연결한 서버는 연결됨·비노출", JSON.stringify(r1?.after) === JSON.stringify([{ name: "data-stub", status: "connected", exposed: false }]), r1?.after);
check("[1g] 실제 spawn 1·call 1", count("spawn data-stub") === 1 && count("call data-stub") === 1, logLines());
check("[1h] 같은 턴 다음 provider 요청에도 data-stub 도구 0(연결 refresh가 노출하지 않는다)", mcpNames(second).length === 0, mcpNames(second));
check("[1i] 코드가 출력하지 않은 원문(40행 PAYLOAD)은 대화에 들어가지 않는다", !JSON.stringify(second?.messages).includes("PAYLOAD-data-stub"), out1);

// [2a] 다음 요청이 그 서버와 관련돼 판정을 부르지만 판정이 실패하면 선택은 기존 노출을 그대로 둔다. eval 연결이 노출을 켰다면
// 여기서 모델에 새어 나간다(연결 refresh 경합 회귀).
judgeFails.on = true;
const judgedBefore = judgeCalls;
const [failedJudge] = await plainTurn(a.session, "table rows 정리 방법만 알려줘");
judgeFails.on = false;
evidence.judgeFailureTurnMcpNames = mcpNames(failedJudge);
evidence.judgeFailureTurnTools = (failedJudge?.tools ?? []).map(tool => tool.name);
check(
	"[2a] 판정 실패 요청에서도 eval이 연결한 서버 도구는 provider 요청에 없다",
	judgeCalls > judgedBefore && mcpNames(failedJudge).length === 0,
	{ judged: judgeCalls - judgedBefore, names: mcpNames(failedJudge) },
);

// [2] 다음 무관 요청: 선택이 그 서버를 노출하지 않는다(연결은 유지, 재spawn 없음).
const [next] = await plainTurn(a.session, "테스트만 돌려줘");
evidence.nextTurnMcpNames = mcpNames(next);
check("[2] 다음 요청 provider 도구에도 data-stub 0·재spawn 0", mcpNames(next).length === 0 && count("spawn data-stub") === 1, { names: mcpNames(next), log: logLines() });

// [3] 꺼진 서버는 eval에서도 닿지 않는다(spawn 0).
const [, disabledAfter] = await evalTurn(
	a.session,
	"확인만",
	"js",
	`try { await mcp.tools("off-stub"); console.log("REACHED"); } catch (error) { console.log("BLOCKED=" + JSON.stringify(String(error.message))); }`,
);
const out3 = evalOutput(disabledAfter);
evidence.disabledOutput = out3;
check("[3] 꺼진 서버: eval 접근 거절·spawn 0", out3.includes("BLOCKED=") && out3.includes("not available") && count("spawn off-stub") === 0, out3);

// [4] 승인 규칙: 직접 호출과 같은 tools.approval deny가 eval 호출도 막는다(tools/call 0).
const denyName = createMCPToolName("data-stub", "fetch_rows");
const denied = await open({ settings: { "tools.approval": { [denyName]: "deny" } } });
const callsBefore = count("call data-stub");
const [, deniedAfter] = await evalTurn(
	denied.session,
	"확인만",
	"js",
	`try { await mcp.call("data-stub", "fetch_rows", { limit: 1 }); console.log("CALLED"); } catch (error) { console.log("DENIED=" + JSON.stringify(String(error.message))); }`,
);
const out4 = evalOutput(deniedAfter);
evidence.denyOutput = out4;
check(
	"[4] tools.approval deny: eval 호출이 같은 게이트에서 막힌다·tools/call 0",
	out4.includes("DENIED=") && out4.includes("blocked by user policy") && !out4.includes("CALLED") && count("call data-stub") === callsBefore,
	out4,
);

// [5] 신뢰하지 않은 프로젝트(CUELO는 enableMCP:false로 연다): eval에 mcp 자체가 없다.
const untrusted = await open({ enableMCP: false });
const spawnsBefore = logLines().filter(line => line.startsWith("spawn")).length;
const [, untrustedAfter] = await evalTurn(untrusted.session, "확인만", "js", `console.log("TYPE=" + JSON.stringify(typeof mcp));`);
const out5 = evalOutput(untrustedAfter);
check("[5] enableMCP:false: eval에 mcp 없음·spawn 0", out5.includes('TYPE="undefined"') && logLines().filter(line => line.startsWith("spawn")).length === spawnsBefore, out5);

// [6] child(부모 manager 상속)는 deferred 서버를 연결하지 않는다.
const owner = await open();
const child = await open({ mcpManager: owner.mcpManager });
const [, childAfter] = await evalTurn(
	child.session,
	"확인만",
	"js",
	`try { await mcp.tools("data-stub"); console.log("CONNECTED"); } catch (error) { console.log("REFUSED=" + JSON.stringify(String(error.message))); }`,
);
const out6 = evalOutput(childAfter);
check(
	"[6] child eval은 부모 manager의 deferred 서버를 연결하지 않는다",
	out6.includes("REFUSED=") && out6.includes("only the session that owns per-request MCP selection") && owner.mcpManager.getConnectedServers().length === 0,
	out6,
);

// [7] Python eval: 같은 이름으로 목록·호출(이미 연결된 서버).
const [, pyAfter] = await evalTurn(
	a.session,
	"확인만",
	"py",
	`r = await mcp.call("data-stub", "fetch_rows", {"limit": 5})\nprint("PY=" + str(len(r["structured"]["rows"])) + "/" + str(r["isError"]))`,
);
const out7 = evalOutput(pyAfter);
evidence.pythonOutput = out7;
check("[7] Python eval: mcp.call 결과를 코드에서 쓴다", out7.includes("PY=5/False"), out7);

for (const created of [child, owner, untrusted, denied, a]) {
	await created.session.dispose();
	if (created !== child) await created.mcpManager?.disconnectAll();
}

const out = process.env.OMP_MCP_EVAL_EVIDENCE;
if (out) writeFileSync(out, JSON.stringify(evidence, null, 2));
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
