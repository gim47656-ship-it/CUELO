import {
  COMPLETION_AUDIO_ALIASES,
  CUE_TAG_MEANING,
  selectCueAsset,
  type CompletionAudioAlias,
  type CueTag,
} from "./completion-audio";
import type { InlineUtteranceStatus } from "./inline-utterance";

const STICKER_VARIANTS = ["01", "02", "03"] as const;
const STICKER_ROOT = "/stickers/";

export interface InlineSticker {
  readonly src: string;
  readonly alt: string;
}

/** 같은 발화 key에는 항상 같은 sticker 변형이 배정된다. */
function stableRandom(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/** 완료·실패 발화에만 계정 얼굴의 캐릭터 스티커를 붙인다. */
export function inlineStickerFor(
  alias: string | null | undefined,
  status: InlineUtteranceStatus,
  utteranceKey: string,
): InlineSticker | null {
  if (!alias || status === "streaming" || !COMPLETION_AUDIO_ALIASES.includes(alias as CompletionAudioAlias)) {
    return null;
  }

  const tag: CueTag = status === "failed" ? "failed" : "done";
  const characterId = alias.slice(0, alias.indexOf("(")).toLowerCase();
  const assets = STICKER_VARIANTS.map((variant) => `${STICKER_ROOT}${characterId}/${tag}/${variant}.webp`);
  const src = selectCueAsset(assets, null, () => stableRandom(utteranceKey));
  return src ? { src, alt: CUE_TAG_MEANING[tag] } : null;
}
