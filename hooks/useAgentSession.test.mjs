import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");

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

test("keeps the session event stream open through the idle grace window", () => {
  const finishSource = source.slice(
    source.indexOf("const finishPromptWithoutStream"),
    source.indexOf("const waitForPromptSettlement"),
  );
  const graceSource = source.slice(
    source.indexOf("const scheduleEventStreamClose"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  const agentStartSource = source.slice(
    source.indexOf('case "agent_start"'),
    source.indexOf('case "agent_end"'),
  );
  const agentSettledSource = source.slice(
    source.indexOf('case "agent_settled"'),
    source.indexOf('case "prompt_done"'),
  );
  const promptDoneSource = source.slice(
    source.indexOf('case "prompt_done"'),
    source.indexOf('case "prompt_error"'),
  );

  assert.match(source, /const EVENT_STREAM_IDLE_GRACE_MS = 30_000/);
  assert.match(graceSource, /setTimeout\(\(\) => void checkServerIdle\(\), EVENT_STREAM_IDLE_GRACE_MS\)/);
  assert.match(graceSource, /fetch\(`\/api\/agent\/\$\{encodeURIComponent\(sid\)\}`\)/);
  assert.match(graceSource, /closeEvents\(\)/);
  assert.match(finishSource, /scheduleEventStreamClose\(sid\)/);
  assert.doesNotMatch(finishSource, /closeEvents\(\)/);
  assert.doesNotMatch(agentEndSource, /closeEvents\(\)/);
  assert.match(agentStartSource, /cancelEventStreamGrace\(\)/);
  assert.match(agentSettledSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(agentSettledSource, /notifyAgentEnd\(\)/);
  assert.match(promptDoneSource, /notifyPromptStage\(runId\)/);
  assert.match(promptDoneSource, /scheduleEventStreamClose\(sid\)/);
});


test("distinguishes a blocking wait from active Main work", () => {
  const toolStartSource = source.slice(
    source.indexOf('case "tool_execution_start"'),
    source.indexOf('case "tool_execution_end"'),
  );
  const waitingSource = chatWindowSource.slice(
    chatWindowSource.indexOf("  const dependencyWaiting"),
    chatWindowSource.indexOf("  const transitionBusy"),
  );

  assert.match(toolStartSource, /const args = event\.args as unknown/);
  assert.match(toolStartSource, /tools\.push\(\{ id, name, args \}\)/);
  assert.match(waitingSource, /agentPhase\.tools\.every/);
  assert.match(waitingSource, /tool\.name === "wait"/);
  assert.match(chatWindowSource, /onWaitingChange\?\.\(dependencyWaiting\)/);
  assert.match(appShellSource, /onWaitingChange=\{setMainWaiting\}/);
  assert.match(appShellSource, /translate\("workspace\.mainWaiting"\)/);
});


test("keeps completed subagents in the session history", () => {
  assert.match(source, /function mergeSubagentSnapshots/);
  assert.match(source, /const finished: SubagentSnapshot/);
  assert.match(source, /progress: previous\?\.progress \? \{ \.\.\.previous\.progress, status: terminalStatus \}/);
  assert.doesNotMatch(source, /payload\.status !== "started"\) \{\s*setSubagents\(\(previous\) => previous\.filter/);
});

test("routes blocking extension requests through deduplicated browser attention notifications", () => {
  const extensionRequestSource = source.slice(
    source.indexOf("  const handleExtensionUiRequest = useCallback"),
    source.indexOf("  const settleUiStage = useCallback"),
  );
  const attentionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
    appShellSource.indexOf("  const handleAutoName = useCallback"),
  );

  assert.match(
    extensionRequestSource,
    /isBlockingExtensionUiRequest\(request\)[\s\S]*?onAttentionNeeded\?\.\(request\)/,
  );
  assert.match(chatWindowSource, /onAttentionNeeded, onSessionCreated/);
  assert.match(attentionSource, /shouldShowBrowserNotification\(\)/);
  assert.match(attentionSource, /claimExtensionAttentionNotification\(request, notifiedAttentionRequestIdsRef\.current\)/);
  assert.match(attentionSource, /tag: `pi-extension-ui:\$\{request\.id\}`/);
  assert.match(appShellSource, /onAttentionNeeded=\{handleAttentionNeeded\}/);
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


test("/fork is consumed locally and surfaces server resolution errors", () => {
  const forkCaseSource = source.slice(
    source.indexOf('case "fork":'),
    source.indexOf('case "goal":', source.indexOf('case "fork":')),
  );

  assert.match(source, /case "fork": \{/);
  assert.match(forkCaseSource, /const result = await handleFork\(\);/);
  assert.doesNotMatch(forkCaseSource, /messages|entryIds|newestUserEntryId/);
  assert.match(forkCaseSource, /complete\(\{ handled: true, error: result\.error \?\? "Fork failed" \}\)/);
  assert.match(forkCaseSource, /complete\(\{ handled: true, message: "Forked a new session" \}\)/);
  // Every branch returns handled, so /fork never reaches the SDK fallback that
  // forwards the message as an LLM prompt — the case ends in a handled return
  // and yields to the next explicit case, not the default bridge.
  assert.doesNotMatch(forkCaseSource, /execute_slash_command/);
  assert.doesNotMatch(forkCaseSource, /type: "prompt"/);
  assert.match(source, /case "fork":[\s\S]*?return complete\(\{ handled: true, message: "Forked a new session" \}\);\s*\}\s*case "goal": \{/);
});

test("fork navigation selects the new session id from the RPC result", () => {
  const forkSource = source.slice(
    source.indexOf("const handleFork = useCallback"),
    source.indexOf("const handleNavigate = useCallback"),
  );

  assert.match(forkSource, /const handleFork = useCallback\(async \([\s\S]*?entryId\?: string,[\s\S]*?Promise<\{ forked: boolean; error\?: string \}>/);
  assert.match(forkSource, /type: "fork"/);
  assert.match(forkSource, /\.\.\.\(entryId \? \{ entryId \} : \{\}\)/);
  assert.match(forkSource, /const \{ cancelled, newSessionId \} = result \?\? \{\};/);
  assert.match(forkSource, /if \(!cancelled && newSessionId\) \{/);
  assert.match(forkSource, /onSessionForked\?\.\(newSessionId\);\s*\n\s*return \{ forked: true \};/);
  assert.match(forkSource, /error: e instanceof Error \? e\.message : String\(e\)/);
  assert.match(forkSource, /setForkingEntryId\(null\)/);
});

test("/handoff forwards the focus text verbatim and keeps the UI busy", () => {
  const handoffCaseSource = source.slice(
    source.indexOf('case "handoff":'),
    source.indexOf("default: {", source.indexOf('case "handoff":')),
  );

  assert.match(source, /case "handoff": \{/);
  // The text after /handoff is forwarded exactly as the handoff focus.
  assert.match(handoffCaseSource, /type: "handoff"/);
  assert.match(handoffCaseSource, /\.\.\.\(args \? \{ customInstructions: args \} : \{\}\)/);
  // The long oneshot generation keeps the composer busy through existing
  // agent-running state, with no new state machine.
  assert.match(handoffCaseSource, /if \(agentRunningRef\.current \|\| bashRunningRef\.current\)/);
  assert.match(handoffCaseSource, /Cannot hand off while the session is busy/);
  assert.match(handoffCaseSource, /agentRunningRef\.current = true/);
  assert.match(handoffCaseSource, /setAgentRunning\(true\)/);
  assert.match(handoffCaseSource, /agentRunningRef\.current = false/);
  assert.match(handoffCaseSource, /setAgentRunning\(false\)/);
  // Cancellation resolves locally as an error; /handoff never falls through to
  // the SDK command bridge or an LLM prompt.
  assert.match(handoffCaseSource, /if \(!result \|\| result\.cancelled\)/);
  assert.match(handoffCaseSource, /complete\(\{ handled: true, error: "Handoff cancelled" \}\)/);
  assert.doesNotMatch(handoffCaseSource, /execute_slash_command/);
  assert.doesNotMatch(handoffCaseSource, /type: "prompt"/);
  const connectIndex = handoffCaseSource.indexOf("await ensureEventsConnected(sid)");
  const dispatchIndex = handoffCaseSource.indexOf('type: "handoff"');
  assert.ok(connectIndex >= 0);
  assert.ok(dispatchIndex > connectIndex);
  assert.match(handoffCaseSource, /scheduleEventStreamClose\(sid\)/);
});

test("/handoff reloads the same session after an in-place compaction", () => {
  const handoffCaseSource = source.slice(
    source.indexOf('case "handoff":'),
    source.indexOf("default: {", source.indexOf('case "handoff":')),
  );

  assert.match(
    handoffCaseSource,
    /sendAgentCommand<\{ cancelled\?: boolean \}>[\s\S]*?type: "handoff"/,
  );
  // omp 18 hands off in place: the session id never changes, so success
  // reloads this transcript instead of navigating to a replacement session.
  assert.doesNotMatch(handoffCaseSource, /newSessionId/);
  assert.doesNotMatch(handoffCaseSource, /onSessionForked/);
  assert.match(handoffCaseSource, /if \(await loadSession\(sid, true\)\) promoteNewSession\(\);/);
  // Every branch returns handled so the command never reaches the SDK
  // fallback — the busy state is torn down in a finally block and the case
  // yields to the default bridge with a return.
  assert.match(handoffCaseSource, /complete\(\{ handled: true, message: "컨텍스트를 현재 세션에 압축했습니다" \}\)/);
  assert.match(source, /case "handoff":[\s\S]*?return complete\(\{ handled: true, message: "컨텍스트를 현재 세션에 압축했습니다" \}\);\s*\}\s*finally \{[\s\S]*?\}\s*\}\s*default: \{/);
});

test("rehydrates handoff as busy without misreporting compaction", () => {
  assert.match(source, /isHandoffRunning\?: boolean/);
  assert.match(
    source,
    /state\.isStreaming \|\| state\.isPromptRunning \|\| state\.isCompacting \|\| state\.isHandoffRunning/,
  );
  assert.match(
    source,
    /agentState\.state\?\.isStreaming[\s\S]*?agentState\.state\?\.isPromptRunning[\s\S]*?agentState\.state\?\.isHandoffRunning/,
  );
});

test("preserves flat images across busy transport failures and queue recall", () => {
  const busySource = source.slice(
    source.indexOf("  const handleSteer = useCallback"),
    source.indexOf("  const handleThinkingLevelChange = useCallback"),
  );

  assert.equal((busySource.match(/toDraftImages\(images\)/g) ?? []).length, 6);
  assert.match(busySource, /type: "steer"[\s\S]*?images: piImages/);
  assert.match(busySource, /type: "prompt"[\s\S]*?streamingBehavior: behavior[\s\S]*?images: piImages/);
  assert.match(busySource, /type: "follow_up"[\s\S]*?images: piImages/);
  assert.match(busySource, /mergeRestoredQueuedMessages\([\s\S]*?result\?\.steering[\s\S]*?result\?\.followUp/);
  assert.match(busySource, /restoreSubmission\?\.\([\s\S]*?recalled\.text[\s\S]*?recalled\.images/);
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
test("업데이트 복귀 신호를 받은 유휴 화면은 새로고침 없이 Wake 응답을 한 번만 보여 준다", async (t) => {
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
});

test("lets a user scroll pause auto-follow mid-stream", () => {
  const scrollHandlerSource = source.slice(
    source.indexOf("const handleScrollPositionChange"),
    source.indexOf("  // Load session on mount"),
  );

  // The auto-follow effect refreshes the programmatic-scroll window on every
  // streaming chunk, so gating every scroll event on it made the follow flag
  // impossible to clear while the model was producing output.
  assert.match(scrollHandlerSource, /const userDriven = Date\.now\(\) <= userScrollIntentUntilRef\.current/);
  assert.match(scrollHandlerSource, /if \(!userDriven && Date\.now\(\) < ignoreProgrammaticScrollUntilRef\.current\) return/);
  assert.match(scrollHandlerSource, /distanceFromBottom <= AUTO_FOLLOW_BOTTOM_THRESHOLD_PX\)\s*\{\s*setAutoFollow\(true\)/);
  assert.match(scrollHandlerSource, /if \(userDriven\) \{\s*setAutoFollow\(false\)/);
});

test("exposes a paused-follow flag and a jump-to-bottom action", () => {
  // The ref drives the scroll effects and the state drives the button; one
  // writer keeps them from drifting apart.
  assert.match(source, /const setAutoFollow = useCallback\(\(following: boolean\) => \{\s*completionScrollAllowedRef\.current = following;\s*setAutoFollowPaused\(/);
  assert.match(source, /const resumeAutoFollow = useCallback\(\(\) => \{[\s\S]*?userScrollIntentUntilRef\.current = 0;[\s\S]*?setAutoFollow\(true\);[\s\S]*?scrollToBottom\("smooth"\)/);
  assert.match(source, /autoFollowPaused, resumeAutoFollow,/);
  // A new prompt or shell command resumes following.
  assert.doesNotMatch(source, /completionScrollAllowedRef\.current = true;/);

  assert.match(chatWindowSource, /autoFollowPaused, resumeAutoFollow,/);
  assert.match(chatWindowSource, /\{sessionBusy && autoFollowPaused && \(/);
  assert.match(chatWindowSource, /onClick=\{resumeAutoFollow\}/);
});

test("renders the transcript with omp's hideThinkingBlock setting", () => {
  const messageViewSource = readFileSync(new URL("../components/MessageView.tsx", import.meta.url), "utf8");
  assert.match(messageViewSource, /const \{ hideThinkingBlock \} = useDisplaySettings\(\)/);
  assert.match(messageViewSource, /isHiddenAssistantBlock\(block, \{ isStreaming, hideThinking: hideThinkingBlock \}\)/);

  assert.match(chatWindowSource, /useSyncedDisplaySettings\(/);
  assert.match(chatWindowSource, /displayOptions = useMemo<DisplayOptions>\(\(\) => \(\{ hideThinking: hideThinkingBlock \}\)/);
  // Turn grouping has to agree with what MessageView renders, or a message
  // made only of thinking blocks leaves an empty row behind. The grouping this
  // app uses lives in lib/transcript-plan.ts, so the options have to reach it
  // from ChatWindow and be applied to the runs it classifies.
  const planSource = readFileSync(new URL("../lib/transcript-plan.ts", import.meta.url), "utf8");
  assert.match(chatWindowSource, /hideThinking: displayOptions\.hideThinking \}/);
  assert.match(planSource, /splitAssistantBlockRuns\(assistant, options\)/);
  assert.match(planSource, /getAssistantErrorMessage\(assistant, options\)/);
});
