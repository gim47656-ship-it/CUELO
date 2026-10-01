import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { LIVE_VOICE_CHARACTERS, parseLiveVoiceManifest } = await jiti.import("./live-voice-manifest.ts");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const liveDir = path.join(projectRoot, "public", "audio", "live");

function entry(overrides = {}) {
  return {
    id: "yuki",
    alias: "YUKI(유키)",
    reference: "yuki-reference.wav",
    referenceLanguage: "ja",
    referenceAccent: "standard-japanese",
    addAccents: ["korean"],
    generation: { emotion: "excited", speed: 1.2, volume: 1 },
    tuning: "accepted",
    ...overrides,
  };
}

function manifest(characters) {
  return { version: 1, provider: "cartesia", model: "sonic-3.6", characters };
}

test("번들 매니페스트는 7캐릭터 모두 참조 음원이 있고 유키만 청취 확정 설정이다", () => {
  const parsed = parseLiveVoiceManifest(JSON.parse(readFileSync(path.join(liveDir, "voices.json"), "utf8")));
  assert.equal(parsed.model, "sonic-3.6");
  assert.deepEqual([...parsed.profiles.keys()].sort(), LIVE_VOICE_CHARACTERS.map(({ id }) => id).sort());
  for (const profile of parsed.profiles.values()) {
    assert.ok(existsSync(path.join(liveDir, profile.reference)), `${profile.reference} 파일이 있어야 한다`);
    assert.deepEqual(profile.addAccents, ["korean"], `${profile.id}는 한국어 억양을 더해야 통화에 쓴다`);
  }
  assert.deepEqual(parsed.profiles.get("yuki").generation, { emotion: "excited", speed: 1.2, volume: 1 });
  assert.equal(parsed.profiles.get("yuki").tuning, "accepted");
  const provisional = [...parsed.profiles.values()].filter((profile) => profile.tuning === "provisional").map(({ id }) => id);
  assert.deepEqual(provisional.sort(), ["hikari", "isana", "mio", "nova", "rin", "shion"]);
});

test("형식이 깨진 캐릭터 하나만 빠지고 나머지는 살아남는다", () => {
  const parsed = parseLiveVoiceManifest(manifest([
    entry(),
    entry({ id: "rin", alias: "RIN(린)", reference: "../secret.wav" }),
    entry({ id: "mio", alias: "MIO(미오)", reference: "mio-reference.wav", generation: { speed: 1.7 } }),
    entry({ id: "nova", alias: "NOVA(노바)", reference: "nova-reference.wav", generation: { emotion: "yelling" } }),
    entry({ id: "isana", alias: "MIO(미오)", reference: "isana-reference.wav" }),
    entry({ id: "hikari", alias: "HIKARI(히카리)", reference: "hikari-reference.wav", tuning: "final" }),
    entry({ id: "yuki", reference: "duplicate.wav" }),
    entry({ id: "shion", alias: "SHION(시온)", reference: "shion-reference.wav", generation: undefined, addAccents: undefined }),
  ]));
  assert.deepEqual([...parsed.profiles.keys()], ["yuki", "shion"]);
  assert.equal(parsed.profiles.get("yuki").reference, "yuki-reference.wav", "같은 id가 다시 와도 앞의 것을 지킨다");
  assert.deepEqual(parsed.profiles.get("shion").generation, { speed: 1, volume: 1 }, "생략한 생성 설정은 provider 기본값");
  assert.deepEqual(parsed.profiles.get("shion").addAccents, []);
});

test("모르는 provider·모델·버전은 매니페스트 전체를 쓰지 않는다", () => {
  assert.equal(parseLiveVoiceManifest({ ...manifest([entry()]), provider: "elevenlabs" }).profiles.size, 0);
  assert.equal(parseLiveVoiceManifest({ ...manifest([entry()]), model: "sonic-2" }).profiles.size, 0);
  assert.equal(parseLiveVoiceManifest({ ...manifest([entry()]), version: 2 }).profiles.size, 0);
  assert.equal(parseLiveVoiceManifest(null).profiles.size, 0);
});
