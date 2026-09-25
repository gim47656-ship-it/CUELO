"use client";

import { useEffect, useRef } from "react";
import { WORKSPACE_VIEW_IDS, type WorkspaceViewId } from "@/lib/workspace-layout";

// ChatWindow registers the current run's abort action here. AppShell gets the
// first chance to dismiss its own transient layer before abort is considered.
let globalAbortHandler: (() => void) | null = null;
const POST_COMPOSITION_GUARD_MS = 100;
let compositionActive = false;
let lastCompositionEndAt = Number.NEGATIVE_INFINITY;

// An open popover, listbox, menu or expanded combobox owns Escape: it closes
// itself, so the key must not reach the workspace layer stack or abort the run.
const ESCAPE_LAYER_SELECTOR = [
  "[data-dismissible-layer]",
  "[data-capture-keys]",
  "[role='listbox']",
  "[role='menu']",
  "[role='combobox'][aria-expanded='true']",
  "[aria-haspopup][aria-expanded='true']",
].join(", ");

// Escape inside a dialog closes that dialog. Abort is registered only while the
// agent is busy, so without this an Escape aimed at a blocking prompt would
// also kill the run that is waiting for the answer.
const DIALOG_SELECTOR = "[role='dialog']";

// Terminal-like surfaces need Ctrl+U/K/B and Alt+Arrow as literal input, so the
// application shortcuts step aside instead of swallowing them.
const KEY_CAPTURE_SELECTOR = "[data-capture-keys]";

export function updateGlobalShortcutComposition(active: boolean, at = Date.now()): void {
  compositionActive = active;
  if (!active) lastCompositionEndAt = at;
}


export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

export interface UseGlobalKeyboardShortcutsOptions {
  onNewSession?: (cwd: string) => void;
  onToggleCommandPalette?: () => void;
  onToggleNavigator?: () => void;
  onToggleResources?: () => void;
  onSelectView?: (view: WorkspaceViewId) => void;
  onCycleView?: (direction: -1 | 1) => void;
  onNavigateSession?: (direction: -1 | 1) => void;
  /** Return true when an application layer or non-chat view was dismissed. */
  onEscape?: () => boolean;
  activeCwd?: string | null;
  /** Deterministic clock seam for the post-composition guard. */
  now?: () => number;
  enabled?: boolean;
}

export function handleGlobalKeyboardShortcut(
  event: KeyboardEvent,
  options: UseGlobalKeyboardShortcutsOptions,
): boolean {
  if (event.defaultPrevented) return false;
  const now = options.now?.() ?? Date.now();
  if (
    compositionActive
    || event.isComposing
    || event.keyCode === 229
    || now - lastCompositionEndAt < POST_COMPOSITION_GUARD_MS
  ) {
    return false;
  }
  const target = event.target;
  const targetElement = typeof Element !== "undefined" && target instanceof Element ? target : null;
  const editable = Boolean(targetElement?.closest("input, textarea, select, [contenteditable='true']"));

  if (event.key === "Escape") {
    if (targetElement?.closest(ESCAPE_LAYER_SELECTOR)) return false;
    if (options.onEscape?.()) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    if (editable || targetElement?.closest(DIALOG_SELECTOR) || !globalAbortHandler) return false;
    event.preventDefault();
    globalAbortHandler();
    return true;
  }

  if (targetElement?.closest(KEY_CAPTURE_SELECTOR)) return false;
  if (options.enabled === false) return false;
  const key = event.key.toLowerCase();
  const primary = (event.ctrlKey || event.metaKey) && !event.altKey;
  if (primary && !event.shiftKey && key === "k") {
    if (!options.onToggleCommandPalette) return false;
    event.preventDefault();
    options.onToggleCommandPalette();
    return true;
  }
  if (primary && !event.shiftKey && key === "b") {
    if (!options.onToggleNavigator) return false;
    event.preventDefault();
    options.onToggleNavigator();
    return true;
  }
  if (primary && !event.shiftKey && key === "u") {
    if (!options.onToggleResources) return false;
    event.preventDefault();
    options.onToggleResources();
    return true;
  }

  // Chrome/Edge reserve Ctrl+1..4 for browser tabs. Keep these as best-effort
  // aliases only; the auxiliary panel's tabs and the non-reserved cycle action
  // below are the reliable paths.
  if (primary && !event.shiftKey && /^[1-7]$/.test(key)) {
    if (!options.onSelectView) return false;
    const view = WORKSPACE_VIEW_IDS[Number(key) - 1];
    if (!view) return false;
    event.preventDefault();
    options.onSelectView(view);
    return true;
  }
  if (primary && event.shiftKey && (event.code === "Period" || event.code === "Comma")) {
    if (!options.onCycleView) return false;
    event.preventDefault();
    options.onCycleView(event.code === "Period" ? 1 : -1);
    return true;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    if (!options.onNavigateSession) return false;
    event.preventDefault();
    options.onNavigateSession(event.key === "ArrowUp" ? -1 : 1);
    return true;
  }
  if (event.ctrlKey && event.altKey && !event.metaKey && key === "n") {
    if (!options.activeCwd || !options.onNewSession) return false;
    event.preventDefault();
    options.onNewSession(options.activeCwd);
    return true;
  }
  return false;
}

export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      handleGlobalKeyboardShortcut(event, optionsRef.current);
    };
    const handleCompositionStart = () => updateGlobalShortcutComposition(true);
    const handleCompositionEnd = () => updateGlobalShortcutComposition(false);
    window.addEventListener("compositionstart", handleCompositionStart, { capture: true });
    window.addEventListener("compositionend", handleCompositionEnd, { capture: true });
    window.addEventListener("keydown", handler, { capture: true });
    return () => {
      window.removeEventListener("keydown", handler, { capture: true });
      window.removeEventListener("compositionstart", handleCompositionStart, { capture: true });
      window.removeEventListener("compositionend", handleCompositionEnd, { capture: true });
    };
  }, []);
}
