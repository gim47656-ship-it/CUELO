/**
 * 통역 모드가 다루는 언어. 화면(음성 인식·읽어 주기 언어 태그, 버튼 이름)과 서버(번역 지시에
 * 쓰는 영어 이름)가 같은 목록을 쓴다. 서버는 이 목록에 없는 코드를 받지 않는다.
 */
export interface TranslatorLanguage {
  code: string;
  /** Web Speech API의 인식·합성 언어 태그. */
  speechTag: string;
  /** 번역 지시에 넣는 이름. */
  englishName: string;
  /** 그 언어 사용자가 읽는 자기 언어 이름. 상대가 누를 버튼에 쓴다. */
  nativeName: string;
  /** 상대가 누를 버튼의 문구. 상대 언어로 쓴다. */
  speakLabel: string;
}

export const TRANSLATOR_LANGUAGES: readonly TranslatorLanguage[] = [
  { code: "ko", speechTag: "ko-KR", englishName: "Korean", nativeName: "한국어", speakLabel: "한국어로 말하기" },
  { code: "en", speechTag: "en-US", englishName: "English", nativeName: "English", speakLabel: "Speak English" },
  { code: "vi", speechTag: "vi-VN", englishName: "Vietnamese", nativeName: "Tiếng Việt", speakLabel: "Nói tiếng Việt" },
  { code: "ja", speechTag: "ja-JP", englishName: "Japanese", nativeName: "日本語", speakLabel: "日本語で話す" },
  { code: "th", speechTag: "th-TH", englishName: "Thai", nativeName: "ไทย", speakLabel: "พูดภาษาไทย" },
];

export function findTranslatorLanguage(code: unknown): TranslatorLanguage | undefined {
  return typeof code === "string" ? TRANSLATOR_LANGUAGES.find((language) => language.code === code) : undefined;
}

/** 한 번에 번역할 수 있는 글자 수. 말 한마디·짧은 문단을 넘는 입력은 받지 않는다. */
export const MAX_TRANSLATE_CHARS = 2_000;

/** `/api/translate/speech`가 흘려보내는 소리: 모노 `pcm_s16le`(리틀엔디언), 이 표본율. 서버와 화면이 함께 쓴다. */
export const TRANSLATOR_SPEECH_SAMPLE_RATE = 24_000;
