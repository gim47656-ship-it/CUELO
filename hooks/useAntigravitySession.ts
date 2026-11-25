"use client";

import { useEffect, useState } from "react";
import type { AttachedImage } from "@/components/ChatInput";
import type { AttachedDocument } from "@/lib/document-attachments";
import type { ChatDraft, SubmissionOutcome } from "@/lib/draft-store";
import { applyAntigravityEvent, type AntigravityEvent, type AntigravityProblem, type AntigravitySessionInfo, type AntigravityState } from "@/lib/antigravity/types";

export const ANTIGRAVITY_API = "/api/antigravity";
export type BrowserProblem = AntigravityProblem;
export const connectionLost: BrowserProblem = { code: "disconnected", error: "Antigravity connection closed." };

export async function antigravityFetch<T>(url: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json() as T | BrowserProblem;
  if (!response.ok) throw data;
  return data as T;
}

export function browserProblem(error: unknown): BrowserProblem {
  return error && typeof error === "object" && "code" in error && "error" in error ? error as BrowserProblem : connectionLost;
}

interface UnfinishedSubmission {
  submissionId: string;
  serverId: string;
  draft: ChatDraft;
}

function readUnfinished(key: string): UnfinishedSubmission | null {
  try { return JSON.parse(sessionStorage.getItem(key) ?? "null") as UnfinishedSubmission | null; }
  catch { return null; }
}

function writeUnfinished(key: string, pending: UnfinishedSubmission | null) {
  try {
    if (!pending) sessionStorage.removeItem(key);
    else {
      try { sessionStorage.setItem(key, JSON.stringify(pending)); }
      catch {
        // The browser may reject large image data. Keep the restart marker and
        // use the replayed ACP user message to reconstruct missing attachments.
        sessionStorage.setItem(key, JSON.stringify({ ...pending, draft: { ...pending.draft, images: [] } }));
      }
    }
  } catch { /* Browser storage may be unavailable. */ }
}

export function useAntigravitySession(session: AntigravitySessionInfo, streamRevision: number) {
  const { sessionId, cwd } = session;
  const params = new URLSearchParams({ sessionId, cwd });
  const key = `cuelo-antigravity-unfinished:${cwd}:${sessionId}`;
  const [state, setState] = useState<AntigravityState | null>(null);
  const [streamProblem, setStreamProblem] = useState<BrowserProblem | null>(null);
  const [actionError, setActionProblem] = useState<{ revision: number; issue: BrowserProblem } | null>(null);
  const actionProblem = actionError?.revision === streamRevision ? actionError.issue : null;
  const [recovery, setRecovery] = useState<UnfinishedSubmission | null>(null);
  const [switching, setSwitching] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  useEffect(() => {
    const query = new URLSearchParams({ sessionId, cwd });
    const events = new EventSource(`${ANTIGRAVITY_API}/events?${query}`);
    let terminal = false;
    const onEvent = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as AntigravityEvent;
      if ("snapshot" in event) {
        const pending = readUnfinished(key);
        if (pending?.submissionId === event.snapshot.settledSubmissionId) writeUnfinished(key, null);
        setRecovery(pending && pending.submissionId !== event.snapshot.settledSubmissionId && !event.snapshot.streaming ? pending : null);
        setStreamProblem(null);
        setActionProblem(null);
        setState(event.snapshot);
      } else {
        if ("state" in event) {
          if (event.state.settledSubmissionId && readUnfinished(key)?.submissionId === event.state.settledSubmissionId) {
            writeUnfinished(key, null);
            setRecovery(null);
          }
          if (event.state.closed) {
            terminal = true;
            events.close();
            setStreamProblem(event.state.problem ?? connectionLost);
            setRecovery(readUnfinished(key));
          }
        }
        setState((current) => current ? applyAntigravityEvent(current, event) : current);
      }
    };
    events.onmessage = onEvent;
    events.onerror = () => {
      events.close();
      if (terminal) return;
      setStreamProblem(connectionLost);
      setRecovery(readUnfinished(key));
    };
    return () => events.close();
  }, [cwd, sessionId, key, streamRevision]);

  async function send(message: string, images?: AttachedImage[], documents?: AttachedDocument[]): Promise<SubmissionOutcome> {
    if (!state || streamProblem) return "returned";
    const submissionId = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(18)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const draft = { value: message, images: images?.map(({ data, mimeType }) => ({ data, mimeType })) ?? [], documents: documents ?? [] };
    const previous = readUnfinished(key);
    writeUnfinished(key, { submissionId, serverId: state.serverId, draft });
    setActionProblem(null);
    try {
      await antigravityFetch(`${ANTIGRAVITY_API}/send?${params}`, { submissionId, message, images: draft.images, documents });
      setRecovery(null);
      return "accepted";
    } catch (error) {
      const issue = browserProblem(error);
      if (error === issue) writeUnfinished(key, previous);
      setActionProblem({ revision: streamRevision, issue });
      return error === issue ? "returned" : "unknown";
    }
  }

  async function control(body: object) {
    setActionProblem(null);
    try { await antigravityFetch(`${ANTIGRAVITY_API}/control?${params}`, body); }
    catch (error) { setActionProblem({ revision: streamRevision, issue: browserProblem(error) }); }
  }

  return {
    state, streamProblem, actionProblem, switching, deciding, recovery, send,
    cancel: () => control({ action: "cancel" }),
    setOption: async (id: string, value: string) => {
      setSwitching(true);
      try { await control({ action: "option", id, value }); } finally { setSwitching(false); }
    },
    decide: async (id: string, allow: boolean) => {
      setDeciding(id);
      try { await control({ action: "permission", id, allow }); } finally { setDeciding(null); }
    },
    restored: () => { writeUnfinished(key, null); setRecovery(null); },
  };
}
