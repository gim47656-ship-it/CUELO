import { expect, test } from "bun:test";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { A2UI_AGENT_PROMPT, registerA2uiAgentPrompt, withA2uiAgentPrompt } from "./agent-prompt";
import { buildActionEnvelope, formatActionMessage, parseA2uiBlock, parseActionMessage } from "./blocks";

function start(prompt: string, reason: BeforeAgentStartEvent["reason"] = "prompt") {
  let handler!: (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult | undefined;
  registerA2uiAgentPrompt({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as ExtensionAPI);
  return handler({ type: "before_agent_start", reason, prompt, systemPrompt: [withA2uiAgentPrompt("Operator policy")] });
}

const guide: BeforeAgentStartEventResult = {
  message: { customType: "cuelo-a2ui-guide", content: A2UI_AGENT_PROMPT, display: false, attribution: "agent" },
};

test("ordinary prompts get only the stable card capability and a usable minimal example", () => {
  expect(withA2uiAgentPrompt("Operator policy", false)).toBe(`Operator policy\n\n${A2UI_AGENT_PROMPT}`);
  const hint = withA2uiAgentPrompt(undefined);
  expect(withA2uiAgentPrompt("Operator policy")).toBe(`Operator policy\n\n${hint}`);
  expect(hint).toContain("on-demand A2UI guide");
  expect(hint).not.toContain("# Answer cards (A2UI)");
  const example = parseA2uiBlock(hint.slice(hint.indexOf("[")));
  expect(example.ok && example.messages).toMatchObject([
    { version: "1.0", createSurface: { surfaceId: "summary", catalogId: "cuelo" } },
    { version: "1.0", updateComponents: { surfaceId: "summary", components: [{ id: "root", component: "Card", child: "t" }, { id: "t", component: "Text" }] } },
  ]);
  expect(start("Explain binary search.")).toBeUndefined();
  expect(start("What options does git log take?")).toBeUndefined();
  expect(start("My credit card was declined.")).toBeUndefined();
  expect(start("Show build progress.")).toBeUndefined();
  expect(start("Make an answer card.", "revive")).toBeUndefined();
});

test.each([
  "Make an answer card.",
  "Compare Option A and Option B and recommend one.",
  "Show a progress update.",
  "두 방안의 장단점을 알려줘.",
])("passes the full spec before the model answers %s", (prompt) => {
  expect(start(prompt)).toEqual(guide);
});

test("an unchanged action envelope gets hidden guidance even in a queued batch", () => {
  const envelope = buildActionEnvelope({ name: "pick", surfaceId: "p", sourceComponentId: "b", timestamp: "t", context: {} }, { selection: "A" });
  const action = formatActionMessage(envelope);
  expect(parseActionMessage(action)?.envelope).toEqual(envelope);
  expect(start(action)).toEqual(guide);
  expect(start(`Keep going.\n\n${action}`)).toEqual(guide);
});
