import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

if (process.env.CUELO_ASSISTANT_CHILD === "1") {
  const starting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const restrictions: string[][] = [];
  let promptCount = 0;
  const allowed = ["read", "grep", "glob", "web_search"];
  let restriction: string[] | undefined = allowed;
  let alive = true, idle = true, unsafeTools = false, omitAnswer = false, deadAfterPrompt = false;
  let shutdowns = 0;
  let raceBusy = false;
  let answer = "fixture answer";
  const history: { role: string; content: string; stopReason?: string }[] = [];
  mock.module("./model", () => ({ routineModelSettings: async () => ({ enabled: false }), runRoutineChecker: async () => "{}" }));
  const session = {
    sessionId: "fixture-assistant-session", sessionFile: join(process.env.PI_CODING_AGENT_DIR!, "session.jsonl"),
    get restrictTools() { return restriction; },
    isAlive: () => alive, isSafelyIdle: () => idle, isRunning: () => false, waitUntilReady: async () => {},
    onEvent: () => () => {}, beginClose() {}, shutdown: async () => { shutdowns++; alive = false; }, destroy: () => { alive = false; },
    inner: { sessionManager: { buildSessionContext: () => ({ messages: history }) } },
    send: async (command: { type: string; message?: string }) => {
      if (command.type === "get_tools") return [...allowed, ...(unsafeTools ? ["bash"] : [])].map((name) => ({ name, active: true }));
      if (command.type === "abort" && deadAfterPrompt) throw new Error("fixture abort error");
      if (command.type === "prompt") {
        promptCount++;
        expect(command.message).toContain("use oneOff:false and preserve the requested date/time");
        history.push({ role: "user", content: command.message! });
        if (!omitAnswer) history.push({ role: "assistant", content: answer, stopReason: "stop" });
        if (deadAfterPrompt) alive = false;
      }
      if (command.type === "get_last_assistant_text") return { text: answer };
    },
  };
  mock.module("../rpc-manager", () => ({
    getRpcSession: () => session,
    startNewRpcSession: async (_request: unknown, _cwd: string, options: { restrictTools: string[] }) => {
      restrictions.push(options.restrictTools); starting.resolve(); await release.promise; alive = true; restriction = options.restrictTools;
      return { session, realSessionId: session.sessionId };
    },
    startRpcSession: async (_id: string, _file: string, _cwd: string, options: { restrictTools: string[] }) => {
      restrictions.push(options.restrictTools); alive = true; restriction = options.restrictTools; if (raceBusy) idle = false; return { session, realSessionId: session.sessionId };
    },
  }));
  const { startAssistantTurn, assistantSnapshot, ASSISTANT_TOOLS } = await import("./assistant");
  const { readAssistantState, saveAssistantState, cancelAssistantProposal } = await import("./assistant-proposals");
  test("session startup preserves an interleaved cancellation and new cards; every resume re-passes admission policy", async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const at = new Date().toISOString();
    saveAssistantState({ proposals: [{ id: "cancel-me", action: "run", status: "pending", routineId: "test", at, changedAt: at, turn: "old" }], notified: [] });
    startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "fixture" });
    await starting.promise;
    expect(() => startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "duplicate" })).toThrow(/이전 요청/);
    cancelAssistantProposal("cancel-me");
    const state = readAssistantState();
    state.proposals.push({ id: "new-card", action: "enable", status: "pending", routineId: "test", at, changedAt: at, turn: "another" });
    saveAssistantState(state);
    writeFileSync(session.sessionFile, "fixture saved session");
    release.resolve();
    await globalThis.__cueloRoutineAssistantWork;
    expect(readAssistantState().proposals.find((p) => p.id === "cancel-me")?.status).toBe("cancelled");
    expect(readAssistantState().proposals.find((p) => p.id === "new-card")?.status).toBe("pending");
    expect(readAssistantState().sessionId).toBe(session.sessionId);
    startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "follow-up" });
    await globalThis.__cueloRoutineAssistantWork;
    expect(promptCount).toBe(2);
    expect(restrictions).toEqual([ASSISTANT_TOOLS, ASSISTANT_TOOLS]);
    expect(agentDir).toBeTruthy();
  });
  test("idle unrestricted wrapper is replaced, running external wrapper returns 409, and reset notice clears", async () => {
    restriction = undefined;
    const before = shutdowns;
    startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "restore restricted conversation" });
    await globalThis.__cueloRoutineAssistantWork;
    expect(shutdowns).toBe(before + 1);
    expect(session.restrictTools).toEqual(ASSISTANT_TOOLS);
    idle = false;
    expect(() => startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "busy" })).toThrow(/다른 화면/);
    idle = true;
    saveAssistantState({ sessionId: "gone", proposals: [], notified: [] });
    alive = false;
    startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "new" });
    await globalThis.__cueloRoutineAssistantWork;
    expect(readAssistantState().newSession).toBe(true);
    startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "continued" });
    await globalThis.__cueloRoutineAssistantWork;
    expect(readAssistantState().newSession).toBe(false);
  });
  test("no new answer cannot re-extract the previous turn's create proposal", async () => {
    answer = '```routine-proposal\\n{"action":"create","name":"fixture","prompt":"fixture","enabled":false,"host":"fixture","cwd":null,"schedule":{"kind":"hourly","everyHours":1,"minute":0}}\\n```'.replaceAll("\\n", "\n");
    startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "create" });
    await globalThis.__cueloRoutineAssistantWork;
    const count = readAssistantState().proposals.length;
    expect(count).toBe(1);
    omitAnswer = true;
    startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "aborted follow-up" });
    await globalThis.__cueloRoutineAssistantWork;
    expect(readAssistantState().proposals.length).toBe(count);
    expect(readAssistantState().error).toContain("요청을 처리하지 못했습니다");
    omitAnswer = false; answer = "fixture answer";
  });
  test("rejected startup closes the orphan, and cleanup failure preserves the original prompt error", async () => {
    saveAssistantState({ proposals: [], notified: [] });
    unsafeTools = true;
    const before = shutdowns;
    startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "reject unsafe startup" });
    await globalThis.__cueloRoutineAssistantWork;
    expect(shutdowns).toBe(before + 1);
    expect(readAssistantState().sessionId).toBeUndefined();
    unsafeTools = false; deadAfterPrompt = true;
    startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "dead session" });
    await globalThis.__cueloRoutineAssistantWork;
    expect(readAssistantState().error).toContain("요청을 처리하지 못했습니다");
    expect(readAssistantState().error).not.toContain("fixture abort error");
    expect(globalThis.__cueloRoutineAssistantWork).toBeUndefined();
    deadAfterPrompt = false;
  });
  test("generic replies do not replace the routine assistant answer; a racing busy wrapper is not aborted", async () => {
    alive = true; idle = true; deadAfterPrompt = false;
    history.length = 0;
    history.push({ role: "user", content: "[CUELO_ROUTINE_ASSISTANT turn=t1]\n\n[CUELO_USER]\nhello" }, { role: "assistant", content: "original answer", stopReason: "stop" }, { role: "user", content: "generic prompt" }, { role: "assistant", content: "generic reply", stopReason: "stop" });
    saveAssistantState({ sessionId: session.sessionId, sessionFile: session.sessionFile, proposals: [], notified: [] });
    expect((await assistantSnapshot()).messages.at(-1)?.text).toBe("original answer");
    const before = shutdowns;
    raceBusy = true;
    startAssistantTurn(process.env.CUELO_ROUTINES_DIR!, { text: "racing turn" });
    await globalThis.__cueloRoutineAssistantWork;
    expect(shutdowns).toBe(before);
    expect(readAssistantState().error).toContain("다른 화면");
    raceBusy = false; idle = true;
  });
} else {
  test("assistant interleaving fixture has an isolated module registry and state directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cuelo-assistant-session-"));
    try {
      console.log(execFileSync(process.execPath, ["test", import.meta.filename], { encoding: "utf8", timeout: 30000,
        env: { ...process.env, CUELO_ASSISTANT_CHILD: "1", PI_CODING_AGENT_DIR: root, CUELO_ROUTINES_DIR: root },
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
