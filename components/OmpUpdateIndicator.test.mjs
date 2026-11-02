import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * 실제 컴포넌트를 effect까지 돌리는 최소 React 대역(hooks/useAgentSession.test.mjs와 같은 방식).
 * 상태가 바뀌면 microtask에서 다시 그리고, deps가 바뀐 effect만 cleanup 뒤 다시 실행한다.
 */
function createEffectRenderer() {
  let cells = [];
  let cursor = 0;
  let pending = [];
  let render = null;
  let scheduled = false;
  const sameDeps = (previous, next) => Array.isArray(previous) && Array.isArray(next)
    && previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
  const schedule = () => {
    if (scheduled || !render) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render?.();
    });
  };
  const cell = (create) => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = create();
    return cells[index];
  };
  const react = {
    useState(initial) {
      const state = cell(() => ({ value: typeof initial === "function" ? initial() : initial }));
      state.set ??= (next) => {
        const value = typeof next === "function" ? next(state.value) : next;
        if (Object.is(value, state.value)) return;
        state.value = value;
        schedule();
      };
      return [state.value, state.set];
    },
    useRef: (initial) => cell(() => ({ current: initial })),
    useCallback(callback, deps) {
      const memo = cell(() => ({}));
      if (!sameDeps(memo.deps, deps)) Object.assign(memo, { value: callback, deps });
      return memo.value;
    },
    useMemo(factory, deps) {
      const memo = cell(() => ({}));
      if (!sameDeps(memo.deps, deps)) Object.assign(memo, { value: factory(), deps });
      return memo.value;
    },
    useEffect(effect, deps) {
      const slot = cell(() => ({ effect: true }));
      if (deps !== undefined && sameDeps(slot.deps, deps)) return;
      slot.deps = deps;
      pending.push(() => {
        slot.cleanup?.();
        const cleanup = effect();
        slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      });
    },
  };
  return {
    react,
    mount(renderComponent) {
      render = () => {
        cursor = 0;
        pending = [];
        renderComponent();
        const effects = pending;
        pending = [];
        for (const run of effects) run();
      };
      render();
    },
    unmount() {
      render = null;
      for (const slot of cells) if (slot?.effect) slot.cleanup?.();
      cells = [];
    },
  };
}

const rendererKey = "__ompUpdateIndicatorEffectRenderer";
const HOUR = 60 * 60 * 1000;
/** 탭 복귀 신호가 겹친 것으로 보지 않을 만큼 지난 시간. */
const LATER = 60_000;

const settle = async () => {
  for (let round = 0; round < 30; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

const statusFor = (latest, current = "0.10.120") => ({
  currentAppVersion: current,
  latestRelease: {
    version: latest,
    tagName: `v${latest}`,
    name: `CUELO v${latest}`,
    body: "release notes",
    htmlUrl: `https://github.com/example/cuelo/releases/tag/v${latest}`,
    publishedAt: "2026-11-02T10:06:25Z",
  },
  updateAvailable: latest !== current,
  checkedAt: "2026-11-02T10:00:00Z",
});

async function loadIndicator(directory) {
  const sourceRoot = new URL("../", import.meta.url);
  const fakeReactPath = join(directory, "react.mjs");
  await writeFile(fakeReactPath, [
    `const react = () => globalThis.${rendererKey}.react;`,
    ...["useState", "useRef", "useCallback", "useMemo", "useEffect"]
      .map((name) => `export const ${name} = (...args) => react().${name}(...args);`),
    "export const useLayoutEffect = (...args) => react().useEffect(...args);",
  ].join("\n"));
  const i18nPath = join(directory, "useI18n.mjs");
  await writeFile(i18nPath, [
    "const value = { locale: \"en\", t: (key, params) => params ? `${key} ${JSON.stringify(params)}` : key };",
    "export function useI18n() { return value; }",
  ].join("\n"));
  const mobilePath = join(directory, "useIsMobile.mjs");
  await writeFile(mobilePath, "export function useIsMobile() { return false; }\n");
  const markdownPath = join(directory, "MarkdownBody.mjs");
  await writeFile(markdownPath, "export function MarkdownBody() { return null; }\n");

  const href = (path) => JSON.stringify(pathToFileURL(path).href);
  const source = await readFile(new URL("./OmpUpdateIndicator.tsx", import.meta.url), "utf8");
  const subjectPath = join(directory, "OmpUpdateIndicator.tsx");
  await writeFile(subjectPath, source
    .replace('from "react";', `from ${href(fakeReactPath)};`)
    .replace('from "react-dom";', `from ${JSON.stringify(import.meta.resolve("react-dom"))};`)
    .replace('from "@/hooks/useI18n";', `from ${href(i18nPath)};`)
    .replace('from "@/hooks/useIsMobile";', `from ${href(mobilePath)};`)
    .replace('from "./MarkdownBody";', `from ${href(markdownPath)};`)
    .replace(/from "@\/([^"]+)";/g, (_match, path) => `from ${JSON.stringify(new URL(path, sourceRoot).href)};`));
  const jiti = createJiti(import.meta.url, {
    jsx: { runtime: "automatic", importSource: new URL("../node_modules/react", import.meta.url).pathname },
    moduleCache: false,
    tsconfigPaths: true,
  });
  const { OmpUpdateIndicator } = await jiti.import(subjectPath);
  return OmpUpdateIndicator;
}

/**
 * 브라우저 대신 쓰는 탭·시계·네트워크. `/api/updates` 응답은 `server`가 정하고, 시계는 `advance`로만
 * 흐른다. 업데이트 적용 상태(`/api/updates/apply`)는 이 시험의 관심 밖이라 404로 답한다.
 */
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "cuelo-update-indicator-"));
  const OmpUpdateIndicator = await loadIndicator(directory);
  const globalKeys = ["window", "document", "fetch", "setTimeout", "clearTimeout", rendererKey];
  const originals = Object.fromEntries(globalKeys.map((key) => [key, globalThis[key]]));
  const originalNow = Date.now;
  const renderer = createEffectRenderer();
  let mounted = false;
  t.after(async () => {
    if (mounted) renderer.unmount();
    Date.now = originalNow;
    for (const key of globalKeys) {
      if (originals[key] === undefined) delete globalThis[key];
      else globalThis[key] = originals[key];
    }
    await rm(directory, { recursive: true, force: true });
  });

  const clock = { now: 1_800_000_000_000, nextId: 1, timers: new Map() };
  Date.now = () => clock.now;
  globalThis.setTimeout = (callback, ms = 0, ...args) => {
    const id = clock.nextId++;
    clock.timers.set(id, { at: clock.now + ms, run: () => callback(...args) });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    clock.timers.delete(id);
  };
  const advance = async (ms) => {
    const target = clock.now + ms;
    for (;;) {
      const [due] = [...clock.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at);
      if (!due) break;
      clock.timers.delete(due[0]);
      clock.now = due[1].at;
      due[1].run();
      await settle();
    }
    clock.now = target;
    await settle();
  };

  let reloads = 0;
  globalThis.window = Object.assign(new EventTarget(), {
    innerWidth: 1280,
    innerHeight: 800,
    location: { reload: () => { reloads += 1; } },
  });
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });

  const net = { server: () => Response.json(statusFor("0.10.120")), checks: [] };
  globalThis.fetch = async (url, init = {}) => {
    if (url !== "/api/updates") return new Response("{}", { status: 404 });
    net.checks.push(init.signal);
    return net.server(init);
  };

  globalThis[rendererKey] = renderer;
  let output = null;
  renderer.mount(() => {
    output = OmpUpdateIndicator();
  });
  mounted = true;
  await settle();

  return {
    net,
    clock,
    advance,
    reloads: () => reloads,
    markup: () => (output ? renderToStaticMarkup(output) : ""),
    showsUpdate(version) {
      const html = this.markup();
      return html.includes(">updates.available<") && html.includes(`>v${version}<`);
    },
    setVisibility(state) {
      document.visibilityState = state;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    fire(type) {
      window.dispatchEvent(new Event(type));
    },
    unmount() {
      mounted = false;
      renderer.unmount();
    },
  };
}

// 2026-11-02 사용자 관측: "왜업데이트는또안뜨냐". 0.10.121이 나온 뒤에도 그 전에 열어 둔 화면은
// 업데이트 버튼을 띄우지 않았다. 처음 열 때 한 번만 물었기 때문이다.
test("릴리스 전에 연 화면이 탭으로 돌아오면 새로 고침 없이 업데이트 버튼을 띄운다", async (t) => {
  const page = await setup(t);
  assert.equal(page.markup(), "", "처음에는 새 버전이 없어 아무것도 그리지 않는다");
  assert.equal(page.net.checks.length, 1);

  page.net.server = () => Response.json(statusFor("0.10.121"));
  page.clock.now += LATER;
  page.setVisibility("hidden");
  page.setVisibility("visible");
  page.fire("focus");
  await settle();

  assert.ok(page.showsUpdate("0.10.121"), `업데이트 버튼이 보여야 한다: ${page.markup()}`);
  assert.equal(page.net.checks.length, 2, "같이 오는 visibilitychange·focus는 한 번만 묻는다");
  assert.equal(page.reloads(), 0);

  page.fire("online");
  await settle();
  assert.equal(page.net.checks.length, 2, "방금 물었으면 겹쳐 온 복귀 신호로 다시 묻지 않는다");

  for (const [type, version] of [["focus", "0.10.122"], ["online", "0.10.123"]]) {
    page.net.server = () => Response.json(statusFor(version));
    page.clock.now += LATER;
    page.fire(type);
    await settle();
    assert.ok(page.showsUpdate(version), `${type} 복귀도 다시 묻는다`);
  }
});

test("다시 묻다 실패하면 이미 알고 있던 업데이트 버튼을 그대로 둔다", async (t) => {
  const page = await setup(t);
  page.net.server = () => Response.json(statusFor("0.10.121"));
  page.clock.now += LATER;
  page.fire("focus");
  await settle();
  assert.ok(page.showsUpdate("0.10.121"));

  page.net.server = () => Response.json({ error: "Update source returned HTTP 502" }, { status: 502 });
  page.clock.now += LATER;
  page.fire("focus");
  await settle();
  assert.ok(page.showsUpdate("0.10.121"), "HTTP 오류 응답 뒤에도 남아야 한다");

  page.net.server = () => { throw new TypeError("Failed to fetch"); };
  page.clock.now += LATER;
  page.fire("online");
  await settle();
  assert.ok(page.showsUpdate("0.10.121"), "네트워크 오류 뒤에도 남아야 한다");
  assert.equal(page.net.checks.length, 4);
});

test("보이는 동안에는 한 시간마다 다시 묻고, 숨겨진 화면과 닫힌 화면은 묻지 않는다", async (t) => {
  const page = await setup(t);
  page.net.server = () => Response.json(statusFor("0.10.121"));
  await page.advance(HOUR);
  assert.ok(page.showsUpdate("0.10.121"), "계속 열어 둔 화면도 한 시간 안에 알아차린다");
  assert.equal(page.net.checks.length, 2);

  page.setVisibility("hidden");
  await page.advance(3 * HOUR);
  assert.equal(page.net.checks.length, 2, "숨겨진 동안에는 묻지 않는다");

  page.setVisibility("visible");
  await settle();
  assert.equal(page.net.checks.length, 3, "다시 보이면 바로 묻는다");
  await page.advance(HOUR);
  assert.equal(page.net.checks.length, 4, "돌아온 뒤에도 한 시간 주기가 이어진다");

  page.net.server = (init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  page.clock.now += LATER;
  page.fire("focus");
  await settle();
  assert.equal(page.net.checks.length, 5);
  const inFlight = page.net.checks[4];
  assert.equal(inFlight.aborted, false);

  page.unmount();
  await settle();
  assert.equal(inFlight.aborted, true, "닫히면 진행 중인 요청을 끊는다");
  page.clock.now += LATER;
  page.setVisibility("hidden");
  page.setVisibility("visible");
  page.fire("focus");
  page.fire("online");
  await page.advance(2 * HOUR);
  assert.equal(page.net.checks.length, 5, "닫힌 뒤에는 어떤 신호로도 묻지 않는다");
  assert.equal(page.clock.timers.size, 0, "닫힌 뒤 남은 타이머가 없다");
});
