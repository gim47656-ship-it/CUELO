"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceEngine } from "./voice-engine";
import type { VoiceUtterance } from "@/lib/interpreter-voice/session";
import type { SpeakerSide } from "@/lib/interpreter-voice/speakers";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import type { InterpreterProfile } from "@/lib/translator-context";
import type { LiveState } from "@/lib/live-types";

export function useVoiceInterpreter(options: { onUtterance(item: VoiceUtterance, connection: string, startedAt: number, pair: { mine: TranslatorLanguage; theirs: TranslatorLanguage }): void; playVoice: boolean; echoGuard: boolean; naturalVoice: boolean }) {
  const latest = useRef(options); latest.current = options;
  const engine = useRef<VoiceEngine | null>(null);
  const [state, setState] = useState<LiveState>("idle");
  const [connectionId, setConnectionId] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [models, setModels] = useState<{ state: "loading" | "ready" | "failed"; percent: number }>({ state: "loading", percent: 0 });
  const [enrollment, setEnrollment] = useState<{ side: SpeakerSide | null; seconds: number; failed?: boolean }>({ side: null, seconds: 0 });
  const [overlap, setOverlap] = useState(false);
  const overlapTimer = useRef<number | undefined>(undefined);
  useEffect(() => { setSupported(typeof WebSocket === "function" && typeof AudioWorkletNode === "function" && !!navigator.mediaDevices?.getUserMedia); return () => { engine.current?.dispose(); window.clearTimeout(overlapTimer.current); }; }, []);
  const start = useCallback((mine: TranslatorLanguage, theirs: TranslatorLanguage, profile: InterpreterProfile) => {
    engine.current?.dispose(); window.clearTimeout(overlapTimer.current); setOverlap(false); setFailure(null);
    const connection = crypto.randomUUID(), startedAt = Date.now();
    setConnectionId(connection);
    const next = new VoiceEngine({ mine, theirs, profile,
      onUpdate: (item) => latest.current.onUtterance(item, connection, startedAt, { mine, theirs }),
      onState: (nextState, reason) => { setState(nextState); if (reason) setFailure(reason); },
      onModels: (nextState, percent) => setModels({ state: nextState, percent }),
      onEnrollment: (side, seconds, failed) => setEnrollment({ side, seconds, failed }),
      onOverlap: () => { setOverlap(true); window.clearTimeout(overlapTimer.current); overlapTimer.current = window.setTimeout(() => setOverlap(false), 5000); },
      playback: () => ({ enabled: latest.current.playVoice, echoGuard: latest.current.echoGuard, natural: latest.current.naturalVoice }),
    });
    engine.current = next; void next.start();
  }, []);
  const stop = useCallback(() => { void engine.current?.stop(); }, []);
  const shutdown = useCallback(() => { engine.current?.dispose(); setState("idle"); setEnrollment({ side: null, seconds: 0 }); setOverlap(false); window.clearTimeout(overlapTimer.current); }, []);
  const correct = useCallback((id: number, side: SpeakerSide) => engine.current?.correct(id, side), []);
  const nextEnrollment = useCallback(() => engine.current?.nextEnrollment(), []);
  const skipEnrollment = useCallback(() => engine.current?.skipEnrollment(), []);
  return { state, failure, detail: null, supported, start, stop, shutdown, correct, models, enrollment, nextEnrollment, skipEnrollment, overlap, connectionId,
    reconnecting: false, ended: null, skipped: false, prepare: undefined,
  };
}
