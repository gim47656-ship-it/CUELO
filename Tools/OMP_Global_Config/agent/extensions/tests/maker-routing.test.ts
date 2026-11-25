import { describe, expect, test } from "bun:test";
import { registerMakerRouting } from "../lib/maker-routing";

const effortRange = Symbol.for("cuelo.makerEffort");
const sonnet = "anthropic/test-sonnet";
const sol = "openai-codex/test-sol";
const registryModel = { thinking: { efforts: ["medium", "high", "xhigh"] } };

function harness(registry = { find: (_provider: string, _id: string) => registryModel as typeof registryModel | undefined, refreshDiscoverableProviders: async (_providers: string[], _mode: string) => {} }) {
  const routing = registerMakerRouting({} as never, {
    settings: async () => ({ getModelRoles: () => ({ implSonnet: `${sonnet}:high`, implSol: `${sol}:auto` }) }),
    owners: () => [],
  });
  const ctx = { sessionManager: { getSessionId: () => "dispatch-test" }, modelRegistry: registry } as never;
  return { routing, beforeTask: (input: Record<string, unknown>, id: string) => routing.beforeTask(input, ctx, id) };
}

function item(name: string, path: string, model = `${sonnet}:auto`) {
  return { name, model, solutionSpace: "Use the existing path and checks.", task: `TASK_GUARD:\nWORK_CLASS: feature\nPRIMARY_DELIVERABLE: Export\nOWNED_PATHS: ${path}\n\nImplement export.` };
}

describe("task candidate and reservation admission", () => {
  test("exact profile IDs preserve the selected effort range for slots sharing one model", async () => {
    const h = harness();
    const hard = { ...item("Hard", "hard.ts", "HARD_CODE_SOL"), effort: "high" };
    const normal = item("Normal", "normal.ts", "NORMAL_SOL");
    const set = await h.beforeTask({ tasks: [hard, normal] }, "profiles");
    const tasks = set?.input?.tasks as Record<string, unknown>[];
    expect(tasks[0]).toMatchObject({ model: `${sol}:auto` });
    expect(tasks[0]).not.toHaveProperty("effort");
    expect(Reflect.get(tasks[0]!, effortRange)).toEqual({ start: "medium", max: "xhigh" });
    expect(tasks[1]).toMatchObject({ model: `${sol}:auto` });
    expect(Reflect.get(tasks[1]!, effortRange)).toEqual({ start: "high", max: "xhigh" });
    expect(hard).toMatchObject({ model: "HARD_CODE_SOL", effort: "high" });
    expect(await h.beforeTask(item("Unknown", "other.ts", "HARD_UNKNOWN_SOL"), "unknown")).toMatchObject({ block: true });
  });

  test("same checkout directory collisions reserve atomically across concurrent calls; isolated work is separate", async () => {
    const h = harness();
    const left = item("Left", "src/");
    const right = item("Right", "./SRC/export.ts");
    const results = await Promise.all([h.beforeTask(left, "left"), h.beforeTask(right, "right")]);
    expect(results.filter((result) => result?.block)).toHaveLength(1);
    expect(await h.beforeTask({ ...right, isolated: "capture" }, "capture")).toBeUndefined();
    expect(await h.beforeTask({ isolated: true, tasks: [{ ...right, isolated: false }] }, "shared")).toMatchObject({ block: true });
  });

  test("missing, blank and non-string solutionSpace reject the batch without reserving its valid sibling", async () => {
    const h = harness();
    const good = item("Good", "a.ts");
    for (const solutionSpace of [undefined, "\n  ", 3]) {
      const invalid = { ...item("Invalid", "b.ts"), solutionSpace };
      expect(await h.beforeTask({ tasks: [good, invalid] }, "bad")).toMatchObject({ block: true, reason: expect.stringContaining("solutionSpace") });
    }
    expect(await h.beforeTask(good, "good")).toBeUndefined();
  });

  test("registry discovery is limited to selected candidates, at most once per provider per call", async () => {
    const refreshed: string[] = [];
    const h = harness({
      find: (provider) => refreshed.includes(provider) ? registryModel : undefined,
      async refreshDiscoverableProviders(providers, mode) {
        expect(mode).toBe("online");
        refreshed.push(...providers);
      },
    });
    const tasks = [item("First", "a.ts"), item("Second", "b.ts")];
    expect(await h.beforeTask({ tasks }, "known")).toBeUndefined();
    expect(refreshed).toEqual(["anthropic"]);
    expect(await h.beforeTask(item("Invalid", "c.ts", "test/unconfigured"), "bad")).toMatchObject({ block: true });
    expect(refreshed).toEqual(["anthropic"]);
  });

  test("phone operator calls without a model keep their exception; a model override does not", async () => {
    const h = harness();
    const phone = { agent: "phone-operator", name: "Phone", task: "Read the calculator display." };
    expect(await h.beforeTask(phone, "phone")).toBeUndefined();
    expect(await h.beforeTask({ ...phone, model: `${sonnet}:auto` }, "overridden")).toMatchObject({ block: true });
  });
});
