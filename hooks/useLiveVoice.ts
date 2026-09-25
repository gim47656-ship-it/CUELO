"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { LiveState } from "@/lib/live-types";

/**
 * Browser half of the live voice surface.
 *
 * The page owns the microphone and the peer connection; the server owns the
 * Codex credential and the sideband socket. Exactly two things cross between
 * them — the offer SDP going out and the answer SDP coming back — plus a
 * one-way SSE stream of call state.
 */

/** Why a live call could not start, mapped to a message by the caller. */
export type LiveFailure =
  | "unsupported"
  | "mic-denied"
  | "mic-unavailable"
  | "auth"
  | "upstream"
  | "failed";

export interface LiveTranscriptLine {
  role: "user" | "assistant";
  text: string;
}

export interface LiveVoiceController {
  state: LiveState;
  failure: LiveFailure | null;
  /** Upstream detail for the failure, when the server supplied one. */
  detail: string | null;
  transcript: LiveTranscriptLine | null;
  /** `null` while the browser check has not run yet, on the server and first paint. */
  supported: boolean | null;
  toggle: () => void;
}

/** Codex signals over HTTP once, so the offer must carry every ICE candidate. */
const ICE_GATHER_TIMEOUT_MS = 3_000;

const LIVE_STATE_IDS: Record<string, true> = {
  idle: true,
  connecting: true,
  live: true,
  working: true,
  error: true,
  closed: true,
};

function isLiveState(value: string): value is LiveState {
  return LIVE_STATE_IDS[value] === true;
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const finish = () => {
    clearTimeout(timer);
    pc.removeEventListener("icegatheringstatechange", onChange);
    resolve();
  };
  const onChange = () => {
    if (pc.iceGatheringState === "complete") finish();
  };
  const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
  pc.addEventListener("icegatheringstatechange", onChange);
  return promise;
}

function failureFromOffer(status: number, code: unknown): LiveFailure {
  if (status === 401 || code === "live-auth") return "auth";
  if (status === 502 || code === "live-upstream") return "upstream";
  return "failed";
}

export function useLiveVoice(
  sessionId: string | undefined,
  /** Creates the session for a conversation that has not been sent yet. */
  ensureSession?: () => Promise<string | null>,
  /** Refreshes the associated chat after the server confirms durable append. */
  onTranscriptPersisted?: (sessionId: string) => void | Promise<void>,
): LiveVoiceController {
  const { locale } = useI18n();
  const [state, setState] = useState<LiveState>("idle");
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<LiveTranscriptLine | null>(null);
  // `null` until the effect below runs: the server render cannot know whether
  // this browser has WebRTC, and starting at `false` made every first paint
  // flash "this browser cannot make live calls" before the real answer.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const eventsRef = useRef<EventSource | null>(null);
  const callIdRef = useRef<string | null>(null);
  /** Bumped by every teardown so a connect in flight knows it was cancelled. */
  const genRef = useRef(0);

  useEffect(() => {
    setSupported(
      typeof RTCPeerConnection !== "undefined"
      && typeof navigator !== "undefined"
      && typeof navigator.mediaDevices?.getUserMedia === "function",
    );
  }, []);

  /**
   * Release every device and socket this hook opened. Runs on user stop, on
   * failure, and on unmount, so the microphone can never stay hot.
   */
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

    if (callId) {
      void fetch(`/api/live/call/${encodeURIComponent(callId)}`, { method: "DELETE" }).catch(() => {
        // The call also expires server-side once no reader remains.
      });
    }
    setState(next);
    setTranscript(null);
    // Every cancel path bumps the generation and returns from `start` wherever it
    // was waiting, so the connect in flight never reaches its own `finally`.
    // Clearing the flag here is what keeps `toggle` from being wedged shut after
    // a cancel during session creation or the microphone prompt.
    setBusy(false);
  }, []);

  const fail = useCallback((reason: LiveFailure, message?: string) => {
    setFailure(reason);
    setDetail(message ?? null);
    teardown("error");
  }, [teardown]);

  const start = useCallback(async () => {
    const gen = genRef.current + 1;
    genRef.current = gen;
    setFailure(null);
    setDetail(null);
    setBusy(true);
    setState("connecting");

    // Cancelling bumps the generation, and a connect that was already in flight
    // keeps running until its awaits return. Reporting its failure then would
    // tear down and relabel the call that replaced it, so every exit below is
    // gated on `genRef.current === gen` still holding.

    // A call talks to one session's agent, so a brand-new conversation needs its
    // session before anything else. This runs before the microphone prompt: if
    // the session cannot be created there is no call to make, and asking for the
    // microphone first would leave the user granting a device for nothing.
    let sid: string | null | undefined = sessionId;
    if (!sid && ensureSession) {
      try {
        sid = await ensureSession();
      } catch {
        sid = undefined;
      }
      if (genRef.current !== gen) return;
    }
    if (!sid) {
      if (genRef.current === gen) {
        setBusy(false);
        fail("failed");
      }
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (genRef.current === gen) {
        setBusy(false);
        fail(name === "NotAllowedError" || name === "SecurityError" ? "mic-denied" : "mic-unavailable");
      }
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

      const audio = document.createElement("audio");
      audio.autoplay = true;
      audioRef.current = audio;
      pc.ontrack = (event) => {
        const [remote] = event.streams;
        if (remote) audio.srcObject = remote;
      };

      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGathering(pc);
      if (genRef.current !== gen) return;
      const offer = pc.localDescription?.sdp;
      if (!offer) throw new Error("The browser produced no offer SDP.");

      const response = await fetch("/api/live/offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, sdp: offer, locale }),
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
        if (genRef.current === gen) {
          setBusy(false);
          fail(failureFromOffer(response.status, code), message);
        }
        return;
      }

      if (genRef.current !== gen) {
        void fetch(`/api/live/call/${encodeURIComponent(callId)}`, { method: "DELETE" }).catch(() => {});
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      if (genRef.current !== gen) {
        // Cancelled while the answer was being applied. `teardown` already
        // closed this peer, but the call it belongs to only exists server-side,
        // and the refs below now point at whatever replaced it.
        pc.close();
        void fetch(`/api/live/call/${encodeURIComponent(callId)}`, { method: "DELETE" }).catch(() => {});
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
          if (typeof parsed.state === "string" && isLiveState(parsed.state)) setState(parsed.state);
          return;
        }
        if (parsed.type === "transcript" && "role" in parsed && "text" in parsed) {
          if ((parsed.role === "user" || parsed.role === "assistant") && typeof parsed.text === "string") {
            setTranscript({ role: parsed.role, text: parsed.text });
            if ("final" in parsed && parsed.final === true && onTranscriptPersisted) {
              void Promise.resolve().then(() => onTranscriptPersisted(sid)).catch(() => {
                // The next session load or page reload still reads the durable entry.
              });
            }
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
    } finally {
      if (genRef.current === gen) setBusy(false);
    }
  }, [sessionId, ensureSession, onTranscriptPersisted, locale, fail]);

  const toggle = useCallback(() => {
    if (state === "idle" || state === "closed" || state === "error") {
      if (!busy) void start();
      return;
    }
    teardown("idle");
  }, [busy, state, start, teardown]);

  useEffect(() => () => teardown("closed"), [teardown]);

  return { state, failure, detail, transcript, supported, toggle };
}
