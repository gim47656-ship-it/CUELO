import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { spawnExec } from "../lib/cross-review";
import { extractVisible, type Extracted } from "./extract";

/**
 * git이 추적하는 파일은 HEAD 대비 추가·바뀐 글만 모델에 보낸다(긴 CHANGELOG의 옛 항목이 매 릴리스를 막지 않게).
 * 통과 기록은 그대로 현재 파일 전체의 sha256에 묶는다. 추적하지 않는 파일·HEAD에 없는 파일·git을 읽지 못하는 경우·
 * 저장소 밖 산출물은 전체를 본다(판정하지 못하면 줄이지 않는다). office·pdf는 추출한 글끼리 비교한다.
 */

const CONTEXT_LINES = 3;

export interface Delta { text: string; source?: string; addedLines: number }

const norm = (line: string) => line.replace(/\s+/g, " ").trim();

/** 현재 줄 중 HEAD에 없는(또는 HEAD보다 더 많이 나온) 줄의 색인. 위치가 옮겨진 줄은 새 줄이 아니다. */
export function addedIndexes(current: readonly string[], head: readonly string[]): Set<number> {
  const counts = new Map<string, number>();
  for (const line of head) counts.set(norm(line), (counts.get(norm(line)) ?? 0) + 1);
  const added = new Set<number>();
  current.forEach((line, index) => {
    const key = norm(line);
    if (key === "") return;
    const left = counts.get(key) ?? 0;
    if (left > 0) counts.set(key, left - 1);
    else added.add(index);
  });
  return added;
}

/** 추가 줄은 `+ `, 읽기용 앞뒤 줄은 두 칸 들여 붙이고 떨어진 구간은 `…`로 가른다. */
export function hunks(lines: readonly string[], added: ReadonlySet<number>): string {
  const keep = new Set<number>();
  for (const index of added) for (let i = Math.max(0, index - CONTEXT_LINES); i <= Math.min(lines.length - 1, index + CONTEXT_LINES); i += 1) keep.add(i);
  const out: string[] = [];
  let last = -2;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index !== last + 1 && out.length > 0) out.push("…");
    out.push(`${added.has(index) ? "+ " : "  "}${lines[index]}`);
    last = index;
  }
  return out.join("\n");
}

/** 바뀐 것이 없으면(삭제뿐) addedLines가 0이다. source가 있으면(html) 원문도 같은 방식으로 자른다. */
export function deltaOf(current: Extracted, head: Extracted): Delta {
  const lines = current.text.split("\n");
  const added = addedIndexes(lines, head.text.split("\n"));
  let addedLines = added.size;
  const out: Delta = { text: hunks(lines, added), addedLines };
  if (current.source !== undefined) {
    const sourceLines = current.source.split("\n");
    const sourceAdded = addedIndexes(sourceLines, (head.source ?? "").split("\n"));
    out.source = hunks(sourceLines, sourceAdded);
    addedLines += sourceAdded.size;
    out.addedLines = addedLines;
  }
  return out;
}

/** 이 파일의 HEAD 버전을 같은 확장자의 임시 파일로 꺼내 추출한다. 추적하지 않거나 읽지 못하면 undefined(전체 심사). */
export async function headExtracted(abs: string, extract: (path: string) => Promise<Extracted> = extractVisible): Promise<Extracted | undefined> {
  const exec = spawnExec();
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(abs) });
  if (top.code !== 0) return undefined;
  const root = top.stdout.trim();
  const rel = relative(root, abs).split("\\").join("/");
  if (!rel || rel.startsWith("..")) return undefined;
  const tracked = await exec("git", ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", rel], { cwd: root });
  if (tracked.code !== 0) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "slop-head-"));
  try {
    const shown = Bun.spawn(["git", "--literal-pathspecs", "show", `HEAD:${rel}`], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [bytes, code] = await Promise.all([new Response(shown.stdout).arrayBuffer(), shown.exited]);
    if (code !== 0) return undefined;
    const copy = join(dir, `head${extname(abs)}`);
    writeFileSync(copy, new Uint8Array(bytes));
    return await extract(copy);
  } catch { return undefined; } finally { rmSync(dir, { recursive: true, force: true }); }
}
