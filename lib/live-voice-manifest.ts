import { COMPLETION_AUDIO_ALIASES, characterIdForAlias, type CompletionAudioAlias } from "./completion-audio";

/**
 * 통화 캐릭터 음성의 번들 매니페스트(`public/audio/live/voices.json`).
 *
 * 공개판에 들어가는 것은 참조 음원과 생성 설정뿐이다. 각 설치는 사용자가 넣은 Cartesia 키로
 * 이 참조를 자기 계정에 비공개 복제하고, 그 voice id는 설치별 상태 파일에만 남는다.
 * 형식이 깨진 캐릭터 하나는 「자산 없음」이 되고 나머지 캐릭터는 그대로 살린다.
 */

export const LIVE_VOICE_MANIFEST_FILE = "voices.json";

const SUPPORTED_MODELS: Record<string, true> = {
  "sonic-3.6": true,
  "sonic-3.5": true,
  "sonic-3": true,
  "sonic-latest": true,
};

/** Cartesia `generation_config.emotion`의 전체 목록(Volume, Speed, and Emotion 문서). */
const CARTESIA_EMOTIONS: Record<string, true> = Object.fromEntries([
  "neutral", "happy", "excited", "enthusiastic", "elated", "euphoric", "triumphant", "amazed", "surprised",
  "flirtatious", "curious", "content", "peaceful", "serene", "calm", "grateful", "affectionate", "trust",
  "sympathetic", "anticipation", "mysterious", "angry", "mad", "outraged", "frustrated", "agitated",
  "threatened", "disgusted", "contempt", "envious", "sarcastic", "ironic", "sad", "dejected", "melancholic",
  "disappointed", "hurt", "guilty", "bored", "tired", "rejected", "nostalgic", "wistful", "apologetic",
  "hesitant", "insecure", "confused", "resigned", "anxious", "panicked", "alarmed", "scared", "proud",
  "confident", "distant", "skeptical", "contemplative", "determined",
].map((emotion) => [emotion, true as const]));

/** 같은 폴더의 음원 파일 이름만 받는다. 경로 구분자나 `..`이 들어갈 자리가 없다. */
const REFERENCE_FILE = /^[a-z0-9][a-z0-9_-]*\.(?:wav|mp3|flac|ogg|webm)$/;
const LANGUAGE = /^[a-z]{2}$/;
const ACCENT = /^[a-z][a-z-]*$/;

export interface LiveVoiceGeneration {
  emotion?: string;
  speed: number;
  volume: number;
}

export interface LiveVoiceProfile {
  id: string;
  alias: CompletionAudioAlias;
  /** `public/audio/live/` 안의 참조 음원 파일 이름. */
  reference: string;
  referenceLanguage: string;
  referenceAccent: string;
  /** 복제 뒤 같은 voice에 추가할 억양. 통화는 이 억양이 모두 붙은 뒤에만 쓴다. */
  addAccents: string[];
  generation: LiveVoiceGeneration;
  /** `accepted`는 사용자가 청취로 고른 설정, `provisional`은 청취 전 임시 설정. */
  tuning: "accepted" | "provisional";
}

export interface LiveVoiceManifest {
  model: string;
  profiles: ReadonlyMap<string, LiveVoiceProfile>;
}

export const EMPTY_LIVE_VOICE_MANIFEST: LiveVoiceManifest = { model: "", profiles: new Map() };

/** 매니페스트가 다룰 수 있는 캐릭터. 완료음·스티커와 같은 별칭과 id를 쓴다. */
export const LIVE_VOICE_CHARACTERS: readonly { id: string; alias: CompletionAudioAlias }[] = COMPLETION_AUDIO_ALIASES.map(
  (alias) => ({ id: characterIdForAlias(alias)!, alias }),
);

function inRange(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

function readGeneration(raw: unknown): LiveVoiceGeneration | null {
  if (raw === undefined) return { speed: 1, volume: 1 };
  if (typeof raw !== "object" || raw === null) return null;
  const { emotion, speed, volume } = raw as Record<string, unknown>;
  const parsedSpeed = inRange(speed, 0.6, 1.5, 1);
  const parsedVolume = inRange(volume, 0.5, 2, 1);
  if (parsedSpeed === null || parsedVolume === null) return null;
  if (emotion !== undefined && (typeof emotion !== "string" || !Object.hasOwn(CARTESIA_EMOTIONS, emotion))) return null;
  return emotion === undefined
    ? { speed: parsedSpeed, volume: parsedVolume }
    : { emotion, speed: parsedSpeed, volume: parsedVolume };
}

function readProfile(raw: unknown): LiveVoiceProfile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const { id, alias, reference, referenceLanguage, referenceAccent, addAccents, tuning } = entry;
  if (typeof id !== "string" || typeof alias !== "string" || characterIdForAlias(alias) !== id) return null;
  if (typeof reference !== "string" || !REFERENCE_FILE.test(reference)) return null;
  if (typeof referenceLanguage !== "string" || !LANGUAGE.test(referenceLanguage)) return null;
  if (typeof referenceAccent !== "string" || !ACCENT.test(referenceAccent)) return null;
  const accents = addAccents === undefined ? [] : addAccents;
  if (!Array.isArray(accents) || !accents.every((accent) => typeof accent === "string" && ACCENT.test(accent))) return null;
  if (tuning !== "accepted" && tuning !== "provisional") return null;
  const generation = readGeneration(entry.generation);
  if (!generation) return null;
  return {
    id,
    alias: alias as CompletionAudioAlias,
    reference,
    referenceLanguage,
    referenceAccent,
    addAccents: [...new Set(accents as string[])],
    generation,
    tuning,
  };
}

export function parseLiveVoiceManifest(raw: unknown): LiveVoiceManifest {
  if (typeof raw !== "object" || raw === null) return EMPTY_LIVE_VOICE_MANIFEST;
  const { version, provider, model, characters } = raw as Record<string, unknown>;
  if (version !== 1 || provider !== "cartesia" || typeof model !== "string" || !Object.hasOwn(SUPPORTED_MODELS, model)) {
    return EMPTY_LIVE_VOICE_MANIFEST;
  }
  if (!Array.isArray(characters)) return EMPTY_LIVE_VOICE_MANIFEST;
  const profiles = new Map<string, LiveVoiceProfile>();
  for (const character of characters) {
    const profile = readProfile(character);
    if (profile && !profiles.has(profile.id)) profiles.set(profile.id, profile);
  }
  return { model, profiles };
}
