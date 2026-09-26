import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { mergeSessionSnapshotEvent, useAgentSession } = await jiti.import("./useAgentSession.ts");

test("applies a session snapshot once, preserves optimistic input, and isolates sessions", () => {
  const persistedUser = { role: "user", content: "질문", timestamp: 1 };
  const reply = {
    role: "assistant",
    content: [{ type: "text", text: "시온 답변" }],
    provider: "web6",
    model: "web6",
    stopReason: "stop",
    timestamp: 2,
  };
  const optimistic = { role: "user", content: "아직 저장 전", timestamp: 3 };
  const event = {
    type: "session_snapshot",
    sessionId: "session-a",
    entryId: "reply-1",
    context: {
      messages: [persistedUser, reply],
      entryIds: ["user-1", "reply-1"],
    },
  };

  assert.equal(
    mergeSessionSnapshotEvent(event, "session-b", "user-1", [persistedUser], ["user-1"]),
    null,
    "다른 세션 frame은 섞이지 않는다",
  );
  const merged = mergeSessionSnapshotEvent(
    event,
    "session-a",
    "user-1",
    [persistedUser, optimistic],
    ["user-1"],
  );
  assert.deepEqual(merged, {
    entryId: "reply-1",
    messages: [persistedUser, reply, optimistic],
    entryIds: ["user-1", "reply-1"],
  });
  assert.equal(
    mergeSessionSnapshotEvent(event, "session-a", "reply-1", merged.messages, merged.entryIds),
    null,
    "같은 stable entryId를 재전달해도 중복 표시하지 않는다",
  );
  const sameText = { role: "user", content: "같은 문장", timestamp: 4 };
  const duplicateIntent = mergeSessionSnapshotEvent(
    {
      ...event,
      entryId: "reply-2",
      context: {
        messages: [sameText, reply],
        entryIds: ["user-2", "reply-2"],
      },
    },
    "session-a",
    "user-2",
    [sameText, { ...sameText, timestamp: 5 }],
    ["user-2"],
  );
  assert.equal(
    duplicateIntent.messages.filter((message) => message.role === "user").length,
    2,
    "정본에 한 번만 있는 같은 문장의 낙관적 두 번째 전송은 합치지 않는다",
  );
});

test("preserves a distinct execution message when merging a persisted snapshot", () => {
  const persisted = { role: "bashExecution", command: "first", output: "one", exitCode: 0 };
  const pending = { role: "bashExecution", command: "second", output: "two", exitCode: 0 };
  const merged = mergeSessionSnapshotEvent({
    type: "session_snapshot",
    sessionId: "session-a",
    entryId: "bash-1",
    context: { messages: [persisted], entryIds: ["bash-1"] },
  }, "session-a", null, [pending], []);
  assert.deepEqual(merged.messages, [persisted, pending]);
});

test("server close events remove only the matching dialog and delivery state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cuelo-hook-"));
  const fakeReactPath = join(directory, "react.mjs");
  const harnessSubjectPath = join(directory, "useAgentSession.ts");
  const harnessKey = "__ompUseAgentSessionHarness";
  await writeFile(fakeReactPath, `
const harness = globalThis.${harnessKey};
export const useState = (...args) => harness.useState(...args);
export const useReducer = (...args) => harness.useReducer(...args);
export const useRef = (...args) => harness.useRef(...args);
export const useCallback = (callback) => callback;
export const useMemo = (factory) => factory();
export const useEffect = () => {};
export const useLayoutEffect = () => {};
`);
  const fakeReactUrl = pathToFileURL(fakeReactPath).href;
  const sourceRoot = new URL("../", import.meta.url);
  const harnessSource = source
    .replace('from "react";', `from ${JSON.stringify(fakeReactUrl)};`)
    .replace(/from "@\/([^"]+)";/g, (_match, path) => (
      `from ${JSON.stringify(new URL(path, sourceRoot).href)};`
    ));
  await writeFile(harnessSubjectPath, harnessSource);
  const originalHarness = globalThis[harnessKey];
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    if (originalHarness === undefined) delete globalThis[harnessKey];
    else globalThis[harnessKey] = originalHarness;
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  });

  const state = [];
  const reducers = [];
  const refs = [];
  let stateIndex = 0;
  let reducerIndex = 0;
  let refIndex = 0;
  const harness = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (value) => {
        state[index] = typeof value === "function" ? value(state[index]) : value;
      }];
    },
    useReducer(reducer, initial) {
      const index = reducerIndex++;
      if (!(index in reducers)) reducers[index] = initial;
      return [reducers[index], (action) => {
        reducers[index] = reducer(reducers[index], action);
      }];
    },
    useRef(initial) {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
  };
  globalThis[harnessKey] = harness;

  const harnessJiti = createJiti(import.meta.url, {
    jsx: { runtime: "automatic" },
    moduleCache: false,
    tsconfigPaths: true,
  });
  const { useAgentSession: useHarnessedAgentSession } = await harnessJiti.import(harnessSubjectPath);
  const sessionData = {
    sessionId: "session-id",
    filePath: "/tmp/session.jsonl",
    totalActiveMs: 0,
    tree: [],
    leafId: null,
    context: {
      messages: [],
      entryIds: [],
      thinkingLevel: "off",
      model: null,
    },
  };
  const useRenderedSession = () => {
    stateIndex = 0;
    reducerIndex = 0;
    refIndex = 0;
    return useHarnessedAgentSession({
      session: { id: "session-id", name: "Test", cwd: "/tmp" },
      newSessionCwd: null,
      initialData: sessionData,
    });
  };
  const finishResponses = [];
  globalThis.fetch = async () => {
    await new Promise((resolve) => {
      finishResponses.push(resolve);
    });
    return new Response(
      JSON.stringify({ success: true, data: null }),
      { headers: { "Content-Type": "application/json" } },
    );
  };

  let hook = useRenderedSession();
  const oldRequest = {
    type: "extension_ui_request",
    id: "old-dialog",
    method: "ask",
    questions: [{ id: "direction", question: "Continue?", options: [{ label: "Continue" }] }],
  };
  const newRequest = { ...oldRequest, id: "new-dialog" };
  hook.handleAgentEventRef.current(oldRequest);
  hook = useRenderedSession();
  assert.equal(hook.extensionDialog.id, oldRequest.id);

  const response = hook.respondToExtensionUi(oldRequest, { value: JSON.stringify({ kind: "chat" }) });
  hook = useRenderedSession();
  assert.deepEqual(hook.extensionResponse, { id: oldRequest.id, status: "sending" });
  hook.handleAgentEventRef.current(newRequest);
  hook = useRenderedSession();
  assert.equal(hook.extensionDialog.id, newRequest.id);

  hook.handleAgentEventRef.current({ ...oldRequest, closed: true });
  hook = useRenderedSession();
  assert.equal(hook.extensionDialog.id, newRequest.id);
  assert.equal(hook.extensionResponse, null);

  hook.handleAgentEventRef.current({ ...newRequest, closed: true });
  hook = useRenderedSession();
  assert.equal(hook.extensionDialog, null);
  const customRequest = {
    type: "extension_ui_request",
    id: "custom-dialog",
    method: "custom",
    lines: ["Custom content"],
  };
  hook.handleAgentEventRef.current(customRequest);
  hook = useRenderedSession();
  assert.equal(hook.extensionCustomUi.id, customRequest.id);
  hook.handleAgentEventRef.current({ ...customRequest, lines: [], closed: true });
  hook = useRenderedSession();
  assert.equal(hook.extensionCustomUi, null);

  const completed = {
    role: "assistant",
    content: [{ type: "text", text: "먼저 끝난 답" }],
    provider: "openai-codex",
    model: "gpt",
    stopReason: "stop",
    timestamp: 10,
  };
  const shionReply = {
    role: "assistant",
    content: [{ type: "text", text: "연이어 도착한 시온 답" }],
    provider: "web6",
    model: "web6",
    stopReason: "stop",
    timestamp: 11,
  };
  hook.handleAgentEventRef.current({ type: "agent_start" });
  hook.handleAgentEventRef.current({ type: "message_end", message: completed });
  hook.handleAgentEventRef.current({
    type: "session_snapshot",
    sessionId: "session-id",
    entryId: "shion-1",
    context: {
      messages: [completed, shionReply],
      entryIds: ["assistant-1", "shion-1"],
    },
  });
  hook = useRenderedSession();
  assert.deepEqual(
    hook.messages,
    [completed, shionReply],
    "같은 render 사이의 message_end를 snapshot이 stale closure로 잃지 않는다",
  );

  const streaming = {
    role: "assistant",
    content: [{ type: "text", text: "진행 중" }],
    provider: "openai-codex",
    model: "gpt",
    timestamp: 12,
  };
  hook.handleAgentEventRef.current({ type: "agent_start" });
  hook.handleAgentEventRef.current({ type: "message_update", message: streaming });
  hook.handleAgentEventRef.current({
    type: "session_snapshot",
    sessionId: "session-id",
    entryId: "shion-2",
    context: {
      messages: [completed, shionReply],
      entryIds: ["assistant-1", "shion-2"],
    },
  });
  hook = useRenderedSession();
  assert.equal(hook.streamState.isStreaming, true);
  assert.deepEqual(
    hook.streamState.streamingMessage,
    streaming,
    "외부 reply snapshot은 기존 streaming bubble 상태를 건드리지 않는다",
  );


  for (const finishResponse of finishResponses) finishResponse();
  await response;
});

test("distinguishes an ambiguous transport failure from an explicit maintenance rejection", async (t) => {
  const originalEventSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalConsoleError = console.error;
  t.after(() => {
    if (originalEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalEventSource;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    console.error = originalConsoleError;
  });

  const eventSources = [];
  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    constructor(url) {
      this.url = url;
      this.readyState = FakeEventSource.CONNECTING;
      this.onmessage = null;
      this.onerror = null;
      eventSources.push(this);
    }

    emit(event) {
      if (event.type === "connected") this.readyState = FakeEventSource.OPEN;
      this.onmessage?.({ data: JSON.stringify(event) });
    }

    close() {
      this.readyState = FakeEventSource.CLOSED;
    }
  }

  globalThis.EventSource = FakeEventSource;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    timer.unref?.();
    return timer;
  };
  console.error = () => {};

  const sessionData = {
    sessionId: "session-id",
    filePath: "/tmp/session.jsonl",
    totalActiveMs: 0,
    tree: [],
    leafId: null,
    context: {
      messages: [],
      entryIds: [],
      thinkingLevel: "off",
      model: null,
    },
  };
  const promptBodies = [];
  let maintenanceRejectionsRemaining = 1;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      promptBodies.push(body);
      if (body.message === "inspect this") throw new TypeError("connection reset after dispatch");
      if (body.message === "blocked by maintenance" && maintenanceRejectionsRemaining > 0) {
        maintenanceRejectionsRemaining -= 1;
        return new Response(
          JSON.stringify({
            error: "CUELO update CUTOVER",
            code: "update_draining",
            accepted: false,
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ success: true, data: null }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith("/api/sessions/session-id?")) {
      return new Response(
        JSON.stringify(sessionData),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  let hook;
  let restores = 0;
  const completions = [];
  function Harness() {
    hook = useAgentSession({
      session: { id: "session-id", name: "Test", cwd: "/tmp" },
      newSessionCwd: null,
      initialData: sessionData,
      chatInputRef: {
        current: {
          restoreSubmission: () => {
            restores += 1;
          },
        },
      },
      onAgentEnd: (completion) => {
        completions.push(completion);
      },
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  const firstSend = hook.handleSend(
    "inspect this",
    [{ data: "AQID", mimeType: "image/png", previewUrl: "blob:test" }],
  );
  assert.equal(eventSources.length, 1);
  eventSources[0].emit({ type: "connected" });
  await firstSend;

  assert.equal(promptBodies.length, 1);
  assert.deepEqual(promptBodies[0].images, [
    { type: "image", data: "AQID", mimeType: "image/png" },
  ]);
  assert.equal(restores, 0);

  await hook.handleSend("must not dispatch while unsettled");
  assert.equal(promptBodies.length, 1);

  hook.handleAgentEventRef.current({ type: "prompt_done" });
  await hook.handleSend("send this next");

  assert.deepEqual(promptBodies.map(({ message }) => message), [
    "inspect this",
    "send this next",
  ]);
  assert.deepEqual(completions, [{ outcome: "unknown", sessionId: "session-id" }]);
  hook.handleAgentEventRef.current({ type: "prompt_error", errorMessage: "provider failed" });
  hook.handleAgentEventRef.current({ type: "prompt_done" });
  assert.deepEqual(completions[1], { outcome: "failed", sessionId: "session-id" });

  await hook.handleSend("blocked by maintenance");
  assert.equal(restores, 1);

  const retry = hook.handleSend("blocked by maintenance");
  assert.equal(eventSources.length, 2);
  eventSources[1].emit({ type: "connected" });
  await retry;
  assert.deepEqual(promptBodies.map(({ message }) => message), [
    "inspect this",
    "send this next",
    "blocked by maintenance",
    "blocked by maintenance",
  ]);
  hook.handleAgentEventRef.current({ type: "prompt_error", errorMessage: "retrying" });
  hook.handleAgentEventRef.current({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
      provider: "openai-codex",
      model: "gpt",
      credentialId: 8,
      stopReason: "stop",
    },
  });
  hook.handleAgentEventRef.current({ type: "prompt_done" });
  assert.deepEqual(completions[2], {
    outcome: "completed",
    sessionId: "session-id",
    provider: "openai-codex",
    credentialId: 8,
  });
});

/**
 * 실제 훅을 effect까지 돌리는 최소 React 대역. 상태가 바뀌면 microtask에서 다시 그리고, deps가
 * 바뀐 effect만 cleanup 뒤 다시 실행한다. effect가 붙인 listener로만 드러나는 동작을 브라우저
 * 없이 확인하는 데 쓴다.
 */
function createEffectRenderer() {
  let cells = [];
  let cursor = 0;
  let pending = [];
  let render = null;
  let scheduled = false;
  const sameDeps = (previous, next) => Array.isArray(previous) && Array.isArray(next)
    && previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
  const schedule = () => {
    if (scheduled || !render) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render?.();
    });
  };
  const cell = (create) => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = create();
    return cells[index];
  };
  const react = {
    useState(initial) {
      const state = cell(() => ({ value: typeof initial === "function" ? initial() : initial }));
      state.set ??= (next) => {
        const value = typeof next === "function" ? next(state.value) : next;
        if (Object.is(value, state.value)) return;
        state.value = value;
        schedule();
      };
      return [state.value, state.set];
    },
    useReducer(reducer, initial) {
      const state = cell(() => ({ value: initial }));
      state.reducer = reducer;
      state.dispatch ??= (action) => {
        const value = state.reducer(state.value, action);
        if (Object.is(value, state.value)) return;
        state.value = value;
        schedule();
      };
      return [state.value, state.dispatch];
    },
    useRef: (initial) => cell(() => ({ current: initial })),
    useCallback(callback, deps) {
      const memo = cell(() => ({}));
      if (!sameDeps(memo.deps, deps)) Object.assign(memo, { value: callback, deps });
      return memo.value;
    },
    useMemo(factory, deps) {
      const memo = cell(() => ({}));
      if (!sameDeps(memo.deps, deps)) Object.assign(memo, { value: factory(), deps });
      return memo.value;
    },
    useEffect(effect, deps) {
      const slot = cell(() => ({ effect: true }));
      if (deps !== undefined && sameDeps(slot.deps, deps)) return;
      slot.deps = deps;
      pending.push(() => {
        slot.cleanup?.();
        const cleanup = effect();
        slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      });
    },
  };
  return {
    react,
    mount(renderComponent) {
      render = () => {
        cursor = 0;
        pending = [];
        renderComponent();
        const effects = pending;
        pending = [];
        for (const run of effects) run();
      };
      render();
    },
    rerender: () => render?.(),
    unmount() {
      render = null;
      for (const slot of cells) if (slot?.effect) slot.cleanup?.();
      cells = [];
    },
  };
}

// 2026-09-23 사용자 관측: Wake로 세션은 재개됐는데 보고 있던 탭에는 응답이 안 떠 F5가 필요했다.
// 복귀 화면은 idle transcript를 읽은 뒤 붙고, Wake run은 그 뒤 서버에서 시작된다.
// 평소 30~70ms지만 CI 러너가 느린 순간(옆 테스트까지 70~125배 느려진 run 36149916815)에는 기본 5초를
// 넘겼다. 시간이 지나면 t.after가 돌지 않아 바꿔 둔 window가 남고 useAudio 테스트까지 연달아 깨지므로
// 제한을 넉넉히 둔다.
test("서버에서 시작된 run을 유휴 화면이 새로고침 없이 한 번만 보여 준다 (업데이트 복귀·grace 뒤 후속 run)", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cuelo-hook-wake-"));
  const rendererKey = "__ompUseAgentSessionEffectRenderer";
  const fakeReactPath = join(directory, "react.mjs");
  await writeFile(fakeReactPath, [
    `const react = () => globalThis.${rendererKey}.react;`,
    ...["useState", "useReducer", "useRef", "useCallback", "useMemo", "useEffect"]
      .map((name) => `export const ${name} = (...args) => react().${name}(...args);`),
    "export const useLayoutEffect = (...args) => react().useEffect(...args);",
  ].join("\n"));
  const sourceRoot = new URL("../", import.meta.url);
  const subjectPath = join(directory, "useAgentSession.ts");
  await writeFile(subjectPath, source
    .replace('from "react";', `from ${JSON.stringify(pathToFileURL(fakeReactPath).href)};`)
    .replace(/from "@\/([^"]+)";/g, (_match, path) => `from ${JSON.stringify(new URL(path, sourceRoot).href)};`));
  const harnessJiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, moduleCache: false, tsconfigPaths: true });
  const { useAgentSession: useHarnessedAgentSession } = await harnessJiti.import(subjectPath);
  const { confirmUpdateResume } = await harnessJiti.import(new URL("../lib/update-maintenance-client.ts", import.meta.url).href);

  const globalKeys = ["window", "document", "sessionStorage", "EventSource", "fetch", "setTimeout", "setInterval", rendererKey];
  const originals = Object.fromEntries(globalKeys.map((key) => [key, globalThis[key]]));
  t.after(async () => {
    for (const key of globalKeys) {
      if (originals[key] === undefined) delete globalThis[key];
      else globalThis[key] = originals[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = originals.setTimeout(callback, ms, ...args);
    timer.unref?.();
    return timer;
  };
  globalThis.setInterval = (callback, ms, ...args) => {
    const timer = originals.setInterval(callback, ms, ...args);
    timer.unref?.();
    return timer;
  };
  const sources = [];
  globalThis.EventSource = class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onmessage = null;
      this.onerror = null;
      sources.push(this);
    }
    emit(event) {
      if (event.type === "connected") this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify(event) });
    }
    close() {
      this.readyState = 2;
    }
  };
  globalThis.window = Object.assign(new EventTarget(), { location: { pathname: "/", search: "", hash: "" } });
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible", title: "" });
  const storage = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };

  const sessionData = (id, messages) => ({
    sessionId: id,
    filePath: `/tmp/${id}.jsonl`,
    totalActiveMs: 0,
    tree: [],
    leafId: messages.length ? `${id}-${messages.length}` : null,
    context: { messages, entryIds: messages.map((_message, index) => `${id}-${index + 1}`), thinkingLevel: "off", model: null },
  });
  const liveState = (flags = {}) => ({
    running: true,
    state: { isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, isHandoffRunning: false, ...flags },
  });
  // 서버 대역: 세션별 현재 transcript·상태, 한 번만 먼저 돌려줄 오래된 transcript, 응답을 붙잡는 gate.
  const server = { transcripts: new Map(), staleTranscripts: new Map(), gates: new Map(), states: new Map(), wake: null };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (init.method === "POST" && url === "/api/update-maintenance") {
      return json({ schemaVersion: 2, resumed: true, wake: server.wake });
    }
    const transcript = url.match(/^\/api\/sessions\/([^/?]+)\?deferThinking=1&deferMedia=1$/);
    if (transcript) {
      const id = decodeURIComponent(transcript[1]);
      // confirmUpdateResume의 세션 신원 확인은 no-store로 온다. 화면의 transcript 읽기만 붙잡는다.
      if (init.cache === "no-store") return json(sessionData(id, server.transcripts.get(id) ?? []));
      await server.gates.get(id);
      return json(sessionData(id, server.staleTranscripts.get(id)?.shift() ?? server.transcripts.get(id) ?? []));
    }
    const state = url.match(/^\/api\/(?:sessions\/([^/?]+)\/state|agent\/([^/?]+))$/);
    if (state) return json(server.states.get(decodeURIComponent(state[1] ?? state[2])) ?? { running: false });
    return json({ error: "not found" }, 404);
  };

  const renderer = createEffectRenderer();
  globalThis[rendererKey] = renderer;
  const completions = [];
  let props;
  let hook;
  const sessionProps = (id, messages) => ({
    session: { id, name: "Test", cwd: "/tmp" },
    newSessionCwd: null,
    initialData: sessionData(id, messages),
    onAgentEnd: (completion) => completions.push(completion),
  });
  const mount = (id, messages) => {
    props = sessionProps(id, messages);
    renderer.mount(() => {
      hook = useHarnessedAgentSession(props);
    });
  };
  const settle = async () => {
    for (let round = 0; round < 30; round += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const requestId = "a".repeat(32);
  const stageHash = "b".repeat(64);
  const intentFor = (sessionId) => ({
    schemaVersion: 2, requestId, stageHash, clientId: "client_wake_hook_00000000", sessionId, resumeUrl: `/?session=${sessionId}`,
  });
  const SESSION = "11111111-2222-4333-8444-555555555555";
  const OTHER_SESSION = "99999999-8888-4777-8666-555555555555";
  const mainStream = (id) => sources.find((source) => source.url === `/api/agent/${id}/events`);
  const history = [
    { role: "user", content: "업데이트 해 줘", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "업데이트를 시작했어요" }], provider: "openai-codex", model: "gpt", stopReason: "stop", timestamp: 2 },
  ];
  const wakePrompt = { role: "user", content: "[하네스 통지] 업데이트가 끝나 이 세션이 재개됐습니다.", timestamp: 3 };
  const wakeReply = {
    role: "assistant", content: [{ type: "text", text: "업데이트 뒤 하던 일을 이어 갈게요" }], provider: "openai-codex", model: "gpt", stopReason: "stop", timestamp: 4,
  };

  // 1) 복귀 확인 응답이 올 때 Wake는 실행 중이다: 그 run에 붙어 스트림으로 끝까지 따라간다.
  server.transcripts.set(SESSION, history);
  server.states.set(SESSION, { running: false });
  mount(SESSION, history);
  await settle();
  assert.equal(hook.agentRunning, false);
  server.transcripts.set(SESSION, [...history, wakePrompt]);
  server.states.set(SESSION, liveState({ isPromptRunning: true }));
  server.wake = { wake: true, requestId, stageHash, sessionId: SESSION };
  await confirmUpdateResume(intentFor(SESSION));
  await settle();
  assert.equal(hook.agentRunning, true, "F5·탭 전환·추가 입력 없이 서버에서 시작된 Wake run에 붙는다");
  const stream = mainStream(SESSION);
  assert.ok(stream, "그 세션의 주 이벤트 스트림을 연다");
  stream.emit({ type: "connected", sessionId: SESSION });
  stream.emit({ type: "agent_start" });
  stream.emit({ type: "message_update", message: { ...wakeReply, content: [{ type: "text", text: "업데이트 뒤" }], stopReason: undefined } });
  await settle();
  assert.equal(hook.streamState.isStreaming, true);
  server.transcripts.set(SESSION, [...history, wakePrompt, wakeReply]);
  server.states.set(SESSION, liveState());
  stream.emit({ type: "message_end", message: wakeReply });
  // 실제 순서: agent_end → agent_settled → (inner.prompt settle 뒤) prompt_done.
  stream.emit({ type: "agent_end" });
  stream.emit({ type: "agent_settled" });
  stream.emit({ type: "prompt_done" });
  await settle();
  assert.deepEqual(hook.messages, [...history, wakePrompt, wakeReply], "Wake 응답이 한 번만 보인다");
  assert.equal(hook.agentRunning, false);
  assert.equal(completions.length, 1);
  renderer.unmount();

  // 2) 두 번째 복귀 탭(already-claimed): 짧은 Wake가 확인 전에 끝났다. 붙기 전에 읽은 transcript는
  //    끝나기 직전 것이고, 이어진 상태 읽기는 idle을 본다.
  sources.length = 0;
  const shortReply = { ...wakeReply, content: [{ type: "text", text: "짧게 끝난 Wake 응답" }], timestamp: 5 };
  server.transcripts.set(SESSION, history);
  server.states.set(SESSION, { running: false });
  mount(SESSION, history);
  await settle();
  server.staleTranscripts.set(SESSION, [[...history, wakePrompt]]);
  server.transcripts.set(SESSION, [...history, wakePrompt, shortReply]);
  server.states.set(SESSION, liveState());
  server.wake = { wake: false, reason: "already-claimed" };
  await confirmUpdateResume(intentFor(SESSION));
  await settle();
  assert.deepEqual(hook.messages, [...history, wakePrompt, shortReply], "이미 끝난 짧은 Wake 응답도 놓치지 않고 한 번만 보인다");
  assert.equal(hook.agentRunning, false);
  assert.equal(mainStream(SESSION), undefined, "끝난 run에는 스트림을 붙이지 않는다");
  renderer.unmount();

  // 3) 신호 뒤 이전 세션의 읽기가 늦게 끝나는 사이 다른 세션으로 옮겼다: 새 화면을 덮지 않는다.
  sources.length = 0;
  const otherHistory = [{ role: "user", content: "다른 세션의 대화", timestamp: 1 }];
  server.transcripts.set(SESSION, history);
  server.states.set(SESSION, { running: false });
  server.transcripts.set(OTHER_SESSION, otherHistory);
  server.states.set(OTHER_SESSION, { running: false });
  mount(SESSION, history);
  await settle();
  let releaseLateRead;
  server.gates.set(SESSION, new Promise((resolve) => {
    releaseLateRead = resolve;
  }));
  server.transcripts.set(SESSION, [...history, wakePrompt, wakeReply]);
  server.states.set(SESSION, liveState({ isPromptRunning: true }));
  server.wake = { wake: true, requestId, stageHash, sessionId: SESSION };
  await confirmUpdateResume(intentFor(SESSION));
  props = sessionProps(OTHER_SESSION, otherHistory);
  renderer.rerender();
  await settle();
  releaseLateRead();
  await settle();
  await confirmUpdateResume(intentFor(SESSION));
  await settle();
  assert.deepEqual(hook.messages, otherHistory, "이전 세션의 늦은 Wake 응답이 새 세션 화면을 덮지 않는다");
  assert.equal(hook.agentRunning, false);
  assert.equal(mainStream(SESSION), undefined);
  renderer.unmount();

  // 2026-09-26 사용자 관측: 턴이 끝나고(스티커가 뜬 뒤) 서버가 이어서 시작한 run이 F5 전까지 안 보였다.
  // 주 스트림은 idle grace 뒤 닫히고, 선택된 화면에 남는 것은 entries 스트림뿐이다.
  const entriesStream = (id) => sources.find((source) => source.url === `/api/agent/${id}/events?entries=1`);
  const mainStreams = (id) => sources.filter((source) => source.url === `/api/agent/${id}/events`);
  const followPrompt = { role: "user", content: "[백그라운드 결과] 작업이 끝났습니다.", timestamp: 6 };
  const followReply = {
    role: "assistant", content: [{ type: "text", text: "결과를 받아 이어서 정리할게요" }], provider: "openai-codex", model: "gpt", stopReason: "stop", timestamp: 7,
  };

  // 4) 오래 도는 후속 run: 그 run에 붙고, 같은 시작 신호가 더 와도 주 스트림은 하나다.
  sources.length = 0;
  server.wake = null;
  server.transcripts.set(SESSION, history);
  server.states.set(SESSION, { running: false });
  mount(SESSION, history);
  await settle();
  const entries = entriesStream(SESSION);
  assert.ok(entries, "선택된 화면은 entries 스트림을 열어 둔다");
  assert.equal(mainStreams(SESSION).length, 0, "유휴 화면에는 주 스트림이 없다");
  server.transcripts.set(SESSION, [...history, followPrompt]);
  server.states.set(SESSION, liveState({ isStreaming: true }));
  entries.emit({ type: "connected", sessionId: SESSION });
  entries.emit({ type: "agent_start" });
  entries.emit({ type: "agent_start" });
  await settle();
  assert.equal(hook.agentRunning, true, "F5 없이 서버가 시작한 후속 run에 붙는다");
  assert.equal(mainStreams(SESSION).length, 1, "겹친 시작 신호가 주 스트림을 두 번 열지 않는다");
  entries.emit({ type: "agent_start" });
  await settle();
  assert.equal(mainStreams(SESSION).length, 1, "이미 붙은 run의 시작 신호는 무시한다");
  const follow = mainStreams(SESSION)[0];
  follow.emit({ type: "connected", sessionId: SESSION });
  server.transcripts.set(SESSION, [...history, followPrompt, followReply]);
  server.states.set(SESSION, liveState());
  follow.emit({ type: "message_end", message: followReply });
  follow.emit({ type: "agent_end" });
  follow.emit({ type: "agent_settled" });
  follow.emit({ type: "prompt_done" });
  await settle();
  assert.deepEqual(hook.messages, [...history, followPrompt, followReply], "후속 응답이 한 번만 보인다");
  assert.equal(hook.agentRunning, false);
  renderer.unmount();

  // 5) 짧은 후속 run: 붙기 전에 끝났다. 먼저 읽힌 transcript가 끝나기 전 것이어도 끝난 내용을 보인다.
  sources.length = 0;
  const shortFollow = { ...followReply, content: [{ type: "text", text: "짧게 끝난 후속 응답" }], timestamp: 8 };
  server.transcripts.set(SESSION, history);
  server.states.set(SESSION, { running: false });
  mount(SESSION, history);
  await settle();
  server.staleTranscripts.set(SESSION, [[...history, followPrompt]]);
  server.transcripts.set(SESSION, [...history, followPrompt, shortFollow]);
  server.states.set(SESSION, liveState());
  entriesStream(SESSION).emit({ type: "agent_start" });
  await settle();
  assert.deepEqual(hook.messages, [...history, followPrompt, shortFollow], "이미 끝난 짧은 후속 응답도 F5 없이 보인다");
  assert.equal(hook.agentRunning, false);
  assert.equal(mainStreams(SESSION).length, 0, "끝난 run에는 주 스트림을 붙이지 않는다");
  renderer.unmount();

  // 6) 다른 세션으로 옮긴 뒤 이전 세션의 늦은 시작 신호는 새 화면을 건드리지 않는다.
  sources.length = 0;
  server.transcripts.set(SESSION, history);
  server.states.set(SESSION, { running: false });
  server.transcripts.set(OTHER_SESSION, otherHistory);
  server.states.set(OTHER_SESSION, { running: false });
  mount(SESSION, history);
  await settle();
  const previousEntries = entriesStream(SESSION);
  props = sessionProps(OTHER_SESSION, otherHistory);
  renderer.rerender();
  await settle();
  assert.equal(previousEntries.readyState, 2, "화면을 옮기면 이전 세션의 entries 스트림을 닫는다");
  server.transcripts.set(SESSION, [...history, followPrompt]);
  server.states.set(SESSION, liveState({ isStreaming: true }));
  previousEntries.emit({ type: "agent_start" });
  await settle();
  assert.deepEqual(hook.messages, otherHistory, "이전 세션의 run이 새 세션 화면을 덮지 않는다");
  assert.equal(hook.agentRunning, false);
  assert.equal(mainStreams(SESSION).length, 0);
  renderer.unmount();
});

// 2026-09-26: 마지막 응답의 message_end를 놓친 턴은 prompt_done·agent_settled가 세션 재로드를 기다리지
// 않고 판정해 "unknown"(캐릭터 큐 대신 중립음)이 됐다. 재로드 뒤 이 run이 남긴 응답으로 한 번만 알린다.
test("message_end를 놓친 턴은 재로드된 이 run의 응답으로 한 번만 완료를 알린다", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cuelo-hook-completion-"));
  const rendererKey = "__ompUseAgentSessionEffectRenderer";
  const fakeReactPath = join(directory, "react.mjs");
  await writeFile(fakeReactPath, [
    `const react = () => globalThis.${rendererKey}.react;`,
    ...["useState", "useReducer", "useRef", "useCallback", "useMemo", "useEffect"]
      .map((name) => `export const ${name} = (...args) => react().${name}(...args);`),
    "export const useLayoutEffect = (...args) => react().useEffect(...args);",
  ].join("\n"));
  const sourceRoot = new URL("../", import.meta.url);
  const subjectPath = join(directory, "useAgentSession.ts");
  await writeFile(subjectPath, source
    .replace('from "react";', `from ${JSON.stringify(pathToFileURL(fakeReactPath).href)};`)
    .replace(/from "@\/([^"]+)";/g, (_match, path) => `from ${JSON.stringify(new URL(path, sourceRoot).href)};`)
    .replace(/await import\("@\/([^"]+)"\)/g, (_match, path) => `await import(${JSON.stringify(new URL(`${path}.ts`, sourceRoot).href)})`));
  const harnessJiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, moduleCache: false, tsconfigPaths: true });
  const { useAgentSession: useHarnessedAgentSession } = await harnessJiti.import(subjectPath);

  const globalKeys = ["window", "document", "sessionStorage", "EventSource", "fetch", "setTimeout", "setInterval", rendererKey];
  const originals = Object.fromEntries(globalKeys.map((key) => [key, globalThis[key]]));
  t.after(async () => {
    for (const key of globalKeys) {
      if (originals[key] === undefined) delete globalThis[key];
      else globalThis[key] = originals[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = originals.setTimeout(callback, ms, ...args);
    timer.unref?.();
    return timer;
  };
  globalThis.setInterval = (callback, ms, ...args) => {
    const timer = originals.setInterval(callback, ms, ...args);
    timer.unref?.();
    return timer;
  };
  const sources = [];
  globalThis.EventSource = class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sources.push(this);
    }
    emit(event) {
      if (event.type === "connected") this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify(event) });
    }
    close() {
      this.readyState = 2;
    }
  };
  globalThis.window = Object.assign(new EventTarget(), { location: { pathname: "/", search: "", hash: "" } });
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible", title: "" });
  const storage = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };

  const SESSION = "11111111-2222-4333-8444-555555555555";
  const OTHER_SESSION = "99999999-8888-4777-8666-555555555555";
  const sessionData = (id, messages) => ({
    sessionId: id,
    filePath: `/tmp/${id}.jsonl`,
    totalActiveMs: 0,
    tree: [],
    leafId: messages.length ? `${id}-${messages.length}` : null,
    context: { messages, entryIds: messages.map((_message, index) => `${id}-${index + 1}`), thinkingLevel: "off", model: null },
  });
  const server = { transcript: [], state: { running: false }, gate: null, failReload: false, slashOutput: [] };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const transcript = url.match(/^\/api\/sessions\/([^/?]+)\?deferThinking=1&deferMedia=1$/);
    if (transcript) {
      const id = decodeURIComponent(transcript[1]);
      await server.gate;
      if (server.failReload) return json({ error: "reload failed" }, 500);
      return json(sessionData(id, id === SESSION ? server.transcript : []));
    }
    if (init.method === "POST" && url === `/api/agent/${SESSION}`) {
      const command = JSON.parse(String(init.body));
      if (command.type === "execute_slash_command") return json({ success: true, data: { handled: true, output: server.slashOutput } });
      return json({ success: true, data: {} });
    }
    if (/^\/api\/(?:sessions\/[^/?]+\/state|agent\/[^/?]+)$/.test(url)) return json(server.state);
    return json({ success: true, data: {} });
  };

  const renderer = createEffectRenderer();
  globalThis[rendererKey] = renderer;
  const settle = async () => {
    for (let round = 0; round < 30; round += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const running = (flags) => ({
    running: true,
    state: { isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, isHandoffRunning: false, ...flags },
  });
  const user = { role: "user", content: "폰에서 눌러 봐", timestamp: 1 };
  const toolTurn = {
    role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
    provider: "anthropic", model: "claude-opus-5-5", credentialId: 11, stopReason: "toolUse", timestamp: 2,
  };
  const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 };
  const finalReply = {
    role: "assistant", content: [{ type: "text", text: "확인했어요." }],
    provider: "anthropic", model: "claude-opus-5-5", credentialId: 11, stopReason: "stop", timestamp: 4,
  };
  const MIO_DONE = { outcome: "completed", sessionId: SESSION, provider: "anthropic", credentialId: 11 };

  let props;
  let hook;
  let completions;
  const mount = (transcript, state) => {
    sources.length = 0;
    completions = [];
    server.transcript = transcript;
    server.state = state;
    props = {
      session: { id: SESSION, name: "Test", cwd: "/tmp" },
      newSessionCwd: null,
      initialData: sessionData(SESSION, transcript),
      onAgentEnd: (completion) => completions.push(completion),
    };
    renderer.mount(() => {
      hook = useHarnessedAgentSession(props);
    });
  };
  const mainStream = () => sources.find((source) => source.url === `/api/agent/${SESSION}/events`);
  // 탭이 실행 중인 run에 붙은 뒤 마지막 응답의 조각만 받고 message_end는 받지 못한다.
  const adoptAndStreamWithoutEnd = async (state) => {
    mount([user, toolTurn, toolResult], state);
    await settle();
    assert.equal(hook.agentRunning, true);
    mainStream().emit({ type: "connected", sessionId: SESSION });
    mainStream().emit({ type: "message_update", message: { ...finalReply, stopReason: undefined } });
    await settle();
  };

  // 1) 새로고침 중 이어받은 prompt run: prompt_done이 판정한다.
  await adoptAndStreamWithoutEnd(running({ isStreaming: true, isPromptRunning: true }));
  server.transcript = [user, toolTurn, toolResult, finalReply];
  server.state = { running: false };
  for (const type of ["agent_end", "agent_settled", "prompt_done"]) mainStream().emit({ type });
  await settle();
  assert.deepEqual(completions, [MIO_DONE], "이어받은 prompt run");
  renderer.unmount();

  // 2) 서버가 시작한 run(prompt_done 없음): agent_settled가 판정한다.
  await adoptAndStreamWithoutEnd(running({ isStreaming: true }));
  server.transcript = [user, toolTurn, toolResult, finalReply];
  server.state = { running: false };
  for (const type of ["agent_end", "agent_settled"]) mainStream().emit({ type });
  await settle();
  assert.deepEqual(completions, [MIO_DONE], "서버가 시작한 run");
  renderer.unmount();

  // 3) run 중 탭 로컬 명령 결과가 끼어든 뒤 정상 응답이 온다. 로컬 결과는 이 run의 응답을 가리지 않는다.
  await adoptAndStreamWithoutEnd(running({ isStreaming: true, isPromptRunning: true }));
  server.slashOutput = ["Fast mode is on."];
  assert.deepEqual(await hook.handleBuiltinSlashCommand("/fast status"), { handled: true });
  assert.equal(hook.messages.at(-1).role, "custom", "로컬 명령 결과가 대화에 붙는다");
  server.transcript = [user, toolTurn, toolResult, finalReply];
  server.state = { running: false };
  for (const type of ["agent_end", "agent_settled", "prompt_done"]) mainStream().emit({ type });
  await settle();
  assert.equal(hook.messages.filter((message) => message.role === "custom").length, 1, "재로드 뒤에도 로컬 결과는 한 번 남는다");
  assert.deepEqual(completions, [MIO_DONE], "로컬 명령 결과 뒤 정상 응답");
  renderer.unmount();

  // 4) 응답 없이 끝나는 명령 run: 지난 턴의 응답으로 완료를 판정하지 않는다.
  mount([user, toolTurn, toolResult, finalReply], { running: false });
  await settle();
  const send = hook.handleSend("/fast status");
  mainStream().emit({ type: "connected", sessionId: SESSION });
  await send;
  mainStream().emit({ type: "prompt_done" });
  await settle();
  assert.deepEqual(completions, [{ outcome: "unknown", sessionId: SESSION }], "응답 없는 명령 run");
  renderer.unmount();

  // 5) 재로드가 실패하면 처음 판정으로 한 번 알린다.
  await adoptAndStreamWithoutEnd(running({ isStreaming: true, isPromptRunning: true }));
  server.failReload = true;
  server.state = { running: false };
  for (const type of ["agent_end", "agent_settled", "prompt_done"]) mainStream().emit({ type });
  await settle();
  server.failReload = false;
  assert.deepEqual(completions, [{ outcome: "unknown", sessionId: SESSION }], "재로드 실패");
  renderer.unmount();

  // 6) 재로드를 기다리는 사이 새 run이 시작되면 늦은 재판정이 그 run의 값을 읽지 않는다.
  await adoptAndStreamWithoutEnd(running({ isStreaming: true, isPromptRunning: true }));
  let release;
  server.gate = new Promise((resolve) => { release = resolve; });
  server.transcript = [user, toolTurn, toolResult, finalReply];
  server.state = { running: false };
  for (const type of ["agent_end", "agent_settled", "prompt_done"]) mainStream().emit({ type });
  await settle();
  assert.deepEqual(completions, [], "재로드 전에는 알리지 않는다");
  const nextReply = { ...finalReply, content: [{ type: "text", text: "다음 run" }], timestamp: 5 };
  mainStream().emit({ type: "agent_start" });
  mainStream().emit({ type: "message_end", message: nextReply });
  server.gate = null;
  release();
  await settle();
  assert.deepEqual(completions, [{ outcome: "unknown", sessionId: SESSION }], "새 run 시작");
  renderer.unmount();

  // 7) 재로드를 기다리는 사이 다른 세션으로 옮기면 처음 판정을 원래 세션으로 한 번 알린다.
  await adoptAndStreamWithoutEnd(running({ isStreaming: true, isPromptRunning: true }));
  server.gate = new Promise((resolve) => { release = resolve; });
  server.transcript = [user, toolTurn, toolResult, finalReply];
  server.state = { running: false };
  for (const type of ["agent_end", "agent_settled", "prompt_done"]) mainStream().emit({ type });
  await settle();
  props = { ...props, session: { id: OTHER_SESSION, name: "Other", cwd: "/tmp" }, initialData: sessionData(OTHER_SESSION, []) };
  renderer.rerender();
  await settle();
  server.gate = null;
  release();
  await settle();
  assert.deepEqual(completions, [{ outcome: "unknown", sessionId: SESSION }], "세션 전환");
  renderer.unmount();
});
