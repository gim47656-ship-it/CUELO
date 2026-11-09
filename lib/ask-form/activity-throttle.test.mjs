import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createActivityThrottle } = await jiti.import("./activity-throttle.ts");

/** A clock the test moves by hand; due timers run only when the test says so. */
function manualClock() {
  const clock = {
    time: 10_000,
    timers: new Map(),
    next: 1,
    now: () => clock.time,
    setTimeout(callback, ms) {
      const id = clock.next++;
      clock.timers.set(id, { callback, at: clock.time + ms });
      return id;
    },
    clearTimeout(id) {
      clock.timers.delete(id);
    },
    advance(ms) {
      clock.time += ms;
      for (const [id, timer] of [...clock.timers]) {
        if (timer.at <= clock.time) {
          clock.timers.delete(id);
          timer.callback();
        }
      }
    },
  };
  return clock;
}

test("the first edit reports at once and a burst collapses into one trailing report", () => {
  const clock = manualClock();
  const sent = [];
  const throttle = createActivityThrottle(() => sent.push(clock.time), 1000, clock);
  throttle.notify();
  assert.deepEqual(sent, [10_000]);
  clock.advance(100);
  throttle.notify();
  clock.advance(100);
  throttle.notify();
  assert.deepEqual(sent, [10_000], "edits inside the interval wait");
  clock.advance(800);
  assert.deepEqual(sent, [10_000, 11_000], "one trailing report carries the last edit");
});

test("an edit arriving after the interval while a trailing report is still queued never sends twice", () => {
  const clock = manualClock();
  const sent = [];
  const throttle = createActivityThrottle(() => sent.push(clock.time), 1000, clock);
  throttle.notify();
  clock.advance(100);
  throttle.notify(); // queues the trailing report for t=11000
  clock.time = 11_001; // the timer is overdue but has not run yet
  throttle.notify();
  assert.deepEqual(sent, [10_000, 11_001]);
  clock.advance(0);
  assert.deepEqual(sent, [10_000, 11_001], "the queued report was cancelled by the immediate one");
  clock.advance(999);
  throttle.notify();
  clock.advance(1);
  assert.deepEqual(sent, [10_000, 11_001, 12_001]);
});

test("cancel drops a queued report", () => {
  const clock = manualClock();
  const sent = [];
  const throttle = createActivityThrottle(() => sent.push(clock.time), 1000, clock);
  throttle.notify();
  clock.advance(10);
  throttle.notify();
  throttle.cancel();
  clock.advance(2000);
  assert.deepEqual(sent, [10_000]);
});
