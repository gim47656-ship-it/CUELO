export const MOBILE_MAX_WIDTH = 640;
export const SPLIT_PANEL_MIN_WIDTH = 960;

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

export const RIGHT_PANEL_FALLBACK_WIDTH = 560;
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_MAX_WIDTH = 1200;

const COMPACT_CHAT_MIN_WIDTH = 320;
const DESKTOP_CHAT_MIN_WIDTH = 420;

export function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  const finiteWidth = Number.isFinite(width) ? width : minWidth;
  const effectiveMax = Math.max(minWidth, maxWidth);
  return Math.round(Math.max(minWidth, Math.min(effectiveMax, finiteWidth)));
}

export function getDefaultRightPanelWidth(viewportWidth: number): number {
  return clampPanelWidth(viewportWidth * 0.42, 360, 640);
}

export function getSidebarMaxWidth(options: {
  viewportWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
}): number {
  const { viewportWidth, rightPanelOpen, rightPanelWidth } = options;
  if (viewportWidth <= MOBILE_MAX_WIDTH) return SIDEBAR_MAX_WIDTH;

  const compact = viewportWidth < SPLIT_PANEL_MIN_WIDTH;
  const chatWidth = compact ? COMPACT_CHAT_MIN_WIDTH : DESKTOP_CHAT_MIN_WIDTH;
  const visibleRightPanelWidth = !compact && rightPanelOpen ? rightPanelWidth : 0;
  return Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - chatWidth - visibleRightPanelWidth);
}

export function getRightPanelMaxWidth(options: {
  viewportWidth: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
}): number {
  const { viewportWidth, sidebarOpen, sidebarWidth } = options;
  if (viewportWidth < SPLIT_PANEL_MIN_WIDTH) return RIGHT_PANEL_MAX_WIDTH;

  const visibleSidebarWidth = sidebarOpen ? sidebarWidth : 0;
  return Math.min(
    RIGHT_PANEL_MAX_WIDTH,
    viewportWidth - DESKTOP_CHAT_MIN_WIDTH - visibleSidebarWidth,
  );
}

/** The pinned inspector (auxiliary deck). Its automatic width follows the shell; a drag replaces it. */
export const INSPECTOR_MIN_WIDTH = 320;
export const INSPECTOR_DEFAULT_WIDTH = 372;
export const INSPECTOR_WIDE_DEFAULT_WIDTH = 440;
export const INSPECTOR_MAX_WIDTH = 1200;
/** Shell widths where the wide layout starts (reading measure 960) and where it widens again (1120, inspector 440). */
export const WIDE_SHELL_MIN_WIDTH = 1440;
export const WIDER_SHELL_MIN_WIDTH = 1800;
const TRANSCRIPT_MIN_WIDTH = 560;
const RAIL_WIDTH = 60;
const NAVIGATOR_MIN_WIDTH = 240;
const NAVIGATOR_MAX_WIDTH = 300;

export function getDefaultInspectorWidth(shellWidth: number): number {
  return shellWidth >= WIDER_SHELL_MIN_WIDTH ? INSPECTOR_WIDE_DEFAULT_WIDTH : INSPECTOR_DEFAULT_WIDTH;
}

/**
 * The widest pinned inspector that keeps the transcript at its 560px floor beside the rail and the
 * open navigator. Zones meet on `zoneGap` (the graphite look's gap; 0 otherwise). The extra pixel
 * matches the navigator clamp in the shell CSS, so the widest inspector never narrows the navigator.
 * It never falls below the automatic default, so a window under 1440px keeps today's inspector: there
 * the shell CSS narrows the navigator instead, as it always has.
 */
export function getInspectorMaxWidth(options: {
  shellContentWidth: number;
  navigatorWidth: number | null;
  zoneGap: number;
}): number {
  const { shellContentWidth, navigatorWidth, zoneGap } = options;
  const navigator = navigatorWidth === null
    ? 0
    : Math.min(NAVIGATOR_MAX_WIDTH, Math.max(NAVIGATOR_MIN_WIDTH, navigatorWidth));
  const zones = navigatorWidth === null ? 3 : 4;
  const room = shellContentWidth - RAIL_WIDTH - navigator - TRANSCRIPT_MIN_WIDTH - zoneGap * (zones - 1) - 1;
  return Math.max(getDefaultInspectorWidth(shellContentWidth), Math.floor(room));
}

/** How the process log lays out one output line: the monospace advance and the horizontal space around the text. */
export interface LogLineMetrics {
  charWidth: number;
  chrome: number;
}

export const LOG_SNAP_CHARS = [80, 100, 120] as const;
/** The 로그 layout opens the process log at this many characters per output line. */
export const LOG_PRESET_CHARS = 120;
export const LOG_SNAP_DISTANCE = 10;

export function getLogCharsForWidth(width: number, metrics: LogLineMetrics): number {
  if (!(metrics.charWidth > 0)) return 0;
  return Math.max(0, Math.floor((width - metrics.chrome) / metrics.charWidth + 1e-6));
}

export function getWidthForLogChars(chars: number, metrics: LogLineMetrics): number {
  return Math.ceil(chars * metrics.charWidth + metrics.chrome - 1e-6);
}

/** Pulls a dragged width onto the 80, 100 or 120 character width when it is within LOG_SNAP_DISTANCE. */
export function snapToLogWidth(width: number, metrics: LogLineMetrics | null): number {
  if (!metrics) return width;
  for (const chars of LOG_SNAP_CHARS) {
    const target = getWidthForLogChars(chars, metrics);
    if (Math.abs(width - target) <= LOG_SNAP_DISTANCE) return target;
  }
  return width;
}

const LOG_PROBE_CHARS = 100;
const LOG_PROBE_WIDTH = 1000;

function contentInlineSize(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return element.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
}

/**
 * Browser only. Measures the process log's output line inside `deck` (the pinned inspector slot):
 * the monospace advance from an off-screen probe that carries the log output's own classes, and
 * the space around the text from a real output line when one is on screen, else from the probe.
 */
export function measureLogLineMetrics(deck: HTMLElement | null): LogLineMetrics | null {
  if (typeof document === "undefined") return null;
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-${LOG_PROBE_WIDTH * 3}px;top:0;inline-size:${LOG_PROBE_WIDTH}px;visibility:hidden;pointer-events:none;contain:layout style;`;
  host.innerHTML = '<div class="process-log-body" style="overflow:visible"><div class="tool-call-card"><div class="tool-call-body">'
    + '<div class="shell-output-preview"><div class="shell-output-panel"><div class="shell-output-body" style="overflow:visible">'
    + `<span class="shell-output-line" style="white-space:pre">${"0".repeat(LOG_PROBE_CHARS)}</span></div></div></div></div></div></div>`;
  // The body, not the deck: an inactive inspector view is not laid out, so a probe inside it measures 0.
  document.body.appendChild(host);
  try {
    const probeBody = host.querySelector<HTMLElement>(".shell-output-body");
    const probeText = host.querySelector<HTMLElement>(".shell-output-line");
    if (!probeBody || !probeText) return null;
    const charWidth = probeText.getBoundingClientRect().width / LOG_PROBE_CHARS;
    if (!(charWidth > 0)) return null;
    let chrome = LOG_PROBE_WIDTH - contentInlineSize(probeBody);
    const liveBody = deck
      ? [...deck.querySelectorAll<HTMLElement>(".process-log .shell-output-body")].find((body) => body.getClientRects().length > 0)
      : undefined;
    if (deck && liveBody) chrome = deck.getBoundingClientRect().width - contentInlineSize(liveBody);
    return { charWidth, chrome };
  } finally {
    host.remove();
  }
}
