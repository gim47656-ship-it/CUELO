"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import { clampPanelWidth } from "@/lib/panel-layout";

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
  target: HTMLDivElement;
  previousCursor: string;
  previousUserSelect: string;
}

interface UseResizablePanelOptions {
  ariaLabel: string;
  cssVariable: `--${string}`;
  defaultWidth: number;
  getDefaultWidth?: () => number;
  getMaxWidth: () => number;
  growthDirection: "left" | "right";
  maxWidth: number;
  minWidth: number;
  storageKey: string;
  widthRef: MutableRefObject<number>;
  /**
   * Without a stored width the panel follows getDefaultWidth whenever it re-clamps, and reset clears
   * the stored width instead of storing the default. Re-clamps never overwrite the stored width, so a
   * window that narrows for a while does not lose the width the user chose.
   */
  followDefault?: boolean;
  /** Adjusts each pointer-drag width (for example to snap); the result is clamped again. */
  snapWidth?: (width: number) => number;
  /** Every width the panel takes, including drag frames that do not re-render. */
  onLiveWidth?: (width: number) => void;
  /** Spoken value of the separator; defaults to "<width> px". */
  formatValueText?: (width: number) => string;
}

interface CommitOptions {
  forcePersist?: boolean;
  persist?: boolean;
}

function readStoredWidth(storageKey: string): number | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return null;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(storageKey: string, width: number): void {
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Resizing remains available when storage is unavailable.
  }
}

function clearStoredWidth(storageKey: string): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Without storage there is nothing to clear.
  }
}

export function useResizablePanel(options: UseResizablePanelOptions) {
  const {
    ariaLabel,
    cssVariable,
    defaultWidth,
    followDefault = false,
    formatValueText,
    getDefaultWidth,
    getMaxWidth,
    growthDirection,
    maxWidth,
    minWidth,
    onLiveWidth,
    snapWidth,
    storageKey,
    widthRef,
  } = options;
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const restoredRef = useRef(false);
  // followDefault only: the width the user chose (stored), or null while the panel follows its default.
  const preferredWidthRef = useRef<number | null>(null);
  // What a re-clamp goes back to: the chosen width when a following panel has one, else the width last committed.
  const reclampTargetRef = useRef(defaultWidth);
  const [width, setWidth] = useState(defaultWidth);
  const [separatorMaxWidth, setSeparatorMaxWidth] = useState(maxWidth);
  const [isResizing, setIsResizing] = useState(false);

  const effectiveMaxWidth = useCallback(
    () => Math.min(maxWidth, Math.max(minWidth, getMaxWidth())),
    [getMaxWidth, maxWidth, minWidth],
  );

  const clampWidth = useCallback(
    (candidate: number) => clampPanelWidth(candidate, minWidth, effectiveMaxWidth()),
    [effectiveMaxWidth, minWidth],
  );

  const applyLiveWidth = useCallback((nextWidth: number) => {
    widthRef.current = nextWidth;
    panelRef.current?.style.setProperty(cssVariable, `${nextWidth}px`);
    onLiveWidth?.(nextWidth);
  }, [cssVariable, onLiveWidth, widthRef]);

  const commitWidth = useCallback((candidate: number, commitOptions: CommitOptions = {}) => {
    const { forcePersist = false, persist = true } = commitOptions;
    // Measure geometry on layout changes and resize actions, not on unrelated shell renders.
    const limit = effectiveMaxWidth();
    setSeparatorMaxWidth(limit);
    const nextWidth = clampPanelWidth(candidate, minWidth, limit);
    const changed = nextWidth !== widthRef.current;
    applyLiveWidth(nextWidth);
    setWidth(nextWidth);
    // A following panel stores only explicit choices (drag, keys, a preset); re-clamps never store.
    const store = followDefault ? persist && forcePersist : persist && (changed || forcePersist);
    if (store) {
      writeStoredWidth(storageKey, nextWidth);
      if (followDefault) preferredWidthRef.current = nextWidth;
    }
    reclampTargetRef.current = preferredWidthRef.current ?? nextWidth;
    return nextWidth;
  }, [applyLiveWidth, effectiveMaxWidth, followDefault, minWidth, storageKey, widthRef]);

  const restoreBodyState = useCallback((drag: DragState) => {
    document.body.style.cursor = drag.previousCursor;
    document.body.style.userSelect = drag.previousUserSelect;
  }, []);

  const finishResize = useCallback((pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    restoreBodyState(drag);
    setIsResizing(false);
    // A press that never moved is not a width choice for a panel that follows its default.
    commitWidth(widthRef.current, { forcePersist: !followDefault || widthRef.current !== drag.startWidth });

    try {
      if (drag.target.hasPointerCapture(pointerId)) {
        drag.target.releasePointerCapture(pointerId);
      }
    } catch {
      // The browser may have already released capture after pointer cancellation.
    }
  }, [commitWidth, followDefault, restoreBodyState, widthRef]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const activeDrag = dragRef.current;
    if (activeDrag) finishResize(activeDrag.pointerId);

    const target = event.currentTarget;
    target.focus({ preventScroll: true });
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widthRef.current,
      target,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setIsResizing(true);
  }, [finishResize, widthRef]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      finishResize(event.pointerId);
      return;
    }
    event.preventDefault();

    const direction = growthDirection === "right" ? 1 : -1;
    const dragged = clampWidth(drag.startWidth + ((event.clientX - drag.startX) * direction));
    const nextWidth = snapWidth ? clampWidth(snapWidth(dragged)) : dragged;
    applyLiveWidth(nextWidth);
    event.currentTarget.setAttribute("aria-valuenow", String(nextWidth));
    event.currentTarget.setAttribute("aria-valuetext", formatValueText?.(nextWidth) ?? `${nextWidth} px`);
  }, [applyLiveWidth, clampWidth, finishResize, formatValueText, growthDirection, snapWidth]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const onPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const onLostPointerCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const resetWidth = useCallback(() => {
    const nextDefault = getDefaultWidth?.() ?? defaultWidth;
    if (followDefault) {
      preferredWidthRef.current = null;
      clearStoredWidth(storageKey);
      commitWidth(nextDefault);
      return;
    }
    commitWidth(nextDefault, { forcePersist: true });
  }, [commitWidth, defaultWidth, followDefault, getDefaultWidth, storageKey]);

  const reclampWidth = useCallback(() => {
    if (followDefault) {
      commitWidth(preferredWidthRef.current ?? getDefaultWidth?.() ?? defaultWidth);
      return;
    }
    commitWidth(widthRef.current);
  }, [commitWidth, defaultWidth, followDefault, getDefaultWidth, widthRef]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 12;
    const growKey = growthDirection === "right" ? "ArrowRight" : "ArrowLeft";
    const shrinkKey = growthDirection === "right" ? "ArrowLeft" : "ArrowRight";

    if (event.key === growKey) {
      event.preventDefault();
      commitWidth(widthRef.current + step, { forcePersist: true });
    } else if (event.key === shrinkKey) {
      event.preventDefault();
      commitWidth(widthRef.current - step, { forcePersist: true });
    } else if (event.key === "Home") {
      event.preventDefault();
      commitWidth(minWidth, { forcePersist: true });
    } else if (event.key === "End") {
      event.preventDefault();
      commitWidth(effectiveMaxWidth(), { forcePersist: true });
    } else if (event.key === "Enter") {
      event.preventDefault();
      resetWidth();
    }
  }, [commitWidth, effectiveMaxWidth, growthDirection, minWidth, resetWidth, widthRef]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    const storedWidth = readStoredWidth(storageKey);
    if (followDefault) preferredWidthRef.current = storedWidth;
    const candidate = storedWidth ?? getDefaultWidth?.() ?? defaultWidth;
    const restoredWidth = commitWidth(candidate, { persist: false });
    if (followDefault) return;
    if (storedWidth !== null && storedWidth !== restoredWidth) {
      writeStoredWidth(storageKey, restoredWidth);
    }
  }, [commitWidth, defaultWidth, followDefault, getDefaultWidth, storageKey]);

  useEffect(() => {
    if (!restoredRef.current) return;
    // A following panel goes back to the width it was given (chosen, else its automatic default, which
    // never exceeds the maximum); the window resize listener picks up a changed default.
    commitWidth(reclampTargetRef.current);

    window.addEventListener("resize", reclampWidth);
    return () => window.removeEventListener("resize", reclampWidth);
  }, [commitWidth, reclampWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const cancelResize = () => {
      const drag = dragRef.current;
      if (drag) finishResize(drag.pointerId);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") cancelResize();
    };
    window.addEventListener("blur", cancelResize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", cancelResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [finishResize, isResizing]);

  useEffect(() => {
    return () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      restoreBodyState(drag);
    };
  }, [restoreBodyState]);

  return {
    isResizing,
    panelRef,
    reclampWidth,
    resetWidth,
    /** Sets the width as a user choice (stored), for example from a layout preset. */
    setPanelWidth: commitWidth,
    separatorProps: {
      "aria-label": ariaLabel,
      "aria-orientation": "vertical" as const,
      "aria-valuemax": separatorMaxWidth,
      "aria-valuemin": minWidth,
      "aria-valuenow": width,
      "aria-valuetext": formatValueText?.(width) ?? `${width} px`,
      onDoubleClick: resetWidth,
      onKeyDown,
      onLostPointerCapture,
      onPointerCancel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      role: "separator" as const,
      tabIndex: 0,
    },
    width,
  };
}
