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

// 머리줄 글자만 본다: 감싸는 태그 구조가 바뀌어도 보이는 인증 표시는 같아야 한다.
function anthropicHeaderLabel(html, model) {
  const text = html.replace(/<[^>]*>/g, "");
  return text.match(new RegExp(`(Anthropic(?: subscription| API)?) · ${model.replaceAll(".", "\\.")}`))?.[1];
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

function renderTool(toolName, input, result, message = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-test",
          content: [{ type: "toolCall", toolCallId: "call-1", toolName, input }],
          ...message,
        },
        toolResults: result ? new Map([["call-1", { role: "toolResult", toolCallId: "call-1", ...result }]]) : undefined,
      }),
    ),
  );
}

test("a call still waiting for its result is shown as running, never as a success", () => {
  // 생성이 끝난 지 몇 초 지난 호출: 지연이 지났으므로 상태 단어가 보인다.
  const html = renderTool("read", { path: "lib/main.ts" }, undefined, { completedAt: Date.now() - 3_000 });

  assert.doesNotMatch(html, /is-success/);
  assert.match(html, /class="tool-call-card is-running"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Running<span class="tool-run-duration">3s<\/span>/);
});

test("a running call that just started does not flash the running word", () => {
  const html = renderTool("read", { path: "lib/main.ts" }, undefined, { completedAt: Date.now() });

  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /Running/);
});

test("a finished call shows only its duration, with no state word", () => {
  const html = renderTool(
    "read",
    { path: "lib/main.ts" },
    { content: [{ type: "text", text: "contents" }], timestamp: 1_007_000 },
    { completedAt: 1_000_000 },
  );

  assert.match(html, /class="tool-call-card is-done"/);
  assert.match(html, /<span class="tool-run-duration">7s<\/span>/);
  assert.doesNotMatch(html, /Running|Failed|aria-busy/);
});

test("collapsed bash is one row with the first command line and its state", () => {
  const html = renderTool(
    "bash",
    { command: "git status --short\necho second-line" },
    { content: [{ type: "text", text: " M components/MessageView.tsx\nCommand exited with code 0" }] },
  );

  assert.match(html, /<span class="tool-call-name">bash<\/span>/);
  assert.match(html, /class="tool-call-target"[^>]*>git status --short<\/span>/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /shell-output-preview/);
  // 접힌 줄은 본문을 그리지 않으므로 없는 id를 가리키지 않는다.
  assert.doesNotMatch(html, /aria-controls=/);
  assert.doesNotMatch(html, /components\/MessageView\.tsx/);
  assert.doesNotMatch(html, /Failed/);
});

test("a failed bash opens expanded with the failure word, exit code and output", () => {
  const html = renderTool(
    "bash",
    { command: "bun test" },
    { content: [{ type: "text", text: "1 fail\nCommand exited with code 1" }], isError: true },
  );

  assert.match(html, /class="tool-call-card is-error is-shell"/);
  assert.match(html, />Failed</);
  assert.match(html, /exit 1/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /class="shell-output-preview is-error"/);
  // 실패는 배지와 종료 코드로만 말한다. 종류 아이콘은 중립 잉크 그대로다.
  assert.match(html, /data-tool-icon="bash" style="[^"]*color:var\(--text-muted\)/);
  assert.doesNotMatch(html, /data-tool-icon="bash" style="[^"]*color:var\(--danger\)/);
  assert.match(html, /1 fail/);
  const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
  assert.ok(controls && html.includes(`id="${controls}"`), "the row controls the expanded body");
});

test("a nonzero exit counts as failed even when the result is not flagged as an error", () => {
  const html = renderTool("bash", { command: "false" }, { content: [{ type: "text", text: "Command exited with code 2" }] });

  assert.match(html, />Failed</);
  assert.match(html, /exit 2/);
});

test("an edit row starts collapsed and shows its line counts", () => {
  const html = renderTool(
    "edit",
    { i: "Fixing the header", path: "components/MessageView.tsx" },
    { content: [{ type: "text", text: "ok" }], details: { diff: "--- a\n+++ b\n-old line\n+new line\n+another line" } },
  );

  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="2 lines added, 1 lines removed"/);
  assert.match(html, />\+2<\/span>/);
  assert.match(html, />−1<\/span>/);
  assert.doesNotMatch(html, /new line/);
});

test("a path target keeps its filename by trimming from the front", () => {
  const html = renderTool("unknown_tool", { path: "components/workspace/ProcessLogPanel.tsx" });

  assert.match(html, /class="tool-call-target is-path"[^>]*><bdi dir="ltr">components\/workspace\/ProcessLogPanel\.tsx<\/bdi>/);
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

test("shows a neutral operation icon beside every standard tool label", () => {
  const cases = [
    ["read", "read"],
    ["write", "write"],
    ["glob", "glob"],
    ["grep", "grep"],
    ["edit", "edit"],
    ["eval", "eval"],
    ["functions.task", "task"],
    ["unknown_tool", "generic"],
  ];

  for (const [toolName, iconKind] of cases) {
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
    assert.ok(html.slice(iconPosition, iconEnd).includes("color:var(--text-muted)"), `expected ${toolName} icon in neutral ink`);
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

test("an Anthropic answer says subscription or API only from the credential kind recorded on that response", () => {
  const answer = (usage) => renderMessage({
    role: "assistant", provider: "anthropic", model: "claude-opus-5-5", content: [{ type: "text", text: "답" }], stopReason: "stop",
    ...(usage ? { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage } } : {}),
  });
  assert.equal(anthropicHeaderLabel(answer({ credentialKind: "oauth" }), "claude-opus-5-5"), "Anthropic subscription");
  assert.equal(anthropicHeaderLabel(answer({ credentialKind: "api-key" }), "claude-opus-5-5"), "Anthropic API");
  for (const old of [answer(undefined), answer({}), answer({ credentialKind: "Api-Key" })]) {
    assert.equal(anthropicHeaderLabel(old, "claude-opus-5-5"), "Anthropic", "a record without a known credential kind keeps the plain provider name");
  }
  const codex = renderMessage(liveAnswer({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, credentialKind: "api-key", cost: { total: 0 } } }));
  assert.ok(codex.replace(/<[^>]*>/g, "").includes("OpenAI Codex · Codex Live"), "other providers ignore the field");
  assert.equal(anthropicHeaderLabel(codex, "Codex Live"), undefined);
});

test("a reloaded session file shows each Anthropic answer with its own recorded credential kind", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildSessionContext, getSessionEntries } = await jiti.import("../lib/session-reader.ts");
  const dir = mkdtempSync(join(tmpdir(), "cuelo-credential-kind-"));
  try {
    const filePath = join(dir, "session.jsonl");
    const usage = (kind) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...(kind ? { credentialKind: kind } : {}) });
    const reply = (id, parentId, kind) => ({ type: "message", id, parentId, timestamp: "2026-10-29T00:00:00.000Z",
      message: { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5-5",
        content: [{ type: "text", text: id }], stopReason: "stop", usage: usage(kind) } });
    const ask = (id, parentId) => ({ type: "message", id, parentId, timestamp: "2026-10-29T00:00:00.000Z", message: { role: "user", content: id } });
    writeFileSync(filePath, [
      { type: "session", version: 3, id: "credential-kind", timestamp: "2026-10-29T00:00:00.000Z", cwd: "" },
      ask("u1", null), reply("a1", "u1", "oauth"), ask("u2", "a1"), reply("a2", "u2", "api-key"), ask("u3", "a2"), reply("a3", "u3", null),
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    const { messages } = buildSessionContext(await getSessionEntries(filePath), undefined, { deferThinking: true, deferToolResultImages: true });
    const labels = messages.filter((message) => message.role === "assistant")
      .map((message) => anthropicHeaderLabel(renderMessage(message), "claude-opus-5-5"));
    assert.deepEqual(labels, ["Anthropic subscription", "Anthropic API", "Anthropic"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
