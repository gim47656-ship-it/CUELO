"use client";

import { useSyncExternalStore } from "react";
import type { RoutineSyncState } from "@/lib/routines/git-sync";
import type { RoutineLastRun } from "@/lib/routines/state";
import type { Routine, RoutinePostSummary } from "@/lib/routines/store";
import { NEW_POST_MS, parsePostKey, postFileStartedAt } from "@/lib/routines/post-key";

/**
 * 루틴 화면(가운데)과 사이드바 루틴 목록이 함께 보는 상태. 이 탭 안에 하나만 있고, 서버 목록(`/api/routines`)과
 * 지금 보고 있는 화면(갤러리 목록, 게시판, 글, 설정)을 들고 있다.
 */

export interface BoardRoutine extends Routine {
  running: boolean;
  /** 켜진 루틴의 다음 회차(ISO). */
  nextRunAt: string | null;
  /** 이 PC에서 마지막으로 끝난 실행. */
  lastRun: RoutineLastRun | null;
  posts: RoutinePostSummary[];
}

export interface BoardData {
  setup: { reason: "missing" | "not-git"; dir: string } | null;
  thisHost: string;
  hosts: string[];
  sync: RoutineSyncState;
  routines: BoardRoutine[];
  /** 모든 PC의 읽음 기록 합집합(최근 키만). 서버가 아직 올리지 못한 이 서버의 읽음도 들어 있다. */
  readPosts: string[];
}

export type BoardScreen =
  | { kind: "gallery" }
  | { kind: "board"; id: string }
  | { kind: "post"; id: string; file: string }
  | { kind: "form"; id: string | null };

interface BoardState {
  data: BoardData | null;
  loadError: string | null;
  screen: BoardScreen;
}

let state: BoardState = { data: null, loadError: null, screen: { kind: "gallery" } };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function update(patch: Partial<BoardState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export async function readApiError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `${res.status} ${res.statusText}`;
}

export function refreshRoutineBoard(): Promise<void> {
  inflight ??= (async () => {
    try {
      const res = await fetch("/api/routines", { cache: "no-store" });
      if (!res.ok) throw new Error(await readApiError(res));
      const next = await res.json() as BoardData;
      applyServerReads(next.readPosts ?? []);
      update({ data: next, loadError: null });
      if (!next.setup) shareLocalReads();
    } catch (error) {
      update({ loadError: error instanceof Error ? error.message : String(error) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function showRoutineScreen(screen: BoardScreen): void {
  update({ screen });
}

export function useRoutineBoard(): BoardState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

/**
 * 열어 본 글(`<루틴 id>/<파일>`). 이 브라우저의 localStorage에 남겨 바로 반영하고, 서버에도 알려 저장소의 PC별 읽음 파일
 * (`reads/<PC>.json`)로 모은다. 서버가 돌려주는 모든 PC의 합집합(`serverReads`)과 이 브라우저 기록을 합쳐, 최근 7일 안에
 * 올라왔고 어디서도 열지 않은 글만 「새 글」로 보인다. 오래된 기록부터 지워 READ_LIMIT개까지만 둔다.
 *
 * localStorage의 읽고-고쳐-쓰기는 탭끼리 원자적이지 않아, 쓰기는 Web Locks(`navigator.locks`)로 탭 사이에 한 줄로 세운다:
 * 잠금 안에서 저장된 목록을 다시 읽고 붙여 쓰므로 다른 탭의 기록을 덮지 않는다. 잠금이 없는 환경(보안 연결이 아닌 http)은
 * 바로 쓴다. 저장하지 못한 기록(`localOnly`)은 이 탭 화면에만 둔다.
 */
const READ_KEY = "cuelo-routine-read-posts";
const READ_LIMIT = 2000;
const NO_READS: ReadonlySet<string> = new Set();
let serverReads: ReadonlySet<string> = NO_READS;
/**
 * 이 탭이 서버에 보낸 키와 보낸 시각. 같은 키를 목록을 받을 때마다 보내지 않되, 서버 합집합(메모리에 모은 키 포함)에
 * 보낸 지 `RESEND_MS`가 지나도 없으면 서버가 재시작 등으로 잃은 것이므로 다시 보낸다.
 */
const sentReads = new Map<string, number>();
const RESEND_MS = 2 * 60_000;
let readPosts: ReadonlySet<string> | null = null;
const localOnly = new Set<string>();
const readListeners = new Set<() => void>();

function storedReadPosts(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(READ_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function loadReadPosts(): ReadonlySet<string> {
  readPosts ??= new Set([...storedReadPosts(), ...localOnly, ...serverReads]);
  return readPosts;
}

function reloadReadPosts(): void {
  readPosts = null;
  for (const listener of readListeners) listener();
}

function persistReadPosts(keys: readonly string[]): void {
  const stored = storedReadPosts();
  const known = new Set(stored);
  const added = keys.filter((key) => !known.has(key));
  try {
    if (added.length) localStorage.setItem(READ_KEY, JSON.stringify([...stored, ...added].slice(-READ_LIMIT)));
    for (const key of keys) localOnly.delete(key);
  } catch {
    // 저장소가 막힌 브라우저에서는 이 탭에서만 읽음으로 둔다.
  }
  reloadReadPosts();
}

/** 읽음으로 바꿀 키들을 화면에 바로 반영하고, 탭 사이 잠금 안에서 한 번에 저장한 뒤 서버에 알린다. */
function markKeysRead(keys: string[]): void {
  for (const key of keys) localOnly.add(key);
  reloadReadPosts();
  if (typeof navigator !== "undefined" && navigator.locks) void navigator.locks.request(READ_KEY, () => persistReadPosts(keys));
  else persistReadPosts(keys);
  shareReads(keys);
}

const SHARE_BATCH = 500;

/** 서버가 돌려준 모든 PC의 읽음 합집합을 반영한다. 내용이 같으면 화면을 다시 그리지 않는다. */
function applyServerReads(keys: string[]): void {
  const next = new Set(keys);
  if (next.size === serverReads.size && keys.every((key) => serverReads.has(key))) return;
  serverReads = next;
  reloadReadPosts();
}

/** 읽음 키를 서버로 보낸다. 실패하면 보냄 기록을 지워 다음 목록 받기 때 다시 보낸다. */
function shareReads(keys: string[]): void {
  const now = Date.now();
  const fresh = keys.filter((key) => now - (sentReads.get(key) ?? -Infinity) >= RESEND_MS);
  for (let i = 0; i < fresh.length; i += SHARE_BATCH) {
    const batch = fresh.slice(i, i + SHARE_BATCH);
    for (const key of batch) sentReads.set(key, now);
    void fetch("/api/routines/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: batch }) })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
      })
      .catch(() => {
        for (const key of batch) sentReads.delete(key);
      });
  }
}

/**
 * 이 브라우저에 읽음으로 남았지만 서버 합집합에 없고 아직 「새 글」 기간 안인 키를 서버로 올린다. 이전에 열어 둔 글과
 * 서버가 다시 켜지며 잃은 읽음이 다른 PC로도 저절로 퍼진다.
 */
function shareLocalReads(): void {
  const now = Date.now();
  const keys = [...new Set([...storedReadPosts(), ...localOnly])].filter((key) => {
    const parsed = parsePostKey(key);
    const at = parsed ? postFileStartedAt(parsed.file) : null;
    return at !== null && now - at < NEW_POST_MS && !serverReads.has(key);
  });
  shareReads(keys);
}

export function markRoutinePostRead(routineId: string, file: string): void {
  const key = `${routineId}/${file}`;
  if (loadReadPosts().has(key)) return;
  markKeysRead([key]);
}

/**
 * 「전체 읽음 표시」: 주어진 루틴들(게시판 전체, 또는 게시판 안의 루틴 하나)에서 지금 새 글인 것을 한 번에 읽음으로 한다.
 * 저장소는 한 번 쓰고, 화면은 한 번 다시 그리고, 서버에는 SHARE_BATCH개씩 나눠 보낸다. 읽음으로 바꾼 글 수를 돌려준다.
 */
export function markAllRoutinePostsRead(routines: readonly Pick<BoardRoutine, "id" | "posts">[], now = Date.now()): number {
  const read = loadReadPosts();
  const keys = routines.flatMap((routine) => routine.posts
    .filter((post) => isNewRoutinePost(routine.id, post, read, now))
    .map((post) => `${routine.id}/${post.file}`));
  if (keys.length) markKeysRead(keys);
  return keys.length;
}

/** 다른 탭이 목록을 쓰거나 저장소를 비우면 다시 읽는다. 아직 저장하지 못한 이 탭의 기록은 그대로 더해 보인다. */
function onReadPostsStorage(event: StorageEvent): void {
  if (event.key === READ_KEY || event.key === null) reloadReadPosts();
}

export function useReadRoutinePosts(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      if (readListeners.size === 0) window.addEventListener("storage", onReadPostsStorage);
      readListeners.add(listener);
      return () => {
        readListeners.delete(listener);
        if (readListeners.size === 0) window.removeEventListener("storage", onReadPostsStorage);
      };
    },
    loadReadPosts,
    () => NO_READS,
  );
}

export function isNewRoutinePost(routineId: string, post: RoutinePostSummary, read: ReadonlySet<string>, now = Date.now()): boolean {
  const at = Date.parse(post.startedAt);
  return !read.has(`${routineId}/${post.file}`) && Number.isFinite(at) && now - at < NEW_POST_MS;
}
