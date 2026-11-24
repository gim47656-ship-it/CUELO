import {
  fetchPaneState,
  openPaneFrames,
  postPaneInput,
  postPaneReturn,
  postPaneViewport,
  readPaneChannel,
  type PaneChannel,
  type PaneFrame,
  type PaneFrameStream,
  type PaneSpaceState,
} from "./channel";
import { toPaneEventBatch } from "./input";
import { paneChannelPath, paneSpaceName, type EgoOwnership } from "./space";

/**
 * live: a frame of the open stream is showing. waiting: the stream is open (first connect, or a tab
 * was picked) and no frame came yet. lost: the stream ended by itself and is being reopened; what
 * is on screen is old. none: this session has no TaskSpace tab. off: the ego app does not answer.
 * Input is forwarded only while live.
 */
export type PaneStatus = "live" | "waiting" | "lost" | "none" | "off";

export interface PaneState {
  status: PaneStatus;
  /** Who controls the space, as ego reports it; null without a space. */
  ownership: EgoOwnership | null;
  tabs: { id: string; title: string; url: string }[];
  /** The tab being shown. */
  tabId: string | null;
  /** The tab the space itself shows: the one the agent is using. */
  agentTabId: string | null;
  /** True while the view follows the agent's tab; false after the user picked a tab. */
  follow: boolean;
}

export type PaneEvent =
  | { type: "state"; state: PaneState }
  | { type: "frame"; tabId: string; data: string; width: number; height: number };

export type PaneInputResult = "sent" | "invalid" | "not-user" | "not-live";
export type PaneReturnResult = "returned" | "not-user" | "failed";
export type PaneViewportResult = "set" | "invalid" | "none" | "failed";

/** A viewer box outside this range is no real pane; ego refuses it too. */
const VIEWPORT_MIN = 100;
const VIEWPORT_MAX = 10_000;

const POLL_MS = 1_000;
const EMPTY_STATE: PaneState = { status: "none", ownership: null, tabs: [], tabId: null, agentTabId: null, follow: true };

/**
 * One session's live view: holds one frames stream on ego's pane channel and fans its frames out
 * to the subscribed browser windows. It exists only while someone is subscribed; without a stream
 * it asks ego for the space once a second.
 */
export class PaneHub {
  readonly #space: string;
  readonly #channelPath: string;
  readonly #listeners = new Set<(event: PaneEvent) => void>();
  #state: PaneState = EMPTY_STATE;
  #lastFrame: PaneEvent | null = null;
  /** ego's last word on the space, kept so a frame can re-derive the state without a new answer. */
  #latest: PaneSpaceState | null = null;
  /** A frame arrived on the stream that is open now. */
  #frameSeen = false;
  /** The stream ended without being asked to; cleared by the next frame. */
  #streamLost = false;
  /** The tab the user picked, or null while following the agent's tab. */
  #pinned: string | null = null;
  #channel: PaneChannel | null = null;
  #stream: PaneFrameStream | null = null;
  #timer: NodeJS.Timeout | null = null;
  /** Bumped on every (re)connect and on stop, so answers of an older attempt are ignored. */
  #attempt = 0;

  constructor(sessionId: string, channelPath: string) {
    this.#space = paneSpaceName(sessionId);
    this.#channelPath = channelPath;
  }

  get idle(): boolean {
    return this.#listeners.size === 0;
  }

  subscribe(listener: (event: PaneEvent) => void): () => void {
    this.#listeners.add(listener);
    listener({ type: "state", state: this.#state });
    if (this.#lastFrame) listener(this.#lastFrame);
    if (this.#listeners.size === 1) void this.#connect();
    return () => {
      if (!this.#listeners.delete(listener) || this.#listeners.size > 0) return;
      this.#attempt += 1;
      clearTimeout(this.#timer ?? undefined);
      this.#timer = null;
      this.#closeStream();
      this.#state = EMPTY_STATE;
      this.#latest = null;
      this.#streamLost = false;
    };
  }

  /** Shows one of the space's tabs, or follows the agent's tab again with null. */
  selectTab(tabId: string | null): boolean {
    if (tabId !== null && !this.#state.tabs.some((tab) => tab.id === tabId)) return false;
    this.#pinned = tabId;
    // A picked tab is a new stream the user asked for, not a lost one.
    this.#streamLost = false;
    if (!this.idle) void this.#connect();
    return true;
  }

  /**
   * Forwards a batch of pane input for the tab the sender was looking at. Checked here before ego
   * checks it again, and again before every event of the batch: the batch must be on the
   * whitelist, that tab must be the one showing live, someone must still be watching, and ego's
   * last word on ownership must be "user". Input for a tab that is no longer shown is dropped.
   */
  async input(tabId: unknown, events: unknown): Promise<PaneInputResult> {
    const mapped = toPaneEventBatch(events);
    if (!mapped || typeof tabId !== "string") return "invalid";
    const attempt = this.#attempt;
    for (const event of mapped) {
      const channel = this.#channel;
      if (attempt !== this.#attempt || this.idle || !channel || this.#state.status !== "live" || this.#state.tabId !== tabId) return "not-live";
      if (this.#state.ownership !== "user") return "not-user";
      const status = await postPaneInput(channel, this.#space, tabId, event);
      if (status === 409) return "not-user";
      if (status !== 204) return "not-live";
    }
    return "sent";
  }

  #emit(event: PaneEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #setState(state: PaneState): void {
    this.#state = state;
    this.#emit({ type: "state", state });
  }

  #closeStream(): void {
    this.#stream?.close();
    this.#stream = null;
    this.#channel = null;
    this.#lastFrame = null;
    this.#frameSeen = false;
  }

  #retryLater(): void {
    clearTimeout(this.#timer ?? undefined);
    this.#timer = setTimeout(() => void this.#connect(), POLL_MS);
  }

  /** Derives the state from ego's last answer; shownTabId is the tab of the newest frame, if any. */
  #applySpace(shownTabId: string | null): void {
    const space = this.#latest;
    if (!space) return;
    const tabs = space.tabs.map(({ id, title, url }) => ({ id, title, url }));
    const has = (id: string | null) => id !== null && tabs.some((tab) => tab.id === id);
    if (!has(this.#pinned)) this.#pinned = null;
    const agentTabId = space.tabs.find((tab) => tab.active)?.id ?? null;
    // Following: the tab of the last frame is the truth; before a frame, ego's active tab.
    const followed = has(shownTabId) ? shownTabId : agentTabId ?? tabs[0]?.id ?? null;
    this.#setState({
      status: tabs.length === 0 ? "none" : this.#frameSeen ? "live" : this.#streamLost ? "lost" : "waiting",
      ownership: space.ownership,
      tabs,
      tabId: this.#pinned ?? followed,
      agentTabId,
      follow: this.#pinned === null,
    });
  }

  async #connect(): Promise<void> {
    const attempt = (this.#attempt += 1);
    clearTimeout(this.#timer ?? undefined);
    this.#timer = null;
    this.#closeStream();
    const channel = readPaneChannel(this.#channelPath);
    let space: PaneSpaceState | null = null;
    let reachable = channel !== null;
    if (channel) {
      try {
        space = await fetchPaneState(channel, this.#space);
      } catch {
        reachable = false;
      }
    }
    if (attempt !== this.#attempt || this.idle) return;
    if (!channel || !space) {
      this.#latest = null;
      this.#streamLost = false;
      this.#setState({ ...EMPTY_STATE, status: reachable ? "none" : "off" });
      this.#retryLater();
      return;
    }
    this.#channel = channel;
    this.#latest = space;
    this.#applySpace(null);
    this.#stream = openPaneFrames(channel, this.#space, this.#pinned, {
      onState: (state) => {
        if (attempt !== this.#attempt) return;
        this.#latest = state;
        this.#applySpace(this.#lastFrame?.type === "frame" ? this.#lastFrame.tabId : null);
      },
      onFrame: (frame: PaneFrame) => {
        if (attempt !== this.#attempt) return;
        this.#lastFrame = { type: "frame", tabId: frame.targetId, data: frame.jpeg, width: frame.width, height: frame.height };
        // The first frame makes the view live; while following, a frame also says which tab the stream moved to.
        if (!this.#frameSeen || (this.#pinned === null && this.#state.tabId !== frame.targetId)) {
          this.#frameSeen = true;
          this.#streamLost = false;
          this.#applySpace(frame.targetId);
        }
        this.#emit(this.#lastFrame);
      },
      onEnd: () => {
        if (attempt !== this.#attempt) return;
        // The view on screen is old from here on: no input until a new stream shows a frame.
        this.#stream = null;
        this.#channel = null;
        this.#frameSeen = false;
        this.#streamLost = true;
        this.#applySpace(null);
        // Not at once: an ego that keeps ending the stream must not be asked in a tight loop.
        this.#retryLater();
      },
    });
  }
}

declare global {
  var __cueloEgoPaneHubs: Map<string, PaneHub> | undefined;
}

/** Survives dev-server module reloads so a reload cannot strand an open frames stream. */
function hubs(): Map<string, PaneHub> {
  globalThis.__cueloEgoPaneHubs ??= new Map();
  return globalThis.__cueloEgoPaneHubs;
}

/** Subscribes one client to a session's live view; the returned function must run when it leaves. */
export function subscribePane(sessionId: string, listener: (event: PaneEvent) => void, channelPath: string = paneChannelPath()): () => void {
  const registry = hubs();
  let hub = registry.get(sessionId);
  if (!hub) {
    hub = new PaneHub(sessionId, channelPath);
    registry.set(sessionId, hub);
  }
  const current = hub;
  const leave = current.subscribe(listener);
  return () => {
    leave();
    if (current.idle && registry.get(sessionId) === current) registry.delete(sessionId);
  };
}

/** Input needs an open live view: without one nothing is forwarded. */
export async function sendPaneInput(sessionId: string, tabId: unknown, events: unknown): Promise<PaneInputResult> {
  return (await hubs().get(sessionId)?.input(tabId, events)) ?? "not-live";
}

export function selectPaneTab(sessionId: string, tabId: string | null): boolean {
  return hubs().get(sessionId)?.selectTab(tabId) ?? false;
}

/** 「조작 돌려주기」: ego itself hands a user-owned space back to the agent, and only that direction. */
export async function returnPaneControl(sessionId: string, channelPath: string = paneChannelPath()): Promise<PaneReturnResult> {
  const channel = readPaneChannel(channelPath);
  if (!channel) return "failed";
  const status = await postPaneReturn(channel, paneSpaceName(sessionId));
  return status === 200 ? "returned" : status === 409 ? "not-user" : "failed";
}

/**
 * The box a surface shows the session's space in (CSS pixels). ego lays the space's tabs out in
 * that shape, so the page fills the box instead of leaving empty rows above and below it.
 */
export async function setPaneViewport(sessionId: string, width: unknown, height: unknown, channelPath: string = paneChannelPath()): Promise<PaneViewportResult> {
  const valid = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= VIEWPORT_MIN && (value as number) <= VIEWPORT_MAX;
  if (!valid(width) || !valid(height)) return "invalid";
  const channel = readPaneChannel(channelPath);
  if (!channel) return "failed";
  const status = await postPaneViewport(channel, paneSpaceName(sessionId), width, height);
  return status === 204 ? "set" : status === 404 ? "none" : "failed";
}

/**
 * Who controls the session's TaskSpace right now (null when it has none), and whether an ego app
 * with a pane channel is running at all.
 */
export async function readPaneOwnership(sessionId: string, channelPath: string = paneChannelPath()): Promise<{ ownership: EgoOwnership | null; available: boolean }> {
  const channel = readPaneChannel(channelPath);
  if (!channel) return { ownership: null, available: false };
  try {
    return { ownership: (await fetchPaneState(channel, paneSpaceName(sessionId)))?.ownership ?? null, available: true };
  } catch {
    return { ownership: null, available: false };
  }
}
