"use client";

import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

export interface RailQuestion {
  /** Index of the question in the conversation items. */
  item: number;
  text: string;
}

interface QuestionRailProps {
  questions: readonly RailQuestion[];
  /** The transcript scroller whose `[data-chat-item]` holders mark item positions. */
  containerRef: RefObject<HTMLElement | null>;
  /** Changes whenever the rendered range of items changes. */
  layoutKey: string;
  onJump: (item: number) => void;
  label: string;
}

/**
 * A thin strip of ticks, one per question the user asked, in the transcript's
 * right margin (on phones inside the column padding, clear of the messages and
 * the composer). Each tick jumps to its question. Ticks keep a 24px pitch; a
 * longer list scrolls inside the strip. Up/Down/Home/End move between ticks.
 */
export function QuestionRail({ questions, containerRef, layoutKey, onJump, label }: QuestionRailProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // The question the reader is at, or -1. Tracked here so scrolling re-renders
  // only the rail, never the transcript.
  const [activeItem, setActiveItem] = useState(-1);
  // The strip is secondary: it mounts in its own task after the transcript's
  // first render instead of lengthening it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(timer);
  }, []);
  const tracking = mounted && questions.length >= 2;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !tracking) return;
    let frame = 0;
    // Holders only change with the rendered range (this effect's key); scroll
    // frames reuse the list instead of querying the DOM each time.
    let holders: NodeListOf<HTMLElement> | null = null;
    const update = () => {
      frame = 0;
      // The first rendered item still visible at the top; holders are in order.
      if (!holders?.[0]?.isConnected) holders = container.querySelectorAll<HTMLElement>("[data-chat-item]");
      const top = container.getBoundingClientRect().top + 8;
      let low = 0;
      let high = holders.length - 1;
      let first = holders.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const box = holders[mid].firstElementChild?.getBoundingClientRect();
        if (box && box.bottom > top) {
          first = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
      const visibleItem = first >= 0 ? Number(holders[first].dataset.chatItem) : -1;
      let active = -1;
      for (const question of questions) {
        if (question.item > visibleItem) break;
        active = question.item;
      }
      setActiveItem(active);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [questions, tracking, layoutKey, containerRef]);

  // Keep the active tick visible inside a scrolling strip.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>("[aria-current='true']");
    if (!list || !active) return;
    const top = active.offsetTop - list.scrollTop;
    if (top < 0 || top + active.offsetHeight > list.clientHeight) {
      list.scrollTop = active.offsetTop - (list.clientHeight - active.offsetHeight) / 2;
    }
  }, [activeItem]);

  const count = questions.length;
  const moveFocus = useCallback((event: KeyboardEvent<HTMLButtonElement>, position: number) => {
    const target = event.key === "ArrowUp" ? position - 1
      : event.key === "ArrowDown" ? position + 1
        : event.key === "Home" ? 0
          : event.key === "End" ? count - 1
            : null;
    if (target === null) return;
    event.preventDefault();
    const clamped = Math.max(0, Math.min(count - 1, target));
    listRef.current?.querySelectorAll<HTMLButtonElement>("button")[clamped]?.focus();
  }, [count]);

  if (!tracking) return null;
  // One tab stop for the whole strip: the active tick, or the first one.
  const focusItem = questions.some((question) => question.item === activeItem) ? activeItem : questions[0].item;
  return (
    <nav className="question-rail" aria-label={label}>
      <div ref={listRef} className="question-rail-list">
        {questions.map((question, position) => (
          <RailTick
            key={question.item}
            question={question}
            position={position}
            count={count}
            active={question.item === activeItem}
            focusable={question.item === focusItem}
            onJump={onJump}
            onMoveFocus={moveFocus}
          />
        ))}
      </div>
    </nav>
  );
}

interface RailTickProps {
  question: RailQuestion;
  position: number;
  count: number;
  active: boolean;
  focusable: boolean;
  onJump: (item: number) => void;
  onMoveFocus: (event: KeyboardEvent<HTMLButtonElement>, position: number) => void;
}

// Memoized so moving through the conversation re-renders two ticks, not all.
const RailTick = memo(function RailTick({ question, position, count, active, focusable, onJump, onMoveFocus }: RailTickProps) {
  const preview = question.text.length > 140 ? `${question.text.slice(0, 140)}…` : question.text;
  return (
    <button
      type="button"
      className="question-rail-tick"
      tabIndex={focusable ? 0 : -1}
      aria-current={active ? "true" : undefined}
      aria-label={`${position + 1}/${count} ${preview}`}
      title={preview}
      onClick={() => onJump(question.item)}
      onKeyDown={(event) => onMoveFocus(event, position)}
    >
      <span aria-hidden="true" />
    </button>
  );
});
