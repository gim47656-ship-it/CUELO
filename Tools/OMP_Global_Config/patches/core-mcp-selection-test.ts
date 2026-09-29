// 요청별 MCP 선택(`mcp.selection: per-request`) 실제 AgentSession + 실제 stdio MCP transport 회귀.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-mcp-selection-test.ts
// 모델 호출은 fake stream, JEV는 결정적 주입 판정기다. MCP 서버는 이 테스트가 임시로 만든 로컬
// stdio stub 프로세스이며 외부 네트워크·유료 MCP·실제 JEV를 부르지 않는다. stub은 시작할 때마다
// spawn 로그에 한 줄을 남기므로 "연결 전 선별"은 프로세스가 실제로 떴는지로 판정한다.
// 미패치 core에서는 첫 per-request 세션 생성이 `Unknown setting "mcp.selection"`으로 실패(RED)한다.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (!process.env.OMP_MCP_SELECTION_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-mcp-selection-"));
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
				OMP_MCP_SELECTION_FIXTURE_ROOT: root,
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
if (!existsSync(join(CORE, "mcp/manager.ts"))) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
const PACKAGES = resolve(dirname(CORE), "..").replace(/\\/g, "/");
const fixtureRoot = process.env.OMP_MCP_SELECTION_FIXTURE_ROOT!;
const agentDir = join(fixtureRoot, "home", ".omp", "agent");
const { setAgentDir } = await import(`${CORE}/../../pi-utils/src/dirs.ts`);
setAgentDir(agentDir);
mkdirSync(agentDir, { recursive: true });

// 런타임 선택 경로라 정적 import가 불가능하다(OMP_CORE_PATCH_TARGET 사본만 검증).
const { createAgentSession } = await import(`${CORE}/sdk.ts`);
const { createAssistantMessageEventStream } = await import(`${PACKAGES}/pi-ai/src/utils/event-stream.ts`);
const { getBundledModel } = await import(`${PACKAGES}/pi-catalog/src/models.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
const { createMcpSelection } = await import(
	resolve(import.meta.dir, "../agent/extensions/mcp-selection.ts").replace(/\\/g, "/")
);
// 비밀 아닌 placeholder. fake stream이 provider transport를 대체한다.
process.env.OPENAI_API_KEY = "<probe>";
const model = getBundledModel("openai", "gpt-4o-mini");
assert.ok(model, "fake transport용 bundled model이 필요하다");

// ---------------------------------------------------------------------------
// 로컬 stdio MCP stub: 줄 단위 JSON-RPC, tool 1개, 시작마다 spawn 로그 1줄(이름 pid).
// mode crash는 시작 직후 종료(연결 실패), slow는 initialize 응답을 늦춘다(handshake 중 취소 검증).
// ---------------------------------------------------------------------------
const spawnLog = join(fixtureRoot, "spawn.log");
writeFileSync(spawnLog, "");
const stubPath = join(fixtureRoot, "stub-mcp.ts");
writeFileSync(
	stubPath,
	`import { appendFileSync } from "node:fs";
const [name, log, tool, description, mode] = process.argv.slice(2);
appendFileSync(log, name + " " + process.pid + "\\n");
if (mode === "crash") process.exit(3);
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
		if (request.method === "initialize") {
			const result = { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } };
			if (mode === "slow") setTimeout(() => reply(result), 4000);
			else reply(result);
		}
		else if (request.method === "tools/list") reply({ tools: [{ name: tool, description, inputSchema: { type: "object", properties: {} } }] });
		else if (request.method === "tools/call") reply({ content: [{ type: "text", text: "STUB-" + name + "-OK" }] });
		else if (request.method === "ping") reply({});
		else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } });
	}
});
`,
);
const stub = (name: string, tool: string, description: string, extra: Record<string, unknown> = {}, mode = "ok") => ({
	command: process.execPath,
	args: [stubPath, name, spawnLog, tool, description, mode],
	...extra,
});
const spawnLines = () =>
	readFileSync(spawnLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => line.split(" ") as [string, string]);
const spawned = () => spawnLines().map(([name]) => name);
const count = (name: string) => spawned().filter(item => item === name).length;
const pidOf = (name: string) => Number(spawnLines().findLast(([item]) => item === name)?.[1]);
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
// 실제 자식 프로세스의 spawn·종료를 기다리는 통합 검증이라 가짜 시계로 대체할 수 없다(짧은 폴링, 상한 있음).
async function until(condition: () => boolean, limitMs = 8000): Promise<boolean> {
	for (let waited = 0; waited < limitMs; waited += 50) {
		if (condition()) return true;
		await Bun.sleep(50);
	}
	return condition();
}

const work = join(fixtureRoot, "work");
mkdirSync(join(work, ".omp"), { recursive: true });
writeFileSync(
	join(work, ".omp", "mcp.json"),
	JSON.stringify({
		mcpServers: {
			"figma-stub": stub("figma-stub", "get_design", "Read a design node from the design tool."),
			"docs-stub": stub("docs-stub", "search_docs", "Search internal documentation."),
			"off-stub": stub("off-stub", "query_db", "Query a database.", { enabled: false }),
			"broken-stub": stub("broken-stub", "noop", "Crashes on start.", {}, "crash"),
			"slow-stub": stub("slow-stub", "slow_op", "Answers the handshake slowly.", {}, "slow"),
		},
	}),
);
// 프로젝트 기술 단서: 파일 종류·manifest 종류·공개 프레임워크 이름만 JEV에 가야 한다(사내 패키지명·파일명 제외).
writeFileSync(join(work, "wrangler.toml"), 'name = "fixture"\n');
writeFileSync(join(work, "package.json"), JSON.stringify({ dependencies: { hono: "4", "acme-internal-billing": "1" }, devDependencies: { wrangler: "4" } }));
mkdirSync(join(work, "src"));
writeFileSync(join(work, "src", "worker.ts"), "export default {};\n");
// user(전역) 서버 1개 + 사용자가 끈 서버 1개. 카탈로그 이름은 꺼 두어 설치 제안 경로를 따로 본다.
writeFileSync(
	join(agentDir, "mcp.json"),
	JSON.stringify({
		mcpServers: { "user-stub": stub("user-stub", "lookup", "Look up a user-level reference.") },
		disabledServers: ["github"],
	}),
);

// ---------------------------------------------------------------------------
// fake provider + 결정적 JEV
// ---------------------------------------------------------------------------
const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
type ProviderContext = { systemPrompt?: unknown; messages: unknown[]; tools?: Array<{ name: string; description?: string; parameters?: unknown }> };
/** tool은 provider 요청을 보고 호출 인자를 만든다(장치 이름은 실행 중에만 안다). */
type Step = { tool?: (context: ProviderContext) => { name: string; args: Record<string, unknown> }; inspect?: (context: ProviderContext) => void };

function fakeStream(steps: Step[]) {
	let index = 0;
	return (_model: unknown, context: ProviderContext) => {
		const stream = createAssistantMessageEventStream();
		const step = steps[index++];
		queueMicrotask(() => {
			if (!step) {
				stream.fail(new Error(`unexpected provider call #${index}`));
				return;
			}
			step.inspect?.(context);
			const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, usage: usage(), timestamp: Date.now() };
			const tool = step.tool?.(context);
			if (tool) {
				const toolCall = { type: "toolCall" as const, id: `call-${index}`, name: tool.name, arguments: tool.args };
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

type Need = "needed" | "not-needed" | "unknown";
type JudgeState = { request: string; project: string; servers: Array<{ id: string; name: string }> };
const judgeCalls: Array<{ request: string; project: string; servers: string[] }> = [];
type JudgeFactory = () => Promise<{ judge: (request: { state: JudgeState }) => Promise<unknown> }>;
function judgeBy(decide: (request: string, server: string) => Need, fail: { on: boolean } = { on: false }): JudgeFactory {
	return async () => ({
		judge: async (request: { state: JudgeState }) => {
			judgeCalls.push({ request: request.state.request, project: request.state.project, servers: request.state.servers.map(server => server.name) });
			if (fail.on) throw new Error("judge provider unavailable");
			const answers: Record<string, { type: "choice"; choice: string }> = {};
			for (const server of request.state.servers) {
				answers[server.id] = { type: "choice", choice: decide(request.state.request, server.name) };
				answers[`${server.id}_scope`] = { type: "choice", choice: server.name === "cloudflare-docs" ? "project" : "user" };
			}
			return { answers };
		},
	});
}
const byRequest = (request: string, server: string): Need => {
	if (/figma|피그마/i.test(request) && server === "figma-stub") return "needed";
	if (/Workers/.test(request) && server === "cloudflare-docs") return "needed";
	if (/broken/.test(request) && server === "broken-stub") return "needed";
	if (/slow/.test(request) && server === "slow-stub") return "needed";
	return "not-needed";
};
// 검증 대상 core 사본의 실제 판정·설정 모듈(native-only 게이트 확인용). 판정 호출은 하지 않는다.
const coreJudgment = async () => ({
	judgment: await import(`${CORE}/judgment/index.ts`),
	settings: await import(`${CORE}/config/settings.ts`),
});

// 프로세스 Settings 싱글턴 대신 세션마다 격리 설정을 넘긴다(같은 프로세스에서 all/per-request를 비교).
async function open(options: { selection: "all" | "per-request"; judge?: JudgeFactory; native?: boolean; hasUI?: boolean; mcpManager?: unknown }) {
	return createAgentSession({
		cwd: work,
		agentDir,
		settings: Settings.isolated({ "mcp.selection": options.selection }),
		model,
		getApiKey: () => "example",
		hasUI: options.hasUI ?? false,
		disableExtensionDiscovery: true,
		extensions: [createMcpSelection(options.native ? { agentDir, loadCore: coreJudgment } : { agentDir, resolveJudge: options.judge })],
		enableLsp: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		...(options.mcpManager ? { mcpManager: options.mcpManager } : {}),
	});
}
/** 한 사용자 요청을 보내고 그 요청의 provider 호출 context를 순서대로 돌려준다. */
async function turn(session: { agent: { streamFn: unknown }; prompt(text: string): Promise<unknown> }, prompt: string, steps: Step[] = [{}]) {
	const seen: ProviderContext[] = [];
	session.agent.streamFn = fakeStream(steps.map(step => ({ ...step, inspect: (c: ProviderContext) => seen.push(c) }))) as never;
	await session.prompt(prompt);
	return seen;
}

const mcpNames = (context: ProviderContext | undefined) => {
	if (!context) return [];
	const text = `${JSON.stringify(context.systemPrompt)}\n${JSON.stringify(context.tools ?? [])}`;
	return [...new Set(text.match(/mcp__[A-Za-z0-9_-]+/g) ?? [])].sort();
};
const promptBytes = (context: ProviderContext) =>
	Buffer.byteLength(JSON.stringify(context.systemPrompt)) + Buffer.byteLength(JSON.stringify(context.tools ?? []));
const selectionNotice = (context: ProviderContext | undefined) =>
	String(
		context?.messages
			.map(message => JSON.stringify(message))
			.filter(text => text.includes("[MCP 선택]"))
			.at(-1),
	);

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

// [0] 기준선: selection all(기본)은 활성 서버를 시작 시 전부 연결 시도한다.
{
	const all = await open({ selection: "all", judge: judgeBy(byRequest) });
	const [seen] = await turn(all.session, "README 오타만 고쳐줘");
	await until(() => spawned().length >= 5);
	evidence.allSpawned = [...spawned()].sort();
	evidence.allMcpNames = mcpNames(seen);
	evidence.allPromptBytes = promptBytes(seen!);
	check(
		"[0] all 모드는 활성 5개 서버를 시작 시 띄우고 끈 서버는 띄우지 않는다",
		JSON.stringify(evidence.allSpawned) === JSON.stringify(["broken-stub", "docs-stub", "figma-stub", "slow-stub", "user-stub"]),
		evidence.allSpawned,
	);
	await all.session.dispose();
	await all.mcpManager?.disconnectAll();
}
writeFileSync(spawnLog, "");

// [1-7] per-request, 비UI 경로(loader).
const a = await open({ selection: "per-request", judge: judgeBy(byRequest) });
check("[1] 시작 직후 per-request는 MCP 프로세스를 하나도 띄우지 않는다", spawned().length === 0, spawned());
const [unrelated] = await turn(a.session, "README 오타만 고쳐줘");
evidence.unrelatedMcpNames = mcpNames(unrelated);
evidence.unrelatedPromptBytes = promptBytes(unrelated!);
check("[2] 무관한 요청: 연결 0, provider 요청의 MCP schema/catalog 0", spawned().length === 0 && mcpNames(unrelated).length === 0, { spawned: spawned(), names: mcpNames(unrelated) });

// 관련 요청: 선택 서버만 실제 spawn → 같은 턴 provider 요청에 그 장치만 → 실제 tool 호출 결과.
const [relevant, afterTool] = await turn(a.session, "피그마 시안 노드를 읽어서 버튼 색을 맞춰줘", [
	{ tool: c => ({ name: "write", args: { path: `xd://${mcpNames(c).find(name => name.includes("figma"))}`, content: "{}" } }) },
	{},
]);
evidence.relevantMcpNames = mcpNames(relevant);
evidence.relevantNotice = selectionNotice(relevant);
check("[3a] 관련 요청: figma-stub만 실제 spawn", JSON.stringify(spawned()) === JSON.stringify(["figma-stub"]), spawned());
check("[3b] 같은 턴 provider 요청에 figma 장치만 노출", mcpNames(relevant).length > 0 && mcpNames(relevant).every(name => name.includes("figma")), mcpNames(relevant));
check("[3c] 실제 연결 결과가 '연결됨'으로 모델·사용자 메시지에 전달된다", String(evidence.relevantNotice).includes("연결됨: `figma-stub`"), evidence.relevantNotice);
const toolResult = afterTool?.messages.map(message => JSON.stringify(message)).find(text => text.includes("STUB-figma-stub-OK"));
check("[3d] 실제 stdio transport tool 호출 결과가 대화에 들어온다", toolResult !== undefined, afterTool?.messages.slice(-2));

// 다음 무관 요청: 연결은 유지(재spawn 없음), 선택이 연결한 figma 도구는 숨긴다.
const [hidden] = await turn(a.session, "테스트만 돌려줘");
check("[4a] 이후 무관 요청: 연결 유지·재spawn 없음", count("figma-stub") === 1 && a.mcpManager.getConnectedServers().includes("figma-stub"), spawned());
check("[4b] 이후 무관 요청: 선택 서버 schema 누적 없음", mcpNames(hidden).length === 0, mcpNames(hidden));

// auto→숨김 상태에서 사용자가 /mcp reconnect(manual)하면 소유가 사용자로 바뀌고 이후 not-needed에서도 노출된다.
await a.mcpManager.reconnectServer("figma-stub", { manual: true });
await a.session.refreshMCPTools(a.mcpManager.getTools());
const [afterManual] = await turn(a.session, "테스트만 다시 돌려줘");
check(
	"[4c] auto 연결→숨김→수동 재연결 뒤 not-needed 요청에서도 노출 유지",
	!a.mcpManager.isSelectionConnected("figma-stub") && mcpNames(afterManual).some(name => name.includes("figma")),
	{ selected: a.mcpManager.isSelectionConnected("figma-stub"), names: mcpNames(afterManual) },
);

// 꺼진 서버·미설치 카탈로그: 자동 연결·설치 0, 프로젝트 단서로 고른 범위의 명령과 공식 출처 안내만.
const figmaSpawns = count("figma-stub");
const [installTurn] = await turn(a.session, "Workers 배포 설정 공식 문서 확인하고 off-stub 도 봐줘");
evidence.installNotice = selectionNotice(installTurn);
const project = judgeCalls.at(-1)?.project ?? "";
evidence.projectCue = project;
check("[5a] 꺼진·미설치 서버는 spawn 0", count("off-stub") === 0 && count("figma-stub") === figmaSpawns && spawned().length === figmaSpawns, spawned());
check(
	"[5b] 프로젝트 단서(wrangler·hono)로 프로젝트 범위 설치 명령과 공식 출처를 안내한다(실행 없음은 [5a])",
	evidence.installNotice.includes("`cloudflare-docs`") &&
		evidence.installNotice.includes("--scope project --url https://docs.mcp.cloudflare.com/mcp") &&
		evidence.installNotice.includes("https://github.com/cloudflare/mcp-server-cloudflare"),
	evidence.installNotice,
);
check("[5c] 요청에 이름이 나온 꺼진 서버는 /mcp enable 수동 경로를 보인다", String(evidence.installNotice).includes("/mcp enable off-stub"), evidence.installNotice);
check(
	"[5d] 프로젝트 단서는 종류·공개 프레임워크만(사내 패키지명·파일명 없음)",
	project.includes("wrangler config") && project.includes("hono") && !project.includes("acme") && !project.includes("worker.ts"),
	project,
);

// 실제 연결 실패: '연결됨'으로 보고하지 않고, 후보에서 빠져 자동 재시도하지 않으며, 수동 재연결은 동작한다.
const [brokenTurn] = await turn(a.session, "broken 도구로 확인해줘");
evidence.brokenNotice = selectionNotice(brokenTurn);
check(
	"[6a] 연결 실패는 '연결 실패'와 수동 경로로 보고되고 '연결됨'이 아니다",
	count("broken-stub") === 1 && evidence.brokenNotice.includes("연결 실패: `broken-stub`") && !evidence.brokenNotice.includes("연결됨: `broken-stub`"),
	{ spawned: spawned(), notice: evidence.brokenNotice },
);
await turn(a.session, "broken 도구로 다시 확인");
check(
	"[6b] 실패한 서버는 다음 요청에서 자동 재선택·재시도되지 않는다",
	count("broken-stub") === 1 && !(judgeCalls.at(-1)?.servers ?? []).includes("broken-stub"),
	{ spawned: spawned(), servers: judgeCalls.at(-1)?.servers },
);
const brokenManual = await a.mcpManager.reconnectServer("broken-stub", { manual: true });
// 수동 재연결은 기존 core reconnect 의미(내부 재시도 포함)를 그대로 쓴다. 선택 기능은 재시도를 더하지 않는다.
const brokenAfterManual = count("broken-stub");
evidence.brokenSpawnsAfterManual = brokenAfterManual;
check("[6c] 실패 서버의 수동 /mcp reconnect 경로는 유지된다(다시 시도, 여전히 실패)", brokenManual === null && brokenAfterManual >= 2, spawned());

// 취소: 이미 abort된 신호는 spawn 0, handshake 중 취소는 늦은 연결·고아 프로세스 없이 후보로 복귀.
await a.mcpManager.connectDeferred(["slow-stub"], AbortSignal.abort());
check("[7a] 이미 취소된 요청은 선택 서버를 spawn하지 않는다", count("slow-stub") === 0, spawned());
const cancelled = turn(a.session, "slow 도구로 처리해줘").catch(() => []);
await until(() => count("slow-stub") === 1);
const slowPid = pidOf("slow-stub");
a.session.abort();
await cancelled;
const slowGone = await until(() => !alive(slowPid));
// 늦은 initialize 응답 시점(4초)이 지나도 연결이 생기지 않는지 본다.
await until(() => a.mcpManager.getConnectionStatus("slow-stub") !== "disconnected", 4500);
const slowDeferred = (await a.mcpManager.getDeferredServers()).some((server: { name: string }) => server.name === "slow-stub");
check(
	"[7b] handshake 중 취소: 연결 0, stub 프로세스 종료, deferred 후보로 복귀",
	slowGone && a.mcpManager.getConnectionStatus("slow-stub") === "disconnected" && slowDeferred,
	{ slowGone, status: a.mcpManager.getConnectionStatus("slow-stub"), slowDeferred },
);

// [8] child: 부모 manager를 재사용하지만 선택·연결·해제를 하지 않는다.
const beforeChild = spawned().length;
const child = await open({ selection: "per-request", judge: judgeBy(() => "needed"), mcpManager: a.mcpManager });
await turn(child.session, "docs-stub 로 문서 검색해줘");
await child.session.dispose();
check(
	"[8] child는 부모 manager에 새 연결을 만들지 않고 dispose해도 부모 연결을 끊지 않는다",
	spawned().length === beforeChild && a.mcpManager.getConnectedServers().includes("figma-stub"),
	{ spawned: spawned(), connected: a.mcpManager.getConnectedServers() },
);

// [9] 다른 top-level 세션(UI 지연 discovery 경로): 자기 manager, 연결 0에서 시작. JEV 실패는 새 연결 0 + 명시.
const failing = { on: true };
const b = await open({ selection: "per-request", judge: judgeBy(byRequest, failing), hasUI: true });
const beforeB = spawned().length;
const [failedTurn] = await turn(b.session, "피그마 시안 읽어줘");
evidence.failureNotice = selectionNotice(failedTurn);
check("[9a] 세션 격리: 새 세션 manager는 A의 연결을 공유하지 않는다", b.mcpManager !== a.mcpManager && b.mcpManager.getConnectedServers().length === 0, b.mcpManager?.getConnectedServers());
check(
	"[9b] JEV 실패: 새 spawn 0, schema 0, 실패 상태 명시",
	spawned().length === beforeB && mcpNames(failedTurn).length === 0 && evidence.failureNotice.includes("JEV 판정 불가"),
	{ spawned: spawned(), notice: evidence.failureNotice },
);

// [10] 수동 우회: /mcp reconnect(manual)는 deferred 서버를 바로 연결하고, 정상 판정이 not-needed여도 노출을 유지한다.
failing.on = false;
const manual = await b.mcpManager.reconnectServer("docs-stub", { manual: true });
await b.session.refreshMCPTools(b.mcpManager.getTools());
const [manualTurn] = await turn(b.session, "테스트만 돌려줘");
check("[10] 수동 연결 서버는 spawn되고 다음 요청에서도 노출 유지", manual !== null && count("docs-stub") === 1 && mcpNames(manualTurn).some(name => name.includes("docs")), { spawned: spawned(), names: mcpNames(manualTurn) });

// [11] handshake 중 세션 dispose: 소유 manager가 정리되고 고아 stub이 남지 않는다.
const c = await open({ selection: "per-request", judge: judgeBy(byRequest) });
const disposing = turn(c.session, "slow 도구로 처리해줘").catch(() => []);
await until(() => count("slow-stub") === 2);
const disposedPid = pidOf("slow-stub");
await c.session.dispose();
await c.mcpManager?.disconnectAll();
await disposing;
const disposedGone = await until(() => !alive(disposedPid));
check("[11] handshake 중 dispose: 늦은 연결 없음·stub 프로세스 종료", disposedGone && c.mcpManager.getConnectedServers().length === 0, { disposedGone, connected: c.mcpManager.getConnectedServers() });

// [12] 기본 판정기(실제 core judgment 모듈): judge 역할 첫 후보가 native가 아니면 판정하지 않고 연결 0.
const d = await open({ selection: "per-request", native: true });
const beforeD = spawned().length;
const [nativeTurn] = await turn(d.session, "피그마 시안 읽어줘");
evidence.nativeNotice = selectionNotice(nativeTurn);
check(
	"[12] native JEV 없는 설정: chat/세션 fallback 없이 판정 불가 명시·새 spawn 0",
	evidence.nativeNotice.includes("judge 역할 첫 후보가 native JEV가 아님") && spawned().length === beforeD,
	{ notice: evidence.nativeNotice, spawned: spawned() },
);

evidence.judgeInputs = judgeCalls;
check(
	"[13] JEV 입력에 command·args·경로·사내 패키지명이 없다",
	!JSON.stringify(judgeCalls).includes("stub-mcp") && !JSON.stringify(judgeCalls).includes(fixtureRoot.replace(/\\/g, "\\\\")) && !JSON.stringify(judgeCalls).includes("acme"),
	judgeCalls,
);

check("[6d] 수동 재시도 뒤 실패 서버가 끝없이 다시 spawn되지 않는다", count("broken-stub") === brokenAfterManual, { before: brokenAfterManual, now: count("broken-stub") });

for (const created of [d, b, a]) {
	await created.session.dispose();
	await created.mcpManager?.disconnectAll();
}

const out = process.env.OMP_MCP_SELECTION_EVIDENCE;
if (out) writeFileSync(out, JSON.stringify(evidence, null, 2));
console.log(`\nprompt bytes (system prompt + tools JSON): all=${evidence.allPromptBytes} per-request-unrelated=${evidence.unrelatedPromptBytes}`);
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
