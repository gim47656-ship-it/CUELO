// Opus 5.5 narration 표시 회귀: 도구 앞 사용자용 문장이 서명된 `narration` thinking 블록으로 와도
// omitThinking(`thinkingDisplay: "omitted"`)에서 본문 text로 보이고, 일반 thinking 내용은 계속 숨는다.
// 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-narration-display-test.ts
// 미패치 core 에서는 요청이 omitted로 나가고 narration 문장이 text로 나오지 않아 [1]·[3]·[5]가 FAIL(RED).
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

// 실제 서명은 protobuf 바이트다. 판정은 그 안의 블록 종류 이름(`thinking`/`narration`)만 본다.
const signature = (kind: string) => Buffer.from(`\x08\x04\x12\x10${kind}\x00opaque-${kind}`, "latin1").toString("base64");
const THINKING_TEXT = "The user wants a check; I should run echo first.";
const NARRATION_TEXT = "지금 echo로 결과를 확인할게요.";

function sse(events: Array<{ type: string }>): string {
	return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const events = [
	{
		type: "message_start",
		message: {
			id: "msg_narr", type: "message", role: "assistant", model: "claude-opus-5-5", content: [],
			stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THINKING_TEXT } },
	{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: signature("thinking") } },
	{ type: "content_block_stop", index: 0 },
	{ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } },
	{ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: NARRATION_TEXT } },
	{ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: signature("narration") } },
	{ type: "content_block_stop", index: 1 },
	{ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_narr", name: "bash", input: {} } },
	{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"command\":\"echo hi\"}" } },
	{ type: "content_block_stop", index: 2 },
	{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } },
	{ type: "message_stop" },
];

let requestBody: Record<string, unknown> | undefined;
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		requestBody = await req.json();
		return new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
	},
});

try {
	const base = getBundledModel("anthropic", "claude-opus-5-5");
	const model = { ...base, baseUrl: `http://127.0.0.1:${server.port}` };
	const context = {
		systemPrompt: "test",
		messages: [{ role: "user", content: "echo로 확인해", timestamp: Date.now() }],
		tools: [{ name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } }],
	};
	const s = streamAnthropic(model, context, { apiKey: "sk-ant-test", thinkingEnabled: true, thinkingDisplay: "omitted", maxRetries: 0 });
	const thinkingDeltas: string[] = [];
	const textDeltas: string[] = [];
	for await (const ev of s) {
		if (ev.type === "thinking_delta") thinkingDeltas.push(ev.delta);
		if (ev.type === "text_delta") textDeltas.push(ev.delta);
	}
	const message = await s.result();

	const thinking = requestBody?.thinking;
	const display = thinking && typeof thinking === "object" && "display" in thinking ? thinking.display : undefined;
	check("[1] omitThinking이어도 요청은 summarized로 보낸다", display === "summarized", `display=${display}`);

	const leaked = [...thinkingDeltas, ...message.content.flatMap((b: { type: string; thinking?: string }) => (b.type === "thinking" ? [b.thinking ?? ""] : []))]
		.join("")
		.includes("The user wants");
	check("[2] 일반 thinking 내용은 화면·결과에 나오지 않는다", !leaked, JSON.stringify(thinkingDeltas));

	const texts = message.content.filter((b: { type: string }) => b.type === "text");
	check(
		"[3] narration 문장이 본문 text로 보인다",
		texts.length === 1 && texts[0].text === NARRATION_TEXT && textDeltas.join("") === NARRATION_TEXT,
		JSON.stringify(message.content.map((b: { type: string }) => b.type)),
	);

	const order = message.content.map((b: { type: string }) => b.type).join(",");
	check("[4] 서명된 thinking 2개와 도구 호출은 그대로 남는다", order === "thinking,thinking,text,toolCall", order);

	const params = convertAnthropicMessages([...context.messages, message], model, false);
	type WireBlock = { type: string; signature?: string };
	type WireMessage = { role: string; content: WireBlock[] };
	// convertAnthropicMessages 는 SDK 의 MessageParam[] 을 돌려준다. 동적 import 라 타입이 없어 이름을 붙여 둔다.
	const wire: WireMessage[] = params;
	const assistant = wire.find(p => p.role === "assistant");
	const sentTypes = assistant?.content.map(b => b.type).join(",");
	const sentSignatures = assistant?.content.filter(b => b.type === "thinking").map(b => b.signature);
	check(
		"[5] 다시 보낼 때 화면용 narration 사본은 빼고 서명된 thinking은 보낸다",
		sentTypes === "thinking,thinking,tool_use" && sentSignatures?.[1] === signature("narration"),
		`${sentTypes}`,
	);
} finally {
	server.stop(true);
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
