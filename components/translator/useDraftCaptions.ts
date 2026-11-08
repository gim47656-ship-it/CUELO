"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyInputDelta,
  applyOutputDelta,
  emptyDraftState,
  needsTick,
  reconcileDrafts,
  type DraftPair,
  type DraftState,
} from "@/lib/translator-draft";
import { openDraftSession, type DraftSession } from "./draft-session";
import type { TranscriptSegment } from "./transcript-log";

/** How often drafts are checked for expiry, and held output for release, while either exists. */
const EXPIRY_CHECK_MS = 250;

interface DraftCaptionsOptions {
  /** The setting is on and a call is open or opening. Off closes the sessions and drops every draft. */
  enabled: boolean;
  /** Changes with every new call and reconnect: the sessions and drafts start over. */
  epoch: number;
  /** The language pair of the call that is open; read when a session opens. */
  pairRef: { current: DraftPair };
  segments: TranscriptSegment[];
  /** The track the call sends (denoised or raw); the drafts hear the same audio. */
  sendTrack: MediaStreamTrack | null;
  /** True while the echo guard silences the microphone. */
  isBlocked: () => boolean;
  onBlockedChange: (listener: (blocked: boolean) => void) => () => void;
}

export interface DraftCaptions {
  state: DraftState;
  /** Drop every draft (the clear button). */
  reset: () => void;
  /**
   * Hand the new transcript segments over in the same event that stores them, so a Codex segment and
   * the draft it takes over change in one render (no frame shows both).
   */
  reconcile: (segments: TranscriptSegment[]) => void;
}

/**
 * Quick draft captions: runs the two dedicated translation sessions while `enabled` and keeps the
 * draft state (`lib/translator-draft.ts`). Nothing here reaches the Codex call or the history.
 */
export function useDraftCaptions({ enabled, epoch, pairRef, segments, sendTrack, isBlocked, onBlockedChange }: DraftCaptionsOptions): DraftCaptions {
  const [state, setState] = useState<DraftState>(() => emptyDraftState());
  const stateRef = useRef(state);
  const segmentsRef = useRef(segments);
  const trackRef = useRef(sendTrack);
  const blockedRef = useRef(isBlocked);
  const blockedChangeRef = useRef(onBlockedChange);
  const sessionRef = useRef<DraftSession | null>(null);
  const enabledRef = useRef(enabled);

  const commit = useCallback((next: DraftState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    segmentsRef.current = segments;
    trackRef.current = sendTrack;
    blockedRef.current = isBlocked;
    blockedChangeRef.current = onBlockedChange;
    enabledRef.current = enabled;
  });

  const reconcile = useCallback((next: TranscriptSegment[]) => {
    if (enabledRef.current) commit(reconcileDrafts(stateRef.current, next, performance.now()));
  }, [commit]);

  const reset = useCallback(() => {
    commit(emptyDraftState([], stateRef.current));
  }, [commit]);

  useEffect(() => {
    commit(emptyDraftState(segmentsRef.current, stateRef.current));
    if (!enabled) return;
    const pair = pairRef.current;
    const session = openDraftSession({
      mine: pair.mine,
      theirs: pair.theirs,
      isBlocked: () => blockedRef.current(),
      onBlockedChange: (listener) => blockedChangeRef.current(listener),
      onInput: (language, delta) => commit(applyInputDelta(stateRef.current, pair, language, delta, performance.now())),
      onOutput: (language, delta) => commit(applyOutputDelta(stateRef.current, pair, language, delta, performance.now())),
    });
    sessionRef.current = session;
    session.setTrack(trackRef.current);
    return () => {
      session.close();
      sessionRef.current = null;
      commit(emptyDraftState(segmentsRef.current, stateRef.current));
    };
    // `epoch` restarts the sessions for a new call or reconnect; the pair is read at that moment.
  }, [commit, enabled, epoch, pairRef]);

  useEffect(() => {
    sessionRef.current?.setTrack(sendTrack);
  }, [sendTrack]);

  const pending = needsTick(state);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => commit(reconcileDrafts(stateRef.current, segmentsRef.current, performance.now())), EXPIRY_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [commit, pending]);

  return { state, reset, reconcile };
}
