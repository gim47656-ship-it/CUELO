// Computer docs stay inline for Main and load through xd://eval/computer for Makers.
// Run: OMP_CORE_PATCH_TARGET=<core> bun run patches/core-computer-doc-scope-test.ts
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { createSettingsTestScope } from "./core-test-settings";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required");
const core = resolve(target, "src");
const { createComputerPrelude } = await import(`${core}/tools/computer.ts`);
// OMP_CORE_PATCH_TARGET selects the installed or isolated core at runtime.
const { EvalTool, getEvalToolDescription } = await import(`${core}/tools/eval.ts`);
const { XdProtocolHandler } = await import(`${core}/internal-urls/xd-protocol.ts`);

const cases = [];
for (const taskDepth of [0, 1, 2, undefined]) {
	const session = {
		taskDepth,
		cwd: process.cwd(),
		settings: createSettingsTestScope(key => key === "computer.enabled" ? true : undefined),
		getEvalKernelOwnerId: () => `computer-doc-scope-${taskDepth}`,
	};
	// No native supervisor or desktop is started by this documentation-only fixture.
	const prelude = createComputerPrelude(session, () => ({ close: async () => {} }));
	const description = getEvalToolDescription({ preludes: [prelude] });
	cases.push({ taskDepth, session, prelude, description });
}
console.log(JSON.stringify({ measurements: cases.map(({ taskDepth, prelude, description }) => ({
	taskDepth: taskDepth ?? "undefined", documentationChars: prelude.documentation.trim().length, descriptionChars: description.length,
})) }));

for (const { taskDepth, session, prelude, description } of cases) {
	const doc = prelude.documentation.trim();
	if (taskDepth === undefined || taskDepth === 0) {
		assert.ok(description.includes(doc), `depth ${taskDepth}: Main must retain full inline computer docs`);
	} else {
		assert.ok(!description.includes(doc), `depth ${taskDepth}: Maker must not inline full computer docs`);
		assert.ok(description.includes("xd://eval/computer"), `depth ${taskDepth}: Maker must advertise computer topic`);
	}
	assert.ok(getEvalToolDescription({ preludes: [prelude], inlineTopics: true }).includes(doc), "read-disabled sessions retain inline fallback");
	Object.assign(session, { getEvalPreludes: () => [prelude] });
	const evalTool = new EvalTool(session);
	Object.assign(session, { getToolByName: (name: string) => name === "eval" ? evalTool : undefined });
	const resource = await new XdProtocolHandler().resolve({ href: "xd://eval/computer" }, { session });
	assert.equal(resource.content, doc, `depth ${taskDepth}: xd topic serves the full unchanged guide`);
}
console.log("PASS: Main/undefined inline docs, Maker topic links, read-disabled fallback, and xd topic transport");
