/**
 * 세션 보기 전체. 이 순서가 곧 Ctrl+숫자 별칭 순서이므로 중간에 끼워 넣으면 기존
 * 사용자가 이미 누르던 숫자가 다른 보기를 가리키게 된다. 덱 자체의 탭 순서는
 * WORKSPACE_PANEL_VIEW_IDS가 따로 정한다.
 */
export const WORKSPACE_VIEW_IDS = ["chat", "process", "subagents", "files", "resource", "sidechat", "efficiency"] as const;
export type WorkspaceViewId = (typeof WORKSPACE_VIEW_IDS)[number];

/**
 * Session views other than the transcript, in the order the auxiliary deck
 * shows them. They all share that one panel region, so selecting one replaces
 * the previous one.
 */
export const WORKSPACE_PANEL_VIEW_IDS = ["process", "efficiency", "subagents", "files", "resource", "sidechat"] as const;
export type WorkspacePanelViewId = (typeof WORKSPACE_PANEL_VIEW_IDS)[number];

export const WORKSPACE_RESOURCE_TABS = ["characters", "usage", "models"] as const;
export type WorkspaceResourceTab = (typeof WORKSPACE_RESOURCE_TABS)[number];

export const WORKSPACE_EFFICIENCY_TABS = ["governor", "lab"] as const;
export type WorkspaceEfficiencyTab = (typeof WORKSPACE_EFFICIENCY_TABS)[number];


export const WORKSPACE_TRANSIENT_LAYERS = [
  "navigator-drawer",
  "command-palette",
] as const;
export type WorkspaceTransientLayer = (typeof WORKSPACE_TRANSIENT_LAYERS)[number];

export const WORKSPACE_CONTENT_MINIMUMS = Object.freeze({
  transcript: 550,
  composer: 384,
  navigator: 240,
  deck: 384,
});

// Navigator/deck floors are cumulative content sums. Usage and models live in
// the same deck as the other panel views, so there is no separate rail floor
// and no width at which two auxiliary surfaces are open at once.
export const WORKSPACE_PIN_THRESHOLDS = Object.freeze({
  navigator: 791, // 240 + 1 + 550
  deck: 1176, // 240 + 1 + 550 + 1 + 384
});

export interface WorkspaceLayoutState {
  activeView: WorkspaceViewId;
  transientLayer: WorkspaceTransientLayer | null;
  /**
   * The user widened the pinned deck into the transcript's place. Only the
   * shell decides whether it takes effect (a pinned deck); closing the deck
   * clears it so the next open starts at the pinned size again.
   */
  deckExpanded: boolean;
}

export const DEFAULT_WORKSPACE_LAYOUT_STATE: Readonly<WorkspaceLayoutState> = Object.freeze({
  activeView: "chat",
  transientLayer: null,
  deckExpanded: false,
});

export type WorkspaceLayoutAction =
  | { type: "select-view"; view: WorkspaceViewId }
  | { type: "open-layer"; layer: WorkspaceTransientLayer }
  | { type: "toggle-layer"; layer: WorkspaceTransientLayer }
  | { type: "close-layer" }
  | { type: "set-deck-expanded"; expanded: boolean };

const WORKSPACE_VIEW_ID_LOOKUP: Record<string, true> = Object.fromEntries(
  WORKSPACE_VIEW_IDS.map((id) => [id, true]),
);

/**
 * 알 수 없는 보기 id를 대화 보기로 되돌린다. 제거된 보기(arena 등)의 이름이 남은
 * 값이 들어와도 덱이 빈 패널을 그리거나 라벨 조회가 undefined가 되지 않게, 상태가
 * 만들어지는 이 한 곳에서 정규화한다.
 */
export function normalizeWorkspaceViewId(view: string | null | undefined): WorkspaceViewId {
  return typeof view === "string" && WORKSPACE_VIEW_ID_LOOKUP[view] === true
    ? (view as WorkspaceViewId)
    : DEFAULT_WORKSPACE_LAYOUT_STATE.activeView;
}

/**
 * Applies the workspace's two exclusivity rules: session views replace one
 * another, and opening a transient layer always replaces the current layer.
 */
export function reduceWorkspaceLayout(
  state: Readonly<WorkspaceLayoutState>,
  action: WorkspaceLayoutAction,
): WorkspaceLayoutState {
  // 넓게 보기는 덱이 열려 있을 때만 뜻이 있다. 대화 보기로 돌아가면(정규화로 돌아간 경우 포함) 지운다.
  const keepExpanded = (activeView: WorkspaceViewId, expanded: boolean): boolean => activeView !== "chat" && expanded;
  switch (action.type) {
    case "select-view": {
      const activeView = normalizeWorkspaceViewId(action.view);
      return { activeView, transientLayer: null, deckExpanded: keepExpanded(activeView, state.deckExpanded === true) };
    }
    case "open-layer": {
      const activeView = normalizeWorkspaceViewId(state.activeView);
      return { activeView, transientLayer: action.layer, deckExpanded: keepExpanded(activeView, state.deckExpanded === true) };
    }
    case "toggle-layer": {
      const activeView = normalizeWorkspaceViewId(state.activeView);
      return {
        activeView,
        transientLayer: state.transientLayer === action.layer ? null : action.layer,
        deckExpanded: keepExpanded(activeView, state.deckExpanded === true),
      };
    }
    case "close-layer": {
      const activeView = normalizeWorkspaceViewId(state.activeView);
      return { activeView, transientLayer: null, deckExpanded: keepExpanded(activeView, state.deckExpanded === true) };
    }
    case "set-deck-expanded": {
      const activeView = normalizeWorkspaceViewId(state.activeView);
      return { activeView, transientLayer: state.transientLayer, deckExpanded: keepExpanded(activeView, action.expanded) };
    }
  }
}

/**
 * Whether the deck takes the transcript's place. View-stack always does; a
 * pinned deck does only while the user has widened it. `staleExpansion` is
 * true when a widened deck can no longer be widened (the window narrowed to
 * view-stack): the shell clears the flag then, so widening the window again
 * does not silently re-expand it.
 */
export function getDeckPresentation(input: {
  deckVisible: boolean;
  pinDecision: WorkspacePinDecision;
  deckExpanded: boolean;
}): { replacesTranscript: boolean; expandable: boolean; expanded: boolean; staleExpansion: boolean } {
  const expandable = input.deckVisible && input.pinDecision.deck === "pinned";
  const expanded = expandable && input.deckExpanded;
  return {
    replacesTranscript: input.deckVisible && (input.pinDecision.deck === "view-stack" || expanded),
    expandable,
    expanded,
    staleExpansion: input.deckExpanded && !expandable,
  };
}

export interface WorkspacePinDecision {
  availableWidth: number;
  navigator: "drawer" | "pinned";
  /**
   * `pinned` puts the auxiliary panel beside the transcript with no scrim;
   * `view-stack` replaces the transcript with it, one view at a time.
   */
  deck: "view-stack" | "pinned";
}

/**
 * Resolves region presentation in priority order. Width is the shell's
 * available inline size, not a device classification or user-agent signal.
 * The 43em transcript measure is normative; 550px is only its descriptive
 * content floor for pin priority.
 */
export function getWorkspacePinDecision(availableWidth: number): WorkspacePinDecision {
  const width = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0;

  return {
    availableWidth: width,
    navigator: width >= WORKSPACE_PIN_THRESHOLDS.navigator ? "pinned" : "drawer",
    deck: width >= WORKSPACE_PIN_THRESHOLDS.deck ? "pinned" : "view-stack",
  };
}

/**
 * The navigator's presentation, derived in one place because the open request
 * alone is not a presentation. `clientPainted` is false until the client has
 * answered the content-derived pin question for the first time; the server can
 * never answer it while the pinned default is already open, and the shell's
 * CSS keeps a pending drawer off-screen. Announcing, scrimming, resizing or
 * focusing the raw open request in that frame would describe a navigator that
 * is not on screen.
 */
export interface NavigatorPresentation {
  /**
   * The navigator paints at its open size in the current geometry: the pinned
   * default before the client answers, or a drawer the client has painted.
   */
  laidOut: boolean;
  /** The reader and the keyboard may treat the navigator as open. */
  presented: boolean;
  /** The presented navigator is the compact drawer laid over the transcript. */
  drawer: boolean;
}

export function getNavigatorPresentation(input: {
  clientPainted: boolean;
  compactWorkspace: boolean;
  requestedOpen: boolean;
}): NavigatorPresentation {
  const presented = input.requestedOpen && input.clientPainted;

  return {
    laidOut: input.requestedOpen && (!input.compactWorkspace || input.clientPainted),
    presented,
    drawer: presented && input.compactWorkspace,
  };
}
