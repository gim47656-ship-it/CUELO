import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setTimeout as settle } from "node:timers/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { useAudio } = await jiti.import("./useAudio.ts");
const { CUE_MANIFEST_PATH } = await jiti.import("../lib/completion-audio.ts");

const MANIFEST = {
  characters: [
    {
      id: "yuki",
      clips: [
        { file: "yuki/01.wav", tag: "done", ko: "끝났어. 확인해 봐." },
        { file: "yuki/02.wav", tag: "done", ko: "다 됐어. 기다렸지." },
        { file: "yuki/failed/01.wav", tag: "failed", ko: "미안, 실패했어." },
      ],
      stickers: [
        { file: "yuki/completed/01.png", tag: "done" },
        { file: "yuki/completed/02.png", tag: "done" },
      ],
      captions: [
        { tag: "working", ko: "좀 걸리는 일이야." },
        // 음성이 있는 태그의 자막 전용 대사는 쓰이지 않는다 — 소리와 자막이 어긋나지 않게.
        { tag: "done", ko: "쓰이면 안 되는 대사" },
      ],
    },
  ],
};

function renderAudioHook() {
  let result;
  function Harness() {
    result = useAudio();
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  return result;
}

function fakeContext(initialState = "running") {
  const sources = [];
  const oscillators = [];
  const context = {
    state: initialState,
    currentTime: 0,
    destination: {},
    resumeCalls: 0,
    resume() {
      this.resumeCalls += 1;
      this.state = "running";
      return Promise.resolve();
    },
    decodeAudioData() {
      return Promise.resolve({ decoded: true });
    },
    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        started: false,
        stopped: false,
        connect() {},
        start() { this.started = true; },
        stop() { this.stopped = true; },
      };
      sources.push(source);
      return source;
    },
    createOscillator() {
      const oscillator = {
        type: "sine",
        frequency: { value: 0 },
        started: false,
        connect() {},
        start() { this.started = true; },
        stop() {},
      };
      oscillators.push(oscillator);
      return oscillator;
    },
    createGain() {
      return {
        connect() {},
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
      };
    },
  };
  return { context, sources, oscillators };
}

/** 매니페스트는 실제 JSON으로, 음원은 통과하는 응답으로 답하는 fetch 대역. */
function manifestFetch(fetched, { failAudio = false } = {}) {
  return async (url) => {
    fetched.push(url);
    if (url === CUE_MANIFEST_PATH) {
      return { ok: true, json: async () => MANIFEST };
    }
    if (failAudio) throw new Error("missing asset");
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
  };
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}

test("suspended AudioContext를 재개하고 같은 태그의 직전 음원·스티커를 연속으로 쓰지 않는다", async () => {
  const previousAudioContext = globalThis.AudioContext;
  const previousFetch = globalThis.fetch;
  const previousRandom = Math.random;
  const { context, sources } = fakeContext("suspended");
  const fetched = [];
  globalThis.AudioContext = class { constructor() { return context; } };
  globalThis.fetch = manifestFetch(fetched);
  Math.random = () => 0;

  try {
    const audio = renderAudioHook();
    const first = await audio.playCueSound("YUKI(유키)");
    await settle(0);
    const second = await audio.playCueSound("YUKI(유키)");
    await settle(0);

    assert.equal(context.resumeCalls, 1);
    assert.deepEqual(fetched.filter((url) => url !== CUE_MANIFEST_PATH), [
      "/audio/completion/yuki/01.wav",
      "/audio/completion/yuki/02.wav",
    ]);
    assert.equal(sources.length, 2);
    assert.equal(sources[0].stopped, true, "다음 알림이 이전 음성을 중단한다");
    assert.equal(sources[1].started, true);
    assert.deepEqual(first, { sticker: "/stickers/yuki/completed/01.png", text: "끝났어. 확인해 봐." });
    assert.deepEqual(second, { sticker: "/stickers/yuki/completed/02.png", text: "다 됐어. 기다렸지." });
  } finally {
    restoreGlobal("AudioContext", previousAudioContext);
    restoreGlobal("fetch", previousFetch);
    Math.random = previousRandom;
  }
});

test("이벤트가 고른 태그의 음성만 내보내고, 그 태그에 자산이 없으면 중립 tone으로 물러난다", async () => {
  const previousAudioContext = globalThis.AudioContext;
  const previousFetch = globalThis.fetch;
  const { context, oscillators } = fakeContext();
  const fetched = [];
  globalThis.AudioContext = class { constructor() { return context; } };
  globalThis.fetch = manifestFetch(fetched);

  try {
    const audio = renderAudioHook();
    const failed = await audio.playCueSound("YUKI(유키)", "failed");
    await settle(0);
    assert.deepEqual(fetched.filter((url) => url !== CUE_MANIFEST_PATH), [
      "/audio/completion/yuki/failed/01.wav",
    ]);
    assert.deepEqual(failed, { sticker: null, text: "미안, 실패했어." }, "스티커가 없어도 대사는 화면에 남는다");

    await audio.playCueSound("YUKI(유키)", "blocked");
    await audio.playCueSound("UNKNOWN", "done");
    await audio.playCueSound(null, null);
    assert.equal(oscillators.length, 6, "자산이 없는 태그와 태그 없는 중립음마다 기존 2음 tone을 한 번 재생한다");

    const working = await audio.playCueSound("YUKI(유키)", "working");
    assert.deepEqual(working, { sticker: null, text: "좀 걸리는 일이야." }, "음성 없는 태그는 자막 전용 대사를 띄운다");
    assert.equal(oscillators.length, 6, "working은 무음 계약이라 자산이 없어도 tone으로 물러나지 않는다");
  } finally {
    restoreGlobal("AudioContext", previousAudioContext);
    restoreGlobal("fetch", previousFetch);
  }
});

test("음원 fetch 실패와 알 수 없는 캐릭터는 기존 중립 tone으로 돌아간다", async () => {
  const previousAudioContext = globalThis.AudioContext;
  const previousFetch = globalThis.fetch;
  const { context, oscillators } = fakeContext();
  globalThis.AudioContext = class { constructor() { return context; } };
  globalThis.fetch = manifestFetch([], { failAudio: true });

  try {
    const audio = renderAudioHook();
    await audio.playCueSound("YUKI(유키)");
    await settle(0);
    await audio.playCueSound("UNKNOWN");

    assert.equal(oscillators.length, 4, "각 fallback은 기존 2음 tone을 한 번 재생한다");
  } finally {
    restoreGlobal("AudioContext", previousAudioContext);
    restoreGlobal("fetch", previousFetch);
  }
});

test("음소거는 재생만 막고, 말풍선에 쓸 대사는 그대로 돌려준다", async () => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const previousAudioContext = globalThis.AudioContext;
  const previousFetch = globalThis.fetch;
  const previousRandom = Math.random;
  let contexts = 0;
  const fetched = [];
  const localStorage = {
    getItem: () => "false",
    setItem() {},
  };
  globalThis.window = { localStorage };
  globalThis.localStorage = localStorage;
  globalThis.AudioContext = class { constructor() { contexts += 1; } };
  globalThis.fetch = manifestFetch(fetched);
  Math.random = () => 0;

  try {
    const audio = renderAudioHook();
    const cue = await audio.playCueSound("YUKI(유키)");

    assert.equal(audio.soundEnabled, false);
    assert.deepEqual(cue, { sticker: "/stickers/yuki/completed/01.png", text: "끝났어. 확인해 봐." });
    assert.equal(contexts, 0, "소리를 끈 상태에서 AudioContext를 만들지 않는다");
    assert.deepEqual(fetched, [CUE_MANIFEST_PATH], "음원은 받지 않고 대사 목록만 읽는다");
  } finally {
    restoreGlobal("window", previousWindow);
    restoreGlobal("localStorage", previousLocalStorage);
    restoreGlobal("AudioContext", previousAudioContext);
    restoreGlobal("fetch", previousFetch);
    Math.random = previousRandom;
  }
});

test("제스처 전 resume()이 끝나지 않아도 스티커·대사는 바로 오고, 풀린 소리는 트리거가 유효할 때만 난다", async () => {
  const previousAudioContext = globalThis.AudioContext;
  const previousFetch = globalThis.fetch;
  const { context, sources, oscillators } = fakeContext("suspended");
  const pending = [];
  context.resume = function resume() {
    this.resumeCalls += 1;
    const { promise, resolve } = Promise.withResolvers();
    pending.push(() => { this.state = "running"; resolve(); });
    return promise;
  };
  globalThis.AudioContext = class { constructor() { return context; } };
  globalThis.fetch = manifestFetch([]);

  try {
    const audio = renderAudioHook();
    let current = true;
    const stale = await audio.playCueSound("YUKI(유키)", "done", () => current);
    assert.ok(MANIFEST.characters[0].clips.some((clip) => clip.tag === "done" && clip.ko === stale.text), "resume이 끝나기 전에 선택한 대사가 온다");
    assert.ok(MANIFEST.characters[0].stickers.some((sticker) => `/stickers/${sticker.file}` === stale.sticker), "스티커도 소리보다 먼저 온다");
    current = false;
    pending.shift()();
    await settle(0);
    assert.equal(sources.length, 0, "그 사이 턴이 바뀐 큐는 풀려도 소리를 내지 않는다");
    assert.equal(oscillators.length, 0);

    context.state = "suspended";
    await audio.playCueSound("YUKI(유키)", "failed", () => true);
    pending.shift()();
    await settle(0);
    assert.equal(sources.length, 1, "같은 트리거가 유효하면 풀린 뒤 소리를 낸다");
    assert.equal(sources[0].started, true);
  } finally {
    restoreGlobal("AudioContext", previousAudioContext);
    restoreGlobal("fetch", previousFetch);
  }
});
