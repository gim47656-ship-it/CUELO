import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  COMPLETION_AUDIO_ALIASES,
  CUE_TAGS,
  CUE_MANIFEST_PATH,
  CUE_VISIBLE_MAX_MS,
  CUE_VISIBLE_MIN_MS,
  cueSetFor,
  cueForOutcome,
  cueVisibleMs,
  loadCueManifest,
  parseCueManifest,
  selectCueAsset,
} = await jiti.import("./completion-audio.ts");

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directories = ["yuki", "isana", "mio", "rin", "nova", "shion"];

const FIXTURE = {
  characters: [
    {
      id: "yuki",
      clips: [
        { file: "yuki/01.wav", tag: "done", ko: "끝났어. 확인해 봐." },
        { file: "yuki/02.wav", tag: "done", ko: "  다 됐어.  " },
        { file: "yuki/failed/01.wav", tag: "failed" },
      ],
      stickers: [
        { file: "yuki/completed/01.png", tag: "done" },
        { file: "yuki/failed/01.png", tag: "failed" },
      ],
      captions: [{ tag: "working", ko: "  좀 걸리는 일이야.  " }],
    },
    { id: "isana", clips: [{ file: "isana/01.wav" }] },
  ],
};

test("턴 종료를 사용자가 할 일로 옮기고, 알릴 것이 없으면 알리지 않는다", () => {
  assert.equal(cueForOutcome("completed"), "done");
  assert.equal(cueForOutcome("failed"), "failed");
  assert.equal(cueForOutcome("aborted"), null, "사용자가 방금 자기 손으로 멈춘 것은 되돌려줄 정보가 없다");
  assert.equal(cueForOutcome("unknown"), "neutral", "끝났는지 모르는 상태에 완료 대사를 내면 거짓말이 된다");
});

test("매니페스트를 캐릭터·태그별 세트로 읽고, 자산이 없는 태그도 빈 세트로 남긴다", () => {
  const manifest = parseCueManifest(FIXTURE);

  assert.deepEqual(cueSetFor(manifest, "YUKI(유키)", "done"), {
    voices: ["/audio/completion/yuki/01.wav", "/audio/completion/yuki/02.wav"],
    stickers: ["/stickers/yuki/completed/01.png"],
    lines: new Map([
      ["/audio/completion/yuki/01.wav", "끝났어. 확인해 봐."],
      ["/audio/completion/yuki/02.wav", "다 됐어."],
    ]),
    captions: [],
  });
  assert.deepEqual(cueSetFor(manifest, "YUKI(유키)", "failed"), {
    voices: ["/audio/completion/yuki/failed/01.wav"],
    stickers: ["/stickers/yuki/failed/01.png"],
    lines: new Map(),
    captions: [],
  }, "ko가 없는 클립은 자막 없이 소리만 난다");
  assert.deepEqual(cueSetFor(manifest, "YUKI(유키)", "approval"), { voices: [], stickers: [], lines: new Map(), captions: [] });
  assert.deepEqual(cueSetFor(manifest, "YUKI(유키)", "working"), {
    voices: [],
    stickers: [],
    lines: new Map(),
    captions: ["좀 걸리는 일이야."],
  }, "음성 없는 태그의 자막 전용 대사를 태그별로 읽는다");
  assert.deepEqual(cueSetFor(manifest, "ISANA(이사나)", "done"), {
    voices: ["/audio/completion/isana/01.wav"],
    stickers: [],
    lines: new Map(),
    captions: [],
  });

  assert.equal(cueSetFor(manifest, "UNKNOWN", "done"), null);
  assert.equal(cueSetFor(manifest, null, "done"), null);
  assert.deepEqual(cueSetFor(manifest, "ISANA(이사나)", "blocked"), { voices: [], stickers: [], lines: new Map(), captions: [] });
});

test("모르는 태그·형식이 어긋난 항목은 버리고 나머지 자산은 살린다", () => {
  const manifest = parseCueManifest({
    characters: [
      {
        id: "mio",
        clips: [
          { file: "mio/01.wav", tag: "cheerful" },
          { file: "", tag: "done" },
          { tag: "done" },
          { file: "mio/02.wav", tag: "approval" },
          "mio/03.wav",
        ],
        stickers: "mio/completed/01.png",
        captions: [
          { tag: "cheerful", ko: "모르는 태그" },
          { tag: "working", ko: "   " },
          { tag: "working" },
          { tag: "working", ko: "살아남는 자막" },
        ],
      },
      { clips: [{ file: "nope/01.wav" }] },
      null,
    ],
  });

  assert.deepEqual(cueSetFor(manifest, "MIO(미오)", "done"), { voices: [], stickers: [], lines: new Map(), captions: [] });
  assert.deepEqual(cueSetFor(manifest, "MIO(미오)", "approval"), {
    voices: ["/audio/completion/mio/02.wav"],
    stickers: [],
    lines: new Map(),
    captions: [],
  });
  assert.deepEqual(cueSetFor(manifest, "MIO(미오)", "working").captions, ["살아남는 자막"], "모르는 태그와 빈 ko 자막은 버린다");
  assert.equal(manifest.size, 1);
  assert.equal(parseCueManifest(null).size, 0);
  assert.equal(parseCueManifest({}).size, 0);
});

test("직전에 쓴 자산만 피해 고르고, 후보가 하나뿐이면 그 하나를 쓴다", () => {
  const assets = ["a.wav", "b.wav", "c.wav"];

  assert.equal(selectCueAsset(assets, null, () => 0), "a.wav");
  assert.equal(selectCueAsset(assets, "a.wav", () => 0), "b.wav");
  assert.equal(selectCueAsset(assets, "a.wav", () => 1), "c.wav");
  assert.equal(selectCueAsset(assets, "b.wav", () => 0), "a.wav");
  assert.equal(selectCueAsset(["only.png"], "only.png"), "only.png");
  assert.equal(selectCueAsset([], "a.wav"), null);
});

test("매니페스트 읽기 실패는 빈 매니페스트로 물러난다", async () => {
  const notOk = await loadCueManifest(async () => ({ ok: false }));
  const threw = await loadCueManifest(async () => {
    throw new Error("offline");
  });
  const served = await loadCueManifest(async (url) => {
    assert.equal(url, CUE_MANIFEST_PATH);
    return { ok: true, json: async () => FIXTURE };
  });

  assert.equal(notOk.size, 0);
  assert.equal(threw.size, 0);
  assert.deepEqual(cueSetFor(served, "YUKI(유키)", "done").voices.length, 2);
});

test("배포된 매니페스트는 태그 어휘를 지키고 선언한 음원 파일이 실제로 있다", async () => {
  const manifestPath = path.join(projectRoot, "public", "audio", "completion", "voices.json");
  const manifest = parseCueManifest(JSON.parse(await readFile(manifestPath, "utf8")));

  assert.equal(manifest.size, COMPLETION_AUDIO_ALIASES.length);
  COMPLETION_AUDIO_ALIASES.forEach((alias, index) => {
    const sets = manifest.get(directories[index]);
    assert.ok(sets, `${alias}의 태그 세트가 있어야 한다`);
    assert.deepEqual([...sets.keys()], [...CUE_TAGS]);
    assert.ok(sets.get("done").voices.length > 0, `${alias}의 완료 음원이 있어야 한다`);
    assert.ok(sets.get("working").voices.length > 0, `${alias}의 착수 음성이 있어야 한다`);
    assert.ok(sets.get("working").stickers.length > 0, `${alias}의 착수 스티커가 있어야 한다`);

    for (const tag of ["done", "failed", "approval", "choice"]) {
      const stickers = sets.get(tag).stickers;
      assert.ok(stickers.length >= 3, `${alias}의 ${tag} 스티커는 세 장 이상이어야 한다`);
      for (const previous of stickers) {
        for (const random of [0, 0.5, 1]) {
          assert.notEqual(selectCueAsset(stickers, previous, () => random), previous, `${alias} ${tag} 직전 그림 반복 방지`);
        }
      }
    }

    for (const tag of CUE_TAGS) {
      const set = sets.get(tag);
      for (const url of [...set.voices, ...set.stickers]) {
        assert.ok(existsSync(path.join(projectRoot, "public", url)), `${url} 파일이 있어야 한다`);
      }
      // 말풍선은 이 한국어를 읽는다. ko가 빠진 클립은 소리만 나고 화면에는 아무 말도 남지 않는다.
      for (const url of set.voices) {
        assert.ok(set.lines.get(url), `${url}의 한국어 대사가 있어야 한다`);
      }
      // 음성이 없는데 발화 지점이 있는 태그는 자막 전용 대사가 없으면 화면에 아무것도 못 띄운다.
      if (tag !== "blocked" && set.voices.length === 0) {
        assert.ok(set.captions.length > 0, `${alias}의 ${tag} 자막 대사가 있어야 한다`);
      }
    }
  });
});

test("말풍선은 대사가 길수록 오래 머물되 최소·최대 안에 있다", () => {
  assert.equal(cueVisibleMs(null), CUE_VISIBLE_MIN_MS, "스티커만 떠도 알아볼 시간은 준다");
  assert.equal(cueVisibleMs("끝났어."), CUE_VISIBLE_MIN_MS, "짧은 대사도 최소 시간 아래로 내려가지 않는다");
  assert.ok(cueVisibleMs("다 됐어. 확인해 보고 다음 걸 알려줘.") > CUE_VISIBLE_MIN_MS, "긴 대사는 읽을 시간을 더 준다");
  assert.equal(cueVisibleMs("가".repeat(200)), CUE_VISIBLE_MAX_MS, "아무리 길어도 화면을 계속 잡고 있지 않는다");
});
