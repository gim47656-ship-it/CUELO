import { loadSpeaker, loadOverlap } from "./models.mjs";
let extractor, overlap;
const vectors = new Map();
function similarity(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function enroll(side, samples) {
  if (!extractor || samples.length < 16000) return false;
  const next = extractor.extract(samples.subarray(0, 48000), 16000);
  const old = vectors.get(side);
  if (old) { for (let i = 0; i < next.length; i++) next[i] = (old[i] + next[i]) / 2; }
  vectors.set(side, next);
  return true;
}
let running = false;
self.onmessage = async ({ data }) => {
  if (data.type === "init") {
    let speakerLoading = true;
    void loadSpeaker((loaded, total) => { if (speakerLoading) postMessage({ type: "progress", percent: Math.min(99, Math.round(100 * loaded / total)) }); })
      .then((value) => { speakerLoading = false; extractor = value; postMessage({ type: "speaker-ready" }); })
      .catch(() => { speakerLoading = false; postMessage({ type: "speaker-failed" }); });
    void loadOverlap().then((value) => { overlap = value; postMessage({ type: "overlap-ready" }); })
      .catch(() => postMessage({ type: "overlap-failed" }));
  } else if (data.type === "reset") {
    vectors.clear();
  } else if (data.type === "remove") {
    vectors.delete(data.side);
  } else if (data.type === "enroll") {
    try { postMessage({ type: "enrolled", side: data.side, ok: enroll(data.side, data.samples) }); }
    catch { postMessage({ type: "enrolled", side: data.side, ok: false }); }
  } else if (data.type === "analyze" && !running) {
    running = true;
    const start = performance.now();
    try {
      const samples = data.samples;
      const matches = [];
      let speakerMs = 0, overlapMs = 0, overlapFrames = 0, speechFrames = 0;
      let recentEnergy = 0;
      for (let i = Math.max(0, samples.length - 6400); i < samples.length; i++) recentEnergy += samples[i] * samples[i];
      if (extractor && samples.length >= 16000 && recentEnergy / 6400 >= 0.000144) {
        const at = performance.now();
        const embedding = extractor.extract(samples.subarray(samples.length - 16000), 16000);
        speakerMs = performance.now() - at;
        for (const [side, vector] of vectors) matches.push({ side, score: similarity(embedding, vector) });
      }
      if (overlap && samples.length >= 16000) {
        const at = performance.now();
        const { session, ort } = overlap;
        const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", samples, [1, 1, samples.length]) });
        const value = outputs[session.outputNames[0]], scores = value.data, classes = value.dims.at(-1);
        for (let offset = 0; offset < scores.length; offset += classes) {
          let best = 0;
          for (let i = 1; i < classes; i++) if (scores[offset + i] > scores[offset + best]) best = i;
          if (best !== 0) speechFrames++;
          if (best >= 4) overlapFrames++;
        }
        overlapMs = performance.now() - at;
      }
      postMessage({ type: "analysis", endMs: data.endMs, epoch: data.epoch, matches, overlapFrames, speechFrames, speakerMs, overlapMs, ms: performance.now() - start });
    } catch { postMessage({ type: "analysis-error" }); }
    finally { running = false; }
  }
};
