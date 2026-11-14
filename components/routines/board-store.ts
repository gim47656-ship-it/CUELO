"use client";

import { useSyncExternalStore } from "react";
import type { RoutineSyncState } from "@/lib/routines/git-sync";
import type { RoutineLastRun } from "@/lib/routines/state";
import type { Routine, RoutinePostSummary } from "@/lib/routines/store";

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
      update({ data: await res.json() as BoardData, loadError: null });
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
 * 이 브라우저에서 열어 본 글(`<루틴 id>/<파일>`). 서버에 두지 않으므로 PC나 브라우저마다 따로 센다. 최근 7일 안에 올라와
 * 아직 열어 보지 않은 글을 「새 글」로 보인다. 오래된 기록부터 지워 READ_LIMIT개까지만 둔다.
 *
 * localStorage의 읽고-고쳐-쓰기는 탭끼리 원자적이지 않아, 쓰기는 Web Locks(`navigator.locks`)로 탭 사이에 한 줄로 세운다:
 * 잠금 안에서 저장된 목록을 다시 읽고 붙여 쓰므로 다른 탭의 기록을 덮지 않는다. 잠금이 없는 환경(보안 연결이 아닌 http)은
 * 바로 쓴다. 저장하지 못한 기록(`localOnly`)은 이 탭 화면에만 둔다.
 */
const READ_KEY = "cuelo-routine-read-posts";
const READ_LIMIT = 2000;
const NEW_POST_MS = 7 * 24 * 60 * 60 * 1000;
const NO_READS: ReadonlySet<string> = new Set();
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
  readPosts ??= new Set([...storedReadPosts(), ...localOnly]);
  return readPosts;
}

function reloadReadPosts(): void {
  readPosts = null;
  for (const listener of readListeners) listener();
}

function persistReadPost(key: string): void {
  const stored = storedReadPosts();
  try {
    if (!stored.includes(key)) localStorage.setItem(READ_KEY, JSON.stringify([...stored, key].slice(-READ_LIMIT)));
    localOnly.delete(key);
  } catch {
    // 저장소가 막힌 브라우저에서는 이 탭에서만 읽음으로 둔다.
  }
  reloadReadPosts();
}

export function markRoutinePostRead(routineId: string, file: string): void {
  const key = `${routineId}/${file}`;
  if (loadReadPosts().has(key)) return;
  // 잠금을 기다리는 동안에도 화면에는 바로 읽음으로 보인다.
  localOnly.add(key);
  reloadReadPosts();
  if (typeof navigator !== "undefined" && navigator.locks) void navigator.locks.request(READ_KEY, () => persistReadPost(key));
  else persistReadPost(key);
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
