import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * Anthropic 요청 머리(도구 정의와 시스템 블록)의 절 단위 지문을 세션 기록에 남긴다. 모델에는 보내지 않는다.
 * 재시작 뒤 첫 턴이 도구 정의까지만 캐시를 맞히고 시스템 프롬프트를 통째로 다시 쓰는데, 코어 기록은 프롬프트 전체 지문
 * 하나뿐이라 어느 절이 바뀌었는지 가를 수 없었다(2026-11-12 실측, 사용자 결정 「지금 만들어서 바로 배포」).
 * 내용이 직전 기록과 다를 때만 남기므로, 재개 뒤 새 항목이 없으면 요청 머리는 그대로였다는 뜻이다.
 * `<project-context>` 블록이 있는 에이전트 프롬프트만 대상이라 압축 요약 같은 보조 요청은 기록하지 않는다.
 */

export const PROMPT_PREFIX_LEDGER_TYPE = "prompt-prefix-ledger";

const SECTION_START = /^(?:#{1,3}[ \t]|<[a-z][\w-]*[ >])/;
const VOLATILE_MARKERS = ["<memories>", "<project-context>"];
const TITLE_CHARS = 60;

type Section = [title: string, hash: string, chars: number];

export interface PromptPrefixRecord {
  v: 1;
  key: string;
  model?: string;
  tools: Array<[name: string, hash: string]>;
  system: Array<{ hash: string; chars: number; volatile: boolean; sections: Section[] }>;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function sections(text: string): Section[] {
  const out: Section[] = [];
  let title = "(head)";
  let lines: string[] = [];
  const flush = () => {
    if (lines.length === 0) return;
    const body = lines.join("\n");
    out.push([title, digest(body), body.length]);
  };
  for (const line of text.split("\n")) {
    if (SECTION_START.test(line)) {
      flush();
      title = line.trim().slice(0, TITLE_CHARS);
      lines = [];
    }
    lines.push(line);
  }
  flush();
  return out;
}

/** Anthropic 요청 본문에서 기록을 만든다. 에이전트 프롬프트가 아니면 undefined. */
export function promptPrefixRecord(payload: unknown): PromptPrefixRecord | undefined {
  if (!payload || typeof payload !== "object" || !("system" in payload) || !Array.isArray(payload.system)) {
    return undefined;
  }
  const texts = payload.system.flatMap((block: unknown) =>
    block && typeof block === "object" && "text" in block && typeof block.text === "string" ? [block.text] : [],
  );
  if (!texts.some((text) => text.startsWith("<project-context>"))) return undefined;

  let volatile = false;
  const system = texts.map((text) => {
    volatile ||= VOLATILE_MARKERS.some((marker) => text.startsWith(marker));
    return { hash: digest(text), chars: text.length, volatile, sections: sections(text) };
  });
  const wireTools: unknown[] = "tools" in payload && Array.isArray(payload.tools) ? payload.tools : [];
  const tools = wireTools.flatMap((tool): Array<[string, string]> => {
    if (!tool || typeof tool !== "object") return [];
    // cache_control 위치는 요청마다 옮겨 다니므로 정의 지문에서 뺀다.
    const { cache_control: _cacheControl, ...definition } = tool as Record<string, unknown>;
    const name = typeof definition.name === "string" ? definition.name : "?";
    return [[name, digest(JSON.stringify(definition))]];
  });
  const key = digest(JSON.stringify([tools, system]));
  const model = "model" in payload && typeof payload.model === "string" ? payload.model : undefined;
  return { v: 1, key, ...(model ? { model } : {}), tools, system };
}

function lastRecordedKey(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== PROMPT_PREFIX_LEDGER_TYPE) continue;
    const data: unknown = entry.data;
    return data && typeof data === "object" && "key" in data && typeof data.key === "string" ? data.key : undefined;
  }
  return undefined;
}

export default function promptPrefixLedger(pi: ExtensionAPI): void {
  // 매 요청마다 현재 분기의 마지막 기록과 비교한다. 재시작, 세션 전환, 분기 이동 뒤에도 기준이 그 분기의 기록이다.
  pi.on("before_provider_request", (event, ctx) => {
    const record = promptPrefixRecord(event.payload);
    if (!record || record.key === lastRecordedKey(ctx)) return;
    pi.appendEntry(PROMPT_PREFIX_LEDGER_TYPE, record);
  });
}
