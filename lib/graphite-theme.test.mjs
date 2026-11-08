import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The graphite look is applied twice per page load: the inline <head> script
// paints the stored state before hydration, and the client store applies every
// change after it. Both must turn the same storage into the same two <html>
// attributes, or a reload paints one look and flips to another. The table also
// pins the wallpaper rule: office mode shows the office wallpaper and nothing
// else, and a disabled look leaves no attribute even when a wallpaper is stored.

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const graphite = await jiti.import("./graphite-theme.ts");

function makeFakeDom(entries = {}) {
  const attributes = new Map();
  const storage = new Map(Object.entries(entries));
  globalThis.window = {};
  globalThis.document = {
    documentElement: {
      setAttribute: (name, value) => attributes.set(name, String(value)),
      removeAttribute: (name) => attributes.delete(name),
      getAttribute: (name) => attributes.get(name) ?? null,
    },
  };
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  return storage;
}

function observed() {
  const root = document.documentElement;
  return { look: root.getAttribute("data-cuelo-look"), wallpaper: root.getAttribute("data-cuelo-wallpaper") };
}

/** A reload: a fresh document with the same storage, painted by the inline script only. */
function firstPaintAfterReload(storage) {
  makeFakeDom(Object.fromEntries(storage));
  new Function(graphite.GRAPHITE_BOOTSTRAP)();
  return observed();
}

const rows = [
  { name: "off by default", steps: [], expect: { look: null, wallpaper: null } },
  { name: "on before the character mode is known", steps: [["enable", true]], expect: { look: "graphite", wallpaper: null } },
  { name: "on in default mode", steps: [["enable", true], ["mode", "default"]], expect: { look: "graphite", wallpaper: "default" } },
  { name: "on in office mode", steps: [["enable", true], ["mode", "office"]], expect: { look: "graphite", wallpaper: "office" } },
  { name: "mode switched office → default", steps: [["enable", true], ["mode", "office"], ["mode", "default"]], expect: { look: "graphite", wallpaper: "default" } },
  { name: "unknown mode value falls back to default", steps: [["enable", true], ["mode", "nonsense"]], expect: { look: "graphite", wallpaper: "default" } },
  { name: "turned off keeps no attribute though a wallpaper is stored", steps: [["enable", true], ["mode", "office"], ["enable", false]], expect: { look: null, wallpaper: null } },
  { name: "mode learned while off applies nothing", steps: [["mode", "office"]], expect: { look: null, wallpaper: null } },
  { name: "turned on again reuses the stored wallpaper", steps: [["mode", "office"], ["enable", true]], expect: { look: "graphite", wallpaper: "office" } },
];

for (const row of rows) {
  test(`graphite look: ${row.name}`, () => {
    const storage = makeFakeDom();
    for (const [step, value] of row.steps) {
      if (step === "enable") graphite.setGraphiteEnabled(value);
      else graphite.applyGraphiteWallpaper(value);
    }
    assert.deepEqual(observed(), row.expect, "client store");
    assert.deepEqual(firstPaintAfterReload(storage), row.expect, "inline script after reload");
  });
}

test("graphite look: the switch notifies its subscribers", () => {
  makeFakeDom();
  let calls = 0;
  const unsubscribe = graphite.subscribeGraphite(() => { calls += 1; });
  graphite.setGraphiteEnabled(true);
  assert.equal(graphite.isGraphiteEnabled(), true);
  unsubscribe();
  graphite.setGraphiteEnabled(false);
  assert.equal(calls, 1);
  assert.equal(graphite.isGraphiteEnabled(), false);
});

test("graphite look: a blocked storage write keeps the switch and the screen in step", () => {
  makeFakeDom();
  const working = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: working.getItem,
    setItem() { throw new Error("quota"); },
    removeItem() { throw new Error("quota"); },
  };
  graphite.setGraphiteEnabled(true);
  assert.deepEqual([graphite.isGraphiteEnabled(), observed().look], [true, "graphite"]);
  graphite.setGraphiteEnabled(false);
  assert.deepEqual([graphite.isGraphiteEnabled(), observed().look], [false, null]);
  // a successful write hands the state back to storage for the tests that follow
  globalThis.localStorage = working;
  graphite.setGraphiteEnabled(false);
});

test("graphite look: a mode change that cannot be saved still decides the wallpaper when turned on", () => {
  makeFakeDom();
  graphite.applyGraphiteWallpaper("office");
  const working = globalThis.localStorage;
  globalThis.localStorage = { ...working, setItem() { throw new Error("quota"); } };
  graphite.applyGraphiteWallpaper("default");
  graphite.setGraphiteEnabled(true);
  assert.deepEqual(observed(), { look: "graphite", wallpaper: "default" });
  // successful writes hand the state back to storage for the tests that follow
  globalThis.localStorage = working;
  graphite.setGraphiteEnabled(false);
  graphite.applyGraphiteWallpaper("default");
});

test("graphite look: unreadable storage paints the default look", () => {
  makeFakeDom();
  globalThis.localStorage = { getItem() { throw new Error("blocked"); } };
  new Function(graphite.GRAPHITE_BOOTSTRAP)();
  assert.deepEqual(observed(), { look: null, wallpaper: null });
});
