// 기억 주입 게이트(턴 단위 원시 dense)와 근거형 learn citations 검증. 실행:
//   OMP_CORE_PATCH_TARGET=<patched-core> bun run patches/core-memory-gate-citations-test.ts
// 게이트: 자동 첫 턴 회상에서 상위 후보의 원시 dense 최댓값이 기준 미만이면 그 턴은 기억을 싣지 않는다. 명시 recall·압축 회상은
// 게이트를 받지 않는다. citations: kind evidence(project)는 존재하는 근거 파일을 요구하고, 회상 줄에 `근거 후보:` 로 나온다.
// 동적 import 예외: core-bai-retry-test.ts 와 같다(지정한 사본만 검증). 네트워크·`~/.omp` 접근 없음(임베딩 끔·임시 폴더).
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const { LearnTool } = await import(`${CORE}/tools/learn.ts`);
await stateMod.loadMnemopi();
await stateMod.loadMnemopiCore();
const { Mnemopi } = await import(`${CORE}/../../pi-mnemopi/src/core/memory.ts`);

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

const root = mkdtempSync(join(tmpdir(), "omp-gate-citations-"));
try {
	// ── 1. 설정 ────────────────────────────────────────────────────────────────
	console.log("\n[1] mnemopi.recallDenseGate — 기본 0.80, 0 은 끔, 범위는 0~1");
	{
		const cfg = (value?: number) =>
			loadMnemopiConfig(Settings.isolated({ "memory.backend": "mnemopi", ...(value === undefined ? {} : { "mnemopi.recallDenseGate": value }) }), join(root, "agent"));
		check("기본값은 0.8 이다", cfg().recallDenseGate === 0.8, `got ${cfg().recallDenseGate}`);
		check("0 은 그대로 둔다(끔)", cfg(0).recallDenseGate === 0);
		check("범위를 넘는 값은 0~1 로 자른다", cfg(5).recallDenseGate === 1 && cfg(-1).recallDenseGate === 0);
	}

	// ── 2. 자동 첫 턴 게이트 ───────────────────────────────────────────────────
	console.log("\n[2] 자동 첫 턴 회상 — 후보의 원시 dense 최댓값이 기준 미만이면 그 턴은 기억을 싣지 않는다");
	{
		const E5 = "intfloat/multilingual-e5-large";
		const row = (id: string, dense: number | undefined) => ({ id, content: `기억 ${id}`, source: "coding-agent-learn", timestamp: "2026-10-01T00:00:00Z", score: 0.9, dense_score: dense });
		const scenario = async (dense: Array<number | undefined>, options: { gate?: number; model?: string; compaction?: boolean } = {}) => {
			const rows = dense.map((d, i) => row(`m${i}`, d));
			const target = { bank: "bank", memory: { recallEnhanced: async () => rows, get: () => null } };
			const parentState = {
				config: {
					autoRecall: true, autoRetain: false, recallLimit: 8, recallContextTurns: 1, recallMaxQueryChars: 2000, bank: "bank", globalBank: "bank",
					dbPath: join(root, "gate.db"), recallDenseGate: options.gate ?? 0.8, providerOptions: { embeddingModel: options.model ?? E5, debug: false },
				},
				scoped: { recall: [target], retain: target },
			};
			const recorded: Array<{ customType: string; data: unknown }> = [];
			const session = {
				sessionId: "gate-child",
				settings: settingsLike({ get: (key: string) => (key === "mnemopi.injectionTokenLimit" ? 5000 : undefined) }) as never,
				getXdevToolEntries: () => [],
				sessionManager: { getEntries: () => [], getBranch: () => [], appendCustomEntry: (customType: string, data: unknown) => { recorded.push({ customType, data }); return "entry"; } },
			} as never;
			await mnemopiBackend.start({ session, settings: (session as { settings: never }).settings, agentDir: "", taskDepth: 1, parentMnemopiSessionState: parentState } as never);
			if (options.compaction) {
				const state = stateMod.getMnemopiSessionState(session);
				return { recorded, text: await state.recallForContext("압축 회상 질의"), staged: undefined as never, session };
			}
			const staged = await mnemopiBackend.beforeAgentStartPrompt(session, "배포 절차 알려줘");
			return { recorded, staged, text: staged?.context, session };
		};
		const gatedEntries = (r: { recorded: Array<{ customType: string }> }) => r.recorded.filter(entry => entry.customType === "mnemopi-recall-gated");

		const low = await scenario([0.7, 0.78, 0.5]);
		check("최댓값 0.78 < 0.80 이면 기억을 싣지 않는다", low.text === undefined, `text=${JSON.stringify(low.text)}`);
		check("건너뛴 턴은 dense 값과 기준을 세션 기록에 남긴다(주입 id 기록은 없다)",
			JSON.stringify(gatedEntries(low)) === JSON.stringify([{ customType: "mnemopi-recall-gated", data: { dense: 0.78, gate: 0.8, candidates: 3 } }]) &&
			low.recorded.every(entry => entry.customType !== "mnemopi-recall"), JSON.stringify(low.recorded));
		check("건너뛴 턴도 첫 턴 회상으로 끝난다(commit 성공, 두 번째 턴은 다시 회상하지 않는다)",
			low.staged?.commit() === true && (await mnemopiBackend.beforeAgentStartPrompt(low.session, "다음 턴")) === undefined);

		const exact = await scenario([0.8]);
		check("최댓값이 기준과 같으면 싣는다(>= 기준)", exact.text?.includes("(id: m0)") === true, `text=${JSON.stringify(exact.text)}`);
		const mixed = await scenario([0.62, 0.86, 0.5]);
		check("후보 중 하나라도 기준 이상이면 후보 전부를 싣는다(기억별 점수 컷은 바꾸지 않는다)",
			["m0", "m1", "m2"].every(id => mixed.text?.includes(`(id: ${id})`)) && gatedEntries(mixed).length === 0, `text=${JSON.stringify(mixed.text)}`);
		const off = await scenario([0.5], { gate: 0 });
		check("기준 0 이면 게이트를 끈다", off.text?.includes("(id: m0)") === true);
		const bge = await scenario([0.5], { model: "BAAI/bge-base-en-v1.5" });
		check("e5 가 아닌 임베딩은 이 기준을 쓰지 않는다(코사인 범위가 다르다)", bge.text?.includes("(id: m0)") === true);
		const noSignal = await scenario([undefined, 0]);
		check("dense 신호가 전혀 없으면(임베딩 없음) 게이트하지 않는다", noSignal.text?.includes("(id: m0)") === true, `text=${JSON.stringify(noSignal.text)}`);
		const compaction = await scenario([0.5], { compaction: true });
		check("압축 회상(recallForContext 기본 호출)은 게이트를 받지 않는다", compaction.text?.includes("(id: m0)") === true, `text=${JSON.stringify(compaction.text)}`);
	}

	// ── 3. 근거형 learn ────────────────────────────────────────────────────────
	console.log("\n[3] learn — project 의 kind evidence 는 실제 근거 파일을 달아야 저장되고, 회상에 근거 후보로 나온다");
	{
		const project = join(root, "project");
		mkdirSync(join(project, "doc", "history"), { recursive: true });
		Bun.spawnSync(["git", "init", "-q", project]);
		writeFileSync(join(project, ".gitignore"), "ignored.md\n");
		writeFileSync(join(project, "doc", "history", "record.md"), "# 기록\n\nRECORD: x\nDATE: 2026-10-17\nSCOPE: 배포 검증\n\n## 배포 검증 절차\n\n본문 한 줄.\n\n## 실패 원인 (2026-10-17)\n\n둘째 본문.\n");
		writeFileSync(join(project, "ignored.md"), "# ignored\n");
		writeFileSync(join(project, ".env"), "KEY=value\n");
		writeFileSync(join(root, "outside.md"), "# outside\n");
		try {
			symlinkSync(join(root, "outside.md"), join(project, "link.md"));
		} catch {
			// 심볼릭 링크를 못 만드는 환경은 그 사례만 건너뛴다.
		}
		const dir = join(root, "mem");
		mkdirSync(dir, { recursive: true });
		const config = {
			dbPath: join(dir, "m.db"), baseBank: "shared", bank: "projA", globalBank: "shared", retainBank: "projA", recallBanks: ["projA", "shared"],
			scoping: "per-project-tagged", autoRecall: true, autoRetain: false, polyphonicRecall: false, enhancedRecall: true,
			proactiveLinking: false, retainEveryNTurns: 1, recallLimit: 8, recallContextTurns: 1, recallMaxQueryChars: 800,
			injectionTokenLimit: 2000, debug: false, providerOptions: { noEmbeddings: true, debug: false }, llmMode: "none",
		};
		const session: Record<string, unknown> = {
			sessionId: "cite-session", cwd: project, sessionFile: undefined, sessionManager: { getCwd: () => project, getSessionId: () => "cite-session" },
			settings: settingsLike({ get: (k: string) => (k === "memory.backend" ? "mnemopi" : k === "autolearn.enabled" ? true : undefined) }),
		};
		const st = new stateMod.MnemopiSessionState({ sessionId: "cite-session", config, session: session as never });
		session.getMnemopiSessionState = () => st;
		stateMod.setMnemopiSessionState(session as never, st);
		const tool = new LearnTool(session as never);
		const count = () => Number((st.memory.conn.query("SELECT COUNT(*) n FROM working_memory").get() as { n: number }).n);
		const attempt = (args: Record<string, unknown>) => tool.execute("cite", args as never).then(
			result => ({ ok: true as const, text: String(result.content[0]?.text) }),
			(error: Error) => ({ ok: false as const, text: error.message }),
		);
		const metaOf = (id: string) => {
			for (const memory of [st.memory, st.globalMemory]) {
				const found = memory.conn.query("SELECT metadata_json FROM working_memory WHERE id = ?").get(id) as { metadata_json: string } | null;
				if (found) return JSON.parse(found.metadata_json);
			}
			throw new Error("memory not found: " + id);
		};
		const idOf = (text: string) => /id: ([^,)]+)/.exec(text)![1]!;
		const record = "doc/history/record.md";
		try {
			const noKind = await attempt({ memory: "배포 검증은 헬스 확인 뒤에 끝낸다" });
			check("kind 도 citations 도 없으면 거절하고 무엇을 붙일지 알려 준다",
				!noKind.ok && noKind.text.includes("kind evidence") && noKind.text.includes("citations") && noKind.text.includes("preference") && count() === 0, noKind.text);
			const bare = await attempt({ memory: "배포 검증은 헬스 확인 뒤에 끝낸다", kind: "evidence" });
			check("kind evidence 에 citations 가 없으면 거절한다", !bare.ok && bare.text.includes("at least one citation") && count() === 0, bare.text);
			const emptyList = await attempt({ memory: "배포 검증은 헬스 확인 뒤에 끝낸다", kind: "evidence", citations: [] });
			check("빈 citations 도 거절한다", !emptyList.ok && count() === 0, emptyList.text);

			const good = await attempt({ memory: "배포 검증은 헬스 확인 뒤에 끝낸다", kind: "evidence", citations: [{ path: record, anchor: "배포 검증 절차" }, { path: "doc/history/../history/record.md", anchor: "RECORD" }] });
			const goodMeta = good.ok ? metaOf(idOf(good.text)) : {};
			check("유효한 경로·절 제목 citation 은 저장하고 metadata 에 kind·citations 를 남긴다",
				good.ok && goodMeta.kind === "evidence" && JSON.stringify(goodMeta.citations) === JSON.stringify([{ path: record, anchor: "배포 검증 절차" }, { path: record, anchor: "RECORD" }]) && goodMeta.tool === "learn", JSON.stringify([good, goodMeta]));
			const inferred = await attempt({ memory: "citations 만 있어도 evidence 로 저장한다", citations: [{ path: record }] });
			check("kind 없이 citations 만 주면 evidence 로 저장한다", inferred.ok && metaOf(idOf(inferred.text)).kind === "evidence" && JSON.stringify(metaOf(idOf(inferred.text)).citations) === JSON.stringify([{ path: record }]), inferred.text);
			const dupe = await attempt({ memory: "같은 citation 은 하나로 합친다", kind: "evidence", citations: [{ path: record, anchor: "SCOPE" }, { path: `./${record}`, anchor: " SCOPE " }] });
			check("같은 경로·앵커는 한 번만 남긴다", dupe.ok && metaOf(idOf(dupe.text)).citations.length === 1, dupe.text);
			const line = await attempt({ memory: "줄 범위 앵커도 받는다", kind: "evidence", citations: [{ path: record, anchor: "6-9" }] });
			check("파일 안의 줄 범위 앵커를 받는다", line.ok, line.text);
			const heading = await attempt({ memory: "괄호가 붙은 절 제목은 앞부분만 줘도 받는다", kind: "evidence", citations: [{ path: record, anchor: "## 실패 원인" }] });
			check("'## ' 접두를 붙인 제목·제목 앞부분을 받고, 저장할 때는 접두를 뗀다", heading.ok && JSON.stringify(metaOf(idOf(heading.text)).citations) === JSON.stringify([{ path: record, anchor: "실패 원인" }]), heading.text);

			const before = count();
			const missing = await attempt({ memory: "없는 파일을 인용한다", kind: "evidence", citations: [{ path: "doc/history/none.md" }] });
			check("없는 파일은 저장 전에 거절한다", !missing.ok && missing.text.includes("does not exist") && missing.text.includes("citations[0]"), missing.text);
			const outside = await attempt({ memory: "프로젝트 밖 파일을 인용한다", kind: "evidence", citations: [{ path: "../outside.md" }] });
			check("프로젝트 밖 경로(..)는 거절한다", !outside.ok && outside.text.includes("outside the project root"), outside.text);
			const absolute = await attempt({ memory: "프로젝트 밖 절대 경로를 인용한다", kind: "evidence", citations: [{ path: join(root, "outside.md") }] });
			check("프로젝트 밖 절대 경로는 거절한다", !absolute.ok && absolute.text.includes("outside the project root"), absolute.text);
			if (existsSync(join(project, "link.md"))) {
				const link = await attempt({ memory: "밖을 가리키는 링크를 인용한다", kind: "evidence", citations: [{ path: "link.md" }] });
				check("프로젝트 밖을 가리키는 심볼릭 링크는 거절한다", !link.ok && link.text.includes("outside the project root"), link.text);
			}
			const secret = await attempt({ memory: "비밀 파일을 인용한다", kind: "evidence", citations: [{ path: ".env" }] });
			check("비밀 파일(.env)은 인용할 수 없다", !secret.ok && secret.text.includes("cannot be cited"), secret.text);
			const ignored = await attempt({ memory: "무시된 파일을 인용한다", kind: "evidence", citations: [{ path: "ignored.md" }] });
			check("git 이 무시하는 파일은 인용할 수 없다", !ignored.ok && ignored.text.includes("cannot be cited"), ignored.text);
			const directory = await attempt({ memory: "폴더를 인용한다", kind: "evidence", citations: [{ path: "doc/history" }] });
			check("폴더는 인용할 수 없다", !directory.ok && directory.text.includes("not a file"), directory.text);
			const badAnchor = await attempt({ memory: "없는 절을 인용한다", kind: "evidence", citations: [{ path: record, anchor: "없는 절" }] });
			check("없는 앵커는 거절하고 파일의 절 제목을 알려 준다",
				!badAnchor.ok && badAnchor.text.includes("was not found in doc/history/record.md") && badAnchor.text.includes("배포 검증 절차"), badAnchor.text);
			const badRange = await attempt({ memory: "범위 밖 줄을 인용한다", kind: "evidence", citations: [{ path: record, anchor: "40-50" }] });
			check("파일 밖 줄 범위는 거절한다", !badRange.ok && badRange.text.includes("was not found"), badRange.text);
			const badField = await attempt({ memory: "없는 헤더 필드를 인용한다", kind: "evidence", citations: [{ path: record, anchor: "PATHS" }] });
			check("파일 머리에 없는 헤더 필드는 거절한다", !badField.ok, badField.text);
			const tooMany = await attempt({ memory: "너무 많이 인용한다", kind: "evidence", citations: Array.from({ length: 9 }, (_, i) => ({ path: record, anchor: `${i + 1}` })) });
			check("citations 는 8개까지다", !tooMany.ok && tooMany.text.includes("at most 8"), tooMany.text);
			check("거절된 호출은 아무것도 저장하지 않는다", count() === before, `before=${before} after=${count()}`);

			const pref = await attempt({ memory: "사용자는 답을 짧게 받기를 원한다", kind: "preference" });
			const prefMeta = pref.ok ? metaOf(idOf(pref.text)) : {};
			check("preference 는 citation 없이 저장하고 kind 만 남긴다", pref.ok && prefMeta.kind === "preference" && !("citations" in prefMeta), JSON.stringify([pref, prefMeta]));
			const hypothesis = await attempt({ memory: "아직 확인 안 된 추측이다", kind: "hypothesis" });
			check("hypothesis·procedure 도 citation 없이 저장한다", hypothesis.ok && (await attempt({ memory: "절차 메모", kind: "procedure" })).ok);
			const withPrefCite = await attempt({ memory: "preference 에 citation 을 붙여도 검증한다", kind: "preference", citations: [{ path: "doc/none.md" }] });
			check("preference 에 citation 을 주면 그것은 검증한다", !withPrefCite.ok && withPrefCite.text.includes("does not exist"), withPrefCite.text);
			const globalNoKind = await attempt({ memory: "전역 교훈은 kind 없이도 저장한다", scope: "global" });
			check("global scope 는 kind 없이 저장할 수 있다(근거 요구는 project 만)", globalNoKind.ok && !("kind" in metaOf(idOf(globalNoKind.text))), globalNoKind.text);

			// topic: 새 revision 의 kind·citations 가 이전 것을 대체한다.
			const t1 = await attempt({ memory: "topic 교훈 첫 판", topic: "cite-topic", kind: "evidence", citations: [{ path: record, anchor: "SCOPE" }] });
			const t2 = await attempt({ memory: "topic 교훈 정정판", topic: "cite-topic", kind: "evidence", citations: [{ path: record, anchor: "배포 검증 절차" }] });
			const t2Meta = t2.ok ? metaOf(idOf(t2.text)) : {};
			check("topic 정정은 같은 행의 citations 를 최신 판으로 바꾼다",
				t1.ok && t2.ok && idOf(t1.text) === idOf(t2.text) && t2Meta.revision === 2 && JSON.stringify(t2Meta.citations) === JSON.stringify([{ path: record, anchor: "배포 검증 절차" }]) && t2Meta.kind === "evidence", JSON.stringify([t1, t2, t2Meta]));
			const t3 = await attempt({ memory: "topic 교훈 근거 없는 정정", topic: "cite-topic", kind: "hypothesis" });
			const t3Meta = t3.ok ? metaOf(idOf(t3.text)) : {};
			check("topic 을 근거 없는 kind 로 정정하면 옛 citations 를 남기지 않는다", t3.ok && t3Meta.kind === "hypothesis" && !("citations" in t3Meta), JSON.stringify([t3, t3Meta]));
			const tBad = await attempt({ memory: "topic 인데 근거가 없다", topic: "cite-topic-2", kind: "evidence" });
			check("topic 이어도 evidence 는 citations 를 요구한다", !tBad.ok && count() >= 0 && tBad.text.includes("at least one citation"), tBad.text);

			// 회상: 근거 후보가 줄에 붙고, 확인 안내가 한 번만 나온다.
			const query = "배포 검증 헬스 확인 citations 근거 후보 앵커";
			const injected = String(await st.recallForContext(query));
			const goodId = idOf(good.ok ? good.text : "id: none");
			const goodLine = injected.split("\n").find(l => l.includes(`(id: ${goodId})`)) ?? "";
			check("자동 주입 줄에 근거 후보(경로#앵커)가 붙는다", /\{[^}]*근거 후보: doc\/history\/record\.md#배포 검증 절차, doc\/history\/record\.md#RECORD[^}]*\} \(id: /.test(goodLine), `line=${goodLine}\n${injected}`);
			check("근거 후보는 확인할 위치라는 안내가 블록에 한 번만 붙는다", injected.split("are where a memory says it was recorded").length === 2, injected);
			const prefText = String(await st.recallForContext("사용자는 답을 짧게 받기를 원한다 preference"));
			const prefLine = prefText.split("\n").find(l => l.includes("답을 짧게")) ?? "";
			check("citation 이 없는 기억 줄에는 근거 후보가 없다", prefLine !== "" && !prefLine.includes("근거 후보"), prefLine);
			const toolText = st.formatScopedRecallWithIds(await st.recallResultsScoped(query));
			check("recall 도구 출력도 같은 근거 후보를 보인다", toolText.includes("근거 후보: doc/history/record.md#배포 검증 절차"), toolText);
			// 증거 교훈에서 뽑힌 fact 줄도 출처 기억의 citations 를 보인다(fact 는 source_memory_id 만 가진다). 출처 기억이 같이 회상되면 fact 는 코어가 뺀다.
			const factId = "fact-cite-1";
			const factRowCols = (st.memory.conn.query("PRAGMA table_info(facts)").all() as Array<{ name: string }>).map(c => c.name);
			const factRow: Record<string, string | number> = { fact_id: factId, session_id: st.memory.beam.sessionId, subject: "배포검증", predicate: "절차", object: "FACTCITE 배포 검증 헬스 확인 절차는 기록을 따른다", timestamp: new Date().toISOString(), source_msg_id: goodId, confidence: 0.9, created_at: new Date().toISOString(), scope: "session" };
			const usable = Object.keys(factRow).filter(k => factRowCols.includes(k));
			st.memory.conn.query(`INSERT INTO facts (${usable.join(",")}) VALUES (${usable.map(() => "?").join(",")})`).run(...usable.map(k => factRow[k] as string | number));
			const factText = st.formatScopedRecallWithIds(await st.recallResultsScoped("FACTCITE"));
			const factLine = factText.split("\n").find(l => l.includes("FACTCITE")) ?? "";
			check("fact 줄도 출처 기억의 근거 후보를 보인다", factLine.includes("[facts]") && factLine.includes("근거 후보: doc/history/record.md#배포 검증 절차"), factLine || factText);
			const longPath = `${"d".repeat(100)}/${"f".repeat(60)}.md`;
			mkdirSync(join(project, "d".repeat(100)), { recursive: true });
			writeFileSync(join(project, longPath), "# long\n");
			const many = await attempt({ memory: "여러 근거 후보 표시는 세 개까지다 긴경로", kind: "evidence", citations: [{ path: record, anchor: "1" }, { path: record, anchor: "2" }, { path: record, anchor: "3" }, { path: record, anchor: "4" }, { path: longPath }] });
			const manyText = String(await st.recallForContext("여러 근거 후보 표시는 세 개까지다 긴경로"));
			check("근거 후보는 세 개까지 보이고 나머지는 건수로 줄인다", many.ok && manyText.includes("외 2건") && manyText.includes("#3") && !manyText.includes("#4"), manyText);
		} finally {
			st.unsubscribe?.();
			for (const m of new Set([st.memory, st.globalMemory])) (m as { close(): void } | undefined)?.close();
		}
	}

	// ── 4. learn 스키마 ────────────────────────────────────────────────────────
	console.log("\n[4] learn schema — kind·citations 가 도구 인자로 노출된다");
	{
		const tool = new LearnTool({ settings: settingsLike({ get: (k: string) => (k === "memory.backend" ? "mnemopi" : k === "autolearn.enabled" ? true : undefined) }), cwd: root } as never);
		const schema = tool.parameters as unknown as { toJsonSchema?: () => unknown; json?: unknown };
		const json = JSON.stringify(schema.toJsonSchema?.() ?? schema.json ?? {});
		check("parameters 에 kind 와 citations 가 있다", json.includes('"kind"') && json.includes('"citations"') && json.includes("evidence"), json.slice(0, 400));
		check("도구 설명이 kind 와 citations 규칙을 알린다", tool.description.includes("`kind` is required in project scope") && tool.description.includes("citations"));
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
