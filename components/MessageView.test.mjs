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

test("renders thinking markdown directly without a collapsible card", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-test",
          content: [{ type: "thinking", thinking: "**Direct thought**" }],
        },
      }),
    ),
  );

  assert.match(html, /class="markdown-thinking"/);
  assert.match(html, /<strong>Direct thought<\/strong>/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("shows the images a tool produced as thumbnails in the answer", async () => {
  const { loadToolImageCount, toolImageBlock } = await jiti.import("../lib/message-display.ts");
  const previousFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const toolCallId = new URL(String(url), "http://localhost").searchParams.get("toolCallId");
    return new Response(JSON.stringify({ count: toolCallId === "gen-1" ? 2 : 0 }), { status: 200 });
  };
  try {
    // 화면이 그리기 전에 라우트가 센 개수를 받아 둔 상태 — 실제 화면에서는 effect 가 같은 함수를 부른다.
    assert.equal(await loadToolImageCount("s-1", "gen-1"), 2);
    assert.equal(await loadToolImageCount("s-1", "empty"), 0);
    assert.equal(await loadToolImageCount("s-1", "gen-1"), 2);
    assert.equal(asked.length, 2, "한 호출의 개수는 한 번만 묻는다");
  } finally {
    globalThis.fetch = previousFetch;
  }

  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, {
        sessionId: "s-1",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-test",
          content: [toolImageBlock("gen-1"), toolImageBlock("empty"), { type: "text", text: "Here it is." }],
        },
      }),
    ),
  );

  assert.equal(html.match(/class="tool-image-strip"/g)?.length, 1, "이미지가 없는 호출은 자리를 만들지 않는다");
  assert.match(html, /src="\/api\/tool-image\?sessionId=s-1&amp;toolCallId=gen-1&amp;index=0"/);
  assert.match(html, /src="\/api\/tool-image\?sessionId=s-1&amp;toolCallId=gen-1&amp;index=1"/);
  assert.equal(html.match(/class="tool-image-thumb"/g)?.length, 2);
  assert.ok(html.indexOf("tool-image-strip") < html.indexOf("Here it is."), "그림이 답 글 앞에 온다");
});

const liveAnswer = (extra = {}) => ({
  role: "assistant",
  provider: "openai-codex",
  model: "Codex Live",
  content: [{ type: "text", text: "통화 답변" }],
  stopReason: "stop",
  ...extra,
});

test("a live call answer shows the character who spoke, keeping the Codex footer", () => {
  const html = renderMessage(liveAnswer({ liveSpeaker: { alias: "RIN(린)", mode: "character" } }));
  assert.match(html, /rin\.webp/);
  assert.match(html, />RIN\(린\)</);
  assert.doesNotMatch(html, /YUKI\(유키\)|yuki\.webp/);
  assert.match(html, /OpenAI Codex · Codex Live/);
  assert.doesNotMatch(html, /default voice/);
});

test("a native-voice live answer marks the default voice next to the speaker", () => {
  const html = renderMessage(liveAnswer({ liveSpeaker: { alias: "MIO(미오)", mode: "native" } }));
  assert.match(html, />MIO\(미오\)</);
  assert.match(html, />default voice</);
});

test("a live answer without a recorded speaker, or with an unknown one, renders as before", () => {
  // 화자가 없으면 계정 얼굴 경로(useAccountFace) 그대로다. 정적 렌더에서 그 값은 비어 provider · 모델만 남는다.
  const before = renderMessage(liveAnswer());
  assert.doesNotMatch(before, /account-avatar|rin\.webp|default voice/);
  assert.match(before, /<span>OpenAI Codex · Codex Live<\/span>/);
  assert.equal(renderMessage(liveAnswer({ liveSpeaker: { alias: "GHOST", mode: "native" } })), before);
});
