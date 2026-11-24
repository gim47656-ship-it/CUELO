"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import type { PaneReturnResult, PaneState } from "@/lib/ego-pane/hub";
import { PaneViewStore, type OpenPaneSource, type PaneViewSnapshot } from "@/lib/ego-pane/view-store";

/** connecting: no frame yet. lost: there was a view and the stream or the ego app went away. */
export type BrowserPaneStatus = "connecting" | "live" | "none" | "off" | "lost";

export type BrowserPaneInput =
  | { t: "mouse"; type: "move"; x: number; y: number; modifiers: number }
  | { t: "mouse"; type: "down" | "up"; x: number; y: number; button: "left" | "middle" | "right"; clickCount: number; modifiers: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number; modifiers: number }
  | { t: "key"; type: "down" | "up"; key: string; modifiers: number }
  | { t: "text"; text: string };

export interface BrowserPaneView {
  status: BrowserPaneStatus;
  state: PaneState | null;
  /** A frame was shown at least once, so a lost or reconnecting view still has a picture to keep. */
  hadView: boolean;
  /** Page size of the shown frame in CSS pixels of the TaskSpace tab; pointer positions map to it. */
  frameSize: { width: number; height: number } | null;
  /** The hook writes each frame straight into the bound image, so a frame is not a React render. */
  imageRef: RefObject<HTMLImageElement | null>;
  /** Ref callback for that image; an image mounted after a frame arrived gets the frame at once. */
  bindImage: (node: HTMLImageElement | null) => void;
  sendInput: (event: BrowserPaneInput) => void;
  returnControl: () => Promise<PaneReturnResult>;
  /** A tab id pins the view to it; null follows the agent's tab again. */
  selectTab: (tabId: string | null) => void;
  reconnect: () => void;
  /** The box (CSS pixels) this surface can show the page in; ego lays the space's tabs out in that shape. */
  reportViewport: (width: number, height: number) => void;
}

const INPUT_BATCH = 32;
/** A viewport report that failed is sent again this often before it is left to the next resize. */
const VIEWPORT_TRIES = 3;
const VIEWPORT_RETRY_MS = 2_000;

const openEventSource: OpenPaneSource = (url, handlers) => {
  const source = new EventSource(url);
  source.onopen = handlers.open;
  source.onerror = () => handlers.error(source.readyState === EventSource.CLOSED);
  source.onmessage = (message) => handlers.message(message.data);
  return () => source.close();
};

/** One store per session for the life of the page; an idle store holds no stream and no frame. */
const stores = new Map<string, PaneViewStore>();

function viewStore(sessionId: string): PaneViewStore {
  let store = stores.get(sessionId);
  if (!store) {
    store = new PaneViewStore(`/api/agent/${encodeURIComponent(sessionId)}/browser/events`, openEventSource);
    stores.set(sessionId, store);
  }
  return store;
}

const SERVER_SNAPSHOT: PaneViewSnapshot = { state: null, streamDown: false, frameSize: null, frameTabId: null, hadView: false };
const serverSnapshot = (): PaneViewSnapshot => SERVER_SNAPSHOT;

/**
 * Live view of one session's ego TaskSpace. Every surface showing the same session shares one
 * stream and one state; the stream is open only while one of them is mounted and the page is
 * visible. Input is queued per surface: mount the component that calls this with the session id
 * as key.
 */
export function useBrowserPane(sessionId: string): BrowserPaneView {
  const store = viewStore(sessionId);
  const { state, streamDown, frameSize, frameTabId, hadView } = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const bindImage = useCallback((node: HTMLImageElement | null) => {
    imageRef.current = node;
    if (node && store.frameSrc) node.src = store.frameSrc;
  }, [store]);
  useEffect(() => store.watchFrames((src) => {
    if (imageRef.current) imageRef.current.src = src;
  }), [store]);
  /** Input waiting to be sent, each with the tab whose frame was on screen when it was made. */
  const queueRef = useRef<{ tabId: string; event: BrowserPaneInput }[]>([]);
  const sendingRef = useRef(false);
  const base = `/api/agent/${encodeURIComponent(sessionId)}/browser`;

  // A closed pane sends nothing more: what it had queued (the rest of a long paste) is dropped,
  // even when another surface keeps the same view open.
  const closedRef = useRef(false);
  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      queueRef.current = [];
    };
  }, []);

  // Input made on the tab that was showing must not reach the tab that shows now. The server
  // refuses it by its tab id as well.
  useEffect(() => {
    queueRef.current = [];
  }, [frameTabId]);

  const flush = useCallback(async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      while (queueRef.current.length > 0 && !closedRef.current) {
        // One request carries input of one tab; the server drops it when that tab is no longer shown.
        const queue = queueRef.current;
        const tabId = queue[0].tabId;
        let count = 1;
        while (count < queue.length && count < INPUT_BATCH && queue[count].tabId === tabId) count += 1;
        const events = queue.splice(0, count).map((entry) => entry.event);
        const response = await fetch(`${base}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabId, events }),
        }).catch(() => null);
        // Refused or failed: what was queued behind it belongs to a turn that is over.
        if (!response?.ok || closedRef.current) queueRef.current = [];
      }
    } finally {
      sendingRef.current = false;
    }
  }, [base]);

  const sendInput = useCallback((event: BrowserPaneInput) => {
    const tabId = store.getSnapshot().frameTabId;
    if (!tabId) return;
    const queue = queueRef.current;
    const last = queue.at(-1);
    // Only the newest pointer position matters while a request is in flight.
    if (event.t === "mouse" && event.type === "move" && last?.tabId === tabId && last.event.t === "mouse" && last.event.type === "move") queue[queue.length - 1] = { tabId, event };
    else queue.push({ tabId, event });
    void flush();
  }, [flush, store]);

  const returnControl = useCallback(async (): Promise<PaneReturnResult> => {
    queueRef.current = [];
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "return" }),
      });
      const body: { result?: PaneReturnResult } = await response.json();
      return body.result ?? "failed";
    } catch {
      return "failed";
    }
  }, [base]);

  const selectTab = useCallback((tabId: string | null) => {
    void fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tab", tabId }),
    }).catch(() => {});
  }, [base]);

  const reconnect = useCallback(() => store.reconnect(), [store]);

  // One report in flight at a time, always the newest box, so an older box never lands after a
  // newer one. A failed one is tried again a few times; after that the next resize or a view
  // that comes back live sends it.
  const viewportRef = useRef<{ width: number; height: number } | null>(null);
  const viewportSendingRef = useRef(false);
  const reportViewport = useCallback((width: number, height: number) => {
    viewportRef.current = { width, height };
    if (viewportSendingRef.current) return;
    viewportSendingRef.current = true;
    void (async () => {
      try {
        let failures = 0;
        for (;;) {
          const box = viewportRef.current;
          if (!box || closedRef.current) return;
          const ok = await fetch(base, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "viewport", ...box }),
          }).then((response) => response.ok, () => false);
          if (viewportRef.current !== box) {
            failures = 0;
            continue;
          }
          if (ok || ++failures >= VIEWPORT_TRIES) return;
          const pause = Promise.withResolvers<void>();
          setTimeout(pause.resolve, VIEWPORT_RETRY_MS);
          await pause.promise;
        }
      } finally {
        viewportSendingRef.current = false;
      }
    })();
  }, [base]);

  let status: BrowserPaneStatus;
  // A stream that is being reopened is "lost" only when there is an old picture to say so about.
  if (streamDown) status = hadView ? "lost" : "connecting";
  else if (!state) status = "connecting";
  else if (state.status === "off") status = hadView ? "lost" : "off";
  else if (state.status === "none") status = "none";
  else if (state.status === "lost") status = hadView ? "lost" : "connecting";
  else status = state.status === "live" && frameTabId === state.tabId ? "live" : "connecting";

  return { status, state, hadView, frameSize, imageRef, bindImage, sendInput, returnControl, selectTab, reconnect, reportViewport };
}
