// eval `commit` prelude(18.20.1 선택 커밋) 기본값 회귀: 실제 AgentSession + 실제 eval worker.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-commit-prelude-test.ts
// 하네스 config.yml(`commit.enabled: false`)은 클라우드 갱신과 npm 설치가 배포하지 않는다. 그런 프로필에서 eval `commit`으로
// 만든 로컬 커밋은 git_finalize가 resume-push로 받아 교차 검토 없이 보낸다. 그래서 설정이 없을 때도 꺼져 있어야 한다.
// 모델은 fake stream이다. 미패치 18.20.1 core에서는 [1]이 실패(RED)한다.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (!process.env.OMP_COMMIT_PRELUDE_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-commit-prelude-"));
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
				OMP_COMMIT_PRELUDE_FIXTURE_ROOT: root,
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
const fixtureRoot = process.env.OMP_COMMIT_PRELUDE_FIXTURE_ROOT!;
const agentDir = join(fixtureRoot, "home", ".omp", "agent");
const { setAgentDir } = await import(`${PACKAGES}/pi-utils/src/dirs.ts`);
setAgentDir(agentDir);
mkdirSync(agentDir, { recursive: true });

// 런타임 선택 경로라 정적 import가 불가능하다(OMP_CORE_PATCH_TARGET 사본만 검증).
const { createAgentSession } = await import(`${CORE}/sdk.ts`);
const { createAssistantMessageEventStream } = await import(`${PACKAGES}/pi-ai/src/utils/event-stream.ts`);
const { getBundledModel } = await import(`${PACKAGES}/pi-catalog/src/models.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
// 비밀 아닌 placeholder. fake stream이 provider transport를 대체한다.
process.env.OPENAI_API_KEY = "<probe>";
const model = getBundledModel("openai", "gpt-4o-mini");
assert.ok(model, "fake transport용 bundled model이 필요하다");

const work = join(fixtureRoot, "work");
mkdirSync(work, { recursive: true });

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
type ProviderContext = { systemPrompt?: unknown; messages: unknown[] };

/** 첫 provider 호출이 eval cell을 부르고 두 번째 호출이 끝낸다. 두 번째 호출의 context에 eval 결과가 있다. */
function fakeStream(code: string, seen: ProviderContext[]) {
	let index = 0;
	return (_model: unknown, context: ProviderContext) => {
		const stream = createAssistantMessageEventStream();
		const call = index++;
		queueMicrotask(() => {
			if (call > 1) {
				stream.fail(new Error(`unexpected provider call #${call + 1}`));
				return;
			}
			seen.push(structuredClone({ systemPrompt: context.systemPrompt, messages: context.messages }));
			const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, usage: usage(), timestamp: Date.now() };
			if (call === 0) {
				const toolCall = { type: "toolCall" as const, id: "call-1", name: "eval", arguments: { language: "js", code } };
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

async function probe(settings: Record<string, unknown>) {
	const { session } = await createAgentSession({
		cwd: work,
		agentDir,
		settings: Settings.isolated(settings),
		model,
		getApiKey: () => "example",
		hasUI: false,
		disableExtensionDiscovery: true,
		extensions: [],
		enableLsp: false,
		enableMCP: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
	});
	const seen: ProviderContext[] = [];
	session.agent.streamFn = fakeStream(`console.log("TYPE=" + JSON.stringify(typeof commit));`, seen) as never;
	await session.prompt("확인만");
	await session.dispose();
	const results = (seen[1]?.messages ?? []).filter(
		(message): message is { role: string; content: Array<{ text?: string }> } =>
			typeof message === "object" && message !== null && "role" in message && message.role === "toolResult",
	);
	return {
		output: (results.at(-1)?.content ?? []).map(block => block.text ?? "").join(""),
		prompt: JSON.stringify(seen[0]?.systemPrompt ?? ""),
	};
}

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

// [1] 설정에 commit 키가 없는 프로필(클라우드·npm 설치): eval에 commit이 없고 system prompt도 안내하지 않는다.
const unset = await probe({});
check("[1] commit.enabled 미설정: eval에 commit 없음", unset.output.includes('TYPE="undefined"'), unset.output);
check("[1] commit.enabled 미설정: system prompt에 commit.draft 안내 없음", !unset.prompt.includes("commit.draft"));

// [2] 명시적으로 켠 사용자는 계속 쓸 수 있다(probe가 commit을 실제로 볼 수 있다는 대조군이기도 하다).
const enabled = await probe({ "commit.enabled": true });
check("[2] commit.enabled: true: eval에 commit 있음", enabled.output.includes('TYPE="object"'), enabled.output);

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
