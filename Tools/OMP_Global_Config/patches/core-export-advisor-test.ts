// HTML export가 advisor 내부 transcript를 싣지 않는지 본다. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-export-advisor-test.ts
// advisor는 `<session>/__advisor.jsonl`·`__advisor.<slug>.jsonl`(subagent advisor는 `<session>/<SubId>/__advisor.jsonl`)에
// 자기 프롬프트·검토를 기록한다. upstream exporter의 subagent 수집은 이 디렉터리의 `*.jsonl`을 전부 subSession으로 넣어,
// 내보낸 HTML에 advisor 검토가 그대로 들어간다(18.4.5, upstream #13908 미머지). 웹 route(`app/api/sessions/[id]/export`)는
// 번들 `dist/cli.js --export`를 먼저 실행하고, 세션 안 `/export`는 src exporter를 쓰므로 두 경로를 모두 실제로 돌린다.
// 18.4.x 미패치 core에서는 [0]·[1]·[2]의 advisor 검사가 FAIL(RED), 패치 core에서는 전부 PASS다. 18.5.0은 upstream이 같은 경계를
// 넣어(session/sub-sessions.ts) 순정에서도 PASS이고 패치는 no-op이다. 세션 JSONL은 읽기만 한다(삭제·수정 없음).
// 모델 호출·네트워크 없음. HOME/USERPROFILE은 임시 폴더로 격리한다.
// 동적 import 예외: core-bai-retry-test.ts와 같은 이유(지정한 사본만 검증).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 전역 npm 위치는 PC마다 다르다. apply-core-patch.mjs와 같은 순서로 찾는다. */
function resolvePackage(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(p => existsSync(join(p, "src/export/html/index.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	return hit.replace(/\\/g, "/");
}

const PKG = resolvePackage();
console.log(`대상 ${PKG}`);
const exporter = await import(`${PKG}/src/export/html/index.ts`);
const { exportFromFile } = exporter;
// 18.5.0은 수집 함수를 `session/sub-sessions.ts`로 옮겼다(export/html은 내부 래퍼만 둔다). 두 판 모두 같은 수집 경계를 본다.
const collectSubSessions = exporter.collectSubSessions
	?? (await import(`${PKG}/src/session/sub-sessions.ts`)).collectSubSessions;

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

const PARENT = "PARENT-KEEP-7c1a";
const PARENT_NOTE = "PARENT-ADVISOR-NOTE-2d8e";
const CHILD = "CHILD-KEEP-4b2f";
const NESTED = "NESTED-KEEP-9d3c";
const ADVISOR = ["ADVISOR-PROMPT-e5f1", "ADVISOR-REVIEW-slug-a6b2", "ADVISOR-REVIEW-sub-c7d3"];

const workdir = mkdtempSync(join(tmpdir(), "omp-export-advisor-"));
const home = join(workdir, "home");
mkdirSync(home, { recursive: true });

let clock = Date.parse("2026-10-01T00:00:00.000Z");
const at = () => new Date((clock += 1000)).toISOString();
function sessionFile(file: string, id: string, messages: Array<Record<string, unknown>>): string[] {
	const ids: string[] = [];
	const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: at(), cwd: workdir })];
	let parentId: string | null = null;
	for (const [index, message] of messages.entries()) {
		const entryId = `${id}-${index}`;
		lines.push(JSON.stringify({ type: "message", id: entryId, parentId, timestamp: at(), message: { timestamp: clock, ...message } }));
		ids.push(entryId);
		parentId = entryId;
	}
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
	return ids;
}
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5-5",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
});

// 부모 대화: 사용자·assistant와, 부모에게 실제로 전달된 advisor 메시지(부모 대화의 일부라 유지 대상).
const main = join(workdir, "sessions", "main.jsonl");
const mainIds = sessionFile(main, "main", [
	user(`${PARENT} 사용자 요청`),
	{ role: "custom", customType: "advisor", content: `${PARENT_NOTE} 부모에게 전달된 조언`, display: true },
	assistant(`${PARENT} 답변`),
]);
const dir = main.slice(0, -".jsonl".length);
sessionFile(join(dir, "Scout.jsonl"), "scout", [user(`${CHILD} 과제`), assistant(`${CHILD} 결과`)]);
sessionFile(join(dir, "Scout", "Helper.jsonl"), "helper", [user(`${NESTED} 과제`), assistant(`${NESTED} 결과`)]);
// advisor 내부 기록: 기본 advisor, 이름 있는 advisor, subagent advisor.
sessionFile(join(dir, "__advisor.jsonl"), "adv", [user(`${ADVISOR[0]} 내부 프롬프트`), assistant(`${ADVISOR[0]} 검토`)]);
sessionFile(join(dir, "__advisor.reviewer.jsonl"), "adv-reviewer", [user(`${ADVISOR[1]} 프롬프트`), assistant(`${ADVISOR[1]} 검토`)]);
sessionFile(join(dir, "Scout", "__advisor.jsonl"), "adv-sub", [user(`${ADVISOR[2]} 프롬프트`), assistant(`${ADVISOR[2]} 검토`)]);
const fixtureFiles = [main, join(dir, "Scout.jsonl"), join(dir, "Scout", "Helper.jsonl"), join(dir, "__advisor.jsonl"), join(dir, "__advisor.reviewer.jsonl"), join(dir, "Scout", "__advisor.jsonl")];
const before = new Map(fixtureFiles.map(file => [file, readFileSync(file, "utf8")]));

/** 검사에 쓰는 내보낸 세션 JSON의 부분 모양(viewer가 읽는 `SessionData`). */
interface ExportedSession {
	entries?: Array<{ id: string }>;
	subSessions?: Record<string, unknown>;
}

/** 내보낸 HTML에 내장된 세션 JSON(base64)을 푼다. 원문 HTML과 함께 검사해 base64 우회도 막는다. */
function decodeExport(file: string): { raw: string; data: ExportedSession } {
	const raw = readFileSync(file, "utf8");
	const match = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(raw);
	if (!match) throw new Error(`session-data를 찾지 못했다: ${file}`);
	// 방금 이 테스트가 만든 export다. 모양이 달라지면 아래 검사가 FAIL로 드러난다.
	return { raw, data: JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as ExportedSession };
}

function verify(label: string, file: string): void {
	const { raw, data } = decodeExport(file);
	const text = `${raw}\n${JSON.stringify(data)}`;
	const keys = Object.keys(data.subSessions ?? {}).sort();
	check(`${label} advisor 프롬프트·검토 sentinel이 없다`, ADVISOR.every(s => !text.includes(s)), `found=${ADVISOR.filter(s => text.includes(s))} keys=${keys}`);
	check(`${label} 진짜 subagent·중첩 subagent는 남는다`, keys.join(",") === "Scout,Scout/Helper" && text.includes(CHILD) && text.includes(NESTED), `keys=${keys}`);
	const exportedIds = (data.entries ?? []).map(entry => entry.id);
	check(
		`${label} 부모 대화 entry는 그대로다(부모에게 전달된 advisor 메시지 포함)`,
		mainIds.every(id => exportedIds.includes(id)) && text.includes(PARENT) && text.includes(PARENT_NOTE),
		`ids=${exportedIds}`,
	);
}

try {
	console.log("\n[0] 수집 경계");
	const keys = Object.keys(await collectSubSessions(main)).sort();
	check("[0] collectSubSessions는 advisor transcript를 subSession으로 넣지 않는다", keys.join(",") === "Scout,Scout/Helper", `keys=${keys}`);

	console.log("\n[1] SDK exporter(src exportFromFile — 세션 안 /export와 같은 수집)");
	const sdkOut = join(workdir, "sdk.html");
	await exportFromFile(main, sdkOut);
	verify("[1]", sdkOut);

	console.log("\n[2] 번들 CLI(dist/cli.js --export — 웹 route가 먼저 쓰는 경로)");
	const cli = join(PKG, "dist", "cli.js");
	const cliOut = join(workdir, "cli.html");
	const run = spawnSync(process.execPath, [cli, "--export", main, cliOut], {
		cwd: workdir,
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, HOME: home, USERPROFILE: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
	});
	check("[2] CLI export가 종료 코드 0으로 끝난다", run.status === 0 && existsSync(cliOut), `status=${run.status} stderr=${(run.stderr ?? "").slice(0, 400)}`);
	if (existsSync(cliOut) && statSync(cliOut).size > 0) verify("[2]", cliOut);

	check("[3] export는 세션 JSONL을 바꾸거나 지우지 않는다", fixtureFiles.every(file => existsSync(file) && readFileSync(file, "utf8") === before.get(file)));
} finally {
	rmSync(workdir, { recursive: true, force: true });
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
