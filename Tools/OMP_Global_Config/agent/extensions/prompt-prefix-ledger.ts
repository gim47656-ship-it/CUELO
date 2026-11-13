import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SECRET_PATTERN } from "./lib/interpreter";
import { onSessionLifecycle } from "./lib/session-identity";

/**
 * Anthropic 요청 머리(도구 정의와 시스템 블록)의 절 단위 지문을 세션 기록에 남긴다. 모델에는 보내지 않는다.
 * 재시작 뒤 첫 턴이 도구 정의까지만 캐시를 맞히고 시스템 프롬프트를 통째로 다시 쓰는데, 코어 기록은 프롬프트 전체 지문
 * 하나뿐이라 어느 절이 바뀌었는지 가를 수 없었다(2026-11-12 실측, 사용자 결정 「지금 만들어서 바로 배포」).
 * 내용이 직전 기록과 다를 때만 남기므로, 재개 뒤 새 항목이 없으면 요청 머리는 그대로였다는 뜻이다.
 * `<project-context>` 블록이 있는 에이전트 프롬프트만 대상이라 압축 요약 같은 보조 요청은 기록하지 않는다.
 */

/**
 * 대화 메시지 쪽 끊김 기록(2026-11-13, 사용자 결정 「분석을 바탕으로 수정하자」). 7일 실측에서 미스의 대부분은 재시작 뒤 첫 요청과
 * 새 사용자 턴 직후(Astra 사용자 턴의 23%, Opus 11%, 턴 중간은 0.1%)였고, 시스템 머리는 그대로인데 대화 앞부분이 바뀌었다.
 * 요청마다 직전 요청의 메시지와 비교해, 앞부분이 바뀌어 잃는 분량이 크면 바뀐 첫 위치와 그 앞뒤 글자를 남긴다.
 * 재시작 비교는 종료 때 남긴 메시지 지문(snapshot)으로 한다. Codex 웹소켓의 이어 보내기(previous_response_id) 요청은
 * 일부만 담겨 비교하지 않고, 이어 보내기가 끊겨 전체를 다시 보낸 요청을 chain-reset으로 남긴다.
 */
export const PROMPT_PREFIX_BREAK_TYPE = "prompt-prefix-break";
export const PROMPT_PREFIX_SNAPSHOT_TYPE = "prompt-prefix-snapshot";
/** 이보다 적게 잃는 끊김(끝 메시지 한두 개)은 캐시 손실이 작아 남기지 않는다. 글자 수 기준(약 5천 토큰). */
export const MIN_LOST_CHARS = 20_000;
const EXCERPT_BEFORE = 120;
const EXCERPT_AFTER = 240;

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

/** 비교 단위로 펼친 요청. head는 시스템·도구(또는 instructions·도구), items는 메시지를 cache_control 없이 직렬화한 것이다. */
export interface WireUnits {
  wire: "anthropic" | "responses";
  model?: string;
  head: string;
  items: string[];
  /** Codex 웹소켓이 직전 응답에 이어 보낸 요청이라 input이 일부뿐이다. */
  chained: boolean;
}

function serialize(value: unknown): string {
  // cache_control 위치는 요청마다 마지막 메시지로 옮겨 다니므로 비교에서 뺀다.
  return JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner)) ?? "";
}

/** 에이전트 프롬프트 요청을 비교 단위로 펼친다. 에이전트 프롬프트가 아니면 undefined. */
export function wireUnits(payload: unknown): WireUnits | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const body = payload as Record<string, unknown>;
  const model = typeof body.model === "string" ? body.model : undefined;
  if (Array.isArray(body.system) && Array.isArray(body.messages)) {
    const agent = body.system.some((block: unknown) =>
      block !== null && typeof block === "object" && "text" in block && typeof block.text === "string" && block.text.startsWith("<project-context>"));
    if (!agent) return undefined;
    return { wire: "anthropic", model, head: serialize([body.system, body.tools]), items: body.messages.map(serialize), chained: false };
  }
  if (!Array.isArray(body.input)) return undefined;
  // 이어 보내기 요청은 비교하지 않으므로 직렬화하지 않는다.
  if (typeof body.previous_response_id === "string") return { wire: "responses", model, head: "", items: [], chained: true };
  const head = serialize([body.instructions, body.tools]);
  const items = body.input.map(serialize);
  // Codex는 system 블록 0을 instructions로, 나머지(<project-context> 포함)를 input 앞 developer 항목으로 싣는다.
  if (!head.includes("<project-context>") && !items.slice(0, 8).some((item) => item.includes("<project-context>"))) return undefined;
  return { wire: "responses", model, head, items, chained: false };
}

function excerpt(text: string, at: number): string {
  const piece = text.slice(Math.max(0, at - EXCERPT_BEFORE), at + EXCERPT_AFTER);
  return SECRET_PATTERN.test(piece) ? "[생략: 비밀값처럼 보이는 내용]" : piece;
}

function firstDifference(left: string, right: string): number {
  const end = Math.min(left.length, right.length);
  let index = 0;
  while (index < end && left.charCodeAt(index) === right.charCodeAt(index)) index++;
  return index;
}

function roleOf(item: string | undefined): string | undefined {
  if (!item) return undefined;
  try {
    const parsed = JSON.parse(item) as { role?: unknown; type?: unknown };
    return typeof parsed.role === "string" ? parsed.role : typeof parsed.type === "string" ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

/** 직전 요청의 비교 상태. texts는 같은 프로세스에서 본 요청에만 있고, 재시작 뒤 snapshot에서 되살린 상태에는 없다. */
interface LastRequest {
  wire: WireUnits["wire"];
  model?: string;
  head: string;
  headChars: number;
  digests: string[];
  chars: number[];
  texts?: string[];
  headText?: string;
  at: number;
}

export interface PromptPrefixBreak {
  v: 1;
  kind: "rewrite" | "chain-reset";
  wire: WireUnits["wire"];
  model?: string;
  /** 재시작 뒤 첫 요청을 종료 때 snapshot과 비교했다. */
  restart: boolean;
  /** rewrite는 직전 전체 요청부터, chain-reset은 직전 에이전트 요청(이어 보낸 요청 포함)부터 지난 시간. */
  gapMs: number;
  prevCount?: number;
  curCount: number;
  /** 바뀐 첫 메시지 위치. "head"는 시스템·도구(instructions) 쪽이다. */
  index?: number | "head";
  /** 처음 다른 글자부터 직전 요청 끝까지의 글자 수: 캐시에서 다시 써야 하는 분량. */
  lostChars?: number;
  role?: string;
  prevChars?: number;
  curChars?: number;
  /** 그 메시지(또는 머리) 직렬화에서 처음 다른 글자 위치와 앞뒤 발췌. 재시작 비교에는 직전 내용이 없어 cur만 있다. */
  offset?: number;
  prev?: string;
  cur?: string;
  /** 이 전체 요청 직전까지 Codex가 이어 보낸 요청 수. */
  chained?: number;
}

interface Digests { head: string; items: string[]; chars: number[] }

function digests(units: WireUnits): Digests {
  return { head: digest(units.head), items: units.items.map(digest), chars: units.items.map((item) => item.length) };
}

/** 직전 요청과 지금 요청을 비교해 큰 앞부분 끊김이면 기록 내용을 돌려준다. 모델이나 전송 형식이 다르면 비교하지 않는다. */
export function comparePrefix(last: LastRequest, units: WireUnits, current: Digests, now: number, restart: boolean): PromptPrefixBreak | undefined {
  if (last.wire !== units.wire || last.model !== units.model) return undefined;
  const base = {
    v: 1 as const, wire: units.wire, ...(units.model ? { model: units.model } : {}), restart,
    gapMs: now - last.at, prevCount: last.digests.length, curCount: units.items.length,
  };
  const messageChars = last.chars.reduce((sum, value) => sum + value, 0);
  if (current.head !== last.head) {
    // 머리가 바뀌면 그 지점 뒤 머리와 대화 전체를 다시 쓴다. Anthropic 머리 절 변화는 원장이 따로 남기고 여기서는 손실과 발췌를 남긴다.
    const offset = last.headText === undefined ? 0 : firstDifference(last.headText, units.head);
    const lostChars = last.headChars - offset + messageChars;
    if (lostChars < MIN_LOST_CHARS) return undefined;
    return {
      ...base, kind: "rewrite", index: "head", lostChars, prevChars: last.headChars, curChars: units.head.length, offset,
      ...(last.headText === undefined ? {} : { prev: excerpt(last.headText, offset) }),
      cur: excerpt(units.head, offset),
    };
  }
  let index = 0;
  const shared = Math.min(last.digests.length, current.items.length);
  while (index < shared && last.digests[index] === current.items[index]) index++;
  if (index === last.digests.length) return undefined;
  const curText = units.items[index];
  const prevText = last.texts?.[index];
  const offset = prevText === undefined || curText === undefined ? 0 : firstDifference(prevText, curText);
  const lostChars = last.chars.slice(index).reduce((sum, value) => sum + value, 0) - offset;
  if (lostChars < MIN_LOST_CHARS) return undefined;
  return {
    ...base, kind: "rewrite", index, lostChars, role: roleOf(curText ?? prevText),
    prevChars: last.chars[index], ...(curText === undefined ? {} : { curChars: curText.length }), offset,
    ...(prevText === undefined ? {} : { prev: excerpt(prevText, offset) }),
    ...(curText === undefined ? {} : { cur: excerpt(curText, offset) }),
  };
}

interface SnapshotData { v: 1; wire: WireUnits["wire"]; model?: string; head: string; headChars: number; items: string[]; chars: number[]; at: number }

function lastSnapshot(ctx: ExtensionContext): LastRequest | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== PROMPT_PREFIX_SNAPSHOT_TYPE) continue;
    const data = entry.data as Partial<SnapshotData> | undefined;
    if (!data || !Array.isArray(data.items) || !Array.isArray(data.chars) || typeof data.head !== "string" || (data.wire !== "anthropic" && data.wire !== "responses")) return undefined;
    return {
      wire: data.wire, model: data.model, head: data.head, headChars: typeof data.headChars === "number" ? data.headChars : 0,
      digests: data.items, chars: data.chars, at: typeof data.at === "number" ? data.at : 0,
    };
  }
  return undefined;
}

export default function promptPrefixLedger(pi: ExtensionAPI, clock: () => number = Date.now): void {
  // 이 세션 인스턴스에서 본 직전 전체 요청. 재시작 뒤 첫 요청은 snapshot과 비교한다.
  let last: LastRequest | undefined;
  let restored = false;
  let chained = 0;
  let lastAgentAt: number | undefined;
  // 다른 세션으로 바뀌면 그 세션 분기의 snapshot부터 다시 본다. 같은 세션 안 분기 이동은 다른 분기와 비교하지 않도록 기준만 버린다.
  const forget = (reloadSnapshot: boolean) => {
    last = undefined;
    restored = !reloadSnapshot;
    chained = 0;
    lastAgentAt = undefined;
  };
  const append = (customType: string, data: unknown) => {
    try {
      pi.appendEntry(customType, data);
    } catch {
      // 진단 기록 실패가 요청이나 종료를 막지 않는다. 다음 비교 기준은 이미 지금 요청으로 옮겼다.
    }
  };
  onSessionLifecycle(pi, { start: () => forget(true) });
  pi.on("session_tree", () => forget(false));
  pi.on("session_branch", () => forget(false));

  // 매 요청마다 현재 분기의 마지막 기록과 비교한다. 재시작, 세션 전환, 분기 이동 뒤에도 기준이 그 분기의 기록이다.
  pi.on("before_provider_request", (event, ctx) => {
    const record = promptPrefixRecord(event.payload);
    if (record && record.key !== lastRecordedKey(ctx)) pi.appendEntry(PROMPT_PREFIX_LEDGER_TYPE, record);

    const units = wireUnits(event.payload);
    if (!units) return;
    const now = clock();
    const idleMs = lastAgentAt === undefined ? undefined : now - lastAgentAt;
    lastAgentAt = now;
    if (units.chained) {
      chained++;
      return;
    }
    const baseline = last ?? (restored ? undefined : lastSnapshot(ctx));
    const restart = last === undefined;
    const current = digests(units);
    const found = baseline ? comparePrefix(baseline, units, current, now, restart) : undefined;
    const entry: PromptPrefixBreak | undefined = found
      ? { ...found, ...(chained > 0 ? { chained } : {}) }
      : chained > 0
        ? {
          v: 1, kind: "chain-reset", wire: units.wire, ...(units.model ? { model: units.model } : {}), restart,
          gapMs: idleMs ?? 0, ...(baseline ? { prevCount: baseline.digests.length } : {}), curCount: units.items.length, chained,
        }
        : undefined;
    restored = true;
    last = {
      wire: units.wire, model: units.model, head: current.head, headChars: units.head.length,
      digests: current.items, chars: current.chars, texts: units.items, headText: units.head, at: now,
    };
    chained = 0;
    if (entry) append(PROMPT_PREFIX_BREAK_TYPE, entry);
  });

  // 재시작 비교용 지문은 종료 때 한 번만 남긴다(요청마다 남기면 세션 기록이 커진다). 내용은 남기지 않는다.
  pi.on("session_shutdown", () => {
    const snapshot: SnapshotData | undefined = last && {
      v: 1, wire: last.wire, ...(last.model ? { model: last.model } : {}), head: last.head, headChars: last.headChars,
      items: last.digests, chars: last.chars, at: last.at,
    };
    forget(true);
    if (snapshot) append(PROMPT_PREFIX_SNAPSHOT_TYPE, snapshot);
  });
}
