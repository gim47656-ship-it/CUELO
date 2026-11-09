import type { InterpreterTextEvent } from "@/lib/translator-context";

/** Decode our POST SSE channel across arbitrary byte/UTF-8 boundaries; EOF is not success. */
export async function* readInterpreterTextEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<InterpreterTextEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!frame.startsWith("data: ")) throw new Error("Invalid interpreter stream frame");
        const event = JSON.parse(frame.slice(6)) as InterpreterTextEvent;
        if (!event || (event.type !== "delta" && event.type !== "done" && event.type !== "error")) throw new Error("Invalid interpreter stream event");
        if (event.type === "delta" && typeof event.text !== "string") throw new Error("Invalid interpreter delta");
        if (event.type === "done" && (typeof event.text !== "string" || !event.text.trim() || typeof event.source !== "string" || typeof event.target !== "string")) throw new Error("Invalid interpreter completion");
        if (event.type === "error" && event.error !== "live-auth" && event.error !== "live-upstream") throw new Error("Invalid interpreter failure");
        yield event;
        if (event.type !== "delta") return;
      }
      if (chunk.done) throw new Error("Interpreter stream ended before completion");
    }
  } finally {
    await reader.cancel().catch(() => { /* The fetch may already have been aborted by a mode change. */ });
    reader.releaseLock();
  }
}
