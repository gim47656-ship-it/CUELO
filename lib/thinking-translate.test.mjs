import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { needsKoreanTranslation } = await jiti.import("./thinking-korean.ts");
const { cleanTranslation, createThinkingTranslator } = await jiti.import("./thinking-translate.ts");

const ENGLISH = "I need to check the session reader before touching the sidebar grouping logic.";

function withCacheDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "cuelo-thinking-ko-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("only mostly-English prose is translated; code, literals and short blocks are not", () => {
  assert.equal(needsKoreanTranslation(ENGLISH), true);
  assert.equal(needsKoreanTranslation("세션 리더를 먼저 확인하고 `sessionActivityTime` 경로를 고친다."), false);
  assert.equal(needsKoreanTranslation("Fix it."), false);
  assert.equal(needsKoreanTranslation("사이드바 묶음 확인\n```ts\nconst sessionActivityTime = readActivityBeforeSessionExit(file, stats);\n```"), false);
});

test("a translation is cached on disk and concurrent requests share one call", () => withCacheDir(async (cacheDir) => {
  let calls = 0;
  const call = async () => { calls += 1; return "번역: 세션 리더부터 봐야겟다."; };
  const first = createThinkingTranslator({ cacheDir, call });
  const [a, b] = await Promise.all([first(ENGLISH), first(ENGLISH)]);
  assert.equal(a, "세션 리더부터 봐야겟다.");
  assert.equal(b, a);
  assert.equal(calls, 1);
  assert.equal(readdirSync(cacheDir).filter((name) => name.endsWith(".md")).length, 1);

  const restarted = createThinkingTranslator({ cacheDir, call });
  assert.equal(await restarted(ENGLISH), a);
  assert.equal(calls, 1, "a new server process reads the disk cache");
}));

test("a failed attempt is retried once, then the error surfaces and nothing is cached", () => withCacheDir(async (cacheDir) => {
  let calls = 0;
  const flaky = createThinkingTranslator({ cacheDir, call: async () => { calls += 1; if (calls === 1) throw new Error("truncated"); return "고쳣어."; } });
  assert.equal(await flaky(ENGLISH), "고쳣어.");
  assert.equal(calls, 2);

  const broken = createThinkingTranslator({ cacheDir: join(cacheDir, "broken"), call: async () => { throw new Error("no credentials"); } });
  await assert.rejects(broken(`${ENGLISH} again`), /no credentials/);
  assert.deepEqual(readdirSync(cacheDir).filter((name) => name.endsWith(".md")).length, 1);
}));

test("a slow first request is hedged and the first success wins", () => withCacheDir(async (cacheDir) => {
  const signals = [];
  let calls = 0;
  const call = (_source, signal) => {
    calls += 1;
    signals.push(signal);
    if (calls === 1) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    return Promise.resolve("두 번째 요청이 먼저 왓어.");
  };
  const translate = createThinkingTranslator({ cacheDir, call, hedgeAfterMs: 5 });
  assert.equal(await translate(ENGLISH), "두 번째 요청이 먼저 왓어.");
  assert.equal(calls, 2);
  assert.equal(signals[0].aborted, true, "the losing request is cancelled");
}));

test("model headers are stripped only when certain", () => {
  assert.equal(cleanTranslation("\n번역:\n고쳣어.\n"), "고쳣어.");
  assert.equal(cleanTranslation("번역: 고쳣어."), "고쳣어.");
  assert.equal(cleanTranslation("번역 품질을 먼저 봐야겟다."), "번역 품질을 먼저 봐야겟다.");
});
