import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_WORKSPACE_LAYOUT_STATE,
  WORKSPACE_PIN_THRESHOLDS,
  WORKSPACE_VIEW_IDS,
  getDeckPresentation,
  getNavigatorPresentation,
  getWorkspacePinDecision,
  normalizeWorkspaceViewId,
  reduceWorkspaceLayout,
} = await jiti.import("./workspace-layout.ts");

test("keeps portrait session views mutually exclusive", () => {
  const withFilesOpen = reduceWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT_STATE, {
    type: "select-view",
    view: "files",
  });

  assert.deepEqual(withFilesOpen, {
    activeView: "files",
    transientLayer: null,
    deckExpanded: false,
  });

  const withSubagentsOpen = reduceWorkspaceLayout(withFilesOpen, {
    type: "select-view",
    view: "subagents",
  });

  assert.deepEqual(withSubagentsOpen, {
    activeView: "subagents",
    transientLayer: null,
    deckExpanded: false,
  });
});

test("replaces the active transient layer and toggles the same layer closed", () => {
  const withNavigator = reduceWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT_STATE, {
    type: "open-layer",
    layer: "navigator-drawer",
  });

  assert.equal(withNavigator.transientLayer, "navigator-drawer");
  assert.equal(
    reduceWorkspaceLayout(withNavigator, {
      type: "toggle-layer",
      layer: "navigator-drawer",
    }).transientLayer,
    null,
  );
  assert.equal(
    reduceWorkspaceLayout(withNavigator, {
      type: "toggle-layer",
      layer: "command-palette",
    }).transientLayer,
    "command-palette",
  );
});

test("selecting a session view dismisses a transient layer", () => {
  const withPalette = reduceWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT_STATE, {
    type: "open-layer",
    layer: "command-palette",
  });
  const next = reduceWorkspaceLayout(withPalette, {
    type: "select-view",
    view: "process",
  });

  assert.deepEqual(next, {
    activeView: "process",
    transientLayer: null,
    deckExpanded: false,
  });
});

test("degrades regions in priority order at the observed pin boundaries", () => {
  assert.deepEqual(getWorkspacePinDecision(WORKSPACE_PIN_THRESHOLDS.navigator - 1), {
    availableWidth: 790,
    navigator: "drawer",
    deck: "view-stack",
  });
  assert.deepEqual(getWorkspacePinDecision(WORKSPACE_PIN_THRESHOLDS.navigator), {
    availableWidth: 791,
    navigator: "pinned",
    deck: "view-stack",
  });
  assert.deepEqual(getWorkspacePinDecision(WORKSPACE_PIN_THRESHOLDS.deck - 1), {
    availableWidth: 1175,
    navigator: "pinned",
    deck: "view-stack",
  });
  // Usage and models share the deck, so 1176 is the only auxiliary boundary:
  // above it the panel is pinned beside the transcript at every width.
  assert.deepEqual(getWorkspacePinDecision(WORKSPACE_PIN_THRESHOLDS.deck), {
    availableWidth: 1176,
    navigator: "pinned",
    deck: "pinned",
  });
  assert.deepEqual(getWorkspacePinDecision(1920), {
    availableWidth: 1920,
    navigator: "pinned",
    deck: "pinned",
  });
});

test("resource is a panel view rather than a transient layer", () => {
  const withResource = reduceWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT_STATE, {
    type: "select-view",
    view: "resource",
  });

  assert.deepEqual(withResource, { activeView: "resource", transientLayer: null, deckExpanded: false });
  assert.deepEqual(
    reduceWorkspaceLayout(withResource, { type: "select-view", view: "chat" }),
    { activeView: "chat", transientLayer: null, deckExpanded: false },
  );
});

// 제거된 보기 이름(arena)이 남은 상태로 들어와도 덱이 빈 패널을 그리거나 라벨 조회가
// undefined가 되면 안 된다. 상태가 만들어지는 곳에서 유효한 보기로 되돌린다.
test("제거된 보기 id를 고르면 대화 보기로 되돌아간다", () => {
  assert.equal(WORKSPACE_VIEW_IDS.includes("arena"), false);

  const restored = reduceWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT_STATE, {
    type: "select-view",
    view: "arena",
  });
  assert.deepEqual(restored, { activeView: "chat", transientLayer: null, deckExpanded: false });

  // 되돌아간 뒤에도 보기 전환은 그대로 동작한다.
  assert.deepEqual(
    reduceWorkspaceLayout(restored, { type: "select-view", view: "efficiency" }),
    { activeView: "efficiency", transientLayer: null, deckExpanded: false },
  );
});

test("제거된 보기를 품은 상태에서 레이어를 열고 닫아도 유효한 보기만 남는다", () => {
  const stale = { activeView: "arena", transientLayer: null };

  assert.deepEqual(
    reduceWorkspaceLayout(stale, { type: "open-layer", layer: "command-palette" }),
    { activeView: "chat", transientLayer: "command-palette", deckExpanded: false },
  );
  assert.deepEqual(
    reduceWorkspaceLayout(stale, { type: "toggle-layer", layer: "command-palette" }),
    { activeView: "chat", transientLayer: "command-palette", deckExpanded: false },
  );
  assert.deepEqual(
    reduceWorkspaceLayout(stale, { type: "close-layer" }),
    { activeView: "chat", transientLayer: null, deckExpanded: false },
  );
});

test("정규화는 유효한 보기를 그대로 두고 알 수 없는 값만 되돌린다", () => {
  for (const view of WORKSPACE_VIEW_IDS) {
    assert.equal(normalizeWorkspaceViewId(view), view);
  }
  for (const view of ["arena", "", "ARENA", null, undefined, 3]) {
    assert.equal(normalizeWorkspaceViewId(view), "chat");
  }
});

test("widening the deck survives panel switches and ends when the deck closes", () => {
  const files = reduceWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT_STATE, { type: "select-view", view: "files" });
  const wide = reduceWorkspaceLayout(files, { type: "set-deck-expanded", expanded: true });
  assert.equal(wide.deckExpanded, true);
  assert.equal(reduceWorkspaceLayout(wide, { type: "select-view", view: "subagents" }).deckExpanded, true);
  assert.equal(reduceWorkspaceLayout(wide, { type: "set-deck-expanded", expanded: false }).deckExpanded, false);
  // 덱을 닫으면 다음에 열 때 원래 크기로 시작한다.
  const closed = reduceWorkspaceLayout(wide, { type: "select-view", view: "chat" });
  assert.equal(closed.deckExpanded, false);
  assert.equal(reduceWorkspaceLayout(closed, { type: "select-view", view: "files" }).deckExpanded, false);
  // 닫힌 덱은 넓힐 수 없다.
  assert.equal(reduceWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT_STATE, { type: "set-deck-expanded", expanded: true }).deckExpanded, false);
});

test("only a widened pinned deck replaces the transcript besides view-stack and the office page", () => {
  const pinned = getWorkspacePinDecision(1920);
  const stacked = getWorkspacePinDecision(WORKSPACE_PIN_THRESHOLDS.deck - 1);
  assert.deepEqual(
    getDeckPresentation({ deckVisible: true, pinDecision: pinned, officePage: false, deckExpanded: false }),
    { replacesTranscript: false, expandable: true, expanded: false, staleExpansion: false },
  );
  assert.deepEqual(
    getDeckPresentation({ deckVisible: true, pinDecision: pinned, officePage: false, deckExpanded: true }),
    { replacesTranscript: true, expandable: true, expanded: true, staleExpansion: false },
  );
  // view-stack은 이미 전체 폭이라 넓히기 컨트롤이 없다. 남은 플래그는 효과가 없고 셸이 지우도록 알린다.
  assert.deepEqual(
    getDeckPresentation({ deckVisible: true, pinDecision: stacked, officePage: false, deckExpanded: true }),
    { replacesTranscript: true, expandable: false, expanded: false, staleExpansion: true },
  );
  assert.deepEqual(
    getDeckPresentation({ deckVisible: true, pinDecision: pinned, officePage: true, deckExpanded: true }),
    { replacesTranscript: true, expandable: false, expanded: false, staleExpansion: true },
  );
  assert.deepEqual(
    getDeckPresentation({ deckVisible: false, pinDecision: pinned, officePage: false, deckExpanded: true }),
    { replacesTranscript: false, expandable: false, expanded: false, staleExpansion: true },
  );
});

test("a widened deck that loses the pinned layout starts at its own size when the window widens again", () => {
  const pinned = getWorkspacePinDecision(1920);
  const stacked = getWorkspacePinDecision(WORKSPACE_PIN_THRESHOLDS.deck - 1);
  // 셸이 하는 일: 화면이 바뀔 때마다 표현을 읽고, 더는 넓힐 수 없는데 넓힌 상태가 남았으면 지운다.
  const settle = (state, pinDecision) => {
    const presentation = getDeckPresentation({ deckVisible: state.activeView !== "chat", pinDecision, officePage: false, deckExpanded: state.deckExpanded });
    return presentation.staleExpansion ? reduceWorkspaceLayout(state, { type: "set-deck-expanded", expanded: false }) : state;
  };
  let state = reduceWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT_STATE, { type: "select-view", view: "files" });
  state = settle(reduceWorkspaceLayout(state, { type: "set-deck-expanded", expanded: true }), pinned);
  assert.equal(getDeckPresentation({ deckVisible: true, pinDecision: pinned, officePage: false, deckExpanded: state.deckExpanded }).expanded, true);
  state = settle(state, stacked);
  state = settle(state, pinned);
  assert.deepEqual(
    getDeckPresentation({ deckVisible: true, pinDecision: pinned, officePage: false, deckExpanded: state.deckExpanded }),
    { replacesTranscript: false, expandable: true, expanded: false, staleExpansion: false },
  );
});

// A pending first frame must not be presented, but the pinned navigator keeps
// the geometry it is already painted with: collapsing it there would move the
// transcript on hydration.
test("an open request is presented only once the client has painted it", () => {
  assert.deepEqual(
    getNavigatorPresentation({ clientPainted: true, compactWorkspace: true, requestedOpen: true }),
    { laidOut: true, presented: true, drawer: true },
  );
  assert.deepEqual(
    getNavigatorPresentation({ clientPainted: true, compactWorkspace: false, requestedOpen: true }),
    { laidOut: true, presented: true, drawer: false },
  );
  assert.deepEqual(
    getNavigatorPresentation({ clientPainted: false, compactWorkspace: true, requestedOpen: true }),
    { laidOut: false, presented: false, drawer: false },
  );
  assert.deepEqual(
    getNavigatorPresentation({ clientPainted: false, compactWorkspace: false, requestedOpen: true }),
    { laidOut: true, presented: false, drawer: false },
  );
});
