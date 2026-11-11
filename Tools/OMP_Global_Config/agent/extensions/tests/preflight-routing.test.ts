import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import preflightRouting from "../../cuelo-plugins/preflight-routing/index";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";

type Handler = (event: unknown, ctx: unknown) => unknown;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "preflight-routing-test-"));
  mkdirSync(join(root, "plugin-lab"));
  process.env.PI_CODING_AGENT_DIR = root;
  refreshDirsFromEnv();
});
afterAll(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  refreshDirsFromEnv();
  rmSync(root, { recursive: true, force: true });
});

// Only routing is loaded: resolving any model would mean a disabled dependency was ignored.
describe("preflight-routing with the check plugin unavailable", () => {
  for (const state of [JSON.stringify({ disabled: ["argon-preflight"] }), "not json", JSON.stringify({ disabled: null })]) {
    test(`dispatch stays usable with installed state ${state}`, async () => {
      writeFileSync(join(root, "plugin-lab", "state.json"), state);
      const handlers = new Map<string, Handler[]>();
      let resolutions = 0;
      const tools: string[] = [];
      await preflightRouting({
        on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
        registerTool: (tool: { name: string }) => tools.push(tool.name),
      } as never);
      const ctx = {
        agent: { kind: "main" },
        sessionManager: { getBranch: () => [] },
        models: { resolve: () => { resolutions += 1; throw new Error("check plugin is disabled"); } },
        ui: { setWidget: () => { throw new Error("disabled check must not write a widget"); } },
      };
      for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
      for (const [toolName, input] of [
        ["task", { tasks: [{ name: "Export", task: "Write CSV." }] }],
        ["maker_route", { tasks: [{ name: "Export", task: "Write CSV." }] }],
        ["lab_goal", { op: "frame", size: "normal", goal: "Export", deliverables: [{ id: "export", path: "out.csv" }] }],
      ] as const) {
        for (const handler of handlers.get("tool_call") ?? []) expect(await handler({ toolName, input }, ctx)).toBeUndefined();
      }
      expect(resolutions).toBe(0);
      expect(tools).toEqual([]);
    });
  }
});
