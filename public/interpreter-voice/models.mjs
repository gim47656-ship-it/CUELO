// Runtime code, WASM and weights are downloaded only when the new voice engine starts.
const SPEAKER = "https://cdn.jsdelivr.net/npm/@sherpaw/speaker-identification@0.3.0/dist/";
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
export const VOICE_ASSETS = {
  speakerApi: { url: SPEAKER + "index.js", sha: "6e08027a1422d9349d362793d8656db5e5d280ac6f83b5ef451a672eccfa2ca7", bytes: 8924 },
  speakerRuntime: { url: SPEAKER + "speaker-embedding-BE5WdKB1.js", sha: "c6444e9209125dcbb4587b01933f31138dab3f4c2e0b3ee1bf188a1f87df4455", bytes: 96802 },
  speakerWasm: { url: SPEAKER + "prebuilt/speaker-embedding.wasm", sha: "f485670f5a6bd413fa13cec0b876ec942c0fae31fd6f1631c8fb15079ab91788", bytes: 12336261 },
  speakerModel: { url: "https://huggingface.co/moeru-ai/sherpaw-campplus-zh-en-advanced/resolve/5fc23543ac94200ae77514cf1c40596c5d70f6e8/install/bin/wasm/preload.data", sha: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2", bytes: 28281164 },
  overlapApi: { url: ORT + "ort.wasm.min.mjs", sha: "c21d9c326d453a4a61398270c804d5979e118540597cb0c07f7b3d64e6098234", bytes: 53725 },
  overlapRuntime: { url: ORT + "ort-wasm-simd-threaded.mjs", sha: "30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3", bytes: 24738 },
  overlapWasm: { url: ORT + "ort-wasm-simd-threaded.wasm", sha: "4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d", bytes: 14848852 },
  overlapModel: { url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/model.onnx", sha: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079", bytes: 5992913 },
};
export async function verifiedAsset(asset, progress = () => {}) {
  let cache;
  try { cache = await caches.open("cuelo-voice-models-v1"); } catch { /* Private browsing can disable Cache Storage. */ }
  const cached = await cache?.match(asset.url);
  const response = cached ?? await fetch(asset.url);
  if (!response.ok) throw new Error(`Voice asset download failed (${response.status})`);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length; progress(size, asset.bytes);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (digest !== asset.sha) throw new Error("Voice asset integrity check failed");
  if (!cached) { try { await cache?.put(asset.url, new Response(bytes)); } catch { /* Quota failure does not prevent this session. */ } }
  return bytes;
}
export async function loadSpeaker(progress) {
  const names = ["speakerApi", "speakerRuntime", "speakerWasm", "speakerModel"];
  const loaded = new Map();
  const values = await Promise.all(names.map((name) => verifiedAsset(VOICE_ASSETS[name], (size) => {
    loaded.set(name, size);
    progress([...loaded.values()].reduce((a, b) => a + b, 0), names.reduce((n, key) => n + VOICE_ASSETS[key].bytes, 0));
  })));
  const urls = values.slice(0, 2).map((bytes) => URL.createObjectURL(new Blob([bytes], { type: "text/javascript" })));
  try {
    const [{ createExtractor }, { default: init }] = await Promise.all(urls.map((url) => import(url)));
    const runtime = await init({ wasmBinary: values[2], locateFile: () => VOICE_ASSETS.speakerWasm.url });
    runtime.FS_createDataFile("/", "speaker.onnx", values[3], true, false);
    return createExtractor(runtime, { model: "speaker.onnx" });
  } finally { for (const url of urls) URL.revokeObjectURL(url); }
}
export async function loadOverlap() {
  const values = await Promise.all(["overlapApi", "overlapRuntime", "overlapWasm", "overlapModel"].map((key) => verifiedAsset(VOICE_ASSETS[key])));
  const urls = values.slice(0, 3).map((bytes, i) => URL.createObjectURL(new Blob([bytes], { type: i === 2 ? "application/wasm" : "text/javascript" })));
  try {
    const ort = await import(urls[0]);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { mjs: urls[1], wasm: urls[2] };
    const session = await ort.InferenceSession.create(values[3], { executionProviders: ["wasm"] });
    return { ort, session };
  } finally { for (const url of urls) URL.revokeObjectURL(url); }
}
