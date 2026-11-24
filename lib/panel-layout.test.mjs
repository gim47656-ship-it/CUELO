import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clampPanelWidth,
  getDefaultInspectorWidth,
  getDefaultRightPanelWidth,
  getInspectorMaxWidth,
  getLogCharsForWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  getWidthForLogChars,
  snapToLogWidth,
} = await jiti.import("./panel-layout.ts");

test("clamps panel widths to finite bounds", () => {
  assert.equal(clampPanelWidth(420.4, 180, 480), 420);
  assert.equal(clampPanelWidth(120, 180, 480), 180);
  assert.equal(clampPanelWidth(600, 180, 480), 480);
  assert.equal(clampPanelWidth(Number.NaN, 180, 480), 180);
  assert.equal(clampPanelWidth(200, 300, 250), 300);
});

test("keeps the responsive right panel default within useful limits", () => {
  assert.equal(getDefaultRightPanelWidth(700), 360);
  assert.equal(getDefaultRightPanelWidth(1366), 574);
  assert.equal(getDefaultRightPanelWidth(1920), 640);
});

test("reserves chat space while split panels are visible", () => {
  assert.equal(getSidebarMaxWidth({
    viewportWidth: 700,
    rightPanelOpen: true,
    rightPanelWidth: 560,
  }), 380);
  assert.equal(getSidebarMaxWidth({
    viewportWidth: 1366,
    rightPanelOpen: true,
    rightPanelWidth: 686,
  }), 260);
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 1024,
    sidebarOpen: true,
    sidebarWidth: 260,
  }), 344);
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 1366,
    sidebarOpen: true,
    sidebarWidth: 260,
  }), 686);
});

test("does not rewrite desktop widths while the file panel is in overlay mode", () => {
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 900,
    sidebarOpen: true,
    sidebarWidth: 480,
  }), 1200);
});

test("the inspector widens by default only on an 1800px shell", () => {
  assert.equal(getDefaultInspectorWidth(1280), 372);
  assert.equal(getDefaultInspectorWidth(1799), 372);
  assert.equal(getDefaultInspectorWidth(1800), 440);
});

test("the inspector keeps the transcript at 560 beside the rail and the open navigator", () => {
  // 1920 - rail 60 - navigator 260 - transcript 560 - the navigator clamp's 1px
  assert.equal(getInspectorMaxWidth({ shellContentWidth: 1920, navigatorWidth: 260, zoneGap: 0 }), 1039);
  // a closed navigator gives its width to the inspector
  assert.equal(getInspectorMaxWidth({ shellContentWidth: 1920, navigatorWidth: null, zoneGap: 0 }), 1299);
  // the navigator counts at its laid-out size (240-300), and every zone seam takes the look's gap:
  // 1904 - 60 - 300 - 560 - 3 x 8 - 1
  assert.equal(getInspectorMaxWidth({ shellContentWidth: 1904, navigatorWidth: 480, zoneGap: 8 }), 959);
  // below 1440 the automatic width stays; the shell CSS narrows the navigator as before
  assert.equal(getInspectorMaxWidth({ shellContentWidth: 1232, navigatorWidth: 260, zoneGap: 0 }), 372);
});

test("log characters and inspector widths convert both ways and snap at 80, 100 and 120", () => {
  const metrics = { charWidth: 7.2, chrome: 50 };
  assert.equal(getWidthForLogChars(120, metrics), 914);
  assert.equal(getLogCharsForWidth(914, metrics), 120);
  assert.equal(getLogCharsForWidth(913, metrics), 119);
  assert.equal(getWidthForLogChars(80, metrics), 626);
  assert.equal(snapToLogWidth(618, metrics), 626);
  assert.equal(snapToLogWidth(615, metrics), 615);
  assert.equal(snapToLogWidth(774, metrics), 770);
  assert.equal(snapToLogWidth(904, metrics), 914);
  assert.equal(snapToLogWidth(700, null), 700);
});
