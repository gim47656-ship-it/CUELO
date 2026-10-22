// 회상 줄의 `근거 사라짐` 표시와 learn 의 `비슷한 기존 기억` 알림. 실행:
//   OMP_CORE_PATCH_TARGET=<patched-core> bun run patches/core-memory-citation-freshness-test.ts
// 근거: 기억이 단 citation 의 파일·절 제목이 지금 프로젝트 트리에 없으면 회상 줄이 근거 사라짐으로 싣는다(기억은 그대로 돌려준다).
// 비슷한 기억: learn 저장 뒤 같은 bank 의 원시 dense 코사인 0.90 이상 기억을 최대 3줄로 알린다(저장은 그대로, 임베딩이 없으면 조용히 건너뜀).
// 임베딩은 네트워크 없이 이 파일의 결정적 해시 임베딩(embeddings.provider)을 쓴다. 임시 폴더만 쓰고 `~/.omp` 는 건드리지 않는다.
// 동적 import 예외: core-memory-gate-citations-test.ts 와 같다(지정한 사본만 검증).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const { LearnTool } = await import(`${CORE}/tools/learn.ts`);
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

// 결정적 해시 임베딩: 문자 3-gram 가방을 1024 차원에 해시해 정규화한다. 거의 같은 글은 코사인이 높고 다른 글은 낮다.
const E5 = "intfloat/multilingual-e5-large";
function vectorOf(text: string): number[] {
	const body = text.replace(/^(query|passage): /, "").toLowerCase();
	const v = new Array<number>(1024).fill(0);
	for (let i = 0; i + 3 <= body.length; i++) {
		let h = 2166136261;
		for (const ch of body.slice(i, i + 3)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
		v[h % 1024]! += 1;
	}
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
	return v.map(x => x / norm);
}
const cosine = (a: string, b: string) => vectorOf(a).reduce((s, x, i) => s + x * vectorOf(b)[i]!, 0);
const hashProvider = {
	embed: (texts: readonly string[]) =>
		(async function* () {
			yield texts.map(vectorOf);
		})(),
};

const root = mkdtempSync(join(tmpdir(), "omp-citation-freshness-"));
const openStates: Array<{ st: { unsubscribe?: () => void; memory: unknown; globalMemory?: unknown } }> = [];
try {
	const project = join(root, "project");
	mkdirSync(join(project, "doc", "history"), { recursive: true });
	Bun.spawnSync(["git", "init", "-q", project]);
	const record = "doc/history/record.md";
	const recordBody = "# 기록\n\nRECORD: x\nDATE: 2026-10-23\nSCOPE: 배포 검증\n\n## 배포 검증 절차\n\n본문 한 줄.\n\n## 실패 원인 (2026-10-23)\n\n둘째 본문.\n";
	writeFileSync(join(project, record), recordBody);
	writeFileSync(join(project, "doc", "gone.md"), "# 곧 지워질 파일\n");
	writeFileSync(join(project, "doc", "gone2.md"), "# 곧 지워질 파일 둘\n");
	writeFileSync(join(project, "doc", "big.md"), "# 큰 파일\n\n## 큰 절\n");

	const makeConfig = (dir: string, provider: Record<string, unknown>) => ({
		dbPath: join(dir, "m.db"), baseBank: "shared", bank: "projA", globalBank: "shared", retainBank: "projA", recallBanks: ["projA", "shared"],
		scoping: "per-project-tagged", autoRecall: true, autoRetain: false, polyphonicRecall: false, enhancedRecall: true,
		proactiveLinking: false, retainEveryNTurns: 1, recallLimit: 20, recallContextTurns: 1, recallMaxQueryChars: 800,
		injectionTokenLimit: 4000, debug: false, providerOptions: provider, llmMode: "none",
	});
	const open = (name: string, cwd: string, config: ReturnType<typeof makeConfig>) => {
		const session: Record<string, unknown> = {
			sessionId: name, cwd, sessionFile: undefined, sessionManager: { getCwd: () => cwd, getSessionId: () => name },
			settings: settingsLike({ get: (k: string) => (k === "memory.backend" ? "mnemopi" : k === "autolearn.enabled" ? true : undefined) }),
		};
		const st = new stateMod.MnemopiSessionState({ sessionId: name, config, session: session as never });
		session.getMnemopiSessionState = () => st;
		stateMod.setMnemopiSessionState(session as never, st);
		openStates.push({ st });
		const tool = new LearnTool(session as never);
		const learn = (args: Record<string, unknown>) =>
			tool.execute(name, args as never).then(
				(result: { content: Array<{ text?: string }> }) => ({ ok: true as const, text: String(result.content[0]?.text) }),
				(error: Error) => ({ ok: false as const, text: error.message }),
			);
		return { st, learn };
	};
	const idOf = (text: string) => /id: ([^,)]+)/.exec(text)![1]!;
	const lineOf = (text: string, id: string) => text.split("\n").find(l => l.includes(`(id: ${id})`)) ?? "";

	// ── 1. 근거 사라짐 표시 ────────────────────────────────────────────────────
	console.log("\n[1] 회상 — 근거 파일·절이 사라진 기억은 근거 사라짐으로 표시하고 기억은 그대로 돌려준다");
	{
		const dir = join(root, "mem1");
		mkdirSync(dir, { recursive: true });
		const config = makeConfig(dir, { noEmbeddings: true, debug: false });
		const { st, learn } = open("fresh", project, config);
		const nestedDir = join(project, "doc", "history");
		const nested = open("fresh-nested", nestedDir, config);

		const m1 = await learn({ memory: "zebra-m1 없어질 파일을 근거로 단 교훈", kind: "evidence", citations: [{ path: "doc/gone.md" }] });
		const m2 = await learn({ memory: "zebra-m2 그대로 남는 절을 근거로 단 교훈", kind: "evidence", citations: [{ path: record, anchor: "배포 검증 절차" }] });
		const m3 = await learn({ memory: "zebra-m3 나중에 사라질 절을 근거로 단 교훈", kind: "evidence", citations: [{ path: record, anchor: "실패 원인" }] });
		const m4 = await learn({ memory: "zebra-m4 근거 둘 중 하나만 사라지는 교훈", kind: "evidence", citations: [{ path: record, anchor: "SCOPE" }, { path: "doc/gone2.md" }] });
		const m5 = await nested.learn({ memory: "zebra-m5 하위 폴더 세션이 남긴 교훈", kind: "evidence", citations: [{ path: record, anchor: "실패 원인" }] });
		const m6 = await learn({ memory: "zebra-m6 전역 기억도 근거를 다시 대 본다", kind: "evidence", scope: "global", citations: [{ path: "doc/gone.md" }] });
		const m7 = await learn({ memory: "zebra-m7 큰 파일은 판정하지 않는다", kind: "evidence", citations: [{ path: "doc/big.md", anchor: "큰 절" }] });
		check("전제: 기억 일곱 개가 저장됐다", [m1, m2, m3, m4, m5, m6, m7].every(r => r.ok), JSON.stringify([m1, m2, m3, m4, m5, m6, m7]));
		const [i1, i2, i3, i4, i5, i6, i7] = [m1, m2, m3, m4, m5, m6, m7].map(r => idOf(r.text));

		// 별도 프로젝트: cwd 폴더째 사라진 기억은 판정하지 않는다.
		const p2 = join(root, "project2");
		mkdirSync(p2, { recursive: true });
		Bun.spawnSync(["git", "init", "-q", p2]);
		writeFileSync(join(p2, "a.md"), "# a\n");
		const other = open("fresh-p2", p2, config);
		const m8 = await other.learn({ memory: "zebra-m8 프로젝트 폴더가 통째로 사라진 교훈", kind: "evidence", citations: [{ path: "a.md" }] });
		const i8 = idOf(m8.text);

		const query = "zebra-m1 zebra-m2 zebra-m3 zebra-m4 zebra-m5 zebra-m6 zebra-m7 zebra-m8";
		const recallText = async () => String(await st.recallForContext(query));
		const toolText = async () => st.formatScopedRecallWithIds(await st.recallResultsScoped(query)) as string;

		const before = await recallText();
		check("대조: 모두 있을 때는 근거 후보만 나오고 근거 사라짐은 없다",
			[i1, i2, i3, i4, i5, i6, i7, i8].every(id => lineOf(before, id).includes("근거 후보:")) && !before.includes("근거 사라짐"), before);

		rmSync(join(project, "doc", "gone.md"));
		rmSync(join(project, "doc", "gone2.md"));
		writeFileSync(join(project, record), recordBody.replace(/## 실패 원인 \(2026-10-23\)\n\n둘째 본문\.\n/, ""));
		writeFileSync(join(project, "doc", "big.md"), "# 큰 파일\n" + "x".repeat(9 * 1024 * 1024));
		rmSync(p2, { recursive: true, force: true });

		const after = await recallText();
		const viaTool = await toolText();
		for (const [label, text] of [["자동·압축 회상 블록", after], ["recall 도구 출력", viaTool]] as const) {
			check(`${label}: 지워진 파일 근거는 근거 사라짐이고 기억은 그대로 돌아온다`,
				lineOf(text, i1).includes("zebra-m1") && lineOf(text, i1).includes("근거 사라짐: doc/gone.md") && !lineOf(text, i1).includes("근거 후보:"), lineOf(text, i1));
			check(`${label}: 남아 있는 절 근거는 근거 후보로 남는다`,
				lineOf(text, i2).includes("근거 후보: doc/history/record.md#배포 검증 절차") && !lineOf(text, i2).includes("근거 사라짐"), lineOf(text, i2));
			check(`${label}: 지워진 절 제목 근거는 근거 사라짐이다`,
				lineOf(text, i3).includes("근거 사라짐: doc/history/record.md#실패 원인") && !lineOf(text, i3).includes("근거 후보:"), lineOf(text, i3));
			check(`${label}: 한 기억이 둘을 함께 보일 수 있다(남은 것은 후보, 사라진 것은 사라짐)`,
				lineOf(text, i4).includes("근거 후보: doc/history/record.md#SCOPE") && lineOf(text, i4).includes("근거 사라짐: doc/gone2.md"), lineOf(text, i4));
			check(`${label}: 하위 폴더 세션이 남긴 기억도 git 최상위 기준으로 판정한다`,
				lineOf(text, i5).includes("근거 사라짐: doc/history/record.md#실패 원인"), lineOf(text, i5));
			check(`${label}: 전역 기억도 자기 cwd 기준으로 판정한다`, lineOf(text, i6).includes("근거 사라짐: doc/gone.md"), lineOf(text, i6));
			check(`${label}: 8MiB 넘는 파일의 앵커는 판정하지 않고 근거 후보로 둔다`,
				lineOf(text, i7).includes("근거 후보: doc/big.md#큰 절") && !lineOf(text, i7).includes("근거 사라짐"), lineOf(text, i7));
			check(`${label}: cwd 폴더가 통째로 사라진 기억은 판정하지 않고 근거 후보로 둔다`,
				lineOf(text, i8).includes("근거 후보: a.md") && !lineOf(text, i8).includes("근거 사라짐"), lineOf(text, i8));
			check(`${label}: 근거 사라짐 안내가 한 번만 붙고 근거 후보 안내도 남는다`,
				text.split("근거 사라짐 means").length === 2 && text.split("are where a memory says it was recorded").length === 2, text);
		}
		const row = st.memory.conn.query("SELECT metadata_json FROM working_memory WHERE id = ?").get(i1) as { metadata_json: string };
		check("표시는 읽기 전용이다: 저장된 citations 는 그대로다", JSON.stringify(JSON.parse(row.metadata_json).citations) === JSON.stringify([{ path: "doc/gone.md" }]), row.metadata_json);

		// 하위 폴더 세션에서 회상해도 같은 판정이다(세션 cwd 가 아니라 기억의 cwd 를 쓴다).
		const nestedText = String(await nested.st.recallForContext(query));
		check("하위 폴더 세션에서 회상해도 판정이 같다",
			lineOf(nestedText, i1).includes("근거 사라짐: doc/gone.md") && lineOf(nestedText, i2).includes("근거 후보: doc/history/record.md#배포 검증 절차"), nestedText);

		// git 을 못 쓸 때: 루트를 알 수 없으면 판정하지 않는다(근거 후보). 실패를 기억해 두면 안 된다.
		const deepCwd = join(project, "doc", "other");
		mkdirSync(deepCwd, { recursive: true });
		writeFileSync(join(project, "doc", "live.md"), "# 살아 있는 파일\n");
		const deep = open("fresh-deep", deepCwd, config);
		const m9 = await deep.learn({ memory: "zebra-m9 아직 한 번도 회상하지 않은 하위 폴더에서 남긴 교훈", kind: "evidence", citations: [{ path: "doc/live.md" }] });
		// git 저장소가 아닌 폴더(루트는 cwd 자신), 그리고 .git 이 있지만 git 이 못 읽는 폴더(루트를 알 수 없다).
		const plain = join(root, "plain");
		mkdirSync(plain, { recursive: true });
		writeFileSync(join(plain, "p.md"), "# p\n");
		const broken = join(root, "broken-repo");
		mkdirSync(join(broken, ".git"), { recursive: true });
		writeFileSync(join(broken, "b.md"), "# b\n");
		// .git 이 끊어진 심볼릭 링크이거나, 대상이 사라진 gitdir 포인터 파일이어도 .git 항목은 있다.
		const dangling = join(root, "dangling-link");
		mkdirSync(dangling, { recursive: true });
		symlinkSync(join(root, "no-such-gitdir"), join(dangling, ".git"));
		writeFileSync(join(dangling, "d.md"), "# d\n");
		const worktree = join(root, "gone-worktree");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), "gitdir: " + join(root, "no-such-worktree-gitdir") + "\n");
		writeFileSync(join(worktree, "w.md"), "# w\n");
		const m10 = await open("fresh-plain", plain, config).learn({ memory: "zebra-m10 저장소가 아닌 폴더의 교훈", kind: "evidence", citations: [{ path: "p.md" }] });
		const m11 = await open("fresh-broken", broken, config).learn({ memory: "zebra-m11 git 이 못 읽는 저장소의 교훈", kind: "evidence", citations: [{ path: "b.md" }] });
		const m12 = await open("fresh-dangling", dangling, config).learn({ memory: "zebra-m12 끊어진 .git 링크 폴더의 교훈", kind: "evidence", citations: [{ path: "d.md" }] });
		const m13 = await open("fresh-worktree", worktree, config).learn({ memory: "zebra-m13 gitdir 포인터가 끊어진 폴더의 교훈", kind: "evidence", citations: [{ path: "w.md" }] });
		check("전제: git 실패 시험용 기억 다섯이 저장됐다", [m9, m10, m11, m12, m13].every(r => r.ok), JSON.stringify([m9, m10, m11, m12, m13]));
		const [i9, i10, i11, i12, i13] = [m9, m10, m11, m12, m13].map(r => idOf(r.text));
		const query2 = "zebra-m9 zebra-m10 zebra-m11 zebra-m12 zebra-m13";
		const recall2 = async () => String(await st.recallForContext(query2));

		// git 이 실패하게 만든다: 저장소 메타데이터를 읽을 수 없으면 rev-parse 가 128 로 끝난다(root 로 돌릴 때는 막을 수 없어 건너뛴다).
		// Bun.spawnSync 는 실행 중 바꾼 process.env 를 자식에게 넘기지 않으므로 환경 변수로는 실패를 만들 수 없다.
		if (process.getuid?.() !== 0) {
			let offline: string;
			chmodSync(join(project, ".git"), 0o000);
			try {
				offline = await recall2();
			} finally {
				chmodSync(join(project, ".git"), 0o755);
			}
			check("git 이 실패하면 하위 폴더 기억의 멀쩡한 근거를 사라짐으로 단정하지 않는다",
				lineOf(offline, i9).includes("근거 후보: doc/live.md") && !lineOf(offline, i9).includes("근거 사라짐"), lineOf(offline, i9));
		} else console.log("  SKIP  root 로 실행 중이라 git 실패를 만들 수 없다");
		const online = await recall2();
		check("git 이 돌아오면 실패를 기억해 두지 않고 git 최상위 기준으로 다시 본다(멀쩡한 근거는 후보)",
			lineOf(online, i9).includes("근거 후보: doc/live.md") && !lineOf(online, i9).includes("근거 사라짐"), lineOf(online, i9));
		check("저장소가 아닌 폴더 기억은 cwd 를 루트로 보고 멀쩡하면 후보다", lineOf(online, i10).includes("근거 후보: p.md"), lineOf(online, i10));
		rmSync(join(project, "doc", "live.md"));
		rmSync(join(plain, "p.md"));
		rmSync(join(broken, "b.md"));
		rmSync(join(dangling, "d.md"));
		rmSync(join(worktree, "w.md"));
		const goneNow = await recall2();
		check("git 이 돌아온 뒤 정말 지워진 근거는 사라짐이다", lineOf(goneNow, i9).includes("근거 사라짐: doc/live.md"), lineOf(goneNow, i9));
		check("확실한 비저장소 폴더는 cwd 기준으로 지워진 근거를 사라짐으로 본다(learn 이 저장 때 쓴 루트와 같다)",
			lineOf(goneNow, i10).includes("근거 사라짐: p.md"), lineOf(goneNow, i10));
		check("git 이 못 읽는 저장소 폴더는 루트를 알 수 없어 지워져도 근거 후보로 둔다",
			lineOf(goneNow, i11).includes("근거 후보: b.md") && !lineOf(goneNow, i11).includes("근거 사라짐"), lineOf(goneNow, i11));
		check("끊어진 .git 심볼릭 링크 폴더도 .git 이 있다고 보고 루트를 알 수 없어 지워져도 근거 후보로 둔다",
			lineOf(goneNow, i12).includes("근거 후보: d.md") && !lineOf(goneNow, i12).includes("근거 사라짐"), lineOf(goneNow, i12));
		check("대상이 사라진 gitdir 포인터 .git 파일 폴더도 루트를 알 수 없어 지워져도 근거 후보로 둔다",
			lineOf(goneNow, i13).includes("근거 후보: w.md") && !lineOf(goneNow, i13).includes("근거 사라짐"), lineOf(goneNow, i13));
	}

	// ── 2. 비슷한 기억 알림 ────────────────────────────────────────────────────
	console.log("\n[2] learn — 저장 뒤 비슷한 기존 기억을 알린다(저장은 그대로)");
	{
		const L1 = "배포 검증은 헬스 확인 뒤에 끝낸다. 헬스가 4/4 일 때만 배포 완료로 보고한다.";
		const L2 = "배포 검증은 헬스 확인이 끝난 뒤에 끝낸다. 헬스가 4/4 일 때만 배포 완료로 보고한다.";
		const L3 = "사용자는 답변을 짧은 한국어 문장으로 받기를 원한다.";
		check("전제: 거의 같은 글은 코사인 0.90 이상, 다른 글은 0.90 미만이다", cosine(L1, L2) >= 0.9 && cosine(L1, L3) < 0.9, `L1·L2=${cosine(L1, L2).toFixed(3)} L1·L3=${cosine(L1, L3).toFixed(3)}`);

		const dir = join(root, "mem2");
		mkdirSync(dir, { recursive: true });
		const { st, learn } = open("similar", project, makeConfig(dir, { embeddingModel: E5, embeddings: { provider: hashProvider }, debug: false }));
		const embedded = async (id: string) => {
			for (let i = 0; i < 100; i++) {
				if (Number((st.memory.conn.query("SELECT COUNT(*) n FROM memory_embeddings WHERE memory_id = ?").get(id) as { n: number }).n) > 0) return true;
				await Bun.sleep(100);
			}
			return false;
		};
		const recallCount = (id: string) => Number((st.memory.conn.query("SELECT recall_count n FROM working_memory WHERE id = ?").get(id) as { n: number }).n);

		const a = await learn({ memory: L1, kind: "procedure" });
		const aId = idOf(a.text);
		check("첫 교훈은 기존 기억이 없으니 알림이 없다", a.ok && !a.text.includes("비슷한 기존 기억"), a.text);
		check("전제: 첫 교훈의 임베딩이 저장됐다", await embedded(aId));
		const countBefore = recallCount(aId);

		const b = await learn({ memory: L2, kind: "procedure" });
		const bId = idOf(b.text);
		const hintLines = b.text.split("\n").filter((l: string) => l.startsWith("비슷한 기존 기억:"));
		check("거의 같은 둘째 교훈은 첫 교훈 id 와 앞부분(80자 안, 짧으면 전문)을 알린다",
			b.ok && hintLines.length === 1 && hintLines[0] === `비슷한 기존 기억: ${aId} — ${L1}`, b.text);
		check("알림은 새로 저장된 자기 id 를 나열하지 않는다", !hintLines.some((l: string) => l.includes(bId)), b.text);
		check("알림은 같은 교훈이면 같은 topic 키나 xd://memory_edit 로 고치라고 안내한다", b.text.includes("topic key") && b.text.includes("xd://memory_edit"), b.text);
		check("저장은 그대로다: 둘째 교훈도 id 와 함께 저장됐다", b.ok && b.text.startsWith("Lesson stored (id: ") && bId !== aId, b.text);
		check("조회는 기존 기억을 강화하지 않는다(recall_count 불변)", recallCount(aId) === countBefore, `before=${countBefore} after=${recallCount(aId)}`);

		const c = await learn({ memory: L3, kind: "preference" });
		check("관련 없는 교훈에는 알림이 없다", c.ok && !c.text.includes("비슷한 기존 기억"), c.text);

		// topic: 같은 topic 키로 다시 쓰면 자기 자신을 나열하지 않는다.
		const T1 = "릴리스 노트는 변경 이유부터 쓴다. 이유가 없는 항목은 노트에 싣지 않는다.";
		const t1 = await learn({ memory: T1, topic: "release-note-order", kind: "procedure" });
		check("전제: topic 교훈의 임베딩이 저장됐다", await embedded(idOf(t1.text)));
		const t2 = await learn({ memory: T1, topic: "release-note-order", kind: "procedure" });
		const topicEmbedded = Number((st.memory.conn.query("SELECT COUNT(*) n FROM memory_embeddings WHERE memory_id = ?").get(idOf(t1.text)) as { n: number }).n) > 0;
		check("같은 topic 키로 다시 쓰면 같은 행이고 자기 자신을 비슷한 기억으로 나열하지 않는다(그 행의 임베딩이 남아 있어 후보가 될 수 있는 상태에서)",
			t2.ok && topicEmbedded && idOf(t1.text) === idOf(t2.text) && !t2.text.includes("비슷한 기존 기억"), t2.text);
		check("전제: 정정된 topic 행의 임베딩이 다시 저장됐다", await embedded(idOf(t1.text)));
		const t3 = await learn({ memory: T1 + "  ", kind: "procedure" });
		check("topic 없이 같은 글을 새로 쓰면 topic 행을 비슷한 기억으로 알린다", t3.text.includes(`비슷한 기존 기억: ${idOf(t1.text)} — `), t3.text);

		// 여러 개여도 3줄까지.
		const D = (n: number) => `반복되는 교훈 ${"가나다라".repeat(8)} 여섯 번째 규칙 변형 ${n}번이다.`;
		const ids: string[] = [];
		for (let n = 0; n < 5; n++) {
			const r = await learn({ memory: D(n), kind: "procedure" });
			ids.push(idOf(r.text));
			await embedded(ids[n]!);
		}
		const last = await learn({ memory: D(9), kind: "procedure" });
		check("비슷한 기억이 많아도 알림은 3줄까지다", last.text.split("\n").filter((l: string) => l.startsWith("비슷한 기존 기억:")).length === 3, last.text);

		// 조회가 실패해도 저장 결과는 그대로다.
		const original = st.memory.recall.bind(st.memory);
		st.memory.recall = () => Promise.reject(new Error("조회 실패 시뮬레이션"));
		const broken = await learn({ memory: L2 + " 셋째", kind: "procedure" });
		st.memory.recall = original;
		check("비슷한 기억 조회가 실패해도 저장은 성공하고 알림만 빠진다", broken.ok && broken.text.startsWith("Lesson stored (id: ") && !broken.text.includes("비슷한 기존 기억"), broken.text);
	}

	console.log("\n[3] learn — 임베딩이 꺼져 있으면 알림 없이 조용히 저장한다");
	{
		const dir = join(root, "mem3");
		mkdirSync(dir, { recursive: true });
		const { learn } = open("similar-off", project, makeConfig(dir, { noEmbeddings: true, debug: false }));
		const a = await learn({ memory: "배포 검증은 헬스 확인 뒤에 끝낸다. 헬스가 4/4 일 때만 배포 완료로 보고한다.", kind: "procedure" });
		const b = await learn({ memory: "배포 검증은 헬스 확인이 끝난 뒤에 끝낸다. 헬스가 4/4 일 때만 배포 완료로 보고한다.", kind: "procedure" });
		check("임베딩 꺼짐: 거의 같은 교훈을 거듭 저장해도 알림도 오류도 없다", a.ok && b.ok && !b.text.includes("비슷한 기존 기억") && b.text.startsWith("Lesson stored (id: "), JSON.stringify([a, b]));
	}
} finally {
	for (const { st } of openStates) {
		st.unsubscribe?.();
		for (const m of new Set([st.memory, st.globalMemory])) (m as { close(): void } | undefined)?.close();
	}
	rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
