/**
 * 야간 묶음에 싣는 플러그인 이벤트 집계(종류 이름, 건수, 시각만). 하네스 플러그인은 프로필 폴더의
 * `cuelo-<id>-events.jsonl`에 줄마다 `kind`·`type`·`event` 가운데 하나와 `at`이나 `ts` 시각을 남긴다. HANDOFF의 플러그인
 * 관찰 행(화면 빠른 경로의 blocked/allowed, errexit 정리의 reset 등)을 클라우드가 PC 기록으로 판정하려고 둔다
 * (2026-11-23 야간: 이 자료가 PC 묶음에 없어 관찰 행이 거듭 미측정으로 남음).
 *
 * 세션 id, 경로, 질문 같은 본문은 읽기만 하고 싣지 않는다. 종류 이름은 영문 소문자 낱말 모양만 싣고(숫자가 든 id나 긴
 * 16진 문자열은 종류 자리에 있어도 거른다), 그 밖의 값이나 시각을 읽지 못한 줄은 `unreadable`로만 센다.
 */

import { constants } from "node:fs";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_EVENT_DAYS = 14;
const DAY_MS = 86_400_000;
export const PLUGIN_EVENT_FILE = /^cuelo-([a-z0-9][a-z0-9-]{0,47})-events\.jsonl$/;
export const PLUGIN_FILE_LIMIT = 40;
export const PLUGIN_KIND_LIMIT = 20;
const KIND_SHAPE = /^[a-z]+(?:[-_:][a-z]+){0,5}$/;
const CHUNK_BYTES = 64 * 1024;
/** 이보다 긴 한 줄은 내용을 모으지 않고 읽지 못한 줄로 센다(메모리가 파일 크기를 따라가지 않게). */
const LINE_LIMIT = 1024 * 1024;

/** 기록 종류로 내보낼 수 있는 이름인지. 휴리스틱이다: 숫자 없는 소문자 낱말만 받고, 구분자를 뺀 a-f 8자 이상(16진 id 모양)은 거른다. */
export function isPluginEventKind(value: string): boolean {
  return value.length <= 40 && KIND_SHAPE.test(value) && !/^[a-f]{8,}$/.test(value.replace(/[-_:]/g, ""));
}

/** 종류 하나. `recent`는 집계 시각 앞 14일(`from`~`to`) 안의 줄이다. */
export interface PluginEventKind {
  kind: string;
  total: number;
  recent: number;
}

/** 이벤트 파일 하나. `first`와 `last`는 읽은 줄의 가장 이른·늦은 시각이며 읽은 줄이 없으면 null이다. */
export interface PluginEventFile {
  plugin: string;
  first: string | null;
  last: string | null;
  kinds: PluginEventKind[];
  unreadable: number;
}

/** `partial`이면 파일 일부를 읽지 못했거나 상한 때문에 종류나 파일을 덜 실었다. */
export interface PluginEventExport {
  from: string;
  to: string;
  partial: boolean;
  plugins: PluginEventFile[];
}

type Row = { kind: string; time: number } | null;

function readRow(line: string): Row {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = [record.kind, record.type, record.event].find((field) => typeof field === "string");
  const stamp = [record.at, record.ts].find((field) => typeof field === "string");
  const time = typeof stamp === "string" ? Date.parse(stamp) : NaN;
  return typeof kind === "string" && isPluginEventKind(kind) && Number.isFinite(time) ? { kind, time } : null;
}

/** 한 파일의 줄을 받아 센다. 집계 시각(`to`)보다 늦은 줄은 그 뒤에 생긴 기록이라 어디에도 세지 않는다. */
class EventCounter {
  private readonly kinds = new Map<string, PluginEventKind>();
  private unreadable = 0;
  private first = Infinity;
  private last = -Infinity;

  constructor(private readonly plugin: string, private readonly from: number, private readonly to: number) {}

  /** `null`은 길이 상한을 넘은 줄이다. 공백뿐인 줄도 기록이 아니므로 읽지 못한 줄로 센다. */
  line(text: string | null): void {
    const row = text === null || !text.trim() ? null : readRow(text);
    if (!row) {
      this.unreadable += 1;
      return;
    }
    // 집계 시각보다 늦은 줄(시계가 어긋났거나 집계 중에 붙은 줄)은 기간에 넣지 않고 읽지 못한 줄로 드러낸다.
    if (row.time > this.to) {
      this.unreadable += 1;
      return;
    }
    const entry = this.kinds.get(row.kind) ?? { kind: row.kind, total: 0, recent: 0 };
    entry.total += 1;
    if (row.time >= this.from) entry.recent += 1;
    this.kinds.set(row.kind, entry);
    this.first = Math.min(this.first, row.time);
    this.last = Math.max(this.last, row.time);
  }

  result(): { file: PluginEventFile; truncated: boolean } {
    const sorted = [...this.kinds.values()].sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind));
    const seen = sorted.length > 0;
    return {
      file: {
        plugin: this.plugin,
        first: seen ? new Date(this.first).toISOString() : null,
        last: seen ? new Date(this.last).toISOString() : null,
        kinds: sorted.slice(0, PLUGIN_KIND_LIMIT),
        unreadable: this.unreadable,
      },
      truncated: sorted.length > PLUGIN_KIND_LIMIT,
    };
  }
}

/**
 * 일반 파일만 조각 단위로 읽어 줄바꿈까지 쓰인 줄을 넘긴다. 열 때의 크기까지만 읽어 계속 자라는 파일에서도 끝난다. 줄바꿈으로
 * 끝나지 않은 마지막 조각은 쓰는 중일 수 있어 넘기지 않는다. 심볼릭 링크(`O_NOFOLLOW`), FIFO 같은 일반 파일이 아닌 것과
 * 읽기나 닫기 오류는 false다.
 */
async function readEventLines(path: string, onLine: (line: string | null) => void): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  let ok = false;
  try {
    const stat = await handle.stat();
    if (stat.isFile()) {
      await readLines(handle, stat.size, onLine);
      ok = true;
    }
  } catch {
    ok = false;
  }
  try {
    await handle.close();
  } catch {
    return false;
  }
  return ok;
}

async function readLines(handle: FileHandle, size: number, onLine: (line: string | null) => void): Promise<void> {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let overflow = false;
  let left = size;
  while (left > 0) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, left), null);
    if (bytesRead === 0) return;
    left -= bytesRead;
    const chunk = buffer.subarray(0, bytesRead);
    let start = 0;
    for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, end);
      onLine(overflow || pendingBytes + piece.length > LINE_LIMIT ? null : Buffer.concat([...pending, piece]).toString("utf8"));
      pending = [];
      pendingBytes = 0;
      overflow = false;
      start = end + 1;
    }
    if (start < bytesRead && !overflow) {
      const rest = chunk.subarray(start);
      if (pendingBytes + rest.length > LINE_LIMIT) {
        overflow = true;
        pending = [];
        pendingBytes = 0;
      } else {
        pending.push(Buffer.from(rest));
        pendingBytes += rest.length;
      }
    }
  }
}

/** 프로필 폴더 자체를 읽지 못하면 0건이 아니라 집계 없음(미측정)으로 돌려준다. */
export async function collectPluginEvents(agentDir: string, now: Date): Promise<PluginEventExport | undefined> {
  let names: string[];
  try {
    names = await readdir(agentDir);
  } catch {
    return undefined;
  }
  const to = now.getTime();
  const from = to - PLUGIN_EVENT_DAYS * DAY_MS;
  const matched = names.flatMap((name) => {
    const match = PLUGIN_EVENT_FILE.exec(name);
    return match ? [{ name, plugin: match[1]! }] : [];
  }).sort((a, b) => a.plugin.localeCompare(b.plugin));
  let partial = matched.length > PLUGIN_FILE_LIMIT;
  const plugins: PluginEventFile[] = [];
  for (const { name, plugin } of matched.slice(0, PLUGIN_FILE_LIMIT)) {
    const counter = new EventCounter(plugin, from, to);
    if (!(await readEventLines(join(agentDir, name), (line) => counter.line(line)))) {
      partial = true;
      continue;
    }
    const { file, truncated } = counter.result();
    partial ||= truncated;
    plugins.push(file);
  }
  return { from: new Date(from).toISOString(), to: now.toISOString(), partial, plugins };
}
