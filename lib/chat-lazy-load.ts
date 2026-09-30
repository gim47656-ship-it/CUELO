export const VISIBLE_PAGE_SIZE = 50;
/** Items kept above a jump target so it does not land on the very first row. */
const JUMP_CONTEXT_BEFORE = 10;

/**
 * Which conversation items are in the DOM. `end: null` follows the tail - the
 * normal state, where new messages appear and the last `count` items render.
 * A jump to an older item (search, question rail, palette hit) detaches the
 * window: `end` is fixed and new messages wait outside it until the reader
 * returns to the latest.
 */
export interface RenderWindow {
  count: number;
  end: number | null;
}

export const TAIL_WINDOW: RenderWindow = { count: VISIBLE_PAGE_SIZE, end: null };

export function getVisibleRenderWindow(totalCount: number, window: RenderWindow): {
  startIndex: number;
  endIndex: number;
  hasMore: boolean;
  hasLater: boolean;
} {
  const total = Math.max(totalCount, 0);
  const endIndex = window.end === null ? total : Math.min(Math.max(window.end, 0), total);
  const count = Math.min(Math.max(window.count, 0), endIndex);
  const startIndex = endIndex - count;
  return { startIndex, endIndex, hasMore: startIndex > 0, hasLater: endIndex < total };
}

export function loadEarlier(window: RenderWindow, pageSize = VISIBLE_PAGE_SIZE): RenderWindow {
  return { ...window, count: window.count + pageSize };
}

/** One more page below a detached window; reaching the tail re-attaches it without moving its top. */
export function loadLater(totalCount: number, window: RenderWindow, pageSize = VISIBLE_PAGE_SIZE): RenderWindow {
  if (window.end === null) return window;
  const { startIndex, endIndex } = getVisibleRenderWindow(totalCount, window);
  const end = endIndex + pageSize;
  return end >= totalCount ? { count: totalCount - startIndex, end: null } : { count: end - startIndex, end };
}

/** A window that contains `item`; the current one when it already does. */
export function windowAround(totalCount: number, item: number, window: RenderWindow): RenderWindow {
  const { startIndex, endIndex } = getVisibleRenderWindow(totalCount, window);
  if (item >= startIndex && item < endIndex) return window;
  const start = Math.max(0, item - JUMP_CONTEXT_BEFORE);
  const end = Math.max(item + 1, start + VISIBLE_PAGE_SIZE);
  return end >= totalCount ? { count: totalCount - start, end: null } : { count: end - start, end };
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}
