import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, sep } from "node:path";
import { commitRoutineChange } from "./git-sync";
import { parsePostKey, postFileStartedAt } from "./post-key";
import { thisRoutineHost } from "./store";

/**
 * PC별 읽음 기록. 공용 루틴 저장소의 `reads/<PC 이름>.json`(`{ "version": 1, "posts": ["<루틴 id>/<글 파일>", ...] }`)에
 * 이 PC에서 열어 본 글을 둔다. 각 서버는 자기 파일만 쓰므로 PC끼리 내용이 부딪히지 않고, 읽음은 모든 파일의 합집합이다.
 * 글 파일 이름의 실행 시각이 8일을 넘은 키는 쓸 때 버려 파일이 계속 자라지 않는다(「새 글」은 7일 안의 글만 센다).
 *
 * 열어 본 글은 서버 메모리에 모았다가 `FLUSH_DELAY_MS` 뒤 한 번의 커밋으로 올린다(클릭마다 커밋하지 않는다). 올리지
 * 못하면 키를 남겨 다시 시도한다. 서버가 그 사이 꺼져 잃은 키는 브라우저가 목록을 받을 때 다시 올려 준다.
 */

export const READS_DIR = "reads";
export const FLUSH_DELAY_MS = 45_000;
const FILE_VERSION = 1;
const KEEP_MS = 8 * 24 * 60 * 60 * 1000;
const FILE_SIZE_LIMIT = 1024 * 1024;
const PENDING_LIMIT = 2000;
const HOST_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface PendingReads {
  keys: Set<string>;
  dir: string;
  timer: NodeJS.Timeout | null;
}

declare global {
  var __cueloRoutineReads: PendingReads | undefined;
}

function pending(): PendingReads {
  globalThis.__cueloRoutineReads ??= { keys: new Set(), dir: "", timer: null };
  return globalThis.__cueloRoutineReads;
}

/** 읽음 키로 받을 수 있는 글 키이고 아직 정리 기간 안인지. */
function isRecentKey(key: string, now: number): boolean {
  const parsed = parsePostKey(key);
  const at = parsed ? postFileStartedAt(parsed.file) : null;
  return at !== null && now - at <= KEEP_MS;
}

/** 파일 이름으로 안전한 PC 이름인지(`thisRoutineHost()`는 소문자·숫자·하이픈이다). */
export const isSafeReadsHost = (host: string) => HOST_PATTERN.test(host);

/** `reads/<file>`이 저장소 안의 일반 경로이고 `reads` 폴더와 파일이 심볼릭 링크가 아닌지. 아직 없는 경로는 있는 데까지만 본다. */
function isReadsContained(dir: string, file: string): boolean {
  try {
    const root = realpathSync(dir);
    let current = root;
    for (const part of [READS_DIR, file]) {
      current = join(current, part);
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (!stat) return true;
      if (stat.isSymbolicLink()) return false;
    }
    return realpathSync(current).startsWith(root + sep);
  } catch {
    return false;
  }
}

/** 파일 하나의 유효한 키. 깨졌거나 다른 version이거나 저장소 밖을 가리키면 빈 목록. */
function readReadsFile(dir: string, file: string): string[] {
  if (!isReadsContained(dir, file)) return [];
  try {
    const path = join(dir, READS_DIR, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > FILE_SIZE_LIMIT) return [];
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return [];
    const { version, posts } = raw as { version?: unknown; posts?: unknown };
    if (version !== FILE_VERSION || !Array.isArray(posts)) return [];
    return posts.filter((key): key is string => typeof key === "string" && parsePostKey(key) !== null);
  } catch {
    return [];
  }
}

/** 모든 PC의 읽음 파일 합집합(정리 기간 안의 키만). */
export function readSavedReadKeys(dir: string, now = Date.now()): Set<string> {
  let files: string[];
  try {
    files = readdirSync(join(dir, READS_DIR));
  } catch {
    return new Set();
  }
  const keys = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    for (const key of readReadsFile(dir, file)) if (isRecentKey(key, now)) keys.add(key);
  }
  return keys;
}

/** 화면에 돌려줄 읽음 집합: 저장소의 합집합에 아직 올리지 못한 이 서버 메모리의 키를 더한다. */
export function routineReadKeys(dir: string, now = Date.now()): string[] {
  const keys = readSavedReadKeys(dir, now);
  for (const key of pending().keys) if (isRecentKey(key, now)) keys.add(key);
  return [...keys].sort();
}

/**
 * 이 PC의 읽음 파일에 `keys`를 합쳐 쓴다(오래된 키는 버린다). `commitRoutineChange`의 `mutate`로 쓰이며 자기 파일 말고는
 * 건드리지 않는다. 파일 내용이 이미 같아도 그 경로를 돌려준다: 앞선 커밋 시도가 파일만 쓰고 실패했다면 다음 시도가
 * 그 파일을 커밋해야 하고, 바뀐 게 없으면 `commitRoutineChange`가 커밋하지 않는다.
 */
export function mergeOwnReads(dir: string, host: string, keys: Iterable<string>, now = Date.now()): { paths: string[]; result: number } {
  if (!isSafeReadsHost(host)) throw new Error(`unsafe routine host name for a reads file: ${host}`);
  const file = `${host}.json`;
  if (!isReadsContained(dir, file)) throw new Error(`reads folder is outside the repository: ${file}`);
  const before = readReadsFile(dir, file);
  const next = new Set(before.filter((key) => isRecentKey(key, now)));
  for (const key of keys) if (isRecentKey(key, now)) next.add(key);
  const posts = [...next].sort();
  const sortedBefore = [...before].sort();
  const unchanged = posts.length === sortedBefore.length && posts.every((key, i) => key === sortedBefore[i]);
  const relPath = `${READS_DIR}/${file}`;
  const path = join(dir, READS_DIR, file);
  if (unchanged) return { paths: existsSync(path) ? [relPath] : [], result: 0 };
  mkdirSync(join(dir, READS_DIR), { recursive: true });
  // 임시 파일은 새로 만들어(wx: 이미 있는 경로나 심볼릭 링크면 실패) 저장소 밖 파일을 덮어쓰지 않고, 이 호출이 만든 것만 지운다.
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  let created = false;
  try {
    const fd = openSync(temp, "wx");
    created = true;
    try {
      writeFileSync(fd, `${JSON.stringify({ version: FILE_VERSION, posts }, null, 2)}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    if (created) rmSync(temp, { force: true });
    throw error;
  }
  return { paths: [relPath], result: posts.length - before.length };
}

function schedule(): void {
  const p = pending();
  if (p.timer || p.keys.size === 0) return;
  p.timer = setTimeout(() => void flushRoutineReads(), FLUSH_DELAY_MS);
  p.timer.unref?.();
}

/** 열어 본 글 키를 서버 메모리에 모으고 한 번에 올릴 시각을 잡는다. 형식이나 기간이 맞지 않는 키는 버리고 받은 개수를 돌려준다. */
export function queueRoutineReads(dir: string, keys: Iterable<string>, now = Date.now()): number {
  const p = pending();
  p.dir = dir;
  let accepted = 0;
  for (const key of keys) {
    if (!isRecentKey(key, now)) continue;
    if (!p.keys.has(key) && p.keys.size >= PENDING_LIMIT) continue;
    p.keys.add(key);
    accepted += 1;
  }
  schedule();
  return accepted;
}

/** 모아 둔 키를 이 PC의 읽음 파일로 커밋해 올린다. 실패하면 키를 남기고 다시 잡는다. */
export async function flushRoutineReads(): Promise<void> {
  const p = pending();
  if (p.timer) {
    clearTimeout(p.timer);
    p.timer = null;
  }
  const batch = [...p.keys];
  if (batch.length === 0 || !p.dir) return;
  const host = thisRoutineHost();
  try {
    await commitRoutineChange(p.dir, `reads(${host}): ${batch.length} posts`, () => mergeOwnReads(p.dir, host, batch));
    for (const key of batch) p.keys.delete(key);
  } catch {
    // 키를 그대로 두고 다음 시각에 다시 시도한다.
  }
  schedule();
}
