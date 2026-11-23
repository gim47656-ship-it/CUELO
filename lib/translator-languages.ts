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
  // 코드는 OpenAI 번역·받아쓰기 API가 받는 출력 언어 식별자(소문자 `zh-tw`)와 같다. 대문자 `zh-TW`는 거절한다(2026-11-23 실측).
  { code: "zh-tw", tag: "zh-TW", englishName: "Traditional Chinese (Taiwan)", nativeName: "中文（台灣）" },
];

/** 한자로 쓰는 중국어(간체 `zh`, 대만 번체 `zh-tw`). 문자 판별과 일본어와의 구분에서 같은 편이다. */
export function isChineseCode(code: string): boolean {
  return code === "zh" || code === "zh-tw";
}

export function findTranslatorLanguage(code: unknown): TranslatorLanguage | undefined {
  return typeof code === "string" ? TRANSLATOR_LANGUAGES.find((language) => language.code === code) : undefined;
}

/** 각 언어로 쓴 언어 이름. `LANGUAGE_NAMES[읽는 사람 언어][가리키는 언어]`. */
const LANGUAGE_NAMES: Record<string, Record<string, string>> = {
  ko: { ko: "한국어", en: "영어", vi: "베트남어", ja: "일본어", th: "태국어", zh: "중국어", "zh-tw": "중국어(대만 번체)" },
  en: { ko: "Korean", en: "English", vi: "Vietnamese", ja: "Japanese", th: "Thai", zh: "Chinese", "zh-tw": "Traditional Chinese (Taiwan)" },
  vi: { ko: "tiếng Hàn", en: "tiếng Anh", vi: "tiếng Việt", ja: "tiếng Nhật", th: "tiếng Thái", zh: "tiếng Trung", "zh-tw": "tiếng Trung phồn thể (Đài Loan)" },
  ja: { ko: "韓国語", en: "英語", vi: "ベトナム語", ja: "日本語", th: "タイ語", zh: "中国語", "zh-tw": "中国語（台湾・繁体字）" },
  th: { ko: "ภาษาเกาหลี", en: "ภาษาอังกฤษ", vi: "ภาษาเวียดนาม", ja: "ภาษาญี่ปุ่น", th: "ภาษาไทย", zh: "ภาษาจีน", "zh-tw": "ภาษาจีนตัวเต็ม (ไต้หวัน)" },
  zh: { ko: "韩语", en: "英语", vi: "越南语", ja: "日语", th: "泰语", zh: "中文", "zh-tw": "中文（台湾繁体）" },
  "zh-tw": { ko: "韓語", en: "英語", vi: "越南語", ja: "日語", th: "泰語", zh: "中文（簡體）", "zh-tw": "中文（台灣）" },
};

/** 마주보기 위 칸(상대 쪽) 안내. 상대 언어로 쓰고, 옮겨 줄 내 언어 이름을 그 언어로 넣는다. */
const PARTNER_HINTS: Record<string, (name: string) => string> = {
  ko: (name) => `말씀하시면 ${name}로 옮겨 드려요.`,
  en: (name) => `Go ahead and speak. I'll interpret it into ${name} for you.`,
  vi: (name) => `Bạn cứ nói, tôi sẽ dịch sang ${name} cho bạn.`,
  ja: (name) => `話しかけてください。${name}に通訳します。`,
  th: (name) => `พูดได้เลย ระบบจะแปลเป็น${name}ให้`,
  zh: (name) => `请直接说话，我会帮您翻译成${name}。`,
  "zh-tw": (name) => `請直接說話，我會幫您翻譯成${name}。`,
};

/** 상대(`partner`)가 읽는 안내: 말하면 내 언어(`mine`)로 옮겨 준다는 말을 상대 언어로. */
export function partnerHint(partner: TranslatorLanguage, mine: TranslatorLanguage): string {
  const name = LANGUAGE_NAMES[partner.code]?.[mine.code] ?? mine.englishName;
  return (PARTNER_HINTS[partner.code] ?? PARTNER_HINTS.en)(name);
}

/** 베트남어에만 있는 글자(성조·모음 부호, đ). 라틴 문자만 보고는 영어와 가를 수 없어 이것으로 가른다. */
const VIETNAMESE_LETTERS = /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/giu;

/** 가나(히라가나·가타카나, 가타카나 음성 확장, 반각 가타카나). 한자만으로는 일본어와 중국어를 가를 수 없어 이것으로 가른다. */
const KANA = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d]/u;

const SCRIPT_BY_CODE: Record<string, RegExp> = {
  ko: /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/gu,
  ja: /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d\u4e00-\u9fff]/gu,
  zh: /[\u4e00-\u9fff]/gu,
  "zh-tw": /[\u4e00-\u9fff]/gu,
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
  if (isChineseCode(code) && KANA.test(text)) return 0;
  if (code === "ja" && isChineseCode(other) && !KANA.test(text)) return 0;
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
