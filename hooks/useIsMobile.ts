"use client";

import { useSyncExternalStore } from "react";
import { WORKSPACE_PIN_THRESHOLDS } from "@/lib/workspace-layout";

// This remains the phone-sized control breakpoint used by existing leaf
// components. Structural shell pinning uses the content-derived query below.
const MOBILE_QUERY = "(max-width: 640px)";
const COMPACT_WORKSPACE_QUERY = `(max-width: ${WORKSPACE_PIN_THRESHOLDS.navigator - 1}px)`;

function createMediaStore(query: string) {
  return {
    subscribe(callback: () => void): () => void {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    getSnapshot(): boolean {
      if (typeof window === "undefined" || !window.matchMedia) return false;
      return window.matchMedia(query).matches;
    },
  };
}

const mobileStore = createMediaStore(MOBILE_QUERY);
const compactWorkspaceStore = createMediaStore(COMPACT_WORKSPACE_QUERY);

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Returns true for the existing phone-sized control layout.
 * SSR-safe: the server snapshot remains false until hydration.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    mobileStore.subscribe,
    mobileStore.getSnapshot,
    getServerSnapshot,
  );
}

/**
 * Returns true while the shell cannot pin the 240px navigator beside the
 * transcript's 550px descriptive floor. This is a content-width decision,
 * not device detection.
 */
export function useIsCompactWorkspace(): boolean {
  return useSyncExternalStore(
    compactWorkspaceStore.subscribe,
    compactWorkspaceStore.getSnapshot,
    getServerSnapshot,
  );
}
