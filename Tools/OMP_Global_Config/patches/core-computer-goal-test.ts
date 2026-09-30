// computer.run 목표 대기 회귀(2026-09-30): 행동은 사용자 코드에서 한 번, 목표는 wait(predicate)가 로컬 읽기로만 확인한다.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-computer-goal-test.ts
// 실제 ComputerWorkerCore run 경로에 가짜 native session을 붙인다. 모델·설치본·실제 데스크톱·호스트 클립보드는 건드리지 않는다:
// 클립보드 모듈은 mock.module spy 로 바꾸고, 그 spy 가 worker 경로에 연결된 것을 확인하기 전에는 clipboard 를 부르지 않는다.
// 간격 기본값은 Playwright pollAgainstDeadline([100, 250, 500, 1000]) 을 따른다:
// https://github.com/microsoft/playwright/blob/main/packages/isomorphic/timeoutRunner.ts
import { mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live registry");
const core = resolve(target, "src");
// screenshot 은 os.tmpdir() 에 PNG 를 쓴다. 이 실행 전용 폴더로 돌려 두고 끝에 지운다.
const scratch = mkdtempSync(join(tmpdir(), "omp-computer-goal-"));
for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = scratch;
const clipboardWrites: string[] = [];
const noHostClipboard = async () => {
	throw new Error("host clipboard is not available in this test");
};
const clipboardSpy = {
	copyToClipboard: async (text: string) => void clipboardWrites.push(text),
	readTextFromClipboard: noHostClipboard,
	readImageFromClipboard: noHostClipboard,
	readMacFileUrlsFromClipboard: noHostClipboard,
};
// worker 는 clipboard 를 "../../utils/clipboard" 로 lazy import 한다. 같은 해석 경로를 spy 로 바꾼다.
mock.module(`${core}/utils/clipboard.ts`, () => clipboardSpy);
const clipboardWired = (await import(`${core}/tools/computer/../../utils/clipboard`)).copyToClipboard === clipboardSpy.copyToClipboard;
// 대상 코어는 OMP_CORE_PATCH_TARGET 으로 실행 때 정해지므로 정적 import 로 쓸 수 없다.
const { ComputerWorkerCore } = await import(`${core}/tools/computer/worker.ts`);

const realConsole = globalThis.console; // worker run 이 전역 console 을 run 출력으로 돌려놓는다
let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (ok) passed++;
	else failed++;
	realConsole.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};

// 가짜 앱: Save 를 누르면 goalDelay 뒤 "Saved row 1" 행이 나타난다(음수면 끝내 나타나지 않는 잘못된 화면).
const state = {
	clicks: 0,
	goalDelay: 0,
	goalVisible: false,
	rowProbes: [] as number[],
	afterSlowReads: 0,
	windowLists: 0,
	captures: 0,
	slowMs: 0,
};
const reset = (goalDelay: number) => {
	Object.assign(state, { clicks: 0, goalDelay, goalVisible: false, rowProbes: [], afterSlowReads: 0, windowLists: 0, captures: 0, slowMs: 0 });
};
type FakeNode = { ref: string; role: string; nativeRole: string; title: string; enabled: boolean; focused: boolean; childCount: number; x: number; y: number; width: number; height: number; actions: string[] };
const node = (ref: string, role: string, title: string): FakeNode => ({ ref, role, nativeRole: role, title, enabled: true, focused: false, childCount: 0, x: 0, y: 0, width: 80, height: 20, actions: ["press"] });
const nodes: Record<string, FakeNode> = {
	e1: node("e1", "button", "Save"),
	e2: node("e2", "row", "Saved row 1"),
	e3: node("e3", "text", "Slow status"),
	e4: node("e4", "text", "Broken"),
};
const press = () => {
	state.clicks++;
	if (state.goalDelay === 0) state.goalVisible = true;
	else if (state.goalDelay > 0) setTimeout(() => (state.goalVisible = true), state.goalDelay);
};
const session = {
	capabilities: {},
	listDisplays: async () => [],
	listWindows: async () => {
		state.windowLists++;
		return [{ id: "w1", app: "Fixture", title: "Goal Fixture", x: 0, y: 0, width: 400, height: 300, focused: false }];
	},
	capture: async () => {
		state.captures++;
		return { data: new Uint8Array(4), width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, target: "w1" };
	},
	axQuery: async (_target: string, query: { title?: string }) => {
		if (query.title === "Save") return [nodes.e1];
		if (query.title === "Saved row 1") {
			state.rowProbes.push(performance.now());
			return state.goalVisible ? [nodes.e2] : [];
		}
		if (query.title === "Slow status") return [nodes.e3];
		if (query.title === "Broken") return [nodes.e4];
		if (query.title === "after-slow") state.afterSlowReads++;
		return [];
	},
	axNode: async (ref: string) => {
		if (ref === "e3" && state.slowMs > 0) await Bun.sleep(state.slowMs);
		if (ref === "e4") throw new Error("Internal: UIA element not available");
		return nodes[ref]!;
	},
	axAttributes: async () => [],
	axParent: async () => null,
	axChildren: async () => [],
	axPerform: async () => press(),
	axClick: async () => press(),
	close: async () => {},
};

type RunError = { message: string; isAbort?: boolean; isToolError?: boolean };
type RunResult = { ok: boolean; payload?: { returnValue: unknown; displays?: unknown[] }; error?: RunError; ms: number };
const waiters = new Map<string, (result: Omit<RunResult, "ms">) => void>();
const toolCalls: string[] = [];
let deliver: (message: unknown) => void = () => {};
const transport = {
	send: (message: { type: string; id?: string; name?: string } & Omit<RunResult, "ms">) => {
		if (message.type === "result" && message.id) waiters.get(message.id)?.(message);
		if (message.type === "tool-call" && message.id) {
			toolCalls.push(message.name ?? "");
			deliver({ type: "tool-reply", id: message.id, reply: { ok: true, value: "tool ran" } });
		}
	},
	onMessage: (handler: (message: unknown) => void) => {
		deliver = handler;
		return () => {};
	},
	close: () => {},
};
new ComputerWorkerCore(transport, () => session);
const snapshot = { cwd: process.cwd(), sessionId: "computer-goal", captureMaxWidth: 100, captureMaxHeight: 100, display: "", readOnly: false };
let runs = 0;
const keepAlive = setInterval(() => {}, 1000);
/** Starts a run; `abortAfter` sends the supervisor abort for that run (0 = synchronously, before any await). */
const run = (code: string, options: { abortAfter?: number; timeoutMs?: number } = {}) => {
	const id = `goal-${++runs}`;
	const started = performance.now();
	const { promise: done, resolve: resolveRun } = Promise.withResolvers<RunResult>();
	waiters.set(id, result => resolveRun({ ...result, ms: performance.now() - started }));
	deliver({ type: "run", id, code, timeoutMs: options.timeoutMs ?? 10_000, session: snapshot });
	if (options.abortAfter === 0) deliver({ type: "abort", id });
	else if (options.abortAfter !== undefined) setTimeout(() => deliver({ type: "abort", id }), options.abortAfter);
	return done;
};
const show = (result: RunResult) => JSON.stringify({ ok: result.ok, value: result.payload?.returnValue, error: result.error?.message, isAbort: result.error?.isAbort, ms: Math.round(result.ms) });
const prologue = `const win = await desktop.window({ title: "Goal Fixture" });
const [save] = await win.find({ title: "Save" });
const rowTitle = async () => (await win.find({ title: "Saved row 1" }))[0]?.title;`;

realConsole.log("[1] 즉시·지연 목표: 클릭 1회 뒤 로컬 읽기로 목표를 확인하고 값만 돌려준다");
{
	reset(0);
	const immediate = await run(`${prologue}
const action = await save.press();
return { action: action.action, row: await wait(rowTitle, { timeout: 2000 }) };`);
	check("즉시 목표: 값을 돌려주고 클릭 1회·probe 1회", immediate.ok && JSON.stringify(immediate.payload?.returnValue) === '{"action":"press","row":"Saved row 1"}' && state.clicks === 1 && state.rowProbes.length === 1, `${show(immediate)} clicks=${state.clicks} probes=${state.rowProbes.length}`);

	reset(600);
	const delayed = await run(`${prologue}
await save.press();
return await wait(rowTitle, { timeout: 3000 });`);
	const gaps = state.rowProbes.slice(1).map((at, index) => at - state.rowProbes[index]!);
	check("지연 목표: 600ms 뒤 나타난 행을 찾고 클릭은 1회", delayed.ok && delayed.payload?.returnValue === "Saved row 1" && state.clicks === 1, `${show(delayed)} clicks=${state.clicks}`);
	// 고정 100ms 였다면 600ms 목표까지 7회 이상 읽는다. 점진적 간격이면 0·100·350·850ms 로 4회다.
	check("간격 기본값은 점진적이다(100→250→500ms)", state.rowProbes.length >= 2 && state.rowProbes.length <= 5 && gaps.length >= 2 && gaps[1]! > gaps[0]! + 60, `probes=${state.rowProbes.length} gaps=${gaps.map(Math.round).join(",")}`);

	reset(300);
	const fixed = await run(`${prologue}
await save.press();
return await wait(rowTitle, { timeout: 3000, interval: 50 });`);
	check("interval 을 주면 그 고정 간격으로 읽는다", fixed.ok && state.rowProbes.length >= 5 && state.clicks === 1, `${show(fixed)} probes=${state.rowProbes.length}`);
}

realConsole.log("[2] 잘못된 화면·timeout: 목표 미달은 timeout 오류이고 재클릭하지 않는다");
{
	reset(-1);
	const wrong = await run(`${prologue}
await save.press();
return await wait(rowTitle, { timeout: 700 });`);
	check("목표 미달은 이름 붙은 timeout ToolError 다(취소 아님)", !wrong.ok && /^wait\(predicate\) timed out after 700ms — predicate never returned truthy \(\d+ probes(; the probe still running at the deadline was abandoned)?\)$/.test(wrong.error?.message ?? "") && wrong.error?.isAbort === false && wrong.error?.isToolError === true, show(wrong));
	check("목표 미달이어도 클릭은 1회뿐이다", state.clicks === 1, `clicks=${state.clicks}`);
	check("deadline 직전까지 읽는다(700ms 창에서 600ms 이상)", wrong.ms >= 600 && wrong.ms < 2000, show(wrong));
	// 동기 predicate 는 timer 보다 늦게 끝날 수 있다. deadline 을 넘겨 끝난 probe 는 truthy 여도 성공이 아니다.
	const late = await run(`return await wait(() => { const until = Date.now() + 300; while (Date.now() < until); return "late"; }, { timeout: 100 });`);
	check("deadline 을 넘겨 끝난 probe 의 truthy 값은 성공으로 치지 않는다", !late.ok && /^wait\(predicate\) timed out after 100ms — predicate never returned truthy \(1 probe; the probe still running at the deadline was abandoned\)$/.test(late.error?.message ?? ""), show(late));
}

realConsole.log("[3] 취소: 실행 전 취소는 클릭 0회, 대기 중 취소는 클릭 1회이고 뒤이은 읽기가 없다");
{
	reset(-1);
	const before = await run(`${prologue}
await save.press();
return await wait(rowTitle, { timeout: 2000 });`, { abortAfter: 0 });
	check("실행 전 취소: 취소로 끝나고 클릭 0회", !before.ok && before.error?.isAbort === true && state.clicks === 0, `${show(before)} clicks=${state.clicks}`);

	reset(-1);
	const during = await run(`${prologue}
await save.press();
return await wait(rowTitle, { timeout: 5000 });`, { abortAfter: 400 });
	const probesAtAbort = state.rowProbes.length;
	await Bun.sleep(1500);
	check("대기 중 취소: timeout 이 아니라 취소로 끝나고 클릭 1회", !during.ok && during.error?.isAbort === true && state.clicks === 1 && during.ms < 1500, `${show(during)} clicks=${state.clicks}`);
	check("취소 뒤 목표 읽기가 더 일어나지 않는다", state.rowProbes.length === probesAtAbort, `at-abort=${probesAtAbort} later=${state.rowProbes.length}`);
}

realConsole.log("[4] 느린 read: deadline 에 진행 중 probe 를 버리고, 늦게 끝난 read 의 continuation 은 읽지도 행동하지도 못한다");
{
	reset(-1);
	state.slowMs = 1500;
	const slow = await run(`${prologue}
const [status] = await win.find({ title: "Slow status" });
await save.press();
return await wait(async () => {
	await status.value();
	await win.find({ title: "after-slow" });
	await save.press();
	return true;
}, { timeout: 400 });`);
	check("deadline 에 바로 timeout 으로 끝나고 진행 중 probe 를 버렸다고 말한다", !slow.ok && /timed out after 400ms .*\(1 probe; the probe still running at the deadline was abandoned\)/.test(slow.error?.message ?? "") && slow.ms < 1200, show(slow));
	await Bun.sleep(1600);
	check("늦게 끝난 read 뒤의 읽기·클릭이 실행되지 않는다", state.afterSlowReads === 0 && state.clicks === 1, `afterSlowReads=${state.afterSlowReads} clicks=${state.clicks}`);

	reset(0);
	const leaked = await run(`${prologue}
await save.press();
const row = await wait(async () => {
	setTimeout(() => void desktop.windows().catch(() => {}), 200);
	return await rowTitle();
});
await wait(500);
return row;`);
	await Bun.sleep(100);
	check("성공한 probe 가 남긴 지연 read 도 wait 가 끝나면 실행되지 않는다", leaked.ok && state.windowLists === 1, `${show(leaked)} windowLists=${state.windowLists}`);
}

realConsole.log("[5] probe 는 읽기만 한다: 입력·clipboard 쓰기·도구 호출은 실행 전에 거절하고, screenshot 은 이미지를 붙이지 않는다");
{
	for (const [label, body] of [
		["press", "await save.press();"],
		["type", 'await win.type("x");'],
	] as const) {
		reset(0);
		const refused = await run(`${prologue}
await save.press();
return await wait(async () => { ${body} return true; }, { timeout: 2000 });`);
		check(`probe 안 ${label} 는 거절되고 클릭은 바깥 1회뿐`, !refused.ok && refused.error?.message.startsWith(`wait(predicate) probe cannot run '${label}'`) === true && state.clicks === 1, `${show(refused)} clicks=${state.clicks}`);
	}
	check("clipboard spy 가 worker 해석 경로에 연결됐다(아니면 clipboard 케이스를 부르지 않는다)", clipboardWired);
	if (clipboardWired) {
		reset(0);
		const probeWrite = await run(`return await wait(async () => { await desktop.clipboard.write("probe"); return true; }, { timeout: 2000 });`);
		check("probe 안 clipboard.write 는 거절되고 쓰기가 일어나지 않는다", !probeWrite.ok && /wait\(predicate\) probe cannot run 'clipboard\.write'/.test(probeWrite.error?.message ?? "") && clipboardWrites.length === 0, `${show(probeWrite)} writes=${clipboardWrites.join(",")}`);
		const outsideWrite = await run(`await desktop.clipboard.write("outside"); return true;`);
		check("probe 밖 clipboard.write 는 전처럼 한 번 쓴다(spy)", outsideWrite.ok && JSON.stringify(clipboardWrites) === '["outside"]', `${show(outsideWrite)} writes=${clipboardWrites.join(",")}`);
	}
	reset(0);
	const shot = await run(`${prologue}
return await wait(async () => (await win.screenshot()).width === 1, { timeout: 2000 });`);
	const shotImages = JSON.stringify(shot.payload?.displays ?? []).includes('"image"');
	check("probe 안 screenshot 은 읽기로 허용하되 이미지를 붙이지 않는다", shot.ok && state.captures === 1 && !shotImages, `${show(shot)} captures=${state.captures}`);
	const outsideShot = await run(`${prologue}
await win.screenshot(); return true;`);
	check("probe 밖 screenshot 은 전처럼 이미지를 붙인다", outsideShot.ok && JSON.stringify(outsideShot.payload?.displays ?? []).includes('"image"'), show(outsideShot));
	reset(0);
	toolCalls.length = 0;
	const tool = await run(`${prologue}
return await wait(async () => { await globalThis.__omp_call_tool__("read", { path: "x" }); return true; }, { timeout: 2000 });`);
	check("probe 안 도구 호출은 도구 bridge 로 나가지 않는다", !tool.ok && /wait\(predicate\) probe cannot run 'tool:read'/.test(tool.error?.message ?? "") && toolCalls.length === 0, `${show(tool)} toolCalls=${toolCalls.join(",")}`);
	reset(0);
	toolCalls.length = 0;
	const outside = await run(`return await globalThis.__omp_call_tool__("read", { path: "x" });`);
	check("probe 밖 도구 호출은 그대로 나간다", outside.ok && outside.payload?.returnValue === "tool ran" && toolCalls.length === 1, `${show(outside)} toolCalls=${toolCalls.join(",")}`);
}

realConsole.log("[6] predicate 오류는 숨기지 않는다: 첫 오류를 그대로 올리고 다시 읽지 않는다");
{
	reset(0);
	let brokenReads = 0;
	const originalNode = session.axNode;
	session.axNode = async (ref: string) => {
		if (ref === "e4") brokenReads++;
		return originalNode(ref);
	};
	const broken = await run(`${prologue}
const [bad] = await win.find({ title: "Broken" });
return await wait(async () => (await bad.value()) === "ok", { timeout: 2000 });`);
	session.axNode = originalNode;
	check("native 오류가 그 문구 그대로 올라오고 1회만 읽는다", !broken.ok && broken.error?.message === "Internal: UIA element not available" && brokenReads === 1, `${show(broken)} reads=${brokenReads}`);
	const programming = await run(`return await wait(() => { throw new TypeError("bad predicate"); }, { timeout: 2000 });`);
	check("프로그래밍 오류도 timeout 으로 바뀌지 않는다", !programming.ok && programming.error?.message === "bad predicate", show(programming));
}

realConsole.log("[7] 기존 wait(ms)·assert·잘못된 인자는 그대로다");
{
	const sleepRun = await run(`const started = Date.now(); await wait(120); return Date.now() - started;`);
	check("wait(ms) 는 그만큼 잔다", sleepRun.ok && Number(sleepRun.payload?.returnValue) >= 110, show(sleepRun));
	const asserted = await run(`assert(true); assert(0, "goal row missing");`);
	check("assert 는 주어진 문구로 실패한다", !asserted.ok && asserted.error?.message === "goal row missing" && asserted.error?.isToolError === true, show(asserted));
	const badArg = await run(`return await wait("soon");`);
	check("숫자·함수가 아닌 인자는 기존 문구로 거절한다", !badArg.ok && badArg.error?.message === "wait(...) expects milliseconds (number) or a predicate function to poll", show(badArg));
	const clamped = await run(`${prologue}
return await wait(rowTitle, { timeout: 60_000 });`, { timeoutMs: 1500 });
	check("predicate 제한 시간은 run 예산보다 먼저 끝난다(이름 붙은 timeout)", !clamped.ok && /^wait\(predicate\) timed out after 500ms/.test(clamped.error?.message ?? ""), show(clamped));
}

clearInterval(keepAlive);
globalThis.console = realConsole;
rmSync(scratch, { recursive: true, force: true });
realConsole.log(`\n결과 ${passed} pass / ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
