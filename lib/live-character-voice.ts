import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { CartesiaError, createCartesiaClient, type CartesiaClient, type CartesiaVoice } from "./cartesia";
import {
  EMPTY_LIVE_VOICE_MANIFEST,
  LIVE_VOICE_CHARACTERS,
  LIVE_VOICE_MANIFEST_FILE,
  parseLiveVoiceManifest,
  type LiveVoiceManifest,
  type LiveVoiceProfile,
} from "./live-voice-manifest";
import { characterIdForAlias } from "./completion-audio";
import type { LiveCharacterVoiceSettings, LiveCharacterVoiceStatus } from "./live-types";

/**
 * 캐릭터 통화 음성의 설치별 준비 상태.
 *
 * 공개판은 키도 voice id도 갖고 있지 않다. 사용자가 Cartesia 키를 넣고 업로드·크레딧 사용에
 * 동의한 뒤 「준비」를 누를 때만, 번들 참조 음원을 그 계정에 비공개로 복제하고 매니페스트의
 * 억양을 더한다. 시작·상태 조회·통화 시작은 provider를 부르지 않는다.
 *
 * 복제는 크레딧을 쓰므로 중복이 곧 비용이다. 그래서 단계마다 즉시 저장하고, 복제 전에는 늘
 * 소유 voice 전체 목록에서 같은 표식(description)의 voice를 찾아 재사용한다. 응답을 받지 못한
 * 복제는 같은 실행에서 다시 보내지 않고 `needs-check`로 남긴다 — 다음 준비가 목록을 다시
 * 맞춰 본 뒤에야 새로 복제한다.
 */

export interface LiveVoiceKeyStore {
  read(): Promise<string | undefined>;
  write(key: string): Promise<void>;
  remove(): Promise<void>;
}

export interface LiveVoiceServiceOptions {
  /** 매니페스트와 참조 음원이 있는 폴더(`public/audio/live`). */
  assetDir: string;
  /** 설치별 voice 매핑 파일. 키 원문은 여기 들어가지 않는다. */
  stateFile: string;
  keys: LiveVoiceKeyStore;
  client?: (apiKey: string) => CartesiaClient;
}

/** 통화 한 건이 쓸 캐릭터 음성. `ready`가 아니면 그 이유. */
export type LiveSpeechPlan =
  | { kind: "ready"; apiKey: string; model: string; voiceId: string; profile: LiveVoiceProfile }
  | { kind: "no-key" }
  | { kind: "not-ready"; alias: string };

interface StoredVoice {
  voiceId?: string;
  /** 이 voice를 만든 참조 음원의 sha256. 참조가 바뀌면 새 복제가 필요하다. */
  referenceSha256?: string;
  /** 다른 경로로 만든 voice를 들여왔다. 참조 개정 비교를 하지 않는다. */
  imported?: boolean;
  /** 매니페스트의 `addAccents`가 모두 붙어 있음을 provider 응답으로 확인했다. */
  accentsReady?: boolean;
  /** 응답을 받지 못한 복제의 표식. 소유 목록으로 결과를 맞춰 볼 때까지 다시 복제하지 않는다. */
  pendingCloneMarker?: string;
  error?: string;
}

interface StoredAccount {
  acknowledgedAt?: string;
  characters: Record<string, StoredVoice>;
}

interface StoredState {
  version: 1;
  accounts: Record<string, StoredAccount>;
}

const STATE_VERSION = 1;
const PROVIDER_NAME_PREFIX = "CUELO";

/** 키를 두 번 저장하지 않고 키(=계정)마다 매핑을 가른다. 원문은 복원되지 않는다. */
export function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/** 화면에 보일 키 모양. 공개 접두(`sk_car_`)와 끝 네 글자만 남긴다. */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) return "••••";
  return `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}`;
}

/** 복제 voice의 description. 소유 목록에서 같은 참조로 만든 voice를 정확히 찾는 표식이다. */
export function cloneMarker(characterId: string, referenceSha256: string): string {
  return `CUELO live voice ${characterId} ref:${referenceSha256.slice(0, 12)}`;
}

function emptyState(): StoredState {
  return { version: STATE_VERSION, accounts: {} };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LiveVoiceService {
  /** 화면이 보는 상태. 로컬 파일만 읽고 provider를 부르지 않는다. */
  settings(): Promise<LiveCharacterVoiceSettings>;
  saveKey(apiKey: string): Promise<void>;
  removeKey(): Promise<void>;
  /** 동의 뒤 사용자가 누른 준비를 시작한다. 끝을 기다리지 않는다. */
  prepare(): Promise<void>;
  planFor(alias: string | null): Promise<LiveSpeechPlan>;
  /** 진행 중인 준비가 끝날 때까지. 테스트와 스모크가 기다리는 자리. */
  idle(): Promise<void>;
}

export function createLiveVoiceService(options: LiveVoiceServiceOptions): LiveVoiceService {
  const clientFor = options.client ?? ((apiKey: string) => createCartesiaClient(apiKey));
  const referenceCache = new Map<string, { mtimeMs: number; size: number; sha256: string }>();
  let running: Promise<void> | undefined;
  let preparingId: string | null = null;
  let lastError: string | null = null;

  function readManifest(): LiveVoiceManifest {
    try {
      return parseLiveVoiceManifest(JSON.parse(readFileSync(join(options.assetDir, LIVE_VOICE_MANIFEST_FILE), "utf8")));
    } catch {
      return EMPTY_LIVE_VOICE_MANIFEST;
    }
  }

  /**
   * 상태 파일. 없으면 빈 상태다. 깨졌으면 예외 — 빈 상태로 덮어쓰면 이미 만든 voice를 잊고
   * 다시 복제하게 되므로, 읽지 못한 상태 위에서는 준비를 시작하지 않는다.
   */
  function readState(): StoredState {
    if (!existsSync(options.stateFile)) return emptyState();
    const parsed = JSON.parse(readFileSync(options.stateFile, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error("통화 음성 상태 파일 형식이 올바르지 않습니다.");
    const { version, accounts } = parsed as Partial<StoredState>;
    if (version !== STATE_VERSION || typeof accounts !== "object" || accounts === null) {
      throw new Error("통화 음성 상태 파일 형식이 올바르지 않습니다.");
    }
    return parsed as StoredState;
  }

  /** 한 캐릭터 항목만 고친다. 매번 새로 읽어 다른 손(수동 가져오기)이 쓴 항목을 덮지 않는다. */
  function updateVoice(fingerprint: string, characterId: string, change: (voice: StoredVoice) => StoredVoice): StoredVoice {
    const state = readState();
    const account = state.accounts[fingerprint] ?? { characters: {} };
    const next = change({ ...account.characters[characterId] });
    state.accounts[fingerprint] = { ...account, characters: { ...account.characters, [characterId]: next } };
    mkdirSync(dirname(options.stateFile), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(options.stateFile, `${JSON.stringify(state, null, 2)}\n`);
    return next;
  }

  function acknowledge(fingerprint: string): void {
    const state = readState();
    const account = state.accounts[fingerprint] ?? { characters: {} };
    state.accounts[fingerprint] = { ...account, acknowledgedAt: new Date().toISOString() };
    mkdirSync(dirname(options.stateFile), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(options.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  /** 참조 음원의 sha256. 같은 파일을 상태 조회마다 다시 읽지 않도록 크기·수정 시각으로 캐시한다. */
  function referenceSha256(profile: LiveVoiceProfile): string | null {
    const path = join(options.assetDir, profile.reference);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const cached = referenceCache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.sha256;
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    referenceCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, sha256 });
    return sha256;
  }

  function isReady(voice: StoredVoice | undefined, sha256: string): voice is StoredVoice & { voiceId: string } {
    return Boolean(voice?.voiceId && voice.accentsReady && (voice.imported || voice.referenceSha256 === sha256));
  }

  async function settings(): Promise<LiveCharacterVoiceSettings> {
    const apiKey = await options.keys.read();
    const manifest = readManifest();
    let state: StoredState | null = null;
    let stateError: string | null = null;
    try {
      state = readState();
    } catch (error) {
      stateError = errorText(error);
    }
    const account = apiKey && state ? state.accounts[keyFingerprint(apiKey)] : undefined;
    const characters: LiveCharacterVoiceStatus[] = LIVE_VOICE_CHARACTERS.map(({ id, alias }) => {
      const profile = manifest.profiles.get(id);
      const sha256 = profile ? referenceSha256(profile) : null;
      if (!profile || !sha256) return { id, alias, state: "missing-asset" };
      const base = { id, alias, tuning: profile.tuning };
      const voice = account?.characters[id];
      if (running && preparingId === id) return { ...base, state: "preparing" };
      if (isReady(voice, sha256)) return { ...base, state: "ready" };
      if (voice?.pendingCloneMarker) return { ...base, state: "needs-check", ...(voice.error ? { error: voice.error } : {}) };
      if (voice?.error) return { ...base, state: "failed", error: voice.error };
      return { ...base, state: "not-prepared" };
    });
    return {
      configured: Boolean(apiKey),
      keyHint: apiKey ? maskApiKey(apiKey) : null,
      preparing: Boolean(running),
      acknowledgedAt: account?.acknowledgedAt ?? null,
      characters,
      lastError: stateError ?? lastError,
    };
  }

  /** 키를 검증하고 저장한다. 크레딧을 쓰지 않는 조회 한 번으로 틀린 키는 저장하지 않는다. */
  async function saveKey(apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed || /\s/.test(trimmed)) throw new CartesiaError("Cartesia API 키 형식이 올바르지 않습니다", "bad-request");
    await clientFor(trimmed).verifyKey();
    await options.keys.write(trimmed);
    lastError = null;
  }

  async function removeKey(): Promise<void> {
    if (running) throw new Error("음성 준비가 진행 중이라 키를 지울 수 없습니다.");
    await options.keys.remove();
    lastError = null;
  }

  async function prepareOne(
    client: CartesiaClient,
    fingerprint: string,
    profile: LiveVoiceProfile,
    sha256: string,
    owned: () => Promise<CartesiaVoice[]>,
    refreshOwned: () => void,
  ): Promise<void> {
    const marker = cloneMarker(profile.id, sha256);
    let voice = updateVoice(fingerprint, profile.id, (current) => {
      // 참조 음원이 바뀌었으면 옛 voice는 이 캐릭터의 지금 참조가 아니다. 계정의 옛 voice는 지우지 않는다.
      if (current.voiceId && !current.imported && current.referenceSha256 !== sha256) {
        return { pendingCloneMarker: current.pendingCloneMarker };
      }
      return { ...current, error: undefined };
    });

    if (!voice.voiceId) {
      const existing = (await owned()).find((candidate) => candidate.description.trim() === marker);
      if (existing) {
        voice = updateVoice(fingerprint, profile.id, () => ({ voiceId: existing.id, referenceSha256: sha256 }));
      } else {
        const fileName = profile.reference;
        const clip = new Blob([readFileSync(join(options.assetDir, fileName))], { type: "audio/wav" });
        // 보내기 전에 표식을 남긴다. 이 프로세스가 응답 전에 죽어도 다음 준비는 목록부터 맞춰 본다.
        updateVoice(fingerprint, profile.id, (current) => ({ ...current, pendingCloneMarker: marker }));
        try {
          const created = await client.cloneVoice({
            clip,
            fileName,
            name: `${PROVIDER_NAME_PREFIX} ${profile.alias}`,
            description: marker,
            language: profile.referenceLanguage,
            accent: profile.referenceAccent,
          });
          voice = updateVoice(fingerprint, profile.id, () => ({ voiceId: created.id, referenceSha256: sha256 }));
        } catch (error) {
          if (!(error instanceof CartesiaError) || error.kind !== "ambiguous") {
            updateVoice(fingerprint, profile.id, () => ({ error: errorText(error) }));
            throw error;
          }
          // 복제가 실제로 만들어졌는지 모른다. 같은 실행에서 다시 보내지 않고 목록으로만 확인한다.
          refreshOwned();
          const landed = (await owned().catch(() => [])).find((candidate) => candidate.description.trim() === marker);
          if (!landed) {
            updateVoice(fingerprint, profile.id, (current) => ({
              ...current,
              error: `복제 결과를 확인하지 못했습니다. 다시 준비하면 계정 목록을 먼저 확인합니다. (${errorText(error)})`,
            }));
            return;
          }
          voice = updateVoice(fingerprint, profile.id, () => ({ voiceId: landed.id, referenceSha256: sha256 }));
        }
      }
    }

    if (voice.accentsReady || !voice.voiceId) return;
    const voiceId = voice.voiceId;
    let current: CartesiaVoice;
    try {
      current = await client.getVoice(voiceId);
    } catch (error) {
      if (error instanceof CartesiaError && error.kind === "not-found") {
        // 계정에서 지워진 voice. 매핑을 비워 다음 준비가 새로 만든다.
        updateVoice(fingerprint, profile.id, () => ({ error: "Cartesia 계정에 이 voice가 없습니다. 다시 준비하면 새로 만듭니다." }));
        return;
      }
      throw error;
    }
    // 추가한 억양은 `is_native: false`로 붙는다. 원래 억양이든 추가 억양이든 지원하면 된다.
    const missing = profile.addAccents.filter((accent) => !current.accents.some((item) => item.accent === accent));
    if (missing.length > 0) current = await client.addAccents(voiceId, missing);
    const stillMissing = profile.addAccents.filter((accent) => !current.accents.some((item) => item.accent === accent));
    if (stillMissing.length > 0) {
      updateVoice(fingerprint, profile.id, (stored) => ({ ...stored, error: `억양을 확인하지 못했습니다: ${stillMissing.join(", ")}` }));
      return;
    }
    updateVoice(fingerprint, profile.id, (stored) => ({ ...stored, accentsReady: true, error: undefined }));
  }

  async function run(apiKey: string): Promise<void> {
    const client = clientFor(apiKey);
    const fingerprint = keyFingerprint(apiKey);
    const manifest = readManifest();
    let ownedList: Promise<CartesiaVoice[]> | undefined;
    const owned = () => (ownedList ??= client.listOwnedVoices());
    const refreshOwned = () => {
      ownedList = undefined;
    };
    for (const { id } of LIVE_VOICE_CHARACTERS) {
      const profile = manifest.profiles.get(id);
      const sha256 = profile ? referenceSha256(profile) : null;
      if (!profile || !sha256) continue;
      const stored = readState().accounts[fingerprint]?.characters[id];
      if (isReady(stored, sha256)) continue;
      preparingId = id;
      try {
        await prepareOne(client, fingerprint, profile, sha256, owned, refreshOwned);
      } catch (error) {
        // 키·플랜·속도 제한은 다음 캐릭터에서도 똑같이 실패한다. 실행을 멈추고 이유를 보인다.
        if (error instanceof CartesiaError && (error.kind === "auth" || error.kind === "plan" || error.kind === "rate")) {
          lastError = error.kind === "plan"
            ? `Cartesia 플랜이나 크레딧이 음성 복제를 허용하지 않습니다. 복제가 되는 플랜(Pro 이상)이 필요합니다. (${error.message})`
            : error.message;
          return;
        }
        // 목록을 끝까지 못 봤으면 중복 복제를 피할 근거가 없다. 다른 캐릭터도 멈춘다.
        if (error instanceof CartesiaError && error.kind === "ambiguous") {
          lastError = error.message;
          return;
        }
        updateVoice(fingerprint, id, (current) => ({ ...current, error: errorText(error) }));
      }
    }
  }

  /**
   * 사용자가 동의하고 누른 준비. 이미 진행 중이면 그 실행을 그대로 둔다(단일 비행).
   * 끝을 기다리지 않고 돌려준다 — 화면은 상태 조회로 진행을 본다.
   */
  async function prepare(): Promise<void> {
    if (running) return;
    // 첫 await(키 읽기) 전에 자리를 잡는다. 그래야 동시에 누른 두 요청이 둘 다 복제를 시작하지 않는다.
    // 키·상태 파일 검증 실패는 이 호출에 그대로 던지고, 자리는 바로 푼다.
    const { promise: started, resolve: start, reject: refuse } = Promise.withResolvers<string>();
    let refused = false;
    running = started.then(run)
      .catch((error: unknown) => {
        if (!refused) lastError = errorText(error);
      })
      .finally(() => {
        running = undefined;
        preparingId = null;
      });
    try {
      const apiKey = await options.keys.read();
      if (!apiKey) throw new CartesiaError("Cartesia API 키가 없습니다", "bad-request");
      // 깨진 상태 파일이면 여기서 멈춘다. 그 위에서 준비하면 이미 만든 voice를 잊고 다시 복제한다.
      acknowledge(keyFingerprint(apiKey));
      lastError = null;
      start(apiKey);
    } catch (error) {
      refused = true;
      refuse(error);
      await running;
      throw error;
    }
  }

  /** 통화 시작 때 이 캐릭터 음성을 쓸 수 있는지. provider를 부르지 않는다. */
  async function planFor(alias: string | null): Promise<LiveSpeechPlan> {
    const apiKey = await options.keys.read();
    if (!apiKey) return { kind: "no-key" };
    const id = characterIdForAlias(alias);
    if (!alias || !id) return { kind: "not-ready", alias: alias ?? "" };
    const manifest = readManifest();
    const profile = manifest.profiles.get(id);
    const sha256 = profile ? referenceSha256(profile) : null;
    if (!profile || !sha256) return { kind: "not-ready", alias };
    let voice: StoredVoice | undefined;
    try {
      voice = readState().accounts[keyFingerprint(apiKey)]?.characters[id];
    } catch {
      return { kind: "not-ready", alias };
    }
    if (!isReady(voice, sha256)) return { kind: "not-ready", alias };
    return { kind: "ready", apiKey, model: manifest.model, voiceId: voice.voiceId, profile };
  }

  return {
    settings,
    saveKey,
    removeKey,
    prepare,
    planFor,
    /** 테스트와 수동 확인용: 진행 중인 준비가 끝날 때까지. */
    idle: () => running ?? Promise.resolve(),
  };
}

