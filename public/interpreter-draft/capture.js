// AudioWorklet for the interpreter's quick draft captions: collects the microphone as PCM16 mono in
// fixed chunks (the context runs at 24 kHz, the rate the dedicated translation model takes) and hands
// each chunk to the page. `{ muted }` messages from the page zero the audio at once; the page sends
// them when the echo guard blocks the microphone, so the drafts hear exactly what Codex hears.
class InterpreterDraftCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.chunkSamples;
    this.chunk = new Int16Array(this.size);
    this.filled = 0;
    this.muted = false;
    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.muted === "boolean") this.muted = event.data.muted;
    };
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    // Without input (the track ended) the frame counts as silence, so the chunk clock keeps running.
    const frames = input ? input.length : 128;
    for (let i = 0; i < frames; i += 1) {
      const sample = this.muted || !input ? 0 : Math.max(-1, Math.min(1, input[i]));
      this.chunk[this.filled] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.filled += 1;
      if (this.filled === this.size) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("interpreter-draft-capture", InterpreterDraftCapture);
