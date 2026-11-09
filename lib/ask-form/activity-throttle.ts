/**
 * Rate limit for the form values a timed card reports to the server: the first edit reports at once,
 * later edits within `intervalMs` collapse into one trailing report, so the server always receives the
 * latest values within `intervalMs` of a change and never two reports closer than `intervalMs`.
 */
export interface ActivityClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: ActivityClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ActivityThrottle {
  /** An edit happened. */
  notify(): void;
  /** Drop a pending trailing report (the card is closing). */
  cancel(): void;
}

export function createActivityThrottle(send: () => void, intervalMs: number, clock: ActivityClock = REAL_CLOCK): ActivityThrottle {
  let lastReport = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  let pending = false;
  const report = () => {
    if (pending) clock.clearTimeout(timer);
    pending = false;
    lastReport = clock.now();
    send();
  };
  return {
    notify() {
      const wait = intervalMs - (clock.now() - lastReport);
      if (wait <= 0) report();
      else if (!pending) {
        pending = true;
        timer = clock.setTimeout(report, wait);
      }
    },
    cancel() {
      if (pending) clock.clearTimeout(timer);
      pending = false;
    },
  };
}
