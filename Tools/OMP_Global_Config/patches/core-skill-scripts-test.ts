// 관리 스킬 스크립트(manage_skill write_script/delete_script + eval `skills` prelude) 실제 AgentSession 회귀.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-skill-scripts-test.ts
// 세션 1이 manage_skill로 스킬과 스크립트를 저장하고, 새로 연 세션 2의 eval(JS·Python)이 그 스크립트를 읽어 실행한다.
// 모델은 fake stream이다. 미패치 core에서는 write_script가 스키마에서 거절돼 [1]부터 실패(RED)한다.
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (!process.env.OMP_SKILL_SCRIPTS_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-skill-scripts-"));
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
				OMP_SKILL_SCRIPTS_FIXTURE_ROOT: root,
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
if (!existsSync(join(CORE, "tools/manage-skill.ts"))) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
const PACKAGES = resolve(dirname(CORE), "..").replace(/\\/g, "/");
const fixtureRoot = process.env.OMP_SKILL_SCRIPTS_FIXTURE_ROOT!;
const agentDir = join(fixtureRoot, "home", ".omp", "agent");
const { setAgentDir } = await import(`${PACKAGES}/pi-utils/src/dirs.ts`);
setAgentDir(agentDir);
mkdirSync(agentDir, { recursive: true });

// 런타임 선택 경로라 정적 import가 불가능하다(OMP_CORE_PATCH_TARGET 사본만 검증).
const { createAgentSession } = await import(`${CORE}/sdk.ts`);
const { createAssistantMessageEventStream } = await import(`${PACKAGES}/pi-ai/src/utils/event-stream.ts`);
const { getBundledModel } = await import(`${PACKAGES}/pi-catalog/src/models.ts`);
const { validateAgentToolArguments } = await import(`${PACKAGES}/pi-agent-core/src/index.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
process.env.OPENAI_API_KEY = "<probe>";
const model = getBundledModel("openai", "gpt-4o-mini");
assert.ok(model, "fake transport용 bundled model이 필요하다");

const work = join(fixtureRoot, "work");
mkdirSync(work, { recursive: true });
const managedRoot = join(agentDir, "managed-skills");
// 사용자가 쓴 스킬: 같은 이름의 관리 스킬 스크립트 저장은 거절되고 이 파일은 그대로여야 한다.
const authoredDir = join(agentDir, "skills", "authored-one");
mkdirSync(authoredDir, { recursive: true });
const authoredSkill = "---\nname: authored-one\ndescription: User authored skill used by the script test.\n---\n\nAuthored body.\n";
writeFileSync(join(authoredDir, "SKILL.md"), authoredSkill);
const outside = join(fixtureRoot, "outside");
mkdirSync(outside);
writeFileSync(join(outside, "secret.ts"), "export const secret = 1;\n");

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
type ProviderContext = { messages: unknown[] };
type Call = { name: string; args: Record<string, unknown> };

/** 도구 호출을 차례로 내보내고 그다음엔 "ok"로 끝낸다. 각 provider 호출의 대화를 기록한다. */
function fakeStream(calls: Call[], seen: ProviderContext[]) {
	let index = 0;
	return (_model: unknown, context: ProviderContext) => {
		const stream = createAssistantMessageEventStream();
		const call = calls[index++];
		queueMicrotask(() => {
			seen.push(structuredClone({ messages: context.messages }));
			const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, usage: usage(), timestamp: Date.now() };
			if (call) {
				const toolCall = { type: "toolCall" as const, id: `call-${index}`, name: call.name, arguments: call.args };
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
async function open(settings: Record<string, unknown>) {
	return createAgentSession({
		cwd: work,
		agentDir,
		settings: Settings.isolated(settings),
		model,
		getApiKey: () => "example",
		hasUI: false,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		rules: [],
		contextFiles: [],
	});
}
type Session = Awaited<ReturnType<typeof open>>["session"];
async function turn(session: Session, prompt: string, calls: Call[]) {
	const seen: ProviderContext[] = [];
	session.agent.streamFn = fakeStream(calls, seen) as never;
	await session.prompt(prompt);
	return seen;
}
/** 대화에 들어간 tool 결과 본문, 오래된 것부터. */
const toolResults = (context: ProviderContext | undefined) =>
	(context?.messages ?? [])
		.filter((message): message is { role: string; content: Array<{ text?: string }> } =>
			typeof message === "object" && message !== null && (message as { role?: string }).role === "toolResult",
		)
		.map(message => message.content.map(block => block.text ?? "").join(""));

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

// [1] 세션 1: 모델이 manage_skill로 스킬을 만들고 검증된 코드를 스크립트로 저장한다(agent loop의 스키마 검증 포함).
const one = await open({ "autolearn.enabled": true });
const tsSource = "export function sum(values: number[]): number {\n\treturn values.reduce((total, value) => total + value, 0);\n}\n";
const pySource = "def total(values):\n    return sum(values)\n";
const saved = await turn(one.session, "이 합계 코드를 재사용하게 저장해줘", [
	{ name: "manage_skill", args: { action: "create", name: "row-tools", description: "Sum helper for table rows.", body: "Use scripts/sum.ts or scripts/sum.py." } },
	{ name: "manage_skill", args: { action: "write_script", name: "row-tools", script: "sum.ts", content: tsSource } },
	{ name: "manage_skill", args: { action: "write_script", name: "row-tools", script: "scripts/sum.py", content: pySource } },
]);
const savedResults = toolResults(saved.at(-1));
evidence.saveResults = savedResults;
check("[1a] create 결과 문구는 기존 그대로", savedResults[0]?.startsWith('Created managed skill "row-tools" (managed-skills/row-tools/SKILL.md).') === true, savedResults[0]);
check("[1b] write_script 저장 결과", savedResults[1]?.startsWith("Saved skill://row-tools/scripts/sum.ts.") === true && savedResults[2]?.startsWith("Saved skill://row-tools/scripts/sum.py.") === true, savedResults);
const scriptsDir = join(managedRoot, "row-tools", "scripts");
check(
	"[1c] 파일은 관리 스킬 폴더 scripts/ 아래에만 생긴다",
	existsSync(scriptsDir) &&
		readFileSync(join(scriptsDir, "sum.ts"), "utf8") === tsSource &&
		readFileSync(join(scriptsDir, "sum.py"), "utf8") === pySource &&
		JSON.stringify(readdirSync(scriptsDir).sort()) === JSON.stringify(["sum.py", "sum.ts"]),
	existsSync(scriptsDir) ? readdirSync(scriptsDir) : "missing",
);

// 미패치 core에는 scripts/ 가 없어 아래 거절 검증을 진행할 수 없다(RED는 [1]에서 끝난다).
if (!existsSync(scriptsDir)) {
	console.log(`\n${pass} pass / ${fail} fail`);
	process.exit(1);
}
// [2] 경로·크기·확장자·대상 거절. 실제 도구 execute로 부른다(모델 호출과 같은 구현).
const tool = one.session.getToolByName("manage_skill");
assert.ok(tool, "manage_skill tool이 있어야 한다");
const attempt = async (args: Record<string, unknown>) => {
	try {
		const result = await tool.execute("probe", args, undefined, undefined, undefined);
		return { ok: result.isError !== true, text: result.content.map((block: { text?: string }) => block.text ?? "").join("") };
	} catch (error) {
		return { ok: false, text: error instanceof Error ? error.message : String(error) };
	}
};
const rejected: Record<string, string> = {};
for (const [label, script] of [
	["traversal", "../evil.ts"],
	["nested", "sub/evil.ts"],
	["absolute", "/tmp/evil.ts"],
	["extension", "evil.sh"],
	["uppercase", "Evil.ts"],
	["dotfile", ".evil.ts"],
] as const) {
	const result = await attempt({ action: "write_script", name: "row-tools", script, content: "export {};\n" });
	rejected[label] = result.text;
	check(`[2a] script 이름 거절: ${label}`, !result.ok && result.text.includes("Invalid script name"), result.text);
}
const big = await attempt({ action: "write_script", name: "row-tools", script: "big.ts", content: "x".repeat(64_001) });
check("[2b] 64 KB 초과 거절", !big.ok && big.text.includes("the limit is 64000"), big.text);
const ghost = await attempt({ action: "write_script", name: "ghost", script: "a.ts", content: "export {};\n" });
check("[2c] 없는 관리 스킬 거절(폴더 생성 없음)", !ghost.ok && ghost.text.includes("does not exist") && !existsSync(join(managedRoot, "ghost")), ghost.text);
const authored = await attempt({ action: "write_script", name: "authored-one", script: "a.ts", content: "export {};\n" });
check(
	"[2d] 사용자가 쓴 스킬 이름은 거절, 원본 그대로",
	!authored.ok && authored.text.includes("authored skill") && readFileSync(join(authoredDir, "SKILL.md"), "utf8") === authoredSkill && !existsSync(join(authoredDir, "scripts")),
	authored.text,
);
// 관리 스킬의 scripts/ 가 바깥 폴더를 가리키는 symlink면 쓰지 않는다.
mkdirSync(join(managedRoot, "linked"));
writeFileSync(join(managedRoot, "linked", "SKILL.md"), "---\nname: linked\ndescription: Linked scripts dir.\n---\n\nBody.\n");
symlinkSync(outside, join(managedRoot, "linked", "scripts"));
const linkedDir = await attempt({ action: "write_script", name: "linked", script: "secret.ts", content: "export const secret = 2;\n" });
check("[2e] symlink scripts/ 거절·바깥 파일 그대로", !linkedDir.ok && readFileSync(join(outside, "secret.ts"), "utf8") === "export const secret = 1;\n", linkedDir.text);
// hard link로 바깥 파일과 이어진 스크립트는 덮어쓰지 않는다.
linkSync(join(outside, "secret.ts"), join(scriptsDir, "shared.ts"));
const hard = await attempt({ action: "write_script", name: "row-tools", script: "shared.ts", content: "export const secret = 3;\n" });
check("[2f] hard link 스크립트 덮어쓰기 거절", !hard.ok && hard.text.includes("single-link") && readFileSync(join(outside, "secret.ts"), "utf8") === "export const secret = 1;\n", hard.text);
rmSync(join(scriptsDir, "shared.ts"));
for (let index = readdirSync(scriptsDir).length; index < 16; index++) {
	await attempt({ action: "write_script", name: "row-tools", script: `filler-${index}.ts`, content: "export {};\n" });
}
const seventeenth = await attempt({ action: "write_script", name: "row-tools", script: "one-more.ts", content: "export {};\n" });
check("[2g] 스크립트 16개 상한", !seventeenth.ok && seventeenth.text.includes("already has 16 scripts") && readdirSync(scriptsDir).length === 16, seventeenth.text);
for (const name of readdirSync(scriptsDir).filter(file => file.startsWith("filler-"))) {
	const removed = await attempt({ action: "delete_script", name: "row-tools", script: name });
	if (!removed.ok) check(`[2h] filler 삭제 ${name}`, false, removed.text);
}
check("[2h] delete_script는 그 파일만 지운다", JSON.stringify(readdirSync(scriptsDir).sort()) === JSON.stringify(["sum.py", "sum.ts"]), readdirSync(scriptsDir));
evidence.rejections = { ...rejected, big: big.text, ghost: ghost.text, authored: authored.text, linked: linkedDir.text, hard: hard.text, seventeenth: seventeenth.text };

// [3] 스키마: 새 action은 필요한 칸을 요구하고, 기존 create/update 문구는 그대로다.
const validate = (args: Record<string, unknown>) => {
	try {
		validateAgentToolArguments(tool, { type: "toolCall", id: "v", name: "manage_skill", arguments: args }, "payload");
		return "ok";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};
const noContent = validate({ action: "write_script", name: "row-tools", script: "a.ts" });
const noScript = validate({ action: "delete_script", name: "row-tools" });
const noBody = validate({ action: "create", name: "x", description: "d" });
evidence.schemaErrors = { noContent, noScript, noBody };
check("[3a] write_script는 script·content를 요구", noContent.includes('"script" and "content"'), noContent);
check("[3b] delete_script는 script를 요구", noScript.includes('"script" for "delete_script"'), noScript);
check("[3c] create 누락 문구는 기존 그대로", noBody.includes('used with both "description" and "body" for "create" and "update"'), noBody);
check("[3d] delete는 여전히 name만으로 통과", validate({ action: "delete", name: "x" }) === "ok");
// 일반 import처럼 모듈 자신을 찾는 코드(postponed annotation dataclass)도 불러와야 한다.
const rowsPy = "from __future__ import annotations\nfrom dataclasses import dataclass\n\n@dataclass\nclass Row:\n    value: int\n";
const rowsSaved = await attempt({ action: "write_script", name: "row-tools", script: "rows.py", content: rowsPy });
assert.ok(rowsSaved.ok, rowsSaved.text);
await one.session.dispose();

// [4] 새 세션 2: eval이 저장된 스크립트를 skill:// 로 찾아 JS·Python에서 실행한다.
const two = await open({});
const jsCode = `
const mod = await skills.load("skill://row-tools/scripts/sum.ts");
const path = await skills.path("row-tools", "sum.ts");
let traversal = "accepted";
try { await skills.path("skill://row-tools/scripts/../SKILL.md"); } catch (error) { traversal = String(error.message); }
let escape = "accepted";
try { await skills.path("skill://linked/scripts/secret.ts"); } catch (error) { escape = String(error.message); }
console.log("JS=" + JSON.stringify({ sum: mod.sum([1, 2, 3, 4]), path, traversal, escape }));
`;
const jsSeen = await turn(two.session, "저장한 합계 스크립트로 계산해줘", [{ name: "eval", args: { language: "js", code: jsCode } }]);
const jsOut = toolResults(jsSeen.at(-1)).at(-1) ?? "";
const jsLine = jsOut.split("\n").find(line => line.startsWith("JS="));
const js = jsLine ? JSON.parse(jsLine.slice(3)) : undefined;
evidence.jsOutput = jsOut;
check("[4a] 새 세션 JS eval이 저장된 .ts 스크립트를 import해 실행", js?.sum === 10, jsOut);
check("[4b] skills.path는 관리 스킬 scripts/ 실제 경로", typeof js?.path === "string" && js.path.endsWith("/managed-skills/row-tools/scripts/sum.ts"), js?.path);
check("[4c] skill:// 경로 탈출(..)은 거절", typeof js?.traversal === "string" && js.traversal.includes("Invalid script name"), js?.traversal);
check("[4d] 스킬 바깥을 가리키는 symlink 스크립트는 거절", typeof js?.escape === "string" && js.escape !== "accepted", js?.escape);
const pySeen = await turn(two.session, "파이썬으로도", [
	{
		name: "eval",
		args: {
			language: "py",
			code: [
				'mod = await skills.load("skill://row-tools/scripts/sum.py")',
				'print("PY=" + str(mod.total([1, 2, 3])))',
				"try:",
				'    rows = await skills.load("row-tools", "rows.py")',
				'    print("ROW=" + str(rows.Row(1).value))',
				"except Exception as error:",
				'    print("ROWERR=" + repr(error))',
			].join("\n"),
		},
	},
]);
const pyOut = toolResults(pySeen.at(-1)).at(-1) ?? "";
evidence.pyOutput = pyOut;
check("[4e] 새 세션 Python eval이 저장된 .py 스크립트를 import해 실행", pyOut.includes("PY=6"), pyOut);
check("[4f] Python 모듈은 sys.modules에 등록돼 dataclass 같은 일반 import 코드도 동작", pyOut.includes("ROW=1"), pyOut);
await two.session.dispose();

// [5] 기존 update/delete 동작: SKILL.md만 바꾸고 스크립트는 그대로, delete는 폴더째 지운다.
const three = await open({ "autolearn.enabled": true });
const tool3 = three.session.getToolByName("manage_skill");
const updated = await tool3.execute("u", { action: "update", name: "row-tools", description: "Sum helper v2.", body: "Updated body." }, undefined, undefined, undefined);
const updatedText = updated.content.map((block: { text?: string }) => block.text ?? "").join("");
check(
	"[5a] update 문구·SKILL.md 갱신, 스크립트 유지",
	updatedText === 'Updated managed skill "row-tools" (managed-skills/row-tools/SKILL.md).' &&
		readFileSync(join(managedRoot, "row-tools", "SKILL.md"), "utf8").includes("Updated body.") &&
		existsSync(join(scriptsDir, "sum.ts")),
	updatedText,
);
await tool3.execute("d", { action: "delete", name: "row-tools" }, undefined, undefined, undefined);
check("[5b] delete는 스크립트까지 관리 스킬 폴더를 지운다", !existsSync(join(managedRoot, "row-tools")));
await three.session.dispose();

const out = process.env.OMP_SKILL_SCRIPTS_EVIDENCE;
if (out) writeFileSync(out, JSON.stringify(evidence, null, 2));
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
