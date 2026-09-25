"use client";

import { useState, useCallback, useRef, useEffect, useReducer, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useRouter, useSearchParams, type ReadonlyURLSearchParams } from "next/navigation";
import { ActionButton, Icon, Menu, ToggleButton } from "@seed-design/react";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { SettingsConfig } from "./SettingsConfig";
import { NotificationPermission, useNotificationPermission } from "./NotificationPermission";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { AuxiliaryDeck, type AuxiliaryDeckView } from "./workspace/AuxiliaryDeck";
import { ProcessLogPanel, type ProcessLogData } from "./workspace/ProcessLogPanel";
import { SideChatPanel } from "./workspace/SideChatPanel";
import { ResourcePanel, type ResourceTab } from "./workspace/ResourcePanel";
import { EfficiencyPanel } from "./workspace/EfficiencyPanel";
import { BranchNavigator } from "./BranchNavigator";
import { getContextIndicator } from "@/lib/context-usage";
import { autoNameBlockReason } from "@/lib/auto-name";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsCompactWorkspace } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useAudio } from "@/hooks/useAudio";
import { useUsageSnapshot } from "@/hooks/useUsageSnapshot";
import { useSyncedAccountFaces } from "@/hooks/useAccountFaces";
import { SidebarUsage } from "./SidebarUsage";
import { copyText } from "@/lib/clipboard";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import {
  claimExtensionAttentionNotification,
  shouldShowBrowserNotification,
  showBrowserNotification,
} from "@/lib/browser-notifications";
import { getInitialNavigation } from "@/lib/initial-navigation";
import { clearLastOpen, getLastOpenSession, setLastOpenSession } from "@/lib/workspace-memory";
import { createSideChatFlightRegistry, createSideChatHistoryStore, type SideChatSessionCensus } from "@/lib/hanse-sidechat-client";
import {
  DEFAULT_WORKSPACE_LAYOUT_STATE,
  getNavigatorPresentation,
  getWorkspacePinDecision,
  reduceWorkspaceLayout,
  WORKSPACE_RESOURCE_TABS,
  type WorkspaceEfficiencyTab,
  WORKSPACE_VIEW_IDS,
  type WorkspacePanelViewId,
  type WorkspaceViewId,
} from "@/lib/workspace-layout";
import {
  getSidebarMaxWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode, SubagentSnapshot } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/omp-types";
import type { AgentCompletionResult, SessionData } from "@/hooks/useAgentSession";
import {
  confirmUpdateResume,
  describeUpdateCleanup,
  dismissUpdateReturn,
  enterUpdateMaintenance,
  heartbeatUpdateClient,
  readUpdateResumeIntent,
  readUpdateReturn,
  updateCleanupAutoHideMs,
  type UpdateReturnRecord,
  type UpdateReturnStatus,
} from "@/lib/update-maintenance-client";

export interface AppShellProps {
  /** Optional auxiliary override; native AuxiliaryDeck is the default. */
  auxiliaryDeck?: ReactNode;
  /** Optional usage/models override; it renders inside the auxiliary panel. */
  resourcePanel?: ReactNode;
}

type SessionCopyField = "file" | "id";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

// The command palette and the compact drawer hand focus to their first control;
// the palette traps Tab inside, the drawer's background is inert instead.
const TRANSIENT_LAYER_FOCUSABLE_SELECTOR =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
function createAppSideChatStore() {
  try {
    return createSideChatHistoryStore(typeof window === "undefined" ? null : window.localStorage);
  } catch {
    return createSideChatHistoryStore(null);
  }
}

export function AppShell({
  auxiliaryDeck,
  resourcePanel,
}: AppShellProps = {}) {
  const router = useRouter();
  // Next widens `useSearchParams()` to `| null` for the whole app once a `pages/` route exists,
  // because there the router can render before the query is known. This component only ever runs
  // under the App Router, where the hook is declared to return the params themselves.
  const searchParams = useSearchParams() as ReadonlyURLSearchParams;
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { preference, toggleTheme } = useTheme();
  const themeLabelKey =
    preference === "light" ? "theme.light" : preference === "dark" ? "theme.dark" : "theme.auto";
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const notificationPermission = useNotificationPermission();
  const isCompactWorkspace = useIsCompactWorkspace();
  useViewportHeight();
  // Audio ownership lives here (not in ChatWindow) so a neutral attention tone can
  // also fire for tasks settling in a non-active workspace whose outcome and Main
  // identity are not available. ChatWindow receives the audio callbacks as props.
  const { soundEnabled, onSoundToggle, playCueSound, preloadCueSound, unlockAudio, soundEnabledRef } = useAudio();
  const usage = useUsageSnapshot();
  // 대화 기록의 계정 얼굴은 사용량 탭과 같은 목록에서 배정돼야 같은 계정이 같은 얼굴로
  // 보인다. 앱의 단일 사용량 구독을 여기서 한 번 흘려 넣고, 메시지들은 읽기만 한다.
  useSyncedAccountFaces(usage.state.data?.reports);
  const notifiedAttentionRequestIdsRef = useRef(new Set<string>());
  const handleBackgroundTaskDone = useCallback(() => {
    // 다른 workspace에서 끝난 작업은 어느 계정이 했는지 알 수 없다 — 캐릭터 없이 「결과 확인」
    // 태그로만 내보내고, 캐릭터를 모르므로 기존 중립 tone이 난다. 이 자리는 말풍선을 띄우지
    // 않으므로 소리를 끈 상태에서는 낼 것이 없다.
    if (soundEnabledRef.current) void playCueSound(null, "done");
  }, [playCueSound, soundEnabledRef]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [pendingSession, setPendingSession] = useState<SessionInfo | null>(null);
  const [preloadedSessionData, setPreloadedSessionData] = useState<SessionData | null>(null);
  const sessionPreloadRequestRef = useRef(0);
  const sessionPreloadAbortRef = useRef<AbortController | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [settingsConfigOpen, setSettingsConfigOpen] = useState(false);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);
  const [workspaceLayout, dispatchWorkspaceLayout] = useReducer(
    reduceWorkspaceLayout,
    DEFAULT_WORKSPACE_LAYOUT_STATE,
  );
  const [resourceTab, setResourceTab] = useState<ResourceTab>("characters");
  const [efficiencyTab, setEfficiencyTab] = useState<WorkspaceEfficiencyTab>("governor");
  const [pinDecision, setPinDecision] = useState(() => getWorkspacePinDecision(0));
  const [sideChatStore] = useState(createAppSideChatStore);
  // 진행 중 /btw 요청의 소유권. 덱이 닫히거나 반응형으로 이동해 패널이
  // 언마운트돼도 이 인스턴스는 유지되므로, 다시 열린 패널이 같은 flight에
  // 재부착해 진행 표시·중단·중복 전송 차단을 이어간다.
  const [sideChatFlights] = useState(createSideChatFlightRegistry);
  const [fullSessions, setFullSessions] = useState<SessionInfo[]>([]);
  const [sideChatSessionCensus, setSideChatSessionCensus] = useState<SideChatSessionCensus>({
    sessions: [],
    complete: false,
  });
  const [sessionBusy, setSessionBusy] = useState(false);
  const [mainWaiting, setMainWaiting] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const composerFocusRef = useRef<(() => void) | null>(null);
  const commandPaletteRef = useRef<HTMLDivElement>(null);
  const requestComposerFocus = useCallback(() => {
    setComposerFocusRequest((request) => request + 1);
  }, []);
  const registerComposerFocus = useCallback((focus: (() => void) | null) => {
    composerFocusRef.current = focus;
  }, []);
  const maintenanceEnteredRef = useRef(false);
  // 재시작 중에는 서버가 receipt를 쓸 수 없어 heartbeat가 그냥 실패한다. 한 번이라도 성공한 뒤
  // 연속으로 실패하면 끊긴 화면 대신 재시작 대기 화면을 띄우고, 다시 성공하면 새 빌드로 새로고침한다.
  const [serverRestarting, setServerRestarting] = useState(false);
  const serverRestartingRef = useRef(false);
  const heartbeatOkRef = useRef(false);
  const heartbeatFailuresRef = useRef(0);
  // 처음 본 서버 식별값. 세션 전환으로 effect가 다시 돌아도 유지해야 재시작만 골라낸다.
  const serverBootIdRef = useRef<string | null>(null);
  // 복귀한 탭이 가리키는 직전 업데이트와 그 정리 상태. 별도 polling을 만들지 않고
  // 아래 heartbeat가 같은 주기로 실제 receipt 값을 받아 온다.
  const [updateReturn, setUpdateReturn] = useState<UpdateReturnRecord | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateReturnStatus | null>(null);
  const updateReturnRef = useRef<UpdateReturnRecord | null>(null);
  const updateSettledRef = useRef(false);
  updateReturnRef.current = updateReturn;
  useEffect(() => {
    setUpdateReturn(readUpdateReturn());
  }, []);
  useEffect(() => {
    let disposed = false;
    let preservationError: string | null = null;
    const attemptEnter = (state: {
      phase?: string;
      requestId?: string;
      stageHash?: string;
    }) => {
      if (
        disposed
        || maintenanceEnteredRef.current
        || state.phase === "IDLE"
        || !state.requestId
        || !state.stageHash
      ) return;
      const resumeUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const entered = enterUpdateMaintenance({
        requestId: state.requestId,
        stageHash: state.stageHash,
        sessionId: selectedSession?.id ?? null,
        resumeUrl,
      });
      if (entered.entered) {
        maintenanceEnteredRef.current = true;
        return;
      }
      preservationError = entered.error;
    };
    const heartbeat = async () => {
      if (disposed || maintenanceEnteredRef.current) return;
      try {
        const followed = updateSettledRef.current ? null : updateReturnRef.current;
        const state = await heartbeatUpdateClient({
          sessionId: selectedSession?.id ?? null,
          resumeUrl: `${window.location.pathname}${window.location.search}${window.location.hash}`,
          preservationError,
          update: followed ? { requestId: followed.requestId, stageHash: followed.stageHash } : null,
        });
        heartbeatFailuresRef.current = 0;
        const bootChanged = Boolean(state.serverBootId && serverBootIdRef.current && state.serverBootId !== serverBootIdRef.current);
        if (serverRestartingRef.current || bootChanged) {
          // 재시작이 짧아 대기 화면이 뜨지 않았어도 서버가 바뀌었으면 새 빌드·새 연결로 다시 연다.
          window.location.reload();
          return;
        }
        if (state.serverBootId) serverBootIdRef.current = state.serverBootId;
        heartbeatOkRef.current = true;
        if (!disposed && state.update) {
          setUpdateStatus(state.update);
          // 정리가 끝났으면 같은 값을 계속 읽지 않는다. 표시는 이 상태로 유지된다.
          if (state.update.cleanup && state.update.cleanup.status !== "running") updateSettledRef.current = true;
        }
        attemptEnter(state);
      } catch {
        // 일시적인 heartbeat 실패는 다음 주기에 다시 읽는다. 사용자 action은 재전송하지 않는다.
        heartbeatFailuresRef.current += 1;
        if (!disposed && heartbeatOkRef.current && heartbeatFailuresRef.current >= 2) {
          serverRestartingRef.current = true;
          setServerRestarting(true);
        }
      }
    };
    const onMaintenance = (event: Event) => {
      attemptEnter((event as CustomEvent<{
        phase?: string;
        requestId?: string;
        stageHash?: string;
      }>).detail ?? {});
      if (preservationError) void heartbeat();
    };
    window.addEventListener("ompweb:update-maintenance", onMaintenance);
    void heartbeat();
    const timer = window.setInterval(() => void heartbeat(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("ompweb:update-maintenance", onMaintenance);
    };
  }, [selectedSession?.id]);

  // 정리가 끝난 상태 줄은 스스로 사라진다. 실패 줄도 예외가 아니며, 실패 증거는 배포
  // receipt에 남으므로 화면에서 사라져도 유실되지 않는다. 진행 중에는 타이머를 걸지 않는다.
  const updateReturnRequestId = updateReturn?.requestId ?? null;
  const updateReturnDismissed = updateReturn?.dismissed ?? true;
  const updateStatusRequestId = updateStatus?.requestId ?? null;
  const updateDeploymentCompleted = updateStatus?.deploymentCompleted ?? false;
  const updateCleanupStatus = updateStatus?.cleanup?.status ?? null;
  useEffect(() => {
    if (!updateReturnRequestId || updateReturnDismissed) return;
    if (updateStatusRequestId !== updateReturnRequestId || !updateDeploymentCompleted) return;
    const autoHideMs = updateCleanupAutoHideMs(updateCleanupStatus);
    if (autoHideMs === null) return;
    const timer = window.setTimeout(() => {
      setUpdateReturn(dismissUpdateReturn(updateReturnRequestId));
    }, autoHideMs);
    return () => window.clearTimeout(timer);
  }, [
    updateReturnRequestId,
    updateReturnDismissed,
    updateStatusRequestId,
    updateDeploymentCompleted,
    updateCleanupStatus,
  ]);

  useEffect(() => {
    const intent = readUpdateResumeIntent();
    if (!intent || (intent.sessionId && selectedSession?.id !== intent.sessionId)) return;
    let disposed = false;
    void confirmUpdateResume(intent)
      .then(() => {
        if (disposed) return;
        // confirmUpdateResume이 이번 request를 복귀 기록으로 남긴다. 그 기록을 읽어
        // 상단 상태 줄이 같은 request의 정리 상태를 이어서 표시한다.
        updateSettledRef.current = false;
        setUpdateReturn(readUpdateReturn());
        setRefreshKey((key) => key + 1);
        setGitRefreshKey((key) => key + 1);
      })
      .catch(() => {
        // exact service/session 확인 전에는 receipt를 쓰지 않는다. heartbeat가 다음 상태를 유지한다.
      });
    return () => {
      disposed = true;
    };
  }, [selectedSession?.id]);

  const handleCommandPaletteKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const container = commandPaletteRef.current;
    if (!container) return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(TRANSIENT_LAYER_FOCUSABLE_SELECTOR));
    if (focusable.length === 0) return;
    const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
    const active = document.activeElement;
    if (active !== edge && container.contains(active)) return;
    event.preventDefault();
    (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
  }, []);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  // Crossing the pin boundary is not a drawer gesture. Without this flag the
  // breakpoint swap between pinned and drawer geometry starts the transform /
  // opacity transitions, and a frame rastered while they run paints a partly
  // slid drawer on top of the header and the transcript.
  const [sidebarModeShift, setSidebarModeShift] = useState(false);
  const sidebarOpenRef = useRef(sidebarOpen);
  const compactSidebarOpenRef = useRef(false);
  const pinnedSidebarOpenRef = useRef(true);
  const previousCompactWorkspaceRef = useRef<boolean | null>(null);
  sidebarOpenRef.current = sidebarOpen;
  // One decision for every navigator consumer. The open state alone is not the
  // presentation: a compact shell paints the drawer off-screen until the client
  // has answered the pin question, so the trigger, the scrim, the resize handle
  // and the inert background must not claim an open navigator that is not on
  // screen.
  const navigatorPresentation = getNavigatorPresentation({
    clientPainted: mobileSidebarReady,
    compactWorkspace: isCompactWorkspace,
    requestedOpen: sidebarOpen,
  });
  // The compact drawer's two facts move together: the open state the shell
  // paints, and the navigator-drawer layer that the toggle, Escape and the
  // focus handoff act on. A close that clears only the state leaves the layer
  // behind, and the next toggle then reads the layer and closes again.
  const setCompactDrawerOpen = useCallback((open: boolean) => {
    compactSidebarOpenRef.current = open;
    setSidebarOpen(open);
    dispatchWorkspaceLayout(
      open ? { type: "open-layer", layer: "navigator-drawer" } : { type: "close-layer" },
    );
  }, []);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const priorDrawerRef = useRef(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen: false,
        rightPanelWidth: 0,
      }),
    [],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "omp-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  // Drawer and pinned modes remember their own navigator state. This prevents
  // hydration from flashing the drawer and preserves an intentional desktop
  // collapse when the shell crosses the content-derived pin boundary.
  useEffect(() => {
    const previousCompact = previousCompactWorkspaceRef.current;
    if (previousCompact === isCompactWorkspace) return;
    setSidebarModeShift(true);
    if (previousCompact !== null) {
      if (previousCompact) {
        compactSidebarOpenRef.current = sidebarOpenRef.current;
      } else {
        pinnedSidebarOpenRef.current = sidebarOpenRef.current;
      }
    }
    previousCompactWorkspaceRef.current = isCompactWorkspace;
    const restoredOpen = isCompactWorkspace
      ? compactSidebarOpenRef.current
      : pinnedSidebarOpenRef.current;
    if (isCompactWorkspace) {
      // The restored drawer owns the navigator-drawer layer from here on;
      // leaving the layer unset would swallow the first toggle.
      setCompactDrawerOpen(restoredOpen);
    } else {
      setSidebarOpen(restoredOpen);
    }
    // Two frames: the first paints the swapped geometry, the second releases
    // the transition so a later user toggle still slides.
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setSidebarModeShift(false));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [isCompactWorkspace, setCompactDrawerOpen]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  // Presenting the compact drawer is a mode change for the keyboard: the
  // drawer covers the trigger and the background region goes inert, so focus
  // moves into the drawer while it is up. Closing it leaves the keyboard
  // nowhere, because the control that had focus is inert, so the trigger takes
  // it back only once no one else has: the close paths that ask for the
  // composer, and the dialogs the drawer opens, both land two frames later.
  useEffect(() => {
    const wasDrawer = priorDrawerRef.current;
    priorDrawerRef.current = navigatorPresentation.drawer;
    if (navigatorPresentation.drawer) {
      const panel = sidebarResizer.panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const frame = requestAnimationFrame(() => {
        panel.querySelector<HTMLElement>(TRANSIENT_LAYER_FOCUSABLE_SELECTOR)?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!wasDrawer) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        sidebarToggleRef.current?.focus();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [navigatorPresentation.drawer, sidebarResizer.panelRef]);
  useEffect(() => {
    reclampSidebarWidth();
  }, [reclampSidebarWidth, workspaceLayout.activeView]);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const updateDecision = (width: number) => {
      setPinDecision((current) => {
        const next = getWorkspacePinDecision(width);
        return current.navigator === next.navigator && current.deck === next.deck
          ? current
          : next;
      });
    };
    updateDecision(shell.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") updateDecision(width);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!composerFocusRequest) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => composerFocusRef.current?.());
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [composerFocusRequest]);
  useEffect(() => {
    if (workspaceLayout.transientLayer !== "command-palette") return;
    const container = commandPaletteRef.current;
    if (!container) return;
    const frame = requestAnimationFrame(() => {
      container.querySelector<HTMLElement>(TRANSIENT_LAYER_FOCUSABLE_SELECTOR)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [workspaceLayout.transientLayer]);
  useEffect(() => {
    if (isCompactWorkspace || workspaceLayout.transientLayer !== "navigator-drawer") return;
    dispatchWorkspaceLayout({ type: "close-layer" });
  }, [isCompactWorkspace, workspaceLayout.transientLayer]);
  useEffect(() => {
    const controller = new AbortController();
    setSideChatSessionCensus((current) => ({ ...current, complete: false }));
    void fetch("/api/sessions", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { sessions?: SessionInfo[] };
        if (!Array.isArray(data.sessions)) throw new Error("Invalid session census");
        setFullSessions(data.sessions);
        setSideChatSessionCensus({
          sessions: data.sessions.map((session) => ({ id: session.id, modified: session.modified })),
          complete: true,
        });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load the complete session census:", error);
      });
    return () => controller.abort();
  }, [refreshKey, selectedSession?.id]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  /**
   * Branch navigator state, attributed to the session it came from. `leafId` is
   * the session's current leaf, which advances on every ordinary append, so it
   * is display data only. `navigation` counts deliberate branch switches within
   * one session and is what identity-sensitive consumers key on: the
   * first branch identity for a session is not a switch, and a session's own
   * appends must not invalidate anything.
   */
  interface BranchState {
    sessionId: string | null;
    tree: SessionTreeNode[];
    leafId: string | null;
    navigation: number;
  }
  const [branchState, setBranchState] = useState<BranchState>({
    sessionId: null,
    tree: [],
    leafId: null,
    navigation: 0,
  });
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    branchLeafChangeFnRef.current = onLeafChange;
    setBranchState((prev) => {
      const sessionId = activeSessionIdRef.current;
      // A different session's data replaces the state outright: the previous
      // session's leaf is never carried into the new selection.
      if (prev.sessionId !== sessionId) return { sessionId, tree, leafId: activeLeafId, navigation: 0 };
      return { ...prev, tree, leafId: activeLeafId };
    });
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    // A reader-driven branch switch is the only leaf move that changes identity,
    // and re-picking the leaf that is already active is not a switch.
    setBranchState((prev) => (
      prev.leafId === leafId ? prev : { ...prev, navigation: prev.navigation + 1 }
    ));
    branchLeafChangeFnRef.current?.(leafId);
  }, []);



  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, shown in the session panel
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [subagents, setSubagents] = useState<SubagentSnapshot[]>([]);
  // 상단 상태줄용 SubAgent 동시 실행 상한. 설정 화면에서만 바뀌므로 마운트 시 1회만 읽는다.
  const [subagentCap, setSubagentCap] = useState<number | null>(null);
  // ChatWindow가 들고 있는 blocking extension 다이얼로그의 열림 여부. 열려 있는 동안만 "입력필요".
  const [mainNeedsInput, setMainNeedsInput] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as {
          fields?: Array<{ path?: string; value?: unknown; defaultValue?: unknown }>;
        };
        const field = data.fields?.find((item) => item.path === "task.maxConcurrency");
        const raw = field?.value ?? field?.defaultValue;
        const cap = typeof raw === "number"
          ? raw
          : typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
        // 0은 Unlimited이므로 상한 미상과 같게 두고 분모를 붙이지 않는다.
        if (!controller.signal.aborted && Number.isFinite(cap) && cap > 0) setSubagentCap(cap);
      })
      .catch(() => {
        // 상한은 장식용 정보다. 설정 조회가 실패하면 미상으로 남기고 조용히 지나간다.
      });
    return () => controller.abort();
  }, []);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);
  useEffect(() => () => sessionPreloadAbortRef.current?.abort(), []);

  // Context usage — populated by ChatWindow, shown in the header indicator
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Work log behind the transcript - published by ChatWindow, rendered by the
  // process view inside the single auxiliary panel.
  const [processLog, setProcessLog] = useState<ProcessLogData | null>(null);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "session" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [lastPanelView, setLastPanelView] = useState<WorkspacePanelViewId>("subagents");

  const selectWorkspaceView = useCallback((view: WorkspaceViewId, restoreFocus = false) => {
    dispatchWorkspaceLayout({ type: "select-view", view });
    setActiveTopPanel(null);
    if (isCompactWorkspace) setCompactDrawerOpen(false);
    if (restoreFocus || view === "chat") requestComposerFocus();
  }, [isCompactWorkspace, requestComposerFocus, setCompactDrawerOpen]);

  const toggleWorkspaceLayer = useCallback((layer: "command-palette") => {
    const closing = workspaceLayout.transientLayer === layer;
    setActiveTopPanel(null);
    // The palette shares the one transient layer slot with the compact drawer.
    // Ending the drawer in front of this toggle clears the layer the toggle
    // reads, so an open palette would re-open instead of closing; the drawer
    // yields only while it is the layer this toggle is about to replace.
    if (isCompactWorkspace && workspaceLayout.transientLayer === "navigator-drawer") {
      setCompactDrawerOpen(false);
    }
    dispatchWorkspaceLayout({ type: "toggle-layer", layer });
    if (closing) requestComposerFocus();
  }, [isCompactWorkspace, requestComposerFocus, setCompactDrawerOpen, workspaceLayout.transientLayer]);

  // The auxiliary panel toggle returns to the view the operator last used, so
  // closing and reopening it does not reset their place in the workspace.
  const toggleAuxiliaryPanel = useCallback(() => {
    if (workspaceLayout.activeView !== "chat") {
      setLastPanelView(workspaceLayout.activeView as WorkspacePanelViewId);
      selectWorkspaceView("chat", true);
      return;
    }
    selectWorkspaceView(lastPanelView, true);
  }, [lastPanelView, selectWorkspaceView, workspaceLayout.activeView]);

  const closeTopWorkspaceLayer = useCallback((): boolean => {
    if (projectTrustDialogOpen) {
      if (!projectTrustBusy) {
        setProjectTrustDialogOpen(false);
        requestComposerFocus();
      }
      return true;
    }
    if (settingsConfigOpen) {
      setSettingsConfigOpen(false);
      requestComposerFocus();
      return true;
    }
    if (moreMenuOpen) {
      setMoreMenuOpen(false);
      requestComposerFocus();
      return true;
    }
    if (activeTopPanel) {
      setActiveTopPanel(null);
      requestComposerFocus();
      return true;
    }
    if (workspaceLayout.transientLayer) {
      if (workspaceLayout.transientLayer === "navigator-drawer") setCompactDrawerOpen(false);
      dispatchWorkspaceLayout({ type: "close-layer" });
      requestComposerFocus();
      return true;
    }
    if (workspaceLayout.activeView !== "chat") {
      dispatchWorkspaceLayout({ type: "select-view", view: "chat" });
      requestComposerFocus();
      return true;
    }
    return false;
  }, [
    moreMenuOpen,
    activeTopPanel,
    projectTrustBusy,
    projectTrustDialogOpen,
    requestComposerFocus,
    setCompactDrawerOpen,
    settingsConfigOpen,
    workspaceLayout.activeView,
    workspaceLayout.transientLayer,
  ]);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "session") => {
    dispatchWorkspaceLayout({ type: "close-layer" });
    if (isCompactWorkspace) setCompactDrawerOpen(false);
    setActiveTopPanel((current) => current === panel ? null : panel);
  }, [isCompactWorkspace, setCompactDrawerOpen]);

  const openSessionStatsPanel = useCallback(() => {
    dispatchWorkspaceLayout({ type: "close-layer" });
    if (isCompactWorkspace) setCompactDrawerOpen(false);
    setActiveTopPanel("session");
  }, [isCompactWorkspace, setCompactDrawerOpen]);

  const handleSidebarToggle = useCallback(() => {
    setActiveTopPanel(null);
    if (isCompactWorkspace) {
      const opening = workspaceLayout.transientLayer !== "navigator-drawer";
      setCompactDrawerOpen(opening);
      if (!opening) requestComposerFocus();
      return;
    }
    dispatchWorkspaceLayout({ type: "close-layer" });
    setSidebarOpen((open) => {
      const next = !open;
      pinnedSidebarOpenRef.current = next;
      return next;
    });
  }, [isCompactWorkspace, requestComposerFocus, setCompactDrawerOpen, workspaceLayout.transientLayer]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      setTopPanelPos({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel]);

  // File tabs are rendered in the AuxiliaryDeck's existing FileViewer slot.
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const returnToComposer = useCallback(() => {
    if (pinDecision.deck === "view-stack") {
      dispatchWorkspaceLayout({ type: "select-view", view: "chat" });
    }
    if (isCompactWorkspace) setCompactDrawerOpen(false);
    requestComposerFocus();
  }, [isCompactWorkspace, pinDecision.deck, requestComposerFocus, setCompactDrawerOpen]);

  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
    returnToComposer();
  }, [returnToComposer]);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
    returnToComposer();
  }, [returnToComposer]);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  useTheme({
    cwd: selectedSession?.cwd ?? newSessionCwd ?? activeCwd,
    syncWithOmp: true,
  });
  const activeProjectRootRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  // Guards the async workspace restore so a slow response from an earlier
  // switch cannot resurrect a session into a project the user already left.
  const workspaceRestoreTokenRef = useRef(0);

  const invalidateWorkspaceRestore = useCallback(() => {
    workspaceRestoreTokenRef.current += 1;
  }, []);

  // Persist every active-session transition, including new and forked sessions
  // that bypass the sidebar selection handler. Transient sessions do not yet
  // carry projectRoot, so use the active project identity until hydration.
  useEffect(() => {
    if (!selectedSession) return;
    const projectKey = selectedSession.projectRoot
      ?? activeProjectRootRef.current
      ?? selectedSession.cwd;
    setLastOpenSession(projectKey, selectedSession.id);
  }, [selectedSession]);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  // Restore the workspace's last open session after switching to it. Called
  // from handleCwdChange once the outgoing context has been reset. The session
  // is looked up against the live list so a deleted or drifted session falls
  // back to the default welcome page instead of erroring.
  const restoreWorkspaceContext = useCallback((projectKey: string) => {
    const token = ++workspaceRestoreTokenRef.current;
    const lastOpenSessionId = getLastOpenSession(projectKey);
    if (!lastOpenSessionId) return;
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        if (token !== workspaceRestoreTokenRef.current) return; // stale switch
        const s = d?.sessions.find((x) => x.id === lastOpenSessionId);
        if (!s) {
          // The list loaded but the remembered session is gone — forget it.
          // When the list itself failed (d === null) keep the memory so a
          // later switch retries the restore.
          if (d) clearLastOpen(projectKey);
          return;
        }
        if ((s.projectRoot ?? s.cwd) !== projectKey) {
          // Defensive: the remembered session drifted out of this workspace.
          clearLastOpen(projectKey);
          return;
        }
        // Selecting the session must remount the chat with the session
        // present: useAgentSession loads content in a mount-only effect, so
        // the null-session welcome mount from the switch would never load
        // the restored session's messages.
        setSelectedSession(s);
        setSessionKey((k) => k + 1);
        if (new URLSearchParams(window.location.search).get("session") !== s.id) {
          router.replace(`?session=${encodeURIComponent(s.id)}`, { scroll: false });
        }
      })
      .catch(() => {
        // Network hiccup: keep the remembered session for a later retry.
      });
  }, [router]);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null) => {
    sessionPreloadRequestRef.current += 1;
    sessionPreloadAbortRef.current?.abort();
    sessionPreloadAbortRef.current = null;
    setPendingSession(null);
    setPreloadedSessionData(null);
    invalidateWorkspaceRestore();
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const newProject = projectRoot ?? cwd;
    const currentProject = activeProjectRootRef.current
      ?? (selectedSession ? (selectedSession.projectRoot ?? selectedSession.cwd) : null);
    activeProjectRootRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    if (currentProject === newProject) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchState({ sessionId: null, tree: [], leafId: null, navigation: 0 });
    setSystemPrompt(null);
    setActiveTopPanel(null);
    // File tabs are keyed by absolute path, so tabs opened in the previous
    // project would otherwise linger after switching to a different project.
    // Reached only past the same-project early return above, so worktrees of
    // one repo keep their open tabs.
    setFileTabs([]);
    setActiveFileTabId(null);
    dispatchWorkspaceLayout({ type: "select-view", view: "chat" });
    // Restore the workspace we switched to: its last open session, or keep
    // the default welcome page when none is remembered.
    restoreWorkspaceContext(newProject);
    router.replace("/", { scroll: false });
  }, [router, selectedSession, invalidateWorkspaceRestore, restoreWorkspaceContext]);

  const commitSessionSelection = useCallback((session: SessionInfo, isRestore: boolean, initialData: SessionData | null) => {
    setNewSessionCwd(null);
    setPreloadedSessionData(initialData);
    setSelectedSession(session);
    // The selection owns its branch identity: the previous session's tree and
    // leaf go out with it, and nothing is consumed until this session's own
    // branch data arrives.
    setBranchState({ sessionId: session.id, tree: [], leafId: null, navigation: 0 });
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    // Collapse the drawer after selection so the transcript is revealed.
    if (isCompactWorkspace && !isRestore) {
      setCompactDrawerOpen(false);
      dispatchWorkspaceLayout({ type: "select-view", view: "chat" });
    }
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar.
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop.
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [isCompactWorkspace, router, setCompactDrawerOpen]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    // Mark the target project before the cwd synchronization effect runs.
    // Otherwise selecting a session in another project looks like a manual
    // project switch and the just-selected session is cleared.
    activeProjectRootRef.current = session.projectRoot ?? session.cwd;
    invalidateWorkspaceRestore();
    // Re-clicking the already-open session cancels any pending transition
    // without remounting the chat or re-running its positioning cycle.
    if (!isRestore && selectedSession) {
      const sameProject =
        (selectedSession.projectRoot ?? selectedSession.cwd) ===
        (session.projectRoot ?? session.cwd);
      if (selectedSession.id === session.id && sameProject) {
        sessionPreloadRequestRef.current += 1;
        sessionPreloadAbortRef.current?.abort();
        sessionPreloadAbortRef.current = null;
        setPendingSession(null);
        if (isCompactWorkspace) setCompactDrawerOpen(false);
        return;
      }
    }
    if (!isRestore && pendingSession?.id === session.id) return;

    sessionPreloadRequestRef.current += 1;
    const requestId = sessionPreloadRequestRef.current;
    sessionPreloadAbortRef.current?.abort();

    // Initial restore/welcome transitions have no outgoing transcript to keep.
    if (isRestore || !selectedSession) {
      sessionPreloadAbortRef.current = null;
      setPendingSession(null);
      commitSessionSelection(session, isRestore, null);
      return;
    }

    const controller = new AbortController();
    sessionPreloadAbortRef.current = controller;
    setPendingSession(session);
    const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
    void fetch(`/api/sessions/${encodeURIComponent(session.id)}?${params}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as SessionData;
        if (data.sessionId !== session.id) throw new Error("Session preload returned the wrong session");
        if (sessionPreloadRequestRef.current !== requestId) return;
        commitSessionSelection(session, false, data);
      })
      .catch((error) => {
        if (controller.signal.aborted || sessionPreloadRequestRef.current !== requestId) return;
        console.error("Failed to preload session before switching:", error);
        commitSessionSelection(session, false, null);
      })
      .finally(() => {
        if (sessionPreloadRequestRef.current !== requestId) return;
        sessionPreloadAbortRef.current = null;
        setPendingSession(null);
      });
  }, [commitSessionSelection, invalidateWorkspaceRestore, isCompactWorkspace, pendingSession?.id, selectedSession, setCompactDrawerOpen]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    sessionPreloadRequestRef.current += 1;
    sessionPreloadAbortRef.current?.abort();
    sessionPreloadAbortRef.current = null;
    setPendingSession(null);
    setPreloadedSessionData(null);
    invalidateWorkspaceRestore();
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchState({ sessionId: null, tree: [], leafId: null, navigation: 0 });
    setSystemPrompt(null);
    setActiveTopPanel(null);
    dispatchWorkspaceLayout({ type: "select-view", view: "chat" });
    if (isCompactWorkspace) setCompactDrawerOpen(false);
    router.replace("/", { scroll: false });
  }, [invalidateWorkspaceRestore, isCompactWorkspace, router, setCompactDrawerOpen]);

  const navigateProjectSession = useCallback((direction: -1 | 1) => {
    const projectRoot = selectedSession?.projectRoot
      ?? activeProjectRootRef.current
      ?? selectedSession?.cwd
      ?? activeCwd;
    if (!projectRoot || !selectedSession) return;
    const projectSessions = fullSessions.filter((session) => (
      (session.projectRoot ?? session.cwd) === projectRoot
    ));
    const currentIndex = projectSessions.findIndex((session) => session.id === selectedSession.id);
    if (currentIndex < 0) return;
    const nextSession = projectSessions[currentIndex + direction];
    if (!nextSession) return;
    setActiveTopPanel(null);
    dispatchWorkspaceLayout({ type: "close-layer" });
    handleSelectSession(nextSession);
    requestComposerFocus();
  }, [activeCwd, fullSessions, handleSelectSession, requestComposerFocus, selectedSession]);

  const cycleWorkspaceView = useCallback((direction: -1 | 1) => {
    const currentIndex = WORKSPACE_VIEW_IDS.indexOf(workspaceLayout.activeView);
    const nextIndex = (currentIndex + direction + WORKSPACE_VIEW_IDS.length) % WORKSPACE_VIEW_IDS.length;
    selectWorkspaceView(WORKSPACE_VIEW_IDS[nextIndex], true);
  }, [selectWorkspaceView, workspaceLayout.activeView]);

  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    onToggleCommandPalette: () => toggleWorkspaceLayer("command-palette"),
    onToggleNavigator: handleSidebarToggle,
    onToggleResources: () => selectWorkspaceView(
      workspaceLayout.activeView === "resource" ? "chat" : "resource",
      true,
    ),
    onSelectView: (view) => selectWorkspaceView(view, true),
    onCycleView: cycleWorkspaceView,
    onNavigateSession: navigateProjectSession,
    onEscape: closeTopWorkspaceLayer,
    enabled: !settingsConfigOpen && !projectTrustDialogOpen,
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (
          prev?.id === sessionId
            ? { ...prev, ...full, transient: full.transient ?? false }
            : prev
        ));
      })
      .catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from omp
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    invalidateWorkspaceRestore();
    setNewSessionCwd(null);
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const deliverSessionNotification = useCallback(({
    targetSession,
    title,
    body,
    tag,
  }: {
    targetSession: SessionInfo | null;
    title: string;
    body: string;
    tag?: string;
  }) => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    const fire = () => {
      const sessionUrl = targetSession ? `/?session=${encodeURIComponent(targetSession.id)}` : "/";
      void showBrowserNotification({
        title,
        body,
        sessionUrl,
        tag,
        onClick: () => {
          window.focus();
          if (targetSession) handleSelectSession(targetSession);
        },
      });
    };

    fire();
  }, [handleSelectSession]);

  const handleAgentEnd = useCallback((completion: AgentCompletionResult) => {
    setRefreshKey((k) => k + 1);
    setGitRefreshKey((k) => k + 1);
    if (selectedSession) hydrateSelectedSession(selectedSession.id);

    if (completion.outcome !== "completed" || !shouldShowBrowserNotification()) return;
    const targetSession = selectedSession;
    deliverSessionNotification({
      targetSession,
      title: targetSession?.name ?? translate("i18n.sessionComplete"),
      body: translate("i18n.taskFinished"),
    });
  }, [deliverSessionNotification, hydrateSelectedSession, selectedSession, translate]);

  const handleAttentionNeeded = useCallback((request: BlockingExtensionUiRequest) => {
    if (!shouldShowBrowserNotification()) return;
    if (!claimExtensionAttentionNotification(request, notifiedAttentionRequestIdsRef.current)) return;

    deliverSessionNotification({
      targetSession: selectedSession,
      title: translate("i18n.attentionNeeded"),
      body: request.method === "custom"
        ? translate("i18n.extensionInputNeeded")
        : request.title,
      tag: `pi-extension-ui:${request.id}`,
    });
  }, [deliverSessionNotification, selectedSession, translate]);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleSessionForked = useCallback((newSessionId: string) => {
    invalidateWorkspaceRestore();
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      transient: false,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    invalidateWorkspaceRestore();
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchState({ sessionId: null, tree: [], leafId: null, navigation: 0 });
      setSystemPrompt(null);
      setActiveTopPanel(null);
      dispatchWorkspaceLayout({ type: "select-view", view: "chat" });
      requestComposerFocus();
      router.replace("/", { scroll: false });
    }
  }, [invalidateWorkspaceRestore, requestComposerFocus, selectedSession, router]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff" },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) {
        return [...prev, {
          id: tabId,
          label: fileName,
          filePath,
          sourceSessionId,
          initialDisplayMode: modeHint,
        }];
      }
      const sourceUnchanged = !sourceSessionId || existing.sourceSessionId === sourceSessionId;
      const modeUnchanged = !modeHint || existing.initialDisplayMode === modeHint;
      if (sourceUnchanged && modeUnchanged) return prev;
      return prev.map((t) => {
        if (t.id !== tabId) return t;
        const next: Tab = { ...t };
        if (sourceSessionId) next.sourceSessionId = sourceSessionId;
        if (modeHint) next.initialDisplayMode = modeHint;
        return next;
      });
    });
    setActiveFileTabId(tabId);
    dispatchWorkspaceLayout({ type: "select-view", view: "files" });
    setActiveTopPanel(null);
    if (isCompactWorkspace) setCompactDrawerOpen(false);
  }, [isCompactWorkspace, setCompactDrawerOpen]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    const remaining = fileTabs.filter((tab) => tab.id !== tabId);
    setFileTabs(remaining);
    setActiveFileTabId((current) => {
      if (current !== tabId) return current;
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
    if (remaining.length === 0 && workspaceLayout.activeView === "files") {
      selectWorkspaceView("chat", true);
    }
  }, [fileTabs, selectWorkspaceView, workspaceLayout.activeView]);


  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const showAuxiliaryDeck = workspaceLayout.activeView !== "chat";
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      requestComposerFocus();
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd, requestComposerFocus]);

  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const sessionTitle = selectedSession?.name?.trim()
    || selectedSession?.firstMessage?.trim()
    || (effectiveNewSessionCwd ? translate("i18n.newSession") : activeCwdName)
    || "CUELO";
  const normalizedSessionTitle = sessionTitle.replace(/\s+/g, " ").trim();
  const boundedSessionTitle = normalizedSessionTitle.length > 96
    ? `${normalizedSessionTitle.slice(0, 93)}…`
    : normalizedSessionTitle;
  const windowTitle = activeCwdName
    ? `${boundedSessionTitle} — ${activeCwdName} — CUELO`
    : `${boundedSessionTitle} — CUELO`;
  // Only document.title carries the 96-char cap; the tooltip must stay readable in full.
  // 상태줄이 상태 요약만 표시하게 되어, 세션 부가정보(경로/메모리 전용 여부)는 여기로 모은다.
  const sessionIdentityBase = activeCwdName
    ? `${normalizedSessionTitle} — ${activeCwdName}`
    : normalizedSessionTitle;
  const sessionIdentityTooltip = selectedSession?.transient
    ? `${sessionIdentityBase} · ${translate("session.inMemory")}`
    : sessionIdentityBase;
  const liveSubagentCount = subagents.filter(
    (snapshot) => snapshot.status === "pending" || snapshot.status === "running",
  ).length;
  // 상태 우선순위: 사용자 응답 대기 > 의존성 대기 > 실행 중 > 사용자 입력 대기.
  const mainStatusGlyph = mainNeedsInput ? "⚠" : mainWaiting ? "○" : sessionBusy ? "●" : "○";
  const mainStatusLabel = mainNeedsInput
    ? translate("workspace.mainAttention")
    : mainWaiting
      ? translate("workspace.mainWaiting")
      : sessionBusy
        ? translate("workspace.mainWorking")
        : translate("workspace.mainIdle");
  // 상한을 모르거나 0(Unlimited)이면 분모 없이 실행 수만 적는다.
  const mainStatusSummary =
    `${mainStatusGlyph} Main ${mainStatusLabel} · Sub ${liveSubagentCount}${subagentCap ? `/${subagentCap}` : ""}`;

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);
  const viewLabels: Record<WorkspaceViewId, string> = locale === "ko"
    ? { chat: "대화", process: "작업 과정", efficiency: "효율", subagents: "서브에이전트", files: "파일", resource: "캐릭터", sidechat: "사이드챗" }
    : { chat: "Chat", process: "Process", efficiency: "Efficiency", subagents: "Subagents", files: "Files", resource: "캐릭터", sidechat: "Side Chat" };
  const panelOpen = workspaceLayout.activeView !== "chat";
  const activePanelLabel = panelOpen
    ? viewLabels[workspaceLayout.activeView]
    : viewLabels[lastPanelView];
  // One context indicator. The number carries the meaning; the bar and the
  // level only reinforce it, so colour is never the sole signal.
  const contextIndicator = getContextIndicator(contextUsage);
  const contextReadout = contextIndicator.readout;
  const contextTitle = contextReadout
    ? translate("chat.contextUsageTitle", {
      used: contextIndicator.usedLabel,
      limit: contextIndicator.limitLabel,
      percent: contextIndicator.percentLabel,
    })
    : null;
  const contextStatus = contextIndicator.level === "critical"
    ? translate("chat.contextUsageCritical")
    : contextIndicator.level === "warning"
      ? translate("chat.contextUsageWarning")
      : null;
  const autoNameBlock = autoNameBlockReason(selectedSession, sessionStats?.userMessages);
  const autoNameDisabledReason = autoNameBlock === "unsaved"
    ? translate("title.unsaved")
    : autoNameBlock === "no-messages" ? translate("title.noMessages") : null;
  const autoNameHint = autoNameDisabledReason
    ?? (autoNameStatus.kind === "error" ? autoNameStatus.message : null);
  const autoNameLabel = autoNameStatus.kind === "naming"
    ? translate("title.generating")
    : autoNameStatus.kind === "success"
      ? translate("title.updated")
      : autoNameStatus.kind === "error"
        ? translate("title.failed")
        : translate("title.generate");
  const fileViewerSlot = (
    <div id="workspace-file-view" className="workspace-file-view">
      <div className="workspace-file-tabs">
        <TabBar
          tabs={fileTabs}
          activeTabId={activeFileTabId ?? ""}
          onSelectTab={setActiveFileTabId}
          onCloseTab={handleCloseFileTab}
        />
      </div>
      <div className="workspace-file-content">
        {activeFileTab?.filePath ? (
          <FileViewer
            filePath={activeFileTab.filePath}
            cwd={activeCwd ?? undefined}
            sourceSessionId={activeFileTab.sourceSessionId}
            gitRefreshKey={gitRefreshKey}
            initialDisplayMode={activeFileTab.initialDisplayMode}
            onMentionLines={handleFileLineMention}
            onAtMention={handleAtMention}
            onOpenFile={(filePath) => handleOpenFile(
              filePath,
              getFileName(filePath),
              { sourceSessionId: activeFileTab.sourceSessionId },
            )}
          />
        ) : (
          <div className="workspace-file-empty">{translate("files.noneOpen")}</div>
        )}
      </div>
    </div>
  );
  const nativeResourcePanel = (
    <ResourcePanel
      open={workspaceLayout.activeView === "resource"}
      sessionId={selectedSession?.id ?? null}
      activeTab={resourceTab}
      onTabChange={setResourceTab}
      usage={usage}
    />
  );
  const resourcePanelContent = resourcePanel ?? nativeResourcePanel;
  const efficiencyPanelContent = (
    <EfficiencyPanel
      open={workspaceLayout.activeView === "efficiency"}
      sessionId={selectedSession?.id ?? null}
      activeTab={efficiencyTab}
      onTabChange={setEfficiencyTab}
    />
  );
  const processLogSlot = (
    <ProcessLogPanel
      title={viewLabels.process}
      data={processLog}
      onOpenFile={handleOpenLinkedFile}
    />
  );
  // The app's one side-chat surface. The store and the flight registry stay
  // at this level so an in-flight /btw request outlives the panel: closing
  // it or moving the deck only unmounts this slot, while the registry keeps
  // the AbortController and the streamed text. A reopened panel resubscribes
  // to the same flight, so progress display, abort, and duplicate-send
  // blocking continue; tab switches keep it mounted (the deck hides inactive
  // tabs in place), so even the live bubble never drops.
  const sideChatSlot = (
    <SideChatPanel
      title={viewLabels.sidechat}
      sessionId={selectedSession?.id ?? null}
      sessionPath={selectedSession?.path ?? null}
      sessionName={selectedSession?.name}
      historyStore={sideChatStore}
      flights={sideChatFlights}
      sessionCensus={sideChatSessionCensus}
      visible={workspaceLayout.activeView === "sidechat"}
    />
  );
  const nativeAuxiliaryDeck = showAuxiliaryDeck ? (
    <AuxiliaryDeck
      activeView={workspaceLayout.activeView as AuxiliaryDeckView}
      onViewChange={(view) => selectWorkspaceView(view)}
      viewLabels={viewLabels}
      sessionId={selectedSession?.id ?? null}
      sessionPath={selectedSession?.path ?? null}
      sessionName={selectedSession?.name}
      sessionCwd={selectedSession?.cwd ?? effectiveNewSessionCwd ?? undefined}
      liveSubagents={subagents}
      processSlot={processLogSlot}
      fileSlot={fileViewerSlot}
      sideChatSlot={sideChatSlot}
      resourceSlot={resourcePanelContent}
      efficiencySlot={efficiencyPanelContent}
      visible
      onClose={() => dispatchWorkspaceLayout({ type: "select-view", view: "chat" })}
      onReturnFocus={requestComposerFocus}
    />
  ) : null;
  const auxiliaryDeckContent = auxiliaryDeck ?? nativeAuxiliaryDeck;

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={pendingSession?.id ?? selectedSession?.id ?? null}
        optimisticSession={pendingSession ?? selectedSession}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onBackgroundTaskDone={handleBackgroundTaskDone}
      />
      {/* Managed builds disable upstream update polling; updates are promoted by CUELO_Setup. */}
      <div className="navigator-footer" style={{ padding: "8px", flexShrink: 0 }}>
        <SidebarUsage
          usage={usage}
          onOpen={() => {
            setResourceTab("usage");
            selectWorkspaceView("resource", false);
          }}
        />
        <button
          className="navigator-settings-action"
          onClick={() => {
            setActiveTopPanel(null);
            dispatchWorkspaceLayout({ type: "close-layer" });
            if (isCompactWorkspace) setCompactDrawerOpen(false);
            setSettingsConfigOpen(true);
          }}
          title={translate("common.settings")}
          style={{
            width: "100%", height: 34, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: "none", border: "1px solid var(--border)", borderRadius: 9,
            color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
            fontFamily: "var(--font-mono)", transition: "background 0.12s, color 0.12s, border-color 0.12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.borderColor = "var(--text-dim)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.borderColor = "var(--border)"; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.39.33.74.6 1 .3.28.69.42 1.1.4h.09v4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
          </svg>
          {translate("common.settings")}
        </button>
      </div>
    </>
  );

  // 상단 업데이트 상태 줄. 배포 완료가 확인된 request에만 붙고, 정리 진행/완료/실패를
  // 같은 줄에서 구분한다. 정리가 끝난 줄은 닫으면 그 request에서 다시 뜨지 않는다.
  const updateBannerStatus = updateReturn && updateStatus
    && updateStatus.requestId === updateReturn.requestId
    && updateStatus.deploymentCompleted
    ? updateStatus
    : null;
  const updateBannerCleanup = updateBannerStatus?.cleanup ?? null;
  const updateBanner = updateBannerStatus && !updateReturn?.dismissed
    ? describeUpdateCleanup(updateBannerCleanup)
    : null;

  return (
    <>
    {serverRestarting ? (
      <div className="server-restart-overlay" role="status" aria-live="polite">
        <div className="server-restart-card">
          <div className="server-restart-spinner" aria-hidden="true" />
          <strong>{translate("restart.title")}</strong>
          <span>{translate("restart.body")}</span>
        </div>
      </div>
    ) : null}
    <div
      ref={shellRef}
      className="workspace-shell"
      data-active-view={workspaceLayout.activeView}
      data-deck-mode={pinDecision.deck}
      data-deck-visible={showAuxiliaryDeck}
    >
      {/* Navigator drawer backdrop */}
      <div
        aria-hidden="true"
        className={`sidebar-overlay-backdrop${navigatorPresentation.drawer ? " is-open" : ""}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarModeShift ? " sidebar-mode-shift" : ""}`}
        onClick={() => {
          setCompactDrawerOpen(false);
          requestComposerFocus();
        }}
      />
      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        className={`sidebar-container${navigatorPresentation.laidOut ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarModeShift ? " sidebar-mode-shift" : ""}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        aria-hidden={isCompactWorkspace && !navigatorPresentation.presented}
        inert={isCompactWorkspace && !navigatorPresentation.presented}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {navigatorPresentation.laidOut && (
        <div
          {...sidebarResizer.separatorProps}
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div
        className="workspace-session-region"
        data-active-view={workspaceLayout.activeView}
        // While the drawer is presented it is the only reachable surface: the
        // background keeps its paint but leaves the tab order and the
        // accessibility tree, so focus stays in the drawer until it closes.
        aria-hidden={navigatorPresentation.drawer}
        inert={navigatorPresentation.drawer}
      >
        <div ref={topBarRef} className="workspace-header-stack">
          {updateBanner && updateReturn && (
            <div className="workspace-update-banner" data-tone={updateBanner.tone} role="status" aria-live="polite">
              <span className="workspace-update-banner-title">{updateBanner.title}</span>
              <span className="workspace-update-banner-detail">{updateBanner.detail}</span>
              {updateBanner.dismissible && (
                <button
                  type="button"
                  className="workspace-update-banner-dismiss"
                  onClick={() => setUpdateReturn(dismissUpdateReturn(updateReturn.requestId))}
                  aria-label="업데이트 상태 알림 닫기"
                >
                  닫기
                </button>
              )}
            </div>
          )}
          <NotificationPermission variant="banner" locale={locale} {...notificationPermission} />
          <header className="workspace-header-seam">
            <ActionButton
              ref={sidebarToggleRef}
              className="workspace-header-nav-toggle"
              variant="ghost"
              size="small"
              layout="iconOnly"
              type="button"
              onClick={handleSidebarToggle}
              aria-controls="session-sidebar"
              aria-expanded={navigatorPresentation.presented}
              title={navigatorPresentation.presented ? translate("sidebar.hide") : translate("sidebar.show")}
              aria-label={navigatorPresentation.presented ? translate("sidebar.hide") : translate("sidebar.show")}
            >
              {navigatorPresentation.presented ? (
                <Icon
                  size="16px"
                  svg={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
                    </svg>
                  }
                />
              ) : (
                <Icon
                  size="18px"
                  svg={
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
                    </svg>
                  }
                />
              )}
            </ActionButton>
            <div className="workspace-session-identity" title={sessionIdentityTooltip}>
              <strong>{boundedSessionTitle}</strong>
              <span aria-live="polite">{mainStatusSummary}</span>
            </div>
            {/* Title generation reports through the menu label; keep one live region mounted. */}
            <span className="sr-only" role="status">
              {autoNameStatus.kind === "error" ? autoNameStatus.message : ""}
            </span>
            {showChat && projectTrust?.requiresTrust && !projectTrust.trusted && (
              <ActionButton
                className="workspace-header-action"
                variant="ghost"
                size="small"
                color="fg.warning"
                type="button"
                onClick={() => {
                  setProjectTrustError(null);
                  setActiveTopPanel(null);
                  dispatchWorkspaceLayout({ type: "close-layer" });
                  setProjectTrustDialogOpen(true);
                }}
                title={translate("trust.resourcesNotLoaded")}
                aria-label={translate("trust.resourcesNotLoaded")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                  <path d="M12 8v4" />
                  <path d="M12 16h.01" />
                </svg>
                {!isCompactWorkspace && <span>{translate("trust.resourcesNotLoaded")}</span>}
              </ActionButton>
            )}
            {showChat && contextReadout && (
              <ActionButton
                className="workspace-context-usage"
                variant="ghost"
                size="small"
                type="button"
                onClick={openSessionStatsPanel}
                aria-expanded={activeTopPanel === "session"}
                title={contextTitle ?? translate("session.title")}
                aria-label={contextStatus ? `${contextTitle}. ${contextStatus}` : contextTitle ?? undefined}
              >
                <span className="workspace-context-meter" aria-hidden="true">
                  <span
                    className="workspace-context-meter-fill"
                    data-level={contextIndicator.level}
                    style={{ inlineSize: `${contextIndicator.fillPercent}%` }}
                  />
                </span>
                <span className="workspace-context-readout" data-level={contextIndicator.level}>{contextReadout}</span>
              </ActionButton>
            )}
            {showChat && (
              <ToggleButton
                className="workspace-panel-toggle"
                variant="neutralWeak"
                size="small"
                pressed={panelOpen}
                onPressedChange={toggleAuxiliaryPanel}
                aria-controls="workspace-auxiliary-panel"
                title={locale === "ko" ? "보조 패널" : "Auxiliary panel"}
              >
                {activePanelLabel}
              </ToggleButton>
            )}
            <Menu.Root
              open={moreMenuOpen}
              onOpenChange={(open) => setMoreMenuOpen(open)}
              placement="bottom-end"
            >
              <Menu.Trigger asChild>
                <ActionButton
                  className="workspace-header-more"
                  variant="ghost"
                  size="small"
                  layout="iconOnly"
                  type="button"
                  title={locale === "ko" ? "더 보기" : "More"}
                  aria-label={locale === "ko" ? "더 보기" : "More"}
                >
                  <Icon
                    size="16px"
                    svg={
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
                      </svg>
                    }
                  />
                </ActionButton>
              </Menu.Trigger>
              <Menu.Positioner>
                <Menu.Content aria-label={locale === "ko" ? "세션 및 환경 메뉴" : "Session and environment menu"}>
                  <Menu.ScrollArea>
                    <Menu.Group>
                      <Menu.GroupLabel>{locale === "ko" ? "세션" : "Session"}</Menu.GroupLabel>
                      <Menu.Item onClick={openSessionStatsPanel}>
                        <Menu.ItemBody><Menu.ItemLabel>{translate("session.title")}</Menu.ItemLabel></Menu.ItemBody>
                      </Menu.Item>
                      <Menu.Item
                        onClick={handleViewFullHistory}
                        disabled={!selectedSession}
                      >
                        <Menu.ItemBody>
                          <Menu.ItemLabel>{translate("history.label")}</Menu.ItemLabel>
                          {!selectedSession && (
                            <Menu.ItemDescription>{translate("history.unsaved")}</Menu.ItemDescription>
                          )}
                        </Menu.ItemBody>
                      </Menu.Item>
                      <Menu.Item
                        onClick={() => void handleAutoName()}
                        disabled={autoNameDisabledReason !== null || autoNameStatus.kind === "naming"}
                      >
                        <Menu.ItemBody>
                          <Menu.ItemLabel>{autoNameLabel}</Menu.ItemLabel>
                          {autoNameHint && (
                            <Menu.ItemDescription>{autoNameHint}</Menu.ItemDescription>
                          )}
                        </Menu.ItemBody>
                      </Menu.Item>
                      <Menu.Item onClick={() => toggleTopPanel("branches")}>
                        <Menu.ItemBody><Menu.ItemLabel>{translate("i18n.branches")}</Menu.ItemLabel></Menu.ItemBody>
                      </Menu.Item>
                      <Menu.Item onClick={() => toggleTopPanel("system")}>
                        <Menu.ItemBody><Menu.ItemLabel>{translate("system.label")}</Menu.ItemLabel></Menu.ItemBody>
                      </Menu.Item>
                    </Menu.Group>
                    <Menu.Group>
                      <Menu.GroupLabel>{locale === "ko" ? "환경" : "Environment"}</Menu.GroupLabel>
                      <NotificationPermission variant="menu" locale={locale} {...notificationPermission} />
                      <Menu.Item
                        onClick={(event) => {
                          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                          toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                        }}
                      >
                        <Menu.ItemBody><Menu.ItemLabel>{translate(themeLabelKey)}</Menu.ItemLabel></Menu.ItemBody>
                      </Menu.Item>
                      {supportedLocales.map((plugin) => (
                        <Menu.Item
                          key={plugin.id}
                          role="menuitemradio"
                          aria-checked={locale === plugin.id}
                          onClick={() => setLocale(plugin.id as typeof locale)}
                        >
                          <Menu.ItemBody><Menu.ItemLabel>{plugin.label}</Menu.ItemLabel></Menu.ItemBody>
                        </Menu.Item>
                      ))}
                      <Menu.Item
                        onClick={() => {
                          setActiveTopPanel(null);
                          dispatchWorkspaceLayout({ type: "close-layer" });
                          if (isCompactWorkspace) setCompactDrawerOpen(false);
                          setSettingsConfigOpen(true);
                        }}
                      >
                        <Menu.ItemBody><Menu.ItemLabel>{translate("common.settings")}</Menu.ItemLabel></Menu.ItemBody>
                      </Menu.Item>
                    </Menu.Group>
                  </Menu.ScrollArea>
                </Menu.Content>
              </Menu.Positioner>
            </Menu.Root>
          </header>
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px - var(--omp-dock-h, 204px) - 8px)`,
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "branches" && (
                <div className="workspace-top-panel" aria-label={translate("i18n.branches")}>
                  <BranchNavigator
                    tree={branchState.sessionId === (selectedSession?.id ?? null) ? branchState.tree : []}
                    activeLeafId={branchState.sessionId === (selectedSession?.id ?? null) ? branchState.leafId : null}
                    onLeafChange={handleBranchLeafChange}
                    hasSession={Boolean(selectedSession)}
                  />
                </div>
              )}
              {activeTopPanel === "system" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("system.empty")}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("system.load")}
                    </div>
                  )}
                </div>
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const formatDuration = (ms: number) => {
                      if (ms <= 0) return "0s";
                      const totalSec = Math.floor(ms / 1000);
                      const h = Math.floor(totalSec / 3600);
                      const m = Math.floor((totalSec % 3600) / 60);
                      const s = totalSec % 60;
                      if (h > 0) return `${h}h ${m}m`;
                      if (m > 0) return `${m}m ${s}s`;
                      return `${s}s`;
                    };
                    const totalActiveMs = sessionStats.totalActiveMs ?? 0;
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                       ...(totalActiveMs > 0 ? [{ label: translate("session.totalActive"), value: formatDuration(totalActiveMs), copyField: null }] : []),
                    ];
                    const messageRows = [
                       [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                       [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                       [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                       [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                       [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                       [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                       [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                       ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                       ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                       [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.tokens !== null ? formatCompact(ctx.tokens) : "?"} / ${formatCompact(ctx.contextWindow)}${ctx.percent !== null ? ` · ${ctx.percent.toFixed(1)}%` : ""}`]] : []),
                       // Cache hit rate = cache reads / (input + cache writes + cache reads) — the denominator covers all input-class tokens.
                       ...(sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0 && sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input > 0
                         ? [[translate("session.cacheHitRate"), `${(sessionStats.tokens.cacheRead / (sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input) * 100).toFixed(1)}%`]]
                         : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                           title={copied ? translate("session.copied") : translate(field === "file" ? "session.copyFile" : "session.copyId")}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                         <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isCompactWorkspace
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isCompactWorkspace ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        {sessionInfoSection}
                         {section(translate("session.messages"), messageRows)}
                         {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Chat content */}
        <div className="chat-content-layout">
          <div id="workspace-transcript" className="chat-session-column">
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              newSessionCwd={effectiveNewSessionCwd}
              initialSessionData={preloadedSessionData}
              transitioning={pendingSession !== null}
              onAgentEnd={handleAgentEnd}
              onAttentionNeeded={handleAttentionNeeded}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onContextUsageChange={handleContextUsageChange}
              onSubagentsChange={setSubagents}
              onProcessLogChange={setProcessLog}
              onOpenFile={handleOpenLinkedFile}
              transcriptReplacement={
                pinDecision.deck === "view-stack" && showAuxiliaryDeck ? (
                  <aside id="workspace-auxiliary-panel" className="workspace-auxiliary-deck-slot is-replacement" data-workspace-region="deck">
                    {auxiliaryDeckContent}
                  </aside>
                ) : null
              }
              onComposerFocusChange={registerComposerFocus}
              onSessionBusyChange={setSessionBusy}
              onWaitingChange={setMainWaiting}
              onAttentionChange={setMainNeedsInput}
              soundEnabled={soundEnabled}
              onSoundToggle={onSoundToggle}
              playCueSound={playCueSound}
              preloadCueSound={preloadCueSound}
              unlockAudio={unlockAudio}
            />
          ) : showAuxiliaryDeck && pinDecision.deck === "view-stack" ? (
            <aside id="workspace-auxiliary-panel" className="workspace-auxiliary-deck-slot is-replacement" data-workspace-region="deck">
              {auxiliaryDeckContent}
            </aside>
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--danger)" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                 {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                   <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
          </div>
          {pinDecision.deck === "pinned" && showAuxiliaryDeck && (
            <aside id="workspace-auxiliary-panel" className="workspace-auxiliary-deck-slot is-pinned" data-workspace-region="deck">
              {auxiliaryDeckContent}
            </aside>
          )}
        </div>
      </div>
      {workspaceLayout.transientLayer === "command-palette" && (
        <div
          className="workspace-command-layer"
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            dispatchWorkspaceLayout({ type: "close-layer" });
            requestComposerFocus();
          }}
        >
          <div
            ref={commandPaletteRef}
            className="workspace-command-palette"
            role="dialog"
            aria-modal="true"
            onKeyDown={handleCommandPaletteKeyDown}
            aria-label={locale === "ko" ? "명령 팔레트" : "Command palette"}
          >
            <header>
              <strong>{locale === "ko" ? "명령 팔레트" : "Command palette"}</strong>
              <kbd>Ctrl K</kbd>
            </header>
            <div className="workspace-command-list">
              {WORKSPACE_VIEW_IDS.map((view) => (
                <button key={view} type="button" onClick={() => selectWorkspaceView(view, true)}>
                  <span>{viewLabels[view]}</span>
                  <small>{workspaceLayout.activeView === view ? (locale === "ko" ? "현재 보기" : "Current view") : ""}</small>
                </button>
              ))}
              {WORKSPACE_RESOURCE_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setResourceTab(tab);
                    selectWorkspaceView("resource", false);
                  }}
                >
                  <span>{tab === "characters" ? "캐릭터" : tab === "usage" ? "계정 한도" : "모델 통계"}</span>
                  <small>{viewLabels.resource}</small>
                </button>
              ))}
              <button type="button" onClick={handleSidebarToggle}>
                <span>{navigatorPresentation.presented ? translate("sidebar.hide") : translate("sidebar.show")}</span>
                <small>Ctrl B</small>
              </button>
              <button
                type="button"
                onClick={() => {
                  dispatchWorkspaceLayout({ type: "close-layer" });
                  setSettingsConfigOpen(true);
                }}
              >
                <span>{translate("common.settings")}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    {settingsConfigOpen && (
      <SettingsConfig
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        onClose={() => {
          setSettingsConfigOpen(false);
          requestComposerFocus();
        }}
        onModelsChanged={() => setModelsRefreshKey((key) => key + 1)}
        onReloaded={() => setSessionKey((key) => key + 1)}
      />
    )}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (projectTrustBusy) return;
          setProjectTrustDialogOpen(false);
          requestComposerFocus();
        }}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    </>
  );
}
