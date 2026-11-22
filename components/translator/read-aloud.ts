import type { TranslatorLanguage } from "@/lib/translator-languages";

/** Resolves at the end of playback. An interrupted native utterance isn't a reason to speak twice. */
export async function readAloud(text: string, language: TranslatorLanguage, signal: AbortSignal,
  context: () => AudioContext, onStart?: () => void) {
  signal.throwIfAborted();
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
  await ctx.resume();
  const response = await fetch("/api/live/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal });
  if (!response.ok) throw new Error("Speech unavailable");
  const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
  signal.throwIfAborted();
  const source = ctx.createBufferSource(); source.buffer = buffer; source.connect(ctx.destination);
  const done = Promise.withResolvers<void>();
  source.onended = () => done.resolve();
  const cancel = () => { source.stop(); done.resolve(); };
  try {
    onStart?.(); source.start(); signal.addEventListener("abort", cancel, { once: true }); await done.promise;
  } finally { signal.removeEventListener("abort", cancel); source.disconnect(); }
}
