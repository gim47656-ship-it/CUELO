import { describe, expect, test } from "bun:test";
import goalBudgetHint from "../goal-budget-hint";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

function harness(kind?: "sub") {
  const handlers: Record<string, Handler[]> = {};
  const sent: { content: string }[] = [];
  const ctx = { agent: kind ? { kind } : undefined, sessionManager: { getSessionId: () => "main-session", getBranch: () => [] } };
  goalBudgetHint({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: { content: string }) => { sent.push(message); },
  } as unknown as Parameters<typeof goalBudgetHint>[0]);
  const emit = (name: string, event: Record<string, unknown>) => (handlers[name] ?? []).map((handler) => handler(event, ctx));
  const goal = (input: Record<string, unknown>) => emit("tool_call", { toolName: "goal", input });
  emit("session_start", {});
  return { emit, goal, sent };
}

describe("goal budget hint", () => {
  test("an unrequested token_budget gets one advisory per input and the call is never blocked", () => {
    const h = harness();
    h.emit("input", { source: "interactive", text: "인증 강화 목표로 잡고 진행해 줘" });
    expect(h.goal({ op: "create", objective: "x", token_budget: 500_000 })).toEqual([undefined]);
    h.goal({ op: "create", objective: "y", token_budget: 100_000 });
    expect(h.sent).toHaveLength(1);
    h.emit("input", { source: "rpc", text: "다음 목표" });
    h.goal({ op: "create", objective: "z", token_budget: 100_000 });
    expect(h.sent).toHaveLength(2);
  });

  test("an explicit budget request in the input or in steering stays silent", () => {
    const h = harness();
    h.emit("input", { source: "interactive", text: "토큰 예산 50만으로 목표 잡아" });
    h.goal({ op: "create", objective: "x", token_budget: 500_000 });
    h.emit("input", { source: "interactive", text: "목표 잡아 줘" });
    h.emit("message_start", { message: { role: "user", steering: true, content: [{ type: "text", text: "budget 200k tokens" }] } });
    h.goal({ op: "create", objective: "y", token_budget: 200_000 });
    h.emit("input", { source: "interactive", text: "Use no more than 1000 tokens for this goal" });
    h.goal({ op: "create", objective: "z", token_budget: 1_000 });
    h.emit("input", { source: "interactive", text: "토큰 5만 이내에서 목표로 잡아" });
    h.goal({ op: "create", objective: "w", token_budget: 50_000 });
    expect(h.sent).toHaveLength(0);
  });

  test("a token count with no limit wording is not a budget request", () => {
    const h = harness();
    h.emit("input", { source: "interactive", text: "Write a parser for documents containing 1000 tokens" });
    h.goal({ op: "create", objective: "parser", token_budget: 1_000 });
    expect(h.sent).toHaveLength(1);
  });

  test("goal calls without a budget, other tools and child sessions stay silent", () => {
    const h = harness();
    h.emit("input", { source: "interactive", text: "목표 잡아 줘" });
    h.goal({ op: "create", objective: "x" });
    h.emit("tool_call", { toolName: "todo", input: { token_budget: 1 } });
    expect(h.sent).toHaveLength(0);
    const child = harness("sub");
    child.emit("input", { source: "interactive", text: "목표 잡아 줘" });
    child.goal({ op: "create", objective: "x", token_budget: 1_000 });
    expect(child.sent).toHaveLength(0);
  });

  test("agent-attributed or synthetic steering does not count as the user asking", () => {
    const h = harness();
    h.emit("input", { source: "interactive", text: "목표 잡아 줘" });
    h.emit("message_start", { message: { role: "user", steering: true, attribution: "agent", content: "token budget 1000" } });
    h.goal({ op: "create", objective: "x", token_budget: 1_000 });
    expect(h.sent).toHaveLength(1);
  });
});
