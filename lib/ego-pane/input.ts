/**
 * Pane input → ego pane channel events. Only these shapes are ever forwarded; anything else rejects
 * the batch. Values are passed through and never logged (they can be passwords).
 */
export type PaneModifier = "shift" | "control" | "alt" | "meta";

export type PaneChannelEvent =
  | { type: "mouseDown" | "mouseUp"; x: number; y: number; button: "left" | "middle" | "right"; clickCount: number; modifiers: PaneModifier[] }
  | { type: "mouseMove"; x: number; y: number; modifiers: PaneModifier[] }
  | { type: "mouseWheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: PaneModifier[] }
  | { type: "keyDown" | "keyUp"; keyCode: string; modifiers: PaneModifier[] }
  | { type: "char"; keyCode: string }
  | { type: "text"; text: string };

export const MAX_INPUT_EVENTS = 64;
const MAX_COORDINATE = 16_384;
const MAX_WHEEL_DELTA = 10_000;
const MAX_TEXT_LENGTH = 2_000;
const MOUSE_BUTTONS: Record<string, "left" | "middle" | "right"> = { left: "left", middle: "middle", right: "right" };
/** DOM `key` values whose Electron accelerator name differs; other named keys pass by NAMED_KEY. */
const KEY_NAMES: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  " ": "Space",
  "+": "Plus",
};
const NAMED_KEY = /^(Enter|Backspace|Tab|Escape|Delete|Insert|Home|End|PageUp|PageDown|F([1-9]|1[0-2]))$/;

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/**
 * The client's modifier bits (Alt 1, Ctrl 2, Meta 4, Shift 8) as the channel's names. A value that
 * is not such a bit set is null, so a malformed shortcut is rejected instead of typed as plain text.
 */
function modifierNames(value: unknown): PaneModifier[] | null {
  if (value === undefined) return [];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 15) return null;
  const names: PaneModifier[] = [];
  if (value & 8) names.push("shift");
  if (value & 2) names.push("control");
  if (value & 1) names.push("alt");
  if (value & 4) names.push("meta");
  return names;
}

/** A DOM `key` as an Electron accelerator key name, or null for keys the pane does not forward. */
function keyName(key: unknown): string | null {
  if (typeof key !== "string") return null;
  if (Object.hasOwn(KEY_NAMES, key)) return KEY_NAMES[key];
  if (NAMED_KEY.test(key)) return key;
  // One printable ASCII character names itself; letters are named in lower case.
  return /^[\x21-\x7e]$/.test(key) ? key.toLowerCase() : null;
}

/** One client input event as channel events, or null when it is not on the whitelist. */
export function toPaneEvents(event: unknown): PaneChannelEvent[] | null {
  if (typeof event !== "object" || event === null) return null;
  const kind = Reflect.get(event, "t");
  const type = Reflect.get(event, "type");
  const modifiers = modifierNames(Reflect.get(event, "modifiers"));
  if (!modifiers) return null;
  if (kind === "mouse" || kind === "wheel") {
    const x = finite(Reflect.get(event, "x"), 0, MAX_COORDINATE);
    const y = finite(Reflect.get(event, "y"), 0, MAX_COORDINATE);
    if (x === null || y === null) return null;
    if (kind === "wheel") {
      // DOM convention on both sides: positive deltaY scrolls down.
      const deltaX = finite(Reflect.get(event, "dx"), -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA);
      const deltaY = finite(Reflect.get(event, "dy"), -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA);
      return deltaX === null || deltaY === null ? null : [{ type: "mouseWheel", x, y, deltaX, deltaY, modifiers }];
    }
    // ego tracks which buttons are held, so a move carries only its position.
    if (type === "move") return [{ type: "mouseMove", x, y, modifiers }];
    if (type !== "down" && type !== "up") return null;
    const pressed = Reflect.get(event, "button");
    const button = typeof pressed === "string" && Object.hasOwn(MOUSE_BUTTONS, pressed) ? MOUSE_BUTTONS[pressed] : null;
    const clickCount = finite(Reflect.get(event, "clickCount"), 1, 3);
    if (!button || clickCount === null) return null;
    return [{ type: type === "down" ? "mouseDown" : "mouseUp", x, y, button, clickCount, modifiers }];
  }
  if (kind === "key") {
    if (type !== "down" && type !== "up") return null;
    const key = Reflect.get(event, "key");
    if (typeof key !== "string" || key.length === 0 || key.length > 32) return null;
    // A key the channel has no name for (a dead key, a media key) sends no key event, not an error.
    const keyCode = keyName(key);
    if (type === "up") return keyCode ? [{ type: "keyUp", keyCode, modifiers }] : [];
    const sent: PaneChannelEvent[] = keyCode ? [{ type: "keyDown", keyCode, modifiers }] : [];
    // A printable key also types its character unless Ctrl or Meta makes it a shortcut. A character
    // outside the BMP does not fit `char`, so it goes as text.
    if ([...key].length === 1 && !modifiers.includes("control") && !modifiers.includes("meta")) {
      sent.push(key.length === 1 ? { type: "char", keyCode: key } : { type: "text", text: key });
    }
    return sent;
  }
  if (kind === "text") {
    const text = Reflect.get(event, "text");
    return typeof text === "string" && text.length > 0 && text.length <= MAX_TEXT_LENGTH ? [{ type: "text", text }] : null;
  }
  return null;
}

/** Every event of a batch as channel events, or null when the batch is malformed (nothing is forwarded then). */
export function toPaneEventBatch(events: unknown): PaneChannelEvent[] | null {
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_INPUT_EVENTS) return null;
  const mapped: PaneChannelEvent[] = [];
  for (const event of events) {
    const next = toPaneEvents(event);
    if (!next) return null;
    mapped.push(...next);
  }
  return mapped;
}
