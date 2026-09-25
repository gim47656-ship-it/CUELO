import { describe, expect, test } from "bun:test";
import { mapOmpEvent } from "./omp-adapter";
import type { AgentEvent } from "./types";

describe("mapOmpEvent", () => {
  test("maps assistant text and reasoning deltas", () => {
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent) => events.push(event);
    mapOmpEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hello" } }, emit);
    mapOmpEvent({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } }, emit);
    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "reasoning_delta", text: "reason" },
    ]);
  });

  test("maps tool lifecycle and terminal agent events", () => {
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent) => events.push(event);
    mapOmpEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a" } }, emit);
    mapOmpEvent({ type: "tool_execution_end", toolCallId: "t1", result: "ok", isError: false }, emit);
    mapOmpEvent({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }, emit);
    expect(events).toEqual([
      { type: "tool_started", id: "t1", name: "read", input: { path: "a" } },
      { type: "tool_completed", id: "t1", output: "ok", isError: false },
      { type: "turn_completed", stopReason: "stop", text: "done" },
    ]);
  });

  test("maps aborted turns and ignores unrelated OMP events", () => {
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent) => events.push(event);
    mapOmpEvent({ type: "agent_end", aborted: true }, emit);
    mapOmpEvent({ type: "agent_start" }, emit);
    expect(events).toEqual([{ type: "turn_completed", stopReason: "aborted", text: "" }]);
  });
});
