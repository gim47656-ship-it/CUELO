import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createLiveVoiceService, keyFingerprint, cloneMarker } = await jiti.import("./live-character-voice.ts");
const { CartesiaError } = await jiti.import("./cartesia.ts");

const API_KEY = "sk_car_test_0123456789abcdef";

function profile(id, alias) {
  return {
    id,
    alias,
    reference: `${id}-reference.wav`,
    referenceLanguage: "ja",
    referenceAccent: "standard-japanese",
    addAccents: ["korean"],
    generation: { emotion: "excited", speed: 1.2, volume: 1 },
    tuning: id === "yuki" ? "accepted" : "provisional",
  };
}

/** A fixture with two characters' assets; the rest of the roster has none. */
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "cuelo-live-voice-"));
  const assetDir = path.join(dir, "assets");
  const stateFile = path.join(dir, "agent", "cuelo-live-voices.json");
  
  
  
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(path.join(assetDir, "yuki-reference.wav"), Buffer.from("RIFF-yuki"));
  writeFileSync(path.join(assetDir, "rin-reference.wav"), Buffer.from("RIFF-rin"));
  writeFileSync(path.join(assetDir, "voices.json"), JSON.stringify({
    version: 1,
    provider: "cartesia",
    model: "sonic-3.6",
    characters: [profile("yuki", "YUKI(유키)"), profile("rin", "RIN(린)")],
  }));
  let key = API_KEY;
  const keys = {
    read: async () => key,
    write: async (value) => { key = value; },
    remove: async () => { key = undefined; },
  };
  return { dir, assetDir, stateFile, keys, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** In-memory Cartesia account. `fail` lets one call throw a chosen error. */
function fakeAccount() {
  const voices = new Map();
  const calls = [];
  let seq = 0;
  const fail = {};
  const client = {
    async verifyKey() { calls.push("verify"); if (fail.verify) throw fail.verify; },
    async listOwnedVoices() {
      calls.push("list");
      return [...voices.values()].map((voice) => ({ ...voice, accents: [...voice.accents] }));
    },
    async getVoice(id) {
      calls.push(`get:${id}`);
      const voice = voices.get(id);
      if (!voice) throw new CartesiaError("Cartesia 404: not found", "not-found", 404);
      return { ...voice, accents: [...voice.accents] };
    },
    async cloneVoice(request) {
      calls.push(`clone:${request.description}`);
      const id = `voice-${++seq}`;
      voices.set(id, {
        id,
        name: request.name,
        description: request.description,
        isOwner: true,
        accents: [{ accent: request.accent, isNative: true }],
      });
      if (fail.cloneAfterCreate) {
        const error = fail.cloneAfterCreate;
        fail.cloneAfterCreate = undefined;
        throw error;
      }
      if (fail.clone) throw fail.clone;
      return voices.get(id);
    },
    async addAccents(id, accents) {
      calls.push(`accents:${id}:${accents.join(",")}`);
      const voice = voices.get(id);
      for (const accent of accents) voice.accents.push({ accent, isNative: false });
      return voice;
    },
  };
  return { voices, calls, fail, client };
}

function service(fx, account) {
  return createLiveVoiceService({ assetDir: fx.assetDir, stateFile: fx.stateFile, keys: fx.keys, client: () => account.client });
}

const clones = (account) => account.calls.filter((call) => call.startsWith("clone:"));

test("상태 조회와 통화 계획은 provider를 부르지 않고 키 원문도 내보내지 않는다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  try {
    const subject = service(fx, account);
    const settings = await subject.settings();
    assert.deepEqual(account.calls, []);
    assert.equal(settings.configured, true);
    assert.equal(settings.keyHint, "sk_car_…cdef");
    assert.ok(!JSON.stringify(settings).includes(API_KEY));
    const states = Object.fromEntries(settings.characters.map((character) => [character.id, character.state]));
    assert.equal(states.yuki, "not-prepared");
    assert.equal(states.mio, "missing-asset", "참조 음원이 없는 캐릭터는 자산 없음");
    assert.deepEqual(await subject.planFor("YUKI(유키)"), { kind: "not-ready", alias: "YUKI(유키)" });
    assert.deepEqual(account.calls, []);
  } finally {
    fx.cleanup();
  }
});

test("준비는 캐릭터마다 비공개 복제 후 한국어 억양을 더하고, 다시 눌러도 새로 복제하지 않는다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  try {
    const subject = service(fx, account);
    await subject.prepare();
    await subject.idle();
    assert.equal(clones(account).length, 2);
    const settings = await subject.settings();
    assert.equal(settings.characters.find((character) => character.id === "yuki").state, "ready");
    assert.equal(settings.characters.find((character) => character.id === "rin").state, "ready");
    assert.ok(settings.acknowledgedAt);

    const plan = await subject.planFor("YUKI(유키)");
    assert.equal(plan.kind, "ready");
    assert.equal(plan.apiKey, API_KEY);
    assert.deepEqual(plan.profile.generation, { emotion: "excited", speed: 1.2, volume: 1 });

    account.calls.length = 0;
    await subject.prepare();
    await subject.idle();
    assert.deepEqual(account.calls, [], "준비된 캐릭터는 provider를 다시 부르지 않는다");
  } finally {
    fx.cleanup();
  }
});

test("상태 파일을 잃어도 소유 목록의 같은 표식 voice를 다시 쓰고 복제하지 않는다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  try {
    await (async () => {
      const subject = service(fx, account);
      await subject.prepare();
      await subject.idle();
    })();
    rmSync(fx.stateFile);
    account.calls.length = 0;
    const subject = service(fx, account);
    await subject.prepare();
    await subject.idle();
    assert.deepEqual(clones(account), []);
    assert.equal((await subject.planFor("RIN(린)")).kind, "ready");
  } finally {
    fx.cleanup();
  }
});

test("응답을 못 받은 복제는 같은 실행에서 다시 보내지 않고 목록으로 결과를 맞춘다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  try {
    const subject = service(fx, account);
    // provider는 만들었지만 응답이 끊겼다.
    account.fail.cloneAfterCreate = new CartesiaError("Cartesia 요청이 끝나지 않았습니다 (TimeoutError)", "ambiguous");
    await subject.prepare();
    await subject.idle();
    assert.equal(clones(account).length, 2, "유키 한 번(모호), 린 한 번 — 유키를 다시 보내지 않았다");
    assert.equal(account.voices.size, 2);
    assert.equal((await subject.planFor("YUKI(유키)")).kind, "ready", "목록에서 찾은 voice를 들였다");
  } finally {
    fx.cleanup();
  }
});

test("모호한 실패 뒤 목록에 없으면 확인 필요로 남기고 다음 준비가 목록 확인 뒤에야 복제한다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  try {
    const subject = service(fx, account);
    const realClone = account.client.cloneVoice;
    account.client.cloneVoice = async (request) => {
      account.calls.push(`clone:${request.description}`);
      throw new CartesiaError("Cartesia 503: unavailable", "ambiguous", 503);
    };
    await subject.prepare();
    await subject.idle();
    const yuki = (await subject.settings()).characters.find((character) => character.id === "yuki");
    assert.equal(yuki.state, "needs-check");
    assert.equal(clones(account).filter((call) => call.includes(" yuki ")).length, 1);

    account.client.cloneVoice = realClone;
    account.calls.length = 0;
    await subject.prepare();
    await subject.idle();
    const listIndex = account.calls.indexOf("list");
    const cloneIndex = account.calls.findIndex((call) => call.startsWith("clone:") && call.includes(" yuki "));
    assert.ok(listIndex !== -1 && listIndex < cloneIndex, "목록을 먼저 본 뒤 복제한다");
    assert.equal((await subject.planFor("YUKI(유키)")).kind, "ready");
  } finally {
    fx.cleanup();
  }
});

test("플랜이 복제를 막으면 멈추고 이유를 보이며 다른 캐릭터를 계속 시도하지 않는다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  try {
    const subject = service(fx, account);
    account.fail.clone = new CartesiaError("Cartesia 402: Payment required", "plan", 402);
    await subject.prepare();
    await subject.idle();
    const settings = await subject.settings();
    assert.match(settings.lastError, /Pro 이상/);
    assert.equal(clones(account).length, 1);
  } finally {
    fx.cleanup();
  }
});

test("들여온 voice는 추가 억양(is_native false)만 있어도 준비됨이고 다시 복제하지 않는다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  try {
    account.voices.set("private-yuki", {
      id: "private-yuki",
      name: "yuki",
      description: "",
      isOwner: true,
      accents: [{ accent: "standard-japanese", isNative: true }, { accent: "korean", isNative: false }],
    });
    
    mkdirSync(path.dirname(fx.stateFile), { recursive: true });
    writeFileSync(fx.stateFile, JSON.stringify({
      version: 1,
      accounts: { [keyFingerprint(API_KEY)]: { characters: { yuki: { voiceId: "private-yuki", imported: true } } } },
    }));
    const subject = service(fx, account);
    await subject.prepare();
    await subject.idle();
    assert.ok(!clones(account).some((call) => call.includes(" yuki ")));
    assert.ok(!account.calls.some((call) => call.startsWith("accents:private-yuki")), "이미 있는 억양은 다시 더하지 않는다");
    assert.equal((await subject.planFor("YUKI(유키)")).voiceId, "private-yuki");
  } finally {
    fx.cleanup();
  }
});

test("참조 음원이 바뀌면 그 캐릭터만 새 표식으로 다시 복제한다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  try {
    const subject = service(fx, account);
    await subject.prepare();
    await subject.idle();
    writeFileSync(path.join(fx.assetDir, "rin-reference.wav"), Buffer.from("RIFF-rin-v2-longer"));
    assert.equal((await subject.planFor("RIN(린)")).kind, "not-ready");
    account.calls.length = 0;
    await subject.prepare();
    await subject.idle();
    assert.deepEqual(clones(account).map((call) => call.split(" ")[3]), ["rin"]);
    const state = JSON.parse(readFileSync(fx.stateFile, "utf8"));
    const rin = state.accounts[keyFingerprint(API_KEY)].characters.rin;
    assert.equal(account.voices.get(rin.voiceId).description, cloneMarker("rin", rin.referenceSha256));
  } finally {
    fx.cleanup();
  }
});

test("깨진 상태 파일 위에서는 준비를 시작하지 않는다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  try {
    
    mkdirSync(path.dirname(fx.stateFile), { recursive: true });
    writeFileSync(fx.stateFile, "{not json");
    const subject = service(fx, account);
    await assert.rejects(subject.prepare());
    assert.deepEqual(account.calls, []);
    assert.equal(readFileSync(fx.stateFile, "utf8"), "{not json", "원본을 덮어쓰지 않는다");
  } finally {
    fx.cleanup();
  }
});

test("틀린 키는 저장하지 않는다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  try {
    const subject = service(fx, account);
    account.fail.verify = new CartesiaError("Cartesia 401: Unauthorized", "auth", 401);
    await assert.rejects(subject.saveKey("sk_car_wrong_key_value"), (error) => error.kind === "auth");
    assert.equal(await fx.keys.read(), API_KEY);
  } finally {
    fx.cleanup();
  }
});

test("키 읽기가 늦어도 동시에 누른 두 준비는 준비 실행 하나로 캐릭터마다 한 번만 복제한다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const read = fx.keys.read;
  fx.keys.read = async () => { await gate; return read(); };
  try {
    const subject = service(fx, account);
    const first = subject.prepare();
    const second = subject.prepare();
    unblock();
    await Promise.all([first, second]);
    await subject.idle();
    assert.equal(clones(account).length, 2, "캐릭터 두 개를 한 번씩만 복제");
    assert.equal(account.calls.filter((call) => call === "list").length, 1, "준비 실행은 하나뿐");
  } finally {
    fx.cleanup();
  }
});

test("키가 없는 준비는 그 자리에서 거절하고 다음 준비를 막지 않는다", async () => {
  const fx = fixture();
  const account = fakeAccount();
  try {
    const subject = service(fx, account);
    await fx.keys.remove();
    await assert.rejects(subject.prepare(), /API 키가 없습니다/);
    const settings = await subject.settings();
    assert.equal(settings.preparing, false);
    assert.equal(settings.lastError, null, "거절은 호출자에게 가고 진행 오류로 남지 않는다");
    await fx.keys.write(API_KEY);
    await subject.prepare();
    await subject.idle();
    assert.equal(clones(account).length, 2);
  } finally {
    fx.cleanup();
  }
});

test("provider가 오류 본문에 키를 되돌려도 오류 문구·저장 상태에 키가 남지 않는다", async () => {
  const { createCartesiaClient } = await jiti.import("./cartesia.ts");
  const echo = async () => new Response(JSON.stringify({ title: "Bad Request", message: `invalid key ${API_KEY}` }), { status: 400 });
  const error = await createCartesiaClient(API_KEY, echo).verifyKey().catch((caught) => caught);
  assert.ok(error instanceof CartesiaError);
  assert.ok(!error.message.includes(API_KEY));
  assert.match(error.message, /\[redacted\]/);

  const fx = fixture();
  try {
    const subject = createLiveVoiceService({ assetDir: fx.assetDir, stateFile: fx.stateFile, keys: fx.keys, client: (key) => createCartesiaClient(key, echo) });
    await subject.prepare();
    await subject.idle();
    assert.ok(!JSON.stringify(await subject.settings()).includes(API_KEY));
    assert.ok(!readFileSync(fx.stateFile, "utf8").includes(API_KEY));
  } finally {
    fx.cleanup();
  }
});
