// Full computer docs load on demand for every session, with read-disabled fallback.
// Run: OMP_CORE_PATCH_TARGET=<core> bun run patches/core-computer-doc-scope-test.ts
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSettingsTestScope } from "./core-test-settings";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required");
const core = resolve(target, "src");
const { createComputerPrelude } = await import(`${core}/tools/computer.ts`);
// OMP_CORE_PATCH_TARGET selects the installed or isolated core at runtime.
const { EvalTool, getEvalToolDescription } = await import(`${core}/tools/eval.ts`);
const urlScheme = existsSync(resolve(core, "internal-urls/help-protocol.ts")) ? "help" : "xd";
const protocol = await import(`${core}/internal-urls/${urlScheme}-protocol.ts`);
const Handler = urlScheme === "help" ? protocol.HelpProtocolHandler : protocol.XdProtocolHandler;
const computerGuide = `${urlScheme}://eval/computer`;

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
	assert.ok(!description.includes(doc), `depth ${taskDepth}: initial eval schema must not inline the full guide`);
	assert.ok(description.includes(computerGuide), `depth ${taskDepth}: eval must advertise the complete computer guide`);
	assert.ok(getEvalToolDescription({ preludes: [prelude], inlineTopics: true }).includes(doc), "read-disabled sessions retain inline fallback");
	Object.assign(session, { getEvalPreludes: () => [prelude] });
	const evalTool = new EvalTool(session);
	Object.assign(session, { getToolByName: (name: string) => name === "eval" ? evalTool : undefined });
	const resource = await new Handler().resolve({ href: computerGuide }, { session });
	assert.equal(resource.content, doc, `depth ${taskDepth}: named topic serves the full unchanged guide`);
}
console.log("PASS: on-demand docs for Main and Maker, read-disabled fallback, and unchanged full topic transport");
