"use client";

import { useSyncExternalStore } from "react";

/**
 * The latest progress line of each tool call still running, keyed by session id plus toolCallId: providers do not
 * promise globally unique tool-call ids, and several chat windows or a subagent transcript may show the same id.
 * The session hook registers the key when it sees the call start, fills it from `tool_execution_update`, and deletes
 * exactly that key when the call ends, the run stops or the hook unmounts, so a finished card shows its result and
 * never a stale line. ToolCallBlock reads it only while the call has no result and only with its own session id.
 */
const progress = new Map<string, string>();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The store key of one tool call in one session; null when either id is missing, so nothing is read or written. */
export function toolProgressKey(sessionId: string | null | undefined, toolCallId: string | null | undefined): string | null {
  return sessionId && toolCallId ? `${sessionId}\u0000${toolCallId}` : null;
}

export function setToolProgress(key: string, text: string): void {
  if (progress.get(key) === text) return;
  progress.set(key, text);
  emit();
}

export function clearToolProgress(keys: Iterable<string>): void {
  let changed = false;
  for (const key of keys) changed = progress.delete(key) || changed;
  if (changed) emit();
}

export function readToolProgress(key: string | null): string | null {
  return key ? progress.get(key) ?? null : null;
}

/** The progress line for one running call of one session, or null. Pass a null key once the call has a result. */
export function useToolProgress(key: string | null): string | null {
  return useSyncExternalStore(subscribe, () => readToolProgress(key), () => null);
}
