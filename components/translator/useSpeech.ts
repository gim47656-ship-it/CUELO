"use client";

import { useCallback, useEffect, useState } from "react";
import type { TranslatorLanguage } from "@/lib/translator-languages";

export interface Speech {
  supported: boolean;
  speaking: boolean;
  /** 마지막 읽기가 끊긴 것이 아니라 실패했는지. 짧은 안내를 보인다. */
  failed: boolean;
  speak: (text: string, language: TranslatorLanguage) => void;
  cancel: () => void;
}

/**
 * 폰 내장 음성(`speechSynthesis`)으로 한 줄을 읽어 준다. 서버를 거치지 않아 비용이 없다. 폰 브라우저는
 * 처음에 목소리 목록을 비워 두기도 하므로 `voiceschanged`를 기다리고, 그 언어 목소리가 없어도
 * `lang`만 정해 읽게 한다.
 */
export function useSpeech(): Speech {
  const [supported, setSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    setSupported(true);
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener("voiceschanged", load);
    return () => {
      synth.removeEventListener("voiceschanged", load);
      synth.cancel();
    };
  }, []);

  const cancel = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeaking(false);
    setFailed(false);
  }, []);

  const speak = useCallback((text: string, language: TranslatorLanguage) => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language.tag;
    const tag = language.tag.toLowerCase();
    const voice = voices.find((candidate) => candidate.lang.toLowerCase().replace("_", "-") === tag)
      ?? voices.find((candidate) => candidate.lang.toLowerCase().startsWith(language.code));
    if (voice) utterance.voice = voice;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = (event) => {
      setSpeaking(false);
      // 새 읽기나 닫기로 끊은 것은 실패가 아니다.
      if (event.error !== "canceled" && event.error !== "interrupted") setFailed(true);
    };
    setFailed(false);
    synth.speak(utterance);
  }, [voices]);

  return { supported, speaking, failed, speak, cancel };
}
