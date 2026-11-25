/**
 * 야간 묶음에 싣는 날짜별 캐시 장부 끊김 집계(비식별 정수만). HANDOFF의 「캐시 장부 보조 요청 분리(0.10.300)」 항목은
 * 설치 전후로 Anthropic 장부의 번역 끼어들기 끊김(앞뒤 요청 중 한쪽에만 `[한국어 번역]`이 있는 끊김)이 사라졌는지를 본다.
 * 집 PC 자료가 두 번 빠져 미측정으로 남아(11-18, 11-25 점검) 클라우드가 PC 묶음으로 판정하도록 둔다(2026-11-26 야간).
 * 날짜는 UTC이고 창은 모델 오류 집계와 같은 오늘을 포함한 UTC 14일이다.
 */

import { readFile } from "node:fs/promises";
import { modelErrorFrom, parseLines, utcDay } from "./model-errors";

const BREAK_TYPE = "prompt-prefix-break";
const NEEDLE = Buffer.from(`"${BREAK_TYPE}"`);
const TRANSLATION = "[한국어 번역]";

export interface PrefixBreakDay {
  day: string;
  /** Anthropic 요청의 장부 끊김 기록 수 */
  anthropic: number;
  /** 그중 앞뒤 발췌의 한쪽에만 번역 표시가 있는 끊김 */
  translation: number;
}

/** `from`(창 첫날 UTC 0시)~`to`(집계 시각). 싣지 않은 날은 모두 0이다. `partial`이면 세션 기록 일부를 읽지 못했다. */
export interface PrefixBreakExport {
  from: string;
  to: string;
  partial: boolean;
  days: PrefixBreakDay[];
}

type BreakEntry = { type?: string; id?: string; timestamp?: string; customType?: string; data?: { wire?: unknown; prev?: unknown; cur?: unknown } };

/**
 * `files`는 원본이 먼저 오도록 정렬된 세션 파일이다. fork나 하위 세션 사본에 같은 기록(id와 시각)이 있으면 한 번만 센다.
 * 읽지 못한 파일이나, 끊김 기록 이름이 든 파일의 깨진 줄이 있으면 `partial`이다(모델 오류 집계와 같은 사전 거르기). 모두 0인 날은 싣지 않는다.
 */
export async function collectPrefixBreaks(files: readonly { path: string }[], now: number, partialScan = false): Promise<PrefixBreakExport> {
  const from = modelErrorFrom(now);
  const seen = new Set<string>();
  const byDay = new Map<string, PrefixBreakDay>();
  let partial = partialScan;
  for (const { path } of files) {
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch {
      partial = true;
      continue;
    }
    if (!raw.includes(NEEDLE)) continue;
    const { entries, malformed } = parseLines<BreakEntry>(raw.toString("utf8"));
    partial ||= malformed;
    entries.forEach((entry, index) => {
      if (entry.type !== "custom" || entry.customType !== BREAK_TYPE || entry.data?.wire !== "anthropic") return;
      const time = Date.parse(entry.timestamp ?? "");
      if (!Number.isFinite(time) || time < from || time > now) return;
      const key = entry.id ? `${entry.id}:${entry.timestamp}` : `${path}#${index}`;
      if (seen.has(key)) return;
      seen.add(key);
      const day = utcDay(time);
      let counts = byDay.get(day);
      if (!counts) byDay.set(day, (counts = { day, anthropic: 0, translation: 0 }));
      counts.anthropic++;
      const { prev, cur } = entry.data;
      if ((typeof prev === "string" && prev.includes(TRANSLATION)) !== (typeof cur === "string" && cur.includes(TRANSLATION))) counts.translation++;
    });
  }
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  return { from: new Date(from).toISOString(), to: new Date(now).toISOString(), partial, days };
}
