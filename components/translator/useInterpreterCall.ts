"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { failureFromOffer, isLiveState, waitForIceGathering, type LiveFailure } from "@/hooks/useLiveVoice";
import type { LiveState, LiveTranscriptRole } from "@/lib/live-types";
import type { TranslatorLanguage } from "@/lib/translator-languages";

/**
 * 통역 통화의 브라우저 쪽. `hooks/useLiveVoice.ts`와 같은 방식으로 마이크·WebRTC 피어는 화면이,
 * Codex 자격·사이드밴드는 서버가 든다. 다른 점은 세션이 없고(`/api/live/interpret`에 두 언어만
 * 보낸다), 목소리는 늘 Codex 원격 음성 트랙이며, 전사를 끝내는 말로 읽지 않는다는 것이다.
 */

export interface InterpreterTranscript {
  role: LiveTranscriptRole;
  text: string;
  final: boolean;
}

export interface InterpreterCallController {
  state: LiveState;
  failure: LiveFailure | null;
  detail: string | null;
  /** `null` until the browser check ran (server render and first paint). */
  supported: boolean | null;
  /**
   * Open a call for this pair ahead of Start, without the microphone: the peer sends
   * no audio track until `start`. Idempotent for the pair; a failure stays silent and
   * `start` then connects from scratch. The state stays `idle`.
   */
  prepare: (mine: TranslatorLanguage, theirs: TranslatorLanguage) => void;
  /** Start interpreting this pair, reusing a prepared call when it matches. Call it inside the click. */
  start: (mine: TranslatorLanguage, theirs: TranslatorLanguage) => void;
  stop: () => void;
}

const hangUp = (callId: string) => {
  void fetch(`/api/live/call/${encodeURIComponent(callId)}`, { method: "DELETE" }).catch(() => {
    // The call also expires server-side once no reader remains.
  });
};

/**
 * Codex ends a call that carries no speech about 30 s after it answers (measured 32 s and
 * 34 s). A prepared call is hung up a little before that, so Start never lands on a call
 * Codex is about to end; after it Start connects cold.
 */
const PREPARED_CALL_MAX_IDLE_MS = 25_000;

const pairKey = (mine: TranslatorLanguage, theirs: TranslatorLanguage) => `${mine.code}>${theirs.code}`;

export function useInterpreterCall(onTranscript: (transcript: InterpreterTranscript) => void): InterpreterCallController {
  const [state, setState] = useState<LiveState>("idle");
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  /** The audio sender; it carries no track until Start attaches the microphone. */
  const senderRef = useRef<RTCRtpSender | null>(null);
  const remoteRef = useRef<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const eventsRef = useRef<EventSource | null>(null);
  const callIdRef = useRef<string | null>(null);
  /** Pair of the call that is open or opening, prepared or started. */
  const pairRef = useRef<string | null>(null);
  /** Whether Start was pressed for the current call. Before that the call is invisible. */
  const startedRef = useRef(false);
  /** The server answered and the event stream is open. */
  const callReadyRef = useRef(false);
  /** The microphone track is on the call's sender (`replaceTrack` resolved). */
  const micAttachedRef = useRef(false);
  const preparedTimerRef = useRef<number | undefined>(undefined);
  /** Bumped by every teardown so a connect in flight knows it was cancelled. */
  const genRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    setSupported(
      typeof RTCPeerConnection !== "undefined"
      && typeof navigator !== "undefined"
      && typeof navigator.mediaDevices?.getUserMedia === "function",
    );
  }, []);

  /** Release the microphone, peer, audio element, event stream and server call. */
  const release = useCallback(() => {
    genRef.current += 1;
    const callId = callIdRef.current;
    callIdRef.current = null;
    pairRef.current = null;
    startedRef.current = false;
    callReadyRef.current = false;
    micAttachedRef.current = false;
    window.clearTimeout(preparedTimerRef.current);
    preparedTimerRef.current = undefined;
    eventsRef.current?.close();
    eventsRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    senderRef.current = null;
    remoteRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.srcObject = null;
      audio.remove();
    }
    if (callId) hangUp(callId);
  }, []);

  const teardown = useCallback((next: LiveState) => {
    release();
    setState(next);
  }, [release]);

  /** A started call shows the failure; a prepared one is dropped quietly and Start connects anew. */
  const fail = useCallback((reason: LiveFailure, message?: string) => {
    if (!startedRef.current) {
      release();
      return;
    }
    setFailure(reason);
    setDetail(message ?? null);
    teardown("error");
  }, [release, teardown]);

  /** Started, the call answered and the microphone is on its sender: only then may the view say it listens. */
  const isListening = useCallback(
    () => startedRef.current && callReadyRef.current && micAttachedRef.current,
    [],
  );

  const settleLive = useCallback((gen: number) => {
    if (genRef.current !== gen || !isListening()) return;
    setState("live");
  }, [isListening]);

  /** Hand the interpreted voice to the audio element once both exist. */
  const attachRemote = useCallback(() => {
    const remote = remoteRef.current;
    const audio = audioRef.current;
    if (!remote || !audio) return;
    if (audio.srcObject !== remote) audio.srcObject = remote;
  }, []);

  /**
   * Open the Codex call with an audio sender that has no track yet: nothing is captured
   * or sent until `attachMic`. Every exit is gated on `genRef.current === gen`, so a
   * cancelled open never tears down or relabels the call that replaced it.
   */
  const openCall = useCallback(async (gen: number, mine: TranslatorLanguage, theirs: TranslatorLanguage) => {
    try {
      const pc = new RTCPeerConnection();
      peerRef.current = pc;
      senderRef.current = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
      pc.ontrack = (event) => {
        // A late track from a cancelled peer must not reach the call that replaced it.
        if (genRef.current !== gen || peerRef.current !== pc) return;
        remoteRef.current = event.streams[0] ?? new MediaStream([event.track]);
        attachRemote();
      };

      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGathering(pc);
      if (genRef.current !== gen) return;
      const offer = pc.localDescription?.sdp;
      if (!offer) throw new Error("The browser produced no offer SDP.");

      const response = await fetch("/api/live/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: offer, mine: mine.code, theirs: theirs.code }),
      });
      const body: unknown = await response.json().catch(() => ({}));
      let code: unknown;
      let message: string | undefined;
      let callId = "";
      let answer = "";
      if (body && typeof body === "object") {
        if ("error" in body) code = body.error;
        if ("message" in body && typeof body.message === "string") message = body.message;
        if ("callId" in body && typeof body.callId === "string") callId = body.callId;
        if ("sdp" in body && typeof body.sdp === "string") answer = body.sdp;
      }
      if (!response.ok || !callId || !answer) {
        if (genRef.current === gen) fail(failureFromOffer(response.status, code), message);
        return;
      }
      if (genRef.current !== gen) {
        hangUp(callId);
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      if (genRef.current !== gen) {
        // Cancelled while the answer was applied; the call exists only server-side now.
        pc.close();
        hangUp(callId);
        return;
      }
      callIdRef.current = callId;

      const events = new EventSource(`/api/live/events?callId=${encodeURIComponent(callId)}`);
      eventsRef.current = events;
      events.onmessage = (event: MessageEvent<string>) => {
        if (genRef.current !== gen) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
        if (parsed.type === "state" && "state" in parsed) {
          if (typeof parsed.state !== "string" || !isLiveState(parsed.state)) return;
          // The server ended or broke the call; the browser still owns the microphone
          // and peer, so release them. Only the in-call states keep them: the view
          // shows Start for every other state, and it must never do so over a live
          // mic. An error state may arrive alone as a replay when the upstream error
          // happened before this stream subscribed. A prepared call stays invisible:
          // its in-call states are not shown, and its end only drops it. A started
          // call stays "connecting" until the microphone is attached: the server can
          // report live while the permission prompt is still open.
          if (parsed.state === "connecting" || parsed.state === "live" || parsed.state === "working") {
            if (isListening()) setState(parsed.state);
          } else if (parsed.state === "error") fail("upstream", parsed.state);
          else if (startedRef.current) teardown(parsed.state);
          else release();
          return;
        }
        if (parsed.type === "transcript" && "role" in parsed && "text" in parsed && "final" in parsed) {
          if (startedRef.current && (parsed.role === "user" || parsed.role === "assistant") && typeof parsed.text === "string") {
            onTranscriptRef.current({ role: parsed.role, text: parsed.text, final: parsed.final === true });
          }
          return;
        }
        if (parsed.type === "error" && "message" in parsed && typeof parsed.message === "string") {
          fail("upstream", parsed.message);
        }
      };
      events.onerror = () => {
        if (genRef.current !== gen) return;
        // The stream also ends normally when the call is closed on purpose.
        if (callIdRef.current) fail("failed");
      };
      callReadyRef.current = true;
      settleLive(gen);
    } catch (error) {
      if (genRef.current === gen) fail("failed", error instanceof Error ? error.message : String(error));
    }
  }, [attachRemote, fail, isListening, release, settleLive, teardown]);

  /** Ask for the microphone (only after Start) and put it on the call's audio sender. */
  const attachMic = useCallback(async (gen: number) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (genRef.current === gen) fail(name === "NotAllowedError" || name === "SecurityError" ? "mic-denied" : "mic-unavailable");
      return;
    }
    const sender = senderRef.current;
    if (genRef.current !== gen || !sender) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    // Kept before the await so a teardown during `replaceTrack` still stops the track.
    streamRef.current = stream;
    try {
      // Same transceiver the offer negotiated: no renegotiation, the call hears the mic at once.
      await sender.replaceTrack(stream.getAudioTracks()[0] ?? null);
    } catch (error) {
      if (genRef.current === gen) fail("failed", error instanceof Error ? error.message : String(error));
      return;
    }
    if (genRef.current !== gen) return;
    micAttachedRef.current = true;
    attachRemote();
    settleLive(gen);
  }, [attachRemote, fail, settleLive]);

  const prepare = useCallback((mine: TranslatorLanguage, theirs: TranslatorLanguage) => {
    const key = pairKey(mine, theirs);
    if (pairRef.current === key) return;
    // A started call is never replaced from here; changing the pair mid-call goes through `start`.
    if (startedRef.current) return;
    release();
    pairRef.current = key;
    const gen = genRef.current;
    preparedTimerRef.current = window.setTimeout(() => {
      if (genRef.current === gen && !startedRef.current) release();
    }, PREPARED_CALL_MAX_IDLE_MS);
    void openCall(gen, mine, theirs);
  }, [openCall, release]);

  const start = useCallback((mine: TranslatorLanguage, theirs: TranslatorLanguage) => {
    const key = pairKey(mine, theirs);
    const reuse = pairRef.current === key && !startedRef.current && peerRef.current !== null;
    if (!reuse) {
      release();
      pairRef.current = key;
    }
    window.clearTimeout(preparedTimerRef.current);
    preparedTimerRef.current = undefined;
    startedRef.current = true;
    const gen = genRef.current;
    setFailure(null);
    setDetail(null);
    setState("connecting");
    // Created inside the click so autoplay policy lets the interpreted voice play.
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audioRef.current = audio;
    attachRemote();
    // The microphone and a cold call open side by side; a prepared call only needs the mic.
    if (!reuse) void openCall(gen, mine, theirs);
    void attachMic(gen);
  }, [attachMic, attachRemote, openCall, release]);

  const stop = useCallback(() => teardown("idle"), [teardown]);

  useEffect(() => () => release(), [release]);

  return { state, failure, detail, supported, prepare, start, stop };
}
