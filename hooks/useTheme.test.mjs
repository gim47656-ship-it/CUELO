import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mock } from "bun:test";

// The theme store is module-global and the store is exercised through the same
// fake DOM + stubbed React in a fresh process. `data-seed-color-mode` is the
// single signal that decides every surface colour; `.dark` and
// `data-omp-theme-mode` must follow the same resolved mode, and the stored
// preference must be the mode that was requested.
//
// Regression table (SettingsConfig theme preview buttons): each card names a
// mode ("Preview dark" / "Preview light") and a press must apply that mode,
// no matter which step of the light→dark→auto cycle the app sits on. Before
// the fix the handler cycled the preference instead, so rows 2 and 4 inverted
// the request.
//   row | preference | system | resolved | visible button | press   | expect
//   ----+------------+--------+----------+----------------+---------+--------
//   1   | light      | light  | light    | Preview dark   | dark    | dark
//   2   | dark       | dark   | dark     | Preview light  | light   | light
//   3   | dark       | light  | dark     | Preview light  | light   | light
//   4   | auto       | light  | light    | Preview dark   | dark    | dark
//   5   | auto       | dark   | dark     | Preview light  | light   | light

function makeFakeDom({ systemDark = false } = {}) {
  const styleProps = new Map();
  const storage = new Map();
  const root = {
    dataset: {},
    attributes: new Map(),
    classSet: new Set(),
    style: {
      get length() { return styleProps.size; },
      item: (i) => [...styleProps.keys()][i] ?? null,
      getPropertyValue: (n) => styleProps.get(n),
      removeProperty: (n) => styleProps.delete(n),
      setProperty: (n, v) => styleProps.set(n, String(v)),
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name.startsWith("data-")) this.dataset[name.slice(5)] = String(value);
    },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    classList: {
      toggle: (name, force) => {
        const next = force === undefined ? !root.classSet.has(name) : force;
        if (next) root.classSet.add(name); else root.classSet.delete(name);
        return next;
      },
      contains: (name) => root.classSet.has(name),
    },
    addEventListener() {},
  };
  globalThis.document = {
    documentElement: root,
    addEventListener() {},
    visibilityState: "visible",
    startViewTransition: undefined,
  };
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };
  setWindow({ systemDark });
  return root;
}

/** Swapping the window swaps the system scheme; the store reads it on resolve. */
function setWindow({ systemDark }) {
  globalThis.window = {
    matchMedia: (query) => ({
      // Reduced motion keeps the apply synchronous; the wipe animation is irrelevant here.
      matches: query.includes("prefers-color-scheme: dark")
        ? systemDark
        : query.includes("prefers-reduced-motion: reduce"),
      addEventListener() {},
    }),
    addEventListener() {},
    innerWidth: 1200,
    innerHeight: 800,
  };
}

mock.module("react", () => ({
  useCallback: (fn) => fn,
  useEffect: () => {},
  useSyncExternalStore: (subscribe, getSnapshot) => {
    subscribe(() => {});
    return getSnapshot();
  },
}));

const { useTheme } = await import("./useTheme.ts");

/** What a consumer can observe: the applied DOM mode and the stored preference. */
function observe() {
  const api = useTheme();
  const root = document.documentElement;
  return {
    preference: api.preference,
    seedMode: root.getAttribute("data-seed-color-mode"),
    ompThemeMode: root.dataset.ompThemeMode,
    darkClass: root.classList.contains("dark"),
    stored: localStorage.getItem("pi-theme"),
  };
}

const rows = [
  { preference: "light", systemDark: false, request: "dark", expect: "dark" },
  { preference: "dark", systemDark: true, request: "light", expect: "light" },
  { preference: "dark", systemDark: false, request: "light", expect: "light" },
  { preference: "auto", systemDark: false, request: "dark", expect: "dark" },
  { preference: "auto", systemDark: true, request: "light", expect: "light" },
];

for (const [index, row] of rows.entries()) {
  test(`named-mode press applies that mode (row ${index + 1}: ${row.preference}/${row.systemDark ? "dark" : "light"} system → request ${row.request})`, () => {
    makeFakeDom({ systemDark: row.systemDark });
    if (index === 0) useTheme(); // first call initializes the store from storage

    // Drive the store onto this row's preference (and system scheme).
    useTheme().setPreference(row.preference);
    const before = observe();
    // The card that names the other mode is the one showing its button.
    assert.notEqual(before.ompThemeMode, row.request);
    assert.equal(before.preference, row.preference);

    // The press: the button that names `row.request` is pressed.
    useTheme().setPreference(row.request);
    const after = observe();
    assert.equal(after.ompThemeMode, row.expect, "applied mode matches the named mode");
    assert.equal(after.seedMode, row.expect === "dark" ? "dark-only" : "light-only");
    assert.equal(after.darkClass, row.expect === "dark");
    assert.equal(after.stored, row.request, "persisted preference is the requested mode");
  });
}

test("the menu-item cycle still walks light → dark → auto and applies each step", () => {
  makeFakeDom({ systemDark: false });
  useTheme().setPreference("auto");
  let observed = observe();
  assert.deepEqual(
    { preference: observed.preference, ompThemeMode: observed.ompThemeMode, seedMode: observed.seedMode, darkClass: observed.darkClass },
    { preference: "auto", ompThemeMode: "light", seedMode: "light-only", darkClass: false },
  );

  useTheme().toggleTheme(); // auto → light
  observed = observe();
  assert.deepEqual(
    { preference: observed.preference, ompThemeMode: observed.ompThemeMode, seedMode: observed.seedMode, darkClass: observed.darkClass },
    { preference: "light", ompThemeMode: "light", seedMode: "light-only", darkClass: false },
  );

  useTheme().toggleTheme(); // light → dark
  observed = observe();
  assert.deepEqual(
    { preference: observed.preference, ompThemeMode: observed.ompThemeMode, seedMode: observed.seedMode, darkClass: observed.darkClass },
    { preference: "dark", ompThemeMode: "dark", seedMode: "dark-only", darkClass: true },
  );

  useTheme().toggleTheme(); // dark → auto
  observed = observe();
  assert.deepEqual(
    { preference: observed.preference, ompThemeMode: observed.ompThemeMode, seedMode: observed.seedMode, darkClass: observed.darkClass },
    { preference: "auto", ompThemeMode: "light", seedMode: "light-only", darkClass: false },
  );
});

// ---------------------------------------------------------------------------
// First paint: the inline bootstrap in app/layout.tsx
//
// The script printed into <head> decides the mode of the first paint, and the
// hook decides every paint after it. Both must resolve the same stored state to
// the same mode, or the page paints one theme and flips to the other at
// hydration. The script shipped before this test read the resolved-mode cache
// (`omp-theme`) instead of the preference (`pi-theme`), so it painted light and
// then flipped in three cases: 1) a first visit with nothing stored, 2) an
// `auto` preference whose system scheme changed after the cache was written,
// 3) a preference changed while the cache still held the previous mode.
//
// The script is extracted from the layout and executed verbatim, so this test
// cannot drift from the string that ships.
//   case | pi-theme | omp-theme | system | first paint | after hydration
//   -----+----------+-----------+--------+-------------+----------------
//   1    | -        | -         | dark   | dark        | dark
//   2    | auto     | light     | dark   | dark        | dark
//   3    | dark     | light     | light  | dark        | dark
//   4    | auto     | dark      | light  | light       | light
//   5    | light    | dark      | dark   | light       | light
//   6    | -        | dark      | light  | dark        | dark
//   7    | nord     | -         | dark   | dark        | dark

const layoutSource = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const bootstrap = /dangerouslySetInnerHTML=\{\{\s*__html:\s*`([\s\S]*?)`/.exec(layoutSource)?.[1];
if (!bootstrap) throw new Error("no inline bootstrap script found in app/layout.tsx");

/** The three signals the first paint reads, in the order they are applied. */
function readFirstPaint() {
  const root = document.documentElement;
  return {
    seedMode: root.getAttribute("data-seed-color-mode"),
    ompThemeMode: root.dataset.ompThemeMode,
    darkClass: root.classList.contains("dark"),
  };
}

function runBootstrap() {
  new Function(bootstrap)();
  return readFirstPaint();
}

/** A fresh module instance re-reads storage, the way a page load does. */
let moduleLoads = 0;
async function loadHook() {
  moduleLoads += 1;
  const { useTheme: freshUseTheme } = await import(`./useTheme.ts?load=${moduleLoads}`);
  const api = freshUseTheme();
  return { preference: api.preference, theme: api.theme, ...readFirstPaint() };
}

const firstPaintRows = [
  { name: "first visit with a dark system scheme", pi: null, omp: null, systemDark: true, expect: "dark" },
  { name: "auto preference, system scheme changed after the cache was written", pi: "auto", omp: "light", systemDark: true, expect: "dark" },
  { name: "preference changed while the cache held the previous mode", pi: "dark", omp: "light", systemDark: false, expect: "dark" },
  { name: "auto preference, light system scheme", pi: "auto", omp: "dark", systemDark: false, expect: "light" },
  { name: "named preference overrides a dark cache", pi: "light", omp: "dark", systemDark: true, expect: "light" },
  { name: "install that predates pi-theme", pi: null, omp: "dark", systemDark: false, expect: "dark" },
  { name: "unrecognised preference falls back to the system scheme", pi: "nord", omp: null, systemDark: true, expect: "dark" },
];

for (const [index, row] of firstPaintRows.entries()) {
  test(`the first paint already matches the hook (row ${index + 1}: ${row.name})`, async () => {
    makeFakeDom({ systemDark: row.systemDark });
    if (row.pi !== null) localStorage.setItem("pi-theme", row.pi);
    if (row.omp !== null) localStorage.setItem("omp-theme", row.omp);

    const expected = {
      seedMode: row.expect === "dark" ? "dark-only" : "light-only",
      ompThemeMode: row.expect,
      darkClass: row.expect === "dark",
    };
    assert.deepEqual(runBootstrap(), expected, "the head script paints the resolved mode");

    const hydrated = await loadHook();
    assert.deepEqual(
      { seedMode: hydrated.seedMode, ompThemeMode: hydrated.ompThemeMode, darkClass: hydrated.darkClass },
      expected,
      "hydration resolves the same stored state to the same mode",
    );
    assert.equal(hydrated.theme, row.expect);
    if (row.pi === "light" || row.pi === "dark" || row.pi === "auto") {
      assert.equal(hydrated.preference, row.pi, "the stored preference is the hook's source");
    }
  });
}

test("the head script drops an older build's surface palette and keeps the markdown accents", () => {
  const root = makeFakeDom({ systemDark: false });
  localStorage.setItem("pi-theme", "dark");
  localStorage.setItem("omp-theme-config", JSON.stringify({
    palettes: {
      dark: { name: "anthracite", variables: { "--omp-md-heading": "#ededed", "--bg": "#1f1f1f" } },
    },
  }));
  root.style.setProperty("--bg", "#000000");
  root.style.setProperty("color", "red");

  assert.deepEqual(runBootstrap(), { seedMode: "dark-only", ompThemeMode: "dark", darkClass: true });
  assert.equal(root.style.getPropertyValue("--omp-md-heading"), "#ededed", "markdown accents survive");
  assert.equal(root.style.getPropertyValue("--bg"), undefined, "inherited surface variables are dropped");
  assert.equal(root.style.getPropertyValue("color"), "red", "non-custom properties are untouched");
  assert.equal(root.dataset.ompThemeName, "anthracite");
});

test("an unreadable palette cache still leaves the first paint on the resolved mode", () => {
  const root = makeFakeDom({ systemDark: true });
  localStorage.setItem("pi-theme", "auto");
  localStorage.setItem("omp-theme-config", "{truncated");

  assert.deepEqual(runBootstrap(), { seedMode: "dark-only", ompThemeMode: "dark", darkClass: true });
  assert.equal(root.dataset.ompThemeName, undefined);
});
