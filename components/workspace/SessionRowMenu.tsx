"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SessionRowMenuItem {
  id: string;
  label: string;
  /** Shown as the item's title and makes it inert, e.g. why 옆에 열기 cannot work right now. */
  disabledReason?: string | null;
  onSelect: () => void;
}

interface SessionRowMenuProps {
  label: string;
  /** Pointer position of the right-click, in viewport pixels. */
  x: number;
  y: number;
  items: SessionRowMenuItem[];
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

/**
 * The right-click menu of a session row. It opens only when no plugin claimed the row's context
 * menu event. Arrow keys move, Enter or Space picks, Escape, Tab or a press elsewhere closes.
 */
export function SessionRowMenu({ label, x, y, items, onClose }: SessionRowMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Keep the whole menu inside the viewport, then put focus on the first item that can act.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - rect.width - VIEWPORT_MARGIN)),
      top: Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - rect.height - VIEWPORT_MARGIN)),
    });
    menu.querySelector<HTMLButtonElement>('button:not([aria-disabled="true"])')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([aria-disabled="true"])') ?? [])];
    if (buttons.length === 0) return;
    const current = buttons.findIndex((button) => button === document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length]?.focus();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="session-row-menu"
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top }}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          aria-disabled={item.disabledReason ? true : undefined}
          title={item.disabledReason ?? undefined}
          onClick={() => {
            if (item.disabledReason) return;
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
