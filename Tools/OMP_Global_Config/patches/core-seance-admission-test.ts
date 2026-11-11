import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsTestScope } from "./core-test-settings";

const target = process.env.OMP_CORE_PATCH_TARGET;
assert.ok(target, "OMP_CORE_PATCH_TARGET must identify the isolated core");
const core = `${target}/src`;
// The module path is selected at runtime so tests cannot load the installed core by mistake.
const { validateSeanceParams } = await import(`${core}/task/seance.ts`);
const consult = { agent: "seance", sourceSession: "source.jsonl", task: "Inspect the historical failure", solutionSpace: "Read-only evidence extraction" };
let failed = 0;
function check(label: string, run: () => void) {
	try { run(); console.log(`PASS ${label}`); }
	catch (error) { failed++; console.error(`FAIL ${label}`, String(error)); }
}
for (const batchEnabled of [false, true]) {
	const params = batchEnabled ? { context: "Historical consultation fixture", tasks: [consult] } : consult;
	check(`shadow consultation rejected (${batchEnabled ? "batch" : "flat"})`, () => {
		assert.match(validateSeanceParams({ params, batchEnabled, defaultAgent: "maker", seanceAdvertised: false }) ?? "", /bundled/);
	});
	check(`bundled consultation admitted (${batchEnabled ? "batch" : "flat"})`, () => {
		assert.equal(validateSeanceParams({ params, batchEnabled, defaultAgent: "maker", seanceAdvertised: true }), undefined);
	});
}
check("custom agent without historical source keeps ordinary semantics", () => {
	assert.equal(validateSeanceParams({ params: { agent: "seance", task: "ordinary" }, batchEnabled: false, defaultAgent: "maker", seanceAdvertised: false }), undefined);
});

// Exercise the real task planner and dispatch. Stop at preflight, before any provider call.
const actual = await import(`${core}/task/structured-subagent.ts`);
const selectedRoot = mkdtempSync(join(tmpdir(), "cuelo-selected-seance-"));
try {
	mkdirSync(join(selectedRoot, ".omp", "agents"), { recursive: true });
	writeFileSync(join(selectedRoot, ".omp", "agents", "seance.md"), "---\nname: seance\ndescription: Synthetic ordinary agent\ntools: read, write\n---\nFixture only.\n");
	const settings = Object.assign(createSettingsTestScope(() => undefined), { reloadFromDisk: async () => {} });
	const session = { cwd: selectedRoot, settings, getSessionSpawns: () => "*", getActiveModelString: () => "fixture/model", taskDepth: 0 };
	await assert.rejects(actual.resolveEffectiveSubagentPolicy({
		session, invocationKind: "task", agent: "seance", sourceSession: "source.jsonl",
		assignment: "Inspect source", solutionSpace: "Read-only evidence",
	}), /bundled read-only/);
	console.log("PASS actual resolved shadow rejected before ordinary execution");
} finally {
	rmSync(selectedRoot, { recursive: true, force: true });
}
let preflightCalls = 0;
const stopped = "SEANCE-TEST-PREFLIGHT";
mock.module(`${core}/task/structured-subagent.ts`, () => ({
	...actual,
	resolveEffectiveSubagentPolicy: async () => { preflightCalls++; throw new Error(stopped); },
}));
const { TaskTool } = await import(`${core}/task/index.ts`);
const root = mkdtempSync(join(tmpdir(), "cuelo-seance-admission-"));
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(p => p.text ?? "").join("\n");
try {
	for (const shadow of [false, true]) {
		const cwd = join(root, shadow ? "shadow" : "bundled");
		mkdirSync(join(cwd, ".omp", "agents"), { recursive: true });
		if (shadow) writeFileSync(join(cwd, ".omp", "agents", "seance.md"), "---\nname: seance\ndescription: Synthetic ordinary writable agent\ntools: read, write\n---\nFixture only.\n");
		for (const batchEnabled of [false, true]) {
			const settings = createSettingsTestScope(key => ({ "task.batch": batchEnabled, "task.speculativeLaunch": true, "async.enabled": false })[key]);
			const tool = await TaskTool.create({ cwd, settings, getSessionSpawns: () => "*", getPlanModeState: () => undefined, taskDepth: 0, suppressSpawnAdvisory: true } as never);
			const params = batchEnabled ? { context: "Historical consultation fixture", tasks: [consult] } : consult;
			const before = preflightCalls;
			const output = text(await tool.execute(`consult-${shadow}-${batchEnabled}`, params));
			check(`real dispatch ${shadow ? "shadow blocked" : "bundled reaches preflight"} (${batchEnabled ? "batch" : "flat"})`, () => {
				if (shadow) { assert.match(output, /bundled/); assert.equal(preflightCalls, before); }
				else { assert.match(output, new RegExp(stopped)); assert.equal(preflightCalls, before + 1); }
			});
		}
	}
} finally {
	mock.restore();
	rmSync(root, { recursive: true, force: true });
}
assert.equal(failed, 0, `${failed} seance admission checks failed`);
