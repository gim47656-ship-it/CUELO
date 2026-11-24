import { readFileSync } from "node:fs";
import type { PaneChannelEvent } from "./input";
import { isPaneTargetId, type EgoOwnership } from "./space";

/**
 * Client of ego lite's pane channel (contract v1): a loopback HTTP endpoint the ego app opens for
 * exactly this view. It can show one named TaskSpace, forward input while ego says the space is the
 * user's, and hand control back. The token stays in this module's callers on the server: it is
 * never sent to a browser and never logged. Each request closes its connection, so the only socket
 * that stays open to ego is a frames stream someone is watching.
 */
export interface PaneChannel {
  port: number;
  token: string;
}

export interface PaneTab {
  id: string;
  title: string;
  url: string;
  /** The tab the space currently shows: the one the agent is using. */
  active: boolean;
}

export interface PaneSpaceState {
  ownership: EgoOwnership;
  tabs: PaneTab[];
}

export interface PaneFrame {
  targetId: string;
  /** CSS pixels of the page viewport the frame shows; input positions use the same space. */
  width: number;
  height: number;
  /** Base64 JPEG. */
  jpeg: string;
}

export interface PaneFrameHandlers {
  onState(state: PaneSpaceState): void;
  onFrame(frame: PaneFrame): void;
  /** The stream is over: the space or the pinned tab went away, ego stopped, or the request failed. */
  onEnd(): void;
}

export interface PaneFrameStream {
  close(): void;
}

const REQUEST_TIMEOUT_MS = 3_000;
/** Wide enough for the pane at 크게 보기 on a 2x display, without shipping full 4K frames. */
const FRAME_MAX_WIDTH = 1_600;
/** Far above one frame of that width; an unfinished event longer than this ends the stream. */
const MAX_EVENT_CHARS = 16 * 1024 * 1024;

function field(value: object, key: string): unknown {
  return key in value ? Reflect.get(value, key) : undefined;
}

/** The channel the running ego app announced, or null when the file is missing, malformed or stale. */
export function readPaneChannel(path: string): PaneChannel | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || field(parsed, "version") !== 1) return null;
    const port = field(parsed, "port");
    const token = field(parsed, "token");
    const pid = field(parsed, "pid");
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    if (typeof token !== "string" || token.length === 0 || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
    } catch (error) {
      // EPERM means the process exists under another user; anything else means it is gone.
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") return null;
    }
    return { port, token };
  } catch {
    return null;
  }
}

export function parsePaneSpaceState(value: unknown): PaneSpaceState | null {
  if (typeof value !== "object" || value === null) return null;
  const ownership = field(value, "ownership");
  const list = field(value, "tabs");
  if ((ownership !== "agent" && ownership !== "user") || !Array.isArray(list)) return null;
  const tabs: PaneTab[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = field(entry, "targetId");
    const title = field(entry, "title");
    const url = field(entry, "url");
    if (!isPaneTargetId(id)) continue;
    tabs.push({ id, title: typeof title === "string" ? title : "", url: typeof url === "string" ? url : "", active: field(entry, "active") === true });
  }
  return { ownership, tabs };
}

// A redirect is no answer of this channel: following one could carry the token or typed text to
// another endpoint, so it fails the request instead.
function request(channel: PaneChannel, path: string, init: { method?: string; body?: unknown; signal: AbortSignal }): Promise<Response> {
  return fetch(`http://127.0.0.1:${channel.port}${path}`, {
    redirect: "error",
    method: init.method ?? "GET",
    headers: {
      "x-ego-lite-pane-token": channel.token,
      Connection: "close",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    keepalive: false,
    signal: init.signal,
  });
}

/** The space's state, or null when ego has no such space (404). Throws when ego does not answer as agreed. */
export async function fetchPaneState(channel: PaneChannel, space: string): Promise<PaneSpaceState | null> {
  const response = await request(channel, `/pane/state?space=${encodeURIComponent(space)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw new Error(`pane state answered ${response.status}`);
  const state = parsePaneSpaceState(await response.json());
  if (!state) throw new Error("unexpected pane state answer");
  return state;
}

/**
 * Opens the frames stream of a space: a given tab, or the active one when targetId is null. ego
 * captures only while this stream is open, so close() is what stops the capture.
 */
export function openPaneFrames(channel: PaneChannel, space: string, targetId: string | null, handlers: PaneFrameHandlers): PaneFrameStream {
  const abort = new AbortController();
  let closed = false;
  const query = new URLSearchParams({ space, maxWidth: String(FRAME_MAX_WIDTH) });
  if (targetId) query.set("targetId", targetId);

  const dispatch = (name: string, data: string): boolean => {
    if (name === "gone") return false;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return true;
    }
    if (name === "state") {
      const state = parsePaneSpaceState(payload);
      if (state) handlers.onState(state);
    } else if (name === "frame" && typeof payload === "object" && payload !== null) {
      const id = field(payload, "targetId");
      const width = field(payload, "width");
      const height = field(payload, "height");
      const jpeg = field(payload, "jpeg");
      if (isPaneTargetId(id) && typeof width === "number" && width > 0 && typeof height === "number" && height > 0 && typeof jpeg === "string") {
        handlers.onFrame({ targetId: id, width, height, jpeg });
      }
    }
    return true;
  };

  const run = async () => {
    try {
      const response = await request(channel, `/pane/frames?${query}`, { signal: abort.signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        // SSE allows CRLF line ends; a lone CR at a chunk edge pairs up with the next chunk.
        buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n");
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let name = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) name = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trimStart();
          }
          if (!dispatch(name, data)) {
            abort.abort();
            return;
          }
        }
        // What is left is one unfinished event: stop instead of buffering it without bound.
        if (buffer.length > MAX_EVENT_CHARS) {
          abort.abort();
          return;
        }
      }
    } catch {
      // Aborted by close(), or ego went away: both end the stream.
    }
  };
  void run().finally(() => {
    if (!closed) handlers.onEnd();
  });

  return {
    close() {
      closed = true;
      abort.abort();
    },
  };
}

/** Forwards one input event. Resolves ego's HTTP status (204 sent, 409 not the user's turn), or 0 when ego did not answer. */
export async function postPaneInput(channel: PaneChannel, space: string, targetId: string, event: PaneChannelEvent): Promise<number> {
  try {
    const response = await request(channel, "/pane/input", { method: "POST", body: { space, targetId, event }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return 0;
  }
}

/** Asks ego to give the space back to the agent. Resolves ego's HTTP status (200 returned, 409 already the agent's), or 0. */
export async function postPaneReturn(channel: PaneChannel, space: string): Promise<number> {
  try {
    const response = await request(channel, "/pane/return", { method: "POST", body: { space }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return 0;
  }
}

/**
 * Tells ego how big the box is that shows the space (CSS pixels), so its tabs lay out in that
 * shape. Resolves ego's HTTP status (204 taken, 404 no such space, 400 refused), or 0.
 */
export async function postPaneViewport(channel: PaneChannel, space: string, width: number, height: number): Promise<number> {
  try {
    const response = await request(channel, "/pane/viewport", { method: "POST", body: { space, width, height }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return 0;
  }
}
