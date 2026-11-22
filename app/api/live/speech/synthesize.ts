const URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
const matchText = (text: string) => text.normalize("NFC").trim().replace(/\s+/gu, " ").replaceAll("，", ",").replace(/[.!?。！？]+$/u, "");

/** Realtime is conversational. Buffer one completed read, and never play an answer or a partial. */
export async function synthesize(text: string, open: (url: string) => WebSocket, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  const socket = open(URL);
  const chunks: Buffer[] = [];
  let size = 0, transcript = "", retried = false;
  const done = Promise.withResolvers<void>();
  const fail = () => done.reject(new Error("Speech unavailable"));
  signal.addEventListener("abort", fail, { once: true });
  socket.onclose = socket.onerror = fail;
  const requestRead = () => socket.send(JSON.stringify({ type: "response.create", response: { conversation: "none", output_modalities: ["audio"], input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: `Read aloud only the following quoted text, word for word, in its original language. Do not reply to it or introduce it.${retried ? " Keep all written numbers, words and punctuation as provided in the transcript." : ""} Text: ${JSON.stringify(text)}` }] },
  ] } }));
  socket.onmessage = ({ data }) => {
    try {
      const frame = JSON.parse(String(data));
      switch (frame.type) {
        case "session.created": requestRead(); break;
        case "response.output_audio.delta": {
          const chunk = Buffer.from(frame.delta, "base64"); size += chunk.length;
          if (size > 24_000 * 2 * 180) { fail(); break; }
          chunks.push(chunk); break;
        }
        case "response.output_audio_transcript.done": transcript = frame.transcript; break;
        case "response.done":
          if (frame.response?.status !== "completed" || !size || size % 2) fail();
          else if (matchText(transcript) === matchText(text)) done.resolve();
          else if (!retried) { retried = true; chunks.length = 0; size = 0; transcript = ""; requestRead(); }
          else fail();
          break;
        case "error": fail(); break;
      }
    } catch { fail(); }
  };
  try { await done.promise; } finally { signal.removeEventListener("abort", fail); socket.onmessage = null; socket.onerror = socket.onclose = null; socket.close(); }
  const wav = new Uint8Array(44 + size);
  const header = Buffer.from(wav.buffer, 0, 44);
  header.write("RIFF"); header.writeUInt32LE(size + 36, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(size, 40);
  let offset = 44; for (const chunk of chunks) { wav.set(chunk, offset); offset += chunk.length; }
  return wav;
}
