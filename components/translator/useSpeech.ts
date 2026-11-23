"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readAloud } from "./read-aloud";
import type { TranslatorLanguage } from "@/lib/translator-languages";

export interface Speech {
  supported: boolean;
  speaking: boolean;
  /** 마지막 읽기가 끊긴 것이 아니라 실패했는지. 짧은 안내를 보인다. */
  failed: boolean;
  speak: (text: string, language: TranslatorLanguage) => void;
  cancel: () => void;
}

/** `natural`: read with the server's ElevenLabs voice first (falls back to the native voice). */
export function useSpeech(natural = false): Speech {
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  const [supported, setSupported] = useState(false);
  const active = useRef<AbortController | null>(null);
  const context = useRef<AudioContext | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Prime native voice discovery; readAloud checks the live list at each request.
    window.speechSynthesis?.getVoices();
    setSupported(!!window.speechSynthesis || typeof AudioContext === "function");
    return () => {
      active.current?.abort();
      void context.current?.close().catch(() => {});
      context.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setSpeaking(false);
    setFailed(false);
  }, []);

  const speak = useCallback((text: string, language: TranslatorLanguage) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setFailed(false);
    setSpeaking(true);
    // Unlock fallback audio on the tap, not from a later asynchronous native error.
    if (typeof AudioContext === "function") {
      try { context.current ??= new AudioContext(); void context.current.resume().catch(() => {}); }
      catch { /* A working native voice does not require WebAudio. */ }
    }
    void readAloud(text, language, controller.signal, () => context.current ??= new AudioContext(), undefined, naturalRef.current).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    }).finally(() => { if (!controller.signal.aborted) setSpeaking(false); });
  }, []);

  return { supported, speaking, failed, speak, cancel };
}
