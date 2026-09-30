// ask 추천안 자동선택 opt-in 회귀. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-ask-timeout-test.ts
// 실제 AskTool.execute 를 fixture UI(askDialog·select)로 부른다. 모델 호출·설치본·실제 프로필은 쓰지 않는다.
// 계약: `autoSelectRecommended: true` + 유효한 `recommended`를 모든 질문이 가질 때만 `ask.timeout`이 UI 에
// 전달된다. 그 밖의 호출은 무기한이고, 타임아웃 결과는 사용자 응답·승인이 아니라고 적힌다.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live core");
const CORE = resolve(target, "src").replace(/\\/g, "/");
if (!existsSync(`${CORE}/tools/ask.ts`)) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);

// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET so the test never imports the live installation.
const { AskTool, recoverAskQuestions } = await import(`${CORE}/tools/ask.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
const { initThemeSync } = await import(`${resolve(target, "..", "pi-tui", "src").replace(/\\/g, "/")}/theme/theme.ts`);
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

type Question = {
	id: string;
	question: string;
	options: { label: string }[];
	recommended?: number;
	autoSelectRecommended?: boolean;
	multi?: boolean;
};

const q = (over: Partial<Question> = {}): Question => ({
	id: "storage",
	question: "Database?",
	options: [{ label: "SQLite" }, { label: "Postgres" }],
	recommended: 1,
	autoSelectRecommended: true,
	...over,
});

function makeTool(planMode = false) {
	const settings = Settings.isolated({ "ask.timeout": 120 });
	return new AskTool({
		settings,
		hasUI: false,
		getPlanModeState: () => ({ enabled: planMode }),
	} as never);
}

type RichAnswer = { kind: "submit"; results: unknown[] } | undefined;

/** Run ask through a rich askDialog fixture; return the timeout the UI received and the tool result. */
async function runRich(questions: Question[], answer: (qs: Question[]) => RichAnswer, planMode = false) {
	let seenTimeout: number | undefined | "unset" = "unset";
	let aborted = false;
	const context = {
		hasUI: true,
		abort: () => {
			aborted = true;
		},
		ui: {
			askDialog: async (qs: Question[], opts?: { timeout?: number }) => {
				seenTimeout = opts?.timeout;
				return answer(qs);
			},
			select: async () => undefined,
			editor: async () => undefined,
		},
	};
	let result: { content: { type: string; text?: string }[]; details: Record<string, unknown> } | undefined;
	let error: unknown;
	try {
		result = await makeTool(planMode).execute("call", { questions }, undefined, undefined, context as never);
	} catch (caught) {
		error = caught;
	}
	return { seenTimeout, result, error, aborted, text: result?.content[0]?.text ?? "" };
}

const timedOutRecommended = (qs: Question[]): RichAnswer => ({
	kind: "submit",
	results: qs.map(item => ({
		id: item.id,
		question: item.question,
		options: item.options.map(o => o.label),
		multi: item.multi ?? false,
		selectedOptions: [item.options[item.recommended ?? 0]!.label],
		timedOut: true,
	})),
});

console.log("[1] opt-in + 유효 recommended 면 ask.timeout(120초)이 UI 에 전달된다");
{
	const r = await runRich([q()], timedOutRecommended);
	check("askDialog timeout = 120000ms", r.seenTimeout === 120_000, String(r.seenTimeout));
	check("타임아웃 결과는 추천안이다", r.text.includes("Postgres"), r.text);
	check("타임아웃 결과는 사용자 선택으로 적지 않는다", !r.text.includes("User selected"), r.text);
	check("타임아웃 결과는 승인이 아니라고 적는다", r.text.includes("not user approval"), r.text);
	check("세션을 abort 하지 않는다", !r.aborted && r.error === undefined, String(r.error));
}

console.log("[2] opt-in 이 없거나 조건이 모자라면 무기한 대기한다");
{
	const cases: [string, Question[]][] = [
		["기존 호출(opt-in 없음)", [q({ autoSelectRecommended: undefined })]],
		["opt-in false", [q({ autoSelectRecommended: false })]],
		["recommended 없음", [q({ recommended: undefined })]],
		["recommended 범위 밖", [q({ recommended: 2 })]],
		["recommended 음수", [q({ recommended: -1 })]],
		["recommended 정수 아님", [q({ recommended: 0.5 })]],
		["배치 중 한 질문만 opt-in 없음", [q(), q({ id: "deploy", autoSelectRecommended: undefined })]],
	];
	for (const [name, questions] of cases) {
		const r = await runRich(questions, qs => ({
			kind: "submit",
			results: qs.map(item => ({
				id: item.id,
				question: item.question,
				options: item.options.map(o => o.label),
				multi: false,
				selectedOptions: ["SQLite"],
			})),
		}));
		check(`${name}: timeout 미전달`, r.seenTimeout === undefined, String(r.seenTimeout));
	}
}

console.log("[3] plan mode 는 opt-in 이어도 무기한이다");
{
	const r = await runRich([q()], timedOutRecommended, true);
	check("plan mode timeout 미전달", r.seenTimeout === undefined, String(r.seenTimeout));
}

console.log("[4] 배치 전부 opt-in 이면 timeout 이 전달되고 각 결과가 타임아웃으로 적힌다");
{
	const r = await runRich([q(), q({ id: "cache", recommended: 0 })], timedOutRecommended);
	check("askDialog timeout = 120000ms", r.seenTimeout === 120_000, String(r.seenTimeout));
	check("다중 결과도 승인 아님 표기", (r.text.match(/not user approval/g) ?? []).length === 2, r.text);
}

console.log("[5] 명시 응답·ESC 취소는 기존대로다");
{
	const explicit = await runRich([q()], qs => ({
		kind: "submit",
		results: [{ id: qs[0]!.id, question: qs[0]!.question, options: ["SQLite", "Postgres"], multi: false, selectedOptions: ["SQLite"] }],
	}));
	check("명시 선택은 User selected", explicit.text === "User selected: SQLite", explicit.text);
	const cancelled = await runRich([q()], () => undefined);
	check("ESC 는 취소(ToolAbortError)", cancelled.error instanceof Error && /cancelled/i.test(String(cancelled.error)), String(cancelled.error));
	check("ESC 는 세션 abort", cancelled.aborted);
}

console.log("[6] select 경로(rich 없음): UI 가 timeout 을 강제하면 추천안, opt-in 없으면 timeout 없음");
{
	const selects: (number | undefined)[] = [];
	const makeContext = (onSelect: (opts: { timeout?: number; onTimeout?: () => void }) => Promise<string | undefined>) => ({
		hasUI: true,
		abort: () => {},
		ui: {
			select: async (_p: string, _o: unknown, opts: { timeout?: number; onTimeout?: () => void }) => {
				selects.push(opts?.timeout);
				return onSelect(opts);
			},
			editor: async () => undefined,
		},
	});
	const timedOut = await makeTool().execute(
		"call",
		{ questions: [q({ recommended: 0 })] },
		undefined,
		undefined,
		makeContext(async opts => {
			opts.onTimeout?.();
			return undefined;
		}) as never,
	);
	const text = timedOut.content[0]?.text ?? "";
	check("select 에 timeout 120000 전달", selects[0] === 120_000, String(selects[0]));
	check("select 타임아웃은 추천안(SQLite)", text.includes("SQLite") && text.includes("not user approval"), text);
	selects.length = 0;
	const legacy = await makeTool().execute(
		"call",
		{ questions: [q({ autoSelectRecommended: undefined })] },
		undefined,
		undefined,
		makeContext(async () => "Postgres (Recommended)") as never,
	);
	check("opt-in 없으면 select timeout 없음", selects[0] === undefined, String(selects[0]));
	check("명시 선택 결과", (legacy.content[0]?.text ?? "") === "User selected: Postgres", legacy.content[0]?.text);
}

console.log("[7] 도구 스키마가 autoSelectRecommended 를 받는다");
{
	const accepted: Question[] | undefined = recoverAskQuestions({ questions: [q()] });
	check("스키마 통과·필드 보존", accepted?.[0]?.autoSelectRecommended === true, JSON.stringify(accepted));
	// 기존 인자 정규화는 "yes"/"false" 같은 불리언 문자열을 의미대로 바꾼다. 해석 불가한 값만 거절된다.
	const rejected = recoverAskQuestions({ questions: [{ ...q(), autoSelectRecommended: "maybe" }] });
	check("불리언으로 해석할 수 없으면 거절", rejected === undefined, JSON.stringify(rejected));
	const optOut: Question[] | undefined = recoverAskQuestions({ questions: [{ ...q(), autoSelectRecommended: "false" }] });
	check("\"false\" 는 opt-out 으로 정규화", optOut?.[0]?.autoSelectRecommended === false, JSON.stringify(optOut));
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
