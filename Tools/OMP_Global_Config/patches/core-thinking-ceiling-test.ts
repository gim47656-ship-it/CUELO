// 「Auto, 최대 X」 session thinking 상한 회귀. 실행:
//   OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-thinking-ceiling-test.ts
// 미패치 core에는 상한 setter가 없어 [0]부터 FAIL(RED)이다. 패치 core에서는 전부 PASS다.
// 실제 ModelRegistry의 Opus 5.5(effort low~max)와 실제 ModelControls를 쓴다. auto 결과는 `ultrathink`
// 경로(분류기 대신 모델 최고 effort)로 정해 모델 호출 없이 재현한다 — 분류기 결과와 같은 clamp를 지난다.
// 네트워크·`~/.omp` 접근 없음. 동적 import 예외: core-bai-retry-test.ts와 같은 이유(지정한 사본만 검증).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsTestScope } from "./core-test-settings";

/** 전역 npm 위치는 PC마다 다르다. apply-core-patch.mjs와 같은 순서로 찾는다. */
function resolveCore(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = env
		? [env]
		: [join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"), join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"), join(root, "@oh-my-pi/pi-coding-agent")];
	const hit = candidates.find(p => existsSync(join(p, "src/session/model-controls.ts")));
	if (!hit) throw new Error(`core 사본을 찾지 못했다: ${candidates.join(", ")}`);
	// 동적 import는 URL로 해석되므로 역슬래시를 쓰면 안 된다.
	return join(hit, "src").replace(/\\/g, "/");
}

const CORE = resolveCore();
console.log(`대상 ${CORE}`);
const { ModelRegistry } = await import(`${CORE}/config/model-registry.ts`);
const { ModelControls } = await import(`${CORE}/session/model-controls.ts`);
const { AgentSession } = await import(`${CORE}/session/agent-session.ts`);
const PI_AI = join(CORE, "..", "..", "pi-ai", "src").replace(/\\/g, "/");
const { AuthStorage } = await import(`${PI_AI}/auth-storage.ts`);

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

const workdir = mkdtempSync(join(tmpdir(), "omp-thinking-ceiling-"));
const auth = await AuthStorage.create(join(workdir, "auth.db"));
const settings = createSettingsTestScope(() => undefined) as never;
const offline = (async () => new Response("offline", { status: 503 })) as never;
const modelsFile = join(workdir, "models.yml");
writeFileSync(modelsFile, "providers: {}\n", "utf8");
const registry = new ModelRegistry(auth, modelsFile, { cacheDbPath: join(workdir, "models.db"), fetch: offline, settings });
const model = registry.find("anthropic", "claude-opus-5-5");
if (!model?.thinking?.efforts?.includes("max")) throw new Error(`Opus 5.5 effort 목록이 예상과 다르다: ${JSON.stringify(model?.thinking)}`);

type Entry = { level: string | undefined; configured: string | undefined };
function controls(options: { thinkingLevel?: string; thinkingLevelCeiling?: string }) {
	const entries: Entry[] = [];
	const wire: { effort?: unknown } = {};
	const host = {
		agent: {
			setThinkingLevel: (effort: unknown) => {
				wire.effort = effort;
			},
			setDisableReasoning: () => {},
			metadataForProvider: () => undefined,
			telemetry: undefined,
		},
		settings,
		modelRegistry: registry,
		sessionManager: {
			appendThinkingLevelChange: (level: string | undefined, configured: string | undefined) => {
				entries.push({ level, configured });
			},
			getSessionId: () => "ceiling-test",
			getLeafId: () => null,
			appendModelUsage: () => undefined,
		},
		providerSessionState: new Map(),
		model: () => model,
		sessionId: () => "ceiling-test",
		promptGeneration: () => 1,
		magicKeywordEnabled: () => true,
		clearInheritedProviderPromptCacheKey: () => {},
		emit: () => {},
		emitSessionEvent: async () => {},
		emitNotice: () => {},
	};
	return { c: new ModelControls(host as never, options as never), entries, wire };
}
/** auto 한 턴을 돌린다. `ultrathink`라 분류 결과는 모델 최고 effort(max)다. */
const autoTurn = (c: { applyAutoThinkingLevel(text: string, generation: number): Promise<void> }) => c.applyAutoThinkingLevel("ultrathink 이 요청", 1);

const probe = controls({ thinkingLevel: "auto" });
const hasSetter = typeof probe.c.setThinkingLevelCeiling === "function";
check("[0] ModelControls에 상한 setter가 있다", hasSetter);
check("[1] AgentSession이 상한 setter를 드러낸다", typeof AgentSession.prototype.setThinkingLevelCeiling === "function");

if (hasSetter) {
	// auto + 상한: 분류 결과(max)가 상한으로 잘리고 auto는 그대로다.
	const a = controls({ thinkingLevel: "auto" });
	a.c.setThinkingLevelCeiling("medium");
	await autoTurn(a.c);
	check("[2] auto 결과가 상한 medium으로 잘린다", a.c.thinkingLevel === "medium" && a.c.configuredThinkingLevel() === "auto", `${a.c.thinkingLevel}/${a.c.configuredThinkingLevel()}`);
	check("[2b] wire effort도 medium이다", a.wire.effort === "medium", String(a.wire.effort));

	a.c.setThinkingLevelCeiling("low");
	const lowered = a.entries.at(-1);
	check("[3] 상한을 low로 내리면 resolved도 low, auto 유지, 기록 남김", a.c.thinkingLevel === "low" && a.c.configuredThinkingLevel() === "auto" && lowered?.level === "low" && lowered.configured === "auto", JSON.stringify(lowered));

	a.c.setThinkingLevelCeiling("xhigh");
	check("[4] 상한을 xhigh로 올리면 상한 전 결과(max)에서 다시 잘려 xhigh", a.c.thinkingLevel === "xhigh" && a.c.configuredThinkingLevel() === "auto", String(a.c.thinkingLevel));

	a.c.setThinkingLevelCeiling(undefined);
	check("[5] 상한을 지우면 분류 결과 max로 돌아가고 상한 없음", a.c.thinkingLevel === "max" && a.c.thinkingLevelCeiling === undefined && a.c.configuredThinkingLevel() === "auto", `${a.c.thinkingLevel}/${a.c.thinkingLevelCeiling}`);

	// 재기동 복원(record=false)은 기록을 남기지 않고, 복원한 상한도 다시 올릴 수 있다.
	const r = controls({ thinkingLevel: "auto" });
	const before = r.entries.length;
	r.c.setThinkingLevelCeiling("low", false);
	check("[6] 복원(record=false)은 thinking 기록을 남기지 않는다", r.entries.length === before && r.c.thinkingLevel === "low", `${r.entries.length - before}건 ${r.c.thinkingLevel}`);
	await autoTurn(r.c);
	r.c.setThinkingLevelCeiling("high");
	check("[7] 복원한 상한을 high로 올릴 수 있다", r.c.thinkingLevel === "high" && r.c.thinkingLevelCeiling === "high", `${r.c.thinkingLevel}/${r.c.thinkingLevelCeiling}`);

	// spawn 상한(task.maxEffort)은 이 경로로 넓어지지 않는다.
	const s = controls({ thinkingLevel: "auto", thinkingLevelCeiling: "medium" });
	s.c.setThinkingLevelCeiling("xhigh");
	await autoTurn(s.c);
	check("[8] spawn 상한 medium 위로 사용자 상한 xhigh를 걸어도 medium", s.c.thinkingLevel === "medium" && s.c.thinkingLevelCeiling === "medium", `${s.c.thinkingLevel}/${s.c.thinkingLevelCeiling}`);
	s.c.setThinkingLevelCeiling(undefined);
	check("[9] 사용자 상한을 지워도 spawn 상한 medium은 남는다", s.c.thinkingLevel === "medium" && s.c.thinkingLevelCeiling === "medium", `${s.c.thinkingLevel}/${s.c.thinkingLevelCeiling}`);
	s.c.setThinkingLevelCeiling("low");
	check("[10] spawn 상한 아래로는 좁힐 수 있다", s.c.thinkingLevel === "low" && s.c.thinkingLevelCeiling === "low", `${s.c.thinkingLevel}/${s.c.thinkingLevelCeiling}`);
	s.c.setThinkingLevelCeiling(undefined);
	check("[11] 좁힌 상한을 지우면 spawn 상한까지만 돌아간다", s.c.thinkingLevel === "medium", String(s.c.thinkingLevel));

	// 직접 고른 level은 상한으로 잘리기만 한다.
	const f = controls({ thinkingLevel: "high" });
	f.c.setThinkingLevelCeiling("low");
	check("[12] 직접 고른 high는 상한 low로 잘리고 auto가 되지 않는다", f.c.thinkingLevel === "low" && f.c.configuredThinkingLevel() === "low", `${f.c.thinkingLevel}/${f.c.configuredThinkingLevel()}`);
}

// Windows는 열린 sqlite 핸들이 남아 있으면 임시 폴더 삭제가 EBUSY로 실패한다. 검증 결과와 무관한 정리다.
try {
	rmSync(workdir, { recursive: true, force: true });
} catch {}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
