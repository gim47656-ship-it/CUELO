/**
 * Host side of the Plugin Lab panel bridge. A plugin panel runs in an iframe with
 * `sandbox="allow-scripts"` only, so its origin is opaque ("null") and the only way
 * in or out is `postMessage`. This module holds every rule that decides what the
 * host accepts, so the React panel stays a thin wire and the rules stay testable.
 *
 * Panel → host: `{ type: "cuelo-lab:ready" }`, `{ type: "cuelo-lab:draft", text }`.
 * Host → panel: `{ type: "cuelo-lab:state", sessionId, lines }`.
 * Agent → panel: the plugin's extension calls `ctx.ui.setWidget("lab:<id>", lines)`
 * (or `lab:<id>:<part>`); the chat view routes those widgets here instead of
 * drawing them as text cards.
 */

export const LAB_DRAFT_MAX_CHARS = 4000;
export const LAB_WIDGET_PREFIX = "lab:";

/** The iframe attribute value. Nothing else is granted: no same-origin, forms, popups or navigation. */
export const LAB_PANEL_SANDBOX = "allow-scripts";

export type LabPanelMessage =
  | { type: "cuelo-lab:ready" }
  | { type: "cuelo-lab:draft"; text: string };

export interface LabStateMessage {
  type: "cuelo-lab:state";
  sessionId: string | null;
  lines: string[];
}

export function isLabWidgetKey(key: string): boolean {
  return key.startsWith(LAB_WIDGET_PREFIX) && labWidgetPluginId(key) !== null;
}

/** `lab:demo` and `lab:demo:status` both belong to plugin `demo`. */
export function labWidgetPluginId(key: string): string | null {
  if (!key.startsWith(LAB_WIDGET_PREFIX)) return null;
  const rest = key.slice(LAB_WIDGET_PREFIX.length);
  const id = rest.split(":", 1)[0];
  return id ? id : null;
}

/** Splits widgets into the ones drawn as text cards and the ones owned by lab panels, keeping order. */
export function splitLabWidgets<T extends { key: string }>(widgets: readonly T[]): { regular: T[]; lab: T[] } {
  const regular: T[] = [];
  const lab: T[] = [];
  for (const widget of widgets) (isLabWidgetKey(widget.key) ? lab : regular).push(widget);
  return { regular, lab };
}

/** The lines one plugin's panel shows: every `lab:<id>` widget of the session, in arrival order. */
export function labLinesFor(widgets: readonly { key: string; lines: readonly string[] }[], pluginId: string): string[] {
  return widgets.filter((widget) => labWidgetPluginId(widget.key) === pluginId).flatMap((widget) => [...widget.lines]);
}

/** Caps a draft at LAB_DRAFT_MAX_CHARS without leaving half a surrogate pair at the cut. */
export function capLabDraft(text: string): string {
  if (text.length <= LAB_DRAFT_MAX_CHARS) return text;
  const cut = text.slice(0, LAB_DRAFT_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The two message shapes a panel may send; anything else is dropped. */
type RawPanelMessage = { type?: unknown; text?: unknown };

/**
 * Accepts a message only when it comes from this panel's own frame window, from an
 * opaque (sandboxed) origin, and has exactly one of the two known shapes.
 */
export function parseLabPanelMessage(
  event: { source: unknown; origin: string; data: unknown },
  frameWindow: unknown,
): LabPanelMessage | null {
  if (!frameWindow || event.source !== frameWindow) return null;
  if (event.origin !== "null") return null;
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return null;
  const data = event.data as RawPanelMessage;
  const keys = Object.keys(data).sort().join(",");
  if (data.type === "cuelo-lab:ready") return keys === "type" ? { type: "cuelo-lab:ready" } : null;
  if (data.type !== "cuelo-lab:draft" || keys !== "text,type" || typeof data.text !== "string") return null;
  const text = capLabDraft(data.text);
  return text.trim() ? { type: "cuelo-lab:draft", text } : null;
}

export interface LabPanelFrame {
  postMessage: (message: LabStateMessage, targetOrigin: string) => void;
}

export interface LabPanelHostOptions {
  /** The iframe's contentWindow, or null before it loads. */
  frame: () => LabPanelFrame | null;
  /** Current session and that session's lines for this plugin. */
  state: () => { sessionId: string | null; lines: string[] };
  /** Puts text into the chat input as an unsent draft. False when no message box is open. */
  insertDraft: (text: string) => boolean;
  /** Records the draft event for usage counts. Failures are the caller's to swallow. */
  recordDraft: () => void;
}

export interface LabPanelHost {
  handleMessage: (event: { source: unknown; origin: string; data: unknown }) => void;
  publishState: () => void;
}

export function createLabPanelHost(options: LabPanelHostOptions): LabPanelHost {
  const publishState = () => {
    const frame = options.frame();
    if (!frame) return;
    const { sessionId, lines } = options.state();
    // An opaque origin cannot be named, so "*" is the only target that reaches it.
    // The message goes to this one frame's window, never broadcast.
    frame.postMessage({ type: "cuelo-lab:state", sessionId, lines: [...lines] }, "*");
  };
  return {
    publishState,
    handleMessage(event) {
      const message = parseLabPanelMessage(event, options.frame());
      if (!message) return;
      if (message.type === "cuelo-lab:ready") {
        publishState();
        return;
      }
      if (options.insertDraft(message.text)) options.recordDraft();
    },
  };
}
