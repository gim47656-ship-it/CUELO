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
  const call = (toolName: string, input: Record<string, unknown>, isError = false) => {
    // 코어는 실행 전에 `tool_call`, 끝난 뒤 `tool_result`를 보낸다. 차단된 호출은 `tool_result`가 없다.
    handlers.get("tool_call")?.({ toolName, input }, ctx);
    handlers.get("tool_result")?.({ toolName, input, isError, content: [] }, ctx);
  };
  return {
    sent,
    logs,
    input: (source = "interactive") => handlers.get("input")!({ source }, ctx),
    start: (reason = "prompt") => handlers.get("before_agent_start")?.({ reason, prompt: "Investigate files" }, ctx),
    call,
    callError: (toolName: string, input: Record<string, unknown>) => call(toolName, input, true),
    blocked: (toolName: string, input: Record<string, unknown>) => handlers.get("tool_call")?.({ toolName, input }, ctx),
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

  test("a failed or blocked read does not take an exploration slot", () => {
    const h = harness();
    h.input();
    for (const path of ["src/f1.ts", "src/f2.ts", "src/f3.ts"]) h.call("read", { path });
    h.blocked("read", { path: "src/blocked.ts" }); // 다른 가드가 막은 호출은 결과가 없다
    h.callError("read", { path: "src/missing.ts" }); // 실행은 됐지만 실패한 읽기
    expect(h.sent).toHaveLength(0);
    h.call("read", { path: "src/f4.ts" });
    expect(h.sent).toHaveLength(1);
    expect(h.logs.map((r) => r.type)).toEqual(["nudge"]);
    expect(h.logs[0]).toMatchObject({ files: 4 });
  });

  test("a failed skim or task does not count as delegating", () => {
    const h = harness();
    h.input();
    h.callError("skim", { paths: ["src"] });
    h.callError("task", { prompt: "investigate" });
    for (let i = 0; i < EXPLORATION_READS_BEFORE_NUDGE; i += 1) h.call("read", { path: `src/f${i}.ts` });
    expect(h.sent).toHaveLength(1); // 실패한 넘김 뒤에도 안내는 살아 있다
  });

  test("a failed edit or write does not count as editing the file", () => {
    const h = harness();
    h.input();
    h.callError("write", { path: "src/a.ts" });
    h.callError("edit", { path: "src/b.ts", old_string: "x", new_string: "y" });
    for (const path of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]) h.call("read", { path });
    expect(h.sent).toHaveLength(1);
  });

  test("replace-mode edit targets from the normalized path are not counted as exploration", () => {
    const h = harness();
    h.input();
    // replace/apply_patch/patch 모드는 hashline 마커가 없고 정규화된 `path`만 온다.
    for (let i = 0; i < EXPLORATION_READS_BEFORE_NUDGE - 1; i += 1) h.call("read", { path: `src/f${i}.ts` });
    h.call("edit", { path: "src/f0.ts", old_string: "a", new_string: "b" });
    h.call("read", { path: "src/other.ts" });
    expect(h.sent).toHaveLength(0); // 편집한 f0은 빠지므로 아직 3개다
    h.call("read", { path: "src/last.ts" });
    expect(h.sent).toHaveLength(1);
  });

  test("a multi-file edit counts every normalized path", () => {
    const h = harness();
    h.input();
    for (const path of ["src/a.ts", "src/b.ts", "src/c.ts"]) h.call("read", { path });
    h.call("edit", { paths: ["src/a.ts", "src/b.ts", "src/c.ts"] });
    // 편집한 셋은 탐색에서 빠지므로, 이어 읽는 넷째 파일이 다시 4개째다.
    for (const path of ["src/d.ts", "src/e.ts", "src/f.ts"]) h.call("read", { path });
    expect(h.sent).toHaveLength(0);
    h.call("read", { path: "src/g.ts" });
    expect(h.sent).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ type: "nudge", files: 4 });
  });

  test("a normalized edit target is authoritative over stray marker-shaped text in the payload", () => {
    const h = harness();
    h.input();
    // 실제 대상은 a이고, payload 안의 `[b#TAG]` 모양 글자는 편집 대상이 아니다.
    for (const path of ["src/b.ts", "src/c.ts", "src/d.ts"]) h.call("read", { path });
    h.call("edit", {
      path: "src/a.ts",
      input: "[src/b.ts#1A2B]\nPUT 1.=1:\n+stray marker-shaped line\n",
    });
    // b가 남아 있어야 e가 서로 다른 미편집 파일 4개째가 되어 안내가 나온다.
    // b가 잘못 빠졌다면 남은 셋뿐이라 안내가 나오지 않는다.
    h.call("read", { path: "src/e.ts" });
    expect(h.sent).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ type: "nudge", files: 4 });
  });

  test("hashline edit mode still reads targets from markers when no normalized path is present", () => {
    const h = harness();
    h.input();
    for (let i = 0; i < EXPLORATION_READS_BEFORE_NUDGE - 1; i += 1) h.call("read", { path: `src/f${i}.ts` });
    // hashline 모드: 정규화된 path가 없고 마커만 온다.
    h.call("edit", { input: "[src/f0.ts#1A2B]\nPUT 1.=1:\n+value\n" });
    h.call("read", { path: "src/other.ts" });
    expect(h.sent).toHaveLength(0); // 편집한 f0은 빠져 아직 3개다
    h.call("read", { path: "src/last.ts" });
    expect(h.sent).toHaveLength(1);
  });

  test("path normalization strips selectors and queries", () => {
    expect(normalizeReadPath("a/b.ts:50-80", "/r")).toBe("/r/a/b.ts");
    expect(normalizeReadPath("a/b.ts:raw:2-4", "/r")).toBe("/r/a/b.ts");
    expect(normalizeReadPath("x.json?q=.a", "/r")).toBe("/r/x.json");
    expect(normalizeReadPath("local://n.md", "/r")).toBeNull();
  });
});
