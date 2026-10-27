// On-demand installed-runtime regression. Requires OMP_EXE and the installed windows_control tool.
// OMP_EXE=/path/to/omp bun --no-install agent/extensions/tests/computer-task-bootstrap-check.ts
// No model inference or desktop input: the final trusted hook exits before the first request.
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childArgs, CHILD_ENV } from "../lib/computer-task";

const exe = process.env.OMP_EXE;
assert.ok(exe, "OMP_EXE must identify the installed runtime under test");
const cwd = await mkdtemp(join(tmpdir(), "computer-task-bootstrap-"));
const probePath = join(cwd, "inspect.ts");
const expectedTools = ["bash", "eval", "read", "windows_control"];
const baseArgs = childArgs({ model: "openai-codex/gpt-6.1-terra", thinking: "high" }, "Do not interact with any window. The inspection hook exits before inference.");
const scopeIndex = baseArgs.indexOf("--trusted-extension") + 1;
const scopePath = baseArgs[scopeIndex];
async function run(scope: string, marker = true) {
  const args = [...baseArgs];
  args[scopeIndex] = scope;
  args.splice(args.length - 1, 0, "--trusted-extension", probePath);
  const env = { ...process.env };
  if (marker) env[CHILD_ENV] = "1";
  else delete env[CHILD_ENV];
  const child = Bun.spawn([exe!, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const line = stdout.split(/\r?\n/).find(item => item.startsWith("WORKER_STATE "));
    const state: unknown = line ? JSON.parse(line.slice("WORKER_STATE ".length)) : undefined;
    return { exit, stderr, state };
  } finally { clearTimeout(timer); }
}
try {
  await writeFile(probePath, `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
export default function inspect(pi: ExtensionAPI) {
  pi.registerTool({name:"boundary_fixture",label:"Boundary fixture",description:"Harmless test tool",loadMode:"essential",
    parameters:pi.zod.object({}), async execute(){return {content:[{type:"text",text:"fixture"}]};}});
  pi.on("before_agent_start", async (_event, ctx) => {
    const session = AgentRegistry.global().list().find(ref => ref.session?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId())?.session;
    if (!session) { console.error("Missing runtime session"); process.exit(2); }
    console.log("WORKER_STATE " + JSON.stringify({active:pi.getActiveTools().sort(),enabled:session.getEvalBridgeToolNames().sort(),
      mounted:session.getMountedXdevToolNames(),blockedCallable:!!session.getToolForEvalBridge("boundary_fixture")}));
    process.exit(0);
  });
}
`);
  const normal = await run(scopePath);
  assert.equal(normal.exit, 0, normal.stderr);
  assert.deepEqual(normal.state, { active: expectedTools, enabled: expectedTools, mounted: [], blockedCallable: false });
  console.log("PASS actual active tools, eval bridge and xd mounts exclude unrelated tool");

  const outside = await run(scopePath, false);
  assert.equal(outside.exit, 0, outside.stderr);
  assert.ok(outside.state && typeof outside.state === "object" && "active" in outside.state && Array.isArray(outside.state.active));
  assert.equal(outside.state.active.includes("boundary_fixture"), true, "ordinary session was narrowed");
  console.log("PASS scope does not change an ordinary session");

  const missing = await run(join(cwd, "missing-scope.ts"));
  assert.notEqual(missing.exit, 0);
  assert.equal(missing.state, undefined, "missing scope reached the request");
  console.log("PASS missing trusted scope stops before inference");

  const failingPath = join(cwd, "failing-scope.ts");
  await writeFile(failingPath, `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import scope from ${JSON.stringify(scopePath)};
export default function fail(pi: ExtensionAPI) {
  scope(new Proxy(pi,{get(target,key,receiver){
    if(key==="setActiveTools")return async()=>{throw new Error("INJECTED_SCOPE_FAILURE")};
    return Reflect.get(target,key,receiver);
  }}));
}
`);
  const failed = await run(failingPath);
  assert.notEqual(failed.exit, 0);
  assert.equal(failed.state, undefined, "failed scope reached the request");
  assert.match(failed.stderr, /INJECTED_SCOPE_FAILURE/);
  console.log("PASS scope failure stops before inference");
} finally {
  await rm(cwd, { recursive: true, force: true });
}
