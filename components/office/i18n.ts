"use client";

import { useCallback } from "react";
import { useI18n } from "@/hooks/useI18n";
import { translateMessage } from "@/lib/i18n/format";
import type { Locale, TranslationParams } from "@/lib/i18n/types";

/**
 * 오피스 보기 전용 문구. 단톡방(`components/lounge/i18n.ts`)과 같은 이유로 앱 공용 언어 팩을
 * 건드리지 않고 여기서 따로 들며, 조회·보간·영어 대체는 공용 `translateMessage`를 그대로 쓴다.
 */
const ko = {
  "office.toOffice": "오피스",
  "office.toOfficeTitle": "캐릭터 자리와 작업 상태를 대화 옆에 펼칩니다",
  "office.toChat": "대화 크게 보기",
  "office.toChatTitle": "자리를 접고 같은 대화를 넓게 봅니다",
  "office.floor": "오피스 자리",
  "office.floorSummary": "이 세션 참여 {count} · 실행 중 {running}",
  "office.seatEmpty": "이 세션 참여 없음",
  "office.main": "Main",
  "office.maker": "Maker",
  "office.unnamed": "이름 없는 참여자",
  "office.unnamedHint": "계정·모델 기록으로 캐릭터를 특정할 근거가 없는 참여자입니다.",
  "office.faceUnknown": "캐릭터 미확인",
  "office.status.pending": "대기",
  "office.status.running": "실행 중",
  "office.status.completed": "실행 완료",
  "office.status.failed": "실패",
  "office.status.aborted": "중단",
  "office.status.unknown": "상태 미확인",
  "office.status.retrying": "재시도 중",
  "office.notAccepted": "실행 완료는 Main 수용이 아닙니다. 수용 여부는 대화에서 확인하세요.",
  "office.participants": "참여자",
  "office.recipient": "받는 사람",
  "office.recipientMain": "Main · {name}",
  "office.showFloor": "자리",
  "office.tabTranscript": "대화 기록",
  "office.tabFiles": "쓴 파일 {count}",
  "office.loading": "기록 불러오는 중…",
  "office.transcriptEmpty": "대화 내용이 없습니다.",
  "office.archiveNote": "디스크 기록이라 본문만 보입니다.",
  "office.filesEmpty": "성공한 write·edit 기록이 아직 없습니다.",
  "office.filesArchive": "디스크 기록에는 도구 결과가 없어 쓴 파일을 확인할 수 없습니다.",
  "office.composerNote": "입력은 {name}에게 갑니다. 이 Maker에게 직접 보내지 않습니다.",
  "office.backToMain": "Main 대화 보기",
  "office.modelUnknown": "모델 미확인",
  "office.currentStep": "현재 단계",
  "office.makerRecord": "{name} 작업 기록",
} as const;

type OfficeMessageKey = keyof typeof ko;

const en: Record<OfficeMessageKey, string> = {
  "office.toOffice": "Office",
  "office.toOfficeTitle": "Show character seats and work status beside the chat",
  "office.toChat": "Focus chat",
  "office.toChatTitle": "Fold the seats and widen the same chat",
  "office.floor": "Office seats",
  "office.floorSummary": "In this session {count} · running {running}",
  "office.seatEmpty": "Not in this session",
  "office.main": "Main",
  "office.maker": "Maker",
  "office.unnamed": "Unnamed participants",
  "office.unnamedHint": "No account or model record identifies a character for these participants.",
  "office.faceUnknown": "Character unknown",
  "office.status.pending": "Pending",
  "office.status.running": "Running",
  "office.status.completed": "Run finished",
  "office.status.failed": "Failed",
  "office.status.aborted": "Aborted",
  "office.status.unknown": "Status unknown",
  "office.status.retrying": "Retrying",
  "office.notAccepted": "A finished run is not Main's acceptance. Check the chat for the verdict.",
  "office.participants": "Participants",
  "office.recipient": "Sending to",
  "office.recipientMain": "Main · {name}",
  "office.showFloor": "Seats",
  "office.tabTranscript": "Transcript",
  "office.tabFiles": "Files written {count}",
  "office.loading": "Loading the record…",
  "office.transcriptEmpty": "No messages.",
  "office.archiveNote": "Disk record: message text only.",
  "office.filesEmpty": "No successful write or edit yet.",
  "office.filesArchive": "The disk record has no tool results, so written files cannot be confirmed.",
  "office.composerNote": "Your input goes to {name}, not directly to this Maker.",
  "office.backToMain": "Show Main chat",
  "office.modelUnknown": "Model unknown",
  "office.currentStep": "Current step",
  "office.makerRecord": "{name} work record",
};

const zhCN: Record<OfficeMessageKey, string> = {
  "office.toOffice": "办公室",
  "office.toOfficeTitle": "在对话旁展开角色座位和工作状态",
  "office.toChat": "大屏对话",
  "office.toChatTitle": "收起座位，放大同一对话",
  "office.floor": "办公室座位",
  "office.floorSummary": "本会话参与 {count} · 运行中 {running}",
  "office.seatEmpty": "未参与本会话",
  "office.main": "Main",
  "office.maker": "Maker",
  "office.unnamed": "未命名参与者",
  "office.unnamedHint": "没有账号或模型记录可以确定这些参与者对应的角色。",
  "office.faceUnknown": "角色未确认",
  "office.status.pending": "等待",
  "office.status.running": "运行中",
  "office.status.completed": "运行结束",
  "office.status.failed": "失败",
  "office.status.aborted": "已中止",
  "office.status.unknown": "状态未确认",
  "office.status.retrying": "重试中",
  "office.notAccepted": "运行结束不等于 Main 已接受。请在对话中确认结论。",
  "office.participants": "参与者",
  "office.recipient": "发送给",
  "office.recipientMain": "Main · {name}",
  "office.showFloor": "座位",
  "office.tabTranscript": "对话记录",
  "office.tabFiles": "写入的文件 {count}",
  "office.loading": "正在加载记录…",
  "office.transcriptEmpty": "没有消息。",
  "office.archiveNote": "磁盘记录，仅显示正文。",
  "office.filesEmpty": "还没有成功的 write·edit 记录。",
  "office.filesArchive": "磁盘记录没有工具结果，无法确认写入的文件。",
  "office.composerNote": "输入发送给 {name}，不会直接发给这个 Maker。",
  "office.backToMain": "查看 Main 对话",
  "office.modelUnknown": "模型未确认",
  "office.currentStep": "当前步骤",
  "office.makerRecord": "{name} 工作记录",
};

const OFFICE_MESSAGES: Record<string, Record<string, string>> = { ko, en, "zh-CN": zhCN };

export type OfficeTranslate = (key: OfficeMessageKey, params?: TranslationParams) => string;

/** 오피스 문구 조회. 앱 locale을 따르고, 없는 언어는 공용 규칙대로 영어로 떨어진다. */
export function useOfficeText(): { ot: OfficeTranslate; locale: Locale } {
  const { locale } = useI18n();
  const ot = useCallback<OfficeTranslate>(
    (key, params) => translateMessage(locale, key, OFFICE_MESSAGES, params),
    [locale],
  );
  return { ot, locale };
}
