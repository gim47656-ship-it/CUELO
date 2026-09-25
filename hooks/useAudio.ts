"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import {
  CUE_TAGS,
  cueSetFor,
  loadCueManifest,
  selectCueAsset,
  NO_TONE_FALLBACK_CUE_TAGS,
  type CueManifest,
  type CuePresentation,
  type CueTag,
} from "@/lib/completion-audio";

function playTone(ctx: AudioContext) {
  const now = ctx.currentTime;
  const freqs = [523.25, 659.25];
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = now + i * 0.18;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.start(t);
    osc.stop(t + 0.45);
  });
}

async function fetchAudioBytes(path: string): Promise<ArrayBuffer> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

export function useAudio() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("omp-sound-enabled");
    return stored === null ? true : stored === "true";
  });

  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // Reuse a single AudioContext so it can be resumed if the browser
  // autoplay policy suspends it (contexts created outside user gestures
  // start in "suspended" state and produce no sound).
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playRequestRef = useRef(0);
  // 태그마다 직전에 쓴 자산만 기억한다. 완료 대사가 실패 대사에 밀려나지 않도록
  // 캐릭터·태그 조합별로 따로 센다.
  const previousVoicePathsRef = useRef(new Map<string, string>());
  const previousStickerPathsRef = useRef(new Map<string, string>());
  const previousCaptionsRef = useRef(new Map<string, string>());
  const manifestRef = useRef<Promise<CueManifest> | null>(null);
  const bufferCacheRef = useRef(new Map<string, Promise<AudioBuffer>>());
  // 미리 받아 둔 음원 바이트. 디코딩은 AudioContext가 필요해 재생 때 한다.
  const bytesCacheRef = useRef(new Map<string, Promise<ArrayBuffer>>());
  // 미리 받은 스티커가 GC로 캐시에서 빠지지 않도록 붙잡아 둔다.
  const preloadedImagesRef = useRef(new Map<string, HTMLImageElement>());
  const getBytes = useCallback((path: string): Promise<ArrayBuffer> => {
    let bytes = bytesCacheRef.current.get(path);
    if (!bytes) {
      bytes = fetchAudioBytes(path).catch((error) => {
        bytesCacheRef.current.delete(path);
        throw error;
      });
      bytesCacheRef.current.set(path, bytes);
    }
    return bytes;
  }, []);
  const getCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current && ctxRef.current.state !== "closed") return ctxRef.current;
    try {
      ctxRef.current = new AudioContext();
    } catch {
      return null;
    }
    return ctxRef.current;
  }, []);

  const getManifest = useCallback((): Promise<CueManifest> => {
    manifestRef.current ??= loadCueManifest();
    return manifestRef.current;
  }, []);

  // 첫 큐가 매니페스트 요청을 기다리지 않도록 미리 받아 둔다. 음소거여도 말풍선은 뜨므로
  // 매니페스트는 소리와 무관하게 필요하다.
  useEffect(() => {
    void getManifest();
  }, [getManifest]);

  /**
   * 이 캐릭터의 스티커·음성을 미리 받는다. 턴이 끝난 뒤에야 받으면 폰에서 스티커가 늦게 뜬다.
   * 음소거면 음성은 받지 않는다.
   */
  const preloadCue = useCallback(async (alias: string | null | undefined) => {
    if (!alias || typeof window === "undefined") return;
    const manifest = await getManifest();
    for (const tag of CUE_TAGS) {
      const set = cueSetFor(manifest, alias, tag);
      if (!set) continue;
      for (const url of set.stickers) {
        if (preloadedImagesRef.current.has(url)) continue;
        const image = new Image();
        image.decoding = "async";
        image.src = url;
        preloadedImagesRef.current.set(url, image);
      }
      if (enabledRef.current) for (const url of set.voices) void getBytes(url).catch(() => {});
    }
  }, [getManifest, getBytes]);

  const stopVoice = useCallback(() => {
    playRequestRef.current += 1;
    const source = sourceRef.current;
    sourceRef.current = null;
    if (!source) return;
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
  }, []);

  const unlockAudio = useCallback((force = false) => {
    if (!force && !enabledRef.current) return;
    const ctx = getCtx();
    if (!ctx || ctx.state !== "suspended") return;
    ctx.resume().catch(() => {});
  }, [getCtx]);

  // 브라우저는 사용자 조작 전 소리를 막는다. 업데이트 뒤 자동 새로고침된 탭은 입력창을 건드리기 전까지
  // 잠겨 있어 완료 음성이 조용히 사라졌다. 화면 어디든 첫 클릭·키 입력에서 푼다.
  useEffect(() => {
    const unlock = () => unlockAudio();
    const options = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", unlock, options);
    window.addEventListener("keydown", unlock, options);
    return () => {
      window.removeEventListener("pointerdown", unlock, options);
      window.removeEventListener("keydown", unlock, options);
    };
  }, [unlockAudio]);

  const toggle = useCallback(() => {
    const next = !enabledRef.current;
    if (next) {
      unlockAudio(true);
    } else {
      stopVoice();
    }
    enabledRef.current = next;
    localStorage.setItem("omp-sound-enabled", String(next));
    setEnabled(next);
  }, [stopVoice, unlockAudio]);

  const playAttention = useCallback((isCurrent?: () => boolean) => {
    if (!enabledRef.current) return;
    const ctx = getCtx();
    if (!ctx) return;
    stopVoice();
    const requestId = playRequestRef.current;
    const play = () => {
      if (requestId !== playRequestRef.current || !enabledRef.current || (isCurrent && !isCurrent())) return;
      try {
        playTone(ctx);
      } catch {
        // AudioContext not available
      }
    };
    if (ctx.state === "suspended") {
      ctx.resume().then(play).catch(() => {});
      return;
    }
    play();
  }, [getCtx, stopVoice]);

  /**
   * 캐릭터 큐 하나를 재생한다. 이벤트가 고른 태그로 그 캐릭터의 (스티커, 음성) 세트를 찾아
   * 음성을 내보내고, 화면에 띄울 스티커와 그 대사의 한국어 표기를 돌려준다. 그 태그에 음성이
   * 아직 없으면 중립 tone으로, 스티커가 없으면 null로 물러난다.
   *
   * 음소거는 **재생만** 막는다 — 소리를 끈 사용자야말로 화면에서 읽어야 하므로 클립 선택과
   * 말풍선은 그대로 흐른다. 자막이 실제로 난 음성과 어긋나지 않도록 둘은 같은 클립에서 온다.
   *
   * `tag`가 null이면 태그 없는 중립음이다 — 무슨 일인지 단정하지 못할 때 쓴다.
   * `NO_TONE_FALLBACK_CUE_TAGS`에 든 태그는 음성이 없어도 중립음으로 물러나지 않는다.
   *
   * 화면에 띄울 것(presentation)은 소리를 기다리지 않고 바로 돌려준다. 브라우저는 사용자
   * 제스처 전의 `resume()`을 제스처가 올 때까지 끝내지 않으므로, 소리를 기다리면 새로고침
   * 직후의 스티커가 영영 뜨지 않는다. 소리는 뒤에서 이어 가다 재개·디코딩이 끝난 순간에도
   * 더 새 큐에 밀리지 않았고 `isCurrent`(이 큐를 부른 트리거가 아직 유효한지)가 참일 때만
   * 낸다 — 늦게 풀린 소리가 지금 화면과 다른 일을 말하지 않도록.
   */
  const playCue = useCallback(async (
    alias?: string | null,
    tag: CueTag | null = "done",
    isCurrent?: () => boolean,
  ): Promise<CuePresentation> => {
    const manifest = await getManifest();

    const set = tag === null ? null : cueSetFor(manifest, alias, tag);
    const cueKey = `${alias ?? ""}\u0000${tag ?? ""}`;
    const sticker = set
      ? selectCueAsset(set.stickers, previousStickerPathsRef.current.get(cueKey) ?? null)
      : null;
    if (sticker !== null) previousStickerPathsRef.current.set(cueKey, sticker);

    const path = set
      ? selectCueAsset(set.voices, previousVoicePathsRef.current.get(cueKey) ?? null)
      : null;
    // 음성이 있으면 그 음성의 대사가 자막이다. 음성이 하나도 없는 태그만 자막 전용 대사에서
    // 고른다.
    let text = path ? set?.lines.get(path) ?? null : null;
    if (!path && set) {
      text = selectCueAsset(set.captions, previousCaptionsRef.current.get(cueKey) ?? null);
      if (text !== null) previousCaptionsRef.current.set(cueKey, text);
    }
    const presentation: CuePresentation = { sticker, text };

    if (!enabledRef.current || (isCurrent && !isCurrent())) return presentation;
    const ctx = getCtx();
    if (!ctx) return presentation;

    if (!path) {
      if (tag === null || !NO_TONE_FALLBACK_CUE_TAGS[tag]) playAttention(isCurrent);
      return presentation;
    }

    stopVoice();
    const requestId = playRequestRef.current;
    const superseded = () => requestId !== playRequestRef.current || !enabledRef.current || (isCurrent !== undefined && !isCurrent());
    void (async () => {
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => {});
        if (superseded()) return;
      }
      try {
        let buffered = bufferCacheRef.current.get(path);
        if (!buffered) {
          buffered = getBytes(path)
            // decodeAudioData는 넘긴 버퍼를 떼어 가므로 캐시 원본 대신 사본을 넘긴다.
            .then((bytes) => ctx.decodeAudioData(bytes.slice(0)))
            .catch((error) => {
              bufferCacheRef.current.delete(path);
              throw error;
            });
          bufferCacheRef.current.set(path, buffered);
        }
        const buffer = await buffered;
        if (superseded()) return;

        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = buffer;
        source.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.82, ctx.currentTime);
        source.onended = () => {
          if (sourceRef.current === source) sourceRef.current = null;
        };
        sourceRef.current = source;
        source.start();
        previousVoicePathsRef.current.set(cueKey, path);
      } catch {
        // 음원을 못 받거나 못 풀었을 때도 음성이 없을 때와 같은 규칙이다 — 착수 알림은 tone으로 대신하지 않는다.
        if (superseded() || (tag !== null && NO_TONE_FALLBACK_CUE_TAGS[tag])) return;
        try {
          playTone(ctx);
        } catch {
          // AudioContext not available
        }
      }
    })();
    return presentation;
  }, [getCtx, playAttention, stopVoice, getManifest, getBytes]);

  return {
    soundEnabled: enabled,
    onSoundToggle: toggle,
    playCueSound: playCue,
    preloadCueSound: preloadCue,
    unlockAudio,
    soundEnabledRef: enabledRef,
  };
}
