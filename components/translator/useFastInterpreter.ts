"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { FastTranslationTurns, type DraftPair, type FastTurn } from "@/lib/translator-draft";
import type { LiveState } from "@/lib/live-types";
import { openDraftSession, type DraftSession } from "./draft-session";

type Failure = "auth" | "upstream" | "mic-denied" | "mic-unavailable";

interface FastCall {
  turns: FastTranslationTurns;
  session?: DraftSession;
  stream?: MediaStream;
  clock?: number;
}

function decodePcm(delta: string): Int16Array | undefined {
  try {
    const bytes = atob(delta);
    if (bytes.length % 2) return undefined;
    const samples = new Int16Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.charCodeAt(2 * i) | bytes.charCodeAt(2 * i + 1) << 8;
    return samples;
  } catch {
    return undefined;
  }
}

function release(call: FastCall) {
  window.clearInterval(call.clock);
  call.session?.close();
  call.stream?.getTracks().forEach((track) => track.stop());
}

// These browser API capabilities are constant for the lifetime of a mounted page.
const subscribeCapabilities = () => () => {};
const hasFastAudio = () => typeof WebSocket === "function" && typeof AudioContext === "function"
  && typeof AudioWorkletNode === "function" && !!navigator.mediaDevices?.getUserMedia;

export function useFastInterpreter(options: {
  playVoice: boolean;
  /** Close the mic while the interpretation plays, for a loud speaker the playback cancelling misses. */
  echoGuard: boolean;
  onTurn(turn: FastTurn, connection: string, clockBase: number, pair: DraftPair): void;
  onRemove(utterance: string): void;
}) {
  const latest = useRef(options);
  const current = useRef<FastCall | null>(null);
  const [state, setState] = useState<LiveState>("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const supported = useSyncExternalStore(subscribeCapabilities, hasFastAudio, () => null);
  useLayoutEffect(() => { latest.current = options; }, [options]);

  useEffect(() => {
    return () => {
      const call = current.current;
      current.current = null;
      if (call) release(call);
    };
  }, []);

  const end = useCallback((reason?: Failure) => {
    const call = current.current;
    if (!call) return;
    current.current = null;
    call.turns.stop(performance.now());
    release(call);
    setFailure(reason ?? null);
    setState(reason ? "error" : "idle");
  }, []);

  const start = useCallback((mine: DraftPair["mine"], theirs: DraftPair["theirs"]) => {
    end();
    setFailure(null);
    setState("connecting");
    const pair = { mine, theirs };
    const connection = `fast-${crypto.randomUUID()}`;
    const clockBase = Date.now() - performance.now();
    const call: FastCall = {
      turns: new FastTranslationTurns(pair, {
        update: (turn) => latest.current.onTurn(turn, connection, clockBase, pair),
        remove: (id) => latest.current.onRemove(`${connection}:${id}`),
        play: (pcm, id) => { if (latest.current.playVoice) call.session?.play(pcm, id); },
        cancel: (id) => call.session?.cancelPlayback(id),
      }, latest.current.playVoice),
    };
    current.current = call;
    call.session = openDraftSession({
      ...pair,
      onInput: (target, delta) => call.turns.input(target, delta, performance.now()),
      onOutput: (target, delta) => call.turns.output(target, delta, performance.now()),
      fast: {
        onAudio: (target, delta) => {
          if (!latest.current.playVoice) return;
          const pcm = decodePcm(delta);
          if (pcm) call.turns.audio(target, pcm, performance.now());
        },
        onReady: () => {
          if (current.current !== call) return;
          setState("live");
          call.clock = window.setInterval(() => call.turns.tick(performance.now()), 250);
        },
        onFailure: (reason) => { if (current.current === call) end(reason); },
      },
    });
    call.session.setEchoGuard(latest.current.echoGuard);
    if (current.current !== call) return;
    void navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } }).then((stream) => {
      if (current.current !== call) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      call.stream = stream;
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState !== "live") { end("mic-unavailable"); return; }
      track.addEventListener("ended", () => { if (current.current === call) end("mic-unavailable"); }, { once: true });
      call.session?.setTrack(track);
    }).catch((error: unknown) => {
      if (current.current !== call) return;
      end(error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name) ? "mic-denied" : "mic-unavailable");
    });
  }, [end]);

  useLayoutEffect(() => { current.current?.turns.setVoice(options.playVoice); }, [options.playVoice]);
  useLayoutEffect(() => { current.current?.session?.setEchoGuard(options.echoGuard); }, [options.echoGuard]);
  const stop = useCallback(() => end(), [end]);
  const clear = useCallback(() => current.current?.turns.clear(), []);
  return { state, failure, detail: null, supported, start, stop, clear, reconnecting: false, ended: null, skipped: false, prepare: undefined };
}
