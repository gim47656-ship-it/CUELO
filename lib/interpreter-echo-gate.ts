/**
 * 통역 음성이 폰 스피커로 나와 마이크에 다시 들어가면, 통역 모델은 그것을 새 말로 듣고 한 번 더
 * 옮긴다(2026-10-26 사용자 실통화, Codex: 영어·한국어를 번갈아 쓸 때 같은 말을 두 번 함). 브라우저
 * 에코 제거가 대부분 거르지만 스피커가 크면 남는다. 이 문은 통역 음성이 나오는 동안과 끝난 뒤
 * `holdMs` 동안 마이크를 막는다. 그 사이 상대가 한 말도 막힌다(사용자가 고른 대가, 설정으로 끈다).
 */

/**
 * 통역 음성이 끝난 뒤에도 마이크를 막아 두는 시간. 재생 장치 지연과 방 울림이 남는 동안이고,
 * 한 통역 안의 낱말 사이 쉼에 마이크가 열렸다 닫히지 않게 이어 준다.
 */
export const ECHO_HOLD_MS = 500;

/** 원격 통역 음성이 들린다고 볼 RMS(약 -40 dBFS). 말 사이 무음·잡음은 이보다 훨씬 작다. */
export const REMOTE_SPEECH_RMS = 0.01;

export class EchoGate {
  readonly #holdMs: number;
  #lastPlayingAt = Number.NEGATIVE_INFINITY;

  constructor(holdMs = ECHO_HOLD_MS) {
    this.#holdMs = holdMs;
  }

  /** `playing`: the interpreted voice is audible at `now` (ms). Returns whether the microphone stays blocked. */
  update(playing: boolean, now: number): boolean {
    if (playing) this.#lastPlayingAt = now;
    return now - this.#lastPlayingAt < this.#holdMs;
  }

  /** Forget the last playback, e.g. when a call is replaced and nothing is queued any more. */
  reset(): void {
    this.#lastPlayingAt = Number.NEGATIVE_INFINITY;
  }
}

/** Root mean square of one block of samples in [-1, 1]. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}
