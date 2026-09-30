"use client";

import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { listChatSearchHits, resolveActiveHit, type ChatSearchKey } from "@/lib/chat-search";

/**
 * In-chat find (Ctrl/Cmd+F). The chat renders only a window of a long
 * conversation, so the browser's own find cannot reach older messages. Items
 * inside the window are matched on their rendered text (the DOM is what the
 * reader sees, markdown included); items outside it are matched on their data
 * and brought into the window only when the reader steps onto one of them.
 * Highlights use the CSS Custom Highlight API; without it the hit still
 * scrolls into view. Pattern from pi-web-ui `web/src/components/SearchBar.tsx`.
 */

const HIGHLIGHT_ALL = "cuelo-chat-search";
const HIGHLIGHT_ACTIVE = "cuelo-chat-search-active";

function setHighlight(name: string, ranges: Range[]): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (ranges.length === 0 || typeof Highlight === "undefined") {
    CSS.highlights.delete(name);
    return;
  }
  CSS.highlights.set(name, new Highlight(...ranges));
}

/** Text ranges of `needle` inside rendered conversation items, grouped by item. */
function collectRanges(root: HTMLElement, needle: string): Map<number, Range[]> {
  const byItem = new Map<number, Range[]>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return (node.textContent ?? "").toLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const holder = node.parentElement?.closest<HTMLElement>("[data-chat-item]");
    const item = holder ? Number(holder.dataset.chatItem) : Number.NaN;
    if (!Number.isInteger(item)) continue;
    const lower = (node.textContent ?? "").toLowerCase();
    let ranges = byItem.get(item);
    if (!ranges) {
      ranges = [];
      byItem.set(item, ranges);
    }
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return byItem;
}

/** Centre the hit in the transcript when it is not already comfortably visible. */
function scrollRangeIntoView(container: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  if (rect.height <= 0) return;
  if (rect.top >= box.top + 48 && rect.bottom <= box.bottom - 48) return;
  container.scrollTop += rect.top - box.top - (container.clientHeight - rect.height) / 2;
}

export interface ChatSearchBarProps {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLDivElement | null>;
  /** Lower-cased text of every conversation item, in order. */
  index: readonly string[];
  /** Conversation items currently in the DOM: [start, end). */
  renderedStart: number;
  renderedEnd: number;
  /** Changes whenever rendered content changes, so DOM hits are collected again. */
  contentKey: unknown;
  /** Bring an item outside the rendered window into it. */
  onReveal: (item: number) => void;
  /** Called before the bar scrolls the transcript, so auto-follow steps aside. */
  onProgrammaticScroll: () => void;
  focusRequest: number;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function ChatSearchBar({
  open, onClose, containerRef, index, renderedStart, renderedEnd, contentKey, onReveal, onProgrammaticScroll, focusRequest, t,
}: ChatSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<ChatSearchKey | null>(null);
  const [counter, setCounter] = useState<{ index: number; total: number }>({ index: -1, total: 0 });
  const deferredQuery = useDeferredValue(query);
  const needle = open ? deferredQuery.trim().toLowerCase() : "";
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const hitsRef = useRef<ChatSearchKey[]>([]);
  // What the last pass showed; scrolling happens only when the reader moved.
  const shownRef = useRef<{ key: ChatSearchKey | null; needle: string; rendered: boolean }>({ key: null, needle: "", rendered: false });

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [open, focusRequest]);

  useEffect(() => () => {
    setHighlight(HIGHLIGHT_ALL, []);
    setHighlight(HIGHLIGHT_ACTIVE, []);
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!open || !needle || !container) {
      setHighlight(HIGHLIGHT_ALL, []);
      setHighlight(HIGHLIGHT_ACTIVE, []);
      hitsRef.current = [];
      shownRef.current = { key: null, needle: "", rendered: false };
      setCounter((current) => (current.total === 0 && current.index === -1 ? current : { index: -1, total: 0 }));
      return;
    }
    const frame = requestAnimationFrame(() => {
      const ranges = collectRanges(container, needle);
      const renderedCounts = new Map<number, number>();
      for (const [item, list] of ranges) renderedCounts.set(item, list.length);
      const hits = listChatSearchHits(index, needle, renderedCounts, renderedStart, renderedEnd);
      hitsRef.current = hits;
      const at = resolveActiveHit(hits, activeKeyRef.current);
      setCounter((current) => (current.index === at && current.total === hits.length ? current : { index: at, total: hits.length }));
      const all: Range[] = [];
      for (const list of ranges.values()) for (const range of list) all.push(range);
      setHighlight(HIGHLIGHT_ALL, all);
      if (at < 0) {
        setHighlight(HIGHLIGHT_ACTIVE, []);
        shownRef.current = { key: null, needle, rendered: false };
        return;
      }
      const hit = hits[at];
      const current = activeKeyRef.current;
      if (!current || current.item !== hit.item || current.k !== hit.k) setActiveKey(hit);
      const rendered = hit.item >= renderedStart && hit.item < renderedEnd;
      const shown = shownRef.current;
      const moved = shown.needle !== needle
        || shown.key?.item !== hit.item
        || shown.key?.k !== hit.k
        || (!shown.rendered && rendered);
      shownRef.current = { key: hit, needle, rendered };
      if (!rendered) {
        setHighlight(HIGHLIGHT_ACTIVE, []);
        if (moved) onReveal(hit.item);
        return;
      }
      const range = ranges.get(hit.item)?.[hit.k];
      setHighlight(HIGHLIGHT_ACTIVE, range ? [range] : []);
      if (!moved) return;
      onProgrammaticScroll();
      if (range) {
        scrollRangeIntoView(container, range);
      } else {
        container.querySelector<HTMLElement>(`[data-chat-item="${hit.item}"] > *`)?.scrollIntoView({ block: "center" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, needle, index, renderedStart, renderedEnd, contentKey, activeKey, containerRef, onReveal, onProgrammaticScroll]);

  const step = useCallback((direction: 1 | -1) => {
    const hits = hitsRef.current;
    if (hits.length === 0) return;
    const at = resolveActiveHit(hits, activeKeyRef.current);
    setActiveKey(hits[(at + direction + hits.length) % hits.length]);
  }, []);

  if (!open) return null;
  const hasQuery = query.trim().length > 0;
  const status = !hasQuery
    ? ""
    : counter.total === 0
      ? t("chat.searchNoResults")
      : t("chat.searchCount", { index: counter.index + 1, total: counter.total });
  return (
    <div
      className="chat-find-bar"
      role="search"
      data-dismissible-layer=""
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          step(event.shiftKey ? -1 : 1);
        }}
        placeholder={t("chat.searchPlaceholder")}
        aria-label={t("chat.searchPlaceholder")}
        autoComplete="off"
        spellCheck={false}
      />
      <span className="chat-find-count" aria-live="polite">{status}</span>
      <button type="button" onClick={() => step(-1)} disabled={counter.total === 0} aria-label={t("chat.searchPrevious")} title={`${t("chat.searchPrevious")} (Shift+Enter)`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
      </button>
      <button type="button" onClick={() => step(1)} disabled={counter.total === 0} aria-label={t("chat.searchNext")} title={`${t("chat.searchNext")} (Enter)`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <button type="button" onClick={onClose} aria-label={t("chat.searchClose")} title={`${t("chat.searchClose")} (Esc)`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
      </button>
    </div>
  );
}
