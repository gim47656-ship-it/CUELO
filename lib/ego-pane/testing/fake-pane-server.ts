import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for ego lite's pane channel (contract v1) for tests and UI checks without an ego app.
 * It answers the same paths and status codes and records what it was asked to do.
 */
export interface FakeTab {
  targetId: string;
  title: string;
  url: string;
  active: boolean;
}

export interface FakeSpace {
  spaceId: number;
  ownership: "agent" | "user";
  tabs: FakeTab[];
}

export interface FakeInput {
  space: string;
  targetId: string;
  event: Record<string, unknown>;
}

export interface FakePaneServer {
  port: number;
  token: string;
  spaces: Map<string, FakeSpace>;
  /** Every input ego would have dispatched, in order. */
  inputs: FakeInput[];
  /** The `targetId` query of every frames stream that was opened ("" when following). */
  streamTargets: string[];
  /** Every viewer box ego was told, in order. */
  viewports: { space: string; width: number; height: number }[];
  openStreams(): number;
  /** Sends the space's state to its open streams; call after changing `spaces`. */
  pushState(space: string): void;
  /** Sends one frame of a tab to the streams that show it. */
  pushFrame(space: string, targetId: string, jpeg?: string, size?: { width: number; height: number }): void;
  /** Completes a space: its streams get `gone` and end. */
  removeSpace(space: string): void;
  /** Ends the space's open streams without a word, as a dropped capture would. */
  dropStreams(space: string): void;
  /** Line ending of the event stream; SSE allows "\r\n" as well. */
  lineEnd: "\n" | "\r\n";
  /** While true, a new frames request answers 503 although state and input still work. */
  failFrames: boolean;
  /** While set, an input request waits for it before it is checked and answered. */
  holdInput: Promise<void> | null;
  stop(): Promise<void>;
}

const INPUT_TYPES: Record<string, true> = { mouseDown: true, mouseUp: true, mouseMove: true, mouseWheel: true, keyDown: true, keyUp: true, char: true, text: true };

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, body === undefined ? {} : { "Content-Type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : null;
  } catch {
    return null;
  }
}

/** Starts the fake channel on a free loopback port and announces it in `channelPath`, as ego does. */
export async function startFakePaneServer(channelPath: string): Promise<FakePaneServer> {
  const token = randomUUID();
  const spaces = new Map<string, FakeSpace>();
  const inputs: FakeInput[] = [];
  const streamTargets: string[] = [];
  const viewports: FakePaneServer["viewports"] = [];
  const streams = new Set<{ space: string; targetId: string | null; res: ServerResponse }>();
  const stateOf = (space: FakeSpace) => ({ spaceId: space.spaceId, ownership: space.ownership, tabs: space.tabs });
  const event = (res: ServerResponse, name: string, data: unknown) => {
    const end = controls.lineEnd;
    res.write(`event: ${name}${end}data: ${JSON.stringify(data)}${end}${end}`);
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers["x-ego-lite-pane-token"] !== token) return send(res, 401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/pane/state") {
        const space = spaces.get(url.searchParams.get("space") ?? "");
        return space ? send(res, 200, stateOf(space)) : send(res, 404, { error: "space not found" });
      }
      if (req.method === "GET" && url.pathname === "/pane/frames") {
        const name = url.searchParams.get("space") ?? "";
        const space = spaces.get(name);
        const targetId = url.searchParams.get("targetId");
        if (!space || (targetId && !space.tabs.some((tab) => tab.targetId === targetId))) return send(res, 404, { error: "space not found" });
        if (controls.failFrames) return send(res, 503, { error: "capture unavailable" });
        streamTargets.push(targetId ?? "");
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        const stream = { space: name, targetId, res };
        streams.add(stream);
        req.on("close", () => streams.delete(stream));
        event(res, "state", stateOf(space));
        return;
      }
      if (req.method === "POST" && url.pathname === "/pane/viewport") {
        const body = await readJson(req);
        const name = typeof body?.space === "string" ? body.space : "";
        if (!body || !spaces.has(name)) return send(res, 404, { error: "space not found" });
        const { width, height } = body;
        const fits = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 10_000;
        if (!fits(width) || !fits(height)) return send(res, 400, { error: "bad viewport" });
        viewports.push({ space: name, width, height });
        return send(res, 204);
      }
      if (req.method === "POST" && (url.pathname === "/pane/input" || url.pathname === "/pane/return")) {
        const body = await readJson(req);
        const name = typeof body?.space === "string" ? body.space : "";
        const space = spaces.get(name);
        if (!body || !space) return send(res, 404, { error: "space not found" });
        if (url.pathname === "/pane/return") {
          if (space.ownership !== "user") return send(res, 409, { error: "not user turn" });
          space.ownership = "agent";
          controls.pushState(name);
          return send(res, 200, { ownership: "agent" });
        }
        const targetId = typeof body.targetId === "string" ? body.targetId : "";
        if (!space.tabs.some((tab) => tab.targetId === targetId)) return send(res, 404, { error: "target not found" });
        const input = body.event;
        if (typeof input !== "object" || input === null || !("type" in input) || typeof input.type !== "string" || !Object.hasOwn(INPUT_TYPES, input.type)) {
          return send(res, 400, { error: "bad event" });
        }
        if (controls.holdInput) await controls.holdInput;
        if (space.ownership !== "user") return send(res, 409, { error: "not user turn" });
        inputs.push({ space: name, targetId, event: Object.fromEntries(Object.entries(input)) });
        return send(res, 204);
      }
      return send(res, 404, { error: "not found" });
    })();
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake pane server has no port");
  const port = (address satisfies AddressInfo).port;
  writeFileSync(channelPath, JSON.stringify({ version: 1, port, token, pid: process.pid }), { mode: 0o600 });

  const controls: FakePaneServer = {
    port,
    token,
    spaces,
    inputs,
    streamTargets,
    viewports,
    openStreams: () => streams.size,
    pushState(name) {
      const space = spaces.get(name);
      if (!space) return;
      for (const stream of streams) if (stream.space === name) event(stream.res, "state", stateOf(space));
    },
    pushFrame(name, targetId, jpeg = "AAAA", size = { width: 1440, height: 816 }) {
      const active = spaces.get(name)?.tabs.find((tab) => tab.active)?.targetId ?? null;
      for (const stream of streams) {
        if (stream.space === name && (stream.targetId ?? active) === targetId) event(stream.res, "frame", { targetId, ...size, jpeg });
      }
    },
    removeSpace(name) {
      spaces.delete(name);
      for (const stream of streams) {
        if (stream.space !== name) continue;
        event(stream.res, "gone", { error: "space not found" });
        stream.res.end();
      }
    },
    dropStreams(name) {
      for (const stream of streams) if (stream.space === name) stream.res.end();
    },
    lineEnd: "\n",
    failFrames: false,
    holdInput: null,
    stop() {
      const closed = Promise.withResolvers<void>();
      for (const stream of streams) stream.res.end();
      server.close(() => closed.resolve());
      server.closeAllConnections();
      return closed.promise;
    },
  };
  return controls;
}
