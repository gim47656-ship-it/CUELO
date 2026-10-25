/**
 * 통역 모드가 다루는 언어. 화면(선택칸, 말풍선의 `lang`, 말풍선 자리 판별)과 서버(통역 지시에 쓰는
 * 영어 이름)가 같은 목록을 쓴다. 서버는 이 목록에 없는 코드를 받지 않는다.
 */
export interface TranslatorLanguage {
  code: string;
  /** 말풍선 `lang` 속성에 쓰는 언어 태그. */
  tag: string;
  /** 통역 지시에 넣는 이름. */
  englishName: string;
  /** 그 언어 사용자가 읽는 자기 언어 이름. 선택칸에 쓴다. */
  nativeName: string;
}

export const TRANSLATOR_LANGUAGES: readonly TranslatorLanguage[] = [
  { code: "ko", tag: "ko-KR", englishName: "Korean", nativeName: "한국어" },
  { code: "en", tag: "en-US", englishName: "English", nativeName: "English" },
  { code: "vi", tag: "vi-VN", englishName: "Vietnamese", nativeName: "Tiếng Việt" },
  { code: "ja", tag: "ja-JP", englishName: "Japanese", nativeName: "日本語" },
  { code: "th", tag: "th-TH", englishName: "Thai", nativeName: "ไทย" },
  { code: "zh", tag: "zh-CN", englishName: "Chinese", nativeName: "中文" },
];

export function findTranslatorLanguage(code: unknown): TranslatorLanguage | undefined {
  return typeof code === "string" ? TRANSLATOR_LANGUAGES.find((language) => language.code === code) : undefined;
}

/**
 * 언어 짝을 바꿀 때의 엔진. 짝에 베트남어가 새로 들어가면 Cloud로, 빠지면 Codex로 바꾼다(2026-10-25 엔진
 * 비교에서 베트남어만 Cloud가 나았다: 사실 전달 89% 대 76%). 베트남어 포함 여부가 그대로면 지금 엔진
 * (사용자가 직접 고른 값)을 둔다.
 */
export function engineForPairChange<P extends string>(
  previous: { mine: TranslatorLanguage; theirs: TranslatorLanguage },
  next: { mine: TranslatorLanguage; theirs: TranslatorLanguage },
  current: P,
): P | "codex" | "cloud" {
  const before = previous.mine.code === "vi" || previous.theirs.code === "vi";
  const after = next.mine.code === "vi" || next.theirs.code === "vi";
  if (after === before) return current;
  return after ? "cloud" : "codex";
}

/** 베트남어에만 있는 글자(성조·모음 부호, đ). 라틴 문자만 보고는 영어와 가를 수 없어 이것으로 가른다. */
const VIETNAMESE_LETTERS = /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/giu;

/** 가나(히라가나·가타카나, 가타카나 음성 확장, 반각 가타카나). 한자만으로는 일본어와 중국어를 가를 수 없어 이것으로 가른다. */
const KANA = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d]/u;

const SCRIPT_BY_CODE: Record<string, RegExp> = {
  ko: /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/gu,
  ja: /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d\u4e00-\u9fff]/gu,
  zh: /[\u4e00-\u9fff]/gu,
  th: /[\u0e00-\u0e7f]/gu,
  vi: VIETNAMESE_LETTERS,
  en: /[a-z]/giu,
};

function scriptScore(text: string, code: string, other: string): number {
  const pattern = SCRIPT_BY_CODE[code];
  if (!pattern) return 0;
  // 베트남어 부호가 하나라도 있으면 그 라틴 글자는 영어 근거가 아니다. (`g` 정규식이라 `test` 대신 `match`.)
  if (code === "en" && text.match(VIETNAMESE_LETTERS)) return 0;
  // 가나가 있으면 그 한자는 일본어 글이다. 일본어·중국어 짝에서 가나 없는 한자만의 말은 중국어로 본다.
  if (code === "zh" && KANA.test(text)) return 0;
  if (code === "ja" && other === "zh" && !KANA.test(text)) return 0;
  return text.match(pattern)?.length ?? 0;
}

/**
 * 두 언어 중 `text`가 어느 쪽 문자로 쓰였는지. 글자로 가를 수 없으면(같은 문자를 쓰는 짝, 숫자뿐인 말)
 * `undefined`. 말한 사람을 맞히려는 것이지 언어 감지기가 아니다.
 */
export function guessTranslatorLanguage(
  text: string,
  first: TranslatorLanguage,
  second: TranslatorLanguage,
): TranslatorLanguage | undefined {
  const a = scriptScore(text, first.code, second.code);
  const b = scriptScore(text, second.code, first.code);
  if (a === b) return undefined;
  return a > b ? first : second;
}
