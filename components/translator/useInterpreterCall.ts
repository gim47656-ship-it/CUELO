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
  /** Start a call for this pair, ending any call already open. Call it inside the click. */
  start: (mine: TranslatorLanguage, theirs: TranslatorLanguage) => void;
  stop: () => void;
}

const hangUp = (callId: string) => {
  void fetch(`/api/live/call/${encodeURIComponent(callId)}`, { method: "DELETE" }).catch(() => {
    // The call also expires server-side once no reader remains.
  });
};

export function useInterpreterCall(onTranscript: (transcript: InterpreterTranscript) => void): InterpreterCallController {
  const [state, setState] = useState<LiveState>("idle");
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const eventsRef = useRef<EventSource | null>(null);
  const callIdRef = useRef<string | null>(null);
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
  const teardown = useCallback((next: LiveState) => {
    genRef.current += 1;
    const callId = callIdRef.current;
    callIdRef.current = null;
    eventsRef.current?.close();
    eventsRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.srcObject = null;
      audio.remove();
    }
    if (callId) hangUp(callId);
    setState(next);
  }, []);

  const fail = useCallback((reason: LiveFailure, message?: string) => {
    setFailure(reason);
    setDetail(message ?? null);
    teardown("error");
  }, [teardown]);

  const connect = useCallback(async (gen: number, mine: TranslatorLanguage, theirs: TranslatorLanguage) => {
    // Every exit is gated on `genRef.current === gen`: a cancelled connect must not
    // tear down or relabel the call that replaced it.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (genRef.current === gen) fail(name === "NotAllowedError" || name === "SecurityError" ? "mic-denied" : "mic-unavailable");
      return;
    }
    if (genRef.current !== gen) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    streamRef.current = stream;
    try {
      const pc = new RTCPeerConnection();
      peerRef.current = pc;
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      const audio = audioRef.current;
      pc.ontrack = (event) => {
        const [remote] = event.streams;
        if (remote && audio) audio.srcObject = remote;
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
          // happened before this stream subscribed.
          if (parsed.state === "connecting" || parsed.state === "live" || parsed.state === "working") setState(parsed.state);
          else if (parsed.state === "error") fail("upstream", parsed.state);
          else teardown(parsed.state);
          return;
        }
        if (parsed.type === "transcript" && "role" in parsed && "text" in parsed && "final" in parsed) {
          if ((parsed.role === "user" || parsed.role === "assistant") && typeof parsed.text === "string") {
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
      setState("live");
    } catch (error) {
      if (genRef.current === gen) fail("failed", error instanceof Error ? error.message : String(error));
    }
  }, [fail, teardown]);

  const start = useCallback((mine: TranslatorLanguage, theirs: TranslatorLanguage) => {
    teardown("connecting");
    const gen = genRef.current;
    setFailure(null);
    setDetail(null);
    // Created inside the click so autoplay policy lets the interpreted voice play.
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audioRef.current = audio;
    void connect(gen, mine, theirs);
  }, [connect, teardown]);

  const stop = useCallback(() => teardown("idle"), [teardown]);

  useEffect(() => () => teardown("closed"), [teardown]);

  return { state, failure, detail, supported, start, stop };
}
