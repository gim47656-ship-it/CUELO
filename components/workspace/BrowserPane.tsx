"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useBrowserPane } from "@/hooks/useBrowserPane";
import { useI18n } from "@/hooks/useI18n";
import { WorkbenchIcon } from "./WorkbenchIcon";

/** What only the side pane has: its own header, the way back to a conversation, and 크게 보기. */
interface BrowserPaneChrome {
  /** Two panes fit, so the pane can offer 크게 보기 and back. */
  canSplit: boolean;
  /** The pane stands alone by the user's choice (크게 보기). */
  enlarged: boolean;
  onToggleEnlarge: () => void;
  /** 「대화로 바꾸기」, or null when there is no conversation to go back to in this pane. */
  onShowChat: (() => void) | null;
  onClose: () => void;
  /** The pane was pointed at or focused: with one pane on screen, the one last used is the one kept. */
  onUse: () => void;
  /** Why only one pane shows, when the window is too narrow for two. */
  narrowNote: string | null;
}

interface BrowserPaneProps {
  sessionId: string;
  sessionTitle: string;
  /** Null inside the inspector, whose tab row and close button stand in for the pane's header. */
  chrome: BrowserPaneChrome | null;
}

type BandNotice = "blocked" | "returned" | "failed" | "pasteTooLong";

const NOTICE_MS = 4_000;
const MOUSE_BUTTONS = ["left", "middle", "right"] as const;
/** One text event carries this much; longer text goes as several events. */
const TEXT_CHUNK = 2_000;
/** Text beyond this is refused as a whole, with a notice, instead of being cut. */
const TEXT_MAX = 200_000;
/** A resize settles before the new shape goes to ego, so a dragged border does not relayout the page every frame. */
const VIEWPORT_SETTLE_MS = 250;

function modifierBits(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/**
 * 브라우저 옆 칸: a live view of the session's ego TaskSpace. While the agent controls the space the
 * pane only shows it; after the agent hands over, clicks, wheel and typing go to the page, and
 * 「조작 돌려주기」 gives control back. The server decides what is forwarded; this is the surface.
 */
export function BrowserPane({ sessionId, sessionTitle, chrome }: BrowserPaneProps) {
  const { t } = useI18n();
  const { status, state, hadView, frameSize, imageRef, bindImage, sendInput, returnControl, selectTab, reconnect, reportViewport } = useBrowserPane(sessionId);
  const [notice, setNotice] = useState<BandNotice | null>(null);
  const [returning, setReturning] = useState(false);
  const [scalePercent, setScalePercent] = useState<number | null>(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const pointerFocusRef = useRef(false);
  const userTurn = state?.ownership === "user";
  const interactive = userTurn && status === "live";
  const shownTab = state?.tabs.find((tab) => tab.id === state.tabId) ?? null;
  const hasView = status === "live" || status === "lost" || (status === "connecting" && hadView);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // How small the page is drawn, so the user knows why its text is small. The observer reports
  // the first size on observe and every later one; the value is shown only with a frame.
  useEffect(() => {
    const image = imageRef.current;
    if (!image || !frameSize || frameSize.width <= 0) return;
    const observer = new ResizeObserver(() => setScalePercent(Math.round((image.getBoundingClientRect().width / frameSize.width) * 100)));
    observer.observe(image);
    return () => observer.disconnect();
  }, [frameSize, hasView, imageRef]);

  // The box the page can fill: the scroll area without its padding and the tab list under the view.
  // ego lays the agent's tab out at 1280 wide in this shape, so the frame fills the box top to bottom.
  // Measured again when the view (re)appears live, since a restarted ego forgets the shape.
  const live = status === "live";
  const tabsShown = (state?.tabs.length ?? 0) > 0;
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !live) return;
    let timer: number | undefined;
    let sent = "";
    const measure = () => {
      const box = getComputedStyle(scroll);
      const tabs = tabsRef.current;
      const tabsHeight = tabs ? tabs.getBoundingClientRect().height + parseFloat(getComputedStyle(tabs).marginBlockStart) : 0;
      const width = Math.round(scroll.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight));
      const height = Math.round(scroll.clientHeight - parseFloat(box.paddingTop) - parseFloat(box.paddingBottom) - tabsHeight);
      const key = `${width}x${height}`;
      // A box that settles back to the one already sent cancels the report still waiting.
      window.clearTimeout(timer);
      if (width < 100 || height < 100 || key === sent) return;
      timer = window.setTimeout(() => {
        sent = key;
        reportViewport(width, height);
      }, VIEWPORT_SETTLE_MS);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    if (tabsRef.current) observer.observe(tabsRef.current);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [live, tabsShown, reportViewport]);

  const pagePoint = useCallback((clientX: number, clientY: number) => {
    const image = imageRef.current;
    if (!image || !frameSize) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(Math.max(((clientX - rect.left) / rect.width) * frameSize.width, 0), frameSize.width),
      y: Math.min(Math.max(((clientY - rect.top) / rect.height) * frameSize.height, 0), frameSize.height),
    };
  }, [frameSize, imageRef]);

  // React's wheel listener is passive, so the pane's own scroll could not be held back from there.
  useEffect(() => {
    const surface = inputRef.current;
    if (!surface || !interactive) return;
    const onWheel = (event: WheelEvent) => {
      const point = pagePoint(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : 1;
      sendInput({ t: "wheel", ...point, dx: event.deltaX * unit, dy: event.deltaY * unit, modifiers: modifierBits(event) });
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, [interactive, pagePoint, sendInput]);

  const sendMouse = (type: "move" | "down" | "up", event: React.MouseEvent<HTMLTextAreaElement>) => {
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    const modifiers = modifierBits(event);
    if (type === "move") {
      sendInput({ t: "mouse", type, ...point, modifiers });
      return;
    }
    // Only the three page buttons are forwarded; back/forward mouse buttons stay with CUELO.
    const button = MOUSE_BUTTONS[event.button];
    if (button) sendInput({ t: "mouse", type, ...point, button, clickCount: Math.min(Math.max(event.detail, 1), 3), modifiers });
  };

  const sendKey = (type: "down" | "up", event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Composition (한글 등) arrives as text when it ends; Tab stays with CUELO so focus can leave the pane.
    if (event.nativeEvent.isComposing || event.key === "Process" || event.key === "Tab") return;
    // Paste goes through the paste event as text, so the shortcut itself is not forwarded.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    event.preventDefault();
    sendInput({ t: "key", type, key: event.key, modifiers: modifierBits(event) });
  };

  // Typed-in, composed (한글) and pasted text all go this way, whole or not at all.
  const sendText = (text: string) => {
    // The limit counts characters as the notice says them (code points), not UTF-16 units.
    const chars = text.length > TEXT_MAX * 2 ? null : [...text];
    if (!chars || chars.length > TEXT_MAX) {
      setNotice("pasteTooLong");
      return;
    }
    let chunk = "";
    // A chunk is cut between characters, so it never ends in half of a surrogate pair.
    for (const char of chars) {
      if (chunk.length + char.length > TEXT_CHUNK) {
        sendInput({ t: "text", text: chunk });
        chunk = "";
      }
      chunk += char;
    }
    if (chunk) sendInput({ t: "text", text: chunk });
  };

  const handleReturn = async () => {
    setReturning(true);
    const result = await returnControl();
    setReturning(false);
    setNotice(result === "returned" ? "returned" : result === "failed" ? "failed" : null);
  };

  const noticeText = notice === "blocked" ? t("browserPane.blocked")
    : notice === "returned" ? t("browserPane.returned")
    : notice === "failed" ? t("browserPane.returnFailed")
    : notice === "pasteTooLong" ? t("browserPane.pasteTooLong")
    : null;

  return (
    <div
      className={chrome ? "chat-pane browser-pane" : "browser-pane is-inspector"}
      data-turn={userTurn ? "user" : "agent"}
      onPointerDownCapture={chrome?.onUse}
      onFocusCapture={chrome?.onUse}
    >
      {chrome && (
        <div className="chat-pane-head">
          <span className="chat-pane-title" title={sessionTitle}>{t("browserPane.title", { title: sessionTitle })}</span>
          {chrome.onShowChat && (
            <button type="button" className="browser-pane-button" onClick={chrome.onShowChat}>{t("workspace.toChat")}</button>
          )}
          <button type="button" className="chat-pane-close" onClick={chrome.onClose} aria-label={t("workspace.closePane")} title={t("workspace.closePane")}>
            <WorkbenchIcon name="x" size={14} />
          </button>
        </div>
      )}
      {chrome?.narrowNote && <p className="browser-pane-narrow">{chrome.narrowNote}</p>}

      {status === "none" && (
        <div className="browser-pane-empty">
          <strong>{t("browserPane.noneTitle")}</strong>
          <p>{t("browserPane.noneHelp")}</p>
        </div>
      )}
      {status === "off" && (
        <div className="browser-pane-empty">
          <strong>{t("browserPane.offTitle")}</strong>
          <p>{t("browserPane.offHelp")}</p>
          <button type="button" className="browser-pane-button" onClick={reconnect}>{t("browserPane.reconnect")}</button>
        </div>
      )}
      {status === "connecting" && !hasView && (
        <div className="browser-pane-empty" role="status">
          <p>{t("browserPane.connecting")}</p>
        </div>
      )}

      {hasView && (
        <>
          {status !== "lost" && (
            <div className="browser-pane-band" data-turn={userTurn ? "user" : "agent"}>
              <span className="workbench-lamp" data-kind={userTurn ? "input" : undefined} aria-hidden="true" />
              <div className="browser-pane-band-text" role="status" aria-live="polite">
                <strong>{userTurn ? t("browserPane.stateUser") : t("browserPane.stateAgent")}</strong>
                <span>{noticeText ?? (userTurn ? t("browserPane.stateUserHelp") : t("browserPane.stateAgentHelp"))}</span>
              </div>
              {userTurn && (
                <button type="button" className="browser-pane-button is-primary" onClick={() => void handleReturn()} disabled={returning}>
                  {returning ? t("browserPane.returning") : t("browserPane.return")}
                </button>
              )}
            </div>
          )}
          <div className="browser-pane-url">
            <span className="browser-pane-url-text" title={shownTab?.url}>{shownTab?.url ?? ""}</span>
            {frameSize && scalePercent !== null && <span className="browser-pane-scale">{t("browserPane.scale", { percent: scalePercent })}</span>}
            {chrome && (chrome.canSplit || chrome.enlarged) && (
              <button type="button" className="browser-pane-button is-quiet" onClick={chrome.onToggleEnlarge}>
                <WorkbenchIcon name={chrome.enlarged ? "columns-2" : "maximize-2"} size={13} />
                {chrome.enlarged ? t("browserPane.shrink") : t("browserPane.enlarge")}
              </button>
            )}
          </div>
          {status === "lost" && (
            <div className="browser-pane-lost" role="status">
              <span className="workbench-lamp" data-kind="off" aria-hidden="true" />
              <div className="browser-pane-band-text">
                <strong>{t("browserPane.lostTitle")}</strong>
                <span>{t("browserPane.lostHelp")}</span>
              </div>
              <button type="button" className="browser-pane-button" onClick={reconnect}>{t("browserPane.reconnect")}</button>
            </div>
          )}
          <div className="browser-pane-scroll" ref={scrollRef}>
            <div className={`browser-pane-view${status === "lost" ? " is-stale" : ""}${keyboardFocus ? " is-keyboard-focus" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- frames are data URLs written by the stream, not a static asset */}
              <img ref={bindImage} alt="" draggable={false} />
              <textarea
                ref={inputRef}
                className="browser-pane-input"
                aria-label={t("browserPane.viewLabel", { title: shownTab?.title || sessionTitle })}
                readOnly={!interactive}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                onInput={(event) => {
                  // Uncontrolled on purpose: a controlled value would reset an IME composition midway.
                  if (event.nativeEvent instanceof InputEvent && event.nativeEvent.isComposing) return;
                  // Text that arrived without key events (on-screen keyboard, emoji picker, dictation).
                  const text = event.currentTarget.value;
                  event.currentTarget.value = "";
                  if (interactive && text) sendText(text);
                }}
                onMouseDown={(event) => {
                  pointerFocusRef.current = true;
                  if (!interactive) {
                    if (status === "live") setNotice("blocked");
                    return;
                  }
                  sendMouse("down", event);
                }}
                onMouseUp={(event) => { if (interactive) sendMouse("up", event); }}
                onMouseMove={(event) => { if (interactive) sendMouse("move", event); }}
                onContextMenu={(event) => { if (interactive) event.preventDefault(); }}
                onKeyDown={(event) => { if (interactive) sendKey("down", event); }}
                onKeyUp={(event) => { if (interactive) sendKey("up", event); }}
                onCompositionEnd={(event) => {
                  if (interactive && event.data) sendText(event.data);
                  event.currentTarget.value = "";
                }}
                onPaste={(event) => {
                  event.preventDefault();
                  const text = event.clipboardData.getData("text/plain");
                  if (interactive && text) sendText(text);
                }}
                onFocus={() => {
                  setKeyboardFocus(!pointerFocusRef.current);
                  pointerFocusRef.current = false;
                }}
                onBlur={() => {
                  // A press on the already focused view leaves the mark set with no focus event to clear it.
                  pointerFocusRef.current = false;
                  setKeyboardFocus(false);
                }}
              />
            </div>
            {state && state.tabs.length > 0 && (
              <div className="browser-pane-tabs" ref={tabsRef}>
                <div className="browser-pane-tabs-head">
                  <span>{t("browserPane.tabs")}</span>
                  <label className="browser-pane-follow">
                    <input
                      type="checkbox"
                      checked={state.follow}
                      onChange={(event) => selectTab(event.target.checked ? null : state.tabId)}
                    />
                    {t("browserPane.followTab")}
                  </label>
                </div>
                <ul>
                  {state.tabs.map((tab) => {
                    const shown = tab.id === state.tabId;
                    const agents = tab.id === state.agentTabId;
                    return (
                      <li key={tab.id}>
                        <button
                          type="button"
                          className={`browser-pane-tab${shown ? " is-shown" : ""}`}
                          aria-current={shown ? "true" : undefined}
                          aria-label={t("browserPane.tabPick", { title: tab.title || tab.url })}
                          onClick={() => selectTab(tab.id)}
                        >
                          <span className="workbench-lamp" data-kind={agents ? (userTurn ? "input" : undefined) : "off"} aria-hidden="true" />
                          <span className="browser-pane-tab-title">{tab.title || tab.url}</span>
                          <span className="browser-pane-tab-mark">
                            {[shown ? t("browserPane.tabViewing") : null, agents && !userTurn ? t("browserPane.tabAgent") : null].filter(Boolean).join(", ")}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface BrowserHandoffNoticeProps {
  sessionId: string;
  /** The agent is operating the browser in the request that is running, on a layout that does not show it by itself. */
  inUse: boolean;
  onOpen: () => void;
}

const HANDOFF_POLL_MS = 3_000;
/** Without a running ego lite there is nothing to hand over; look again now and then in case it starts. */
const HANDOFF_IDLE_POLL_MS = 15_000;

/**
 * Above the composer while no view of the session's browser is showing: tells the user the agent
 * handed the browser over, or that the agent is operating it, with the way in. It asks the server
 * only while the page is visible, and slowly while there is nothing to ask about. Mount it with
 * the session id as key.
 */
export function BrowserHandoffNotice({ sessionId, inUse, onOpen }: BrowserHandoffNoticeProps) {
  const { t } = useI18n();
  const [userTurn, setUserTurn] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      timer = undefined;
      if (stopped) return;
      let delay = HANDOFF_POLL_MS;
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/browser`, { cache: "no-store" });
          const body: { ownership?: unknown; available?: unknown } = response.ok ? await response.json() : {};
          if (stopped) return;
          setUserTurn(body.ownership === "user");
          // No running ego lite, or a session the server cannot place yet (no file before the first message).
          if (body.available !== true) delay = HANDOFF_IDLE_POLL_MS;
        } catch {
          // The next round asks again.
        }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sessionId]);

  if (!userTurn && !inUse) return null;
  return (
    <div className="browser-handoff-notice" data-turn={userTurn ? "user" : "agent"} role="status">
      <span className="workbench-lamp" data-kind={userTurn ? "input" : undefined} aria-hidden="true" />
      <span className="browser-handoff-notice-text">{t(userTurn ? "browserPane.handoffNotice" : "browserPane.useNotice")}</span>
      <button type="button" className={`browser-pane-button${userTurn ? " is-primary" : ""}`} onClick={onOpen}>
        {t(userTurn ? "browserPane.handoffAction" : "browserPane.useAction")}
      </button>
    </div>
  );
}
