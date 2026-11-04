import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { runPluginLab, type PluginLabHost, type ToolSummary } from "../plugin-lab";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bun = Bun.which("bun") ?? process.execPath;

/** A host over one temp plugin folder; the manifest rules themselves are tested in lib/plugin-lab.test.mjs. */
function labWith(id: string, tools: string[], source: string) {
  const root = mkdtempSync(join(tmpdir(), "plugin-lab-ext-"));
  scratch.push(root);
  const dir = join(root, "plugin-lab", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), source);
  const plugin = {
    id, name: id, description: "", createdAt: "2026-11-04T00:00:00Z", origin: "trial" as const, enabled: true, promoted: false,
    hasExtension: true, tools, hasPanel: false,
  };
  const host: PluginLabHost = {
    version: 1,
    roots: () => ({ trial: join(root, "plugin-lab"), promoted: join(root, "cuelo-plugins") }),
    list: async () => [plugin],
    usage: async () => [],
    setEnabled: async (target, enabled) => (target === id ? { ...plugin, enabled } : undefined),
    locate: async (target) => (target === id ? { plugin, dir, extensionPath: join(dir, "index.ts") } : undefined),
  };
  return { host, dir };
}

const registers = (name: string) => `export default function (pi) {
  pi.registerTool({ name: "${name}", label: "x", description: "x", parameters: pi.zod.object({ text: pi.zod.string().optional() }),
    async execute() { return { content: [{ type: "text", text: "ok" }] }; } });
  pi.on("session_start", () => {});
}\n`;

const noTools = (): ToolSummary[] => [];

describe("plugin_lab check", () => {
  test("passes when the extension registers exactly the declared tools", async () => {
    const { host } = labWith("echo", ["lab_echo"], registers("lab_echo"));
    const result = await runPluginLab({ action: "check", id: "echo" }, { host, bun, tools: noTools });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("registers: lab_echo");
  });

  test("reports a declared tool the extension never registers", async () => {
    const { host } = labWith("echo", ["lab_echo", "lab_missing"], registers("lab_echo"));
    const result = await runPluginLab({ action: "check", id: "echo" }, { host, bun, tools: noTools });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not registered: lab_missing");
  });

  test("reports an extension that throws while loading", async () => {
    const { host } = labWith("boom", ["lab_boom"], "export default function () { throw new Error(\"boom on load\"); }\n");
    const result = await runPluginLab({ action: "check", id: "boom" }, { host, bun, tools: noTools });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("extension failed to load: boom on load");
  });

  test("stops an extension that never finishes loading", async () => {
    const { host } = labWith("hang", ["lab_hang"], "await new Promise(() => setInterval(() => {}, 1000));\nexport default function () {}\n");
    // A real child process is killed on a real deadline; fake timers cannot stand in for the OS process here.
    const started = Date.now();
    const result = await runPluginLab({ action: "check", id: "hang" }, { host, bun, tools: noTools, timeoutMs: 1500 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("did not finish within");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("reports a tool name another source already uses in this session", async () => {
    const { host } = labWith("echo", ["read"], registers("read"));
    const tools = () => [{ name: "read", description: "Read a file", source: "<builtin:read>", active: true }];
    const result = await runPluginLab({ action: "check", id: "echo" }, { host, bun, tools });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("name already used in this session: read (<builtin:read>)");
  });

  test("a sibling plugin whose folder name starts with this one's still counts as a clash", async () => {
    const { host, dir } = labWith("foo", ["shared"], registers("shared"));
    const tools = () => [{ name: "shared", description: "x", source: `${dir}-extra/index.ts`, active: true }];
    const result = await runPluginLab({ action: "check", id: "foo" }, { host, bun, tools });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("name already used in this session: shared");
  });

  test("this plugin's own already-loaded tools are not a clash", async () => {
    const { host, dir } = labWith("echo", ["lab_echo"], registers("lab_echo"));
    const tools = () => [{ name: "lab_echo", description: "x", source: join(dir, "index.ts"), active: true }];
    const result = await runPluginLab({ action: "check", id: "echo" }, { host, bun, tools });
    expect(result.isError).toBe(false);
  });

  test("a plugin that floods stdout and stderr still gets a bounded result", async () => {
    const flood = `const chunk = "x".repeat(1 << 20);\nfor (let i = 0; i < 32; i++) { process.stdout.write(chunk); process.stderr.write(chunk); }\n${registers("lab_noisy")}`;
    const { host } = labWith("noisy", ["lab_noisy"], flood);
    const result = await runPluginLab({ action: "check", id: "noisy" }, { host, bun, tools: noTools });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("registers: lab_noisy");
    expect(result.text.length).toBeLessThan(2_000);
  });

  test("a plugin that leaves a FIFO as the result cannot hang the check", async () => {
    const fifo = `import { execFileSync } from "node:child_process";\nexecFileSync("mkfifo", [process.env.PLUGIN_LAB_RESULT]);\nprocess.exit(0);\n`;
    const { host } = labWith("fifo", ["lab_fifo"], fifo);
    const result = await runPluginLab({ action: "check", id: "fifo" }, { host, bun, tools: noTools, timeoutMs: 5000 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not a regular file");
  }, 8000);

  test("an oversized result file is refused, not read whole", async () => {
    const big = `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.PLUGIN_LAB_RESULT, JSON.stringify({ tools: [] }) + " ".repeat(1 << 20));\nprocess.exit(0);\n`;
    const { host } = labWith("big", ["lab_big"], big);
    const result = await runPluginLab({ action: "check", id: "big" }, { host, bun, tools: noTools });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("unexpectedly large");
  });
});

describe("plugin_lab outside CUELO and inspect", () => {
  test("list and enable say the CUELO host is missing instead of guessing", async () => {
    for (const action of ["list", "enable", "check"] as const) {
      const result = await runPluginLab({ action, id: "echo" }, { host: undefined, bun, tools: noTools });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("needs the CUELO server");
    }
  });

  test("inspect lists tool names and shows one tool's schema", async () => {
    const tools = () => [
      { name: "read", description: "Read a file\nmore", parameters: { type: "object" }, source: "<builtin:read>", active: true },
      { name: "lab_echo", description: "Echo", source: "/x/index.ts", active: false },
    ];
    const all = await runPluginLab({ action: "inspect" }, { host: undefined, bun, tools });
    expect(all.text).toContain("read — <builtin:read> — Read a file");
    expect(all.text).toContain("lab_echo (inactive)");
    const one = await runPluginLab({ action: "inspect", tool: "read" }, { host: undefined, bun, tools });
    expect(one.text).toContain('parameters: {"type":"object"}');
  });

  test("the extension registers plugin_lab through omp's loader", async () => {
    const entry = fileURLToPath(new URL("../plugin-lab.ts", import.meta.url));
    const loaded = await loadExtensions([entry], process.cwd());
    expect(loaded.errors).toEqual([]);
    expect([...loaded.extensions[0]!.tools.keys()]).toEqual(["plugin_lab"]);
  });
});
