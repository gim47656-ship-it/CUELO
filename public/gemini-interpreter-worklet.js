/**
 * Gemini 통역의 마이크 캡처 AudioWorklet. 마이크는 기기 표본율(보통 48kHz)로 들어오고 Gemini Live는
 * 16kHz PCM16 little-endian을 받는다. 상자 평균으로 줄여(간단한 저역 통과 겸 decimation) 정해진 크기의
 * 프레임을 채우면 그 버퍼를 메인 스레드로 넘긴다(transfer). 표본마다 새 객체를 만들지 않는다.
 *
 * 같은 파일을 테스트가 모듈로 불러 `Pcm16Downsampler`를 직접 검사한다. `registerProcessor`는 worklet
 * 범위에만 있으므로 그때만 프로세서를 등록한다.
 */

export const GEMINI_INPUT_RATE = 16000;
/** 40 ms at 16 kHz: small enough for low latency, large enough to keep messages few. */
export const GEMINI_INPUT_FRAME_SAMPLES = 640;

export class Pcm16Downsampler {
  /**
   * @param {number} inputRate the capture context's sample rate
   * @param {(frame: ArrayBuffer) => void} emit receives each full frame; the buffer is handed over
   * @param {number} [outputRate]
   * @param {number} [frameSamples]
   */
  constructor(inputRate, emit, outputRate = GEMINI_INPUT_RATE, frameSamples = GEMINI_INPUT_FRAME_SAMPLES) {
    if (!(inputRate >= outputRate)) throw new RangeError(`input rate ${inputRate} is below ${outputRate}`);
    this.ratio = inputRate / outputRate;
    this.emit = emit;
    this.frameSamples = frameSamples;
    this.frame = new Int16Array(frameSamples);
    this.filled = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
  }

  /** @param {Float32Array} samples one render quantum of mono input */
  push(samples) {
    const ratio = this.ratio;
    for (let i = 0; i < samples.length; i += 1) {
      this.sum += samples[i];
      this.count += 1;
      this.phase += 1;
      if (this.phase < ratio) continue;
      this.phase -= ratio;
      const mean = this.sum / this.count;
      this.sum = 0;
      this.count = 0;
      const clamped = mean > 1 ? 1 : mean < -1 ? -1 : mean;
      this.frame[this.filled] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
      this.filled += 1;
      if (this.filled === this.frameSamples) {
        const full = this.frame.buffer;
        this.frame = new Int16Array(this.frameSamples);
        this.filled = 0;
        this.emit(full);
      }
    }
  }
}

if (typeof registerProcessor === "function" && typeof AudioWorkletProcessor === "function") {
  class GeminiCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      // `sampleRate` is a global of the AudioWorkletGlobalScope.
      this.downsampler = new Pcm16Downsampler(sampleRate, (frame) => this.port.postMessage(frame, [frame]));
    }

    process(inputs) {
      const channel = inputs[0]?.[0];
      if (channel) this.downsampler.push(channel);
      // Keep running while the node is connected; the output stays silent.
      return true;
    }
  }
  registerProcessor("gemini-capture", GeminiCaptureProcessor);
}
