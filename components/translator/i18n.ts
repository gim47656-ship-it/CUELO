"use client";

import { useCallback } from "react";
import { useI18n } from "@/hooks/useI18n";
import { translateMessage } from "@/lib/i18n/format";
import type { Locale, TranslationParams } from "@/lib/i18n/types";

/**
 * 통역 모드 전용 문구. 앱 공용 언어 팩을 건드리지 않고 여기서 따로 들며, 조회·보간·영어 대체는
 * 공용 `translateMessage`를 그대로 쓴다.
 */
const ko = {
  "translator.tab": "통역",
  "translator.title": "통역",
  "translator.back": "대화로",
  "translator.panelHint": "통역을 시작하면 ChatGPT 계정의 Codex 라이브 통화로 두 사람의 말을 서로의 언어로 바로 소리 내어 옮깁니다. 작업 세션과 하네스 규칙을 거치지 않고, 기록은 저장하지 않습니다.",
  "translator.open": "통역 화면 열기",
  "translator.me": "나",
  "translator.them": "상대",
  "translator.myLanguage": "내 언어",
  "translator.theirLanguage": "상대 언어",
  "translator.swap": "두 언어 바꾸기",
  "translator.clear": "지우기",
  "translator.start": "통역 시작",
  "translator.stop": "통역 끝내기",
  "translator.empty": "통역 시작을 누르고 폰을 두 사람 사이에 두세요. 누가 말하든 상대 언어로 바로 옮겨 말합니다.",
  "translator.connecting": "연결 중…",
  "translator.live": "듣는 중 · 그냥 말하세요",
  "translator.unsupported": "이 브라우저는 실시간 통화(WebRTC·마이크)를 지원하지 않습니다. 폰에서는 Chrome이나 Safari로 여세요.",
  "translator.insecure": "마이크는 HTTPS 주소에서만 켜집니다.",
  "translator.micDenied": "마이크 권한이 막혀 있습니다. 브라우저 설정에서 이 주소의 마이크를 허용하세요.",
  "translator.micUnavailable": "마이크를 켜지 못했습니다. 다른 앱이 쓰고 있지 않은지 확인하세요.",
  "translator.auth": "Codex 로그인이 없거나 만료됐습니다. 모델 설정에서 ChatGPT 계정으로 다시 로그인하세요.",
  "translator.upstream": "Codex 라이브 연결이 끊겼습니다: {error}",
  "translator.failed": "통역을 시작하지 못했습니다: {error}",
  "translator.original": "원문",
  "translator.translationPending": "통역 중…",
  "translator.conversation": "통역 기록",
} as const;

type TranslatorMessageKey = keyof typeof ko;

const en: Record<TranslatorMessageKey, string> = {
  "translator.tab": "Interpret",
  "translator.title": "Interpreter",
  "translator.back": "Back to chat",
  "translator.panelHint": "Start interpreting and a Codex live call on your ChatGPT account speaks each person's words in the other's language right away. It bypasses work sessions and harness rules, and nothing is saved.",
  "translator.open": "Open interpreter",
  "translator.me": "Me",
  "translator.them": "Them",
  "translator.myLanguage": "My language",
  "translator.theirLanguage": "Their language",
  "translator.swap": "Swap languages",
  "translator.clear": "Clear",
  "translator.start": "Start interpreting",
  "translator.stop": "Stop interpreting",
  "translator.empty": "Press Start interpreting and put the phone between you. Whoever speaks is interpreted into the other language right away.",
  "translator.connecting": "Connecting…",
  "translator.live": "Listening · just talk",
  "translator.unsupported": "This browser cannot make live calls (WebRTC and microphone). On a phone, open this page in Chrome or Safari.",
  "translator.insecure": "The microphone only works on an HTTPS address.",
  "translator.micDenied": "Microphone access is blocked. Allow the microphone for this address in the browser settings.",
  "translator.micUnavailable": "The microphone could not be opened. Check that no other app is using it.",
  "translator.auth": "The Codex sign-in is missing or expired. Sign in again with your ChatGPT account in model settings.",
  "translator.upstream": "The Codex live connection dropped: {error}",
  "translator.failed": "Interpreting could not start: {error}",
  "translator.original": "Original",
  "translator.translationPending": "Interpreting…",
  "translator.conversation": "Interpretation log",
};

const zhCN: Record<TranslatorMessageKey, string> = {
  "translator.tab": "口译",
  "translator.title": "口译",
  "translator.back": "返回对话",
  "translator.panelHint": "开始口译后，通过 ChatGPT 账号的 Codex 实时通话，把双方的话立即用对方的语言说出来。不经过工作会话和规则，也不保存记录。",
  "translator.open": "打开口译",
  "translator.me": "我",
  "translator.them": "对方",
  "translator.myLanguage": "我的语言",
  "translator.theirLanguage": "对方语言",
  "translator.swap": "交换语言",
  "translator.clear": "清除",
  "translator.start": "开始口译",
  "translator.stop": "结束口译",
  "translator.empty": "按开始口译，把手机放在两人之间。无论谁说话，都会立即译成对方的语言说出来。",
  "translator.connecting": "连接中…",
  "translator.live": "正在听 · 直接说话",
  "translator.unsupported": "此浏览器不支持实时通话（WebRTC 和麦克风）。手机请用 Chrome 或 Safari 打开。",
  "translator.insecure": "麦克风只能在 HTTPS 地址上使用。",
  "translator.micDenied": "麦克风权限被阻止。请在浏览器设置中允许此地址使用麦克风。",
  "translator.micUnavailable": "无法打开麦克风。请确认没有其他应用正在使用。",
  "translator.auth": "Codex 登录不存在或已过期。请在模型设置中用 ChatGPT 账号重新登录。",
  "translator.upstream": "Codex 实时连接已断开：{error}",
  "translator.failed": "无法开始口译：{error}",
  "translator.original": "原文",
  "translator.translationPending": "口译中…",
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
