import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { extractVisible, type Extracted } from "./extract";

/**
 * git이 추적하는 파일은 HEAD 대비 추가·바뀐 글만 모델에 보낸다(긴 CHANGELOG의 옛 항목이 매 릴리스를 막지 않게).
 * 통과 기록은 그대로 현재 파일 전체의 sha256에 묶는다. HEAD에 파일이 없거나 저장소 밖 산출물이면 전체를 본다.
 * Git 조회·추출 실패 시에는 심사를 중단한다. office·pdf는 추출한 글끼리 비교한다.
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

/** 이 파일의 HEAD 버전을 같은 확장자의 임시 파일로 꺼내 추출한다. */
export async function headExtracted(abs: string, extract: (path: string) => Promise<Extracted> = extractVisible): Promise<Extracted | undefined> {
  const git = async (cwd: string, args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, LC_ALL: "C" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [bytes, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    return { bytes, stderr: stderr.trim(), code };
  };
  const failed = (command: string, result: { stderr: string; code: number }) =>
    new Error(`git ${command} failed: ${result.stderr || `exit ${result.code}`}`);
  const top = await git(dirname(abs), ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    if (/^fatal: not a git repository \(or (?:any of the parent directories\)|any parent up to mount point )/.test(top.stderr)) return undefined;
    throw failed("rev-parse --show-toplevel", top);
  }
  const root = new TextDecoder().decode(top.bytes).trim();
  const rel = relative(root, abs).split("\\").join("/");
  if (!rel || rel === ".." || rel.startsWith("../")) return undefined;
  const tracked = await git(root, ["--literal-pathspecs", "ls-files", "-z", "--", rel]);
  if (tracked.code !== 0) throw failed("ls-files", tracked);
  if (!new TextDecoder().decode(tracked.bytes).split("\0").includes(rel)) return undefined;
  const head = await git(root, ["rev-parse", "-q", "--verify", "HEAD"]);
  if (head.code === 1 && !head.stderr) return undefined;
  if (head.code !== 0) throw failed("rev-parse --verify HEAD", head);
  const tree = await git(root, ["--literal-pathspecs", "ls-tree", "-z", new TextDecoder().decode(head.bytes).trim(), "--", rel]);
  if (tree.code !== 0) throw failed("ls-tree", tree);
  if (!tree.bytes.byteLength) return undefined;
  const blob = /^[0-7]+ blob ([a-f0-9]+)\t/.exec(new TextDecoder().decode(tree.bytes))?.[1];
  // HEAD can have a directory or submodule where the worktree now has a file.
  if (!blob) return undefined;
  const shown = await git(root, ["cat-file", "blob", blob]);
  if (shown.code !== 0) throw failed("cat-file blob", shown);
  const dir = mkdtempSync(join(tmpdir(), "slop-head-"));
  try {
    const copy = join(dir, `head${extname(abs)}`);
    writeFileSync(copy, new Uint8Array(shown.bytes));
    return await extract(copy);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
