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

// 영어 사본에서 Main만 지키는 항목(배포·git_finalize·cross_review gate·한국어 응답)을 감싸는 표시. 표시 줄 자체는
// 모든 세션에서 지우므로 Main이 받는 본문은 표시를 넣기 전과 같다. Maker child는 감싼 항목까지 지운다.
const MAIN_ONLY_MARK = /^[ \t]*<!-- \/?main-only -->\r?\n/gm;
const MAIN_ONLY_SPAN = /^[ \t]*<!-- main-only -->\r?\n[\s\S]*?^[ \t]*<!-- \/main-only -->\r?\n/gm;

/** 사본 본문에서 main-only 표시를 처리한다. maker면 감싼 항목을 지우고, 아니면 표시 줄만 지운다. */
export function applyMainOnly(body: string, maker: boolean): string {
  return maker ? body.replace(MAIN_ONLY_SPAN, "") : body.replace(MAIN_ONLY_MARK, "");
}

const SKILLS_OPEN = "<skills>\n";
const SKILLS_CLOSE = "\n</skills>";
export const SKILL_NAMES_POINTER =
  "Names only. Main hands the skills a slice needs in the brief; read `skill://<name>` before using one (an unknown name lists every loaded skill).";

/**
 * Maker child용 Skill 목록: 설명 없이 이름만 남긴다. 설명 포함 목록은 Maker 첫 요청마다 약 6.3K 토큰이었고,
 * 필요한 Skill은 Main이 브리프로 넘긴다(rule://subagent 「Skill 인계」). `skill://` 해석은 session.skills에서
 * 하므로 프롬프트 목록을 줄여도 읽기는 그대로 된다.
 */
export function namesOnlySkills(block: string): string {
  const start = block.indexOf(SKILLS_OPEN);
  if (start < 0) return block;
  const from = start + SKILLS_OPEN.length;
  const end = block.indexOf(SKILLS_CLOSE, from);
  if (end < 0) return block;
  const names = block
    .slice(from, end)
    .split("\n")
    .flatMap((line) => /^- ([^:\s][^:]*):/.exec(line)?.[1] ?? []);
  if (names.length === 0) return block;
  return `${block.slice(0, from)}${SKILL_NAMES_POINTER}\n${names.join(", ")}${block.slice(end)}`;
}

export default function promptCompact(pi: ExtensionAPI): void {
  // 코어도 AGENTS.md·RULES.md를 시작할 때 한 번 읽으므로 사본도 같은 시점에 한 번만 읽는다.
  const swaps = loadSwaps(AGENT_DIR, TARGETS);
  const mainBodies = swaps.map((swap) => applyMainOnly(swap.body, false));
  const makerBodies = swaps.map((swap) => applyMainOnly(swap.body, true));
  pi.on("before_agent_start", (event, ctx) => {
    // Maker child만 줄인다. 다른 subagent(advisor·/tan 복제 등)와 Main은 기존 본문을 받는다.
    // 사본이 낡아 교체할 것이 없어도 Maker Skill 목록은 줄인다.
    const maker = ctx?.agent?.kind === "sub" && ctx.agent.name === "maker";
    if (!maker && swaps.length === 0) return undefined;
    const bodies = maker ? makerBodies : mainBodies;
    return {
      systemPrompt: event.systemPrompt.map((block) => {
        const swapped = swaps.reduce((current, swap, index) => replaceBetween(current, swap.open, swap.close, bodies[index]!), block);
        return maker ? namesOnlySkills(swapped) : swapped;
      }),
    };
  });
}
