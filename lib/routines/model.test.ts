import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRoutineAnswer, checkerContext, parseCheckerFindings, parseRoutineModel, selectRoutineModel } from "../../Tools/OMP_Global_Config/agent/cuelo-plugins/routine-model/policy";
import { routineModelSettings } from "./model";
import { parseRoutineInput, readRoutine, writeRoutineFile } from "./store";

const input = { name: "test", enabled: true, schedule: { kind: "weekly", days: [1], times: ["10:00"] }, host: "instabox", prompt: "all four doses", cwd: null };
const future = () => Date.now() + 10_000;

describe("routine-only model selection", () => {
  test("override > PC > unchanged default; disabled ignores both", () => {
    expect(selectRoutineModel(true, "a/b", "c/d")).toBe("a/b");
    expect(selectRoutineModel(true, null, "c/d")).toBe("c/d");
    expect(selectRoutineModel(true)).toBeUndefined();
    expect(selectRoutineModel(false, "a/b", "c/d")).toBeUndefined();
  });
  test("save validates syntax only and round-trips unavailable host models", async () => {
    const dir = await mkdtemp(join(tmpdir(), "routine-model-store-"));
    try {
      const parsed = parseRoutineInput({ ...input, model: "cloud-only/not-installed-here" });
      if ("error" in parsed) throw new Error(parsed.error);
      writeRoutineFile(dir, { ...parsed.input, id: "r-test", createdAt: "", updatedAt: "", timezone: "Asia/Seoul" });
      expect(readRoutine(dir, "r-test")?.model).toBe("cloud-only/not-installed-here");
      expect(parseRoutineInput({ ...input, model: 3 })).toHaveProperty("error");
      for (const model of ["sonnet", "anthropic/*", "a/b c", "/b"]) {
        expect(parseRoutineInput({ ...input, model })).toHaveProperty("error");
      }
      expect(parseRoutineInput(input)).toHaveProperty("input.model", null);
      expect(parseRoutineModel("a/nested/model")).toEqual({ provider: "a", modelId: "nested/model" });
      expect(parseRoutineModel("ollama.local/llama3.1:8b")).toEqual({ provider: "ollama.local", modelId: "llama3.1:8b" });
      // A hand-edited shared field must not remove a routine from a disabled host.
      for (const model of ["sonnet", 3, { bad: true }]) {
        await writeFile(join(dir, "routines/r-test/routine.json"), JSON.stringify({ ...input, id: "r-test", model }));
        expect(readRoutine(dir, "r-test")?.id).toBe("r-test");
        expect(() => parseRoutineModel(readRoutine(dir, "r-test")!.model!)).toThrow();
      }
      await writeFile(join(dir, "routines/r-test/routine.json"), JSON.stringify({ ...input, id: "r-test", model: "  " }));
      expect(readRoutine(dir, "r-test")?.model).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("oversized rejected selectors have bounded error messages", () => {
    let message = "";
    try { parseRoutineModel("a/" + "x".repeat(1_000_000)); } catch (error) { message = String(error); }
    expect(message.length).toBeGreaterThan(0);
    expect(message.length).toBeLessThan(400);
  });
  test("installed toggle gates PC-local file and override wins without reading broken PC setting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "routine-model-config-"));
    try {
      expect(await routineModelSettings("a/b", dir)).toEqual({ enabled: false, model: undefined });
      await mkdir(join(dir, "cuelo-plugins/routine-model"), { recursive: true });
      await cp("Tools/OMP_Global_Config/agent/cuelo-plugins/routine-model/plugin.json", join(dir, "cuelo-plugins/routine-model/plugin.json"));
      expect(await routineModelSettings(null, dir)).toEqual({ enabled: true, model: undefined });
      await writeFile(join(dir, "routine-model.json"), JSON.stringify({ model: "aistudio/gemini-4-hydrogen" }));
      expect((await routineModelSettings(null, dir)).model).toBe("aistudio/gemini-4-hydrogen");
      await writeFile(join(dir, "routine-model.json"), '\uFEFF{"model":"a/b"}');
      expect((await routineModelSettings(null, dir)).model).toBe("a/b");
      await writeFile(join(dir, "routine-model.json"), '{"model":"sonnet"}');
      await expect(routineModelSettings(null, dir)).rejects.toThrow("sonnet");
      await writeFile(join(dir, "routine-model.json"), "broken");
      expect((await routineModelSettings("anthropic/claude-sonnet-5-5", dir)).model).toBe("anthropic/claude-sonnet-5-5");
      await mkdir(join(dir, "plugin-lab"));
      await writeFile(join(dir, "plugin-lab/state.json"), JSON.stringify({ disabled: ["routine-model"] }));
      expect(await routineModelSettings("a/b", dir)).toEqual({ enabled: false, model: undefined });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("fresh pre-post checker", () => {
  test("always checks independently, even Sonnet Main, using only instruction and answer", async () => {
    let calls = 0;
    const answer = await checkRoutineAnswer({ instruction: "required", answer: "Sonnet final", deadline: future(),
      check: async (context) => {
        calls++;
        expect(context.messages).toHaveLength(1);
        expect(JSON.parse(context.messages[0].content)).toEqual({ instruction: "required", answer: "Sonnet final" });
        expect(Object.keys(context).sort()).toEqual(["messages", "systemPrompt"]);
        return '{"findings":[]}';
      }, revise: async () => { throw new Error("must not revise"); }, log: () => {} });
    expect(answer).toBe("Sonnet final"); expect(calls).toBe(1);
    expect(checkerContext("p", "a").systemPrompt.join(" ")).toContain("no transcript or tools");
  });
  test("findings revise once, preserving instruction and full answer publication", async () => {
    let checked = 0, revised = 0;
    const answer = await checkRoutineAnswer({ instruction: "4 doses", answer: "2 doses", deadline: future(),
      check: async () => { checked++; return '{"findings":["missing 7.5 and 10 mg"]}'; },
      revise: async message => { revised++; expect(message).toContain("missing 7.5 and 10 mg"); return "4 doses"; }, log: () => {} });
    expect(answer).toBe("4 doses"); expect(checked).toBe(1); expect(revised).toBe(1);
  });
  test.each(["provider", "malformed", "revision", "empty", "quiet revision"])("%s failure posts original", async kind => {
    const logs: string[] = [];
    const answer = await checkRoutineAnswer({ instruction: "p", answer: "original", deadline: future(),
      check: async () => { if (kind === "provider") throw new Error("provider failed"); return kind === "malformed" ? "nonsense" : '{"findings":["fix"]}'; },
      revise: async () => { if (kind === "revision") throw new Error("revision failed"); return kind === "empty" ? "" : "[알림 없음]"; }, log: message => logs.push(message) });
    expect(answer).toBe("original"); expect(logs.at(-1)).toContain("posting original");
  });
  test("expired deadline and checker timeout cannot block original posting", async () => {
    let aborted = false;
    const answer = await checkRoutineAnswer({ instruction: "p", answer: "original", deadline: Date.now() + 15,
      check: async (_context, signal) => { signal.addEventListener("abort", () => { aborted = true; }); return Promise.withResolvers<string>().promise; },
      revise: async () => "no", log: () => {} });
    expect(answer).toBe("original"); expect(aborted).toBe(true);
    expect(await checkRoutineAnswer({ instruction: "p", answer: "original", deadline: 0, check: async () => { throw new Error("not called"); }, revise: async () => "no", log: () => {} })).toBe("original");
  });
  test("quiet first line is never checked (including CRLF and explanatory tail)", async () => {
    let called = false;
    const answer = "[알림 없음]\r\nexplanation";
    expect(await checkRoutineAnswer({ instruction: "p", answer, deadline: future(), check: async () => { called = true; return ""; }, revise: async () => "", log: () => {} })).toBe(answer);
    expect(called).toBe(false);
  });
  test("checker JSON rejects invalid findings instead of silently approving", () => {
    expect(() => parseCheckerFindings('{"findings":[1]}')).toThrow();
    expect(parseCheckerFindings('```json\n{"findings":[]}\n```')).toEqual([]);
  });
});
