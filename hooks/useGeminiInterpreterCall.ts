"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { failureFromOffer, type LiveFailure } from "@/hooks/useLiveVoice";
import type { LiveState } from "@/lib/live-types";
import type { InterpreterCallController, InterpreterCallOptions } from "@/components/translator/useInterpreterCall";
import type { InterpreterProfile } from "@/lib/translator-context";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import {
  AudioBacklogError,
  GeminiAudioPlayer,
  GeminiLiveSession,
  type GeminiCloseInfo,
  type GeminiLiveHandlers,
  type GeminiSocketLike,
} from "@/lib/gemini-interpreter-audio";

/**
 * Gemini Live 통역(Google Cloud, Vertex AI)의 브라우저 쪽. Codex 통역(`components/translator/useInterpreterCall.ts`)과
 * 같은 컨트롤러를 돌려준다. 연결은 전송(`LiveInterpreterTransport`)이 정한다: 서버 라우트가 통화를 열고,
 * 그 답이 Live 소켓이 된다(`hooks/useCloudInterpreterCall.ts`). 마이크는 AudioWorklet이 16kHz PCM16으로
 * 줄여 보내고, 받은 PCM(보통 24kHz)은 같은 AudioContext로 이어 붙여 재생한다.
 *
 * - `prepare`는 연결만 미리 연다. 마이크도 AudioContext도 만들지 않는다.
 * - `start`는 클릭 안에서 AudioContext를 만들어 재생을 연다. 마이크는 세션이 준비된 뒤에야 캡처에
 *   이어진다. 준비 전 소리를 쌓아 두다 버리는 일이 없다.
 * - 통화가 끊기거나 Gemini가 GoAway를 보내면 마이크를 놓지 않고 새로 연다. 새 연결은
 *   지금까지의 대화(`getHistory`)만 맥락으로 받는다(세션 재개 없음). 재생 중이던 옛 통역은 멈춘다.
 * - 서버 설정이 없으면 `auth` 실패로 멈추고 다른 엔진으로 넘어가지 않는다.
 */

const WORKLET_URL = "/gemini-interpreter-worklet.js";
const WORKLET_PROCESSOR = "gemini-capture";

/**
 * An unused prepared session is closed after this, so a view left open does not keep a Gemini
 * session alive.
 */
const PREPARED_SESSION_MAX_IDLE_MS = 60_000;

/** Reconnects in a row with no transcript in between before interpreting stops (as for Codex). */
const MAX_RECONNECTS_WITHOUT_SPEECH = 10;

/** Pause before reopening after a failed attempt: a Wi-Fi/mobile handoff takes a moment. */
const RECONNECT_RETRY_DELAY_MS = 2_000;

interface CallTarget {
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  profile: InterpreterProfile;
}

interface LostCall {
  reason: LiveFailure;
  message?: string;
}

const targetKey = ({ mine, theirs, profile }: CallTarget) =>
  `${mine.code}>${theirs.code}|${profile.mood ?? ""}|${profile.gender ?? ""}|${profile.age ?? ""}`;

/**
 * How a call is opened: the server route, and how its answer becomes a Live socket. Everything
 * else (microphone, worklet, playback, transcripts, reconnects) is the hook's.
 */
export interface LiveInterpreterTransport {
  /** POST `{ mine, theirs, context }` here to open a call. */
  endpoint: string;
  /** How to open the Live socket for the route's answer, or `null` when the answer lacks what it needs. */
  session(record: Record<string, unknown>): { createSocket: () => GeminiSocketLike } | null;
  /** Release what a successful answer allocated when that answer arrives after the open was cancelled. */
  discard?(record: Record<string, unknown>): void;
}

/** After this another attempt cannot help: the server setup must change first. */
const isSetupError = (error: unknown) => error === "not-configured";

type AudioContextConstructor = typeof AudioContext;

function audioContextClass(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
}

export function useLiveInterpreterCall(
  { onTranscript, getHistory, onReconnect }: InterpreterCallOptions,
  transport: LiveInterpreterTransport,
): InterpreterCallController {
  const transportRef = useRef(transport);
  const [state, setState] = useState<LiveState>("idle");
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [ended, setEnded] = useState<"idle" | null>(null);

  const sessionRef = useRef<GeminiLiveSession | null>(null);
  /** Setup completed on the current session: audio may flow. */
  const sessionReadyRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const playerRef = useRef<GeminiAudioPlayer<AudioDestinationNode> | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  /** The microphone source feeds the capture worklet of the current session. */
  const micAttachedRef = useRef(false);
  const targetRef = useRef<CallTarget | null>(null);
  const startedRef = useRef(false);
  const reconnectsRef = useRef(0);
  const hadLiveRef = useRef(false);
  const retryTimerRef = useRef<number | undefined>(undefined);
  const preparedTimerRef = useRef<number | undefined>(undefined);
  /** Bumped by every teardown or reconnect so work in flight knows it was cancelled. */
  const genRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  const getHistoryRef = useRef(getHistory);
  const onReconnectRef = useRef(onReconnect);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    getHistoryRef.current = getHistory;
    onReconnectRef.current = onReconnect;
    transportRef.current = transport;
  }, [getHistory, onReconnect, onTranscript, transport]);

  useEffect(() => {
    setSupported(
      typeof WebSocket !== "undefined"
      && audioContextClass() !== undefined
      && typeof AudioWorkletNode !== "undefined"
      && typeof navigator !== "undefined"
      && typeof navigator.mediaDevices?.getUserMedia === "function",
    );
  }, []);

  /** Close the session and stop queued playback. The microphone, worklet and AudioContext stay. */
  const dropCall = useCallback(() => {
    genRef.current += 1;
    window.clearTimeout(preparedTimerRef.current);
    preparedTimerRef.current = undefined;
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
    if (micAttachedRef.current) {
      sourceRef.current?.disconnect();
      micAttachedRef.current = false;
    }
    sessionReadyRef.current = false;
    playerRef.current?.interrupt();
    sessionRef.current?.close();
    sessionRef.current = null;
  }, []);

  /** Release the session, microphone, capture graph and AudioContext. */
  const release = useCallback(() => {
    dropCall();
    targetRef.current = null;
    startedRef.current = false;
    const worklet = workletRef.current;
    workletRef.current = null;
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.disconnect();
    }
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    playerRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
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

  /**
   * Wire the microphone into the capture worklet once the call is started, the session is ready
   * and the microphone is held. Only then may the view say it listens.
   */
  const wireCapture = useCallback(() => {
    const source = sourceRef.current;
    const worklet = workletRef.current;
    if (!startedRef.current || !sessionReadyRef.current || micAttachedRef.current || !source || !worklet) return;
    source.connect(worklet);
    micAttachedRef.current = true;
    setReconnecting(false);
    hadLiveRef.current = true;
    setState("live");
  }, []);

  // Declared before `openSession` uses it; assigned below once `openSession` exists.
  const resumeRef = useRef<(failure?: LostCall) => void>(() => {});

  /** A started call that has been live and holds the microphone reconnects when retrying can help. */
  const lost = useCallback((reason: LiveFailure, message?: string, retry = true) => {
    if (retry && reason !== "auth" && startedRef.current && hadLiveRef.current && streamRef.current) {
      resumeRef.current({ reason, message });
    } else fail(reason, message);
  }, [fail]);

  /**
   * Ask the transport's route for a call for this target and open the session. Every step is gated on
   * `genRef.current === gen` so a cancelled open never touches the session that replaced it.
   */
  const openSession = useCallback(async (gen: number, target: CallTarget): Promise<void> => {
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(transportRef.current.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mine: target.mine.code,
          theirs: target.theirs.code,
          context: { profile: target.profile, history: getHistoryRef.current() },
        }),
      });
      body = await response.json().catch(() => ({}));
    } catch (error) {
      if (genRef.current === gen) lost("failed", error instanceof Error ? error.message : String(error));
      return;
    }
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    if (genRef.current !== gen) {
      if (response.ok) transportRef.current.discard?.(record);
      return;
    }
    const message = typeof record.message === "string" ? record.message : undefined;
    const opened = response.ok ? transportRef.current.session(record) : null;
    if (!opened) {
      if (isSetupError(record.error)) lost("auth", message, false);
      else lost(failureFromOffer(response.status, record.error), message);
      return;
    }

    let session: GeminiLiveSession | null = null;
    const current = () => session !== null && genRef.current === gen && sessionRef.current === session;
    const handlers: GeminiLiveHandlers = {
      onReady: () => {
        if (!current()) return;
        sessionReadyRef.current = true;
        wireCapture();
      },
      onTranscript: (event) => {
        if (!current() || !startedRef.current) return;
        if (event.text.trim()) reconnectsRef.current = 0;
        onTranscriptRef.current({ role: event.role, text: event.text, final: event.final });
      },
      onAudio: (data, mimeType) => {
        if (!current() || !startedRef.current) return;
        try {
          playerRef.current?.play(data, mimeType);
        } catch (error) {
          // A stuck output device: say so instead of dropping the interpretation silently.
          if (error instanceof AudioBacklogError) fail("failed", error.message);
          else throw error;
        }
      },
      onInterrupted: () => {
        if (current()) playerRef.current?.interrupt();
      },
      onGoAway: () => {
        if (!current()) return;
        // Reconnect ahead of the server's cut instead of losing the next utterance to it.
        if (startedRef.current && hadLiveRef.current && streamRef.current) resumeRef.current();
        else if (!startedRef.current) release();
      },
      onClose: (info: GeminiCloseInfo) => {
        if (!current()) return;
        if (!startedRef.current) release();
        else if (info.ended && hadLiveRef.current && streamRef.current) resumeRef.current();
        else lost(info.failure, info.message, info.retry);
      },
    };
    try {
      session = new GeminiLiveSession(opened.createSocket, handlers);
    } catch (error) {
      // A socket that cannot be created throws synchronously (a WebSocket constructor does).
      lost("failed", error instanceof Error ? error.message : String(error));
      return;
    }
    sessionRef.current = session;
  }, [fail, lost, release, wireCapture]);

  /**
   * Replace a started call that dropped, keeping the microphone. `failure` is set when the drop or
   * the previous attempt failed: the next attempt waits a moment, and if the budget runs out that
   * failure is shown instead of the idle stop.
   */
  const resume = useCallback((failure?: LostCall) => {
    const target = targetRef.current;
    if (!startedRef.current || !target || !streamRef.current) return;
    reconnectsRef.current += 1;
    if (reconnectsRef.current > MAX_RECONNECTS_WITHOUT_SPEECH) {
      if (failure) fail(failure.reason, failure.message);
      else {
        setEnded("idle");
        teardown("idle");
      }
      return;
    }
    // What was heard on the old session closes as final before the new one starts.
    sessionRef.current?.finishTranscripts();
    dropCall();
    const gen = genRef.current;
    setReconnecting(true);
    setState("connecting");
    onReconnectRef.current();
    const reopen = () => {
      if (genRef.current === gen) void openSession(gen, target);
    };
    if (failure) retryTimerRef.current = window.setTimeout(reopen, RECONNECT_RETRY_DELAY_MS);
    else reopen();
  }, [dropCall, fail, openSession, teardown]);

  useEffect(() => {
    resumeRef.current = resume;
  }, [resume]);

  /** Ask for the microphone (only after Start) and build the capture graph on the call's context. */
  const attachMic = useCallback(async (gen: number, context: AudioContext) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (genRef.current === gen) fail(name === "NotAllowedError" || name === "SecurityError" ? "mic-denied" : "mic-unavailable");
      return;
    }
    if (genRef.current !== gen || contextRef.current !== context) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    // Kept before the await so a teardown while the module loads still stops the track.
    streamRef.current = stream;
    try {
      await context.audioWorklet.addModule(WORKLET_URL);
      if (genRef.current !== gen || contextRef.current !== context) return;
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, WORKLET_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      });
      // Pulled by the destination; the processor writes nothing, so it stays silent.
      worklet.connect(context.destination);
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (micAttachedRef.current) sessionRef.current?.sendAudio(event.data);
      };
      sourceRef.current = source;
      workletRef.current = worklet;
    } catch (error) {
      if (genRef.current === gen) fail("failed", error instanceof Error ? error.message : String(error));
      return;
    }
    wireCapture();
  }, [fail, wireCapture]);

  const prepare = useCallback((mine: TranslatorLanguage, theirs: TranslatorLanguage, profile: InterpreterProfile) => {
    const target: CallTarget = { mine, theirs, profile };
    if (targetRef.current && targetKey(targetRef.current) === targetKey(target)) return;
    // A started call is never replaced from here; changing the pair mid-call goes through `start`.
    if (startedRef.current) return;
    release();
    targetRef.current = target;
    const gen = genRef.current;
    preparedTimerRef.current = window.setTimeout(() => {
      if (genRef.current === gen && !startedRef.current) release();
    }, PREPARED_SESSION_MAX_IDLE_MS);
    void openSession(gen, target);
  }, [openSession, release]);

  const start = useCallback((mine: TranslatorLanguage, theirs: TranslatorLanguage, profile: InterpreterProfile) => {
    const target: CallTarget = { mine, theirs, profile };
    const reuse = targetRef.current !== null
      && targetKey(targetRef.current) === targetKey(target)
      && !startedRef.current
      && sessionRef.current !== null;
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
    const Context = audioContextClass();
    if (!Context) {
      fail("unsupported");
      return;
    }
    // Created and resumed inside the click so autoplay policy lets the interpreted voice play.
    const context = new Context({ latencyHint: "interactive" });
    contextRef.current = context;
    void context.resume().catch(() => {});
    playerRef.current = new GeminiAudioPlayer(context);
    if (!reuse) void openSession(gen, target);
    void attachMic(gen, context);
  }, [attachMic, fail, openSession, release]);

  const stop = useCallback(() => teardown("idle"), [teardown]);

  useEffect(() => () => release(), [release]);

  return { state, failure, detail, supported, reconnecting, ended, prepare, start, stop };
}
