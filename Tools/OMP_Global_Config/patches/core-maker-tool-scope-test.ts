// Run: OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-maker-tool-scope-test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET required (scratch core only)");
const root = mkdtempSync(join(tmpdir(), "maker-tools-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.HOME = root;
const core = resolve(target, "src");
const { setAgentDir } = await import(`${core}/../../pi-utils/src/dirs.ts`);
setAgentDir(root);
const { createAgentSession } = await import(`${core}/sdk.ts`);
const { Settings } = await import(`${core}/config/settings.ts`);
const { getBundledModel } = await import(`${core}/../../pi-catalog/src/models.ts`);
const blocked = ["git_finalize", "git_integrate", "maker_route", "ci_chain", "routing_verdict", "deploy_verify"];
try {
  for (const taskDepth of [0, 1, 2]) {
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, taskDepth, bindProcessState: false,
      model: getBundledModel("openai", "gpt-4o-mini"), getApiKey: () => "fixture",
      settings: Settings.isolated({}), enableMCP: false, enableLsp: false,
      skipPythonPreflight: true, disableExtensionDiscovery: true,
      skills: [], rules: [], contextFiles: [], toolNames: ["read"],
      customTools: [...blocked, "ordinary_custom"].map(name => ({
        name, label: name, description: name, parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
      })),
    });
    try {
      const names = session.getEnabledToolNames();
      assert.ok(names.includes("ordinary_custom"), "ordinary custom tool stays exposed");
      for (const name of blocked) assert.equal(names.includes(name), taskDepth === 0, `${name} at depth ${taskDepth}`);
      console.log(JSON.stringify({ taskDepth, mainOnlyExposed: names.filter((name: string) => blocked.includes(name)), ordinary: true }));
    } finally { await session.dispose(); }
  }
} finally { rmSync(root, { recursive: true, force: true }); }
