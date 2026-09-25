export const SIDE_CHAT_ENDPOINT = "/api/sidecars/sidechat/ask";
export const SIDE_CHAT_HISTORY_LIMIT = 6;
export const SIDE_CHAT_SESSION_LIMIT = 20;
export const SIDE_CHAT_TURN_LIMIT = 40;
export const SIDE_CHAT_CHAR_LIMIT = 120_000;
export const SIDE_CHAT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const SIDE_CHAT_LOG_PREFIX = "omp-btw-log:";
export const SIDE_CHAT_INDEX_KEY = "omp-btw-log-index";

export interface SideChatTurn {
  q: string;
  a: string;
  at: number;
}

export interface SideChatHistoryTurn {
  q: string;
  a: string;
}

export interface SideChatParentSession {
  id: string;
  modified: string | number;
}

export interface SideChatSessionCensus {
  sessions: readonly SideChatParentSession[];
  complete: boolean;
}

export interface SideChatStorage {
  readonly length?: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key?(index: number): string | null;
}

export interface SideChatHistoryStore {
  read(sessionId: string): SideChatTurn[];
  append(sessionId: string, turn: SideChatTurn): SideChatTurn[];
  history(sessionId: string, limit?: number): SideChatHistoryTurn[];
  clear(sessionId: string): void;
  cleanup(census: SideChatSessionCensus, currentSessionId?: string | null): void;
}

export interface SideChatStoreOptions {
  now?: () => number;
}

type SideChatIndexEntry = {
  id: string;
  updatedAt: number;
};

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim().toLowerCase();
}

function copyTurns(turns: readonly SideChatTurn[]): SideChatTurn[] {
  return turns.map((turn) => ({ q: turn.q, a: turn.a, at: turn.at }));
}

function pruneTurns(value: unknown): SideChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: SideChatTurn[] = [];
  let chars = 0;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const turn = candidate as Partial<SideChatTurn>;
    if (typeof turn.q !== "string" || typeof turn.a !== "string") continue;
    const normalized = {
      q: turn.q,
      a: turn.a,
      at: typeof turn.at === "number" && Number.isFinite(turn.at) ? turn.at : 0,
    };
    turns.push(normalized);
    chars += normalized.q.length + normalized.a.length;
  }
  while (turns.length > SIDE_CHAT_TURN_LIMIT || chars > SIDE_CHAT_CHAR_LIMIT) {
    const removed = turns.shift();
    if (!removed) break;
    chars -= removed.q.length + removed.a.length;
  }
  return turns;
}

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; code?: number };
  return value.name === "QuotaExceededError" || value.code === 22 || value.code === 1014;
}

export function createSideChatHistoryStore(
  storage: SideChatStorage | null,
  options: SideChatStoreOptions = {},
): SideChatHistoryStore {
  const now = options.now ?? Date.now;
  const memoryLogs = new Map<string, SideChatTurn[]>();
  const dirtyLogs = new Set<string>();
  let indexLoaded = false;
  let index: SideChatIndexEntry[] = [];

  const removeStorageKey = (key: string) => {
    if (!storage) return;
    try {
      storage.removeItem(key);
    } catch {
      // 메모리 사본은 이미 정리되어 있으므로 저장소 실패를 전파하지 않는다.
    }
  };

  const dropIndexedLog = (sessionId: string) => {
    memoryLogs.delete(sessionId);
    dirtyLogs.delete(sessionId);
    removeStorageKey(SIDE_CHAT_LOG_PREFIX + sessionId);
  };

  const pruneIndex = () => {
    const seen = new Set<string>();
    const kept: SideChatIndexEntry[] = [];
    index.sort((left, right) => right.updatedAt - left.updatedAt);
    for (const entry of index) {
      if (!entry.id || seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (kept.length < SIDE_CHAT_SESSION_LIMIT) kept.push(entry);
      else dropIndexedLog(entry.id);
    }
    index = kept;
  };

  const ensureIndex = () => {
    if (indexLoaded) return;
    indexLoaded = true;
    if (storage) {
      try {
        const raw = storage.getItem(SIDE_CHAT_INDEX_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
          index = parsed.flatMap((candidate): SideChatIndexEntry[] => {
            if (!candidate || typeof candidate !== "object") return [];
            const entry = candidate as Partial<SideChatIndexEntry>;
            if (typeof entry.id !== "string" || !entry.id) return [];
            return [{
              id: normalizeSessionId(entry.id),
              updatedAt: typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
                ? entry.updatedAt
                : 0,
            }];
          });
        }
      } catch {
        index = [];
      }
    }
    pruneIndex();
  };

  const evictOldest = (protectedId: string | null): boolean => {
    ensureIndex();
    for (let position = index.length - 1; position >= 0; position -= 1) {
      if (index[position].id === protectedId) continue;
      const [evicted] = index.splice(position, 1);
      dropIndexedLog(evicted.id);
      return true;
    }
    return false;
  };

  const persistIndex = (protectedId: string | null) => {
    if (!storage) return;
    try {
      storage.setItem(SIDE_CHAT_INDEX_KEY, JSON.stringify(index));
      return;
    } catch (error) {
      if (!isQuotaError(error) || !evictOldest(protectedId)) return;
    }
    try {
      storage.setItem(SIDE_CHAT_INDEX_KEY, JSON.stringify(index));
    } catch {
      // 저장소가 가득 찬 동안에도 메모리 인덱스로 계속 동작한다.
    }
  };

  const touchIndex = (sessionId: string, updatedAt: number) => {
    ensureIndex();
    index = index.filter((entry) => entry.id !== sessionId);
    index.unshift({ id: sessionId, updatedAt });
    pruneIndex();
    persistIndex(sessionId);
  };

  const read = (rawSessionId: string): SideChatTurn[] => {
    const sessionId = normalizeSessionId(rawSessionId);
    if (!sessionId) return [];
    if (dirtyLogs.has(sessionId)) return copyTurns(memoryLogs.get(sessionId) ?? []);
    if (storage) {
      try {
        const raw = storage.getItem(SIDE_CHAT_LOG_PREFIX + sessionId);
        if (raw) {
          const parsed = JSON.parse(raw) as { entries?: unknown };
          const turns = pruneTurns(parsed?.entries);
          memoryLogs.set(sessionId, turns);
          return copyTurns(turns);
        }
      } catch {
        // 저장소 대신 아래 메모리 사본을 사용한다.
      }
    }
    return copyTurns(memoryLogs.get(sessionId) ?? []);
  };

  const save = (rawSessionId: string, candidateTurns: readonly SideChatTurn[]): SideChatTurn[] => {
    const sessionId = normalizeSessionId(rawSessionId);
    if (!sessionId) return [];
    const saved = pruneTurns(candidateTurns);
    const updatedAt = now();
    memoryLogs.set(sessionId, copyTurns(saved));
    touchIndex(sessionId, updatedAt);
    if (!storage) return copyTurns(saved);

    const payload = JSON.stringify({ updatedAt, entries: saved });
    try {
      storage.setItem(SIDE_CHAT_LOG_PREFIX + sessionId, payload);
      dirtyLogs.delete(sessionId);
      return copyTurns(saved);
    } catch (error) {
      if (!isQuotaError(error) || !evictOldest(sessionId)) {
        dirtyLogs.add(sessionId);
        return copyTurns(saved);
      }
    }

    persistIndex(sessionId);
    try {
      storage.setItem(SIDE_CHAT_LOG_PREFIX + sessionId, payload);
      dirtyLogs.delete(sessionId);
    } catch {
      dirtyLogs.add(sessionId);
    }
    return copyTurns(saved);
  };

  const clear = (rawSessionId: string) => {
    const sessionId = normalizeSessionId(rawSessionId);
    if (!sessionId) return;
    ensureIndex();
    index = index.filter((entry) => entry.id !== sessionId);
    dropIndexedLog(sessionId);
    persistIndex(null);
  };

  const cleanup = (census: SideChatSessionCensus, currentSessionId?: string | null) => {
    if (!census.complete) return;
    ensureIndex();
    const live = new Map<string, number>();
    for (const session of census.sessions) {
      if (!session || typeof session.id !== "string" || !session.id) continue;
      const id = normalizeSessionId(session.id);
      const modified = typeof session.modified === "number"
        ? session.modified
        : Date.parse(session.modified);
      live.set(id, Number.isFinite(modified) ? modified : 0);
    }

    const protectedId = currentSessionId ? normalizeSessionId(currentSessionId) : null;
    const currentTime = now();
    for (const entry of [...index]) {
      // 지금 열려 있는 세션은 census에 아직 없을 수 있다(새로 만든 세션, 아직 갱신되지 않은 목록).
      // protected 검사가 census 누락 삭제보다 뒤에 있으면 복원해 둔 이력이 그대로 사라진다.
      if (entry.id === protectedId) continue;
      if (!live.has(entry.id)) {
        clear(entry.id);
        continue;
      }
      const lastTouched = Math.max(live.get(entry.id) ?? 0, entry.updatedAt);
      if (currentTime - lastTouched > SIDE_CHAT_MAX_AGE_MS) clear(entry.id);
    }

    if (!storage || typeof storage.key !== "function" || typeof storage.length !== "number") return;
    const orphanKeys: string[] = [];
    try {
      for (let position = 0; position < storage.length; position += 1) {
        const key = storage.key(position);
        if (!key?.startsWith(SIDE_CHAT_LOG_PREFIX)) continue;
        const id = normalizeSessionId(key.slice(SIDE_CHAT_LOG_PREFIX.length));
        if (!live.has(id) && id !== protectedId) orphanKeys.push(key);
      }
    } catch {
      return;
    }
    for (const key of orphanKeys) removeStorageKey(key);
  };

  return {
    read,
    append(sessionId, turn) {
      return save(sessionId, [...read(sessionId), turn]);
    },
    history(sessionId, limit = SIDE_CHAT_HISTORY_LIMIT) {
      return read(sessionId)
        .slice(-Math.max(0, limit))
        .map(({ q, a }) => ({ q, a }));
    },
    clear,
    cleanup,
  };
}

export interface SideChatFlightSnapshot {
  sessionId: string;
  question: string;
  text: string;
  model: string | null;
}

export interface SideChatFlightRegistry {
  /** Currently streaming flight, or null. The snapshot is a copy. */
  read(sessionId: string): SideChatFlightSnapshot | null;
  /**
   * Registers a new flight. Returns null when one is already streaming for
   * this session, so a remounted panel turns submit into abort instead of a
   * duplicate request.
   */
  begin(sessionId: string, question: string): { controller: AbortController } | null;
  ingest(sessionId: string, event: SideChatStreamEvent): void;
  abort(sessionId: string): boolean;
  /**
   * Ends the flight and records how it ended. The outcome stays until a
   * mounted panel consumes it, so close/reopen or reparenting never drops
   * the abort notice, the error entry, the failed-question restore, or the
   * finished model label.
   */
  finish(sessionId: string, outcome: SideChatFlightOutcome): void;
  /** Takes the pending terminal outcome once, or null. */
  takeOutcome(sessionId: string): SideChatFlightOutcome | null;
  subscribe(sessionId: string, listener: () => void): () => void;
}

export type SideChatFlightOutcome =
  | { kind: "done"; model: string | null }
  | { kind: "aborted"; saved: boolean }
  | { kind: "failed"; question: string; partialAnswer: string; errorKind: SideChatErrorKind | "unknown"; errorMessage: string };

/**
 * Owns in-flight /btw requests above the panel: the deck unmounts its tabs
 * on close and across responsive moves, but this registry (kept at AppShell
 * level) keeps the AbortController and the streamed text, so a reopened
 * panel reattaches to progress display, abort, and duplicate-send blocking
 * instead of losing them.
 */
export function createSideChatFlightRegistry(): SideChatFlightRegistry {
  const flights = new Map<string, { snapshot: SideChatFlightSnapshot; controller: AbortController }>();
  const outcomes = new Map<string, SideChatFlightOutcome>();
  const listeners = new Map<string, Set<() => void>>();
  const emit = (sessionId: string) => {
    listeners.get(sessionId)?.forEach((listener) => {
      listener();
    });
  };
  return {
    read(sessionId) {
      const flight = flights.get(sessionId);
      return flight ? { ...flight.snapshot } : null;
    },
    begin(sessionId, question) {
      if (flights.has(sessionId)) return null;
      const controller = new AbortController();
      flights.set(sessionId, { snapshot: { sessionId, question, text: "", model: null }, controller });
      emit(sessionId);
      return { controller };
    },
    ingest(sessionId, event) {
      const flight = flights.get(sessionId);
      if (!flight) return;
      if (event.t === "d") flight.snapshot.text += event.v;
      else if (event.t === "done") flight.snapshot.text = event.v || flight.snapshot.text;
      else if (event.t === "m") flight.snapshot.model = event.v;
      emit(sessionId);
    },
    abort(sessionId) {
      const flight = flights.get(sessionId);
      if (!flight) return false;
      flight.controller.abort();
      return true;
    },
    finish(sessionId, outcome) {
      if (!flights.has(sessionId)) return;
      flights.delete(sessionId);
      outcomes.set(sessionId, outcome);
      emit(sessionId);
    },
    takeOutcome(sessionId) {
      const outcome = outcomes.get(sessionId) ?? null;
      if (outcome) outcomes.delete(sessionId);
      return outcome;
    },
    subscribe(sessionId, listener) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(sessionId);
      };
    },
  };
}

export type SideChatStreamEvent =
  | { t: "d"; v: string }
  | { t: "done"; v: string }
  | { t: "m"; v: string }
  | { t: "err"; v: string };

export type SideChatErrorKind = "unreachable" | "http" | "stream" | "server" | "empty";

export class SideChatRequestError extends Error {
  constructor(
    public readonly kind: SideChatErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SideChatRequestError";
  }
}

function parseStreamLine(line: string): SideChatStreamEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new SideChatRequestError("stream", "사이드채팅 스트림을 해석할 수 없습니다.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SideChatRequestError("stream", "사이드채팅 스트림 항목이 올바르지 않습니다.");
  }
  const event = parsed as { t?: unknown; v?: unknown };
  if ((event.t !== "d" && event.t !== "done" && event.t !== "m" && event.t !== "err") || typeof event.v !== "string") {
    throw new SideChatRequestError("stream", "사이드채팅 스트림 항목이 올바르지 않습니다.");
  }
  return { t: event.t, v: event.v } as SideChatStreamEvent;
}

export class SideChatNdjsonParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  push(chunk: Uint8Array | string): SideChatStreamEvent[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => line.trim() ? [parseStreamLine(line)] : []);
  }

  finish(): SideChatStreamEvent[] {
    this.buffer += this.decoder.decode();
    const line = this.buffer.trim();
    this.buffer = "";
    return line ? [parseStreamLine(line)] : [];
  }
}

export interface SideChatAskRequest {
  sessionPath: string;
  question: string;
  history: readonly SideChatHistoryTurn[];
  signal?: AbortSignal;
  onEvent?: (event: SideChatStreamEvent) => void;
}

export interface SideChatAskResult {
  text: string;
  model: string | null;
}

export type SideChatFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HanseSideChatClient {
  ask(request: SideChatAskRequest): Promise<SideChatAskResult>;
}

async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    // JSON 오류 본문이 아니면 원문을 사용한다.
  }
  return text;
}

export function createHanseSideChatClient(
  fetchImpl: SideChatFetch = (input, init) => fetch(input, init),
  endpoint = SIDE_CHAT_ENDPOINT,
): HanseSideChatClient {
  return {
    async ask(request) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionPath: request.sessionPath,
            question: request.question,
            history: request.history.slice(-SIDE_CHAT_HISTORY_LIMIT),
          }),
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        throw new SideChatRequestError("unreachable", "사이드채팅 사이드카(30143)에 연결할 수 없습니다.");
      }
      if (!response.ok) {
        throw new SideChatRequestError("http", await responseErrorMessage(response), response.status);
      }
      if (!response.body) {
        throw new SideChatRequestError("stream", "사이드채팅 스트림을 열 수 없습니다.");
      }

      const reader = response.body.getReader();
      const parser = new SideChatNdjsonParser();
      let text = "";
      let model: string | null = null;
      const consume = (events: readonly SideChatStreamEvent[]) => {
        for (const event of events) {
          request.onEvent?.(event);
          if (event.t === "d") text += event.v;
          else if (event.t === "done") text = event.v || text;
          else if (event.t === "m") model = event.v;
          else throw new SideChatRequestError("server", event.v);
        }
      };

      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          consume(parser.push(chunk.value));
        }
        consume(parser.finish());
      } catch (error) {
        if (request.signal?.aborted || error instanceof SideChatRequestError) throw error;
        throw new SideChatRequestError(
          "stream",
          error instanceof Error ? error.message : "사이드채팅 스트림이 중단되었습니다.",
        );
      } finally {
        reader.releaseLock();
      }

      if (!text) throw new SideChatRequestError("empty", "사이드채팅이 빈 응답을 반환했습니다.");
      return { text, model };
    },
  };
}
