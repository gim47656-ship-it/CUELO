// Opus 5.5 progress update 표시 회귀: omitThinking(`thinkingDisplay: "omitted"`)이면 공식 Anthropic API에는
// `display: "updates"`(beta 헤더 포함)로 보내고, 텍스트가 온 thinking(progress update)만 본문 text로 보인다.
// 서명은 불투명 값이라 해석하지 않는다. updates를 요청하지 않은 경우에는 thinking 텍스트를 본문으로 옮기지 않는다.
// 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-narration-display-test.ts
// 미패치 core 에서는 요청이 omitted로 나가고 progress 문장이 text로 나오지 않아 [1]·[3]·[4]가 FAIL(RED).
// 로컬 SSE 서버만 쓴다(네트워크·유료 호출·설정 변경 없음).
// 동적 import 예외: core-task-model-test.ts 와 같은 이유(지정한 사본만 검증).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveAi(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(p => existsSync(join(p, "..", "pi-ai", "src", "providers", "anthropic.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	return join(hit, "..", "pi-ai", "src").replace(/\\/g, "/");
}

const AI = resolveAi();
console.log(`대상 ${AI}`);
const { streamAnthropic, convertAnthropicMessages } = await import(`${AI}/providers/anthropic.ts`);
const CATALOG = join(AI, "..", "..", "pi-catalog", "src", "models.ts").replace(/\\/g, "/");
const { getBundledModel } = await import(CATALOG);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name} ${detail}`);
	}
}

const UPDATES_BETA = "thinking-display-updates-2026-08-18";
// 서명은 불투명하다. 블록 종류 이름이 들어 있지 않은 값으로 판정이 서명에 기대지 않음을 보인다.
const REASONING_SIGNATURE = Buffer.from("opaque-signature-0001").toString("base64");
const PROGRESS_SIGNATURE = Buffer.from("opaque-signature-0002").toString("base64");
const PROGRESS_TEXT = "지금 echo로 결과를 확인할게요.";

function sse(events: Array<{ type: string }>): string {
	return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

// updates 응답 모양: reasoning 블록은 비어 있고 progress update 블록만 텍스트를 싣는다.
const events = [
	{
		type: "message_start",
		message: {
			id: "msg_updates", type: "message", role: "assistant", model: "claude-opus-5-5", content: [],
			stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: REASONING_SIGNATURE } },
	{ type: "content_block_stop", index: 0 },
	{ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } },
	{ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: PROGRESS_TEXT } },
	{ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: PROGRESS_SIGNATURE } },
	{ type: "content_block_stop", index: 1 },
	{ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_updates", name: "bash", input: {} } },
	{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"command\":\"echo hi\"}" } },
	{ type: "content_block_stop", index: 2 },
	{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } },
	{ type: "message_stop" },
];

const requests: Array<{ body: Record<string, unknown>; beta: string }> = [];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		requests.push({ body: await req.json(), beta: req.headers.get("anthropic-beta") ?? "" });
		return new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
	},
});

// 공식 API 주소로 보낸 요청을 로컬 서버로 돌린다. 모델의 baseUrl은 공식 주소 그대로 둔다.
function toLocal(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const url = new URL(input instanceof Request ? input.url : String(input));
	const target = `http://127.0.0.1:${server.port}${url.pathname}${url.search}`;
	return input instanceof Request ? fetch(new Request(target, input), init) : fetch(target, init);
}

type Block = { type: string; text?: string; thinking?: string; thinkingSignature?: string };
const context = {
	systemPrompt: "test",
	messages: [{ role: "user", content: "echo로 확인해", timestamp: Date.now() }],
	tools: [{ name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } }],
};

async function run(model: unknown, extra: Record<string, unknown>) {
	const sentBefore = requests.length;
	const s = streamAnthropic(model, context, { apiKey: "sk-ant-test", thinkingEnabled: true, maxRetries: 0, ...extra });
	const thinkingDeltas: string[] = [];
	const textDeltas: string[] = [];
	for await (const ev of s) {
		if (ev.type === "thinking_delta") thinkingDeltas.push(ev.delta);
		if (ev.type === "text_delta") textDeltas.push(ev.delta);
	}
	const message: { content: Block[] } = await s.result();
	const request = requests.length > sentBefore ? requests[requests.length - 1] : undefined;
	const thinking = request?.body.thinking;
	const display = thinking && typeof thinking === "object" && "display" in thinking ? thinking.display : undefined;
	return { message, display, beta: request?.beta ?? "", thinkingDeltas, textDeltas };
}

try {
	const base = getBundledModel("anthropic", "claude-opus-5-5");

	console.log("omitThinking + 공식 API");
	const official = await run(base, { thinkingDisplay: "omitted", fetch: toLocal });
	check(
		"[1] 요청은 display updates와 그 beta 헤더로 나간다",
		official.display === "updates" && official.beta.split(",").includes(UPDATES_BETA),
		`display=${official.display} beta=${official.beta}`,
	);
	const thinkingTexts = official.message.content.filter(b => b.type === "thinking").map(b => b.thinking ?? "");
	check(
		"[2] thinking은 화면·결과에서 비어 있다",
		official.thinkingDeltas.join("") === "" && thinkingTexts.every(t => t === ""),
		JSON.stringify(official.thinkingDeltas),
	);
	const texts = official.message.content.filter(b => b.type === "text");
	check(
		"[3] progress update 문장이 본문 text로 보인다(서명과 무관)",
		texts.length === 1 && texts[0].text === PROGRESS_TEXT && official.textDeltas.join("") === PROGRESS_TEXT,
		JSON.stringify(official.message.content.map(b => b.type)),
	);
	const order = official.message.content.map(b => b.type).join(",");
	check("[4] 서명된 thinking 2개와 도구 호출은 그대로 남는다", order === "thinking,thinking,text,toolCall", order);

	const params = convertAnthropicMessages([...context.messages, official.message], base, false);
	type WireBlock = { type: string; signature?: string };
	type WireMessage = { role: string; content: WireBlock[] };
	// convertAnthropicMessages 는 SDK 의 MessageParam[] 을 돌려준다. 동적 import 라 타입이 없어 이름을 붙여 둔다.
	const wire: WireMessage[] = params;
	const assistant = wire.find(p => p.role === "assistant");
	const sentTypes = assistant?.content.map(b => b.type).join(",");
	const sentSignatures = assistant?.content.filter(b => b.type === "thinking").map(b => b.signature);
	check(
		"[5] 다시 보낼 때 화면용 사본은 빼고 서명된 thinking은 그대로 보낸다",
		sentTypes === "thinking,thinking,tool_use" && sentSignatures?.[0] === REASONING_SIGNATURE && sentSignatures?.[1] === PROGRESS_SIGNATURE,
		`${sentTypes}`,
	);

	console.log("thinking 표시(omitThinking 아님) + 공식 API");
	const shown = await run(base, { fetch: toLocal });
	check(
		"[6] summarized로 보내고 updates beta를 붙이지 않으며 thinking을 본문으로 옮기지 않는다",
		shown.display === "summarized" &&
			!shown.beta.split(",").includes(UPDATES_BETA) &&
			!shown.message.content.some(b => b.type === "text"),
		`display=${shown.display} types=${shown.message.content.map(b => b.type).join(",")}`,
	);

	console.log("omitThinking + 공식 API가 아닌 주소");
	const gateway = await run({ ...base, baseUrl: `http://127.0.0.1:${server.port}` }, { thinkingDisplay: "omitted" });
	check(
		"[7] updates를 모르는 주소에는 upstream 값을 보내고 thinking을 본문으로 옮기지 않는다",
		gateway.display === "omitted" &&
			!gateway.beta.split(",").includes(UPDATES_BETA) &&
			!gateway.message.content.some(b => b.type === "text"),
		`display=${gateway.display} types=${gateway.message.content.map(b => b.type).join(",")}`,
	);
} finally {
	server.stop(true);
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
