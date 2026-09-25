// 규칙 원문(AGENTS.md·RULES.md)은 한국어 정본으로 두고, 모델에 싣는 사본만 영어 압축본(prompt-copies/)으로 바꾼다.
// Opus 토크나이저에서 한국어 규칙은 약 1.2자/토큰, 영어는 약 4자/토큰이라 같은 규칙이 요청마다 3배 가까이 든다.
// 사본 첫 줄의 source 지문이 현재 원문과 다르면(원문만 고치고 사본을 갱신하지 않음) 그 원문은 그대로 싣는다.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const AGENT_DIR = join(import.meta.dir, "..");
const HEADER = /^<!-- source-fingerprint: ([0-9a-f]+) -->\r?\n/;

/** 원문 지문. 줄바꿈 차이와 앞뒤 공백은 무시한다. 사본 갱신 시 이 값을 사본 첫 줄에 적는다. */
export function sourceFingerprint(text: string): string {
  return Bun.hash(text.replace(/\r\n/g, "\n").trim()).toString(16);
}

/** 사본이 현재 원문에서 만든 것이면 본문을, 아니면 undefined를 돌려준다. */
export function freshCopy(source: string, copy: string): string | undefined {
  const header = HEADER.exec(copy);
  if (!header || header[1] !== sourceFingerprint(source)) return undefined;
  return copy.slice(header[0].length).trim();
}

/** block 안에서 open 태그 뒤부터 close 태그 앞까지를 body로 바꾼다. 태그가 없으면 block을 그대로 돌려준다. */
export function replaceBetween(block: string, open: string, close: string, body: string): string {
  const start = block.indexOf(open);
  if (start < 0) return block;
  const from = start + open.length;
  const end = block.indexOf(close, from);
  if (end < 0) return block;
  return `${block.slice(0, from)}\n${body}\n${block.slice(end)}`;
}

export interface CompactTarget {
  source: string;
  copy: string;
  open: string;
  close: string;
}

export const TARGETS: readonly CompactTarget[] = [
  // 코어는 전역 AGENTS.md를 <file path="…"> 안에 싣고 표 공백을 다듬는다. 경로 태그로 찾아 본문만 바꾼다.
  { source: "AGENTS.md", copy: "prompt-copies/AGENTS.en.md", open: `<file path="${join(AGENT_DIR, "AGENTS.md")}">`, close: "</file>" },
  { source: "RULES.md", copy: "prompt-copies/RULES.en.md", open: "<generic-rules>", close: "</generic-rules>" },
];

export function loadSwaps(agentDir: string, targets: readonly CompactTarget[]): Array<CompactTarget & { body: string }> {
  return targets.flatMap((target) => {
    try {
      const body = freshCopy(readFileSync(join(agentDir, target.source), "utf8"), readFileSync(join(agentDir, target.copy), "utf8"));
      return body ? [{ ...target, body }] : [];
    } catch {
      return [];
    }
  });
}

export default function promptCompact(pi: ExtensionAPI): void {
  // 코어도 AGENTS.md·RULES.md를 시작할 때 한 번 읽으므로 사본도 같은 시점에 한 번만 읽는다.
  const swaps = loadSwaps(AGENT_DIR, TARGETS);
  if (swaps.length === 0) return;
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt.map((block) =>
      swaps.reduce((current, swap) => replaceBetween(current, swap.open, swap.close, swap.body), block),
    ),
  }));
}
