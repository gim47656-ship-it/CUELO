import { describe, expect, test } from "bun:test";
import { applyPop, markerState, planSync, preserveMarker, stateDepth, type OverlayMarker } from "./overlay-history";

/** A browser history in miniature: entries with states and a cursor, as `pushState`/`go` move them. */
class FakeHistory {
  entries: unknown[] = [{ base: true }];
  index = 0;
  get state() {
    return this.entries[this.index];
  }
  push(state: unknown) {
    this.entries = [...this.entries.slice(0, this.index + 1), state];
    this.index += 1;
  }
  go(delta: number) {
    this.index = Math.max(0, Math.min(this.entries.length - 1, this.index + delta));
    return this.state;
  }
}

/** Applies a sync plan the way `useOverlayHistory` does: one `go(-back)`, then pushes. */
function sync(history: FakeHistory, pushed: OverlayMarker[], desired: OverlayMarker[]): OverlayMarker[] {
  const plan = planSync(pushed, desired);
  let next = pushed;
  if (plan.back > 0) next = applyPop(next, history.go(-plan.back)).pushed;
  for (const marker of plan.push) {
    next = [...next, marker];
    history.push(markerState(marker, next.length));
  }
  return next;
}

describe("overlay history stack", () => {
  test("face then card: back closes only the card, a second back exits face, the base entry remains", () => {
    const history = new FakeHistory();
    let pushed = sync(history, [], ["face"]);
    pushed = sync(history, pushed, ["face", "card"]);
    expect(history.entries).toHaveLength(3);

    const first = applyPop(pushed, history.go(-1));
    expect(first.closed).toEqual(["card"]);
    pushed = first.pushed;
    expect(pushed).toEqual(["face"]);

    const second = applyPop(pushed, history.go(-1));
    expect(second.closed).toEqual(["face"]);
    expect(second.pushed).toEqual([]);
    expect(history.index).toBe(0);
    expect(stateDepth(history.state)).toBe(0);
  });

  test("hiding the translator with face and card open consumes both entries in one go(-2)", () => {
    const history = new FakeHistory();
    let pushed = sync(history, [], ["face", "card"]);
    const plan = planSync(pushed, []);
    expect(plan).toEqual({ back: 2, push: [] });
    pushed = sync(history, pushed, []);
    expect(pushed).toEqual([]);
    expect(history.index).toBe(0);
  });

  test("button exit then re-entry leaves exactly one face entry on top of the base", () => {
    const history = new FakeHistory();
    let pushed: OverlayMarker[] = [];
    for (let round = 0; round < 3; round += 1) {
      pushed = sync(history, pushed, ["face"]);
      expect(history.index).toBe(1);
      pushed = sync(history, pushed, []);
      expect(history.index).toBe(0);
    }
    pushed = sync(history, pushed, ["face"]);
    expect(applyPop(pushed, history.go(-1)).closed).toEqual(["face"]);
  });

  test("a closed overlay below the top is replaced, not left stale", () => {
    expect(planSync(["face", "card"], ["card"])).toEqual({ back: 2, push: ["card"] });
    expect(planSync(["face"], ["face", "phrases", "card"])).toEqual({ back: 0, push: ["phrases", "card"] });
  });

  test("forward onto an entry already consumed asks to step back again", () => {
    expect(applyPop(["face"], markerState("card", 2))).toEqual({ pushed: ["face"], closed: [], forward: 1 });
  });

  test("only states carrying a marker and a positive depth count as ours", () => {
    expect(stateDepth(null)).toBe(0);
    expect(stateDepth({ __NA: true })).toBe(0);
    expect(stateDepth({ cueloTranslator: "face", cueloTranslatorDepth: 0 })).toBe(0);
    expect(stateDepth({ __NA: true, ...markerState("face", 1) })).toBe(1);
  });
});

describe("preserveMarker", () => {
  const router = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] } };

  test("a same-URL router replace on our entry keeps the marker and the router's fields", () => {
    const next = preserveMarker({ ...router, ...markerState("card", 2) }, { ...router }, true);
    expect(stateDepth(next)).toBe(2);
    expect(next).toMatchObject({ __NA: true, cueloTranslator: "card" });
    expect(stateDepth(preserveMarker(markerState("face", 1), null, true))).toBe(1);
  });

  test("leaves the new state alone off our entries, across URL changes, or when it already carries a marker", () => {
    expect(preserveMarker(router, { a: 1 }, true)).toEqual({ a: 1 });
    expect(preserveMarker(markerState("face", 1), router, false)).toBe(router);
    const own = markerState("card", 2);
    expect(preserveMarker(markerState("face", 1), own, true)).toBe(own);
    expect(preserveMarker(markerState("face", 1), "text", true)).toBe("text");
  });
});
