// 자동 첫 턴 회상의 결과별 dense 대역(mnemopi.recallDenseBand). 실행:
//   OMP_CORE_PATCH_TARGET=<patched-core> bun run patches/core-memory-recall-precision-test.ts
// 턴 게이트를 통과한 뒤에도 후보 8개를 그대로 싣던 것을, 최고 후보의 원시 dense 보다 대역(기본 0.035) 넘게 뒤처지는 결과는 싣지 않게 한다.
// 최고 후보는 늘 남고, dense 가 없는 결과(fact)는 남는다. 명시 recall·압축 회상은 대역을 받지 않는다. 0 이면 끈다.
// 동적 import 예외: core-memory-gate-citations-test.ts 와 같다(지정한 사본만 검증). 네트워크·`~/.omp` 접근 없음(임베딩 끔·임시 폴더).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { settingsLike } from "./core-test-settings";

function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const candidates = env
		? [env]
		: [join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(process.cwd(), "node_modules/@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(p => existsSync(join(p, "src/mnemopi/state.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const stateMod = await import(`${CORE}/mnemopi/state.ts`);
const { mnemopiBackend } = await import(`${CORE}/mnemopi/backend.ts`);
const { loadMnemopiConfig } = await import(`${CORE}/mnemopi/config.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
await stateMod.loadMnemopi();
await stateMod.loadMnemopiCore();

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

const root = mkdtempSync(join(tmpdir(), "omp-recall-precision-"));
try {
	// ── 1. 설정 ────────────────────────────────────────────────────────────────
	console.log("\n[1] mnemopi.recallDenseBand — 기본 0.035, 0 은 끔, 범위는 0~1");
	{
		// 모르는 설정 키는 Settings.isolated 가 던진다. 패치 전에도 아래 [2] 가 돌도록 값 없음으로 바꾼다.
		const cfg = (value?: number): { recallDenseBand?: number } => {
			try {
				return loadMnemopiConfig(Settings.isolated({ "memory.backend": "mnemopi", ...(value === undefined ? {} : { "mnemopi.recallDenseBand": value }) }), join(root, "agent"));
			} catch {
				return {};
			}
		};
		check("기본값은 0.035 이다", cfg().recallDenseBand === 0.035, `got ${cfg().recallDenseBand}`);
		check("0 은 그대로 둔다(끔)", cfg(0).recallDenseBand === 0, `got ${cfg(0).recallDenseBand}`);
		check("범위를 넘는 값은 0~1 로 자른다", cfg(5).recallDenseBand === 1 && cfg(-1).recallDenseBand === 0);
	}

	// ── 2. 자동 첫 턴 회상의 결과별 대역 ───────────────────────────────────────
	console.log("\n[2] 자동 첫 턴 회상 — 최고 dense 보다 대역 넘게 뒤처진 결과는 싣지 않는다");
	{
		const E5 = "intfloat/multilingual-e5-large";
		const row = (id: string, dense: number | undefined) => ({ id, content: `기억 ${id}`, source: "coding-agent-learn", timestamp: "2026-10-01T00:00:00Z", score: 0.9, dense_score: dense });
		const scenario = async (dense: Array<number | undefined>, options: { band?: number; model?: string; compaction?: boolean } = {}) => {
			const rows = dense.map((d, i) => row(`m${i}`, d));
			const target = { bank: "bank", memory: { recallEnhanced: async () => rows, get: () => null } };
			const parentState = {
				config: {
					autoRecall: true, autoRetain: false, recallLimit: 8, recallContextTurns: 1, recallMaxQueryChars: 2000, bank: "bank", globalBank: "bank",
					dbPath: join(root, "band.db"), recallDenseGate: 0.8, recallDenseBand: options.band ?? 0.035, providerOptions: { embeddingModel: options.model ?? E5, debug: false },
				},
				scoped: { recall: [target], retain: target },
			};
			const settings = settingsLike({ get: (key: string) => (key === "mnemopi.injectionTokenLimit" ? 5000 : undefined) }) as never;
			const session = {
				sessionId: "band-child",
				settings,
				getXdevToolEntries: () => [],
				sessionManager: { getEntries: () => [], getBranch: () => [], appendCustomEntry: () => "entry" },
			} as never;
			await mnemopiBackend.start({ session, settings, agentDir: "", taskDepth: 1, parentMnemopiSessionState: parentState } as never);
			if (options.compaction) {
				const state = stateMod.getMnemopiSessionState(session);
				return { text: await state.recallForContext("압축 회상 질의") };
			}
			const staged = await mnemopiBackend.beforeAgentStartPrompt(session, "배포 절차 알려줘");
			return { text: staged?.context };
		};
		const shown = (r: { text?: string }) => ["m0", "m1", "m2", "m3"].filter(id => r.text?.includes(`(id: ${id})`));

		const trailing = await scenario([0.9, 0.88, 0.86, 0.82]);
		check("최고 0.90 대비 0.88 은 싣고 0.86·0.82 는 싣지 않는다", JSON.stringify(shown(trailing)) === JSON.stringify(["m0", "m1"]), `shown=${JSON.stringify(shown(trailing))}`);
		const order = await scenario([0.84, 0.9, 0.89]);
		check("순서가 아니라 dense 로 가른다(최고가 둘째여도 남고, 첫째 0.84 는 빠진다)",
			JSON.stringify(shown(order)) === JSON.stringify(["m1", "m2"]), `shown=${JSON.stringify(shown(order))}`);
		const single = await scenario([0.81]);
		check("후보가 하나면 그대로 싣는다(최고 후보는 늘 남는다)", JSON.stringify(shown(single)) === JSON.stringify(["m0"]));
		const off = await scenario([0.9, 0.82], { band: 0 });
		check("대역 0 이면 끈다(후보 전부)", JSON.stringify(shown(off)) === JSON.stringify(["m0", "m1"]), `shown=${JSON.stringify(shown(off))}`);
		const bge = await scenario([0.9, 0.82], { model: "BAAI/bge-base-en-v1.5" });
		check("e5 가 아닌 임베딩은 이 대역을 쓰지 않는다(코사인 범위가 다르다)", JSON.stringify(shown(bge)) === JSON.stringify(["m0", "m1"]), `shown=${JSON.stringify(shown(bge))}`);
		const noDense = await scenario([0.9, undefined, 0, 0.82]);
		check("dense 가 없는 결과(undefined·0)는 싣고 뒤처진 0.82 만 뺀다", JSON.stringify(shown(noDense)) === JSON.stringify(["m0", "m1", "m2"]), `shown=${JSON.stringify(shown(noDense))}`);
		const compaction = await scenario([0.9, 0.82], { compaction: true });
		check("압축 회상(recallForContext 기본 호출)은 대역을 받지 않는다", JSON.stringify(shown(compaction)) === JSON.stringify(["m0", "m1"]), `shown=${JSON.stringify(shown(compaction))}`);
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
