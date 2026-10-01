import { open } from "node:fs/promises";

/**
 * Bounded full-text search over saved session transcripts.
 *
 * The sessions directory can hold thousands of files and gigabytes of JSONL, so
 * a query scans newest-first and stops at a time, byte or result budget; the
 * caller reports which budget cut the scan short. Only user text and assistant
 * text blocks are searched - thinking, tool calls and tool output are the work
 * log, not the conversation. Hits inside history the latest compaction replaced
 * are left out: the chat window cannot show them, so a jump would land nowhere.
 */

export interface TranscriptSearchSession {
  id: string;
  path: string;
  modified: string;
}

export interface TranscriptSearchHit {
  sessionId: string;
  entryId: string;
  role: "user" | "assistant";
  snippet: string;
  /** Offset of the match inside `snippet`, so the client can mark it. */
  matchStart: number;
  timestamp?: string;
}

export type TranscriptSearchTruncation = "time" | "bytes" | "results";

export interface TranscriptSearchResult {
  hits: TranscriptSearchHit[];
  scannedSessions: number;
  totalSessions: number;
  scannedBytes: number;
  /** Hits dropped because they sit in history the latest compaction replaced. */
  compactedHits: number;
  truncated: TranscriptSearchTruncation | null;
}

export interface TranscriptSearchLimits {
  maxMs: number;
  maxBytes: number;
  maxHits: number;
  maxHitsPerSession: number;
}

export const DEFAULT_TRANSCRIPT_SEARCH_LIMITS: TranscriptSearchLimits = {
  maxMs: 4_000,
  maxBytes: 768 * 1024 * 1024,
  maxHits: 50,
  maxHitsPerSession: 3,
};

export const TRANSCRIPT_SEARCH_MIN_QUERY = 2;
const READ_CHUNK_BYTES = 1024 * 1024;
const SNIPPET_BEFORE = 50;
const SNIPPET_AFTER = 90;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textOf(content: unknown, role: "user" | "assistant"): string {
  if (typeof content === "string") return role === "user" ? content : "";
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text" || !("text" in block)) continue;
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** A single-line excerpt around the first case-insensitive match. */
export function buildSnippet(text: string, needle: string): { snippet: string; matchStart: number } | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return null;
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(flat.length, at + needle.length + SNIPPET_AFTER);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return { snippet: `${prefix}${flat.slice(start, end)}${suffix}`, matchStart: prefix.length + at - start };
}

interface FileScan {
  hits: (TranscriptSearchHit & { line: number })[];
  bytes: number;
  stoppedBy: "time" | "bytes" | null;
  /** Line of the entry the latest compaction kept first; earlier hits are hidden history. */
  keptFromLine: number | null;
  /** Matches the final latest compaction replaced that this scan had already collected. */
  prunedHits: number;
}

const ID_PATTERN = /"id":"([^"]+)"/;
type Entry = { type?: string; id?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } };

/** The searchable hit on one raw JSONL line, or null when the line is not a matching user/assistant message. */
function parseHit(
  raw: string,
  lineNo: number,
  sessionId: string,
  needle: string,
  pattern: RegExp,
): (TranscriptSearchHit & { line: number }) | null {
  if (!raw.includes('"type":"message"')) return null;
  if (!raw.includes('"role":"user"') && !raw.includes('"role":"assistant"')) return null;
  if (!pattern.test(raw)) return null;
  let entry: Entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  const role = entry.message?.role;
  if (entry.type !== "message" || typeof entry.id !== "string" || (role !== "user" && role !== "assistant")) return null;
  const excerpt = buildSnippet(textOf(entry.message?.content, role), needle);
  if (!excerpt) return null;
  return {
    sessionId,
    entryId: entry.id,
    role,
    snippet: excerpt.snippet,
    matchStart: excerpt.matchStart,
    ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
    line: lineNo,
  };
}

async function scanFile(
  session: TranscriptSearchSession,
  needle: string,
  pattern: RegExp,
  limits: TranscriptSearchLimits,
  deadline: number,
  bytesLeft: number,
  now: () => number,
): Promise<FileScan> {
  const scan: FileScan = { hits: [], bytes: 0, stoppedBy: null, keptFromLine: null, prunedHits: 0 };
  const handle = await open(session.path, "r");
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    const decoder = new TextDecoder();
    const entryById = new Map<string, { line: number; offset: number }>();
    let latestFirstKept: string | null = null;
    let pending = "";
    let line = 0;
    let lineOffset = 0;
    let position = 0;
    // Quota is spent on visible hits only: a compaction marker frees what the
    // history it replaced had taken. A match skipped while the quota was full,
    // or pruned by an earlier marker that the final one does not cover, may sit
    // in the retained range: that range is read once more at the end.
    let firstSkippedLine = -1;
    let lastSkippedLine = -1;
    let maxPrunedLine = -1;
    const prunedLines: number[] = [];
    const handleLine = (raw: string): void => {
      const lineNo = line++;
      const offset = lineOffset;
      lineOffset += Buffer.byteLength(raw) + 1;
      if (raw.startsWith('{"type":"compaction"') || (raw.includes('"type":"compaction"') && !raw.includes('"type":"message"'))) {
        try {
          const entry = JSON.parse(raw) as { type?: string; firstKeptEntryId?: unknown };
          if (entry.type === "compaction" && typeof entry.firstKeptEntryId === "string") latestFirstKept = entry.firstKeptEntryId;
        } catch {
          // A torn line is skipped like the session reader skips it.
        }
        const keptLine = latestFirstKept === null ? undefined : entryById.get(latestFirstKept)?.line;
        if (keptLine !== undefined) {
          const visible = scan.hits.filter((hit) => hit.line >= keptLine);
          for (const hit of scan.hits) if (hit.line < keptLine) prunedLines.push(hit.line);
          if (visible.length !== scan.hits.length) maxPrunedLine = Math.max(maxPrunedLine, keptLine);
          scan.hits = visible;
        }
        return;
      }
      if (!raw.includes('"type":"message"')) return;
      const id = ID_PATTERN.exec(raw.slice(0, 200))?.[1];
      if (id) entryById.set(id, { line: lineNo, offset });
      const hit = parseHit(raw, lineNo, session.id, needle, pattern);
      if (!hit) return;
      if (scan.hits.length >= limits.maxHitsPerSession) {
        if (firstSkippedLine < 0) firstSkippedLine = lineNo;
        lastSkippedLine = lineNo;
        return;
      }
      scan.hits.push(hit);
    };
    for (;;) {
      if (now() >= deadline) {
        scan.stoppedBy = "time";
        break;
      }
      if (scan.bytes >= bytesLeft) {
        scan.stoppedBy = "bytes";
        break;
      }
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      scan.bytes += bytesRead;
      pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const raw of lines) handleLine(raw);
    }
    if (scan.stoppedBy === null && pending) handleLine(pending);
    const kept = latestFirstKept === null ? undefined : entryById.get(latestFirstKept);
    if (kept) scan.keptFromLine = kept.line;
    const finalKeptLine = scan.keptFromLine ?? 0;
    scan.prunedHits = prunedLines.filter((prunedLine) => prunedLine < finalKeptLine).length;
    // Without a marker the first hits are the visible ones. After one, a hit
    // skipped earlier in the retained range can rank before hits stored later.
    const cap = limits.maxHitsPerSession;
    const lastStored = scan.hits.length > 0 ? scan.hits[scan.hits.length - 1].line : -1;
    const skippedRetained =
      maxPrunedLine >= 0 && lastSkippedLine >= finalKeptLine && (scan.hits.length < cap || lastStored > firstSkippedLine);
    const needsReread = scan.stoppedBy === null && (skippedRetained || maxPrunedLine > finalKeptLine);
    if (needsReread) {
      const from = kept ?? { line: 0, offset: 0 };
      const hits: FileScan["hits"] = [];
      const rereadDecoder = new TextDecoder();
      let tail = "";
      let rereadLine = from.line;
      let at = from.offset;
      reread: for (;;) {
        if (now() >= deadline) {
          scan.stoppedBy = "time";
          break;
        }
        if (scan.bytes >= bytesLeft) {
          scan.stoppedBy = "bytes";
          break;
        }
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
        if (bytesRead <= 0) break;
        at += bytesRead;
        scan.bytes += bytesRead;
        tail += rereadDecoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        const lines = tail.split("\n");
        tail = lines.pop() ?? "";
        for (const raw of lines) {
          const hit = parseHit(raw, rereadLine++, session.id, needle, pattern);
          if (hit && hits.push(hit) >= limits.maxHitsPerSession) break reread;
        }
      }
      if (scan.stoppedBy === null && hits.length < cap && tail) {
        const hit = parseHit(tail, rereadLine, session.id, needle, pattern);
        if (hit) hits.push(hit);
      }
      // An interrupted re-read keeps what it recovered next to the first pass.
      const merged = new Map<number, FileScan["hits"][number]>();
      for (const hit of [...scan.hits, ...hits]) if (hit.line >= finalKeptLine) merged.set(hit.line, hit);
      scan.hits = [...merged.values()].sort((a, b) => a.line - b.line).slice(0, cap);
    }
  } finally {
    await handle.close();
  }
  return scan;
}

export async function searchTranscripts(
  sessions: readonly TranscriptSearchSession[],
  query: string,
  limits: TranscriptSearchLimits = DEFAULT_TRANSCRIPT_SEARCH_LIMITS,
  now: () => number = Date.now,
): Promise<TranscriptSearchResult> {
  const needle = query.trim();
  const result: TranscriptSearchResult = {
    hits: [],
    scannedSessions: 0,
    totalSessions: sessions.length,
    scannedBytes: 0,
    compactedHits: 0,
    truncated: null,
  };
  if (needle.length < TRANSCRIPT_SEARCH_MIN_QUERY) return result;
  // JSON escapes quotes, backslashes and control characters, so those needles
  // cannot pre-filter raw lines; they are matched against the parsed text only.
  const rawSafe = !/["\\\u0000-\u001f]/.test(needle);
  const pattern = rawSafe ? new RegExp(escapeRegExp(needle), "i") : /"role":"(?:user|assistant)"/;
  const deadline = now() + limits.maxMs;
  const ordered = [...sessions].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  for (const session of ordered) {
    if (result.hits.length >= limits.maxHits) {
      result.truncated = "results";
      break;
    }
    if (now() >= deadline) {
      result.truncated = "time";
      break;
    }
    const bytesLeft = limits.maxBytes - result.scannedBytes;
    if (bytesLeft <= 0) {
      result.truncated = "bytes";
      break;
    }
    let scan: FileScan;
    try {
      scan = await scanFile(session, needle, pattern, limits, deadline, bytesLeft, now);
    } catch {
      // A session deleted or locked mid-scan is simply not searched.
      result.scannedSessions += 1;
      continue;
    }
    result.scannedBytes += scan.bytes;
    result.scannedSessions += 1;
    result.compactedHits += scan.prunedHits;
    for (const { line, ...hit } of scan.hits) {
      if (scan.keptFromLine !== null && line < scan.keptFromLine) {
        result.compactedHits += 1;
        continue;
      }
      if (result.hits.length >= limits.maxHits) {
        result.truncated = "results";
        break;
      }
      result.hits.push(hit);
    }
    if (scan.stoppedBy) {
      // A partly read file still counts as scanned; the budget that cut it is reported.
      result.truncated = scan.stoppedBy;
      break;
    }
  }
  return result;
}
