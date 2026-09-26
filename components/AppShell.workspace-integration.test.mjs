import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_WORKSPACE_LAYOUT_STATE,
  reduceWorkspaceLayout,
} = await jiti.import("../lib/workspace-layout.ts");
const { createSideChatHistoryStore, resolveSidePanelSessionPath } = await jiti.import("../lib/hanse-sidechat-client.ts");
const {
  handleGlobalKeyboardShortcut,
  registerAbortHandler,
  updateGlobalShortcutComposition,
} = await jiti.import("../hooks/useKeyboardShortcuts.ts");

function keyboardEvent(overrides = {}) {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    target: null,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
  };
}

test("session views and transient layers remain mutually exclusive", () => {
  const drawer = reduceWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT_STATE, {
    type: "open-layer",
    layer: "navigator-drawer",
  });
  const palette = reduceWorkspaceLayout(drawer, {
    type: "open-layer",
    layer: "command-palette",
  });
  assert.equal(palette.transientLayer, "command-palette");

  const resource = reduceWorkspaceLayout(palette, {
    type: "select-view",
    view: "resource",
  });
  assert.deepEqual(resource, { activeView: "resource", transientLayer: null });
});

test("side-chat cleanup waits for a complete census", () => {
  const store = createSideChatHistoryStore(memoryStorage(), { now: () => 100 });
  store.append("missing-session", { q: "question", a: "answer", at: 1 });

  store.cleanup({ sessions: [], complete: false });
  assert.equal(store.read("missing-session").length, 1);

  store.cleanup({ sessions: [], complete: true });
  assert.equal(store.read("missing-session").length, 0);
});

test("a session created in this tab gives the side panels its loaded file before the list has it", () => {
  // handleSessionCreated/handleSessionForked select the session with an empty path; the list
  // lookup at that moment can run before the session file exists.
  const created = { id: "01a0dc45-0000-7000-8000-000000000001", path: "" };
  const loaded = { sessionId: created.id, sessionFile: "C:/profile/sessions/created.jsonl" };
  assert.equal(resolveSidePanelSessionPath(created, loaded), "C:/profile/sessions/created.jsonl");
  assert.equal(resolveSidePanelSessionPath(created, { ...loaded, sessionId: "another-session" }), null);
  assert.equal(resolveSidePanelSessionPath(created, { sessionId: created.id }), null);
  assert.equal(
    resolveSidePanelSessionPath({ ...created, path: "C:/profile/sessions/listed.jsonl" }, loaded),
    "C:/profile/sessions/listed.jsonl",
  );
  assert.equal(resolveSidePanelSessionPath(null, loaded), null);
});

test("Escape dismisses the top application layer before abort", () => {
  let dismissed = 0;
  let aborted = 0;
  registerAbortHandler(() => { aborted += 1; });
  const event = keyboardEvent({ key: "Escape" });

  assert.equal(handleGlobalKeyboardShortcut(event, {
    onEscape: () => {
      dismissed += 1;
      return true;
    },
  }), true);
  assert.equal(dismissed, 1);
  assert.equal(aborted, 0);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  registerAbortHandler(null);
});

test("non-reserved cycle shortcut and resource shortcut remain reachable", () => {
  const cycles = [];
  let resources = 0;
  const cycleEvent = keyboardEvent({
    key: ">",
    code: "Period",
    ctrlKey: true,
    shiftKey: true,
  });
  const resourceEvent = keyboardEvent({ key: "u", code: "KeyU", ctrlKey: true });

  handleGlobalKeyboardShortcut(cycleEvent, { onCycleView: (direction) => cycles.push(direction) });
  handleGlobalKeyboardShortcut(resourceEvent, { onToggleResources: () => { resources += 1; } });

  assert.deepEqual(cycles, [1]);
  assert.equal(resources, 1);
  assert.equal(cycleEvent.prevented, true);
  assert.equal(resourceEvent.prevented, true);
});

test("palette, navigator, and project-session shortcuts dispatch their actions", () => {
  const actions = [];
  handleGlobalKeyboardShortcut(
    keyboardEvent({ key: "k", code: "KeyK", ctrlKey: true }),
    { onToggleCommandPalette: () => actions.push("palette") },
  );
  handleGlobalKeyboardShortcut(
    keyboardEvent({ key: "b", code: "KeyB", ctrlKey: true }),
    { onToggleNavigator: () => actions.push("navigator") },
  );
  handleGlobalKeyboardShortcut(
    keyboardEvent({ key: "ArrowUp", code: "ArrowUp", altKey: true }),
    { onNavigateSession: (direction) => actions.push(`session:${direction}`) },
  );
  handleGlobalKeyboardShortcut(
    keyboardEvent({ key: "ArrowDown", code: "ArrowDown", altKey: true }),
    { onNavigateSession: (direction) => actions.push(`session:${direction}`) },
  );
  assert.deepEqual(actions, ["palette", "navigator", "session:-1", "session:1"]);
});

test("global shortcuts stay inert throughout IME composition and its debounce", () => {
  let paletteToggles = 0;
  const options = {
    onToggleCommandPalette: () => { paletteToggles += 1; },
    now: () => 1_000,
  };

  updateGlobalShortcutComposition(true, 1_000);
  handleGlobalKeyboardShortcut(keyboardEvent({ key: "k", ctrlKey: true }), options);
  assert.equal(paletteToggles, 0);

  updateGlobalShortcutComposition(false, 1_000);
  handleGlobalKeyboardShortcut(keyboardEvent({ key: "k", ctrlKey: true }), {
    ...options,
    now: () => 1_099,
  });
  handleGlobalKeyboardShortcut(keyboardEvent({ key: "k", ctrlKey: true, isComposing: true }), {
    ...options,
    now: () => 1_101,
  });
  handleGlobalKeyboardShortcut(keyboardEvent({ key: "k", ctrlKey: true, keyCode: 229 }), {
    ...options,
    now: () => 1_101,
  });
  assert.equal(paletteToggles, 0);

  handleGlobalKeyboardShortcut(keyboardEvent({ key: "k", ctrlKey: true }), {
    ...options,
    now: () => 1_101,
  });
  assert.equal(paletteToggles, 1);
});
