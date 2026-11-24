"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PaneEvent, PaneReturnResult, PaneState } from "@/lib/ego-pane/hub";

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
}

const INPUT_BATCH = 32;
const STREAM_RETRY_MS = 2_000;

/**
 * Live view of one session's ego TaskSpace. The stream is open only while the pane is mounted and
 * the page is visible; closing the EventSource is what stops the server's screencast. The view
 * state belongs to one session: mount the component that calls this with the session id as key.
 */
export function useBrowserPane(sessionId: string): BrowserPaneView {
  const [state, setState] = useState<PaneState | null>(null);
  const [streamDown, setStreamDown] = useState(false);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [frameTabId, setFrameTabId] = useState<string | null>(null);
  const [hadView, setHadView] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const frameSrcRef = useRef("");
  const bindImage = useCallback((node: HTMLImageElement | null) => {
    imageRef.current = node;
    if (node && frameSrcRef.current) node.src = frameSrcRef.current;
  }, []);
  /** Input waiting to be sent, each with the tab whose frame was on screen when it was made. */
  const queueRef = useRef<{ tabId: string; event: BrowserPaneInput }[]>([]);
  const shownTabRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  const base = `/api/agent/${encodeURIComponent(sessionId)}/browser`;

  useEffect(() => {
    const sync = () => setPageVisible(document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // A closed pane sends nothing more: what it had queued (the rest of a long paste) is dropped,
  // even when another window keeps the same view open on the server.
  const closedRef = useRef(false);
  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      queueRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!pageVisible) return;
    const source = new EventSource(`${base}/events`);
    let size = { width: 0, height: 0 };
    let retry: number | undefined;
    source.onopen = () => setStreamDown(false);
    source.onerror = () => {
      setStreamDown(true);
      // EventSource gives up for good on an HTTP error (a session the server cannot place yet, a
      // restart in progress); it reconnects by itself only after a dropped connection.
      if (source.readyState === EventSource.CLOSED) retry = window.setTimeout(() => setAttempt((value) => value + 1), STREAM_RETRY_MS);
    };
    source.onmessage = (message) => {
      let event: PaneEvent;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event.type === "state") {
        setState(event.state);
        return;
      }
      frameSrcRef.current = `data:image/jpeg;base64,${event.data}`;
      if (imageRef.current) imageRef.current.src = frameSrcRef.current;
      if (event.width !== size.width || event.height !== size.height) {
        size = { width: event.width, height: event.height };
        setFrameSize(size);
      }
      if (event.tabId !== shownTabRef.current) {
        // Input made on the tab that was showing must not reach the tab that shows now.
        queueRef.current = [];
        shownTabRef.current = event.tabId;
        setFrameTabId(event.tabId);
        setHadView(true);
      }
    };
    return () => {
      clearTimeout(retry);
      source.close();
    };
  }, [attempt, base, pageVisible]);

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
    const tabId = shownTabRef.current;
    if (!tabId) return;
    const queue = queueRef.current;
    const last = queue.at(-1);
    // Only the newest pointer position matters while a request is in flight.
    if (event.t === "mouse" && event.type === "move" && last?.tabId === tabId && last.event.t === "mouse" && last.event.type === "move") queue[queue.length - 1] = { tabId, event };
    else queue.push({ tabId, event });
    void flush();
  }, [flush]);

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

  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);

  let status: BrowserPaneStatus;
  // A stream that is being reopened is "lost" only when there is an old picture to say so about.
  if (streamDown) status = hadView ? "lost" : "connecting";
  else if (!state) status = "connecting";
  else if (state.status === "off") status = hadView ? "lost" : "off";
  else if (state.status === "none") status = "none";
  else if (state.status === "lost") status = hadView ? "lost" : "connecting";
  else status = state.status === "live" && frameTabId === state.tabId ? "live" : "connecting";

  return { status, state, hadView, frameSize, imageRef, bindImage, sendInput, returnControl, selectTab, reconnect };
}
