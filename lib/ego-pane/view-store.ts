import type { PaneEvent, PaneState } from "./hub";

export interface PaneViewSnapshot {
  state: PaneState | null;
  /** The stream from this server is down or being reopened. */
  streamDown: boolean;
  /** Page size of the shown frame in CSS pixels of the TaskSpace tab. */
  frameSize: { width: number; height: number } | null;
  /** The tab whose frame is on screen. */
  frameTabId: string | null;
  /** A frame was shown at least once since the view opened. */
  hadView: boolean;
}

export interface PaneSourceHandlers {
  open: () => void;
  /** `closed`: the source gave up for good and will not reconnect by itself. */
  error: (closed: boolean) => void;
  message: (data: string) => void;
}

/** Opens the event stream of one session's view and returns the way to close it. */
export type OpenPaneSource = (url: string, handlers: PaneSourceHandlers) => () => void;

const STREAM_RETRY_MS = 2_000;
const EMPTY_SNAPSHOT: PaneViewSnapshot = { state: null, streamDown: false, frameSize: null, frameTabId: null, hadView: false };

/**
 * One session's live view on the page. Every surface that shows the session's browser (the side
 * pane, the inspector tab) reads this one store, so they share one event stream, one state and
 * the same frames. The stream is open only while a surface is subscribed and the page is visible;
 * when the last one leaves, the view starts from nothing the next time.
 */
export class PaneViewStore {
  readonly #url: string;
  readonly #open: OpenPaneSource;
  readonly #listeners = new Set<() => void>();
  readonly #frameListeners = new Set<(src: string) => void>();
  #snapshot = EMPTY_SNAPSHOT;
  #frameSrc = "";
  #visible = true;
  #close: (() => void) | null = null;
  #unwatchPage: (() => void) | null = null;
  #retry: NodeJS.Timeout | undefined;

  constructor(url: string, open: OpenPaneSource) {
    this.#url = url;
    this.#open = open;
  }

  /** The newest frame as an image source, or "" before the first one. */
  get frameSrc(): string {
    return this.#frameSrc;
  }

  readonly getSnapshot = (): PaneViewSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#watchPage();
      this.#connect();
    }
    return () => {
      if (!this.#listeners.delete(listener) || this.#listeners.size > 0) return;
      this.#unwatchPage?.();
      this.#unwatchPage = null;
      this.#disconnect();
      this.#snapshot = EMPTY_SNAPSHOT;
      this.#frameSrc = "";
    };
  };

  /**
   * Frames go straight to whoever draws them, so a frame is not a state change. A watcher starts
   * with the newest frame: what it draws and the tab its input is tagged with never differ.
   */
  watchFrames(listener: (src: string) => void): () => void {
    this.#frameListeners.add(listener);
    if (this.#frameSrc) listener(this.#frameSrc);
    return () => {
      this.#frameListeners.delete(listener);
    };
  }

  /** A hidden page keeps no stream open: closing it is what stops the server's screencast. */
  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    this.#connect();
  }

  reconnect(): void {
    this.#connect();
  }

  #watchPage(): void {
    if (typeof document === "undefined") return;
    const sync = () => this.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", sync);
    this.#unwatchPage = () => document.removeEventListener("visibilitychange", sync);
    this.#visible = document.visibilityState === "visible";
  }

  #disconnect(): void {
    clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#close?.();
    this.#close = null;
  }

  #connect(): void {
    this.#disconnect();
    if (!this.#visible || this.#listeners.size === 0) return;
    this.#close = this.#open(this.#url, {
      open: () => this.#update({ streamDown: false }),
      error: (closed) => {
        this.#update({ streamDown: true });
        // An event source gives up for good on an HTTP error (a session the server cannot place
        // yet, a restart in progress); it reconnects by itself only after a dropped connection.
        if (closed) this.#retry = setTimeout(() => this.#connect(), STREAM_RETRY_MS);
      },
      message: (data) => this.#receive(data),
    });
  }

  #receive(data: string): void {
    let event: PaneEvent;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.type === "state") {
      this.#update({ state: event.state });
      return;
    }
    this.#frameSrc = `data:image/jpeg;base64,${event.data}`;
    for (const listener of this.#frameListeners) listener(this.#frameSrc);
    const { frameSize, frameTabId } = this.#snapshot;
    if (frameSize?.width !== event.width || frameSize.height !== event.height || frameTabId !== event.tabId) {
      this.#update({ frameSize: { width: event.width, height: event.height }, frameTabId: event.tabId, hadView: true });
    }
  }

  #update(change: Partial<PaneViewSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
}
