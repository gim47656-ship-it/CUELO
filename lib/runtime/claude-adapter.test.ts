import { describe, expect, test } from "bun:test";
import { convertClaudeMessage } from "./claude-adapter";

describe("convertClaudeMessage", () => {
  test("converts session, assistant content blocks, and tool results", () => {
    expect(convertClaudeMessage({ type: "system", subtype: "init", session_id: "session-1" })).toEqual([
      { type: "session_started", sessionId: "session-1", engine: "claude" },
    ]);
    expect(convertClaudeMessage({
      type: "assistant",
      message: { content: [
        { type: "text", text: "hello" },
        { type: "thinking", thinking: "reasoning" },
        { type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "hello.txt", content: "hi" } },
      ] },
    })).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "reasoning_delta", text: "reasoning" },
      { type: "tool_started", id: "tool-1", name: "Write", input: { file_path: "hello.txt", content: "hi" } },
    ]);
    expect(convertClaudeMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "written", is_error: true }] },
    })).toEqual([{ type: "tool_completed", id: "tool-1", output: "written", isError: true }]);
  });

  test("converts streaming text and thinking deltas", () => {
    expect(convertClaudeMessage({ type: "stream_event", event: { delta: { type: "text_delta", text: "hi" } } })).toEqual([
      { type: "text_delta", text: "hi" },
    ]);
    expect(convertClaudeMessage({ type: "stream_event", event: { delta: { type: "thinking_delta", thinking: "hmm" } } })).toEqual([
      { type: "reasoning_delta", text: "hmm" },
    ]);
  });

  test("maps result usage fields and terminal result", () => {
    expect(convertClaudeMessage({
      type: "result",
      subtype: "success",
      result: "done",
      usage: { input_tokens: 20, cache_read_input_tokens: 7, cache_creation_input_tokens: 4, output_tokens: 9 },
    })).toEqual([
      { type: "usage", input: 20, cachedInput: 7, cacheWrite: 4, output: 9 },
      { type: "turn_completed", stopReason: "stop", text: "done" },
    ]);
    expect(convertClaudeMessage({ type: "result", subtype: "error_max_turns", is_error: true, result: "stopped" })).toEqual([
      { type: "turn_completed", stopReason: "error", text: "stopped" },
    ]);
  });
});
