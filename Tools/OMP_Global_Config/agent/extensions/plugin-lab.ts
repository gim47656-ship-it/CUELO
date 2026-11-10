import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * plugin_lab: the agent side of CUELO's Plugin Lab (plugins in this user's profile, installed from
 * `Tools/OMP_Global_Config/agent/cuelo-plugins/` in the repository).
 * list / enable / disable go through the CUELO server's in-process host (`globalThis.__cueloPluginLab`,
 * lib/plugin-lab.ts), so the manifest rules live in one place; outside CUELO those actions report that.
 * inspect reads the current session's tools. check validates a plugin and imports its extension entry in a
 * child Bun process with a timeout, so a broken or hanging plugin cannot take the session down; it accepts the
 * repository source copy, so a plugin can be checked before it is installed.
 */

type LabPlugin = {
  id: string; name: string; description: string; createdAt: string; enabled: boolean;
  hasExtension: boolean; tools: string[]; hasPanel: boolean; problem?: string;
  lastEnhancement?: { at: string; summary: string };
};
type LabUsage = {
  id: string; sessions: number; toolCalls: number; toolFailures: number; panelOpens: number; activeDays: number;
  lastUsedAt: string | null; recentSessionFailures: number;
};
export type PluginLabLocation = { plugin: LabPlugin; dir: string; source: "repository" | "installed"; extensionPath?: string };
export type PluginLabHost = {
  version: 1;
  root(): string;
  list(): Promise<LabPlugin[]>;
  usage(sinceMs: number): Promise<LabUsage[]>;
  setEnabled(id: string, enabled: boolean): Promise<LabPlugin | undefined>;
  locate(id: string, from: string): Promise<PluginLabLocation | undefined>;
};
export type ToolSummary = { name: string; description: string; parameters?: unknown; source: string; active: boolean };

export interface PluginLabInput {
  action: "list" | "inspect" | "check" | "enable" | "disable";
  id?: string;
  tool?: string;
}

export interface PluginLabDeps {
  host: PluginLabHost | undefined;
  tools: () => ToolSummary[];
  /** Bun binary for the check probe. */
  bun: string;
  /** The session cwd: `check` looks for the repository source copy of a plugin up from here. */
  cwd: string;
  timeoutMs?: number;
  now?: () => number;
}

const USAGE_WINDOW_MS = 14 * 86_400_000;
const CHECK_TIMEOUT_MS = 15_000;
const RESULT_LIMIT_BYTES = 64 * 1024;
const OUTPUT_LIMIT = 16_000;
const SCHEMA_LIMIT = 4_000;
const NO_HOST = "Plugin Lab needs the CUELO server: this session is not running inside CUELO, so list/enable/disable/check are unavailable here.";

/**
 * Runs in the child process. A permissive stand-in for ExtensionAPI records `registerTool` names;
 * every other member is a callable, chainable no-op so `pi.zod.object(...)`, `pi.on(...)` and friends work.
 */
const PROBE_SOURCE = String.raw`
const entry = process.env.PLUGIN_LAB_ENTRY;
const names = [];
const chain = () => new Proxy(function () {}, {
  get: (_target, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : chain()),
  apply: () => chain(),
  construct: () => chain(),
});
const api = new Proxy({}, {
  get(_target, key) {
    if (key === "registerTool") return (tool) => { names.push(String(tool && tool.name)); };
    if (key === "then") return undefined;
    return chain();
  },
});
// The result goes to a file, not stdout: the plugin's own output is discarded so it cannot fill the parent's memory.
const report = (value) => require("node:fs").writeFileSync(process.env.PLUGIN_LAB_RESULT, JSON.stringify(value).slice(0, 60000));
(async () => {
  try {
    const mod = await import(require("node:url").pathToFileURL(entry).href);
    const factory = typeof mod.default === "function" ? mod.default : typeof mod === "function" ? mod : null;
    if (!factory) return report({ error: "the extension entry has no default export function" });
    await factory(api);
    report({ tools: names });
  } catch (error) {
    report({ error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
  }
})().finally(() => process.exit(0));
`;

export async function probeExtension(entry: string, cwd: string, bun: string, timeoutMs: number): Promise<{ tools: string[] } | { error: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "plugin-lab-check-"));
  const resultFile = join(scratch, "result.json");
  try {
    const child = Bun.spawn([bun, "-e", PROBE_SOURCE], {
      cwd,
      env: { ...process.env, PLUGIN_LAB_ENTRY: entry, PLUGIN_LAB_RESULT: resultFile },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const exitCode = await child.exited.finally(() => clearTimeout(timer));
    if (timedOut) return { error: `loading the extension did not finish within ${Math.round(timeoutMs / 1000)}s` };
    // Open non-blocking and check the opened file itself: the plugin could leave a FIFO or a symlink there
    // (or swap one in later from a leftover process), and reading either could block or run away.
    // O_NONBLOCK and O_NOFOLLOW are POSIX-only; Windows has no FIFOs to guard against here.
    const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(resultFile, flags).catch(() => null);
    if (!handle) return { error: `the probe exited (code ${exitCode}) without a result` };
    try {
      if (!(await handle.stat()).isFile()) return { error: "the probe result is not a regular file" };
      // Read at most one byte past the limit: a leftover process could still be growing the file.
      const buffer = Buffer.alloc(RESULT_LIMIT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > RESULT_LIMIT_BYTES) return { error: "the probe result is unexpectedly large" };
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as { tools: string[] } | { error: string };
    } finally {
      await handle.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function describePlugin(plugin: LabPlugin, usage: LabUsage | undefined): string {
  const parts = [`${plugin.id} [${plugin.enabled ? "enabled" : "disabled"}] ${plugin.name}`];
  if (plugin.tools.length) parts.push(`tools: ${plugin.tools.join(", ")}`);
  if (plugin.hasPanel) parts.push("panel");
  if (usage) {
    parts.push(`14d: ${usage.toolCalls} calls / ${usage.toolFailures} failures in ${usage.sessions} sessions, ${usage.panelOpens} panel opens, ${usage.activeDays} active days`);
  }
  if (plugin.problem) parts.push(`PROBLEM: ${plugin.problem}`);
  return parts.join(" — ");
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

export async function runPluginLab(input: PluginLabInput, deps: PluginLabDeps): Promise<{ text: string; isError: boolean }> {
  try {
    switch (input.action) {
      case "inspect": {
        const tools = deps.tools();
        if (input.tool) {
          const tool = tools.find((candidate) => candidate.name === input.tool);
          if (!tool) return { text: `No tool named "${input.tool}" in this session.`, isError: true };
          return {
            text: clip([
              `${tool.name} (${tool.active ? "active" : "inactive"}, source ${tool.source})`,
              tool.description,
              `parameters: ${clip(JSON.stringify(tool.parameters ?? null) ?? "(not serializable)", SCHEMA_LIMIT)}`,
            ].join("\n"), OUTPUT_LIMIT),
            isError: false,
          };
        }
        const lines = tools.map((tool) => `${tool.name}${tool.active ? "" : " (inactive)"} — ${tool.source} — ${tool.description.split("\n")[0]!.slice(0, 120)}`);
        return { text: clip([`${tools.length} tools in this session (pick names that do not clash):`, ...lines].join("\n"), OUTPUT_LIMIT), isError: false };
      }
      case "list": {
        if (!deps.host) return { text: NO_HOST, isError: true };
        const [plugins, usage] = await Promise.all([deps.host.list(), deps.host.usage((deps.now?.() ?? Date.now()) - USAGE_WINDOW_MS)]);
        const usageById = new Map(usage.map((entry) => [entry.id, entry]));
        const lines = plugins.length === 0
          ? ["No plugins installed."]
          : plugins.map((plugin) => describePlugin(plugin, usageById.get(plugin.id)));
        return { text: [`root: ${deps.host.root()}`, ...lines].join("\n"), isError: false };
      }
      case "enable":
      case "disable": {
        if (!deps.host) return { text: NO_HOST, isError: true };
        if (!input.id) return { text: "id is required.", isError: true };
        const plugin = await deps.host.setEnabled(input.id, input.action === "enable");
        if (!plugin) return { text: `No plugin "${input.id}".`, isError: true };
        return {
          text: `${describePlugin(plugin, undefined)}\nTakes effect in a new session or after /reload in an idle session.`,
          isError: false,
        };
      }
      case "check": {
        if (!deps.host) return { text: NO_HOST, isError: true };
        if (!input.id) return { text: "id is required.", isError: true };
        const located = await deps.host.locate(input.id, deps.cwd);
        if (!located) {
          return {
            text: `No plugin folder "${input.id}": neither a repository copy under Tools/OMP_Global_Config/agent/cuelo-plugins/ nor an installed one in ${deps.host.root()}.`,
            isError: true,
          };
        }
        const { plugin, dir, source, extensionPath } = located;
        const problems: string[] = [];
        const notes: string[] = [
          `${plugin.id} [${source === "repository" ? "repository source, not installed yet" : "installed"}] at ${dir}`,
        ];
        if (plugin.problem) problems.push(plugin.problem);
        if (extensionPath) {
          const probe = await probeExtension(extensionPath, dir, deps.bun, deps.timeoutMs ?? CHECK_TIMEOUT_MS);
          if ("error" in probe) {
            const hint = /Cannot find (package|module)/i.test(probe.error)
              ? " (an installed plugin cannot resolve packages at runtime; keep `import type` only and use the `pi` API)"
              : "";
            problems.push(`extension failed to load: ${probe.error}${hint}`);
          } else {
            notes.push(`registers: ${probe.tools.length ? probe.tools.join(", ") : "(no tools)"}`);
            const missing = plugin.tools.filter((tool) => !probe.tools.includes(tool));
            const undeclared = probe.tools.filter((tool) => !plugin.tools.includes(tool));
            if (missing.length) problems.push(`declared in plugin.json but not registered: ${missing.join(", ")}`);
            if (undeclared.length) problems.push(`registered but not declared in plugin.json "tools" (usage is counted by that list): ${undeclared.join(", ")}`);
            // This plugin's own tools, already loaded in the session, are not a clash. The session loads the
            // installed copy, so a check of the repository copy has to count that folder as its own too.
            const installedDir = join(deps.host.root(), plugin.id);
            const ownDirs = [dir, installedDir];
            for (const own of [dir, installedDir]) ownDirs.push(await realpath(own).catch(() => own));
            const inside = (source: string, root: string) => {
              const rel = relative(root, source);
              return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith(`..${sep}`);
            };
            const clashes = deps.tools().filter((tool) =>
              probe.tools.includes(tool.name) && !ownDirs.some((own) => inside(tool.source, own)));
            if (clashes.length) problems.push(`name already used in this session: ${clashes.map((tool) => `${tool.name} (${tool.source})`).join(", ")}`);
          }
        } else if (!plugin.problem) {
          notes.push("no extension entry (panel-only plugin)");
        }
        notes.push(problems.length
          ? `PROBLEMS:\n- ${problems.join("\n- ")}`
          : source === "repository"
            ? "OK. Next: add a focused test, then ship it through the normal review, version, CI and deploy path. No new session is needed until that deploy has restarted the server."
            : "OK. Next: start a new session or /reload, call the tool once, then tell the user.");
        return { text: clip(notes.join("\n"), OUTPUT_LIMIT), isError: problems.length > 0 };
      }
      default:
        return { text: "action must be one of list, inspect, check, enable, disable.", isError: true };
    }
  } catch (error) {
    return { text: `plugin_lab failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

export default function pluginLab(pi: ExtensionAPI): void {
  const z = pi.zod;
  // Extension tools carry omptype (`pi.zod`) schemas with their own `toJsonSchema()`; builtins carry plain JSON schema.
  const jsonSchemaOf = (schema: unknown): unknown => {
    try {
      // omptype schemas are callable, so they are functions, not plain objects.
      if (schema && (typeof schema === "object" || typeof schema === "function") && "toJsonSchema" in schema
        && typeof schema.toJsonSchema === "function") {
        return schema.toJsonSchema();
      }
      const json = JSON.stringify(schema);
      return json === undefined ? "(schema not serializable)" : JSON.parse(json);
    } catch {
      return "(schema not serializable)";
    }
  };
  pi.registerTool({
    name: "plugin_lab", label: "Plugin Lab", loadMode: "essential", approval: "read",
    description: "CUELO Plugin Lab (plugins for this user's own profile; read skill://plugin-lab before writing one). action list: installed plugins with problems and 14-day usage. inspect: this session's tool names and sources (tool=<name> adds its description and parameter schema) so a new tool name does not clash. check id=<plugin>: validate plugin.json and paths, import the extension entry in a child Bun process with a timeout and compare the tools it registers with the manifest; it checks the repository source folder Tools/OMP_Global_Config/agent/cuelo-plugins/<id>/ when there is one and says which copy it read, so a plugin can be validated before it is installed. enable/disable id=<plugin>: turn an installed plugin on or off for new sessions and /reload. Nothing is written, deleted or deployed here: the plugin itself ships through the normal review, version, CI and deploy path.",
    parameters: z.object({
      action: z.enum(["list", "inspect", "check", "enable", "disable"]),
      id: z.string().optional(),
      tool: z.string().optional(),
    }) as never,
    async execute(_id, params, _signal, _onUpdate, _ctx: ExtensionContext) {
      const result = await runPluginLab(params as PluginLabInput, {
        host: globalThis.__cueloPluginLab as PluginLabHost | undefined,
        bun: Bun.which("bun") ?? process.execPath,
        cwd: _ctx.cwd,
        tools: () => {
          const active = new Set(pi.getActiveTools());
          return pi.getAllTools().map((tool) => ({
            name: tool.name, description: tool.description ?? "", parameters: jsonSchemaOf(tool.parameters), source: tool.sourceInfo?.path ?? "unknown",
            active: active.has(tool.name),
          }));
        },
      });
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true as const } : {}) };
    },
  });
}

declare global {
  var __cueloPluginLab: unknown;
}
