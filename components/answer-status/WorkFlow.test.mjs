import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StepRows } from "./WorkFlow.tsx";
import { ToolCallRevealContext } from "../tool-call-reveal.ts";
import { ProcessLogPanel } from "../workspace/ProcessLogPanel.tsx";
import { I18nProvider } from "../../hooks/useI18n.tsx";
import { deriveWorkFlow } from "../../lib/answer-status/work-flow.ts";
import { buildTranscriptRenderPlan, partitionTranscriptPlan } from "../../lib/transcript-plan.ts";

const st = (key) => key;

/** 한 턴: 검사 명령 하나를 돌리고 답한다. */
const check = { type: "toolCall", toolCallId: "toolu_check_1", toolName: "bash", input: { command: "bun run typecheck" } };
const checkResult = {
  role: "toolResult",
  toolCallId: check.toolCallId,
  toolName: "bash",
  isError: false,
  details: { exitCode: 0 },
  content: [{ type: "text", text: "Command exited with code 0" }],
  timestamp: 3,
};
const messages = [
  { role: "user", content: "타입 검사해 줘", timestamp: 1 },
  { role: "assistant", provider: "anthropic", model: "claude-test", stopReason: "toolUse", content: [check], timestamp: 2 },
  checkResult,
  { role: "assistant", provider: "anthropic", model: "claude-test", stopReason: "stop", content: [{ type: "text", text: "통과했어." }], timestamp: 4 },
];
const toolResults = new Map([[check.toolCallId, checkResult]]);

function renderRows(reveal) {
  const flow = deriveWorkFlow([check], toolResults);
  return renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ToolCallRevealContext.Provider, { value: reveal },
      createElement(StepRows, { steps: flow.steps, st }))));
}

test("a command row offers the process-log button in its expanded body only when a reveal handler exists", () => {
  const html = renderRows(() => {});
  assert.match(html, /class="[^"]*flow-reveal[^"]*"[^>]*>.*Show in process log/);
  // summary 안의 버튼은 펼치기를 깨므로 펼친 본문(flow-raw)에만 있다.
  const summary = /<summary[^>]*>.*?<\/summary>/.exec(html)?.[0] ?? "";
  assert.doesNotMatch(summary, /flow-reveal/);
  assert.match(/<div class="flow-raw">.*<\/div>/.exec(html)?.[0] ?? "", /flow-reveal/);

  assert.doesNotMatch(renderRows(null), /flow-reveal/);
});

test("the toolCallId a work-flow row carries opens the same card in the process log", () => {
  const [step] = deriveWorkFlow([check], toolResults).steps.filter((entry) => entry.stage === "check");
  assert.equal(step.toolCallId, check.toolCallId);

  const { process } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages));
  const html = renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ProcessLogPanel, {
      title: "log",
      data: { groups: process, messages, entryIds: messages.map((_, idx) => `e${idx}`), toolResults, modelNames: {} },
      focusRequest: { toolCallId: step.toolCallId, nonce: 1 },
    })));
  assert.match(html, new RegExp(`class="tool-call-card [^"]*is-reveal-target"[^>]*data-tool-call-id="${step.toolCallId}"`));
});
