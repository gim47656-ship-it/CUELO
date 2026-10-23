"use client";

import { createContext } from "react";

/**
 * 지금 세션의 입력창에 파일을 붙이고, `text`가 있으면 커서 자리에 넣은 뒤(지우지 않음) 입력창으로 초점을
 * 옮긴다. 붙일 입력창이 없으면 false를 돌려준다. 보내지는 않는다. 붙이기는 붙여넣기·끌어 놓기와 같은 첨부
 * 경로(`ChatInputHandle.addAttachments`)를 지나므로 크기·개수 초과 같은 오류는 입력창이 알린다.
 */
export type AttachToComposer = (files: File[], text?: string) => boolean;

export const ComposerAttachContext = createContext<AttachToComposer | null>(null);
