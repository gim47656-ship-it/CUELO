"use client";

import type { ReactNode } from "react";
import { ActionButton, Badge, Icon, Tabs } from "@seed-design/react";
import type { SubagentSnapshot } from "@/lib/types";
import type { HanseSubagentClient } from "@/lib/hanse-subagent-client";
import { WORKSPACE_PANEL_VIEW_IDS, type WorkspacePanelViewId } from "@/lib/workspace-layout";
import type { MakerSelection } from "@/components/answer-status/AnswerStatusContext";
import { SubagentArchivePanel } from "./SubagentArchivePanel";
import { PanelExpandContext, PanelExpandToggle, type PanelExpandState } from "./PanelHeader";

export type AuxiliaryDeckView = WorkspacePanelViewId;

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
  /** The work log behind the transcript: thinking, tool calls, process notices. */
  processSlot: ReactNode;
  fileSlot: ReactNode;
  /** Side chat. Lives in this panel so no second side-chat surface exists. */
  sideChatSlot: ReactNode;
  /** Usage and models. Lives in this panel so no second auxiliary surface exists. */
  resourceSlot: ReactNode;
  /** Run history and config comparison. Lives in this panel so no second auxiliary surface exists. */
  efficiencySlot: ReactNode;
  visible?: boolean;
  onClose?: () => void;
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

const VIEW_ORDER: ReadonlyArray<AuxiliaryDeckView> = WORKSPACE_PANEL_VIEW_IDS;

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
  processSlot,
  fileSlot,
  sideChatSlot,
  resourceSlot,
  efficiencySlot,
  visible = true,
  onClose,
  onReturnFocus,
  expand = null,
  selectedMaker,
  onSelectMaker,
  onReturnToDispatch,
  onOpenFile,
  fileOpen = false,
}: AuxiliaryDeckProps) {
  const closeDeck = () => {
    onClose?.();
    onReturnFocus?.();
  };

  return (
    <PanelExpandContext.Provider value={expand}>
    <aside
      className="auxiliary-deck"
      aria-label="보조 패널"
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
          <Tabs.List aria-label="보조 패널 보기">
            {VIEW_ORDER.map((view) => {
              // 진행 중(pending|running)인 SubAgent만 센다. 완료/실패는 아카이브 패널의 몫이다.
              const liveCount = view === "subagents"
                ? liveSubagents.filter((snapshot) => snapshot.status === "pending" || snapshot.status === "running").length
                : 0;
              return (
                <Tabs.Trigger
                  key={view}
                  value={view}
                  aria-label={liveCount > 0 ? `${viewLabels[view]} (실행 중 ${liveCount})` : undefined}
                >
                  <span className="auxiliary-deck-tab-label">{viewLabels[view]}</span>
                  {liveCount > 0 && (
                    <Badge size="medium" variant="weak" tone="informative" aria-hidden="true">
                      {liveCount}
                    </Badge>
                  )}
                </Tabs.Trigger>
              );
            })}
            <Tabs.Indicator />
          </Tabs.List>
          {(HEADERLESS_VIEWS.has(activeView) || (activeView === "files" && !fileOpen)) && <PanelExpandToggle className="auxiliary-deck-expand" />}
          {onClose && (
            <ActionButton
              className="auxiliary-deck-close"
              variant="ghost"
              size="small"
              layout="iconOnly"
              onClick={closeDeck}
              aria-label="보조 패널 닫기"
            >
              <Icon size="16px" svg={<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>} />
            </ActionButton>
          )}
        </div>

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
      </Tabs.Root>
    </aside>
    </PanelExpandContext.Provider>
  );
}
