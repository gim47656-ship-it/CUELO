// Public issue #52 regression: the observer lifecycle -> TODO auto-accept protection in InteractiveMode.
//
// Contract: a Maker (child) lifecycle event is evidence for Main's review, never Main's acceptance, so the
// observer UI flush must not call `#reconcileTodosWithSubagents()` (it would complete TODOs behind Main's back).
// 18.13.1 rewrote `#flushObserverUiSync()` (badgeChanged/todoChanged/hudChanged redraw optimization), so the
// protection must resolve on both 18.13.0 and 18.13.1 without overwriting upstream's optimization.
//
// [1] every `src/modes/interactive-mode.ts` EDITS entry resolves to exactly one candidate (not anchor-lost / ambiguous),
//     and after applying it re-resolves to `applied` with no second candidate also matching.
// [2] the patched source has no `#reconcileTodosWithSubagents()` call and still carries upstream's redraw gating.
// [3] the real patched `#scheduleObserverUiSync` + `#flushObserverUiSync` text is executed against a fake `this`:
//     lifecycle never reconciles; badge/todo/HUD flags still gate the redraw; progress-only ticks do not re-sync the HUD.
//
// Source: `OMP_CORE_PATCH_BACKUP/src/modes/interactive-mode.ts` (pristine) when given, else the target's file
// (pristine or already patched; both resolve). The target is never written. Nothing here touches a real session.
//   OMP_CORE_PATCH_TARGET=<core> bun run patches/core-observer-lifecycle-test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live core");
const FILE = "src/modes/interactive-mode.ts";
const pristineDir = process.env.OMP_CORE_PATCH_BACKUP;
const sourcePath = pristineDir && existsSync(join(pristineDir, FILE)) ? join(pristineDir, FILE) : join(target, FILE);
const original = readFileSync(sourcePath, "utf8");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` ${detail}`}`);
	ok ? pass++ : fail++;
}

// The patch script has no exports; read its EDITS/resolveEdit through a temp copy (import is side-effect free).
const scratch = mkdtempSync(join(tmpdir(), "omp-observer-lifecycle-"));
let exitCode = 1;
try {
	const script = readFileSync(resolve(import.meta.dirname, "apply-core-patch.mjs"), "utf8");
	const copy = join(scratch, "apply-core-patch.mjs");
	writeFileSync(copy, `${script}\nexport { EDITS, resolveEdit };\n`);
	const { EDITS, resolveEdit } = (await import(pathToFileURL(copy).href)) as {
		EDITS: Array<{ file: string; alternates?: unknown[] }>;
		resolveEdit: (entry: unknown, root: string) => { status: string; anchor: string; patched: string; file: string };
	};

	// Apply entry by entry against an in-memory interactive-mode.ts so the real resolver (file reads) sees each step.
	const root = join(scratch, "pkg");
	const filePath = join(root, FILE);
	const mk = (text: string) => {
		Bun.spawnSync(["mkdir", "-p", join(root, "src/modes")]);
		writeFileSync(filePath, text);
	};
	const entries = EDITS.filter(entry => entry.file === FILE);
	console.log(`\n[1] interactive-mode.ts 항목 ${entries.length}개 후보 유일성 (${sourcePath})`);
	mk(original);
	const lost: number[] = [];
	for (const [i, entry] of entries.entries()) {
		const resolved = resolveEdit(entry, root);
		if (resolved.status === "anchor-lost" || resolved.status === "ambiguous") {
			lost.push(i);
			continue;
		}
		if (resolved.status === "appliable") {
			const text = readFileSync(filePath, "utf8");
			mk(text.replace(resolved.anchor, () => resolved.patched));
		}
	}
	check("원본에서 모든 interactive-mode.ts 항목이 하나의 후보로 결정된다(anchor-lost/ambiguous 없음)", lost.length === 0, `lost/ambiguous 항목 인덱스: ${lost.join(",")}`);
	const bad = entries.map(entry => resolveEdit(entry, root).status).filter(status => status !== "applied");
	check("적용 후 모든 항목이 정확히 한 후보로 applied 다(두 후보가 함께 성립하지 않는다)", bad.length === 0, `status: ${bad.join(",")}`);
	const patched = readFileSync(filePath, "utf8");

	console.log("\n[2] 패치된 소스");
	check("lifecycle 경로에 #reconcileTodosWithSubagents() 호출이 없다", !/this\.#reconcileTodosWithSubagents\(/.test(patched));
	check("Main 수용 보호 주석이 flush 안에 있다", /never changes TodoTracker|never change TodoTracker/.test(patched));
	const optimized = patched.includes("const badgeChanged = this.syncRunningSubagentBadge(");
	check(optimized ? "upstream redraw 최적화(badgeChanged/todoChanged/hudChanged)가 보존된다" : "18.13.0 이하 flush 모양이다(최적화 flag 없음)", optimized ? /if \(badgeChanged \|\| todoChanged \|\| hudChanged\) this\.ui\.requestRender\(\)/.test(patched) && /const hudChanged = this\.#renderSubagentList\(\)/.test(patched) : /#flushObserverUiSync\(\): void \{/.test(patched));

	console.log("\n[3] 패치된 flush·schedule 본문 실행");
	const method = (name: string): string => {
		const start = patched.indexOf(`\t${name}(`);
		if (start < 0) throw new Error(`${name} 본문을 찾지 못했다`);
		const end = patched.indexOf("\n\t}\n", start);
		return patched.slice(start, end + 3);
	};
	// Strip the TS-only bits: `#private` names become plain fields, parameter/return annotations go away.
	const toJs = (src: string): string => src.replace(/this\.#/g, "this.$_").replace(/\):\s*(void|boolean)\s*\{/, ") {").replace(/\(kind: SessionObserverChangeKind\)/, "(kind)").replace(/^\t#?(\w+)\(/, "function $1(");
	const flushSrc = toJs(method("#flushObserverUiSync")).replace(/^function \w+/, "function flush");
	const scheduleSrc = toJs(method("#scheduleObserverUiSync")).replace(/^function \w+/, "function schedule");
	const build = new Function("setTimeout", "SUBAGENT_OBSERVER_UI_COALESCE_MS", `${flushSrc}\n${scheduleSrc}\nreturn { flush, schedule };`) as (
		timer: unknown,
		ms: number,
	) => { flush: (this: Fake) => void; schedule: (this: Fake, kind: string) => void };

	type Fake = Record<string, unknown> & { calls: Record<string, number> };
	const timers: Array<() => void> = [];
	const fakeTimer = (fn: () => void) => {
		timers.push(fn);
		return { unref() {} };
	};
	const { flush, schedule } = build(fakeTimer, 100);
	const makeFake = (opts: { needsReconcile?: boolean; badge?: boolean; hud?: boolean; descs?: string[]; key?: string }): Fake => {
		const calls: Record<string, number> = { reconcile: 0, syncHud: 0, renderTodo: 0, renderSubagent: 0, requestRender: 0 };
		const fake: Fake = {
			calls,
			$_observerUiSyncNeedsTodoReconcile: opts.needsReconcile ?? false,
			$_observerUiSyncTimer: undefined,
			$_todoHudSubagentKey: opts.key ?? "",
			$_todoPhasesOwner: undefined,
			session: {},
			ui: { requestRender: () => void calls.requestRender!++ },
			syncRunningSubagentBadge: () => opts.badge ?? false,
			$_getActiveSubagentDescriptions: () => opts.descs ?? [],
			$_reconcileTodosWithSubagents: () => void calls.reconcile!++,
			$_syncTodoHudState: () => void calls.syncHud!++,
			$_renderTodoList: () => void calls.renderTodo!++,
			$_renderSubagentList: () => {
				calls.renderSubagent!++;
				return opts.hud ?? false;
			},
		};
		fake.$_flushObserverUiSync = () => flush.call(fake);
		return fake;
	};

	{
		const f = makeFake({ needsReconcile: true });
		flush.call(f);
		check("lifecycle flush 는 reconciler 를 호출하지 않는다", f.calls.reconcile === 0);
		check("lifecycle flush 는 HUD 상태를 한 번 동기화하고 todo 목록을 다시 그린다", f.calls.syncHud === 1 && f.calls.renderTodo === 1, JSON.stringify(f.calls));
		check("lifecycle flush 는 flag 를 내린다", f.$_observerUiSyncNeedsTodoReconcile === false);
		check("lifecycle flush 는 오래된 todo 를 남기지 않도록 다시 그리기를 요청한다", f.calls.requestRender === 1);
	}
	{
		const f = makeFake({ descs: ["a"], key: "a" });
		flush.call(f);
		check("같은 상태의 progress tick 은 HUD 재동기화(auto-clear timer 재설정)와 todo 다시 그림을 하지 않는다", f.calls.syncHud === 0 && f.calls.renderTodo === 0, JSON.stringify(f.calls));
		check("같은 상태의 progress tick 은 reconciler 를 호출하지 않는다", f.calls.reconcile === 0);
		if (optimized) check("바뀐 것이 없으면 다시 그리기를 요청하지 않는다", f.calls.requestRender === 0, JSON.stringify(f.calls));
	}
	{
		const f = makeFake({ descs: ["a", "b"], key: "a" });
		flush.call(f);
		check("활성 subagent 설명이 바뀌면 HUD 는 재동기화 없이 다시 그린다", f.calls.syncHud === 0 && f.calls.renderTodo === 1 && f.calls.requestRender === 1, JSON.stringify(f.calls));
	}
	if (optimized) {
		const badge = makeFake({ badge: true });
		flush.call(badge);
		check("badge(실행 중 subagent 수·비용)만 바뀌어도 다시 그린다", badge.calls.requestRender === 1 && badge.calls.renderTodo === 0, JSON.stringify(badge.calls));
		const hud = makeFake({ hud: true });
		flush.call(hud);
		check("subagent HUD 만 바뀌어도 다시 그린다", hud.calls.requestRender === 1 && hud.calls.renderTodo === 0, JSON.stringify(hud.calls));
	}
	{
		const f = makeFake({});
		timers.length = 0;
		schedule.call(f, "progress");
		check("progress 변화는 reconcile flag 를 세우지 않는다", f.$_observerUiSyncNeedsTodoReconcile === false && timers.length === 1);
		schedule.call(f, "completed");
		check("lifecycle 변화는 flag 를 세우되 timer 는 하나로 합친다", f.$_observerUiSyncNeedsTodoReconcile === true && timers.length === 1);
		timers[0]!();
		check("합쳐진 flush 는 reconciler 없이 HUD 만 동기화한다", f.calls.reconcile === 0 && f.calls.syncHud === 1 && f.$_observerUiSyncNeedsTodoReconcile === false, JSON.stringify(f.calls));
	}
	console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
	exitCode = fail === 0 ? 0 : 1;
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
process.exit(exitCode);
