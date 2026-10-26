import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// 실제 useAgentSession을 effect 없는 가짜 React로 렌더하고 SSE 이벤트를 직접 넣는다(useAgentSession.test.mjs와 같은 방식).
// 훅과 테스트가 같은 진행 저장소 인스턴스를 보도록 한 jiti(모듈 캐시 켬)로 둘 다 읽는다. 훅 인스턴스마다 상태 칸을 따로 둬
// 두 대화 창이 동시에 떠 있는 경우도 렌더한다.
async function loadSessionHook(t) {
  const directory = await mkdtemp(join(tmpdir(), "cuelo-tool-progress-"));
  const fakeReactPath = join(directory, "react.mjs");
  const subjectPath = join(directory, "useAgentSession.ts");
  const key = "__ompToolProgressHarness";
  await writeFile(fakeReactPath, `
const harness = () => globalThis[${JSON.stringify(key)}];
export const useState = (...args) => harness().useState(...args);
export const useReducer = (...args) => harness().useReducer(...args);
export const useRef = (...args) => harness().useRef(...args);
export const useCallback = (callback) => callback;
export const useMemo = (factory) => factory();
export const useEffect = () => {};
export const useLayoutEffect = () => {};
export const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();
`);
  const sourceRoot = new URL("../", import.meta.url);
  const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  await writeFile(subjectPath, source
    .replace('from "react";', `from ${JSON.stringify(pathToFileURL(fakeReactPath).href)};`)
    .replace(/from "@\/([^"]+)";/g, (_match, path) => `from ${JSON.stringify(new URL(path, sourceRoot).href)};`));
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    delete globalThis[key];
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  });
  // agent_end가 세션을 다시 읽는다. 서버는 없으므로 빈 성공으로 답한다.
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: null }), { headers: { "Content-Type": "application/json" } });
  const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
  const { useAgentSession } = await jiti.import(subjectPath);
  const store = await jiti.import(new URL("hooks/useToolProgress", sourceRoot).href);
  const mount = (firstSessionId) => {
    let sessionId = firstSessionId;
    const cells = { state: [], reducers: [], refs: [] };
    const cursor = { state: 0, reducers: 0, refs: 0 };
    const harness = {
      useState(initial) {
        const index = cursor.state++;
        if (!(index in cells.state)) cells.state[index] = typeof initial === "function" ? initial() : initial;
        return [cells.state[index], (value) => { cells.state[index] = typeof value === "function" ? value(cells.state[index]) : value; }];
      },
      useReducer(reducer, initial) {
        const index = cursor.reducers++;
        if (!(index in cells.reducers)) cells.reducers[index] = initial;
        return [cells.reducers[index], (action) => { cells.reducers[index] = reducer(cells.reducers[index], action); }];
      },
      useRef(initial) {
        const index = cursor.refs++;
        if (!(index in cells.refs)) cells.refs[index] = { current: initial };
        return cells.refs[index];
      },
    };
    let hook;
    // useAgentSession.test.mjs의 renderer.mount(() => { hook = useHarnessedAgentSession(props); })처럼 훅은 익명 렌더
    // 콜백 안에서만 부르고, 테스트 본문은 render()로 다시 그린다.
    const drawWith = (component) => () => {
      cursor.state = 0;
      cursor.reducers = 0;
      cursor.refs = 0;
      globalThis[key] = harness;
      component();
      return hook;
    };
    const render = drawWith(() => {
      hook = useAgentSession({
        session: { id: sessionId, name: "Test", cwd: "/tmp" },
        newSessionCwd: null,
        initialData: { sessionId, filePath: `/tmp/${sessionId}.jsonl`, totalActiveMs: 0, tree: [], leafId: null, context: { messages: [], entryIds: [], thinkingLevel: "off", model: null } },
      });
    });
    return {
      render,
      send: (event) => hook.handleAgentEventRef.current(event),
      // 같은 훅이 다른 세션으로 바뀐다. 가짜 React는 effect를 돌리지 않으므로 [session?.id] effect가 하는 일
      // (useAgentSession.ts의 sessionIdRef.current = session?.id)을 세션 id를 든 ref에 직접 한다. 그 뒤 render()로 다시 그린다.
      switchTo: (next) => {
        for (const ref of cells.refs) if (ref.current === sessionId) ref.current = next;
        sessionId = next;
      },
      read: (toolCallId, session = sessionId) => store.readToolProgress(store.toolProgressKey(session, toolCallId)),
    };
  };
  return { mount, store };
}

const toolCall = (id) => ({ type: "toolCall", id, name: "cross_review", arguments: {} });
const progress = (toolCallId, text) => ({ type: "tool_execution_update", toolCallId, toolName: "cross_review", text });
const start = (toolCallId) => ({ type: "tool_execution_start", toolCallId, toolName: "cross_review", args: {} });
const end = (toolCallId) => ({ type: "tool_execution_end", toolCallId, toolName: "cross_review", result: {}, isError: false });

test("parallel tool calls stay running until each ends, and progress lives only while its call runs", async (t) => {
  const { mount } = await loadSessionHook(t);
  const view = mount("session-id");
  view.render();
  view.send({ type: "agent_start" });
  view.send({ type: "message_end", message: { role: "assistant", content: [toolCall("a"), toolCall("b")], provider: "anthropic", model: "m", stopReason: "toolUse", timestamp: 1 } });
  view.send(start("a"));
  view.send(start("b"));
  view.send(progress("a", "a: openai (required) waiting"));
  view.send(progress("unknown", "never started"));
  assert.equal(view.read("a"), "a: openai (required) waiting");
  assert.equal(view.read("unknown"), null);

  // core는 끝난 호출의 결과 메시지를 곧바로 보낸다. 아직 도는 b가 실행 목록에서 빠지면 안 된다.
  view.send(end("a"));
  view.send({ type: "message_end", message: { role: "toolResult", toolCallId: "a", toolName: "cross_review", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 2 } });
  let hook = view.render();
  assert.deepEqual(hook.agentPhase?.kind, "running_tools");
  assert.deepEqual(hook.agentPhase.tools.map((tool) => tool.id), ["b"]);
  assert.equal(view.read("a"), null);

  // 끝난 뒤 늦게 온 갱신은 붙지 않는다.
  view.send(progress("a", "late"));
  assert.equal(view.read("a"), null);
  view.send(progress("b", "b: google (advisory) timed out after 120 s"));
  assert.equal(view.read("b"), "b: google (advisory) timed out after 120 s");

  // 실행이 끝나면(취소 포함) 남은 진행 줄도 지운다.
  view.send({ type: "agent_end" });
  hook = view.render();
  assert.equal(hook.agentPhase, null);
  assert.equal(view.read("b"), null);
});

test("two sessions showing the same toolCallId neither read nor clear each other's progress", async (t) => {
  const { mount, store } = await loadSessionHook(t);
  const first = mount("session-a");
  const second = mount("session-b");
  for (const view of [first, second]) {
    view.render();
    view.send({ type: "agent_start" });
    view.send(start("call_1"));
  }
  first.send(progress("call_1", "first: openai (required) waiting"));
  second.send(progress("call_1", "second: google (advisory) waiting"));
  assert.equal(first.read("call_1"), "first: openai (required) waiting");
  assert.equal(second.read("call_1"), "second: google (advisory) waiting");
  // 세션 id가 없는 화면(서브에이전트 기록 등)은 같은 호출 id라도 아무것도 읽지 않는다.
  assert.equal(store.readToolProgress(store.toolProgressKey(undefined, "call_1")), null);

  // 한쪽 호출이 끝나도, 한쪽 실행이 멈춰도 다른 세션의 진행 줄은 남는다.
  first.send(end("call_1"));
  assert.equal(first.read("call_1"), null);
  assert.equal(second.read("call_1"), "second: google (advisory) waiting");
  first.send({ type: "agent_end" });
  assert.equal(second.read("call_1"), "second: google (advisory) waiting");

  // 끝난 호출에 늦게 온 갱신은 다른 세션에서 같은 id가 아직 돌아도 다시 붙지 않는다.
  first.send(progress("call_1", "first: late"));
  assert.equal(first.read("call_1"), null);

  second.send({ type: "agent_end" });
  assert.equal(second.read("call_1"), null);
});

// R3-OAI-1: 한 훅이 세션을 바꾼 뒤 새 세션이 같은 호출 id를 시작해도 옛 세션의 등록을 덮어쓰지 않고, 정리할 때 둘 다 지운다.
test("a hook that switches sessions keeps and later releases the old session's registration for a reused toolCallId", async (t) => {
  const { mount } = await loadSessionHook(t);
  const view = mount("session-a");
  view.render();
  view.send({ type: "agent_start" });
  view.send(start("shared"));
  view.send(progress("shared", "a: openai (required) waiting"));
  view.switchTo("session-b");
  view.render();
  view.send({ type: "agent_start" });
  view.send(start("shared"));
  view.send(progress("shared", "b: google (advisory) waiting"));
  assert.equal(view.read("shared", "session-a"), "a: openai (required) waiting");
  assert.equal(view.read("shared"), "b: google (advisory) waiting");
  view.send(end("shared"));
  assert.equal(view.read("shared"), null);
  assert.equal(view.read("shared", "session-a"), "a: openai (required) waiting");
  view.send({ type: "agent_end" });
  assert.equal(view.read("shared", "session-a"), null);
});

/**
 * 실제 훅을 effect까지 돌리는 최소 React 대역(useAgentSession.test.mjs의 createEffectRenderer와 같은 규칙).
 * 상태가 바뀌면 microtask에서 다시 그리고, deps가 바뀐 effect만 cleanup 뒤 다시 실행한다.
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
  const setter = (state) => (next) => {
    const value = typeof next === "function" ? next(state.value) : next;
    if (Object.is(value, state.value)) return;
    state.value = value;
    schedule();
  };
  const react = {
    useState(initial) {
      const state = cell(() => ({ value: typeof initial === "function" ? initial() : initial }));
      state.set ??= setter(state);
      return [state.value, state.set];
    },
    useReducer(reducer, initial) {
      const state = cell(() => ({ value: initial }));
      state.dispatch ??= (action) => setter(state)((value) => reducer(value, action));
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
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
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
    unmount() {
      render = null;
      for (const slot of cells) if (slot?.effect) slot.cleanup?.();
      cells = [];
    },
  };
}

// MAIN-PROGRESS-RESTORE: 도구가 도는 중에 새로 고친 화면은 tool_execution_start를 다시 받지 못한다. 복원한 실행 상태의
// 실행 중 호출에는 이어지는 진행이 붙고, 끝나면 지워지며, 모르는 id와 같은 세션에서 이미 끝난 id의 갱신은 버린다.
test("a view restored mid-call shows later progress for the restored running call only", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cuelo-tool-progress-restore-"));
  const rendererKey = "__ompToolProgressEffectRenderer";
  const fakeReactPath = join(directory, "react.mjs");
  await writeFile(fakeReactPath, [
    `const react = () => globalThis.${rendererKey}.react;`,
    ...["useState", "useReducer", "useRef", "useCallback", "useMemo", "useEffect", "useSyncExternalStore"]
      .map((name) => `export const ${name} = (...args) => react().${name}(...args);`),
    "export const useLayoutEffect = (...args) => react().useEffect(...args);",
  ].join("\n"));
  const sourceRoot = new URL("../", import.meta.url);
  const subjectPath = join(directory, "useAgentSession.ts");
  const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  await writeFile(subjectPath, source
    .replace('from "react";', `from ${JSON.stringify(pathToFileURL(fakeReactPath).href)};`)
    .replace(/from "@\/([^"]+)";/g, (_match, path) => `from ${JSON.stringify(new URL(path, sourceRoot).href)};`)
    .replace(/await import\("@\/([^"]+)"\)/g, (_match, path) => `await import(${JSON.stringify(new URL(`${path}.ts`, sourceRoot).href)})`));
  const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
  const { useAgentSession } = await jiti.import(subjectPath);
  const store = await jiti.import(new URL("hooks/useToolProgress", sourceRoot).href);

  const globalKeys = ["window", "document", "sessionStorage", "EventSource", "fetch", "setTimeout", "setInterval", rendererKey];
  const originals = Object.fromEntries(globalKeys.map((key) => [key, globalThis[key]]));
  const renderer = createEffectRenderer();
  t.after(async () => {
    renderer.unmount();
    for (const key of globalKeys) {
      if (originals[key] === undefined) delete globalThis[key];
      else globalThis[key] = originals[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
  for (const name of ["setTimeout", "setInterval"]) {
    globalThis[name] = (callback, ms, ...args) => {
      const timer = originals[name](callback, ms, ...args);
      timer.unref?.();
      return timer;
    };
  }
  const sources = [];
  globalThis.EventSource = class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
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
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

  const SESSION = "11111111-2222-4333-8444-555555555555";
  const assistant = (calls, timestamp) => ({
    role: "assistant", content: calls.map((id) => ({ type: "toolCall", id, name: "cross_review", arguments: {} })),
    provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp,
  });
  const result = (id, timestamp) => ({ role: "toolResult", toolCallId: id, toolName: "cross_review", content: [{ type: "text", text: "ok" }], isError: false, timestamp });
  // 같은 세션에서 앞서 끝난 "old"와 지금 도는 "run". 서버의 실행 중 호출 목록은 "run"뿐이다.
  const transcript = [{ role: "user", content: "리뷰해 줘", timestamp: 1 }, assistant(["old"], 2), result("old", 3), assistant(["run"], 4)];
  const sessionData = { sessionId: SESSION, filePath: `/tmp/${SESSION}.jsonl`, totalActiveMs: 0, tree: [], leafId: `${SESSION}-4`, context: { messages: transcript, entryIds: transcript.map((_message, index) => `${SESSION}-${index + 1}`), thinkingLevel: "off", model: null } };
  const liveState = { running: true, state: { isStreaming: true, isPromptRunning: true, isBashRunning: false, isCompacting: false, isHandoffRunning: false, pendingToolCalls: ["run"] } };
  const json = (value) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (/^\/api\/sessions\/[^/?]+\?deferThinking=1&deferMedia=1$/.test(url)) return json(sessionData);
    if (/^\/api\/(?:sessions\/[^/?]+\/state|agent\/[^/?]+)$/.test(url)) return json(liveState);
    return json({ success: true, data: {} });
  };

  globalThis[rendererKey] = renderer;
  let hook;
  renderer.mount(() => {
    hook = useAgentSession({ session: { id: SESSION, name: "Test", cwd: "/tmp" }, newSessionCwd: null, initialData: sessionData });
  });
  for (let round = 0; round < 30; round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hook.agentRunning, true, "새로 고친 화면이 도는 run에 다시 붙는다");
  const stream = sources.find((source) => source.url === `/api/agent/${SESSION}/events`);
  stream.emit({ type: "connected", sessionId: SESSION });
  const read = (id) => store.readToolProgress(store.toolProgressKey(SESSION, id));
  const update = (toolCallId, text) => stream.emit({ type: "tool_execution_update", toolCallId, toolName: "cross_review", text });

  update("run", "cross_review round 1: openai (required) answered after 74 s; google (advisory) waiting");
  assert.equal(read("run"), "cross_review round 1: openai (required) answered after 74 s; google (advisory) waiting");
  update("unknown", "never started");
  update("old", "late from an ended call");
  assert.equal(read("unknown"), null);
  assert.equal(read("old"), null);

  stream.emit({ type: "tool_execution_end", toolCallId: "run", toolName: "cross_review", result: {}, isError: false });
  assert.equal(read("run"), null);
  update("run", "late after end");
  assert.equal(read("run"), null);
});
