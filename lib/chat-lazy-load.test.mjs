import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./chat-lazy-load.ts");
}

test("the tail window shows only the last visible render items", async () => {
  const { getVisibleRenderWindow, TAIL_WINDOW } = await loadSubject();
  assert.deepEqual(getVisibleRenderWindow(200, TAIL_WINDOW), { startIndex: 150, endIndex: 200, hasMore: true, hasLater: false });
});

test("shows all render items when the visible count reaches the total", async () => {
  const { getVisibleRenderWindow, TAIL_WINDOW } = await loadSubject();
  assert.deepEqual(getVisibleRenderWindow(30, TAIL_WINDOW), { startIndex: 0, endIndex: 30, hasMore: false, hasLater: false });
  assert.deepEqual(getVisibleRenderWindow(50, TAIL_WINDOW), { startIndex: 0, endIndex: 50, hasMore: false, hasLater: false });
  assert.deepEqual(getVisibleRenderWindow(0, TAIL_WINDOW), { startIndex: 0, endIndex: 0, hasMore: false, hasLater: false });
});

test("continues paging earlier items when render items outnumber source messages", async () => {
  const { loadEarlier, getVisibleRenderWindow, TAIL_WINDOW } = await loadSubject();
  let window = loadEarlier(TAIL_WINDOW);
  assert.equal(getVisibleRenderWindow(120, window).startIndex, 20);
  window = loadEarlier(window);
  assert.deepEqual(getVisibleRenderWindow(120, window), { startIndex: 0, endIndex: 120, hasMore: false, hasLater: false });
});

test("a jump to an old item detaches a window around it; new items stay outside until it re-attaches", async () => {
  const { windowAround, loadLater, getVisibleRenderWindow, TAIL_WINDOW } = await loadSubject();
  const detached = windowAround(1000, 3, TAIL_WINDOW);
  assert.deepEqual(getVisibleRenderWindow(1000, detached), { startIndex: 0, endIndex: 50, hasMore: false, hasLater: true });
  // Messages arriving meanwhile do not move the detached window.
  assert.deepEqual(getVisibleRenderWindow(1010, detached), { startIndex: 0, endIndex: 50, hasMore: false, hasLater: true });

  const middle = windowAround(1000, 500, TAIL_WINDOW);
  assert.deepEqual(getVisibleRenderWindow(1000, middle), { startIndex: 490, endIndex: 540, hasMore: true, hasLater: true });
  assert.equal(windowAround(1000, 520, middle), middle, "an item already rendered keeps the window");

  // Paging down keeps the top where it is and re-attaches at the tail.
  let window = middle;
  while (window.end !== null) window = loadLater(1000, window);
  assert.deepEqual(getVisibleRenderWindow(1000, window), { startIndex: 490, endIndex: 1000, hasMore: true, hasLater: false });
});

test("a jump near the end stays attached to the tail", async () => {
  const { windowAround, TAIL_WINDOW } = await loadSubject();
  assert.deepEqual(windowAround(100, 95, { count: 3, end: null }), { count: 15, end: null });
  assert.equal(windowAround(100, 60, TAIL_WINDOW), TAIL_WINDOW);
});

test("restores the viewport after prepending content", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  const savedDistance = captureScrollDistance(2000, 500);

  assert.equal(savedDistance, 1500);
  assert.equal(restoreScrollTop(2500, savedDistance), 1000);
});

test("restores top and bottom boundary positions", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  assert.equal(restoreScrollTop(3000, captureScrollDistance(2000, 0)), 1000);
  assert.equal(restoreScrollTop(3000, captureScrollDistance(2000, 2000)), 3000);
});
