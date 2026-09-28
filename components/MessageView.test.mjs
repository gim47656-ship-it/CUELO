import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderMessage(message) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message }),
    ),
  );
}

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("renders shell blocks as themed terminal content", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-test",
          content: [{
            type: "toolCall",
            toolCallId: "shell-1",
            toolName: "bash",
            input: { command: "git status --short" },
          }],
        },
        toolResults: new Map([
          ["shell-1", {
            role: "toolResult",
            toolCallId: "shell-1",
            content: [{ type: "text", text: "staged 0, unstaged 1\n M components/MessageView.tsx" }],
          }],
        ]),
      }),
    ),
  );

  assert.match(html, /class="shell-output-preview"/);
  assert.match(html, /git<\/span>/);
  assert.match(html, /--short/);
  assert.match(html, /Output/);
  assert.match(html, /components\/MessageView\.tsx/);
});

test("uses i/title in the standard header for grep, read, write, glob, and eval blocks", () => {
  const cases = [
    ["read", "i", "Verifico bridge startSessionReplay e campionamento", { i: "Verifico bridge startSessionReplay e campionamento", path: "lib/main.dart" }, "lib/main.dart"],
    ["grep", "i", "Individuo avvio e stop del session replay", { i: "Individuo avvio e stop del session replay", path: "lib/main.dart" }, "lib/main.dart"],
    ["write", "i", "Individuo simbolo Main dell'app Flutter", { i: "Individuo simbolo Main dell'app Flutter", path: "lib/main.dart" }, "lib/main.dart"],
    ["glob", "i", "Individuo componenti TypeScript", { i: "Individuo componenti TypeScript", path: "components/**/*.tsx" }, "components/**/*.tsx"],
    ["eval", "title", "Valuto il risultato del parser", { title: "Valuto il risultato del parser", code: "return 42" }, "return 42"],
  ];

  for (const [toolName, property, preview, input, fallback] of cases) {
    const html = renderMessage({
      role: "assistant",
      provider: "openai",
      model: "gpt-test",
      content: [{
        type: "toolCall",
        toolCallId: `${toolName}-preview`,
        toolName,
        input,
      }],
    });

    const renderedPreview = preview.replaceAll("'", "&#x27;");
    const previewPosition = html.indexOf(renderedPreview);
    const toolPosition = html.indexOf(`>${toolName}</span>`);
    assert.ok(previewPosition > toolPosition, `expected ${property} from ${toolName} in the standard header`);
    assert.doesNotMatch(html, /class="tool-intent-preview"/);
    assert.ok(!html.includes(fallback), `expected ${toolName} fallback to stay out of the header`);
  }
});

test("shows an operation icon beside every standard tool label", () => {
  const cases = [
    ["read", "read", "var(--accent)"],
    ["write", "write", "var(--warning)"],
    ["glob", "glob", "var(--accent-hover)"],
    ["grep", "grep", "var(--accent)"],
    ["edit", "edit", "var(--warning)"],
    ["eval", "eval", "var(--accent-hover)"],
    ["functions.task", "task", "var(--accent)"],
    ["unknown_tool", "generic", "var(--text-dim)"],
  ];

  for (const [toolName, iconKind, themeColor] of cases) {
    const html = renderMessage({
      role: "assistant",
      provider: "openai",
      model: "gpt-test",
      content: [{
        type: "toolCall",
        toolCallId: `${toolName}-icon`,
        toolName,
        input: {},
      }],
    });

    const iconPosition = html.indexOf(`data-tool-icon="${iconKind}"`);
    const iconEnd = html.indexOf(">", iconPosition);
    const toolPosition = html.indexOf(`>${toolName}</span>`);
    assert.ok(iconPosition >= 0, `expected ${iconKind} icon for ${toolName}`);
    assert.ok(html.slice(iconPosition, iconEnd).includes(`color:${themeColor}`), `expected ${toolName} icon to use ${themeColor}`);
    assert.ok(iconPosition < toolPosition, `expected ${iconKind} icon before ${toolName}`);
  }
});


test("renders every todo task in an integrated checklist", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-test",
          content: [{
            type: "toolCall",
            toolCallId: "todo-1",
            toolName: "todo",
            input: {
              list: [{
                phase: "Implementation",
                items: ["First task", "Second task", "Third task", "Fourth task"],
              }],
            },
          }],
        },
        toolResults: new Map([
          ["todo-1", {
            role: "toolResult",
            toolCallId: "todo-1",
            details: {
              phases: [{
                name: "Implementation",
                tasks: [
                  { content: "First task", status: "completed" },
                  { content: "Second task", status: "completed" },
                  { content: "Third task", status: "in_progress" },
                  { content: "Fourth task", status: "pending" },
                ],
              }],
            },
            content: [],
          }],
        ]),
      }),
    ),
  );

  assert.match(html, /class="todo-checklist-preview"/);
  assert.match(html, /Todo 4 tasks/);
  assert.match(html, /First task/);
  assert.match(html, /Second task/);
  assert.match(html, /Third task/);
  assert.match(html, /Fourth task/);
  assert.doesNotMatch(html, /… 1/);
});

function renderThinking(thinking) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-test",
          content: [{ type: "thinking", thinking }],
        },
      }),
    ),
  );
}

test("folds the English monologue to one line and keeps Korean thinking open", () => {
  const english = renderThinking("**Direct thought** about the session reader before editing.");
  assert.match(english, /class="markdown-thinking"/);
  assert.match(english, /class="markdown-thinking-fold"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(english, /Direct thought/);

  const korean = renderThinking("**세션 리더**부터 확인할게요.");
  assert.match(korean, /<strong>세션 리더<\/strong>/);
  assert.doesNotMatch(korean, /aria-expanded/);
});
