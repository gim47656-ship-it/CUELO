"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { failureFromOffer, isLiveState, waitForIceGathering, type LiveFailure } from "@/hooks/useLiveVoice";
import type { LiveState, LiveTranscriptRole } from "@/lib/live-types";
import type { InterpreterProfile, InterpreterTurn } from "@/lib/translator-context";
import type { TranslatorLanguage } from "@/lib/translator-languages";

/**
 * 통역 통화의 브라우저 쪽. `hooks/useLiveVoice.ts`와 같은 방식으로 마이크·WebRTC 피어는 화면이,
 * Codex 자격·사이드밴드는 서버가 든다. 다른 점은 세션이 없고(`/api/live/interpret`에 두 언어와
 * 통역 맥락만 보낸다), 목소리는 늘 Codex 원격 음성 트랙이며, 전사를 끝내는 말로 읽지 않는다는 것이다.
 *
 * 통역 중에 통화가 끝나면(Codex는 말이 없는 통화를 약 30초 뒤 끊는다, 서버 이벤트 스트림이 끊김,
 * 망이 바뀌어 WebRTC가 실패) 마이크를 놓지 않고 새 통화를 연다. 새 통화에는 그때까지의 대화를
 * 넘겨 앞 맥락을 잇는다. 말 없이 다시 연결만 이어지면 멈추고 `ended: "idle"`을 알린다.
 */

export interface InterpreterTranscript {
  role: LiveTranscriptRole;
  text: string;
  final: boolean;
}

export interface InterpreterCallOptions {
  onTranscript: (transcript: InterpreterTranscript) => void;
  /** The turns interpreted so far, read each time a call opens. */
  getHistory: () => InterpreterTurn[];
  /** A started call was replaced by a reconnect: new transcripts belong to a new call. */
  onReconnect: () => void;
}

export interface InterpreterCallController {
  state: LiveState;
  failure: LiveFailure | null;
  detail: string | null;
  /** `null` until the browser check ran (server render and first paint). */
  supported: boolean | null;
  /** A started call dropped and a new one is opening with the microphone kept. */
  reconnecting: boolean;
  /** Why the last started call stopped on its own: `idle` after reconnects with no speech. */
  ended: "idle" | null;
  /**
   * Open a call for this pair and profile ahead of Start, without the microphone: the peer
   * sends no audio track until `start`. Idempotent for the pair and profile; a failure stays
   * silent and `start` then connects from scratch. The state stays `idle`.
   */
  prepare: (mine: TranslatorLanguage, theirs: TranslatorLanguage, profile: InterpreterProfile) => void;
  /** Start interpreting, reusing a prepared call when it matches. Call it inside the click. */
  start: (mine: TranslatorLanguage, theirs: TranslatorLanguage, profile: InterpreterProfile) => void;
  stop: () => void;
}

interface CallTarget {
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  profile: InterpreterProfile;
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

/**
 * Reconnect attempts in a row with no transcript in between before interpreting stops. At
 * Codex's ~32 s silent-call limit this is about five minutes without anyone speaking; when
 * the attempts themselves fail (no network) the last failure is shown instead.
 */
const MAX_RECONNECTS_WITHOUT_SPEECH = 10;

/** Pause before reopening after a failed attempt: a Wi-Fi/mobile handoff takes a moment. */
const RECONNECT_RETRY_DELAY_MS = 2_000;

interface LostCall {
  reason: LiveFailure;
  message?: string;
}

const targetKey = ({ mine, theirs, profile }: CallTarget) =>
  `${mine.code}>${theirs.code}|${profile.mood ?? ""}|${profile.gender ?? ""}|${profile.age ?? ""}`;

export function useInterpreterCall({ onTranscript, getHistory, onReconnect }: InterpreterCallOptions): InterpreterCallController {
  const [state, setState] = useState<LiveState>("idle");
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [ended, setEnded] = useState<"idle" | null>(null);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  /** The audio sender; it carries no track until Start attaches the microphone. */
  const senderRef = useRef<RTCRtpSender | null>(null);
  const remoteRef = useRef<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const eventsRef = useRef<EventSource | null>(null);
  const callIdRef = useRef<string | null>(null);
  /** Pair and profile of the call that is open or opening, prepared or started. */
  const targetRef = useRef<CallTarget | null>(null);
  /** Whether Start was pressed for the current call. Before that the call is invisible. */
  const startedRef = useRef(false);
  /** The server answered and the event stream is open. */
  const callReadyRef = useRef(false);
  /** The microphone track is on the call's sender (`replaceTrack` resolved). */
  const micAttachedRef = useRef(false);
  const reconnectsRef = useRef(0);
  /** The started call has been live at least once: from then on a drop reconnects instead of failing. */
  const hadLiveRef = useRef(false);
  const retryTimerRef = useRef<number | undefined>(undefined);
  const preparedTimerRef = useRef<number | undefined>(undefined);
  /** Bumped by every teardown or reconnect so a connect in flight knows it was cancelled. */
  const genRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  const getHistoryRef = useRef(getHistory);
  const onReconnectRef = useRef(onReconnect);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    getHistoryRef.current = getHistory;
    onReconnectRef.current = onReconnect;
  }, [getHistory, onReconnect, onTranscript]);

  useEffect(() => {
    setSupported(
      typeof RTCPeerConnection !== "undefined"
      && typeof navigator !== "undefined"
      && typeof navigator.mediaDevices?.getUserMedia === "function",
    );
  }, []);

  /** Drop the peer, event stream and server call. The microphone and audio element stay. */
  const dropCall = useCallback(() => {
    genRef.current += 1;
    const callId = callIdRef.current;
    callIdRef.current = null;
    callReadyRef.current = false;
    micAttachedRef.current = false;
    window.clearTimeout(preparedTimerRef.current);
    preparedTimerRef.current = undefined;
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
    eventsRef.current?.close();
    eventsRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    senderRef.current = null;
    remoteRef.current = null;
    if (callId) hangUp(callId);
  }, []);

  /** Release the microphone, peer, audio element, event stream and server call. */
  const release = useCallback(() => {
    dropCall();
    targetRef.current = null;
    startedRef.current = false;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.srcObject = null;
      audio.remove();
    }
  }, [dropCall]);

  const teardown = useCallback((next: LiveState) => {
    release();
    setReconnecting(false);
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
    setReconnecting(false);
    hadLiveRef.current = true;
    setState("live");
  }, [isListening]);

  /** Hand the interpreted voice to the audio element once both exist. */
  const attachRemote = useCallback(() => {
    const remote = remoteRef.current;
    const audio = audioRef.current;
    if (!remote || !audio) return;
    if (audio.srcObject !== remote) audio.srcObject = remote;
  }, []);

  /** Put the microphone on the current call's sender: no renegotiation, the call hears it at once. */
  const attachTrack = useCallback(async (gen: number, stream: MediaStream) => {
    const sender = senderRef.current;
    if (genRef.current !== gen || !sender) return;
    try {
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

  // Declared before `openCall` uses it; assigned below once `openCall` exists.
  const resumeRef = useRef<(failure?: LostCall) => void>(() => {});

  /**
   * A started call that has been live and still holds the microphone reconnects; anything
   * else fails as before. A missing or expired sign-in never heals by retrying.
   */
  const lost = useCallback((reason: LiveFailure, message?: string) => {
    if (startedRef.current && hadLiveRef.current && streamRef.current && reason !== "auth") resumeRef.current({ reason, message });
    else fail(reason, message);
  }, [fail]);

  /**
   * Open the Codex call with an audio sender that has no track yet: nothing is captured
   * or sent until a track is attached. Every exit is gated on `genRef.current === gen`, so
   * a cancelled open never tears down or relabels the call that replaced it. Resolves
   * `true` once the call answered and its event stream is open.
   */
  const openCall = useCallback(async (gen: number, target: CallTarget): Promise<boolean> => {
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
      // Switching between Wi-Fi and mobile data breaks the media path while the event
      // stream may survive; a started call then reconnects instead of going silent.
      pc.onconnectionstatechange = () => {
        if (genRef.current === gen && pc.connectionState === "failed") lost("failed", "connection failed");
      };

      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGathering(pc);
      if (genRef.current !== gen) return false;
      const offer = pc.localDescription?.sdp;
      if (!offer) throw new Error("The browser produced no offer SDP.");

      const response = await fetch("/api/live/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sdp: offer,
          mine: target.mine.code,
          theirs: target.theirs.code,
          context: { profile: target.profile, history: getHistoryRef.current() },
        }),
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
        if (genRef.current === gen) lost(failureFromOffer(response.status, code), message);
        return false;
      }
      if (genRef.current !== gen) {
        hangUp(callId);
        return false;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      if (genRef.current !== gen) {
        // Cancelled while the answer was applied; the call exists only server-side now.
        pc.close();
        hangUp(callId);
        return false;
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
          // The server ended or broke the call. A prepared call stays invisible: its
          // in-call states are not shown, and its end only drops it. A started call
          // stays "connecting" until the microphone is attached: the server can report
          // live while the permission prompt is still open. Once a started call has been
          // live and holds the microphone, an end (Codex's silent-call limit) reconnects,
          // also while a replacement is still attaching; the view shows Start only when
          // the browser holds no live mic.
          if (parsed.state === "connecting" || parsed.state === "live" || parsed.state === "working") {
            if (isListening()) setState(parsed.state);
          } else if (parsed.state === "error") lost("upstream", parsed.state);
          else if (startedRef.current && hadLiveRef.current && streamRef.current) resumeRef.current();
          else if (startedRef.current) teardown(parsed.state);
          else release();
          return;
        }
        if (parsed.type === "transcript" && "role" in parsed && "text" in parsed && "final" in parsed) {
          if (startedRef.current && (parsed.role === "user" || parsed.role === "assistant") && typeof parsed.text === "string") {
            if (parsed.text.trim()) reconnectsRef.current = 0;
            onTranscriptRef.current({ role: parsed.role, text: parsed.text, final: parsed.final === true });
          }
          return;
        }
        if (parsed.type === "error" && "message" in parsed && typeof parsed.message === "string") {
          lost("upstream", parsed.message);
        }
      };
      events.onerror = () => {
        // The stream also ends normally when the call is closed on purpose (that path
        // bumps the generation first).
        if (genRef.current === gen && callIdRef.current) lost("failed");
      };
      callReadyRef.current = true;
      settleLive(gen);
      return true;
    } catch (error) {
      if (genRef.current === gen) lost("failed", error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [attachRemote, isListening, lost, release, settleLive, teardown]);

  /**
   * Replace a started call that dropped, keeping the microphone and the conversation.
   * `failure` is set when the drop or the previous attempt failed: the next attempt waits
   * a moment, and if the budget runs out that failure is shown instead of the idle stop.
   */
  const resume = useCallback((failure?: LostCall) => {
    const target = targetRef.current;
    const stream = streamRef.current;
    // Callers check both; a call that never held the microphone has nothing to keep.
    if (!startedRef.current || !target || !stream) return;
    reconnectsRef.current += 1;
    if (reconnectsRef.current > MAX_RECONNECTS_WITHOUT_SPEECH) {
      if (failure) fail(failure.reason, failure.message);
      else {
        setEnded("idle");
        teardown("idle");
      }
      return;
    }
    dropCall();
    const gen = genRef.current;
    setReconnecting(true);
    setState("connecting");
    onReconnectRef.current();
    const reopen = () => {
      if (genRef.current !== gen) return;
      void openCall(gen, target).then((open) => {
        if (open) void attachTrack(gen, stream);
      });
    };
    if (failure) retryTimerRef.current = window.setTimeout(reopen, RECONNECT_RETRY_DELAY_MS);
    else reopen();
  }, [attachTrack, dropCall, fail, openCall, teardown]);

  useEffect(() => {
    resumeRef.current = resume;
  }, [resume]);

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
    if (genRef.current !== gen || !senderRef.current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    // Kept before the await so a teardown during `replaceTrack` still stops the track.
    streamRef.current = stream;
    await attachTrack(gen, stream);
  }, [attachTrack, fail]);

  const prepare = useCallback((mine: TranslatorLanguage, theirs: TranslatorLanguage, profile: InterpreterProfile) => {
    const target = { mine, theirs, profile };
    if (targetRef.current && targetKey(targetRef.current) === targetKey(target)) return;
    // A started call is never replaced from here; changing the pair mid-call goes through `start`.
    if (startedRef.current) return;
    release();
    targetRef.current = target;
    const gen = genRef.current;
    preparedTimerRef.current = window.setTimeout(() => {
      if (genRef.current === gen && !startedRef.current) release();
    }, PREPARED_CALL_MAX_IDLE_MS);
    void openCall(gen, target);
  }, [openCall, release]);

  const start = useCallback((mine: TranslatorLanguage, theirs: TranslatorLanguage, profile: InterpreterProfile) => {
    const target = { mine, theirs, profile };
    const reuse = targetRef.current !== null
      && targetKey(targetRef.current) === targetKey(target)
      && !startedRef.current
      && peerRef.current !== null;
    if (!reuse) {
      release();
      targetRef.current = target;
    }
    window.clearTimeout(preparedTimerRef.current);
    preparedTimerRef.current = undefined;
    startedRef.current = true;
    reconnectsRef.current = 0;
    hadLiveRef.current = false;
    const gen = genRef.current;
    setFailure(null);
    setDetail(null);
    setEnded(null);
    setReconnecting(false);
    setState("connecting");
    // Created inside the click so autoplay policy lets the interpreted voice play.
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audioRef.current = audio;
    attachRemote();
    // The microphone and a cold call open side by side; a prepared call only needs the mic.
    if (!reuse) void openCall(gen, target);
    void attachMic(gen);
  }, [attachMic, attachRemote, openCall, release]);

  const stop = useCallback(() => teardown("idle"), [teardown]);

  useEffect(() => () => release(), [release]);

  return { state, failure, detail, supported, reconnecting, ended, prepare, start, stop };
}
