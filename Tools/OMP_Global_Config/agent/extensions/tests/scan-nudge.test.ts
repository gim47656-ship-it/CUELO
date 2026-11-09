import { describe, expect, test } from "bun:test";
import { createScanNudge, EXPLORATION_READS_BEFORE_NUDGE, normalizeReadPath } from "../../cuelo-plugins/scan-nudge/index";

function harness(kind: "main" | "sub" = "main") {
  type Handler = (event: unknown, ctx: unknown) => void;
  const handlers = new Map<string, Handler>();
  const sent: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const pi = {
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    sendMessage: (message: { content: string }) => sent.push(message.content),
  };
  createScanNudge((record) => logs.push(record))(pi as never);
  const ctx = { cwd: "/repo", agent: { kind }, sessionManager: { getSessionId: () => "s1" } };
  return {
    sent,
    logs,
    input: (source = "interactive") => handlers.get("input")!({ source }, ctx),
    start: (reason = "prompt") => handlers.get("before_agent_start")?.({ reason, prompt: "Investigate files" }, ctx),
    call: (toolName: string, input: Record<string, unknown>) => handlers.get("tool_call")!({ toolName, input }, ctx),
  };
}

describe("scan-nudge", () => {
  test("nudges once on the 4th distinct unedited file of one user input", () => {
    expect(EXPLORATION_READS_BEFORE_NUDGE).toBe(4);
    const h = harness();
    h.input();
    for (const path of ["src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f1.ts:10-20"]) h.call("read", { path });
    expect(h.sent).toHaveLength(0);
    h.call("read", { path: "src/f4.ts" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("skim");
    h.call("read", { path: "src/f5.ts" });
    expect(h.sent).toHaveLength(1);
    h.call("skim", { paths: ["src"] });
    expect(h.logs.map((r) => r.type)).toEqual(["nudge", "followed"]);
  });

  test("files edited before or after reading, and internal URLs, do not count", () => {
    const h = harness();
    h.input();
    h.call("edit", { input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+x\n[src/b.ts#3C4D]\nPUT 1.=1:\n+y" });
    h.call("write", { path: "src/c.ts" });
    h.call("read", { path: "src/d.ts" });
    h.call("write", { path: "src/d.ts" }); // read first, edited later
    for (const path of ["src/a.ts:5", "/repo/src/b.ts", "src/c.ts", "src/d.ts", "rule://subagent", "skill://x", "https://example.com", "artifact://3"])
      h.call("read", { path });
    for (const path of ["src/e.ts", "src/f.ts", "src/g.ts"]) h.call("read", { path });
    expect(h.sent).toHaveLength(0); // four edited files + three unedited reads
    h.call("read", { path: "src/h.ts" });
    expect(h.sent).toHaveLength(1);
  });

  test("a non-user input after a user input does not inherit its read count", () => {
    const h = harness();
    h.input();
    for (const path of ["a", "b", "c"]) h.call("read", { path });
    h.input("extension");
    h.call("read", { path: "d" });
    expect(h.sent).toHaveLength(0);
  });

  test("a Maker prompt is armed without interactive input and records skim follow-through", () => {
    const sub = harness("sub");
    sub.start();
    for (let i = 0; i < EXPLORATION_READS_BEFORE_NUDGE; i += 1) sub.call("read", { path: `f${i}` });
    expect(sub.sent).toHaveLength(1);
    sub.call("read", { path: "another" });
    sub.call("skim", { paths: ["src"] });
    sub.call("skim", { paths: ["lib"] });
    expect(sub.sent).toHaveLength(1);
    expect(sub.logs.map((r) => r.type)).toEqual(["nudge", "followed"]);
  });

  test("Maker revival does not arm or reset reads, while a new prompt resets them", () => {
    const sub = harness("sub");
    sub.start("revive");
    sub.call("read", { path: "before" });
    sub.start();
    for (let i = 0; i < EXPLORATION_READS_BEFORE_NUDGE - 1; i += 1) sub.call("read", { path: `f${i}` });
    sub.start("revive");
    expect(sub.sent).toHaveLength(0);
    sub.call("read", { path: "last" });
    expect(sub.sent).toHaveLength(1);
    sub.start();
    sub.call("read", { path: "fresh" });
    expect(sub.sent).toHaveLength(1);
  });

  test("delegating first and non-user inputs stay silent; a new input re-arms", () => {
    const h = harness();
    for (let i = 0; i < 10; i += 1) h.call("read", { path: `pre${i}` }); // before any user input
    h.input("extension");
    for (let i = 0; i < 10; i += 1) h.call("read", { path: `ext${i}` });
    expect(h.sent).toHaveLength(0);
    h.input();
    h.call("task", {});
    for (let i = 0; i < 10; i += 1) h.call("read", { path: `d${i}` });
    expect(h.sent).toHaveLength(0);
    h.input();
    for (let i = 0; i < EXPLORATION_READS_BEFORE_NUDGE; i += 1) h.call("read", { path: `n${i}` });
    expect(h.sent).toHaveLength(1);
  });

  test("path normalization strips selectors and queries", () => {
    expect(normalizeReadPath("a/b.ts:50-80", "/r")).toBe("/r/a/b.ts");
    expect(normalizeReadPath("a/b.ts:raw:2-4", "/r")).toBe("/r/a/b.ts");
    expect(normalizeReadPath("x.json?q=.a", "/r")).toBe("/r/x.json");
    expect(normalizeReadPath("local://n.md", "/r")).toBeNull();
  });
});
