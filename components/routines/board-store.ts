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
