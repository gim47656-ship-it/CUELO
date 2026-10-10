"use client";

import { useEffect, useSyncExternalStore } from "react";

interface ViewportHeightState {
  hasFocusedEditable: boolean;
  innerHeight: number;
  viewportHeight: number;
  viewportScale: number;
}

export function shouldUseVisualViewportHeight({
  hasFocusedEditable,
  innerHeight,
  viewportHeight,
  viewportScale,
}: ViewportHeightState): boolean {
  const isUnscaled = Math.abs(viewportScale - 1) < 0.01;
  return hasFocusedEditable && isUnscaled && innerHeight - viewportHeight > 1;
}

function hasFocusedEditableElement(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;

  return activeElement.isContentEditable
    || activeElement.tagName === "INPUT"
    || activeElement.tagName === "SELECT"
    || activeElement.tagName === "TEXTAREA";
}

/** A height loss smaller than this is browser chrome (iOS toolbars), not a keyboard. */
const SOFT_KEYBOARD_MIN_PX = 120;

interface SoftKeyboardState extends ViewportHeightState {
  /** Tallest innerHeight seen at the current width: the height without a keyboard. */
  baselineHeight: number;
}

/**
 * The soft keyboard is open when an editor has focus and either the visual
 * viewport shrank below the layout viewport (iOS) or the layout viewport itself
 * shrank below its keyboard-free height (Android resizes it).
 */
export function isSoftKeyboardOpen({
  hasFocusedEditable,
  innerHeight,
  viewportHeight,
  viewportScale,
  baselineHeight,
}: SoftKeyboardState): boolean {
  if (!hasFocusedEditable || Math.abs(viewportScale - 1) >= 0.01) return false;
  return innerHeight - viewportHeight > SOFT_KEYBOARD_MIN_PX
    || baselineHeight - innerHeight > SOFT_KEYBOARD_MIN_PX;
}

let softKeyboardOpen = false;
let baseline = { width: 0, height: 0 };
const softKeyboardListeners = new Set<() => void>();
let detachSoftKeyboard: (() => void) | null = null;

function readSoftKeyboard(): void {
  const viewport = window.visualViewport;
  const hasFocusedEditable = hasFocusedEditableElement();
  // Width changes mean rotation or a resized window: start a new baseline.
  if (baseline.width !== window.innerWidth) baseline = { width: window.innerWidth, height: window.innerHeight };
  else if (!hasFocusedEditable) baseline.height = Math.max(baseline.height, window.innerHeight);
  const next = isSoftKeyboardOpen({
    hasFocusedEditable,
    innerHeight: window.innerHeight,
    viewportHeight: viewport?.height ?? window.innerHeight,
    viewportScale: viewport?.scale ?? 1,
    baselineHeight: baseline.height,
  });
  if (next === softKeyboardOpen) return;
  softKeyboardOpen = next;
  for (const listener of softKeyboardListeners) listener();
}

function subscribeSoftKeyboard(listener: () => void): () => void {
  softKeyboardListeners.add(listener);
  if (!detachSoftKeyboard) {
    let frameId: number | null = null;
    // Same reason as below: focus and viewport events fire before the values settle.
    const schedule = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        readSoftKeyboard();
      });
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", schedule);
    readSoftKeyboard();
    detachSoftKeyboard = () => {
      viewport?.removeEventListener("resize", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", schedule);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }
  return () => {
    softKeyboardListeners.delete(listener);
    if (softKeyboardListeners.size === 0 && detachSoftKeyboard) {
      detachSoftKeyboard();
      detachSoftKeyboard = null;
    }
  };
}

/** True while a phone's soft keyboard covers part of the page. SSR-safe (false). */
export function useSoftKeyboardOpen(): boolean {
  return useSyncExternalStore(subscribeSoftKeyboard, () => softKeyboardOpen, () => false);
}

/**
 * Keep the app height aligned with the visual viewport while a mobile keyboard
 * is open. iOS standalone PWAs can leave 100dvh at the layout viewport height,
 * which puts the composer behind the keyboard and may scroll the page itself.
 */
export function useViewportHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const root = document.documentElement;
    let frameId: number | null = null;

    const update = () => {
      frameId = null;
      const keyboardOpen = shouldUseVisualViewportHeight({
        hasFocusedEditable: hasFocusedEditableElement(),
        innerHeight: window.innerHeight,
        viewportHeight: viewport.height,
        viewportScale: viewport.scale,
      });
      if (keyboardOpen) {
        root.style.setProperty("--app-viewport-height", `${viewport.height}px`);
      } else {
        root.style.removeProperty("--app-viewport-height");
      }

      const pageWasShifted = window.scrollX !== 0 || window.scrollY !== 0;
      const isUnscaled = Math.abs(viewport.scale - 1) < 0.01;
      if (pageWasShifted && isUnscaled) {
        window.scrollTo(0, 0);
      }
    };

    // WebKit can dispatch the resize event before visualViewport.height has
    // settled, especially when an installed PWA dismisses the keyboard. Reading
    // it on the next animation frame prevents the keyboard-height CSS value
    // from remaining after the keyboard has closed.
    const scheduleUpdate = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(update);
    };

    scheduleUpdate();
    viewport.addEventListener("resize", scheduleUpdate);
    viewport.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("focusin", scheduleUpdate);
    window.addEventListener("focusout", scheduleUpdate);
    window.addEventListener("pageshow", scheduleUpdate);

    return () => {
      viewport.removeEventListener("resize", scheduleUpdate);
      viewport.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("focusin", scheduleUpdate);
      window.removeEventListener("focusout", scheduleUpdate);
      window.removeEventListener("pageshow", scheduleUpdate);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      root.style.removeProperty("--app-viewport-height");
    };
  }, []);
}
