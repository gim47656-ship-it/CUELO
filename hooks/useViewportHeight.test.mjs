import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isSoftKeyboardOpen, shouldUseVisualViewportHeight } = await jiti.import("./useViewportHeight.ts");

test("uses the visual viewport for a focused editor when the keyboard shrinks it", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    innerHeight: 844,
    viewportHeight: 510,
    viewportScale: 1,
  }), true);
});

test("does not keep the keyboard height after the visual viewport restores", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    innerHeight: 844,
    viewportHeight: 844,
    viewportScale: 1,
  }), false);
});

test("restores the dynamic height as soon as the editor loses focus", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: false,
    innerHeight: 844,
    viewportHeight: 510,
    viewportScale: 1,
  }), false);
});

test("does not mistake pinch zoom for an open keyboard", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    innerHeight: 844,
    viewportHeight: 422,
    viewportScale: 2,
  }), false);
});

test("keeps the dynamic viewport height when the visual viewport is not reduced", () => {
  assert.equal(shouldUseVisualViewportHeight({
    hasFocusedEditable: true,
    innerHeight: 844,
    viewportHeight: 844,
    viewportScale: 1,
  }), false);
});

const keyboard = (overrides) => isSoftKeyboardOpen({
  hasFocusedEditable: true, innerHeight: 844, viewportHeight: 844, viewportScale: 1, baselineHeight: 844, ...overrides,
});

test("an iOS keyboard shrinks the visual viewport under a focused editor", () => {
  assert.equal(keyboard({ viewportHeight: 470 }), true);
});

test("an Android keyboard resizes the layout viewport below its keyboard-free height", () => {
  assert.equal(keyboard({ innerHeight: 470, viewportHeight: 470 }), true);
});

test("a collapsing browser toolbar is not a keyboard", () => {
  assert.equal(keyboard({ viewportHeight: 790 }), false);
  assert.equal(keyboard({ innerHeight: 790, viewportHeight: 790 }), false);
});

test("no focused editor or a pinch zoom never counts as an open keyboard", () => {
  assert.equal(keyboard({ hasFocusedEditable: false, innerHeight: 470, viewportHeight: 470 }), false);
  assert.equal(keyboard({ viewportHeight: 422, viewportScale: 2 }), false);
});
