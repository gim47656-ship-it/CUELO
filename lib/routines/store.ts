import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { nightlySourceName, sanitizeSource } from "@/lib/upkeep/nightly-inbox";
import { type RoutinePost, type RoutinePostMeta, parseRoutinePost, serializeRoutinePost } from "./post";
import { ROUTINE_TIMEZONE, type RoutineSchedule, isValidTimeZone, parseSchedule } from "./schedule";

/**
 * 공용 루틴 저장소의 작업 사본. `routines/<id>/routine.json`(루틴 정의)과 `routines/<id>/posts/*.md`(게시판 글)만
 * 다룬다. 이 모듈은 파일만 읽고 쓰며, git 동기화와 커밋은 `git-sync.ts`가 한 잠금 아래에서 맡는다. 저장소는 다른
 * PC가 쓴 내용이므로, 저장소 밖을 가리키는 심볼릭 링크는 따라가지 않는다.
 */

export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  schedule: RoutineSchedule;
  timezone: string;
  host: string;
  prompt: string;
  cwd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutinePostSummary extends RoutinePostMeta {
  file: string;
}

export type RepoState = { ok: true; dir: string } | { ok: false; dir: string; reason: "missing" | "not-git" };

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const POST_FILE_PATTERN = /^\d{8}T\d{4}-[a-z0-9-]{1,63}(?:-\d+)?\.md$/;
const NAME_LIMIT = 80;
const PROMPT_LIMIT = 20_000;
const CWD_LIMIT = 500;

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** `CUELO_ROUTINES_DIR`, 없으면 `~/cuelo-routines`. */
export function routinesDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.CUELO_ROUTINES_DIR?.trim();
  return configured ? expandHome(configured) : join(homedir(), "cuelo-routines");
}

export function inspectRepo(dir: string): RepoState {
  if (!existsSync(dir)) return { ok: false, dir, reason: "missing" };
  if (!existsSync(join(dir, ".git"))) return { ok: false, dir, reason: "not-git" };
  return { ok: true, dir };
}

/** 이 서버가 루틴을 실행하는 PC 이름. 야간 보고의 출처 이름과 같은 규칙이다. */
export function thisRoutineHost(): string {
  return nightlySourceName(process.env, hostname());
}

export const isRoutineId = (id: string) => ID_PATTERN.test(id);
export const isPostFileName = (file: string) => POST_FILE_PATTERN.test(file);

export function routinePaths(dir: string, id: string) {
  const relFolder = `routines/${id}`;
  return {
    relFolder,
    relJson: `${relFolder}/routine.json`,
    folder: join(dir, "routines", id),
    json: join(dir, "routines", id, "routine.json"),
    posts: join(dir, "routines", id, "posts"),
  };
}

/**
 * 루틴 폴더 안의 경로가 실제로 저장소 안에 있고, 그 경로와 지나는 폴더(routines, 루틴 폴더, posts)가 심볼릭 링크가
 * 아닌지. 아직 없는 경로는 있는 데까지만 본다.
 */
function isContained(dir: string, id: string, ...rest: string[]): boolean {
  try {
    const root = realpathSync(dir);
    let current = root;
    for (const part of ["routines", id, ...rest]) {
      current = join(current, part);
      // lstat은 링크 자체를 본다: 가리키는 곳이 없는(끊긴) 링크도 링크로 걸러야 쓰기가 밖에 파일을 만들지 않는다.
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (!stat) return true;
      if (stat.isSymbolicLink()) return false;
    }
    return realpathSync(current).startsWith(root + sep);
  } catch {
    return false;
  }
}

export function newRoutineId(now: Date): string {
  return `r-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex")}`;
}

export type RoutineInput = Pick<Routine, "name" | "enabled" | "schedule" | "host" | "prompt" | "cwd">;

const isAbsoluteCwd = (cwd: string) => cwd.startsWith("/") || cwd === "~" || cwd.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(cwd);

/** 화면이나 저장 파일에서 받은 값을 검사해 정리한다. 실행 PC 이름은 출처 이름 규칙으로 맞춘다. */
export function parseRoutineInput(raw: unknown): { input: RoutineInput } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Body must be an object" };
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > NAME_LIMIT) return { error: `name must be 1-${NAME_LIMIT} characters` };
  if (typeof value.enabled !== "boolean") return { error: "enabled must be a boolean" };
  const schedule = parseSchedule(value.schedule);
  if (typeof schedule === "string") return { error: schedule };
  const host = sanitizeSource(typeof value.host === "string" ? value.host : "");
  if (!host) return { error: "host is required" };
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt || prompt.length > PROMPT_LIMIT) return { error: `prompt must be 1-${PROMPT_LIMIT} characters` };
  const cwdRaw = typeof value.cwd === "string" ? value.cwd.trim() : "";
  if (cwdRaw.length > CWD_LIMIT) return { error: "cwd is too long" };
  if (cwdRaw && !isAbsoluteCwd(cwdRaw)) return { error: "cwd must be an absolute path or start with ~/" };
  return { input: { name, enabled: value.enabled, schedule, host, prompt, cwd: cwdRaw || null } };
}

function parseRoutineFile(text: string, id: string): Routine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = parseRoutineInput(raw);
  if ("error" in parsed) return null;
  const value = raw as Record<string, unknown>;
  if (value.id !== id) return null;
  return {
    id,
    ...parsed.input,
    timezone: typeof value.timezone === "string" && isValidTimeZone(value.timezone) ? value.timezone : ROUTINE_TIMEZONE,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

export function readRoutine(dir: string, id: string): Routine | null {
  if (!isRoutineId(id) || !isContained(dir, id, "routine.json")) return null;
  try {
    return parseRoutineFile(readFileSync(routinePaths(dir, id).json, "utf8"), id);
  } catch {
    return null;
  }
}

/** 형식이 맞는 루틴만, 켜진 루틴 먼저, 그다음 이름순. 깨진 routine.json은 건너뛴다(다른 PC가 쓰는 중일 수 있다). */
export function readRoutines(dir: string): Routine[] {
  let ids: string[];
  try {
    ids = readdirSync(join(dir, "routines"));
  } catch {
    return [];
  }
  return ids.filter(isRoutineId).map((id) => readRoutine(dir, id)).filter((r): r is Routine => r !== null)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, "ko") || a.id.localeCompare(b.id));
}

/** 글 목록, 최신순(파일 이름이 실행 시각으로 시작한다). */
export function listPosts(dir: string, id: string): RoutinePostSummary[] {
  let files: string[];
  try {
    files = readdirSync(routinePaths(dir, id).posts);
  } catch {
    return [];
  }
  const out: RoutinePostSummary[] = [];
  for (const file of files.filter(isPostFileName).sort().reverse()) {
    const post = readPost(dir, id, file);
    if (!post) continue;
    out.push({
      file, title: post.title, routineId: post.routineId, host: post.host, status: post.status,
      startedAt: post.startedAt, finishedAt: post.finishedAt, sessionId: post.sessionId,
    });
  }
  return out;
}

export function readPost(dir: string, id: string, file: string): RoutinePost | null {
  if (!isRoutineId(id) || !isPostFileName(file) || !isContained(dir, id, "posts", file)) return null;
  try {
    return parseRoutinePost(readFileSync(join(routinePaths(dir, id).posts, file), "utf8"));
  } catch {
    return null;
  }
}

/** routine.json을 쓰고 저장소 기준 상대 경로를 돌려준다. 시간대는 언제나 Asia/Seoul로 쓴다. */
export function writeRoutineFile(dir: string, routine: Routine): string {
  if (!isContained(dir, routine.id, "routine.json")) throw new Error(`routine folder is outside the repository: ${routine.id}`);
  const paths = routinePaths(dir, routine.id);
  mkdirSync(paths.folder, { recursive: true });
  writeFileSync(paths.json, `${JSON.stringify({ ...routine, timezone: ROUTINE_TIMEZONE }, null, 2)}\n`, "utf8");
  return paths.relJson;
}

/** 글 파일을 새로 쓰고 저장소 기준 상대 경로를 돌려준다. 같은 분에 두 번 돌았으면 `-2`, `-3`을 붙인다. */
export function writePostFile(dir: string, routineId: string, stamp: string, host: string, post: RoutinePost): string {
  if (!isContained(dir, routineId, "posts")) throw new Error(`routine folder is outside the repository: ${routineId}`);
  const paths = routinePaths(dir, routineId);
  mkdirSync(paths.posts, { recursive: true });
  let file = `${stamp}-${host}.md`;
  for (let n = 2; existsSync(join(paths.posts, file)); n += 1) file = `${stamp}-${host}-${n}.md`;
  writeFileSync(join(paths.posts, file), serializeRoutinePost(post), { encoding: "utf8", flag: "wx" });
  return `${paths.relFolder}/posts/${file}`;
}

export function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
