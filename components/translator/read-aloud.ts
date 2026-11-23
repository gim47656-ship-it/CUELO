import type { TranslatorLanguage } from "@/lib/translator-languages";

/**
 * Resolves at the end of playback. An interrupted native utterance isn't a reason to speak twice.
 * `natural` asks the server for an ElevenLabs voice first; if that fails before any sound starts, the native
 * voice and the realtime fallback read it instead.
 */
export async function readAloud(text: string, language: TranslatorLanguage, signal: AbortSignal,
  context: () => AudioContext, onStart?: () => void, natural = false) {
  signal.throwIfAborted();
  if (natural) {
    let playing: Promise<void> | null = null;
    try {
      const ctx = context();
      playing = startBuffer(await fetchSpeech(text, signal, ctx, true), ctx, signal, onStart);
    } catch { /* No sound yet: read it the ordinary way. */ }
    signal.throwIfAborted();
    if (playing) return playing;
  }
  const synth = window.speechSynthesis;
  const voices = synth?.getVoices() ?? [];
  const tag = language.tag.toLowerCase();
  const voice = voices.find((v) => v.lang.toLowerCase().replaceAll("_", "-") === tag)
    ?? voices.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === language.code);
  if (voice) {
    const done = Promise.withResolvers<boolean>();
    const cancel = () => { done.resolve(true); synth.cancel(); };
    // Some engines lose end/error events. Release the queue without repeating a read that started.
    let timer = setTimeout(() => { done.resolve(false); synth.cancel(); }, 5000);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = language.tag; utterance.voice = voice;
      utterance.onstart = () => {
        if (signal.aborted) return;
        clearTimeout(timer);
        timer = setTimeout(() => { done.resolve(true); synth.cancel(); }, Math.max(15000, text.length * 500));
        onStart?.();
      };
      utterance.onend = () => done.resolve(true);
      utterance.onerror = ({ error }) => done.resolve(error === "canceled" || error === "interrupted");
      synth.speak(utterance);
      if (await done.promise) return;
    } catch { /* Native synthesis can throw synchronously as well as emit an error. */ }
    finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
  }
  signal.throwIfAborted();
  const ctx = context();
  await startBuffer(await fetchSpeech(text, signal, ctx, false), ctx, signal, onStart);
}

async function fetchSpeech(text: string, signal: AbortSignal, ctx: AudioContext, natural: boolean): Promise<AudioBuffer> {
  // A context waiting for an audio-start gesture must not hold a canceled read (or the queue behind it).
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try { await Promise.race([ctx.resume(), aborted.promise]); } finally { signal.removeEventListener("abort", onAbort); }
  const response = await fetch("/api/live/speech", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(natural ? { text, engine: "elevenlabs" } : { text }), signal });
  if (!response.ok) throw new Error("Speech unavailable");
  return ctx.decodeAudioData(await response.arrayBuffer());
}

/** Starts the buffer synchronously (throws if it cannot) and returns the end of playback. */
function startBuffer(buffer: AudioBuffer, ctx: AudioContext, signal: AbortSignal, onStart?: () => void): Promise<void> {
  signal.throwIfAborted();
  const source = ctx.createBufferSource(); source.buffer = buffer; source.connect(ctx.destination);
  const done = Promise.withResolvers<void>();
  source.onended = () => done.resolve();
  const cancel = () => { source.stop(); done.resolve(); };
  try { source.start(); } catch (error) { source.disconnect(); throw error; }
  signal.addEventListener("abort", cancel, { once: true });
  onStart?.();
  return done.promise.finally(() => { signal.removeEventListener("abort", cancel); source.disconnect(); });
}
