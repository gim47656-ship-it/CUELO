import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPaneState, postPaneInput, postPaneReturn, readPaneChannel } from "./channel";
import { PaneHub, readPaneOwnership, returnPaneControl, type PaneEvent, type PaneState } from "./hub";
import { toPaneEventBatch } from "./input";
import { paneChannelPath, paneSpaceName } from "./space";
import { PaneViewStore, type PaneSourceHandlers } from "./view-store";
import { startFakePaneServer, type FakePaneServer } from "./testing/fake-pane-server";

const SESSION = "0d0ebb11-a35e-4b59-bb0a-899b7a449458";
const SPACE = paneSpaceName(SESSION);
const TAB_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TAB_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CLICK = [
  { t: "mouse", type: "down", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 0 },
  { t: "mouse", type: "up", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 0 },
];

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// These tests talk to a real loopback HTTP server, so a condition is awaited by polling it: there
// is no fake clock to advance for a socket. The poll only bounds how long a failure takes.
async function until(check: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

/** A fake ego with one agent-owned space of two tabs, A active. */
async function setup(): Promise<{ fake: FakePaneServer; channelPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cuelo-pane-test-"));
  const channelPath = join(dir, "ego-lite-pane.json");
  const fake = await startFakePaneServer(channelPath);
  fake.spaces.set(SPACE, {
    spaceId: 7,
    ownership: "agent",
    tabs: [
      { targetId: TAB_A, title: "A", url: "https://a.example/", active: true },
      { targetId: TAB_B, title: "B", url: "https://b.example/", active: false },
    ],
  });
  cleanups.push(async () => {
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { fake, channelPath };
}

function watch(channelPath: string): { hub: PaneHub; events: PaneEvent[]; state: () => PaneState | undefined; frames: () => string[]; leave: () => void } {
  const hub = new PaneHub(SESSION, channelPath);
  const events: PaneEvent[] = [];
  const leave = hub.subscribe((event) => events.push(event));
  cleanups.push(leave);
  return {
    hub,
    events,
    state: () => events.findLast((event) => event.type === "state")?.state,
    frames: () => events.flatMap((event) => (event.type === "frame" ? [event.tabId] : [])),
    leave,
  };
}

/** Waits for the stream to open, sends the first frame of the tab it shows, and waits for live. */
async function goLive(view: ReturnType<typeof watch>, fake: FakePaneServer, tabId: string = TAB_A): Promise<void> {
  const opened = fake.streamTargets.length;
  await until(() => fake.openStreams() === 1 && fake.streamTargets.length >= Math.max(opened, 1) && view.state()?.tabId === tabId, "open stream");
  fake.pushFrame(SPACE, tabId);
  await until(() => view.state()?.status === "live" && view.state()?.tabId === tabId, "live state");
}

describe("pane channel discovery", () => {
  test("the default path sits beside ego-lite-bridge.json in the app's default profile", () => {
    expect(paneChannelPath({ EGO_LITE_APP_PROFILE_ROOT: "/x/root" })).toBe("/x/root/chromium-profile/ego-lite-pane.json");
  });

  test("a missing file, a wrong version and a dead pid all read as no channel", () => {
    const dir = mkdtempSync(join(tmpdir(), "cuelo-pane-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "ego-lite-pane.json");
    expect(readPaneChannel(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 2, port: 1234, token: "t", pid: process.pid }));
    expect(readPaneChannel(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 1, port: 1234, token: "t", pid: 2 ** 22 + 1 }));
    expect(readPaneChannel(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 1, port: 1234, token: "t", pid: process.pid }));
    expect(readPaneChannel(path)).toEqual({ port: 1234, token: "t" });
  });
});

describe("pane channel client", () => {
  test("a wrong token is refused (401) and reads as an ego that does not answer", async () => {
    const { fake, channelPath } = await setup();
    await expect(fetchPaneState({ port: fake.port, token: "wrong" }, SPACE)).rejects.toThrow("401");
    expect(await postPaneInput({ port: fake.port, token: "wrong" }, SPACE, TAB_A, { type: "text", text: "x" })).toBe(401);
    writeFileSync(channelPath, JSON.stringify({ version: 1, port: fake.port, token: "wrong", pid: process.pid }));
    expect(await readPaneOwnership(SESSION, channelPath)).toEqual({ ownership: null, available: false });
    expect(fake.inputs).toEqual([]);
  });

  test("an unknown space is 404: no state, no input, no return", async () => {
    const { fake } = await setup();
    const channel = { port: fake.port, token: fake.token };
    expect(await fetchPaneState(channel, "cuelo-other-user")).toBeNull();
    expect(await postPaneInput(channel, "cuelo-other-user", TAB_A, { type: "text", text: "x" })).toBe(404);
    expect(await postPaneReturn(channel, "cuelo-other-user")).toBe(404);
  });

  test("ego refuses input under the agent (409) and a tab outside the space (404)", async () => {
    const { fake } = await setup();
    const channel = { port: fake.port, token: fake.token };
    expect(await postPaneInput(channel, SPACE, TAB_A, { type: "text", text: "x" })).toBe(409);
    fake.spaces.get(SPACE)!.ownership = "user";
    expect(await postPaneInput(channel, SPACE, "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", { type: "text", text: "x" })).toBe(404);
    expect(await postPaneInput(channel, SPACE, TAB_A, { type: "text", text: "x" })).toBe(204);
    expect(fake.inputs).toEqual([{ space: SPACE, targetId: TAB_A, event: { type: "text", text: "x" } }]);
  });

  test("a redirect is refused, so typed text and the token never follow one", async () => {
    const { fake } = await setup();
    fake.spaces.get(SPACE)!.ownership = "user";
    // Something answering on the announced port that sends every request on to the real channel.
    const redirector = createServer((req, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${fake.port}${req.url}` });
      res.end();
    });
    const listening = Promise.withResolvers<void>();
    redirector.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    cleanups.push(() => {
      redirector.close();
      redirector.closeAllConnections();
    });
    const address = redirector.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const channel = { port: address.port, token: fake.token };
    expect(await postPaneInput(channel, SPACE, TAB_A, { type: "text", text: "secret" })).toBe(0);
    expect(await postPaneReturn(channel, SPACE)).toBe(0);
    await expect(fetchPaneState(channel, SPACE)).rejects.toThrow();
    expect(fake.inputs).toEqual([]);
    expect(fake.spaces.get(SPACE)!.ownership).toBe("user");
  });
});

describe("toPaneEventBatch", () => {
  test("maps the whitelisted shapes to channel events", () => {
    expect(toPaneEventBatch([
      { t: "mouse", type: "move", x: 1, y: 2, modifiers: 0 },
      { t: "mouse", type: "down", x: 1, y: 2, button: "left", clickCount: 2, modifiers: 8 },
      { t: "wheel", x: 1, y: 2, dx: 0, dy: 120, modifiers: 0 },
      { t: "key", type: "down", key: "A", modifiers: 8 },
      { t: "key", type: "up", key: "A", modifiers: 8 },
      { t: "key", type: "down", key: "ArrowLeft", modifiers: 0 },
      { t: "key", type: "down", key: "c", modifiers: 2 },
      { t: "key", type: "down", key: "Enter", modifiers: 0 },
      { t: "text", text: "한글" },
    ])).toEqual([
      { type: "mouseMove", x: 1, y: 2, modifiers: [] },
      { type: "mouseDown", x: 1, y: 2, button: "left", clickCount: 2, modifiers: ["shift"] },
      { type: "mouseWheel", x: 1, y: 2, deltaX: 0, deltaY: 120, modifiers: [] },
      { type: "keyDown", keyCode: "a", modifiers: ["shift"] },
      { type: "char", keyCode: "A" },
      { type: "keyUp", keyCode: "a", modifiers: ["shift"] },
      { type: "keyDown", keyCode: "Left", modifiers: [] },
      { type: "keyDown", keyCode: "c", modifiers: ["control"] },
      { type: "keyDown", keyCode: "Enter", modifiers: [] },
      { type: "text", text: "한글" },
    ]);
  });

  test("a key the channel cannot name sends nothing; an unnamed printable character is typed", () => {
    expect(toPaneEventBatch([{ t: "key", type: "down", key: "AudioVolumeUp", modifiers: 0 }])).toEqual([]);
    expect(toPaneEventBatch([{ t: "key", type: "down", key: "é", modifiers: 0 }])).toEqual([{ type: "char", keyCode: "é" }]);
  });

  test("one bad event rejects the whole batch", () => {
    expect(toPaneEventBatch([{ t: "text", text: "ok" }, { t: "cdp", method: "Runtime.evaluate" }])).toBeNull();
    expect(toPaneEventBatch([{ t: "mouse", type: "down", x: 1, y: 2, button: "back", clickCount: 1 }])).toBeNull();
    expect(toPaneEventBatch([{ t: "mouse", type: "down", x: -1, y: 2, button: "left", clickCount: 1 }])).toBeNull();
    expect(toPaneEventBatch([{ t: "text", text: "x".repeat(2_001) }])).toBeNull();
    // A modifier value that is no bit set must not turn a shortcut into typed text.
    expect(toPaneEventBatch([{ t: "key", type: "down", key: "a", modifiers: 16 }])).toBeNull();
    expect(toPaneEventBatch([{ t: "key", type: "down", key: "a", modifiers: "2" }])).toBeNull();
    expect(toPaneEventBatch([])).toBeNull();
    expect(toPaneEventBatch("click")).toBeNull();
    expect(toPaneEventBatch(Array.from({ length: 65 }, () => ({ t: "text", text: "x" })))).toBeNull();
  });
});

describe("PaneHub", () => {
  test("shows the session's own space, waits for a frame, and forwards the frames of the agent's tab", async () => {
    const { fake, channelPath } = await setup();
    const view = watch(channelPath);
    await until(() => view.state()?.status === "waiting" && fake.openStreams() === 1, "waiting state");
    expect(view.state()).toEqual({
      status: "waiting",
      ownership: "agent",
      tabs: [{ id: TAB_A, title: "A", url: "https://a.example/" }, { id: TAB_B, title: "B", url: "https://b.example/" }],
      tabId: TAB_A,
      agentTabId: TAB_A,
      follow: true,
    });
    expect(fake.streamTargets).toEqual([""]);
    fake.pushFrame(SPACE, TAB_A, "QUJD", { width: 1200, height: 700 });
    await until(() => view.frames().length === 1, "frame");
    expect(view.state()?.status).toBe("live");
    expect(view.events.at(-1)).toEqual({ type: "frame", tabId: TAB_A, data: "QUJD", width: 1200, height: 700 });
  });

  test("a CRLF event stream is read like an LF one", async () => {
    const { fake, channelPath } = await setup();
    fake.lineEnd = "\r\n";
    const view = watch(channelPath);
    await goLive(view, fake);
    expect(view.frames()).toEqual([TAB_A]);
  });

  test("input is refused while the agent controls and sent once ego says user", async () => {
    const { fake, channelPath } = await setup();
    const view = watch(channelPath);
    await goLive(view, fake);
    expect(await view.hub.input(TAB_A, CLICK)).toBe("not-user");
    expect(fake.inputs).toEqual([]);
    fake.spaces.get(SPACE)!.ownership = "user";
    fake.pushState(SPACE);
    await until(() => view.state()?.ownership === "user", "user turn");
    expect(await view.hub.input(TAB_A, [{ t: "cdp" }])).toBe("invalid");
    expect(await view.hub.input(undefined, CLICK)).toBe("invalid");
    expect(await view.hub.input(TAB_A, CLICK)).toBe("sent");
    expect(fake.inputs.map((input) => [input.space, input.targetId, input.event.type])).toEqual([[SPACE, TAB_A, "mouseDown"], [SPACE, TAB_A, "mouseUp"]]);
  });

  test("no input before the first frame of the stream", async () => {
    const { fake, channelPath } = await setup();
    fake.spaces.get(SPACE)!.ownership = "user";
    const view = watch(channelPath);
    await until(() => view.state()?.status === "waiting" && fake.openStreams() === 1, "waiting state");
    expect(await view.hub.input(TAB_A, CLICK)).toBe("not-live");
    expect(fake.inputs).toEqual([]);
  });

  test("ego's own refusal wins when the hub's ownership is stale", async () => {
    const { fake, channelPath } = await setup();
    fake.spaces.get(SPACE)!.ownership = "user";
    const view = watch(channelPath);
    await goLive(view, fake);
    // The agent took over, and ego has not told the stream yet.
    fake.spaces.get(SPACE)!.ownership = "agent";
    expect(await view.hub.input(TAB_A, CLICK)).toBe("not-user");
    expect(fake.inputs).toEqual([]);
  });

  test("a picked tab must belong to the space; following comes back with null", async () => {
    const { fake, channelPath } = await setup();
    const view = watch(channelPath);
    await goLive(view, fake);
    expect(view.hub.selectTab("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC")).toBe(false);
    expect(view.hub.selectTab(TAB_B)).toBe(true);
    await until(() => view.state()?.tabId === TAB_B && fake.streamTargets.length === 2 && fake.openStreams() === 1, "pinned stream");
    expect(fake.streamTargets[1]).toBe(TAB_B);
    // A picked tab is waited for, not reported as a lost view.
    expect(view.state()).toMatchObject({ status: "waiting", tabId: TAB_B, agentTabId: TAB_A, follow: false });
    expect(view.hub.selectTab(null)).toBe(true);
    await until(() => view.state()?.follow === true && fake.streamTargets.length === 3 && fake.openStreams() === 1, "following again");
    expect(fake.streamTargets[2]).toBe("");
  });

  test("while following, the view moves with the tab the stream shows", async () => {
    const { fake, channelPath } = await setup();
    const view = watch(channelPath);
    await goLive(view, fake);
    const space = fake.spaces.get(SPACE)!;
    space.tabs = space.tabs.map((tab) => ({ ...tab, active: tab.targetId === TAB_B }));
    fake.pushState(SPACE);
    fake.pushFrame(SPACE, TAB_B);
    await until(() => view.state()?.tabId === TAB_B, "followed tab");
    expect(view.state()).toMatchObject({ tabId: TAB_B, agentTabId: TAB_B, follow: true });
    expect(fake.streamTargets).toEqual([""]);
  });

  test("input made on one tab never reaches the tab that shows afterwards", async () => {
    const { fake, channelPath } = await setup();
    fake.spaces.get(SPACE)!.ownership = "user";
    const view = watch(channelPath);
    await goLive(view, fake);
    // The stream moves to B while a paste made on A is still on its way.
    const space = fake.spaces.get(SPACE)!;
    space.tabs = space.tabs.map((tab) => ({ ...tab, active: tab.targetId === TAB_B }));
    fake.pushState(SPACE);
    fake.pushFrame(SPACE, TAB_B);
    await until(() => view.state()?.tabId === TAB_B, "followed tab");
    expect(await view.hub.input(TAB_A, [{ t: "text", text: "marker" }])).toBe("not-live");
    expect(fake.inputs).toEqual([]);
    expect(await view.hub.input(TAB_B, [{ t: "text", text: "for b" }])).toBe("sent");
    expect(fake.inputs.map((input) => input.targetId)).toEqual([TAB_B]);
  });

  test("a batch in flight stops when the last subscriber leaves", async () => {
    const { fake, channelPath } = await setup();
    fake.spaces.get(SPACE)!.ownership = "user";
    const view = watch(channelPath);
    await goLive(view, fake);
    const gate = Promise.withResolvers<void>();
    fake.holdInput = gate.promise;
    const result = view.hub.input(TAB_A, [{ t: "text", text: "first" }, { t: "text", text: "second" }]);
    view.leave();
    gate.resolve();
    expect(await result).toBe("not-live");
    // The request already on its way lands; the one not yet sent never starts.
    expect(fake.inputs.map((input) => input.event.text)).toEqual(["first"]);
  });

  test("a stream that drops reads as lost and takes no input until a new frame", async () => {
    const { fake, channelPath } = await setup();
    fake.spaces.get(SPACE)!.ownership = "user";
    const view = watch(channelPath);
    await goLive(view, fake);
    // Capture fails from here on, while state and input endpoints stay healthy.
    fake.failFrames = true;
    fake.dropStreams(SPACE);
    await until(() => view.state()?.status === "lost", "lost state");
    expect(await view.hub.input(TAB_A, CLICK)).toBe("not-live");
    // Two reconnect rounds later it is still lost, not live on the old picture.
    await until(() => view.events.filter((event) => event.type === "state" && event.state.status === "lost").length >= 3, "retries");
    expect(view.state()).toMatchObject({ status: "lost", ownership: "user" });
    expect(await view.hub.input(TAB_A, CLICK)).toBe("not-live");
    expect(fake.inputs).toEqual([]);
    fake.failFrames = false;
    await until(() => fake.openStreams() === 1, "stream reopened");
    fake.pushFrame(SPACE, TAB_A);
    await until(() => view.state()?.status === "live", "live again");
    expect(await view.hub.input(TAB_A, CLICK)).toBe("sent");
  });

  test("the last subscriber leaving closes the frames stream", async () => {
    const { fake, channelPath } = await setup();
    const hub = new PaneHub(SESSION, channelPath);
    const leaveFirst = hub.subscribe(() => {});
    const leaveSecond = hub.subscribe(() => {});
    await until(() => fake.openStreams() === 1, "one shared stream");
    leaveFirst();
    expect(hub.idle).toBe(false);
    leaveSecond();
    await until(() => fake.openStreams() === 0, "stream closed");
    expect(hub.idle).toBe(true);
  });

  test("a viewer that joins later shares the stream and starts with the state and the last frame", async () => {
    const { fake, channelPath } = await setup();
    const first = watch(channelPath);
    await goLive(first, fake);
    const joined: PaneEvent[] = [];
    cleanups.push(first.hub.subscribe((event) => joined.push(event)));
    expect(joined.map((event) => event.type)).toEqual(["state", "frame"]);
    expect(joined[0]).toEqual({ type: "state", state: first.state()! });
    expect(fake.openStreams()).toBe(1);
    expect(fake.streamTargets.length).toBe(1);
  });

  test("a completed space reads as none, and an ego that stops reads as off", async () => {
    const { fake, channelPath } = await setup();
    const view = watch(channelPath);
    await goLive(view, fake);
    fake.removeSpace(SPACE);
    await until(() => view.state()?.status === "none", "none after gone");
    expect(view.state()).toMatchObject({ ownership: null, tabs: [], tabId: null });
    expect(await view.hub.input(TAB_A, CLICK)).toBe("not-live");
    await fake.stop();
    await until(() => view.state()?.status === "off", "off after stop");
  });
});

describe("returnPaneControl", () => {
  test("only a user-owned space is handed back, by ego itself", async () => {
    const { fake, channelPath } = await setup();
    expect(await returnPaneControl(SESSION, channelPath)).toBe("not-user");
    fake.spaces.get(SPACE)!.ownership = "user";
    expect(await readPaneOwnership(SESSION, channelPath)).toEqual({ ownership: "user", available: true });
    expect(await returnPaneControl(SESSION, channelPath)).toBe("returned");
    expect(fake.spaces.get(SPACE)!.ownership).toBe("agent");
    expect(await readPaneOwnership(SESSION, channelPath)).toEqual({ ownership: "agent", available: true });
  });

  test("fails without a running ego or without the space", async () => {
    const { fake, channelPath } = await setup();
    fake.spaces.clear();
    expect(await returnPaneControl(SESSION, channelPath)).toBe("failed");
    expect(await readPaneOwnership(SESSION, channelPath)).toEqual({ ownership: null, available: true });
    expect(await returnPaneControl(SESSION, join(tmpdir(), "cuelo-pane-test-missing", "ego-lite-pane.json"))).toBe("failed");
  });
});

describe("PaneViewStore", () => {
  // The store watches the page's visibility. Other test files in the same run
  // leave their own `document` stand-ins behind, so these tests bring a visible page.
  let savedDocument: PropertyDescriptor | undefined;
  beforeEach(() => {
    savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    });
  });
  afterEach(() => {
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  /** Stands in for the page's event source: counts what is open and lets the test speak as the server. */
  function source(): { open: (url: string, handlers: PaneSourceHandlers) => () => void; live: () => number; opened: () => number; send: (event: PaneEvent) => void } {
    const live = new Set<PaneSourceHandlers>();
    let opened = 0;
    return {
      open: (_url, handlers) => {
        opened += 1;
        live.add(handlers);
        handlers.open();
        return () => live.delete(handlers);
      },
      live: () => live.size,
      opened: () => opened,
      send: (event) => {
        for (const handlers of live) handlers.message(JSON.stringify(event));
      },
    };
  }
  const STATE: PaneState = { status: "live", ownership: "user", tabs: [{ id: TAB_A, title: "A", url: "https://a.example/" }], tabId: TAB_A, agentTabId: TAB_A, follow: true };

  test("two surfaces of one session read one stream, one state and the same frames", () => {
    const fake = source();
    const store = new PaneViewStore("/events", fake.open);
    const leavePane = store.subscribe(() => {});
    fake.send({ type: "state", state: STATE });
    fake.send({ type: "frame", tabId: TAB_A, data: "QUJD", width: 1200, height: 700 });

    // The inspector tab joins after the pane: no second stream, and it starts with what the pane shows.
    let renders = 0;
    const leaveInspector = store.subscribe(() => { renders += 1; });
    const frames: string[] = [];
    const unwatch = store.watchFrames((src) => frames.push(src));
    expect(fake.opened()).toBe(1);
    expect(store.getSnapshot()).toEqual({ state: STATE, streamDown: false, frameSize: { width: 1200, height: 700 }, frameTabId: TAB_A, hadView: true });
    // Whoever draws starts with the frame that is showing, whenever it begins to watch.
    expect(frames).toEqual(["data:image/jpeg;base64,QUJD"]);

    // A frame of the same tab and size is drawn, not rendered.
    fake.send({ type: "frame", tabId: TAB_A, data: "REVG", width: 1200, height: 700 });
    expect(frames).toEqual(["data:image/jpeg;base64,QUJD", "data:image/jpeg;base64,REVG"]);
    expect(renders).toBe(0);
    fake.send({ type: "frame", tabId: TAB_B, data: "R0hJ", width: 1200, height: 700 });
    expect(store.getSnapshot().frameTabId).toBe(TAB_B);
    expect(renders).toBe(1);

    leavePane();
    expect(fake.live()).toBe(1);
    leaveInspector();
    unwatch();
    expect(fake.live()).toBe(0);
    // The next view of the session starts from nothing.
    expect(store.getSnapshot()).toEqual({ state: null, streamDown: false, frameSize: null, frameTabId: null, hadView: false });
    expect(store.frameSrc).toBe("");
  });

  test("a hidden page holds no stream, and the view picks up when it shows again", () => {
    const fake = source();
    const store = new PaneViewStore("/events", fake.open);
    const leave = store.subscribe(() => {});
    fake.send({ type: "frame", tabId: TAB_A, data: "QUJD", width: 1200, height: 700 });
    store.setVisible(false);
    expect(fake.live()).toBe(0);
    expect(store.getSnapshot().hadView).toBe(true);
    store.setVisible(true);
    expect(fake.live()).toBe(1);
    expect(fake.opened()).toBe(2);
    leave();
    expect(fake.live()).toBe(0);
  });
});
