"use client";

import { createContext, useContext, type ReactNode, type Ref, type PointerEvent as ReactPointerEvent } from "react";
import { ActionButton, Icon, Menu, SegmentedControl } from "@seed-design/react";
import { useI18n } from "@/hooks/useI18n";

/**
 * 덱이 넓게 보기를 허용할 때만 채워지는 값. 덱이 고정(pinned)이 아니면 null이라 머리줄에 토글이 없다.
 */
export interface PanelExpandState {
  expanded: boolean;
  onToggle: () => void;
}

export const PanelExpandContext = createContext<PanelExpandState | null>(null);

export interface PanelHeaderAction {
  id: string;
  label: string;
  icon: ReactNode;
  /** 버튼과 넘침 메뉴가 같이 쓴다. 링크 동작이면 생략하고 href를 준다. */
  onClick?: () => void;
  href?: string;
  download?: string;
  title?: string;
  pressed?: boolean;
  disabled?: boolean;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
}

export interface PanelHeaderViewSwitch<V extends string> {
  label: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string; title?: string }>;
  onChange: (value: V) => void;
}

export interface PanelHeaderProps<V extends string = string> {
  back?: { label: string; onClick: () => void };
  title: ReactNode;
  /** 제목 위에 올렸을 때 보이는 전체 정보(파일이면 경로·언어·줄 수·크기). */
  titleTooltip?: string;
  /** 열릴 때 초점을 받을 제목. 제목 자체는 탭 순서에 들어가지 않는다(tabIndex -1). */
  titleRef?: Ref<HTMLHeadingElement>;
  /** 제목 바로 뒤에 붙는 작은 표시(파일의 실시간 반영 점 등). */
  titleAdornment?: ReactNode;
  subtitle?: string;
  /** 경로면 앞쪽을 줄여 끝(파일이 든 폴더)이 보이게 한다. */
  subtitleKind?: "text" | "path";
  state?: ReactNode;
  viewSwitch?: PanelHeaderViewSwitch<V>;
  actions?: readonly PanelHeaderAction[];
  close?: { label: string; onClick: () => void };
}

const EXPAND_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </svg>
);

const RESTORE_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" />
  </svg>
);

const BACK_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m10 3-5 5 5 5" />
  </svg>
);

const CLOSE_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);

const MORE_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" />
  </svg>
);

/** 넘침 메뉴에서 링크 동작(다운로드)을 고르면 같은 링크를 눌러 준다. */
function runAction(action: PanelHeaderAction) {
  if (action.onClick) {
    action.onClick();
    return;
  }
  if (!action.href) return;
  const link = document.createElement("a");
  link.href = action.href;
  if (action.download) link.download = action.download;
  link.click();
}

/**
 * 덱 안 보기마다 첫 줄에 놓는 한 줄 머리. 뒤로 · 제목 · 부제 · 상태 · 보기 전환 · 동작 · 넓게 보기 · 닫기 순서이며
 * 줄을 바꾸지 않는다. 좁아지면 부제가 먼저 사라지고, 그다음 동작이 넘침 메뉴로 들어가며, 제목은 마지막에 줄어든다.
 */
export function PanelHeader<V extends string = string>({
  back,
  title,
  titleTooltip,
  titleRef,
  titleAdornment,
  subtitle,
  subtitleKind = "text",
  state,
  viewSwitch,
  actions = [],
  close,
}: PanelHeaderProps<V>) {
  const { t } = useI18n();
  return (
    <header className="panel-header">
      {back && (
        <ActionButton className="panel-header-button" variant="ghost" size="small" layout="iconOnly" onClick={back.onClick} aria-label={back.label} title={back.label}>
          <Icon size="16px" svg={BACK_ICON} />
        </ActionButton>
      )}
      <div className="panel-header-heading">
        <h2 className="panel-header-title" title={titleTooltip} ref={titleRef} tabIndex={titleRef ? -1 : undefined}>{title}</h2>
        {titleAdornment}
        {subtitle && (
          subtitleKind === "path"
            ? <span className="panel-header-subtitle is-path" title={subtitle} dir="rtl"><bdi dir="ltr">{subtitle}</bdi></span>
            : <span className="panel-header-subtitle" title={subtitle}>{subtitle}</span>
        )}
      </div>
      {state && <div className="panel-header-state">{state}</div>}
      {viewSwitch && viewSwitch.options.length > 1 && (
        <SegmentedControl.Root
          className="panel-header-switch"
          aria-label={viewSwitch.label}
          value={viewSwitch.value}
          onValueChange={(value) => viewSwitch.onChange(value as V)}
        >
          {viewSwitch.options.map((option) => (
            <SegmentedControl.Item key={option.value} value={option.value} title={option.title}>
              <SegmentedControl.ItemHiddenInput />
              {option.label}
            </SegmentedControl.Item>
          ))}
          <SegmentedControl.Indicator />
        </SegmentedControl.Root>
      )}
      {actions.length > 0 && (
        <>
          <div className="panel-header-actions">
            {actions.map((action) => (action.href
              ? (
                <a
                  key={action.id}
                  className="panel-header-link-button"
                  href={action.href}
                  download={action.download}
                  aria-label={action.label}
                  title={action.title ?? action.label}
                >
                  {action.icon}
                </a>
              )
              : (
                <ActionButton
                  key={action.id}
                  className="panel-header-button"
                  variant="ghost"
                  size="small"
                  layout="iconOnly"
                  onClick={action.onClick}
                  onPointerDown={action.onPointerDown}
                  disabled={action.disabled}
                  aria-pressed={action.pressed}
                  aria-label={action.label}
                  title={action.title ?? action.label}
                >
                  <Icon size="16px" svg={action.icon} />
                </ActionButton>
              )))}
          </div>
          <Menu.Root placement="bottom-end" strategy="fixed">
            <Menu.Trigger asChild>
              <ActionButton className="panel-header-button panel-header-more" variant="ghost" size="small" layout="iconOnly" aria-label={t("panel.more")} title={t("panel.more")}>
                <Icon size="16px" svg={MORE_ICON} />
              </ActionButton>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content aria-label={t("panel.more")}>
                <Menu.ScrollArea>
                  <Menu.Group>
                    {actions.map((action) => (
                      <Menu.Item key={action.id} disabled={action.disabled} onClick={() => runAction(action)}>
                        <Menu.ItemBody>
                          <Menu.ItemLabel>{action.label}</Menu.ItemLabel>
                        </Menu.ItemBody>
                      </Menu.Item>
                    ))}
                  </Menu.Group>
                </Menu.ScrollArea>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
        </>
      )}
      <PanelExpandToggle />
      {close && (
        <ActionButton className="panel-header-button" variant="ghost" size="small" layout="iconOnly" onClick={close.onClick} aria-label={close.label} title={close.label}>
          <Icon size="16px" svg={CLOSE_ICON} />
        </ActionButton>
      )}
    </header>
  );
}

/**
 * 넓게 보기/원래 크기 토글. 머리줄이 있는 보기는 머리줄 안에, 머리줄이 없는 보기는 덱 탭 줄에 하나만 둔다.
 * 덱이 넓게 보기를 허용하지 않으면(고정 자리가 아님) 그리지 않는다.
 */
export function PanelExpandToggle({ className = "panel-header-button" }: { className?: string }) {
  const { t } = useI18n();
  const expand = useContext(PanelExpandContext);
  if (!expand) return null;
  const label = t(expand.expanded ? "panel.restore" : "panel.expand");
  return (
    <ActionButton
      className={className}
      data-panel-expand=""
      variant="ghost"
      size="small"
      layout="iconOnly"
      aria-pressed={expand.expanded}
      aria-label={label}
      title={label}
      onClick={expand.onToggle}
    >
      <Icon size="16px" svg={expand.expanded ? RESTORE_ICON : EXPAND_ICON} />
    </ActionButton>
  );
}
