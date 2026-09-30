// Main Fast(OpenAI `priority`)의 SubAgent 상속을 OpenAI child 로만 좁힌 패치 검증.
// 실행: OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-oai-fast-inheritance-test.ts
// 실제 runSubprocess 로 자식 세션을 만들고, preload 한 확장이 `before_provider_request` 에서 wire payload 를
// 기록한 뒤 요청을 붙잡는다. 하네스가 기록을 보면 abort 하므로 요청은 전송되지 않는다(과금·네트워크 없음).
// Codex 미지원 모델은 같은 child settings 로 실제 Codex request body builder 를 부른다.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// SDK DB 핸들이 열린 자식에서 지우지 않고, 종료를 기다린 부모가 이 실행의 fixture만 지운다.
if (!process.env.OMP_FAST_FIXTURE_ROOT) {
	const root = mkdtempSync(join(tmpdir(), "omp-oai-fast-"));
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
				OMP_FAST_FIXTURE_ROOT: root,
			},
			stdout: "inherit",
			stderr: "inherit",
		});
		exitCode = child.exitCode ?? 1;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	process.exit(exitCode);
}

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live core");
const CORE = resolve(target, "src").replace(/\\/g, "/");
if (!existsSync(join(CORE, "task/executor.ts"))) throw new Error(`core 사본을 찾지 못했다: ${CORE}`);
const PACKAGES = resolve(dirname(CORE), "..").replace(/\\/g, "/");
const fixtureRoot = process.env.OMP_FAST_FIXTURE_ROOT!;

// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET so the test never imports the live installation.
const { setAgentDir } = await import(`${PACKAGES}/pi-utils/src/dirs.ts`);
setAgentDir(join(fixtureRoot, "home", ".omp", "agent"));
const { runSubprocess, createSubagentSettings } = await import(`${CORE}/task/executor.ts`);
const { Settings } = await import(`${CORE}/config/settings.ts`);
const { cfgTierOpenai, cfgTierAnthropic, cfgTierGoogle } = await import(`${CORE}/session/settings.ts`);
const { buildServiceTierByFamily } = await import(`${CORE}/config/service-tier.ts`);
const { resolveModelServiceTier } = await import(`${PACKAGES}/pi-ai/src/types.ts`);
const { buildTransformedCodexRequestBody } = await import(`${PACKAGES}/pi-ai/src/providers/openai-codex-responses.ts`);
const { getBundledModel } = await import(`${PACKAGES}/pi-catalog/src/models.ts`);
// 임시 agentDir 의 모델 preflight 만 통과시키는 비밀 아닌 placeholder. 요청은 전송 전에 abort 한다.
process.env.OPENAI_API_KEY = "<probe>";
process.env.ANTHROPIC_API_KEY = "<probe>";

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

type Tiers = Record<string, string>;
type Payload = Record<string, unknown>;

/** Spawn a real subagent and return the first provider payload it would send. */
async function childPayload(
	name: string,
	model: string,
	parentServiceTier: Tiers | null,
	opts: { settings?: Record<string, unknown>; serviceTierOverride?: string } = {},
): Promise<Payload | undefined> {
	const root = mkdtempSync(join(fixtureRoot, `${name}-`));
	const work = join(root, "work");
	mkdirSync(work);
	const out = join(root, "payload.json");
	const extension = join(root, "probe-extension.ts");
	writeFileSync(
		extension,
		`import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.on("before_provider_request", async event => {
		writeFileSync(${JSON.stringify(out)}, JSON.stringify(event.payload));
		// Hold the request; the harness aborts once the payload is recorded, so nothing is sent.
		await Promise.withResolvers().promise;
	});
}
`,
	);
	const recorded = (): Payload | undefined => (existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined);
	const controller = new AbortController();
	const poll = setInterval(() => {
		if (recorded()) controller.abort();
	}, 20);
	const settings = Settings.isolated({ "tier.subagent": "inherit", ...opts.settings });
	await runSubprocess({
		cwd: work,
		agent: { name: "maker", description: "fast probe", systemPrompt: "fast probe", tools: ["read"], model, source: "project" },
		task: "fast probe",
		index: 0,
		id: `FastProbe-${name}`,
		settings,
		parentServiceTier,
		...(opts.serviceTierOverride ? { serviceTierOverride: opts.serviceTierOverride } : {}),
		getApiKey: () => "example",
		preloadedExtensionPaths: [extension],
		enableMCP: false,
		enableLsp: false,
		signal: controller.signal,
	}).catch(() => undefined);
	clearInterval(poll);
	controller.abort();
	return recorded();
}

const OAI = "openai/gpt-4o-mini";
const ANTHROPIC = "anthropic/claude-sonnet-5-5";

console.log("[1] Main OpenAI Fast ON → 새 OpenAI child 는 service_tier=priority");
{
	const p = await childPayload("oai-on", OAI, { openai: "priority" });
	check("payload 기록", p !== undefined);
	check("service_tier=priority", p?.service_tier === "priority", JSON.stringify(p?.service_tier));
}

console.log("[2] Main OpenAI Fast ON → Anthropic child 는 fast 아님");
{
	const p = await childPayload("oai-on-anthropic", ANTHROPIC, { openai: "priority" });
	check("payload 기록", p !== undefined);
	check("speed 없음", p !== undefined && p.speed === undefined, JSON.stringify(p?.speed));
}

console.log("[3] Main Anthropic Fast ON → child 로 상속하지 않는다");
{
	const a = await childPayload("anthropic-on", ANTHROPIC, { anthropic: "priority" });
	check("Anthropic child payload 기록", a !== undefined);
	check("Anthropic child speed 없음", a !== undefined && a.speed === undefined, JSON.stringify(a?.speed));
	const o = await childPayload("anthropic-on-oai", OAI, { anthropic: "priority" });
	check("OpenAI child service_tier 없음", o !== undefined && o.service_tier === undefined, JSON.stringify(o?.service_tier));
}

console.log("[4] Main Fast OFF → 자동 priority 없음");
{
	const p = await childPayload("off", OAI, null);
	check("payload 기록", p !== undefined);
	check("service_tier 없음", p !== undefined && p.service_tier === undefined, JSON.stringify(p?.service_tier));
}

console.log("[5] Main Ultrafast·flex 는 자동 상속하지 않는다");
{
	const u = await childPayload("ultrafast", OAI, { openai: "ultrafast" });
	check("ultrafast 미상속", u !== undefined && u.service_tier === undefined, JSON.stringify(u?.service_tier));
	const f = await childPayload("flex", OAI, { openai: "flex" });
	check("flex 미상속", f !== undefined && f.service_tier === undefined, JSON.stringify(f?.service_tier));
}

console.log("[6] 명시 설정은 그대로 적용된다");
{
	const concrete = await childPayload("concrete", ANTHROPIC, null, { settings: { "tier.subagent": "priority" } });
	check("명시 tier.subagent=priority 는 Anthropic child 에 speed=fast", concrete?.speed === "fast", JSON.stringify(concrete?.speed));
	const none = await childPayload("override-none", OAI, { openai: "priority" }, { serviceTierOverride: "none" });
	check("agent override none 은 priority 를 끈다", none !== undefined && none.service_tier === undefined, JSON.stringify(none?.service_tier));
	const overridePriority = await childPayload("override-priority", ANTHROPIC, null, { serviceTierOverride: "priority" });
	check("agent override priority 는 Anthropic child 에 speed=fast", overridePriority?.speed === "fast", JSON.stringify(overridePriority?.speed));
}

console.log("[7] priority 를 광고하지 않는 Codex 모델은 상속돼도 wire 에 보내지 않는다");
{
	const child = createSubagentSettings(Settings.isolated({ "tier.subagent": "inherit" }), undefined, { openai: "priority" });
	const tiers = buildServiceTierByFamily(cfgTierOpenai.get(child), cfgTierAnthropic.get(child), cfgTierGoogle.get(child));
	const base = getBundledModel("openai-codex", "gpt-5.5");
	const context = { messages: [{ role: "user", content: "probe", timestamp: Date.now() }] };
	const unsupported = { ...base, serviceTiers: ["flex"] };
	const supported = { ...base, serviceTiers: ["priority", "flex"] };
	const bodyUnsupported = await buildTransformedCodexRequestBody(unsupported, context, { serviceTier: resolveModelServiceTier(tiers, unsupported) });
	const bodySupported = await buildTransformedCodexRequestBody(supported, context, { serviceTier: resolveModelServiceTier(tiers, supported) });
	check("child 상속 tier 는 openai=priority", JSON.stringify(tiers) === JSON.stringify({ openai: "priority" }), JSON.stringify(tiers));
	check("미지원 Codex body 에 service_tier 없음", bodyUnsupported.service_tier === undefined, JSON.stringify(bodyUnsupported.service_tier));
	check("지원 Codex body 는 service_tier=priority", bodySupported.service_tier === "priority", JSON.stringify(bodySupported.service_tier));
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
