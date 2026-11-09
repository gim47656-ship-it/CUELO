// ask 미리 선택값 자동 제출 opt-in 회귀(18.18.3 HTML 폼 ask). 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-ask-timeout-test.ts
// 실제 AskTool.execute 를 fixture UI(formDialog, 또는 select/input/editor 폴백)로 부른다. 모델 호출·설치본·실제 프로필은 쓰지 않는다.
// 계약: `autoSelectRecommended: true` 이고 폼이 유효한 추천(라디오·단일 select 마다 명시적으로 미리 고른 값, 그 값이 fieldError 를
// 통과)을 가질 때만 `ask.timeout` 이 UI 에 전달된다. 그 밖의 호출(승인 질문·미리 고른 값 없음·plan mode)은 무기한 기다리고,
// 타임아웃 결과는 사용자 응답·승인이 아니라고 적힌다.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live core");
const CORE = resolve(target, "src").replace(/\\/g, "/");
if (!existsSync(`${CORE}/tools/ask.ts`)) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
const TUI = resolve(target, "..", "pi-tui", "src").replace(/\\/g, "/");

// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET so the test never imports the live installation.
const { AskTool } = await import(`${CORE}/tools/ask.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
const { initThemeSync } = await import(`${TUI}/theme/theme.ts`);
const { parseHtmlForm } = await import(`${TUI}/html-form/parse.ts`);
const { defaultFormData } = await import(`${TUI}/html-form/data.ts`);
initThemeSync();
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

const radio = (name: string, checked: boolean) =>
	`<fieldset><legend>Database?</legend>` +
	`<label><input type="radio" name="${name}" value="sqlite"${checked ? " checked" : ""}> SQLite</label>` +
	`<label><input type="radio" name="${name}" value="pg"> Postgres</label></fieldset>`;
const form = (...parts: string[]) => `<form>${parts.join("")}</form>`;
const RADIO_PRESELECTED = form(radio("db", true));

type Result = { content: { type: string; text?: string }[]; details: Record<string, unknown> };

function makeTool(opts: { planMode?: boolean; timeoutSeconds?: number } = {}) {
	const settings = Settings.isolated({ "ask.timeout": opts.timeoutSeconds ?? 120 });
	return new AskTool({
		settings,
		hasUI: false,
		getPlanModeState: () => ({ enabled: opts.planMode ?? false }),
	} as never);
}

type Params = { html: string; autoSelectRecommended?: boolean };

/**
 * Run ask through a formDialog fixture. The fixture reports the options it received and, when it gets a
 * timeout, behaves like a host that enforces it: it resolves the form's untouched defaults with `timedOut`.
 */
async function runForm(params: Params, opts: { planMode?: boolean; timeoutSeconds?: number; cancel?: boolean } = {}) {
	let seen: { timeout?: number; signal?: AbortSignal } | undefined;
	let aborted = false;
	const context = {
		hasUI: true,
		abort: () => {
			aborted = true;
		},
		ui: {
			formDialog: async (html: string, dialogOptions?: { timeout?: number; signal?: AbortSignal }) => {
				seen = dialogOptions;
				if (opts.cancel) return undefined;
				const data = defaultFormData(parseHtmlForm(html));
				return dialogOptions?.timeout === undefined ? { data } : { data, timedOut: true };
			},
		},
	};
	let result: Result | undefined;
	let error: unknown;
	try {
		result = await makeTool(opts).execute("call", params, undefined, undefined, context as never);
	} catch (caught) {
		error = caught;
	}
	return { seenTimeout: seen?.timeout, result, error, aborted, text: result?.content[0]?.text ?? "" };
}

type Prompt = { kind: "select" | "input"; title: string; options?: unknown[]; timeout?: number; initialIndex?: number };

/** Run ask through the field-by-field fallback (no formDialog); `answer` decides each prompt, `onTimeout` models a deadline. */
async function runFields(
	params: Params,
	answer: (prompt: Prompt, dialogOptions: { timeout?: number; onTimeout?: () => void }) => string | undefined,
	opts: { planMode?: boolean; timeoutSeconds?: number } = {},
) {
	const prompts: Prompt[] = [];
	const context = {
		hasUI: true,
		abort: () => {},
		ui: {
			select: async (title: string, options: unknown[], dialogOptions: { timeout?: number; onTimeout?: () => void; initialIndex?: number }) => {
				const prompt: Prompt = { kind: "select", title, options, timeout: dialogOptions?.timeout, initialIndex: dialogOptions?.initialIndex };
				prompts.push(prompt);
				return answer(prompt, dialogOptions);
			},
			input: async (title: string, _placeholder: string | undefined, dialogOptions: { timeout?: number; onTimeout?: () => void }) => {
				const prompt: Prompt = { kind: "input", title, timeout: dialogOptions?.timeout };
				prompts.push(prompt);
				return answer(prompt, dialogOptions);
			},
			editor: async () => undefined,
		},
	};
	const result: Result = await makeTool(opts).execute("call", params, undefined, undefined, context as never);
	return { prompts, result, text: result.content[0]?.text ?? "" };
}

console.log("[1] opt-in + 유효한 추천이면 ask.timeout(120초)이 formDialog 에 전달되고 결과는 승인이 아니라고 적힌다");
{
	const r = await runForm({ html: RADIO_PRESELECTED, autoSelectRecommended: true });
	check("formDialog timeout = 120000ms", r.seenTimeout === 120_000, String(r.seenTimeout));
	check("타임아웃 결과는 미리 고른 값을 자동 제출했다고 적는다", r.text.includes("auto-submitted") && r.text.includes('"db": "sqlite"'), r.text);
	check("타임아웃 결과는 사용자 응답·승인이 아니라고 적는다", r.text.includes("no user response, not user approval"), r.text);
	check("타임아웃 결과는 사용자 답으로 적지 않는다", !r.text.startsWith("User answers"), r.text);
	check("details.timedOut 이 켜지고 답이 기록된다", r.result?.details.timedOut === true && JSON.stringify(r.result?.details.answers).includes("SQLite"), JSON.stringify(r.result?.details));
	check("세션을 abort 하지 않는다", !r.aborted && r.error === undefined, String(r.error));
}

console.log("[2] opt-in 이 없으면(승인 질문 모양 포함) 미리 고른 값이 있어도 무기한 기다린다");
{
	for (const [name, params] of [
		["autoSelectRecommended 없음", { html: RADIO_PRESELECTED }],
		["autoSelectRecommended false", { html: RADIO_PRESELECTED, autoSelectRecommended: false }],
	] as [string, Params][]) {
		const r = await runForm(params);
		check(`${name}: formDialog timeout 미전달`, r.seenTimeout === undefined, String(r.seenTimeout));
		check(`${name}: 제출은 사용자 응답으로 적힌다`, r.text.startsWith("User answers:") && r.result?.details.timedOut === undefined, r.text);
	}
}

console.log("[3] opt-in 이어도 유효한 추천이 아니면 무기한 기다린다");
{
	const selectOf = (...options: string[]) => `<label>Cache <select name="cache">${options.join("")}</select></label>`;
	const cases: [string, string][] = [
		["라디오에 미리 고른 값 없음", form(radio("db", false))],
		["필수 라디오에 미리 고른 값 없음", form(radio("db", false).replace('type="radio"', 'type="radio" required'))],
		["단일 select 에 selected 없음(파서가 첫 option 을 추정)", form(radio("db", true), selectOf('<option value="a">A</option>', '<option value="b">B</option>'))],
		["selected 가 value 문구에만 있는 select", form(radio("db", true), selectOf('<option value="selected">A</option>', '<option value="b">B</option>'))],
		["option 이 없는 select", form(radio("db", true), selectOf())],
		["여러 라디오 그룹 중 하나만 미리 고름", form(radio("db", true), radio("db2", false))],
		["미리 고른 값이 disabled", form(radio("db", true).replace("checked", "checked disabled"))],
		["필수 텍스트가 비어 있음", form(radio("db", true), '<label>Why <input type="text" name="why" required></label>')],
		["기본값이 min 위반", form(radio("db", true), '<label>Days <input type="number" name="days" value="0" min="1"></label>')],
		["기본값이 pattern 위반", form(radio("db", true), '<label>Id <input type="text" name="id" value="x" pattern="[0-9]+"></label>')],
		["필수 체크박스 묶음이 비어 있음", form(radio("db", true), '<label><input type="checkbox" name="opt" value="a" required> A</label><label><input type="checkbox" name="opt" value="b"> B</label>')],
	];
	for (const [name, html] of cases) {
		const r = await runForm({ html, autoSelectRecommended: true });
		check(`${name}: timeout 미전달`, r.seenTimeout === undefined, String(r.seenTimeout));
		check(`${name}: 제출은 사용자 응답`, r.text.startsWith("User answers:"), r.text);
	}
}

console.log("[4] 유효한 추천 모양은 timeout 이 전달된다");
{
	const selectOf = (...options: string[]) => `<label>Cache <select name="cache">${options.join("")}</select></label>`;
	const cases: [string, string][] = [
		["라디오 하나", RADIO_PRESELECTED],
		["첫 option 을 명시적으로 selected 로 고른 select", form(radio("db", true), selectOf('<option value="a" selected>A</option>', '<option value="b">B</option>'))],
		["둘째 option 을 selected 로 고른 select", form(radio("db", true), selectOf('<option value="a">A</option>', '<option value="b" selected>B</option>'))],
		["미리 고른 값이 없는 체크박스 묶음·선택 텍스트·multi select 는 막지 않는다", form(radio("db", true),
			'<label><input type="checkbox" name="opt" value="a"> A</label><label><input type="checkbox" name="opt" value="b"> B</label>',
			'<label>Note <input type="text" name="note"></label>',
			'<label>Tags <select name="tags" multiple><option value="x">X</option><option value="y">Y</option></select></label>')],
		["기본값이 규칙을 지키는 숫자·필수 텍스트", form(radio("db", true), '<label>Days <input type="number" name="days" value="30" min="1" required></label>', '<label>Why <input type="text" name="why" value="ok" required></label>')],
	];
	for (const [name, html] of cases) {
		const r = await runForm({ html, autoSelectRecommended: true });
		check(`${name}: timeout = 120000ms`, r.seenTimeout === 120_000, String(r.seenTimeout));
	}
}

console.log("[5] plan mode 와 ask.timeout 0 은 opt-in 이어도 무기한이다");
{
	const plan = await runForm({ html: RADIO_PRESELECTED, autoSelectRecommended: true }, { planMode: true });
	check("plan mode timeout 미전달", plan.seenTimeout === undefined, String(plan.seenTimeout));
	const off = await runForm({ html: RADIO_PRESELECTED, autoSelectRecommended: true }, { timeoutSeconds: 0 });
	check("ask.timeout 0 이면 timeout 미전달", off.seenTimeout === undefined, String(off.seenTimeout));
}

console.log("[6] 명시 응답·취소는 기존대로다");
{
	const cancelled = await runForm({ html: RADIO_PRESELECTED, autoSelectRecommended: true }, { cancel: true });
	check("취소는 ToolAbortError", cancelled.error instanceof Error && /cancelled/i.test(String(cancelled.error)), String(cancelled.error));
	check("취소는 세션 abort", cancelled.aborted);
}

console.log("[7] 필드별 폴백 경로(formDialog 없음): opt-in 이면 모든 프롬프트에 timeout, 아니면 없음");
{
	const html = form(radio("db", true), '<label>Cache <select name="cache"><option value="a">A</option><option value="b" selected>B</option></select></label>');
	// 마감이 오면 호스트가 onTimeout 을 부르고 undefined 로 끝낸다.
	const deadline = (_prompt: Prompt, dialogOptions: { timeout?: number; onTimeout?: () => void }) => {
		if (dialogOptions.timeout === undefined) return undefined;
		dialogOptions.onTimeout?.();
		return undefined;
	};
	const timedOut = await runFields({ html, autoSelectRecommended: true }, deadline);
	check("첫 프롬프트에 timeout 120000 전달", timedOut.prompts[0]?.timeout === 120_000, String(timedOut.prompts[0]?.timeout));
	check("마감이면 걷기를 멈추고 미리 고른 값을 제출한다", timedOut.prompts.length === 1 && timedOut.text.includes('"db": "sqlite"') && timedOut.text.includes('"cache": "b"'), timedOut.text);
	check("폴백 타임아웃 결과도 승인 아님 문구", timedOut.text.includes("no user response, not user approval") && timedOut.result.details.timedOut === true, timedOut.text);

	// 첫 필드는 사용자가 답하고 둘째 필드에서 마감: 사용자 답은 남고 나머지만 기본값이다.
	let calls = 0;
	const partial = await runFields({ html, autoSelectRecommended: true }, (prompt, dialogOptions) => {
		calls++;
		if (calls === 1) return (prompt.options as string[])[1]!;
		dialogOptions.onTimeout?.();
		return undefined;
	});
	check("사용자가 답한 필드는 마감 뒤에도 남는다", partial.text.includes('"db": "pg"') && partial.text.includes('"cache": "b"'), partial.text);
	check("부분 응답 문구는 응답 없는 필드만 자동 제출이라고 적는다", partial.text.includes("for the unanswered fields") && partial.text.includes("no user response, not user approval"), partial.text);

	const noOptIn = await runFields({ html }, (prompt, dialogOptions) => (dialogOptions.timeout === undefined ? (prompt.options as string[])[0]! : undefined));
	check("opt-in 없으면 모든 프롬프트에 timeout 없음", noOptIn.prompts.length === 2 && noOptIn.prompts.every(p => p.timeout === undefined), JSON.stringify(noOptIn.prompts.map(p => p.timeout)));
	check("opt-in 없으면 결과는 사용자 응답", noOptIn.text.startsWith("User answers:") && noOptIn.result.details.timedOut === undefined, noOptIn.text);

	const noPreselect = await runFields({ html: form(radio("db", false)), autoSelectRecommended: true }, (prompt, dialogOptions) => (dialogOptions.timeout === undefined ? (prompt.options as string[])[0]! : undefined));
	check("미리 고른 값이 없으면 opt-in 이어도 timeout 없음", noPreselect.prompts.every(p => p.timeout === undefined), JSON.stringify(noPreselect.prompts.map(p => p.timeout)));
}

console.log("[8] 도구 스키마가 autoSelectRecommended 를 받는다");
{
	const params = makeTool().parameters as (value: unknown) => unknown;
	// A failed validation returns an error object with a `summary`; a pass returns the value.
	const isError = (value: unknown) => typeof (value as { summary?: unknown } | null)?.summary === "string";
	check("html 이 문자열이 아니면 거절(검출기 확인)", isError(params({ html: 3 })));
	check("html 만으로 통과", !isError(params({ html: RADIO_PRESELECTED })));
	check("autoSelectRecommended: true 통과", !isError(params({ html: RADIO_PRESELECTED, autoSelectRecommended: true })));
	check("불리언이 아닌 값은 거절", isError(params({ html: RADIO_PRESELECTED, autoSelectRecommended: "maybe" })));
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
