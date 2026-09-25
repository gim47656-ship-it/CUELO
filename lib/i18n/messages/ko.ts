import koMessagesJson from "./ko.json";
import { enLocale } from "./en";
import type { LocalePlugin } from "../types";

type MessageKey = keyof typeof enLocale.messages;

const koMessages: Record<MessageKey, string> = koMessagesJson;

/** omp-web 내장 한국어 언어 팩. */
export const koLocale = {
  id: "ko",
  label: "한국어",
  messages: koMessages,
} satisfies LocalePlugin;
