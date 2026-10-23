import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { cropRect, displayToNatural, labelFontSize, outlineRects, outlineWidths, regionFromDrag, regionPercent } = await jiti.import("./image-regions.ts");

// A 1920×1080 screenshot shown at half size, 40px from the left and 100px from the top of the viewport.
const natural = { width: 1920, height: 1080 };
const display = { left: 40, top: 100, width: 960, height: 540 };

test("a screen point maps to natural pixels through the display scale", () => {
  assert.deepEqual(displayToNatural({ x: 40 + 480, y: 100 + 270 }, display, natural), { x: 960, y: 540 });
  assert.deepEqual(displayToNatural({ x: 0, y: 900 }, display, natural), { x: 0, y: 1080 });
});

test("a drag becomes a natural-pixel region whichever way it is drawn", () => {
  const forward = regionFromDrag({ x: 140, y: 150 }, { x: 240, y: 200 }, display, natural);
  const backward = regionFromDrag({ x: 240, y: 200 }, { x: 140, y: 150 }, display, natural);
  assert.deepEqual(forward, { x: 200, y: 100, w: 200, h: 100 });
  assert.deepEqual(backward, forward);
});

test("a drag that leaves the image is clipped to the image", () => {
  assert.deepEqual(
    regionFromDrag({ x: 900, y: 500 }, { x: 1300, y: 900 }, display, natural),
    { x: 1720, y: 800, w: 200, h: 280 },
  );
});

test("a drag shorter than 6 CSS px in either direction is not a region", () => {
  assert.equal(regionFromDrag({ x: 100, y: 120 }, { x: 105, y: 300 }, display, natural), null);
  assert.equal(regionFromDrag({ x: 100, y: 120 }, { x: 300, y: 125 }, display, natural), null);
  assert.notEqual(regionFromDrag({ x: 100, y: 120 }, { x: 106, y: 126 }, display, natural), null);
  // Outside the image entirely: clipped to zero width.
  assert.equal(regionFromDrag({ x: 0, y: 0 }, { x: 30, y: 90 }, display, natural), null);
});

test("outline width follows the long side, with a floor and a ceiling", () => {
  assert.deepEqual(outlineWidths({ width: 1920, height: 1080 }), { inner: 8, outer: 16 });
  assert.deepEqual(outlineWidths({ width: 320, height: 200 }), { inner: 2, outer: 4 });
  assert.deepEqual(outlineWidths({ width: 8000, height: 6000 }), { inner: 12, outer: 24 });
  assert.equal(labelFontSize({ width: 320, height: 200 }), 14);
  assert.equal(labelFontSize({ width: 1920, height: 1080 }), 56);
});

test("a crop adds 12% of the box on each side and stays inside the image", () => {
  assert.deepEqual(cropRect({ x: 500, y: 400, w: 200, h: 100 }, natural), { x: 476, y: 388, w: 248, h: 124 });
  assert.deepEqual(cropRect({ x: 0, y: 1000, w: 100, h: 80 }, natural), { x: 0, y: 990, w: 112, h: 90 });
});

test("overlay percentages place the box over the same pixels at any display size", () => {
  assert.deepEqual(regionPercent({ x: 480, y: 270, w: 960, h: 540 }, natural), { left: 25, top: 25, width: 50, height: 50 });
});

test("outlines sit just outside a box and are pulled inside the image at its edges", () => {
  // 1920×1080 → inner 8, outer 16.
  assert.deepEqual(outlineRects({ x: 500, y: 400, w: 200, h: 100 }, natural), {
    inner: { x: 496, y: 396, w: 208, h: 108 },
    outer: { x: 484, y: 384, w: 232, h: 132 },
  });
  // A box covering the whole image keeps every stroke on the canvas (stroke centre at half its width from the edge).
  assert.deepEqual(outlineRects({ x: 0, y: 0, w: 1920, h: 1080 }, natural), {
    inner: { x: 4, y: 4, w: 1912, h: 1072 },
    outer: { x: 8, y: 8, w: 1904, h: 1064 },
  });
});
