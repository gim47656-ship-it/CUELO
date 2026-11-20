/**
 * 클라우드 야간 실행이 끝난 결과(2026-11-09 사용자 결정). 야간 세션이 게시까지 가지 못하면(검토 실패로 보류, 서버 재시작으로 끊김,
 * 모델 오류) origin/main에 커밋이 남지 않아 각 PC의 아침 보고가 그것을 알 방법이 없었다. 그래서 클라우드 실행 스크립트가 세션이
 * 끝날 때 이 모듈로 작업 사본과 세션 기록을 살펴 결과 파일(`nightly-result.json`)을 받은편지함의 출처마다 써 두고, PC 동기화가
 * 그 파일을 아침 보고로 넘긴다. 판정은 하나의 차례를 따른다: 중단(서버 재시작) > 보류(작업 사본에 남은 일) > 실패(세션의 마지막
 * 답이 오류) > 깨끗함. 깨끗한 실행은 아침 보고에 싣지 않는다(게시된 실행은 커밋으로 이미 보고된다).
 */
import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { HANDOFF_PATHS, parseHandoff } from "./handoff";
import { nightlyStateBranch, type NightlyState } from "./nightly";
import { NIGHTLY_ARTIFACT_BYTES, parseMetricOutcomes, type NightlyMetricOutcome } from "./nightly-outcomes";

const exec = promisify(execFile);

export const NIGHTLY_RESULT_FILE = "nightly-result.json";
export const NIGHTLY_RESULT_VERSION = 2;
/** 받은편지함 파일 이름 규칙(`readNightlyInbox`가 받는 출처 이름과 같다). */
const INBOX_FILE_RE = /^([a-z0-9-]{1,63})\.json$/;
/** 프롬프트에 실을 남은 변경 줄 수와 게시하지 않은 커밋 수. 총 개수는 따로 센다. */
export const LEFTOVER_LIMIT = 30;
export const UNPUSHED_LIMIT = 10;
export const SUMMARY_LIMIT = 6_000;
const LINE_LIMIT = 300;
const ERROR_LIMIT = 400;
/** 세션 기록 끝에서 이만큼만 읽어 마지막 답을 찾는다. 야간 세션 파일은 수십 MB일 수 있다. */
const TAIL_BYTES = 4 * 1024 * 1024;

export type NightlyOutcome = "clean" | "held" | "interrupted" | "failed";

export const NIGHTLY_OUTCOMES: readonly NightlyOutcome[] = ["clean", "held", "interrupted", "failed"];
/** 아침 보고가 알리는 결과. 깨끗한 실행은 게시된 것과 같아 알리지 않는다. */
export const REPORTABLE_OUTCOMES: readonly NightlyOutcome[] = ["held", "interrupted", "failed"];

/** 세션이 남긴 마지막 답 */
export interface LastAssistant {
  text: string;
  stopReason: string | null;
  errorMessage: string | null;
  /** 그 답을 남긴 항목의 시각(ISO). 결과의 `finishedAt`으로 써서 같은 실행을 다시 알려도 같은 값이 되게 한다. */
  timestamp: string | null;
}

export interface NightlyResult {
  version: 1 | 2;
  source?: string;
  outcomes?: NightlyMetricOutcome[];
  /** KST 실행 날짜(YYYY-MM-DD) */
  date: string;
  sessionId: string;
  /** `wt/nightly-YYYYMMDD` */
  branch: string;
  worktree: string;
  startedAt: string;
  finishedAt: string;
  outcome: NightlyOutcome;
  /** 작업 사본에 남은 변경(`git status --porcelain` 줄, 상한까지) */
  leftovers: string[];
  /** 상한으로 자르기 전의 남은 변경 수. 0이면 작업 사본이 깨끗하다. */
  leftoverCount: number;
  /** origin/main에 없는 커밋 제목(상한까지) */
  unpushed: string[];
  /** 세션의 마지막 답(상한까지). 프롬프트에서는 자료로만 다룬다. */
  summary: string;
  error?: string;
  /** 실행 날짜 기준으로 HEAD에 남은 기한 지난 HANDOFF 행 제목. 실행기의 후속 지시에만 쓰며 PC는 읽지 않는다(`error`에 같은 내용). */
  overdue?: string[];
  warnings: string[];
}

/** `parseNightlyResult`가 다시 읽는 상한과 같은 길이를 지킨다. 말줄임표도 상한 안에 넣는다. */
const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

function firstLine(error: unknown): string {
  const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return (stderr || (error instanceof Error ? error.message : String(error))).trim().split("\n")[0];
}

async function git(repo: string, args: string[], timeout = 15_000): Promise<string> {
  return (await exec("git", ["-C", repo, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout;
}

/** 메시지 본문의 글 블록만 이어 붙인다(`readFirstUserMessage`와 같은 규칙). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
      && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * 세션 기록 파일의 마지막 assistant 메시지. 파일 끝 일부만 읽어 뒤에서부터 찾으므로 답이 그보다 앞에 있으면 null이다.
 * 읽지 못해도 던지지 않는다(결과 판정은 작업 사본으로 이어진다).
 */
export function readLastAssistant(filePath: string): LastAssistant | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    // 파일 중간에서 읽기 시작했으면 첫 줄은 잘린 것이다.
    if (start > 0) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line.includes('"assistant"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (record.type !== "message") continue;
      const message = record.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const fields = message as Record<string, unknown>;
      if (fields.role !== "assistant") continue;
      return {
        text: messageText(fields.content),
        stopReason: typeof fields.stopReason === "string" ? fields.stopReason : null,
        errorMessage: typeof fields.errorMessage === "string" ? fields.errorMessage : null,
        timestamp: typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))
          ? new Date(record.timestamp).toISOString() : null,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * 작업 사본과 세션 기록에서 이번 실행의 끝 상태를 낸다. origin/main에 없는 커밋은 게시되지 않은 것으로 세므로, `wt/` 브랜치에
 * 밀어 두기만 하고 main에 합치지 않은 실행도 보류다. 변경 판정은 `pruneNightlyWorktrees`와 같다: 추적하지 않는 결정 기록
 * (`?? .audit/…`)만 빼고 무엇이든 남았으면 보류다. 작업 사본이 없으면 실패로 남긴다(무엇이 남았는지 알 수 없다).
 */
export async function inspectNightlyResult(input: {
  state: NightlyState;
  /** origin을 받아 올 저장소. 없으면 작업 사본에서 받아 온다. */
  repo?: string | null;
  /** 세션 기록 파일(`resolveSessionPath`). 모르면 null. */
  sessionFile?: string | null;
  interrupted: boolean;
}): Promise<NightlyResult> {
  const { state } = input;
  const warnings: string[] = [];
  /** 경고와 오류 문구도 결과 파일을 다시 읽는 쪽의 상한 안에 둔다(`parseNightlyResult`). */
  const warn = (message: string) => {
    const text = clip(message, LINE_LIMIT);
    warnings.push(text);
    return text;
  };
  const worktree = state.worktree;
  try {
    await git(input.repo ?? worktree, ["fetch", "--prune", "--quiet", "origin"], 120_000);
  } catch (error) {
    warn(`git fetch origin에 실패해 이미 받아 둔 참조로 봤습니다(${firstLine(error)}).`);
  }

  let leftovers: string[] = [];
  let leftoverCount = 0;
  let unpushed: string[] = [];
  let error: string | undefined;
  /** 작업 사본을 확인하지 못했으면 깨끗하다고 말하지 않는다(보고를 통째로 잃지 않게). */
  let unverified: string | undefined;
  if (!existsSync(join(worktree, ".git"))) {
    // 경로는 `worktree` 필드에 500자까지 그대로 남으므로, 다시 읽는 쪽의 오류 상한(`ERROR_LIMIT`)에 맞춰 자른다.
    error = clip(`작업 사본을 찾지 못했습니다: ${worktree}`, ERROR_LIMIT);
  } else {
    try {
      const lines = (await git(worktree, ["status", "--porcelain", "--untracked-files=all"]))
        .split("\n").map((line) => line.trimEnd()).filter((line) => line && !line.startsWith("?? .audit/"));
      leftoverCount = lines.length;
      leftovers = lines.slice(0, LEFTOVER_LIMIT).map((line) => clip(line, LINE_LIMIT));
    } catch (failure) {
      unverified = warn(`작업 사본의 변경을 읽지 못했습니다(${firstLine(failure)}).`);
    }
    try {
      unpushed = (await git(worktree, ["log", "origin/main..HEAD", "--format=%s"]))
        .split("\n").map((line) => line.trim()).filter(Boolean).slice(0, UNPUSHED_LIMIT).map((line) => clip(line, LINE_LIMIT));
    } catch (failure) {
      // origin/main을 찾지 못하면 게시 여부를 알 수 없다. 남은 변경만으로 보류를 판단하고(위), 깨끗하다고는 말하지 않는다.
      unverified = warn(`origin/main을 찾지 못해 게시하지 않은 커밋을 세지 못했습니다(${firstLine(failure)}).`);
    }
  }
  /**
   * 받은편지함 실행은 기한 지난 HANDOFF 행을 하나씩 닫거나 옮기라는 지시를 받는다. 실행 날짜(KST) 기준으로 지난 행이 HEAD에
   * 그대로 남았으면 그 일을 끝내지 않은 것이라 보류다(11-20 실행이 제목만 보고 11개를 넘긴 일). 커밋된 내용을 `git show`로
   * 읽으므로 작업 사본의 링크나 특수 파일을 따라가지 않는다. 커밋하지 않은 수정은 위에서 이미 보류다.
   */
  const overdue: string[] = [];
  if (state.sources && !error) {
    const day = new Date(`${state.date}T00:00:00+09:00`);
    for (const path of HANDOFF_PATHS) {
      try {
        // 그 커밋에 파일이 없는 것만 경고다(git 메시지 언어와 상관없이 ls-tree로 가린다). 읽기나 해석이 실패했으면 기한을
        // 확인하지 못한 것이라 깨끗하다고 하지 않는다.
        if (!(await git(worktree, ["ls-tree", "--name-only", "HEAD", "--", path])).trim()) {
          warn(`HEAD에 ${path}이 없어 그 파일의 기한은 보지 않았습니다.`);
          continue;
        }
        const text = await git(worktree, ["show", `HEAD:${path}`]);
        overdue.push(...parseHandoff(text, path, day).filter((item) => item.overdue).map((item) => item.ref.title));
      } catch (failure) {
        unverified ??= warn(`HEAD의 ${path}에서 기한을 확인하지 못했습니다(${firstLine(failure)}).`);
      }
    }
  }

  const last = input.sessionFile ? readLastAssistant(input.sessionFile) : null;
  if (!last) {
    const text = warn("세션 기록에서 마지막 답을 읽지 못했습니다.");
    // 기한 지난 행만 남은 보류는 세션을 다시 깨우고 게시한 고침을 믿는다. 세션이 오류로 끝났는지 모르면 그렇게 하지 않는다.
    if (overdue.length) unverified ??= text;
  }
  /**
   * 결과의 끝 시각. 같은 실행을 다시 알려도 같은 값이어야 아침 보고가 그 결과를 두 번 열지 않는다(그 값으로 비교한다).
   * 세션의 마지막 답 시각, 그것이 없으면 더는 쓰이지 않는 세션 파일의 수정 시각을 쓴다. 둘 다 없으면 이 실행의 시작 시각을
   * 쓰고 끝 시각을 모른다고 남긴다: 지금 시각을 쓰면 같은 실행이 매번 다른 결과로 보인다.
   */
  let finishedAt = last?.timestamp ?? null;
  if (!finishedAt && input.sessionFile) {
    try {
      finishedAt = new Date(statSync(input.sessionFile).mtimeMs).toISOString();
    } catch {
      finishedAt = null;
    }
  }
  if (!finishedAt) {
    finishedAt = state.startedAt;
    warn("세션의 끝 시각을 읽지 못해 실행 시작 시각을 결과 시각으로 썼습니다.");
  }

  const failedBySession = last?.stopReason === "error";
  const outcome: NightlyOutcome = input.interrupted
    ? "interrupted"
    : leftoverCount > 0 || unpushed.length > 0
      ? "held"
      : error || failedBySession || unverified
        ? "failed"
        : overdue.length > 0
          ? "held"
          : "clean";
  const failureText = error
    ?? (failedBySession ? last?.errorMessage || "세션의 마지막 답이 오류로 끝났습니다." : undefined)
    ?? unverified;
  // 남은 행 요약(개수와 「외 N개」)의 자리를 먼저 떼고, 실패 문구는 남은 자리에 맞춰 자른다.
  // 실패 문구가 짧으면 남는 자리를 요약이 쓰고, 길어도 요약은 한도의 절반을 지킨다.
  const overdueText = overdue.length
    ? overdueSummary(overdue, ERROR_LIMIT - (failureText ? Math.min(failureText.length + 3, Math.floor(ERROR_LIMIT / 2)) : 0))
    : undefined;
  const errorText = failureText && overdueText
    ? `${clip(failureText, ERROR_LIMIT - overdueText.length - 3)} / ${overdueText}`
    : failureText ? clip(failureText, ERROR_LIMIT) : overdueText;

  let outcomes: NightlyMetricOutcome[] = [];
  const artifact = join(worktree, ".audit", `nightly-outcomes-${state.date}.json`);
  try {
    const stat = lstatSync(artifact);
    if (!stat.isFile() || stat.size > NIGHTLY_ARTIFACT_BYTES || lstatSync(join(worktree, ".audit")).isSymbolicLink()) throw new Error("invalid artifact file");
    const raw = JSON.parse(readFileSync(artifact, "utf8"));
    const rows = parseMetricOutcomes(raw.outcomes);
    if (raw.version !== 1 || raw.sessionId !== state.sessionId || !rows
      || rows.some((row) => Date.parse(row.checkedAt) < Date.parse(state.startedAt) || Date.parse(row.checkedAt) > Date.parse(finishedAt)
        || !Object.hasOwn(state.sources ?? {}, row.source))) throw new Error("outcomes do not belong to this execution");
    outcomes = rows;
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== "ENOENT") warn("야간 지표 결과 파일이 이번 실행과 맞지 않아 표시를 반영하지 않았습니다.");
  }
  return {
    version: state.sources ? NIGHTLY_RESULT_VERSION : 1,
    date: state.date,
    sessionId: state.sessionId,
    branch: nightlyStateBranch(state),
    worktree,
    startedAt: state.startedAt,
    finishedAt,
    outcome,
    leftovers,
    leftoverCount,
    unpushed,
    summary: clip(last?.text ?? "", SUMMARY_LIMIT),
    ...(errorText ? { error: errorText } : {}),
    ...(overdue.length ? { overdue } : {}),
    ...(state.sources ? { outcomes } : {}),
    warnings,
  };
}

/** 남은 기한 지난 행을 한도 안에서 적는다. 다 못 적으면 「외 N개」로 끝내 개수는 잃지 않는다. */
export function overdueSummary(titles: readonly string[], limit: number): string {
  const head = `기한 지난 HANDOFF 행 ${titles.length}개를 닫거나 옮기지 않았습니다: `;
  let text = head;
  for (const [index, title] of titles.entries()) {
    const piece = `${index ? " / " : ""}${title}`;
    const rest = titles.length - index;
    if (text.length + piece.length + (rest > 1 ? ` 외 ${rest - 1}개`.length : 0) > limit) return `${text}${index ? " " : ""}외 ${rest}개`;
    text += piece;
  }
  return text;
}

/**
 * 기한 지난 행만 남기고 끝난 야간 세션에 실행기가 한 번 보내는 후속 지시. 결과를 쓰기 전에 같은 세션을 다시 깨워
 * 행마다 끝맺게 한다(지시문만으로는 11-20 실행이 제목만 보고 넘겼다).
 */
export function overdueFollowUp(titles: readonly string[]): string {
  return [
    `이 worktree의 HEAD에 점검일이 지난 HANDOFF 행이 ${titles.length}개 남아 있어 이 실행을 아직 끝난 것으로 보지 않습니다.`,
    "행마다 원문과 그 원문이 가리키는 기록을 열어 보고 ① 닫기 ② 굵은 제목의 점검일을 앞날로 옮기고 확인한 것과 남은 조건 한 줄 ③ 날짜를 빼고 「사용자 결정 대기: …」 중 하나로 끝낸 뒤, 처음 지시의 검토와 게시 절차로 main에 올리세요. 이번에도 남으면 보류로 보고합니다.",
    ...titles.map((title) => `- ${title}`),
  ].join("\n");
}

/**
 * 받은편지함의 출처마다 결과 파일을 쓴다. 출처 이름은 받은편지함 파일 이름에서만 얻으므로 경로가 밖으로 나가지 않는다.
 * 임시 이름에 쓴 뒤 rename하므로 PC가 반쯤 쓴 파일을 받지 않는다. 쓴 출처와 쓰지 못한 출처를 나눠 돌려준다. 쓰기 실패를
 * 정상으로 보고하면 그 PC는 결과를 영영 받지 못한다.
 */
export function writeNightlyResult(outboxDir: string, inboxDir: string, result: NightlyResult): { written: string[]; failed: string[] } {
  let files: string[];
  try {
    files = readdirSync(inboxDir).sort();
  } catch {
    return { written: [], failed: [] };
  }
  const written: string[] = [], failed: string[] = [];
  for (const file of files) {
    const source = INBOX_FILE_RE.exec(file)?.[1];
    if (!source) continue;
    const dir = join(outboxDir, source);
    try {
      mkdirSync(dir, { recursive: true });
      // 클라우드 세션도 이 보낸편지함에 쓰므로, 밖을 가리키는 심볼릭 링크로 만든 출처 폴더에는 쓰지 않는다.
      if (!lstatSync(dir).isDirectory()) {
        failed.push(source);
        continue;
      }
      const payload = result.version === 2 ? { ...result, source, outcomes: (result.outcomes ?? []).filter((row) => row.source === source) } : result;
      writePrivateFileAtomicSync(join(dir, NIGHTLY_RESULT_FILE), `${JSON.stringify(payload, null, 2)}\n`);
      written.push(source);
    } catch {
      failed.push(source);
    }
  }
  return { written, failed };
}

const str = (value: unknown, limit: number): string | null =>
  (typeof value === "string" && value.length > 0 && value.length <= limit ? value : null);

function strList(value: unknown, limit: number, cap: number): string[] | null {
  if (!Array.isArray(value) || value.length > cap) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > limit) return null;
    items.push(item);
  }
  return items;
}

/**
 * PC가 받은 결과를 믿지 않고 모양을 다시 맞춘다. 버전, 결과값, ISO 시각, 글 길이 상한이 맞지 않으면 null(그 결과는 빼고 보고한다).
 * 정수와 배열 상한도 여기서 확인하므로 클라우드가 쓴 파일이 아니어도 프롬프트가 길어지지 않는다.
 */
export function parseNightlyResult(value: unknown): NightlyResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 && raw.version !== 2) return null;
  const date = str(raw.date, 10);
  const sessionId = str(raw.sessionId, 64);
  const branch = str(raw.branch, 120);
  const worktree = str(raw.worktree, 500);
  const startedAt = str(raw.startedAt, 40);
  const finishedAt = str(raw.finishedAt, 40);
  const outcome = typeof raw.outcome === "string" && (NIGHTLY_OUTCOMES as readonly string[]).includes(raw.outcome)
    ? raw.outcome as NightlyOutcome
    : null;
  const leftovers = strList(raw.leftovers, LINE_LIMIT, LEFTOVER_LIMIT);
  const unpushed = strList(raw.unpushed, LINE_LIMIT, UNPUSHED_LIMIT);
  const warnings = raw.warnings === undefined ? [] : strList(raw.warnings, LINE_LIMIT, LEFTOVER_LIMIT);
  const leftoverCount = Number.isSafeInteger(raw.leftoverCount) && (raw.leftoverCount as number) >= 0 ? raw.leftoverCount as number : null;
  const summary = typeof raw.summary === "string" && raw.summary.length <= SUMMARY_LIMIT ? raw.summary : null;
  const error = raw.error === undefined ? undefined : str(raw.error, ERROR_LIMIT);
  const outcomes = raw.version === 2 ? parseMetricOutcomes(raw.outcomes) : null;
  if (raw.version === 2 && (!outcomes || typeof raw.source !== "string" || !/^[a-z0-9-]{1,63}$/.test(raw.source)
    || outcomes.some((row) => row.source !== raw.source || Date.parse(row.checkedAt) < Date.parse(startedAt ?? "")
      || Date.parse(row.checkedAt) > Date.parse(finishedAt ?? "")))) return null;
  if (!date || !sessionId || !branch || !worktree || !startedAt || !finishedAt || !outcome
    || !leftovers || !unpushed || !warnings || leftoverCount === null || summary === null
    || (raw.error !== undefined && !error)
    || !Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(finishedAt))) {
    return null;
  }
  return {
    version: raw.version,
    ...(raw.version === 2 ? { source: raw.source as string, outcomes: outcomes! } : {}),
    date, sessionId, branch, worktree, startedAt, finishedAt, outcome,
    leftovers, leftoverCount, unpushed, summary, warnings,
    ...(error ? { error } : {}),
  };
}
