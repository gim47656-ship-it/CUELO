"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TranscriptSearchHit, TranscriptSearchResult } from "@/lib/transcript-search";
import type { SessionInfo } from "@/lib/types";

type SearchResponse = TranscriptSearchResult & { query: string; sessions: Record<string, SessionInfo> };

interface Props {
  onPick: (session: SessionInfo, hit: TranscriptSearchHit, query: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const SEARCH_DEBOUNCE_MS = 250;
// The server ignores shorter queries (`TRANSCRIPT_SEARCH_MIN_QUERY`); that module reads files, so it is not imported here.
const TRANSCRIPT_SEARCH_MIN_QUERY = 2;

function sessionTitle(session: SessionInfo | undefined): string {
  if (!session) return "";
  return session.name?.trim() || session.firstMessage?.trim() || session.id;
}

/**
 * The command palette's transcript search: the query box at the top of the
 * palette and, once it has text, the matching messages across saved sessions.
 * The existing actions stay below it.
 */
export function PaletteTranscriptSearch({ onPick, t }: Props) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "error" } | { kind: "done"; data: SearchResponse }>({ kind: "idle" });
  const listRef = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < TRANSCRIPT_SEARCH_MIN_QUERY) {
      setState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    const timer = setTimeout(() => {
      fetch(`/api/sessions/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal, cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setState({ kind: "done", data: await response.json() as SearchResponse });
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ kind: "error" });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  const focusResult = (position: number) => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!buttons || buttons.length === 0) return;
    buttons[Math.max(0, Math.min(buttons.length - 1, position))]?.focus();
  };

  const onResultKeyDown = (event: KeyboardEvent<HTMLButtonElement>, position: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusResult(position + (event.key === "ArrowDown" ? 1 : -1));
    }
  };

  const data = state.kind === "done" ? state.data : null;
  const truncationNote = data?.truncated
    ? t(`palette.searchTruncated.${data.truncated}`, { scanned: data.scannedSessions, total: data.totalSessions })
    : null;

  return (
    <div className="palette-search">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            focusResult(0);
          } else if (event.key === "Enter" && data && data.hits.length > 0) {
            event.preventDefault();
            const hit = data.hits[0];
            const session = data.sessions[hit.sessionId];
            if (session) onPick(session, hit, data.query);
          }
        }}
        placeholder={t("palette.searchPlaceholder")}
        aria-label={t("palette.searchPlaceholder")}
        autoComplete="off"
        spellCheck={false}
      />
      {trimmed.length >= TRANSCRIPT_SEARCH_MIN_QUERY && (
        <div className="palette-search-results" role="region" aria-label={t("palette.searchResults")} aria-busy={state.kind === "loading"}>
          <p className="palette-search-status" aria-live="polite">
            {state.kind === "loading" && t("palette.searching")}
            {state.kind === "error" && t("palette.searchFailed")}
            {data && (data.hits.length === 0 ? t("palette.searchEmpty") : t("palette.searchHits", { count: data.hits.length }))}
            {truncationNote ? ` · ${truncationNote}` : ""}
            {data && data.compactedHits > 0 ? ` · ${t("palette.searchCompacted", { count: data.compactedHits })}` : ""}
          </p>
          {data && data.hits.length > 0 && (
            <div ref={listRef} className="palette-search-list">
              {data.hits.map((hit, position) => {
                const session = data.sessions[hit.sessionId];
                const matchEnd = hit.matchStart + data.query.length;
                return (
                  <button
                    key={`${hit.sessionId}:${hit.entryId}`}
                    type="button"
                    disabled={!session}
                    onClick={() => session && onPick(session, hit, data.query)}
                    onKeyDown={(event) => onResultKeyDown(event, position)}
                  >
                    <span className="palette-search-title">
                      <span>{sessionTitle(session)}</span>
                      <small>{hit.role === "user" ? t("palette.searchRoleUser") : t("palette.searchRoleAssistant")}</small>
                    </span>
                    <span className="palette-search-snippet">
                      {hit.snippet.slice(0, hit.matchStart)}
                      <mark>{hit.snippet.slice(hit.matchStart, matchEnd)}</mark>
                      {hit.snippet.slice(matchEnd)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
