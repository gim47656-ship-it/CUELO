"use client";

import type { ReactNode } from "react";
import { ActionButton, Badge, Icon, Menu, Tabs } from "@seed-design/react";
import type { SubagentSnapshot } from "@/lib/types";
import type { HanseSubagentClient } from "@/lib/hanse-subagent-client";
import type { WorkspacePanelViewId } from "@/lib/workspace-layout";
import type { MakerSelection } from "@/components/answer-status/AnswerStatusContext";
import { useI18n } from "@/hooks/useI18n";
import { SubagentArchivePanel } from "./SubagentArchivePanel";
import { PanelExpandContext, PanelExpandToggle, type PanelExpandState } from "./PanelHeader";

/**
 * The inspector's views. `turn` (이번 턴) is the inspector's own view of the selected turn; it is not a
 * workspace view id, so it never takes a Ctrl+number alias. The shell shows it while the workspace view
 * is the conversation.
 */
export type AuxiliaryDeckView = WorkspacePanelViewId | "turn";

/** The segmented control's views, in order; the rest open from the overflow menu. */
const PRIMARY_VIEWS: ReadonlyArray<AuxiliaryDeckView> = ["turn", "process", "subagents", "files"];
const OVERFLOW_VIEWS: ReadonlyArray<AuxiliaryDeckView> = ["efficiency", "resource", "sidechat", "plugins", "memory"];

/** 자기 머리줄(PanelHeader)이 없는 보기. 이 보기에서만 넓게 보기 토글을 탭 줄에 둔다. */
const HEADERLESS_VIEWS: ReadonlySet<AuxiliaryDeckView> = new Set<AuxiliaryDeckView>(["efficiency", "sidechat", "resource"]);

export interface AuxiliaryDeckProps {
  activeView: AuxiliaryDeckView;
  onViewChange: (view: AuxiliaryDeckView) => void;
  /** Destination labels, shared with the view switcher so both seams stay in one language. */
  viewLabels: Record<AuxiliaryDeckView, string>;
  sessionId: string | null;
  sessionPath: string | null;
  sessionName?: string;
  sessionCwd?: string;
  liveSubagents: readonly SubagentSnapshot[];
  subagentClient?: HanseSubagentClient;
  /** 이번 턴: the selected turn's summary, flow, dispatches and changes (ChatWindow portals into it). */
  turnSlot: ReactNode;
  /** The work log behind the transcript: thinking, tool calls, process notices. */
  processSlot: ReactNode;
  fileSlot: ReactNode;
  /** Side chat. Lives in this panel so no second side-chat surface exists. */
  sideChatSlot: ReactNode;
  /** Usage and models. Lives in this panel so no second auxiliary surface exists. */
  resourceSlot: ReactNode;
  /** Run history and config comparison. Lives in this panel so no second auxiliary surface exists. */
  efficiencySlot: ReactNode;
  /** Plugin Lab: trial and promoted plugins and their sandboxed panels. */
  pluginsSlot: ReactNode;
  /** Memory trace: how the selected session found memories and doc-map documents. */
  memorySlot: ReactNode;
  visible?: boolean;
  onClose?: () => void;
  /** Accessible name of the close button: the pinned inspector hides, a stacked one returns to the conversation. */
  closeLabel?: string;
  onReturnFocus?: () => void;
  /** 고정 자리에 있을 때만 준다. 없으면 넓게 보기 토글을 그리지 않는다. */
  expand?: PanelExpandState | null;
  /** 셸이 든 Maker 상세 선택. 발주 카드와 Subagents 목록이 같은 값을 쓴다. */
  selectedMaker?: MakerSelection | null;
  onSelectMaker?: (selection: MakerSelection | null) => void;
  onReturnToDispatch?: (origin: string) => void;
  onOpenFile?: (filePath: string) => void;
  /** 파일 보기에 열린 파일이 있어 그 머리줄이 넓게 보기 토글을 든다. 없으면 탭 줄이 든다. */
  fileOpen?: boolean;
}

export function AuxiliaryDeck({
  activeView,
  onViewChange,
  viewLabels,
  sessionId,
  sessionPath,
  sessionName,
  sessionCwd,
  liveSubagents,
  subagentClient,
  turnSlot,
  processSlot,
  fileSlot,
  sideChatSlot,
  resourceSlot,
  efficiencySlot,
  pluginsSlot,
  memorySlot,
  visible = true,
  onClose,
  closeLabel,
  onReturnFocus,
  expand = null,
  selectedMaker,
  onSelectMaker,
  onReturnToDispatch,
  onOpenFile,
  fileOpen = false,
}: AuxiliaryDeckProps) {
  const { t } = useI18n();
  const closeDeck = () => {
    onClose?.();
    onReturnFocus?.();
  };
  // An overflow view that is open joins the segmented control, so the selected view is always named there.
  const listedViews = OVERFLOW_VIEWS.includes(activeView) ? [...PRIMARY_VIEWS, activeView] : PRIMARY_VIEWS;

  return (
    <PanelExpandContext.Provider value={expand}>
    <aside
      className="auxiliary-deck"
      aria-label={t("inspector.label")}
      data-auxiliary-view={activeView}
      data-expanded={expand?.expanded ? "true" : undefined}
    >
      <Tabs.Root
        className="auxiliary-deck-tabs"
        size="small"
        contentLayout="fill"
        triggerLayout="hug"
        value={activeView}
        onValueChange={(value) => onViewChange(value as AuxiliaryDeckView)}
      >
        <div className="auxiliary-deck-tabbar">
          <Tabs.List aria-label={t("inspector.views")}>
            {listedViews.map((view) => {
              // 진행 중(pending|running)인 SubAgent만 센다. 완료/실패는 아카이브 패널의 몫이다.
              const liveCount = view === "subagents"
                ? liveSubagents.filter((snapshot) => snapshot.status === "pending" || snapshot.status === "running").length
                : 0;
              return (
                <Tabs.Trigger
                  key={view}
                  value={view}
                  aria-label={liveCount > 0 ? `${viewLabels[view]} (${t("workbench.runningCount", { count: liveCount })})` : undefined}
                >
                  <span className="auxiliary-deck-tab-label">{viewLabels[view]}</span>
                  {liveCount > 0 && (
                    <Badge size="medium" variant="weak" tone="neutral" aria-hidden="true">
                      {liveCount}
                    </Badge>
                  )}
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
          <Menu.Root placement="bottom-end" strategy="fixed">
            <Menu.Trigger asChild>
              <ActionButton
                className="auxiliary-deck-more"
                variant="ghost"
                size="small"
                layout="iconOnly"
                aria-label={t("inspector.more")}
                title={t("inspector.more")}
              >
                <Icon size="16px" svg={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>} />
              </ActionButton>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content aria-label={t("inspector.more")}>
                <Menu.Group>
                  {OVERFLOW_VIEWS.map((view) => (
                    <Menu.Item
                      key={view}
                      role="menuitemradio"
                      aria-checked={activeView === view}
                      onClick={() => onViewChange(view)}
                    >
                      <Menu.ItemBody><Menu.ItemLabel>{viewLabels[view]}</Menu.ItemLabel></Menu.ItemBody>
                    </Menu.Item>
                  ))}
                </Menu.Group>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
          {(HEADERLESS_VIEWS.has(activeView) || (activeView === "files" && !fileOpen)) && <PanelExpandToggle className="auxiliary-deck-expand" />}
          {onClose && (
            <ActionButton
              className="auxiliary-deck-close"
              variant="ghost"
              size="small"
              layout="iconOnly"
              onClick={closeDeck}
              aria-label={closeLabel ?? t("inspector.hide")}
              title={closeLabel ?? t("inspector.hide")}
            >
              <Icon size="16px" svg={<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>} />
            </ActionButton>
          )}
        </div>

        <Tabs.Content value="turn" className="auxiliary-deck-panel">
          {turnSlot}
        </Tabs.Content>

        <Tabs.Content value="process" className="auxiliary-deck-panel">
          {processSlot}
        </Tabs.Content>

        <Tabs.Content value="efficiency" className="auxiliary-deck-panel">
          {efficiencySlot}
        </Tabs.Content>

        <Tabs.Content value="subagents" className="auxiliary-deck-panel">
          <SubagentArchivePanel
            title={viewLabels.subagents}
            sessionId={sessionId}
            sessionPath={sessionPath}
            sessionCwd={sessionCwd}
            liveSubagents={liveSubagents}
            client={subagentClient}
            visible={visible && activeView === "subagents"}
            selection={selectedMaker}
            onSelectionChange={onSelectMaker}
            onReturnToOrigin={onReturnToDispatch}
            onOpenFile={onOpenFile}
          />
        </Tabs.Content>

        <Tabs.Content value="files" className="auxiliary-deck-panel">
          {fileSlot}
        </Tabs.Content>
        <Tabs.Content value="sidechat" className="auxiliary-deck-panel">
          {sideChatSlot}
        </Tabs.Content>

        <Tabs.Content value="resource" className="auxiliary-deck-panel">
          {resourceSlot}
        </Tabs.Content>

        <Tabs.Content value="plugins" className="auxiliary-deck-panel">
          {pluginsSlot}
        </Tabs.Content>

        <Tabs.Content value="memory" className="auxiliary-deck-panel">
          {memorySlot}
        </Tabs.Content>
      </Tabs.Root>
    </aside>
    </PanelExpandContext.Provider>
  );
}
