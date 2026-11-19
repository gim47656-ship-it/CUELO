import type { CustomToolAPI, CustomToolContext, CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { isEnoent, parseSpillUrl, spillFileName, spillUrl } from "@oh-my-pi/pi-utils";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

// artifact_search: on-demand literal keyword search over one current spill or historical artifact.
// Architecture: existing OMP tool output -> existing artifact file (never modified) -> in-memory bun:sqlite FTS5
// index built lazily on the first search -> locators for the native `read` tool, which stays the only evidence source.
// Not semantic, no model call, no shell, no network, no write, no read-evidence registration.

/** Largest artifact this tool will index. Bigger ones are refused with a native-read fallback instead of truncated. */
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const DEFAULT_READ_CHUNK_BYTES = 512 * 1024;
const SEGMENT_CHARS = 2000;
const GROUP_CHARS = 1500;
const GROUP_LINES = 30;
const MAX_QUERY_CHARS = 512;
/** A long-line segment repeats the last SEGMENT_OVERLAP chars of the previous one; must be >= MAX_QUERY_CHARS so a query word never straddles every cut. */
const SEGMENT_OVERLAP = MAX_QUERY_CHARS;
/** Joins the lines of a grouped row: U+E000 is a unicode61 token character, so a phrase can never match across it (a query word matches inside one line). */
const LINE_SEPARATOR = "\n\uE000\n";
/** Native `read` returns only about the first 50 KB of a single line ("partial"); hits deeper than this char offset may be unreachable through it. */
const NATIVE_READ_LINE_CHARS = 40_000;
const SESSION_CHANGED = "the session changed while artifact_search was running; retry the search";
const MAX_QUERY_UNITS = 16;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_HIT_LINES_PER_RANGE = 4;
const HIT_EXCERPT_CHARS = 240;
const CONTEXT_LINES = 3;
const IDLE_CACHE_MS = 5 * 60 * 1000;
const SESSION_EVENTS = new Set(["start", "switch", "branch", "tree", "shutdown"]);
const TOKEN_RE = /[\p{L}\p{N}\p{M}]+/gu;

export interface ArtifactSearchOptions {
  /** Bytes read from the artifact per indexing step (tests use a tiny value to exercise cancellation). */
  readChunkBytes?: number;
}

export interface ArtifactSearchDetails {
  artifact: string;
  query: string;
  mode: "and" | "or";
  total: number;
  shown: number;
  offset: number;
  nextOffset: number | null;
  lines: number;
  bytes: number;
  cache: "cold" | "warm";
  indexMs: number;
  searchMs: number;
}

interface SearchParams {
  path: string;
  query: string;
  limit?: number;
  offset?: number;
}

interface ArtifactStore {
  readonly dir: string;
  readonly sessionDir: string | null;
}

interface ArtifactTarget {
  id: string;
  url: string;
  legacy: boolean;
}

interface OpenedArtifact {
  url: string;
  handle: fs.promises.FileHandle;
  size: number;
  mtimeMs: number;
  key: string;
}

class IndexEntry {
  holds = 0;
  retired = false;
  closed = false;
  constructor(
    readonly key: string,
    readonly db: Database,
    readonly lines: number,
    readonly bytes: number,
    readonly indexMs: number,
  ) {}
  release(): void {
    this.holds--;
    if (this.retired && this.holds <= 0) this.close();
  }
  retire(): void {
    this.retired = true;
    if (this.holds <= 0) this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

interface Build {
  controller: AbortController;
  tokens: Set<object>;
  done: boolean;
  entry?: IndexEntry;
  promise: Promise<IndexEntry>;
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error("artifact_search was cancelled");
}

function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/** Cut position <= limit for one long-line segment: prefer just after a non-token character near the end. */
function findCut(text: string, limit: number): number {
  let cut = limit;
  const floor = Math.max(1, limit - 256);
  for (let i = limit; i > floor; i--) {
    if (!/[\p{L}\p{N}\p{M}]/u.test(text[i - 1])) {
      cut = i;
      break;
    }
  }
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff && cut < text.length) cut++;
  return cut;
}

interface IndexBuildResult {
  db: Database;
  lines: number;
}

/**
 * Index the whole file as line-mapped rows. Normal lines are grouped into small chunks; a line longer than
 * SEGMENT_CHARS is cut into segments (never dropped) so a hit anywhere inside it stays findable.
 */
async function buildIndex(src: OpenedArtifact, signal: AbortSignal, chunkBytes: number): Promise<IndexBuildResult> {
  const db = new Database(":memory:");
  try {
    db.run(
      "CREATE VIRTUAL TABLE chunks USING fts5(text, start_line UNINDEXED, end_line UNINDEXED, char_start UNINDEXED, tokenize='unicode61 remove_diacritics 0')",
    );
    const insert = db.prepare("INSERT INTO chunks(text, start_line, end_line, char_start) VALUES (?, ?, ?, ?)");
    const decoder = new TextDecoder("utf-8");
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, src.size)));

    let lineNo = 1; // line currently being accumulated
    let pending = ""; // text of the current line not yet emitted
    let pendingOffset = 0; // chars of the current line already emitted as long-line segments
    let groupLines: string[] = [];
    let groupStart = 0;
    let groupChars = 0;
    let completedLines = 0;
    let carried = 0;

    const flushGroup = (): void => {
      if (groupLines.length === 0) return;
      insert.run(groupLines.join(LINE_SEPARATOR), groupStart, groupStart + groupLines.length - 1, -1);
      groupLines = [];
      groupChars = 0;
    };
    // A segment overlaps the previous one by SEGMENT_OVERLAP chars (>= the longest query word), so a query word that
    // straddles a cut is whole inside the next segment. `carried` = leading chars of `text` already indexed.
    const emitSegments = (text: string, final: boolean): string => {
      flushGroup();
      const threshold = final ? SEGMENT_CHARS : SEGMENT_CHARS * 2;
      while (text.length > threshold) {
        const cut = findCut(text, SEGMENT_CHARS);
        insert.run(text.slice(0, cut), lineNo, lineNo, pendingOffset);
        pendingOffset += cut - SEGMENT_OVERLAP;
        text = text.slice(cut - SEGMENT_OVERLAP);
        carried = SEGMENT_OVERLAP;
      }
      return text;
    };
    const finishLine = (): void => {
      let text = pending;
      if (text.endsWith("\r")) text = text.slice(0, -1);
      if (pendingOffset === 0 && text.length <= SEGMENT_CHARS) {
        if (text.length > 0) {
          if (groupLines.length === 0) groupStart = lineNo;
          // Keep blank lines inside a group so start..end stays a contiguous line range.
          groupLines.push(text);
          groupChars += text.length;
          if (groupChars >= GROUP_CHARS || groupLines.length >= GROUP_LINES) flushGroup();
        } else if (groupLines.length > 0) {
          groupLines.push("");
        }
      } else {
        const rest = emitSegments(text, true);
        if (rest.length > carried) insert.run(rest, lineNo, lineNo, pendingOffset);
      }
      completedLines++;
      lineNo++;
      pending = "";
      pendingOffset = 0;
      carried = 0;
    };
    const consume = (piece: string): void => {
      let from = 0;
      for (;;) {
        const nl = piece.indexOf("\n", from);
        if (nl < 0) break;
        pending += piece.slice(from, nl);
        finishLine();
        from = nl + 1;
      }
      if (from < piece.length) {
        pending += piece.slice(from);
        if (pending.length > SEGMENT_CHARS * 2) pending = emitSegments(pending, false);
      }
    };

    let position = 0;
    db.run("BEGIN");
    while (position < src.size) {
      if (signal.aborted) throw abortReason(signal);
      const wanted = Math.min(buffer.length, src.size - position);
      const { bytesRead } = await src.handle.read(buffer, 0, wanted, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
      await yieldToEventLoop();
    }
    if (signal.aborted) throw abortReason(signal);
    consume(decoder.decode());
    if (pending.length > 0 || pendingOffset > 0) finishLine();
    flushGroup();
    db.run("COMMIT");
    return { db, lines: completedLines };
  } catch (error) {
    db.close();
    throw error;
  }
}

class IndexStore {
  #generation = 0;
  #cache: IndexEntry | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #inflight = new Map<string, Build>();
  constructor(readonly chunkBytes: number) {}

  invalidate(reason: string): void {
    this.#generation++;
    this.#dropCache();
    for (const build of this.#inflight.values()) build.controller.abort(new Error(reason));
    this.#inflight.clear();
  }

  #dropCache(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    this.#cache?.retire();
    this.#cache = undefined;
  }

  #touchIdle(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.#dropCache(), IDLE_CACHE_MS);
    this.#idleTimer.unref?.();
  }

  /** Lifecycle generation; a request captures it before admission and every later step rechecks it. */
  get generation(): number {
    return this.#generation;
  }

  #assertCurrent(generation: number): void {
    if (generation !== this.#generation) throw new Error(SESSION_CHANGED);
  }

  /** Returns an index held for the caller: call `release` exactly once when finished (extra calls are ignored). */
  async acquire(
    src: OpenedArtifact,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<{ entry: IndexEntry; release: () => void; cold: boolean }> {
    let closeSource = true;
    try {
      // Admission is async, so cancellation and lifecycle events may have happened meanwhile.
      if (signal?.aborted) throw abortReason(signal);
      this.#assertCurrent(generation);
      const cached = this.#cache;
      if (cached && cached.key === src.key && !cached.retired) {
        cached.holds++;
        this.#touchIdle();
        let released = false;
        return {
          entry: cached,
          cold: false,
          release: () => {
            if (released) return;
            released = true;
            cached.release();
          },
        };
      }
      let build = this.#inflight.get(src.key);
      if (build?.controller.signal.aborted) build = undefined; // a cancelled build is not joinable
      if (!build) {
        build = this.#startBuild(src, generation);
        closeSource = false; // the build owns the handle now
      }
      const joined = build;
      const token = {};
      joined.tokens.add(token);
      // Each waiter owns one hold, granted when the build publishes (see #startBuild); a waiter that
      // leaves earlier only withdraws, and the last one to leave cancels the build and unlists it at once.
      const release = (): void => {
        if (!joined.tokens.delete(token)) return;
        if (joined.done) joined.entry?.release();
        else if (joined.tokens.size === 0) {
          joined.controller.abort(new Error("artifact_search was cancelled"));
          if (this.#inflight.get(src.key) === joined) this.#inflight.delete(src.key);
        }
      };
      try {
        const entry = await raceAbort(joined.promise, signal);
        if (joined.controller.signal.aborted) throw abortReason(joined.controller.signal);
        this.#assertCurrent(generation);
        return { entry, release, cold: true };
      } catch (error) {
        release();
        throw error;
      }
    } finally {
      if (closeSource) await src.handle.close().catch(() => undefined);
    }
  }

  #startBuild(src: OpenedArtifact, startGeneration: number): Build {
    const generation = startGeneration;
    const controller = new AbortController();
    const build: Build = { controller, tokens: new Set(), done: false, promise: undefined as unknown as Promise<IndexEntry> };
    const started = performance.now();
    build.promise = (async () => {
      try {
        const { db, lines } = await buildIndex(src, controller.signal, this.chunkBytes);
        try {
          const after = await src.handle.stat();
          if (after.size !== src.size || after.mtimeMs !== src.mtimeMs) {
            throw new Error(`${src.url} changed while it was being indexed; retry the search`);
          }
          if (controller.signal.aborted) throw abortReason(controller.signal);
          if (generation !== this.#generation) throw new Error("the session changed while the artifact was being indexed; retry the search");
        } catch (error) {
          db.close();
          throw error;
        }
        const entry = new IndexEntry(src.key, db, lines, src.size, Math.round(performance.now() - started));
        this.#dropCache();
        this.#cache = entry;
        this.#touchIdle();
        entry.holds = build.tokens.size;
        build.entry = entry;
        build.done = true;
        return entry;
      } finally {
        build.done = true;
        if (this.#inflight.get(src.key) === build) this.#inflight.delete(src.key);
        await src.handle.close().catch(() => undefined);
      }
    })();
    // A rejected build with every waiter gone must not surface as an unhandled rejection.
    build.promise.catch(() => undefined);
    this.#inflight.set(src.key, build);
    return build;
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

function parseArtifactPath(value: string): ArtifactTarget | null {
  const url = value.trim();
  const legacy = /^artifact:\/\/(0|[1-9]\d*)$/.exec(url);
  if (legacy && Number.isSafeInteger(Number(legacy[1]))) return { id: legacy[1], url, legacy: true };
  const id = parseSpillUrl(url);
  // The SDK parser also accepts selectors and numeric aliases. Search only exact spill URLs.
  if (id !== undefined && Number.isSafeInteger(id) && url === spillUrl(id)) return { id: String(id), url, legacy: false };
  return null;
}

async function legacyFilename(dir: string, id: string, url: string): Promise<string> {
  const prefix = `${id}.`;
  const names = (await fs.promises.readdir(dir))
    .filter((entry) => entry.startsWith(prefix) && /^[A-Za-z0-9_-]{1,64}\.log$/.test(entry.slice(prefix.length)));
  if (names.length === 0) throw new Error(`${url} does not exist in this session's artifact store.`);
  if (names.length > 1) throw new Error(`${url} is ambiguous in this session's artifact store; refusing to guess.`);
  return names[0];
}

function directoryChanged(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino;
}

/** Resolve one filename within the chosen store and pin the regular file before reading bytes. */
async function openArtifact(manager: ArtifactStore, { id, url, legacy }: ArtifactTarget): Promise<OpenedArtifact> {
  const storeDir = legacy ? manager.sessionDir : manager.dir;
  const missing = `${url} does not exist in this session's artifact store.`;
  if (!storeDir) throw new Error(missing);
  try {
    const dir = path.resolve(storeDir);
    const sessionDir = manager.sessionDir ? path.resolve(manager.sessionDir) : null;
    // Allow aliases above the store, but not of either session-owned root.
    const anchor = sessionDir === path.dirname(dir) ? sessionDir : dir;
    const realParent = await fs.promises.realpath(path.dirname(anchor));
    const realAnchor = path.join(realParent, path.basename(anchor));
    const realDir = anchor === dir ? realAnchor : path.join(realAnchor, path.basename(dir));
    const anchorStat = anchor === dir ? null : await fs.promises.lstat(realAnchor, { bigint: true });
    const rootStat = await fs.promises.lstat(realDir, { bigint: true });
    if (anchorStat?.isSymbolicLink() || rootStat.isSymbolicLink() || await fs.promises.realpath(dir) !== realDir) {
      throw new Error(`${url} has a symbolic link in the artifact store root; refusing.`);
    }
    if ((anchorStat && !anchorStat.isDirectory()) || !rootStat.isDirectory()) {
      throw new Error(`${url} has no regular artifact store directory.`);
    }

    const name = legacy ? await legacyFilename(realDir, id, url) : spillFileName(id);
    const file = path.join(realDir, name);
    const linkStat = await fs.promises.lstat(file);
    if (linkStat.isSymbolicLink()) throw new Error(`${url} is a symbolic link; refusing.`);
    if (!linkStat.isFile() || linkStat.nlink !== 1) throw new Error(`${url} is not a regular file with one link.`);
    // Nonblocking open avoids hanging if a regular file is swapped for a FIFO during admission.
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const changed = `${url} or its store changed while it was being opened; retry.`;
      const stat = await handle.stat();
      // A directory may have been swapped and restored between lstat and open.
      const openedPath = await fs.promises.readlink(`/proc/self/fd/${handle.fd}`).catch((cause: unknown) => {
        throw new Error(`${url} cannot verify its opened file via /proc/self/fd; use native read if available.`, { cause });
      });
      if (
        !stat.isFile() || stat.nlink !== 1 || stat.ino !== linkStat.ino || stat.dev !== linkStat.dev ||
        openedPath !== file || await fs.promises.realpath(dir) !== realDir ||
        directoryChanged(rootStat, await fs.promises.lstat(realDir, { bigint: true })) ||
        (anchorStat && directoryChanged(anchorStat, await fs.promises.lstat(realAnchor, { bigint: true })))
      ) {
        throw new Error(changed);
      }
      if (legacy && await legacyFilename(realDir, id, url) !== name) throw new Error(changed);
      if (stat.size > MAX_ARTIFACT_BYTES) {
        throw new Error(
          `${url} is ${stat.size} bytes, above the ${MAX_ARTIFACT_BYTES}-byte search limit; nothing was indexed. Use the native read tool with line selectors (for example ${url}:1-200 or ${url}:-100).`,
        );
      }
      return { url, handle, size: stat.size, mtimeMs: stat.mtimeMs, key: [file, url, `${stat.dev}:${stat.ino}`, stat.size, stat.mtimeMs].join("\0") };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (isEnoent(error)) throw new Error(missing);
    throw error;
  }
}

interface QueryPlan {
  /** One FTS5 phrase per whitespace-separated query word (a word like ERR_CONN_RESET becomes the phrase "err conn reset"). */
  units: string[];
  unitTokens: string[][];
}

/** Literal query -> FTS5 phrase units. Operator characters never survive: only letter/number runs are kept. */
export function planQuery(query: string): QueryPlan {
  if (query.length > MAX_QUERY_CHARS) throw new Error(`query is longer than ${MAX_QUERY_CHARS} characters; search for a distinctive word or phrase instead.`);
  const units: string[] = [];
  const unitTokens: string[][] = [];
  for (const word of query.split(/\s+/)) {
    const parts = word.match(TOKEN_RE);
    if (!parts) continue;
    units.push(parts.join(" "));
    unitTokens.push(parts.map((part) => part.toLowerCase()));
  }
  if (units.length === 0) {
    throw new Error("query has no searchable word characters (letters or digits). Use the native read tool with line selectors on the artifact.");
  }
  if (units.length > MAX_QUERY_UNITS) throw new Error(`query has more than ${MAX_QUERY_UNITS} words; use fewer, more distinctive words.`);
  return { units, unitTokens };
}

function matchExpression(units: string[], joiner: " AND " | " OR "): string {
  return units.map((unit) => `"${unit}"*`).join(joiner);
}

interface ChunkRow {
  text: string;
  start_line: number;
  end_line: number;
  char_start: number;
}

/** Char index where one of the query phrases (consecutive words, last word as a prefix) starts in `line`, or -1. */
function findHit(line: string, unitTokens: string[][]): number {
  const found = [...line.matchAll(TOKEN_RE)];
  const words = found.map((m) => m[0].toLowerCase());
  let best = -1;
  for (const unit of unitTokens) {
    const last = unit.length - 1;
    scan: for (let i = 0; i + unit.length <= words.length; i++) {
      for (let j = 0; j < last; j++) if (words[i + j] !== unit[j]) continue scan;
      if (!words[i + last].startsWith(unit[last])) continue;
      const at = found[i].index;
      if (best < 0 || at < best) best = at;
      break;
    }
  }
  return best;
}

function excerpt(line: string, at: number): string {
  if (line.length <= HIT_EXCERPT_CHARS) return line;
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(HIT_EXCERPT_CHARS / 3));
  const end = Math.min(line.length, start + HIT_EXCERPT_CHARS);
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

function formatRange(url: string, row: ChunkRow, unitTokens: string[][], totalLines: number, rank: number): string {
  const isSegment = row.char_start >= 0; // grouped rows store -1
  const lines = row.text.split(LINE_SEPARATOR);
  const hits: { line: number; text: string; at: number }[] = [];
  let unmatched = 0;
  lines.forEach((text, i) => {
    const at = findHit(text, unitTokens);
    if (at < 0) return;
    if (hits.length < MAX_HIT_LINES_PER_RANGE) hits.push({ line: row.start_line + i, text: excerpt(text, at), at });
    else unmatched++;
  });
  // When no line can be pinned (case-folding differences between FTS5 and this scan), the locator covers the whole row.
  const located = hits.length > 0;
  const first = located ? hits[0].line : row.start_line;
  const last = located ? hits[hits.length - 1].line : row.end_line;
  const from = Math.max(1, first - CONTEXT_LINES);
  const to = Math.min(totalLines, last + CONTEXT_LINES);
  const where = isSegment ? ` (long line, segment from char ${row.char_start}${located ? `, hit at char ${row.char_start + hits[0].at}` : ""})` : "";
  const out = [`[${rank}] lines ${first}${last > first ? `-${last}` : ""}${where}  read: ${url}:${from}-${to}  raw: ${url}:raw:${from}-${to}`];
  for (const hit of hits) out.push(`  ${hit.line}: ${hit.text}`);
  if (!located) out.push(`  (matching text not pinned to a line; the locator covers the whole matching range ${row.start_line}-${row.end_line})`);
  if (isSegment && located && row.char_start + hits[0].at >= NATIVE_READ_LINE_CHARS) {
    out.push("  note: native read returns only about the first 50 KB of one line, so this hit (deep inside a long line) may not be readable through the locator; the excerpt remains a search hint, not verified original-read evidence. Check the artifact's backing file (path shown in native read's partial-line notice) with grep or bash for exact bytes.");
  }
  if (unmatched > 0) out.push(`  … ${unmatched} more matching line(s) in this range`);
  return out.join("\n");
}

function bytesLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function integerParam(name: string, value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function createArtifactSearchTool(pi: Pick<CustomToolAPI, "zod">, options: ArtifactSearchOptions = {}) {
  const store = new IndexStore(Math.max(1, options.readChunkBytes ?? DEFAULT_READ_CHUNK_BYTES));
  const z = pi.zod;
  return {
    name: "artifact_search",
    label: "Artifact Search",
    // 2026-11-15: 큰 출력 검색 때만 쓰므로 xd:// 장치로 내린다(doc/history/2026/11/15-startup-context-cut).
    loadMode: "discoverable" as const,
    approval: "read" as const,
    description:
      "Linux only. Literal keyword search inside ONE session spill (`local://<id>.log`) or historical artifact (`artifact://<id>`). Not semantic: no model understands the question; it matches whole words (a query word also matches words that start with it), all words must appear in the same excerpt, case-insensitive; Korean works by whole word or word start, with no morphology. "
      + "Returns ranked excerpts with line numbers and ready `read` locators. Excerpts only help you find where to look: read the original with the returned locator before citing it as evidence or editing from it. "
      + "No match does NOT prove the text is absent; page the original with the native `read` tool (for example `local://0.log:-100`). Line numbers are artifact output lines, not line annotations of an original source file that may appear inside the text. "
      + "Searches only this session's artifacts (a Maker shares its parent's ids), builds an in-memory index on first use, never changes the artifact, and refuses artifacts over 32 MiB. Use `limit`/`offset` to page results.",
    parameters: z.object({
      path: z.string().describe("Exactly `local://<numeric id>.log` or `artifact://<numeric id>`; no selectors, files, or other URLs"),
      query: z.string().describe("Literal words to look for, e.g. an error code or exception name. Punctuation is ignored; it is not a boolean or regex query"),
      limit: z.number().optional().describe(`Ranges to return, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT})`),
      offset: z.number().optional().describe("Ranges to skip, for paging (default 0)"),
    }),

    async execute(_toolCallId: string, params: SearchParams, _onUpdate: unknown, ctx: CustomToolContext, signal?: AbortSignal) {
      const generation = store.generation; // before any await: lifecycle events during admission must reach this request
      const sourcePath = String(params.path ?? "");
      const target = parseArtifactPath(sourcePath);
      const linux = process.platform === "linux";
      if (!target) {
        const platformNote = linux ? "" : " artifact_search ranked search requires Linux.";
        throw new Error(`path must be exactly local://<numeric id>.log or artifact://<numeric id>; got: ${JSON.stringify(sourcePath)}. No selectors, queries, files, or other URLs are accepted.${platformNote}`);
      }
      if (!linux) {
        throw new Error(`artifact_search ranked search requires Linux to verify opened spill files. Use native read with ${target.url}:1-200 or ${target.url}:-100 where available.`);
      }
      const plan = planQuery(String(params.query ?? ""));
      const limit = integerParam("limit", params.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
      const offset = integerParam("offset", params.offset, 0, 1_000_000, 0);
      if (signal?.aborted) throw abortReason(signal);
      const manager = ctx.sessionManager.getArtifactManager();
      if (!manager) throw new Error("This session has no artifact store, so artifact_search has nothing to search.");

      const src = await openArtifact(manager, target);
      const { entry, release, cold } = await store.acquire(src, signal, generation);
      try {
        // acquire() still awaits closing the admitted handle after its own checks; recheck before touching the index.
        if (signal?.aborted) throw abortReason(signal);
        if (generation !== store.generation) throw new Error(SESSION_CHANGED);
        const searchStarted = performance.now();
        const run = (joiner: " AND " | " OR "): { total: number; rows: ChunkRow[] } => {
          const expression = matchExpression(plan.units, joiner);
          const total = (entry.db.query("SELECT count(*) AS n FROM chunks WHERE chunks MATCH ?").get(expression) as { n: number }).n;
          const rows = entry.db
            .query("SELECT text, start_line, end_line, char_start FROM chunks WHERE chunks MATCH ? ORDER BY rank, rowid LIMIT ? OFFSET ?")
            .all(expression, limit, offset) as ChunkRow[];
          return { total, rows };
        };
        let mode: "and" | "or" = "and";
        let result = run(" AND ");
        if (result.total === 0 && plan.units.length > 1) {
          result = run(" OR ");
          mode = "or";
        }
        const searchMs = Math.round((performance.now() - searchStarted) * 10) / 10;

        const header = [
          `artifact_search ${src.url}: literal word search (not semantic), ${entry.lines} lines, ${bytesLabel(entry.bytes)}. Index ${cold ? `built now in ${entry.indexMs} ms` : "reused from this session's cache"}.`,
          "Excerpts are for discovery only: read the original with the read locator before treating anything here as evidence or editing from it. Line numbers are artifact output lines, not original source-file line annotations inside the text.",
        ];
        const lines = [...header];
        let shown = 0;
        let nextOffset: number | null = null;
        if (result.total === 0) {
          lines.push(
            `No match for ${plan.units.map((u) => JSON.stringify(u)).join(", ")}. This does not prove the text is absent: only whole words or word starts are matched. Try other spellings or word forms, or page the original: ${src.url}:1-200 or ${src.url}:-100.`,
          );
        } else if (offset >= result.total) {
          lines.push(`offset ${offset} is past the ${result.total} matching ranges; use offset 0..${result.total - 1}.`);
        } else {
          lines.push(
            mode === "and"
              ? `${result.total} matching range(s) contain all of: ${plan.units.map((u) => JSON.stringify(u)).join(", ")}. Showing from ${offset + 1}:`
              : `No range contains all words; showing ranges that contain ANY of: ${plan.units.map((u) => JSON.stringify(u)).join(", ")} (${result.total} found). Showing from ${offset + 1}:`,
          );
          let used = lines.join("\n").length;
          for (const row of result.rows) {
            const block = formatRange(src.url, row, plan.unitTokens, entry.lines, offset + shown + 1);
            if (shown > 0 && used + block.length > MAX_OUTPUT_CHARS) break;
            lines.push(block);
            used += block.length + 1;
            shown++;
          }
          const consumed = offset + shown;
          if (consumed < result.total) {
            nextOffset = consumed;
            lines.push(`More: ${result.total - consumed} range(s) not shown. Call again with offset ${consumed}.`);
          }
        }
        const details: ArtifactSearchDetails = {
          artifact: src.url,
          query: params.query,
          mode,
          total: result.total,
          shown,
          offset,
          nextOffset,
          lines: entry.lines,
          bytes: entry.bytes,
          cache: cold ? "cold" : "warm",
          indexMs: cold ? entry.indexMs : 0,
          searchMs,
        };
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
      } finally {
        release();
      }
    },

    onSession(event: { reason: string }) {
      if (SESSION_EVENTS.has(event.reason)) store.invalidate(`artifact_search index discarded: session ${event.reason}`);
    },
  };
}

const factory: CustomToolFactory = (pi) => createArtifactSearchTool(pi);

export default factory;
