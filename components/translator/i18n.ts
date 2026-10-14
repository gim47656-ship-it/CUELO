"use client";

import { useCallback } from "react";
import { useI18n } from "@/hooks/useI18n";
import { translateMessage } from "@/lib/i18n/format";
import type { Locale, TranslationParams } from "@/lib/i18n/types";

/**
 * 통역 모드 전용 문구. 오피스(`components/office/i18n.ts`)와 같은 방식으로 앱 공용 언어 팩을
 * 건드리지 않고 여기서 따로 들며, 조회·보간·영어 대체는 공용 `translateMessage`를 그대로 쓴다.
 */
const ko = {
  "translator.tab": "통역",
  "translator.title": "통역",
  "translator.back": "대화로",
  "translator.panelHint": "말하면 Gemini 3.8 Flash가 번역하고 Cartesia 음성으로 읽어 줍니다. Cartesia를 쓸 수 없으면 폰 기본 목소리로 읽습니다. 작업 세션과 하네스 규칙을 거치지 않습니다.",
  "translator.open": "통역 화면 열기",
  "translator.me": "나",
  "translator.them": "상대",
  "translator.myLanguage": "내 언어",
  "translator.theirLanguage": "상대 언어",
  "translator.swap": "두 언어 바꾸기",
  "translator.autoSpeak": "자동으로 읽기",
  "translator.clear": "지우기",
  "translator.empty": "아래 버튼을 누르고 말하세요. 상대 버튼은 상대 언어로 적혀 있어 폰을 건네 누르게 하면 됩니다.",
  "translator.listening": "듣는 중… 다시 누르면 멈춥니다",
  "translator.translating": "번역 중…",
  "translator.replay": "다시 읽기",
  "translator.original": "원문",
  "translator.failed": "번역 실패: {error}",
  "translator.retry": "다시 번역",
  "translator.inputPlaceholder": "직접 입력해 번역",
  "translator.input": "번역할 문장",
  "translator.direction": "번역 방향",
  "translator.directionMine": "나 → 상대",
  "translator.directionTheirs": "상대 → 나",
  "translator.send": "번역",
  "translator.noSpeech": "이 브라우저는 음성 인식을 지원하지 않습니다. 직접 입력은 쓸 수 있습니다. 폰에서는 Chrome이나 Safari로 여세요.",
  "translator.insecure": "마이크는 HTTPS 주소에서만 켜집니다. 직접 입력은 쓸 수 있습니다.",
  "translator.micDenied": "마이크 권한이 막혀 있습니다. 브라우저 설정에서 이 주소의 마이크를 허용하세요.",
  "translator.micFailed": "음성 인식 오류: {error}",
  "translator.conversation": "통역 기록",
} as const;

type TranslatorMessageKey = keyof typeof ko;

const en: Record<TranslatorMessageKey, string> = {
  "translator.tab": "Interpret",
  "translator.title": "Interpreter",
  "translator.back": "Back to chat",
  "translator.panelHint": "Speak and Gemini 3.8 Flash translates; a Cartesia voice reads it aloud, or the phone's own voice when Cartesia is unavailable. It bypasses work sessions and harness rules.",
  "translator.open": "Open interpreter",
  "translator.me": "Me",
  "translator.them": "Them",
  "translator.myLanguage": "My language",
  "translator.theirLanguage": "Their language",
  "translator.swap": "Swap languages",
  "translator.autoSpeak": "Read aloud",
  "translator.clear": "Clear",
  "translator.empty": "Press a button below and speak. Their button is labelled in their language, so hand them the phone.",
  "translator.listening": "Listening… press again to stop",
  "translator.translating": "Translating…",
  "translator.replay": "Read again",
  "translator.original": "Original",
  "translator.failed": "Translation failed: {error}",
  "translator.retry": "Retry",
  "translator.inputPlaceholder": "Type to translate",
  "translator.input": "Text to translate",
  "translator.direction": "Direction",
  "translator.directionMine": "Me → Them",
  "translator.directionTheirs": "Them → Me",
  "translator.send": "Translate",
  "translator.noSpeech": "This browser has no speech recognition. Typing still works. On a phone, open this page in Chrome or Safari.",
  "translator.insecure": "The microphone only works on an HTTPS address. Typing still works.",
  "translator.micDenied": "Microphone access is blocked. Allow the microphone for this address in the browser settings.",
  "translator.micFailed": "Speech recognition error: {error}",
  "translator.conversation": "Interpretation log",
};

const zhCN: Record<TranslatorMessageKey, string> = {
  "translator.tab": "口译",
  "translator.title": "口译",
  "translator.back": "返回对话",
  "translator.panelHint": "说话后由 Gemini 3.8 Flash 翻译，并用 Cartesia 语音朗读；无法使用 Cartesia 时改用手机自带语音。不经过工作会话和规则。",
  "translator.open": "打开口译",
  "translator.me": "我",
  "translator.them": "对方",
  "translator.myLanguage": "我的语言",
  "translator.theirLanguage": "对方语言",
  "translator.swap": "交换语言",
  "translator.autoSpeak": "自动朗读",
  "translator.clear": "清除",
  "translator.empty": "按下方按钮后说话。对方按钮用对方语言标注，可以把手机递给对方。",
  "translator.listening": "正在听… 再按一次停止",
  "translator.translating": "翻译中…",
  "translator.replay": "再读一遍",
  "translator.original": "原文",
  "translator.failed": "翻译失败：{error}",
  "translator.retry": "重试",
  "translator.inputPlaceholder": "输入文字翻译",
  "translator.input": "要翻译的文字",
  "translator.direction": "翻译方向",
  "translator.directionMine": "我 → 对方",
  "translator.directionTheirs": "对方 → 我",
  "translator.send": "翻译",
  "translator.noSpeech": "此浏览器不支持语音识别，仍可输入文字。手机请用 Chrome 或 Safari 打开。",
  "translator.insecure": "麦克风只能在 HTTPS 地址上使用，仍可输入文字。",
  "translator.micDenied": "麦克风权限被阻止。请在浏览器设置中允许此地址使用麦克风。",
  "translator.micFailed": "语音识别错误：{error}",
  "translator.conversation": "口译记录",
};

const TRANSLATOR_MESSAGES: Record<string, Record<string, string>> = { ko, en, "zh-CN": zhCN };

export type TranslatorTranslate = (key: TranslatorMessageKey, params?: TranslationParams) => string;

/** 통역 모드 문구 조회. 앱 locale을 따르고, 없는 언어는 공용 규칙대로 영어로 떨어진다. */
export function useTranslatorText(): { tt: TranslatorTranslate; locale: Locale } {
  const { locale } = useI18n();
  const tt = useCallback<TranslatorTranslate>(
    (key, params) => translateMessage(locale, key, TRANSLATOR_MESSAGES, params),
    [locale],
  );
  return { tt, locale };
}
