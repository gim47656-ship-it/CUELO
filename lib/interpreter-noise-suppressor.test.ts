import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createNoiseSuppressor, RNNOISE_ASSETS } from "./interpreter-noise-suppressor";

const packageDist = "node_modules/@sapphi-red/web-noise-suppressor/dist/";
const publicFile = (url: string) => readFileSync(`public${url}`);

describe("RNNoise assets", () => {
  // The worklet and the wasm come from one package version; a bump that misses a copy would load a mismatched pair.
  test.each([
    ["worklet", RNNOISE_ASSETS.worklet, "rnnoise/workletProcessor.js"],
    ["wasm", RNNOISE_ASSETS.wasm, "rnnoise.wasm"],
    ["simd wasm", RNNOISE_ASSETS.simdWasm, "rnnoise_simd.wasm"],
  ])("the served %s is the installed package's file", (_name, url, packagePath) => {
    expect(publicFile(url).equals(readFileSync(packageDist + packagePath))).toBe(true);
  });
});

describe("createNoiseSuppressor", () => {
  test("rejects without AudioWorklet so the caller keeps the raw microphone", async () => {
    expect(typeof AudioWorkletNode).toBe("undefined");
    await expect(createNoiseSuppressor({} as MediaStream, () => {})).rejects.toThrow("not available");
  });
});

/**
 * Cancellation of a setup that is still loading (#78). The package import is the only faked module
 * (`@sapphi-red/web-noise-suppressor`, which the "not available" test above never reaches); the
 * helper under test is the real one. `AudioWorkletNode` cannot be aborted by the spec, so its
 * returned promise is the one that stalls here, and an abort must not wait for it.
 */
const globals = globalThis as unknown as Record<string, unknown>;
const originals = {
  AudioContext: globals.AudioContext,
  AudioWorkletNode: globals.AudioWorkletNode,
};

const deferred = <T>(): Deferred<T> => Promise.withResolvers<T>();
const flush = async (rounds = 60) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

const wasmMagic = new Uint8Array([0x00, 0x61, 0x73, 0x6d]).buffer;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface FakeContext {
  state: string;
  closeCalls: number;
  readonly sampleRate: number;
  readonly moduleGate: Deferred<void>;
}

interface FakeNode {
  destroyed: number;
  disconnected: number;
}

/** Records what the helper did to the audio graph, and stalls `addModule` or `resume` on request. */
function installNoiseFakes() {
  const contexts: FakeContext[] = [];
  const nodes: FakeNode[] = [];
  let resumeGate: Deferred<void> | null = null;

  class Context {
    state = "suspended";
    closeCalls = 0;
    readonly sampleRate = 48_000;
    readonly moduleGate = deferred<void>();
    readonly audioWorklet = { addModule: () => this.moduleGate.promise };
    constructor() {
      contexts.push(this);
    }
    async resume() {
      if (resumeGate) await resumeGate.promise;
      this.state = "running";
    }
    async close() {
      this.closeCalls += 1;
      this.state = "closed";
    }
    createMediaStreamSource() {
      return { connect: () => {}, disconnect: () => {} };
    }
    createGain() {
      return { connect: () => {}, disconnect: () => {}, gain: { setTargetAtTime: () => {} } };
    }
    createMediaStreamDestination() {
      return { connect: () => {}, stream: { getAudioTracks: () => [{ kind: "audio", stop: () => {} }] } };
    }
  }

  class WorkletNode {
    onprocessorerror: (() => void) | null = null;
    destroyed = 0;
    disconnected = 0;
    constructor() {
      nodes.push(this);
    }
    connect() {}
    disconnect() {
      this.disconnected += 1;
    }
    destroy() {
      this.destroyed += 1;
    }
  }

  globals.AudioContext = Context;
  globals.AudioWorkletNode = WorkletNode;
  mock.module("@sapphi-red/web-noise-suppressor", () => ({
    RnnoiseWorkletNode: WorkletNode,
    loadRnnoise: async () => wasmMagic,
  }));

  return {
    contexts,
    nodes,
    stallResume: () => {
      resumeGate = deferred<void>();
      return resumeGate;
    },
  };
}

const audioStream = { getAudioTracks: () => [{ kind: "audio" }] } as unknown as MediaStream;

afterEach(() => {
  for (const key of Object.keys(originals) as (keyof typeof originals)[]) {
    if (originals[key] === undefined) delete globals[key];
    else globals[key] = originals[key];
  }
});

describe("createNoiseSuppressor cancellation", () => {
  test("an abort while addModule is pending rejects at once and closes the context once", async () => {
    const fakes = installNoiseFakes();
    const abort = new AbortController();
    const outcome = createNoiseSuppressor(audioStream, () => {}, abort.signal).then(
      () => ({ settled: "resolved" as const }),
      (error: Error) => ({ settled: "rejected" as const, message: error.message }),
    );

    await flush();
    expect(fakes.contexts).toHaveLength(1);
    abort.abort();
    await flush();

    // The stalled addModule is still unresolved; the cancellation must not wait for it.
    expect(await outcome).toEqual({ settled: "rejected", message: "setup cancelled" });
    expect(fakes.contexts[0].state).toBe("closed");
    expect(fakes.contexts[0].closeCalls).toBe(1);
    expect(fakes.nodes).toHaveLength(0);
  });

  test("a module that loads after the abort creates no node and closes nothing twice", async () => {
    const fakes = installNoiseFakes();
    const abort = new AbortController();
    const outcome = createNoiseSuppressor(audioStream, () => {}, abort.signal).then(
      () => "resolved",
      () => "cancelled",
    );
    await flush();
    expect(fakes.contexts).toHaveLength(1);

    abort.abort();
    expect(await outcome).toBe("cancelled");

    // The stalled module arrives only now, after the setup was cancelled and cleaned up.
    fakes.contexts[0].moduleGate.resolve();
    await flush(120);

    expect(fakes.nodes).toHaveLength(0);
    expect(fakes.contexts[0].closeCalls).toBe(1);
  });

  test("a module rejection after the abort stays handled and closes the context once", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const fakes = installNoiseFakes();
      const abort = new AbortController();
      const outcome = createNoiseSuppressor(audioStream, () => {}, abort.signal).then(
        () => "resolved",
        () => "cancelled",
      );
      await flush();
      expect(fakes.contexts).toHaveLength(1);

      abort.abort();
      expect(await outcome).toBe("cancelled");

      fakes.contexts[0].moduleGate.reject(new Error("synthetic late addModule rejection"));
      await flush(120);

      expect(unhandled).toEqual([]);
      expect(fakes.nodes).toHaveLength(0);
      expect(fakes.contexts[0].closeCalls).toBe(1);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  test("an abort while the context is resuming rejects without waiting for it", async () => {
    const fakes = installNoiseFakes();
    const resumeGate = fakes.stallResume();
    const abort = new AbortController();
    const outcome = createNoiseSuppressor(audioStream, () => {}, abort.signal).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    fakes.contexts[0].moduleGate.resolve();
    await flush();
    expect(fakes.contexts[0].state).toBe("suspended");

    abort.abort();

    expect(await outcome).toBe("setup cancelled");
    expect(fakes.contexts[0].closeCalls).toBe(1);
    expect(fakes.nodes).toHaveLength(0);
    // The resume that arrives after the cancellation still creates no node.
    resumeGate.resolve();
    await flush(60);
    expect(fakes.nodes).toHaveLength(0);
  });

  test("an already aborted signal rejects before any context is created", async () => {
    const fakes = installNoiseFakes();
    const abort = new AbortController();
    abort.abort();

    await expect(createNoiseSuppressor(audioStream, () => {}, abort.signal)).rejects.toThrow("setup cancelled");
    await flush();

    expect(fakes.contexts).toHaveLength(0);
    expect(fakes.nodes).toHaveLength(0);
  });

  test("a setup that completes keeps the denoised track and closes idempotently", async () => {
    const fakes = installNoiseFakes();
    const abort = new AbortController();
    const setup = createNoiseSuppressor(audioStream, () => {}, abort.signal);
    await flush();
    fakes.contexts[0].moduleGate.resolve();
    const suppressor = await setup;

    expect(suppressor.track).toBeDefined();
    expect(fakes.nodes).toHaveLength(1);
    // Aborting after a successful setup closes the graph and is safe to repeat.
    abort.abort();
    suppressor.close();
    suppressor.close();
    expect(fakes.contexts[0].closeCalls).toBe(1);
    expect(fakes.nodes[0].destroyed).toBe(1);
  });
});
