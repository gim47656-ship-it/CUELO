/**
 * Run X-Ray / Experiment Lab 읽기 전용 집계.
 *
 * 새로 계측하지 않고 `~/.omp/stats.db`(읽기 전용)와 세션 JSONL에 이미 쌓인
 * 기록만 읽는다. 기록에 없는 값은 비워두고 "미측정"으로 표시하며 추정하지 않는다.
 *
 * - DB는 파일이 없으면 빈 결과를 돌려주고, 열 때는 호출마다 열고 `finally`에서 닫는다.
 * - `session_file`은 Windows 절대경로(백슬래시)다.
 * - run 경계는 부모 transcript와 정확히 일치하는 `user_messages` 행이다.
 * - 공백 coverage의 요청 구간은 `[timestamp, timestamp + (duration ?? 0)]`이다.
 */

import { Database } from "bun:sqlite";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb } from "@oh-my-pi/omp-stats/db";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  EXPERIMENT_DEFAULT_SESSIONS,
  EXPERIMENT_MAX_SESSIONS,
  HARNESS_UNKNOWN_FILTER,
  RUN_LIST_DEFAULT_LIMIT,
  RUN_LIST_MAX_LIMIT,
  RUN_ROLE_KINDS,
  RUN_ROLE_PURPOSES,
  RUN_UNMEASURED_REASONS,
  type ExperimentConfig,
  type ExperimentConfigRole,
  type ExperimentGroupBy,
  type ExperimentHarnessCount,
  type ExperimentResponse,
  type ExperimentScope,
  type RunBottleneck,
  type RunDetail,
  type RunListResponse,
  type RunOutcome,
  type RunRoleKind,
  type RunRolePurpose,
  type RunHelperUsage,
  type RunRoleSegment,
  type RunToolTotal,
  type RunUnmeasuredReason,
} from "./run-xray-types";

export class RunXrayError extends Error {
  constructor(
    message: string,
    readonly status: number = 500,
  ) {
    super(message);
    this.name = "RunXrayError";
  }
}

// ---------------------------------------------------------------------------
// 순수 함수 (DB·FS 접근 없음)
// ---------------------------------------------------------------------------

/**
 * 겹치는 구간을 합집합으로 계산하고 창 밖은 잘라낸 뒤 전체 길이를 돌려준다.
 * 끝점이 맞닿은 구간은 이어진 것으로 본다.
 */
export function unionCoverageMs(
  intervals: ReadonlyArray<readonly [number, number]>,
  windowStart: number,
  windowEnd: number,
): number {
  if (!(windowEnd > windowStart)) return 0;
  const clipped: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    const from = Math.max(start, windowStart);
    const to = Math.min(end, windowEnd);
    if (to > from) clipped.push([from, to]);
  }
  clipped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let currentStart = 0;
  let currentEnd = 0;
  let open = false;
  for (const [from, to] of clipped) {
    if (!open || from > currentEnd) {
      if (open) total += currentEnd - currentStart;
      currentStart = from;
      currentEnd = to;
      open = true;
    } else if (to > currentEnd) {
      currentEnd = to;
    }
  }
  if (open) total += currentEnd - currentStart;
  return total;
}

/**
 * 큰 것부터 최대 3개를 고른다. 동률은 id 오름차순으로 잘라 결정성을 보장한다.
 *
 * `relative`는 **뽑힌 것 중 1위 대비** 비율이라 막대 길이 말고는 의미가 없다. 생성시간을
 * 경과시간으로 나누지 않는다: 역할은 병렬로 돌아 합이 경과를 넘고, 그런 값에 막대나
 * 백분율을 붙이면 "경과의 일부"라는 없는 관계를 만들어낸다. 경과와 생성시간은 화면에서도
 * 나란히만 둔다.
 */
export function pickBottlenecks(
  roleBusy: ReadonlyArray<{ id: string; ms: number }>,
  unmeasuredMs: number,
): RunBottleneck[] {
  const candidates: Array<{ kind: RunBottleneck["kind"]; id: string; ms: number }> = roleBusy.map(
    (role) => ({ kind: "role-busy" as const, id: role.id, ms: role.ms }),
  );
  if (unmeasuredMs > 0) {
    candidates.push({ kind: "unmeasured-gap", id: "unmeasured", ms: unmeasuredMs });
  }
  candidates.sort((a, b) => b.ms - a.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const top = candidates.slice(0, 3);
  const largest = top[0]?.ms ?? 0;
  return top.map((candidate) => ({
    kind: candidate.kind,
    id: candidate.id,
    ms: candidate.ms,
    relative: largest > 0 ? candidate.ms / largest : 0,
  }));
}

/**
 * 역할별 (kind, 관측 model 집합, 관측 effort 집합)을 만들고 같은 조합을 `count`로 합친다.
 *
 * 한 역할이 model 하나·effort 하나(또는 effort 미기록)만 관측했으면 그 값이 곧 구성이다(`pairing:
 * "single"`). 서명 문자열은 `kind=model:effort`이고 effort가 없으면 `null`·서명에서는 `?`다.
 * 둘 이상 관측했으면 첫 관측값을 대표로 쓰지 않는다. 대표값만 쓰면 첫 값이 같은 단일 run과 혼합 run이
 * 같은 구성으로 합쳐진다. 대신 정렬한 집합을 `{a,b}`로 적고 `pairing: "unknown"`으로 표시한다.
 * 관측 배열은 요청별 (model, effort) 짝도, 순서도 담지 않으므로 같은 집합의 두 혼합 run이 같은
 * 조건에서 돌았다고 말할 수 없다. 이 값은 "같은 집합을 관측했다"는 뜻일 뿐이다.
 * `main`은 항상 하나이므로 개수 표기를 붙이지 않고, 나머지 역할은 항상 ` xN`을 붙인다.
 *
 * `signature`는 화면용 라벨이고 묶음 키는 `identity`다. 라벨은 모델 ID 문자열을 이어 붙이므로
 * 이름에 따라 겹칠 수 있지만, `identity`는 구조(JSON)라 겹치지 않는다.
 */
export function buildConfigSignature(
  roles: ReadonlyArray<{ kind: RunRoleKind; models: string[]; efforts: string[] }>,
): { signature: string; identity: string; roles: ExperimentConfigRole[] } {
  const grouped = new Map<string, ExperimentConfigRole>();
  for (const role of roles) {
    const models = [...new Set(role.models)].sort();
    const efforts = [...new Set(role.efforts)].sort();
    const model = setLabel(models) ?? "?";
    const effort = setLabel(efforts);
    const key = JSON.stringify([role.kind, models, efforts]);
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, {
        kind: role.kind,
        model,
        effort,
        count: 1,
        models,
        efforts,
        pairing: models.length > 1 || efforts.length > 1 ? "unknown" : "single",
      });
    }
  }
  const sorted = [...grouped.entries()].sort(([leftKey, a], [rightKey, b]) => {
    const byKind = RUN_ROLE_KINDS.indexOf(a.kind) - RUN_ROLE_KINDS.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    if (a.model !== b.model) return a.model < b.model ? -1 : 1;
    const leftEffort = a.effort ?? "?";
    const rightEffort = b.effort ?? "?";
    if (leftEffort !== rightEffort) return leftEffort < rightEffort ? -1 : 1;
    // 표시 라벨이 같아도(모델 ID `{a,b}` 대 집합 {a,b}) 구조 키로 순서를 정해 입력 순서와 무관하게 한다.
    return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
  }).map(([, role]) => role);
  const signature = sorted
    .map((role) => `${role.kind === "main" ? "main" : `${role.kind} x${role.count}`}=${role.model}:${role.effort ?? "?"}`)
    .join("|");
  const identity = JSON.stringify(sorted.map((role) => [role.kind, role.models, role.efforts, role.count]));
  return { signature, identity, roles: sorted };
}

/** 관측값 집합의 라벨. 없으면 `null`, 하나면 그 값, 둘 이상이면 `{a,b}`. */
function setLabel(values: string[]): string | null {
  if (values.length === 0) return null;
  return values.length === 1 ? values[0] : `{${values.join(",")}}`;
}

/** CUELO WSL 갱신 기록에서 하네스 revision을 정하는 데 쓰는 줄 하나. */
export interface HarnessDeployEvent {
  at: number;
  kind: "start" | "ready" | "rolled-back" | "rollback-failed";
  /** `start`는 갱신 전에 돌던 revision, 나머지는 그 시각부터 도는 revision. 알 수 없으면 `null`. */
  revision: string | null;
}

/** `from`부터 다음 구간 시작 전까지 설치돼 있던 revision. `null`은 unknown이다. */
export interface HarnessSegment {
  from: number;
  revision: string | null;
}

const DEPLOY_LINE_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) (START old=(\S*)|READY ([0-9a-f]{40})|ROLLED_BACK ([0-9a-f]{40})|ROLLBACK_FAILED)(?:\s|$)/;
const REVISION_RE = /^[0-9a-f]{40}$/;

/**
 * 갱신 스크립트(`Tools/CUELO_Setup/wsl/update.sh`)가 `say`로 남긴 줄만 읽는다. 형식은
 * `<UTC ISO 초> <단계> ...`이며 빌드 출력처럼 다른 줄은 건너뛴다. 미리 빌드 실패(`FAIL prebuild`)는
 * 실행 중인 버전을 바꾸지 않으므로 사건이 아니다.
 */
export function parseHarnessDeployLog(text: string): HarnessDeployEvent[] {
  const events: HarnessDeployEvent[] = [];
  for (const line of text.split("\n")) {
    const match = DEPLOY_LINE_RE.exec(line);
    if (!match) continue;
    const at = Date.parse(match[1]);
    if (!Number.isFinite(at)) continue;
    if (match[3] !== undefined) {
      events.push({ at, kind: "start", revision: REVISION_RE.test(match[3]) ? match[3] : null });
    } else if (match[4] !== undefined) {
      events.push({ at, kind: "ready", revision: match[4] });
    } else if (match[5] !== undefined) {
      events.push({ at, kind: "rolled-back", revision: match[5] });
    } else {
      events.push({ at, kind: "rollback-failed", revision: null });
    }
  }
  return events;
}

/**
 * 갱신 사건을 시간 구간으로 바꾼다.
 * - 첫 사건 이전은 구간이 없어 unknown이다.
 * - `READY`·`ROLLED_BACK`은 그 시각부터 해당 revision, `ROLLBACK_FAILED`는 그 시각부터 unknown이다.
 * - `START old=X`는 그 순간 X가 돌고 있었다는 증거다. 직전 구간의 revision과 다르면 기록 밖에서
 *   버전이 바뀐 것이므로, 바뀐 시각을 모르는 직전 구간 전체를 unknown으로 내리고 X를 START부터 잇는다.
 */
export function buildHarnessTimeline(events: readonly HarnessDeployEvent[]): HarnessSegment[] {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const segments: HarnessSegment[] = [];
  for (const event of ordered) {
    const last = segments.at(-1);
    if (event.kind === "start") {
      if (last && last.revision === event.revision) continue;
      if (last) last.revision = null;
      segments.push({ from: event.at, revision: event.revision });
      continue;
    }
    if (last && last.revision === event.revision) continue;
    segments.push({ from: event.at, revision: event.revision });
  }
  return segments;
}

/** `at`에 설치돼 있던 revision. 구간 시작 시각과 같으면 그 구간이다. */
export function harnessRevisionAt(timeline: readonly HarnessSegment[], at: number): string | null {
  let revision: string | null = null;
  for (const segment of timeline) {
    if (segment.from > at) break;
    revision = segment.revision;
  }
  return revision;
}

/** run들의 revision별 수. 가장 최근에 시작된 run의 revision이 먼저 온다. */
export function countHarnesses(
  runs: ReadonlyArray<{ harnessRevision: string | null; startedAt: number }>,
): ExperimentHarnessCount[] {
  const counts = new Map<string | null, { runCount: number; lastSeenAt: number }>();
  for (const run of runs) {
    const entry = counts.get(run.harnessRevision) ?? { runCount: 0, lastSeenAt: run.startedAt };
    entry.runCount += 1;
    entry.lastSeenAt = Math.max(entry.lastSeenAt, run.startedAt);
    counts.set(run.harnessRevision, entry);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
    .map(([revision, entry]) => ({ revision, runCount: entry.runCount }));
}

/** 빈 배열이면 0, 짝수면 두 중앙값의 평균. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function extractPurpose(taskText: string): RunRolePurpose | null {
  for (const line of taskText.split("\n")) {
    const match = /^\s*PURPOSE:\s*(\S+)\s*$/.exec(line);
    if (match) {
      return (RUN_ROLE_PURPOSES as readonly string[]).includes(match[1])
        ? (match[1] as RunRolePurpose)
        : null;
    }
  }
  return null;
}

/**
 * 부모 JSONL 라인에서 `task` 도구 호출을 찾아 `tasks[].name` →
 * `{agent, purpose}` 맵을 만든다. `purpose`는 `tasks[].task` 문자열의
 * `PURPOSE:` 줄에서 `primary|rework|review`만 인정하고 그 외/부재는 `null`이다.
 * 같은 이름이 여러 번 나오면 마지막 호출이 이긴다.
 */
export function parseTaskRoleMap(
  lines: Iterable<string>,
): Map<string, { agent: string; purpose: RunRolePurpose | null }> {
  const map = new Map<string, { agent: string; purpose: RunRolePurpose | null }>();
  for (const line of lines) {
    if (!line.includes('"name":"task"')) continue;
    let root: unknown;
    try {
      root = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (root as { message?: { content?: unknown } } | null)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const call = block as { type?: unknown; name?: unknown; arguments?: unknown };
      if (call.type !== "toolCall" || call.name !== "task") continue;
      const tasks = (call.arguments as { tasks?: unknown } | null)?.tasks;
      if (!Array.isArray(tasks)) continue;
      for (const item of tasks) {
        if (!item || typeof item !== "object") continue;
        const entry = item as { name?: unknown; agent?: unknown; task?: unknown };
        if (typeof entry.name !== "string" || !entry.name) continue;
        const name = entry.name.endsWith(".jsonl") ? entry.name.slice(0, -".jsonl".length) : entry.name;
        map.set(name, {
          agent: typeof entry.agent === "string" ? entry.agent : "",
          purpose: typeof entry.task === "string" ? extractPurpose(entry.task) : null,
        });
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// transcript JSONL 스캐너 (문자열 prefilter + 모듈 스코프 캐시)
// ---------------------------------------------------------------------------

interface EffortMark {
  at: number;
  level: string;
}

interface TranscriptScan {
  /** 사용자 메시지 id → 공백 정규화 후 120자로 자른 첫 텍스트 블록. */
  titles: Map<string, string>;
  /** `thinkingLevel` 변경 타임라인(발생 순서). */
  effortTimeline: EffortMark[];
  /** 부모의 `task` 호출에서 뽑은 자식 이름 → 역할 맵. */
  roleMap: Map<string, { agent: string; purpose: RunRolePurpose | null }>;
  /**
   * 대화 밖 보조 호출(`model_usage`) entry id → 목적·role. stats.db는 이 행을 대화 응답과 같은
   * `messages` 표에 넣고 구분 열을 남기지 않으므로 transcript의 id로만 가려낸다.
   */
  helperEntries: Map<string, { purpose: string; role: string | null }>;
  /** `isError` 도구 결과의 toolCallId → 분류. 오류가 아닌 결과는 담지 않는다. */
  toolErrors: Map<string, ToolErrorKind>;
}

export type ToolErrorKind = "failed" | "noMatch" | "cancelled";

const HARNESS_SKIP_PREFIX = "실행하지 않음: 이 호출이 실행되기 전에 사용자 메시지가 도착했다";
const NO_MATCH_COMMAND = /^(?:grep|egrep|fgrep|rg|test|\[\[?)(?:\s|$)/;

/** 끝의 공백 앞 백슬래시가 짝수(0 포함)면 단어가 끝난 것이다. `file\ #tag`의 #은 같은 단어라 주석이 아니다. */
const UNESCAPED_TRAILING_SPACE = /(?:^|[^\\])(?:\\\\)*\s$/;

/** 단순 명령 구간과, 그 구간 바로 앞에 있던 구분자. 첫 구간은 `start`다. */
interface CommandSegment {
  text: string;
  joinedBy: "start" | "sequence" | "pipe" | "and" | "or";
}

/**
 * 스크립트를 단순 명령 구간으로 나눈다. 줄바꿈·`;`·`&&`·`||`·`|`에서 자르고, 따옴표('…', "…")와
 * 백슬래시로 이스케이프한 문자 안의 구분자는 무시한다. 따옴표 밖 heredoc(`<<`, `<<-`)이나 닫히지
 * 않은 따옴표가 있으면 구간을 믿을 수 없으므로 빈 배열을 돌려준다.
 */
function splitSimpleCommands(script: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let current = "";
  let joinedBy: CommandSegment["joinedBy"] = "start";
  let quote: "'" | '"' | null = null;
  const flush = (next: CommandSegment["joinedBy"]) => {
    if (current.trim()) {
      segments.push({ text: current.trim(), joinedBy });
      joinedBy = next;
    } else if (segments.length > 0 && !(next === "sequence" && joinedBy !== "sequence")) {
      // 빈 구간은 건너뛴다. `a &&⏎b`처럼 &&·||·| 뒤의 줄바꿈이 그 연결을 지우지 않게 한다.
      joinedBy = next;
    }
    current = "";
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < script.length) current += script[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      current += ch + (script[i + 1] ?? "");
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "<" && script[i + 1] === "<" && script[i + 2] !== "<" && script[i - 1] !== "<") {
      return [];
    } else if (ch === "#" && (current === "" || UNESCAPED_TRAILING_SPACE.test(current))) {
      // 단어 첫머리의 #부터 줄 끝까지는 셸 주석이다. 구간으로 세지 않아 앞의 && 연결이 다음 줄 명령에 그대로 이어진다.
      while (i + 1 < script.length && script[i + 1] !== "\n") i++;
    } else if (ch === "\n" || ch === ";" || ch === "|" || (ch === "&" && script[i + 1] === "&")) {
      const next = ch === "&" ? "and" : ch === "|" ? (script[i + 1] === "|" ? "or" : "pipe") : "sequence";
      if (next === "and" || next === "or") i++;
      flush(next);
    } else {
      current += ch;
    }
  }
  if (quote) return [];
  flush("sequence");
  return segments;
}

/** stderr를 버리거나 닫는 리다이렉트. 앞선 명령의 진단이 가려지므로 grep이 실제로 돌았는지 알 수 없다. */
const STDERR_SUPPRESSED = /2>\s*\/dev\/null|2>&-|&>\s*\/dev\/null|>\s*\/dev\/null\s+2>&1/;

/** `cd`가 실패하는 식으로 grep이 아예 실행되지 않았다는 신호. 출력에 이 표지가 있으면 무일치로 보지 않는다. */
const SHELL_ERROR_MARKERS = [
  ": No such file or directory",
  ": command not found",
  ": Permission denied",
  ": Not a directory",
  "syntax error",
  "Traceback (most recent call last)",
];

// bash.ts(node_modules/@oh-my-pi/pi-coding-agent/src/tools/bash.ts)가 만드는 위치에만 맞춘다. 명령 출력이
// 같은 문구를 찍어도 흉내 내지 못하게 한다.
// - 종료 줄: `#buildCompletedResult`(727행)가 출력 뒤 `"", "Command exited with code N"`을 마지막 줄로 붙인다.
// - `[Command cancelled]`: 로컬 실행기가 출력 맨 앞에 붙인다(681-685행, 1600-1606행). 뒤에 capture notice가 붙을 수 있다.
// - `[Command aborted]`: 앞 표지가 없을 때 출력 뒤 `"\n\n[Command aborted]"`로 붙이고(685행), 출력이 없으면 `Command aborted`
//   한 줄이다. 둘 다 뒤에 `\n\n[capture notice]`가 올 수 있다.
const EXIT_CODE_LINE = /(?:^|\n)Command exited with code (\d+)\s*$/;
const ABORTED_TAIL = /(?:^Command aborted|\n\n\[Command aborted\])(?:\n\n\[[^\n]*\])?\s*$/;

/** `cd`는 실패하면 `No such file or directory` 같은 표지를 남기므로, 그 뒤 `&&`의 검사가 돌았는지 출력으로 가릴 수 있다. */
const CD_COMMAND = /^cd(?:\s|$)/;

/**
 * 마지막 검사 명령이 실제로 실행됐다고 볼 수 있는가. `;`·줄바꿈·`|`·`||` 뒤라면 실행됐고 종료 코드도 그
 * 검사의 것이다. `&&` 뒤라면 앞 명령이 실패했을 때 검사는 돌지 않고 종료 코드는 앞 명령의 것이므로,
 * 실패가 출력에 드러나는 `cd`만 앞에 올 수 있다(#36).
 */
function lastCheckRan(segments: CommandSegment[]): boolean {
  let index = segments.length - 1;
  for (;;) {
    while (index > 0 && segments[index].joinedBy === "pipe") index--;
    if (segments[index].joinedBy !== "and") return true;
    index--;
    if (index < 0 || !CD_COMMAND.test(segments[index].text)) return false;
  }
}

/**
 * 오류로 기록된 도구 결과를 가른다. 보수적으로, 근거가 분명한 것만 `cancelled`·`noMatch`로 두고
 * 나머지는 모두 `failed`다.
 */
export function classifyToolError(toolName: string, command: string | null, text: string): ToolErrorKind {
  if (text.startsWith(HARNESS_SKIP_PREFIX)) return "cancelled";
  if (toolName !== "bash") return "failed";
  // 실제 중단·취소 결과에는 종료 줄이 없다. 종료 줄이 있으면 명령이 표지를 흉내 낸 것이다.
  const exit = EXIT_CODE_LINE.exec(text);
  if (!exit && (text.startsWith("[Command cancelled]") || ABORTED_TAIL.test(text))) return "cancelled";
  if (!command || exit?.[1] !== "1") return "failed";
  if (SHELL_ERROR_MARKERS.some((marker) => text.includes(marker))) return "failed";
  const segments = splitSimpleCommands(command);
  const last = segments.at(-1);
  if (!last || !NO_MATCH_COMMAND.test(last.text)) return "failed";
  if (segments.slice(0, -1).some((segment) => STDERR_SUPPRESSED.test(segment.text))) return "failed";
  return lastCheckRan(segments) ? "noMatch" : "failed";
}

function emptyScan(): TranscriptScan {
  return { titles: new Map(), effortTimeline: [], roleMap: new Map(), helperEntries: new Map(), toolErrors: new Map() };
}

/** 스캔 캐시 상한. 오래된 것부터 버린다. */
const TRANSCRIPT_CACHE_MAX = 128;
const transcriptCache = new Map<string, TranscriptScan>();

function scanTranscriptFile(file: string): TranscriptScan {
  let stamp = "";
  try {
    const stat = statSync(file);
    stamp = `${file}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    // 기록에 없는 transcript는 비워두고 "미측정"으로 표시한다.
    return emptyScan();
  }
  const hit = transcriptCache.get(stamp);
  if (hit) {
    transcriptCache.delete(stamp);
    transcriptCache.set(stamp, hit);
    return hit;
  }
  const scan = readTranscriptFile(file);
  transcriptCache.set(stamp, scan);
  while (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
    const oldest = transcriptCache.keys().next();
    if (oldest.done) break;
    transcriptCache.delete(oldest.value);
  }
  return scan;
}

/** assistant 줄의 `bash` toolCall 블록에서 toolCallId → command를 모은다. */
function collectBashCommands(line: string, out: Map<string, string>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const record = parsed as { message?: { content?: unknown } };
  const content = record.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: { command?: unknown } };
    if (call.type === "toolCall" && call.name === "bash" && typeof call.id === "string" && typeof call.arguments?.command === "string") {
      out.set(call.id, call.arguments.command);
    }
  }
}

function classifyToolErrors(errorLines: string[], bashCommands: Map<string, string>): Map<string, ToolErrorKind> {
  const result = new Map<string, ToolErrorKind>();
  for (const line of errorLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parsed as { message?: { toolCallId?: unknown; toolName?: unknown; isError?: unknown; content?: unknown } };
    const message = record.message;
    if (!message || message.isError !== true || typeof message.toolCallId !== "string") continue;
    const texts: string[] = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        const textBlock = block as { type?: unknown; text?: unknown };
        if (textBlock.type === "text" && typeof textBlock.text === "string") texts.push(textBlock.text);
      }
    }
    const text = texts.join("\n");
    const toolName = typeof message.toolName === "string" ? message.toolName : "";
    result.set(message.toolCallId, classifyToolError(toolName, bashCommands.get(message.toolCallId) ?? null, text));
  }
  return result;
}

function readTranscriptFile(file: string): TranscriptScan {
  const scan = emptyScan();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return scan;
  }
  const taskLines: string[] = [];
  const errorLines: string[] = [];
  const bashCommands = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (line.startsWith('{"type":"thinking_level_change"')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = parsed as { thinkingLevel?: unknown; timestamp?: unknown };
      const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
      if (typeof record.thinkingLevel === "string" && record.thinkingLevel && Number.isFinite(at)) {
        scan.effortTimeline.push({ at, level: record.thinkingLevel });
      }
    } else if (line.startsWith('{"type":"model_change"') || line.startsWith('{"type":"session"')) {
      // 모델 표기는 DB 실측값을 쓰므로 여기서는 파싱만 통과시키고 버린다.
      continue;
    } else if (line.startsWith('{"type":"model_usage"')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = parsed as { id?: unknown; purpose?: unknown; role?: unknown };
      if (typeof record.id !== "string" || !record.id) continue;
      scan.helperEntries.set(record.id, {
        purpose: typeof record.purpose === "string" && record.purpose ? record.purpose : "?",
        role: typeof record.role === "string" && record.role ? record.role : null,
      });
    } else if (line.startsWith('{"type":"message"')) {
      if (line.includes('"role":"user"')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const record = parsed as { id?: unknown; message?: { content?: unknown } };
        if (typeof record.id !== "string") continue;
        const content = record.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block && typeof block === "object") {
            const textBlock = block as { type?: unknown; text?: unknown };
            if (textBlock.type === "text" && typeof textBlock.text === "string") {
              scan.titles.set(record.id, textBlock.text.replace(/\s+/g, " ").trim().slice(0, 120));
              break;
            }
          }
        }
      } else {
        if (line.includes('"name":"task"')) taskLines.push(line);
        if (line.includes('"role":"toolResult"') && line.includes('"isError":true')) {
          errorLines.push(line);
        } else if (line.includes('"type":"toolCall"') && line.includes('"name":"bash"')) {
          collectBashCommands(line, bashCommands);
        }
      }
    }
  }
  scan.toolErrors = classifyToolErrors(errorLines, bashCommands);
  scan.roleMap = parseTaskRoleMap(taskLines);
  return scan;
}

// ---------------------------------------------------------------------------
// stats.db 읽기 (호출마다 열고 finally에서 닫는다)
// ---------------------------------------------------------------------------

interface MessageRow {
  session_file: string;
  entry_id: string;
  folder: string;
  model: string;
  provider: string;
  timestamp: number;
  duration: number | null;
  /** 첫 토큰까지(ms). 코어가 부동소수로 남긴다. 미기록은 `null`이며 0과 구분한다. */
  ttft: number | null;
  stop_reason: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_total: number;
  cost_unpriced: number;
  agent_type: string;
}

interface ToolCallRow {
  session_file: string;
  tool_name: string;
  timestamp: number;
  is_error: number | null;
  tool_call_id: string;
}

interface UserRow {
  entry_id: string;
  timestamp: number;
}

function openStatsDb(): Database | null {
  const path = join(homedir(), ".omp", "stats.db");
  if (!existsSync(path)) return null;
  return new Database(path, { readonly: true });
}

/** 갱신 기록 파일별 파싱 결과. 끝난 갱신의 기록은 바뀌지 않으므로 크기·수정 시각이 같으면 다시 읽지 않는다. */
const deployLogCache = new Map<string, { size: number; mtimeMs: number; events: HarnessDeployEvent[] }>();
const DEPLOY_LOG_NAME_RE = /^\d{8}T\d{6}Z\.log$/;

/**
 * 이 PC의 WSL 갱신 기록(`~/.omp/wsl-update/<UTC>.log`)으로 하네스 시간선을 만든다. 폴더가 없거나
 * 읽지 못하면 빈 시간선이며, 그러면 모든 run이 unknown이다.
 */
function loadHarnessTimeline(): HarnessSegment[] {
  const dir = join(homedir(), ".omp", "wsl-update");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => DEPLOY_LOG_NAME_RE.test(name)).sort();
  } catch {
    return [];
  }
  const events: HarnessDeployEvent[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      const cached = deployLogCache.get(path);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        events.push(...cached.events);
        continue;
      }
      const parsed = parseHarnessDeployLog(readFileSync(path, "utf8"));
      deployLogCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, events: parsed });
      events.push(...parsed);
    } catch {
      // 읽는 도중 사라진 파일은 건너뛴다. 그 구간은 다음 START의 old 대조로 unknown이 된다.
    }
  }
  return buildHarnessTimeline(events);
}

let statsSync: Promise<void> | null = null;

/**
 * 읽기 전에 세션 JSONL을 `stats.db`로 증분 동기화한다. 코어는 `/usage`·`omp stats`를 열 때만
 * 동기화하므로, 이것 없이는 그 뒤에 진행된 세션이 효율 탭에서 "기록 없음"으로 보인다.
 * 바뀐 파일만 읽고(`file_offsets`), 동시 요청은 진행 중인 한 번을 같이 기다린다. 실패하면
 * 이미 쌓인 기록으로 계속 보여준다.
 */
export function syncStatsDb(): Promise<void> {
  statsSync ??= (async () => {
    try {
      await syncAllSessions({ workers: 1 });
    } finally {
      closeDb();
    }
  })()
    .catch((error: unknown) => {
      console.warn("[run-xray] stats sync failed; serving existing stats.db", error);
    })
    .finally(() => {
      statsSync = null;
    });
  return statsSync;
}

/**
 * 최상위 transcript는 `<폴더>/<ts>_<sessionId>.jsonl`(예: `2026-09-14T11-34-03-224Z_01a0…`)
 * 이고 SubAgent transcript는 `<폴더>/<ts>_<sessionId>/<역할명>.jsonl`이다. 둘 다
 * `user_messages`에 행을 남기므로(자식에게는 브리프가 사용자 메시지다) 구성 비교에서
 * 자식을 독립 세션으로 세지 않으려면 basename이 `_<sessionId>`로 끝나는지 봐야 한다.
 * `resolveParentSessionFile`의 suffix 규칙과 같은 판정이다. 자식 이름은 `tasks[].name`
 * (CamelCase) 또는 `__advisor`라 이 모양이 되지 않는다.
 */
const PARENT_TRANSCRIPT_RE =
  /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * basename이 `_<sessionId>.jsonl`로 끝나는 부모 transcript를 찾는다.
 * LIKE 패턴에 쓰는 sessionId는 `%`/`_`/`\`를 escape하고 `ESCAPE` 절을 쓴다.
 */
function resolveParentSessionFile(db: Database, sessionId: string): string | null {
  const pattern = `%\\_${sessionId.replace(/[\\%_]/g, (char) => `\\${char}`)}.jsonl`;
  // 파일마다 행이 수백~수천 개라 `LIKE '%…'`는 messages 인덱스 전체(수십만 행)를 훑는다. 고유 session_file만
  // 인덱스에서 하나씩 건너뛰며(loose index scan) 뽑아 같은 LIKE에 건다. 대상 집합은 messages와
  // user_messages의 고유 session_file 합집합 그대로다.
  const rows = db
    .query<{ session_file: string }, [string, string]>(
      `WITH RECURSIVE
         m(f) AS (
           SELECT MIN(session_file) FROM messages
           UNION ALL
           SELECT (SELECT MIN(session_file) FROM messages WHERE session_file > m.f) FROM m WHERE m.f IS NOT NULL
         ),
         u(f) AS (
           SELECT MIN(session_file) FROM user_messages
           UNION ALL
           SELECT (SELECT MIN(session_file) FROM user_messages WHERE session_file > u.f) FROM u WHERE u.f IS NOT NULL
         )
       SELECT f AS session_file FROM m WHERE f LIKE ? ESCAPE '\\'
       UNION
       SELECT f AS session_file FROM u WHERE f LIKE ? ESCAPE '\\'`,
    )
    .all(pattern, pattern);
  const suffix = `_${sessionId}.jsonl`;
  const parents = rows
    .map((row) => row.session_file)
    .filter((file) => (file.split(/[\\/]/).pop() ?? file).endsWith(suffix))
    .sort();
  return parents[0] ?? null;
}

interface SessionData {
  sessionId: string;
  parentFile: string;
  childFiles: string[];
  users: UserRow[];
  messages: MessageRow[];
  toolCalls: ToolCallRow[];
  parentScan: TranscriptScan;
  childScans: Map<string, TranscriptScan>;
}

function loadSessionDataByParent(db: Database, sessionId: string, parentFile: string): SessionData {
  const stem = parentFile.slice(0, -".jsonl".length);
  // 자식 transcript는 `<stem>\` 또는 `<stem>/`로 시작하는 파일이다. `session_file`은 BINARY(UTF-8) 비교라
  // 같은 접두사 문자열은 `[접두사, 다음 문자)` 구간 하나이고(`/`→`0`, `\`→`]`는 바로 다음 바이트),
  // 구간 조회는 `idx_messages_session`을 타서 messages 전체를 훑지 않는다. LIKE는 ASCII 대소문자를
  // 가리지 않아 messages 전체 인덱스를 읽어야 했다. 아래 startsWith 검사는 그대로 두어 판정 계약을 지킨다.
  const childRows = db
    .query<{ session_file: string }, [string, string, string, string]>(
      `SELECT DISTINCT session_file FROM messages
       WHERE (session_file >= ? AND session_file < ?) OR (session_file >= ? AND session_file < ?)
       ORDER BY session_file ASC`,
    )
    .all(`${stem}\\`, `${stem}]`, `${stem}/`, `${stem}0`);
  const childFiles = childRows
    .map((row) => row.session_file)
    .filter(
      (file) => file !== parentFile && (file.startsWith(`${stem}\\`) || file.startsWith(`${stem}/`)),
    );
  const users = db
    .query<UserRow, [string]>(
      `SELECT entry_id, timestamp FROM user_messages
       WHERE session_file = ? ORDER BY timestamp ASC, entry_id ASC`,
    )
    .all(parentFile);
  const files = [parentFile, ...childFiles];
  const placeholders = files.map(() => "?").join(",");
  const messages = db
    .query<MessageRow, string[]>(
      `SELECT session_file, entry_id, folder, model, provider, timestamp, duration, ttft,
              stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              total_tokens, cost_total, cost_unpriced, agent_type
       FROM messages WHERE session_file IN (${placeholders}) ORDER BY timestamp ASC, id ASC`,
    )
    .all(...files);
  const toolCalls = db
    .query<ToolCallRow, string[]>(
      `SELECT session_file, tool_call_id, tool_name, timestamp, is_error
       FROM tool_calls WHERE session_file IN (${placeholders})`,
    )
    .all(...files);
  const parentScan = scanTranscriptFile(parentFile);
  const childScans = new Map<string, TranscriptScan>();
  for (const file of childFiles) {
    childScans.set(file, scanTranscriptFile(file));
  }
  return { sessionId, parentFile, childFiles, users, messages, toolCalls, parentScan, childScans };
}

/** 시각이 속한 run 번호. 첫 요청보다 이른 기록은 0번 run에 넣는다. */
function bucketIndex(users: UserRow[], timestamp: number): number {
  let low = 0;
  let high = users.length - 1;
  let answer = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (users[middle].timestamp <= timestamp) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

function roleNameOf(childFile: string): string {
  const base = childFile.split(/[\\/]/).pop() ?? childFile;
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

// 역할은 부모 JSONL의 `task` 인자 하나로만 정한다. advisor만 예외로 파일명 규약을 쓴다 —
// advisor는 `tasks[]`에 실리지 않기 때문이다. 판정 경로를 늘리지 않는다: stats.db의
// `agent_type`은 실측상 `__advisor.jsonl`과 정확히 같은 집합만 가리켜(613행 전부) 새로
// 잡아내는 것이 없고, 오탐 경로만 하나 더 생긴다.
//
// 실제로 숫자로 끝나는 task 이름을 지키려면 정확 일치가 먼저다.
function resolveChildKind(
  roleName: string,
  roleMap: Map<string, { agent: string; purpose: RunRolePurpose | null }>,
): { kind: RunRoleKind; purpose: RunRolePurpose | null } {
  if (roleName === "__advisor") return { kind: "advisor", purpose: null };
  const entry = roleMap.get(roleName) ?? roleMap.get(roleName.replace(/-\d+$/, ""));
  if (entry && (entry.agent === "maker" || entry.agent === "checker")) {
    return { kind: entry.agent, purpose: entry.purpose };
  }
  return { kind: "unattributed", purpose: null };
}

function outcomeFromStopReason(stopReason: string): RunOutcome {
  if (stopReason === "stop") return "completed";
  if (stopReason === "error" || stopReason === "length") return "error";
  if (stopReason === "aborted") return "aborted";
  return "running";
}

/**
 * 한 역할의 기록을 모은다. `helperEntries`에 있는 행은 대화 밖 보조 호출이다. 토큰·비용·가격 미기록
 * 수는 역할 합계에 한 번씩 넣고(기존 합계 유지) `helpers`에 내역으로 남긴다. 요청 수·생성시간·
 * 소요시간 미기록·첫 응답 대기·모델·오류 수는 대화 요청만 센다 — 보조 호출은 `duration`·`ttft`를
 * 남기지 않으므로 섞으면 생성시간이 거짓으로 "하한"이 되고 대표 모델이 바뀐다.
 */
function buildRoleSegment(
  id: string,
  kind: RunRoleKind,
  purpose: RunRolePurpose | null,
  rows: MessageRow[],
  helperEntries: TranscriptScan["helperEntries"],
  toolCallCount: number,
  efforts: string[],
): RunRoleSegment {
  const models: string[] = [];
  const seenModels = new Set<string>();
  const helpers = new Map<string, RunHelperUsage>();
  let requestCount = 0;
  let busyMs = 0;
  let startedAt = Number.POSITIVE_INFINITY;
  let endedAt = Number.NEGATIVE_INFINITY;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let unpricedRequests = 0;
  let untimedRequests = 0;
  let ttftMs = 0;
  let ttftRequests = 0;
  let errorCount = 0;
  let abortedCount = 0;
  for (const row of rows) {
    const label = `${row.provider}/${row.model}`;
    const requestStart = row.timestamp;
    const requestEnd = requestStart + (row.duration ?? 0);
    if (requestStart < startedAt) startedAt = requestStart;
    if (requestEnd > endedAt) endedAt = requestEnd;
    inputTokens += row.input_tokens;
    outputTokens += row.output_tokens;
    cacheReadTokens += row.cache_read_tokens;
    cacheWriteTokens += row.cache_write_tokens;
    totalTokens += row.total_tokens;
    // 상류 `omp-stats`의 `unpricedRequestSql`과 같은 조건이다.
    const unpriced = row.total_tokens > 0 && row.cost_total === 0
      && (row.provider === "xai-oauth" || row.cost_unpriced === 1);
    const cost = unpriced ? 0 : row.cost_total;
    if (unpriced) unpricedRequests += 1;
    estimatedCostUsd += cost;
    const failed = row.stop_reason === "error" || row.stop_reason === "length";

    const helperEntry = helperEntries.get(row.entry_id);
    if (helperEntry) {
      const key = JSON.stringify([helperEntry.purpose, helperEntry.role, label]);
      const helper = helpers.get(key) ?? {
        purpose: helperEntry.purpose,
        role: helperEntry.role,
        model: label,
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        unpricedRequests: 0,
        errorCount: 0,
      };
      helper.requestCount += 1;
      helper.inputTokens += row.input_tokens;
      helper.outputTokens += row.output_tokens;
      helper.cacheReadTokens += row.cache_read_tokens;
      helper.cacheWriteTokens += row.cache_write_tokens;
      helper.totalTokens += row.total_tokens;
      helper.estimatedCostUsd += cost;
      if (unpriced) helper.unpricedRequests += 1;
      if (failed) helper.errorCount += 1;
      helpers.set(key, helper);
      continue;
    }

    requestCount += 1;
    if (!seenModels.has(label)) {
      seenModels.add(label);
      models.push(label);
    }
    // `duration`이 없는 요청은 0ms로 더해지므로 busyMs가 하한이 된다. 숨기지 않고 센다.
    if (row.duration === null) untimedRequests += 1;
    busyMs += row.duration ?? 0;
    if (row.ttft !== null) {
      ttftMs += row.ttft;
      ttftRequests += 1;
    }
    if (failed) {
      errorCount += 1;
    } else if (row.stop_reason === "aborted") {
      abortedCount += 1;
    }
  }
  return {
    id,
    kind,
    purpose,
    models,
    efforts,
    requestCount,
    busyMs,
    spanMs: endedAt - startedAt,
    startedAt,
    endedAt,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    estimatedCostUsd,
    unpricedRequests,
    untimedRequests,
    ttftMs: ttftRequests > 0 ? ttftMs : null,
    ttftRequests,
    helpers: [...helpers.values()].sort(
      (a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.totalTokens - a.totalTokens
        || (a.purpose < b.purpose ? -1 : a.purpose > b.purpose ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
    ),
    errorCount,
    abortedCount,
    toolCalls: toolCallCount,
  };
}

function buildToolTotals(rows: ToolCallRow[], data: SessionData): RunToolTotal[] {
  const grouped = new Map<string, { calls: number; failed: number; noMatch: number; cancelled: number }>();
  for (const row of rows) {
    const entry = grouped.get(row.tool_name) ?? { calls: 0, failed: 0, noMatch: 0, cancelled: 0 };
    entry.calls += 1;
    if ((row.is_error ?? 0) !== 0) {
      const scan = row.session_file === data.parentFile ? data.parentScan : data.childScans.get(row.session_file);
      // transcript에서 못 찾은 오류는 조용히 빠지지 않도록 실패로 센다.
      const kind = scan?.toolErrors.get(row.tool_call_id) ?? "failed";
      entry[kind] += 1;
    }
    grouped.set(row.tool_name, entry);
  }
  return [...grouped.entries()]
    .map(([toolName, totals]) => ({ toolName, ...totals }))
    .sort((a, b) => b.calls - a.calls || (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0))
    .slice(0, 8);
}

/**
 * 세션 전체 run을 만든다. run i의 창은 `[u[i].timestamp, u[i+1].timestamp)`이며
 * 마지막 run의 끝은 관측된 요청 종료 시각과 도구 기록 시각의 최댓값이다.
 * 다음 사용자 요청까지의 창은 사용자 유휴를 포함하며 작업 완료 시간과 다르다.
 */
function buildSessionRuns(data: SessionData, harness: readonly HarnessSegment[] = []): RunDetail[] {
  if (data.users.length === 0) return [];
  const messageBuckets: MessageRow[][] = data.users.map(() => []);
  for (const row of data.messages) {
    messageBuckets[bucketIndex(data.users, row.timestamp)].push(row);
  }
  const toolBuckets: ToolCallRow[][] = data.users.map(() => []);
  for (const row of data.toolCalls) {
    toolBuckets[bucketIndex(data.users, row.timestamp)].push(row);
  }
  // 마지막 창의 끝은 이 세션에서 관측된 마지막 기록이다. 도구 호출이 마지막 모델
  // 응답보다 뒤에 남으면 그것까지 포함해야 경과와 도구 집계가 어긋나지 않는다.
  let sessionMaxTs = data.users[data.users.length - 1].timestamp;
  let sessionEndTs = sessionMaxTs;
  for (const row of data.messages) {
    if (row.timestamp > sessionMaxTs) sessionMaxTs = row.timestamp;
    const requestEnd = row.timestamp + (row.duration ?? 0);
    if (requestEnd > sessionEndTs) sessionEndTs = requestEnd;
  }
  for (const row of data.toolCalls) {
    if (row.timestamp > sessionMaxTs) sessionMaxTs = row.timestamp;
    if (row.timestamp > sessionEndTs) sessionEndTs = row.timestamp;
  }

  const details: RunDetail[] = [];
  for (let index = 0; index < data.users.length; index += 1) {
    const user = data.users[index];
    const windowStart = user.timestamp;
    const windowEnd = Math.max(
      index + 1 < data.users.length ? data.users[index + 1].timestamp : sessionEndTs,
      windowStart,
    );
    const wallClockMs = windowEnd - windowStart;
    const bucketMessages = messageBuckets[index];
    const bucketTools = toolBuckets[index];

    const byFile = new Map<string, MessageRow[]>();
    for (const row of bucketMessages) {
      const list = byFile.get(row.session_file) ?? [];
      list.push(row);
      byFile.set(row.session_file, list);
    }
    const toolCountByFile = new Map<string, number>();
    for (const row of bucketTools) {
      toolCountByFile.set(row.session_file, (toolCountByFile.get(row.session_file) ?? 0) + 1);
    }

    // 다음 사용자 요청이 존재하면 이 창은 이미 닫혔다. 최종 답변 전에 닫혔다면
    // "진행 중"이 아니라 "사용자 개입으로 중단"이다.
    // 결과는 부모의 마지막 **대화** 응답으로 정한다. 보조 호출(`model_usage`)은 답변 도중이나
    // 뒤에 `stop`으로 남으므로, 섞으면 최종 답변 없이 끝난 run이 "완료"로 둔갑한다.
    const parentRows = byFile.get(data.parentFile) ?? [];
    const lastParentReply = parentRows.findLast((row) => !data.parentScan.helperEntries.has(row.entry_id));
    const hasFollowingRequest = index + 1 < data.users.length;
    const settled = lastParentReply ? outcomeFromStopReason(lastParentReply.stop_reason) : "running";
    const outcome: RunOutcome = settled === "running" && hasFollowingRequest ? "interrupted" : settled;

    // 창이 닫힌 run은 마지막 관측 기록(`windowEnd`)에서 끝난다. 그 뒤의 effort 변경은
    // 이 run에 쓰인 적이 없다. 아직 진행 중인 마지막 run만 상한이 없다.
    // 생성 종료까지 창을 늘려도 마지막 기록 뒤의 설정 변경을 사용된 effort로 세지 않는다.
    const effortCap = outcome === "running" ? null : hasFollowingRequest ? windowEnd : sessionMaxTs;

    const roles: RunRoleSegment[] = [];
    if (parentRows.length > 0) {
      roles.push(
        buildRoleSegment(
          "main",
          "main",
          null,
          parentRows,
          data.parentScan.helperEntries,
          toolCountByFile.get(data.parentFile) ?? 0,
          windowEfforts(data.parentScan, data.users, index, effortCap),
        ),
      );
    }
    for (const childFile of data.childFiles) {
      const rows = byFile.get(childFile);
      if (!rows || rows.length === 0) continue;
      const roleName = roleNameOf(childFile);
      const resolved = resolveChildKind(roleName, data.parentScan.roleMap);
      const scan = data.childScans.get(childFile) ?? emptyScan();
      roles.push(
        buildRoleSegment(
          roleName,
          resolved.kind,
          resolved.purpose,
          rows,
          scan.helperEntries,
          toolCountByFile.get(childFile) ?? 0,
          windowEfforts(scan, data.users, index, effortCap),
        ),
      );
    }

    let busyMs = 0;
    let totalTokens = 0;
    let estimatedCostUsd = 0;
    let unpricedRequests = 0;
    for (const role of roles) {
      busyMs += role.busyMs;
      totalTokens += role.totalTokens;
      estimatedCostUsd += role.estimatedCostUsd;
      unpricedRequests += role.unpricedRequests;
    }
    const intervals = bucketMessages.map(
      (row): readonly [number, number] => [row.timestamp, row.timestamp + (row.duration ?? 0)],
    );
    const unmeasuredMs = Math.max(0, wallClockMs - unionCoverageMs(intervals, windowStart, windowEnd));
    const unmeasured: RunUnmeasuredReason[] = [];
    if (unmeasuredMs > 0) unmeasured.push("wait-attribution");
    if (roles.some((role) => role.unpricedRequests > 0)) unmeasured.push("unpriced-cost");
    if (roles.some((role) => role.efforts.length === 0)) unmeasured.push("effort-unrecorded");
    if (roles.some((role) => role.kind === "unattributed")) unmeasured.push("role-unattributed");
    if (roles.some((role) => role.untimedRequests > 0)) unmeasured.push("busy-unrecorded");

    const built = buildConfigSignature(
      roles.map((role) => ({ kind: role.kind, models: role.models, efforts: role.efforts })),
    );
    details.push({
      runId: `${data.sessionId}:${user.entry_id}`,
      sessionId: data.sessionId,
      entryId: user.entry_id,
      index: index + 1,
      title: data.parentScan.titles.get(user.entry_id) ?? null,
      startedAt: windowStart,
      endedAt: outcome === "running" ? null : windowEnd,
      wallClockMs,
      outcome,
      busyMs,
      childCount: roles.filter((role) => role.id !== "main").length,
      totalTokens,
      estimatedCostUsd,
      unpricedRequests,
      configSignature: built.signature,
      harnessRevision: harnessRevisionAt(harness, windowStart),
      roles,
      bottlenecks: pickBottlenecks(
        roles.map((role) => ({ id: role.id, ms: role.busyMs })),
        unmeasuredMs,
      ),
      unmeasuredMs,
      toolTotals: buildToolTotals(bucketTools, data),
      unmeasured,
    });
  }
  return details;
}

/**
 * 이 run에서 실제로 쓰인 effort. 변경 기록은 바뀔 때만 남으므로 창 안의 변경만
 * 보면 "창 시작 시점에 이미 걸려 있던 값"을 통째로 놓친다. 창 시작 이전의
 * 마지막 값을 먼저 싣고 그 뒤 창 안의 변경을 순서대로 잇는다.
 *
 * 창 소속 판정은 `bucketIndex`와 같은 half-open 규칙을 써야 한다. 다음 사용자
 * 요청과 같은 시각의 기록은 다음 run 것이고, 그 기록을 양쪽에 다 넣으면 경계
 * run의 effort와 구성 서명이 오염된다.
 *
 * `cap`은 창이 닫힌 run의 끝(마지막 관측 기록)이다. 마지막 run은 뒤에 사용자 요청이
 * 없어 `bucketIndex`가 이후 모든 시각을 이 run으로 돌려보내므로, 응답이 끝난 뒤 사용자가
 * effort만 바꾼 값이 "이 run에서 쓴 값"으로 둔갑한다. 아직 진행 중이면 `null`이다.
 */
function windowEfforts(
  scan: TranscriptScan,
  users: UserRow[],
  runIndex: number,
  cap: number | null,
): string[] {
  const windowStart = users[runIndex].timestamp;
  const efforts: string[] = [];
  const seen = new Set<string>();
  let activeAtStart: string | null = null;
  for (const mark of scan.effortTimeline) {
    if (mark.at <= windowStart) {
      activeAtStart = mark.level;
      continue;
    }
    if (cap !== null && mark.at > cap) continue;
    if (bucketIndex(users, mark.at) !== runIndex) continue;
    if (activeAtStart !== null && !seen.has(activeAtStart)) {
      seen.add(activeAtStart);
      efforts.push(activeAtStart);
      activeAtStart = null;
    }
    if (!seen.has(mark.level)) {
      seen.add(mark.level);
      efforts.push(mark.level);
    }
  }
  if (activeAtStart !== null && !seen.has(activeAtStart)) efforts.push(activeAtStart);
  return efforts;
}

function unionUnmeasured(details: ReadonlyArray<{ unmeasured: RunUnmeasuredReason[] }>): RunUnmeasuredReason[] {
  const seen = new Set<RunUnmeasuredReason>();
  for (const detail of details) {
    for (const reason of detail.unmeasured) seen.add(reason);
  }
  return RUN_UNMEASURED_REASONS.filter((reason) => seen.has(reason));
}

// ---------------------------------------------------------------------------
// 공개 API (라우트에서 호출)
// ---------------------------------------------------------------------------

/** `GET /api/runs` — 최신 run이 먼저 온다. */
export function listRuns(sessionId: string, limit: number = RUN_LIST_DEFAULT_LIMIT): RunListResponse {
  if (!sessionId.trim()) throw new RunXrayError("sessionId가 필요합니다.", 400);
  const clamped = Math.min(Math.max(Math.floor(limit), 1), RUN_LIST_MAX_LIMIT);
  const db = openStatsDb();
  if (!db) return { sessionId, runs: [], unmeasured: [] };
  try {
    const parentFile = resolveParentSessionFile(db, sessionId);
    if (!parentFile) return { sessionId, runs: [], unmeasured: [] };
    const details = buildSessionRuns(loadSessionDataByParent(db, sessionId, parentFile), loadHarnessTimeline());
    details.sort((a, b) => b.startedAt - a.startedAt || b.index - a.index);
    const picked = details.slice(0, clamped);
    return {
      sessionId,
      runs: picked.map((detail) => ({
        runId: detail.runId,
        sessionId: detail.sessionId,
        entryId: detail.entryId,
        index: detail.index,
        title: detail.title,
        startedAt: detail.startedAt,
        endedAt: detail.endedAt,
        wallClockMs: detail.wallClockMs,
        outcome: detail.outcome,
        busyMs: detail.busyMs,
        childCount: detail.childCount,
        totalTokens: detail.totalTokens,
        estimatedCostUsd: detail.estimatedCostUsd,
        unpricedRequests: detail.unpricedRequests,
        configSignature: detail.configSignature,
        harnessRevision: detail.harnessRevision,
      })),
      unmeasured: unionUnmeasured(picked),
    };
  } finally {
    db.close();
  }
}

/** `GET /api/runs/<runId>` — 없으면 404. */
export function getRunDetail(sessionId: string, entryId: string): RunDetail {
  if (!sessionId.trim() || !entryId.trim()) {
    throw new RunXrayError("runId 형식이 올바르지 않습니다.", 400);
  }
  const db = openStatsDb();
  if (!db) throw new RunXrayError("기록을 찾을 수 없습니다.", 404);
  try {
    const parentFile = resolveParentSessionFile(db, sessionId);
    if (!parentFile) throw new RunXrayError("기록을 찾을 수 없습니다.", 404);
    const details = buildSessionRuns(loadSessionDataByParent(db, sessionId, parentFile), loadHarnessTimeline());
    const found = details.find((detail) => detail.entryId === entryId);
    if (!found) throw new RunXrayError("기록을 찾을 수 없습니다.", 404);
    return found;
  } finally {
    db.close();
  }
}

/**
 * `GET /api/experiments` — 구성을 `configSignature`로 묶어 비교한다.
 * `scope`가 `attributed`면 역할을 하나라도 확정하지 못한 run을 그룹화 전에 뺀다.
 * `groupBy`가 `harness`면 같은 구성을 하네스 revision별로 나눈다(기본 `config`는 기존 묶음 그대로).
 * `harness`(40자 revision 또는 `unknown`)를 주면 그 revision의 run만 센다. 선택지(`harnesses`)는
 * 범위 필터 뒤·하네스 필터 전 run으로 만든다.
 */
export function listExperiments(
  folder: string | null,
  sessionLimit: number = EXPERIMENT_DEFAULT_SESSIONS,
  scope: ExperimentScope = "all",
  groupBy: ExperimentGroupBy = "config",
  harness: string | null = null,
): ExperimentResponse {
  const clamped = Math.min(Math.max(Math.floor(sessionLimit), 1), EXPERIMENT_MAX_SESSIONS);
  const db = openStatsDb();
  if (!db) {
    return {
      folder,
      folders: [],
      scope,
      configs: [],
      runCount: 0,
      sessionCount: 0,
      excludedRunCount: 0,
      groupBy,
      harness,
      harnesses: [],
      unmeasured: [],
    };
  }
  try {
    // 선택지는 messages에 나온 폴더와 user_messages에 나온 폴더의 합집합이다.
    // 아직 모델 응답이 없어 messages에 행이 없는 세션의 폴더도 빠뜨리지 않는다.
    // 순서는 run 수(사용자 요청 수) 많은 순이다.
    const folders = db
      .query<{ folder: string }, []>(
        `SELECT f.folder AS folder FROM (
           SELECT folder FROM messages GROUP BY folder
           UNION
           SELECT folder FROM user_messages GROUP BY folder
         ) f LEFT JOIN user_messages u ON u.folder = f.folder
         GROUP BY f.folder ORDER BY COUNT(u.entry_id) DESC, f.folder ASC`,
      )
      .all()
      .map((row) => row.folder);
    // 부모 후보는 user_messages의 고유 session_file이다. user_messages와 messages를 바로 조인하면
    // (요청 수 × 응답 수)만큼 행이 불어나므로, 고유 파일마다 가장 늦은 응답 시각을 인덱스로 한 번씩만 읽는다.
    // 마지막 응답 시각이 같거나 없는 세션의 순서는 이전 GROUP BY가 내던 session_file 오름차순으로 못박는다.
    // DISTINCT의 방출 순서는 쿼리 계획에 달려 있어, 이 보조 키가 없으면 계획이 바뀔 때 동률의 순서가 달라진다.
    const parentRows = folder
      ? db
          .query<{ session_file: string }, [string]>(
            `SELECT u.session_file AS session_file
             FROM (SELECT DISTINCT session_file FROM user_messages WHERE folder = ?) u
             ORDER BY (SELECT MAX(timestamp) FROM messages WHERE session_file = u.session_file) DESC, u.session_file COLLATE BINARY ASC`,
          )
          .all(folder)
      : db
          .query<{ session_file: string }, []>(
            `SELECT u.session_file AS session_file
             FROM (SELECT DISTINCT session_file FROM user_messages) u
             ORDER BY (SELECT MAX(timestamp) FROM messages WHERE session_file = u.session_file) DESC, u.session_file COLLATE BINARY ASC`,
          )
          .all();
    // 자식 transcript를 먼저 버리고 나서 개수를 센다. 먼저 자르면 최근 세션이
    // 자식 행에 밀려 빠진다.
    const picked = parentRows
      .map((row) => row.session_file)
      .filter((file) => PARENT_TRANSCRIPT_RE.test(file))
      .slice(0, clamped);

    const grouped = new Map<string, { signature: string; roles: ExperimentConfigRole[]; runs: RunDetail[] }>();
    const harnessTimeline = loadHarnessTimeline();
    const scopedRuns: RunDetail[] = [];
    // `attributed`는 역할 판정이 끝난 run만 남긴다. 제외 수를 세어 두면 화면이
    // "무엇을 빼고 센 값인지"를 숫자로 말할 수 있다.
    let sessionCount = 0;
    let excludedRunCount = 0;
    for (const parentFile of picked) {
      // 부모 transcript 경로에서 sessionId를 복원한다(`<ts>_<sessionId>.jsonl`).
      const base = parentFile.split(/[\\/]/).pop() ?? parentFile;
      const sessionId = base.endsWith(".jsonl")
        ? base.slice(0, -".jsonl".length).split("_").slice(1).join("_")
        : "";
      const details = buildSessionRuns(loadSessionDataByParent(db, sessionId, parentFile), harnessTimeline);
      let contributed = false;
      for (const detail of details) {
        // 역할이 없거나 확정하지 못한 run은 비교할 역할 체계가 없다. 그룹화 전에 뺀다.
        if (scope === "attributed" && (detail.roles.length === 0 || detail.roles.some((role) => role.kind === "unattributed"))) {
          excludedRunCount += 1;
          continue;
        }
        scopedRuns.push(detail);
        if (harness !== null
          && (harness === HARNESS_UNKNOWN_FILTER ? detail.harnessRevision !== null : detail.harnessRevision !== harness)) {
          continue;
        }
        contributed = true;
        const built = buildConfigSignature(
          detail.roles.map((role) => ({ kind: role.kind, models: role.models, efforts: role.efforts })),
        );
        // 묶음 키는 표시용 서명 문자열이 아니라 구조 identity다. 혼합 run은 단일 run과 합쳐지지 않는다.
        const key = groupBy === "harness"
          ? JSON.stringify([built.identity, detail.harnessRevision])
          : built.identity;
        const existing = grouped.get(key);
        if (existing) {
          existing.runs.push(detail);
        } else {
          grouped.set(key, { signature: detail.configSignature, roles: built.roles, runs: [detail] });
        }
      }
      if (contributed) sessionCount += 1;
    }

    const configs: ExperimentConfig[] = [...grouped.values()].map((group) => {
      const runs = group.runs;
      const wallClocks = runs.map((run) => run.wallClockMs);
      const busies = runs.map((run) => run.busyMs);
      const tokens = runs.map((run) => run.totalTokens);
      const costs = runs.map((run) => run.estimatedCostUsd);
      const starts = runs.map((run) => run.startedAt);
      return {
        signature: group.signature,
        roles: group.roles,
        runCount: runs.length,
        medianWallClockMs: median(wallClocks),
        medianBusyMs: median(busies),
        medianTotalTokens: median(tokens),
        medianEstimatedCostUsd: median(costs),
        totalEstimatedCostUsd: costs.reduce((sum, value) => sum + value, 0),
        unpricedRuns: runs.filter((run) => run.unpricedRequests > 0).length,
        untimedRuns: runs.filter((run) => run.roles.some((role) => role.untimedRequests > 0)).length,
        reworkRuns: runs.filter((run) => run.roles.some((role) => role.purpose === "rework")).length,
        errorRuns: runs.filter((run) => run.outcome === "error").length,
        childRunsAvg: runs.reduce((sum, run) => sum + run.childCount, 0) / runs.length,
        firstSeenAt: Math.min(...starts),
        lastSeenAt: Math.max(...starts),
        harnesses: countHarnesses(runs),
      };
    });
    if (groupBy === "harness") {
      // 같은 구성의 하네스별 묶음을 나란히 둔다. 구성 순서는 기본 보기와 같은 규칙(run 수, 최근 사용)이고
      // 그 안에서는 최근 하네스가 먼저 온다.
      const bySignature = new Map<string, { runCount: number; lastSeenAt: number }>();
      for (const config of configs) {
        const total = bySignature.get(config.signature) ?? { runCount: 0, lastSeenAt: config.lastSeenAt };
        total.runCount += config.runCount;
        total.lastSeenAt = Math.max(total.lastSeenAt, config.lastSeenAt);
        bySignature.set(config.signature, total);
      }
      configs.sort((a, b) => {
        const left = bySignature.get(a.signature) ?? { runCount: a.runCount, lastSeenAt: a.lastSeenAt };
        const right = bySignature.get(b.signature) ?? { runCount: b.runCount, lastSeenAt: b.lastSeenAt };
        return right.runCount - left.runCount
          || right.lastSeenAt - left.lastSeenAt
          || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0)
          || b.lastSeenAt - a.lastSeenAt;
      });
    } else {
      configs.sort((a, b) => b.runCount - a.runCount || b.lastSeenAt - a.lastSeenAt);
    }

    const allRuns = [...grouped.values()].flatMap((group) => group.runs);
    return {
      folder,
      folders,
      scope,
      configs,
      runCount: allRuns.length,
      sessionCount,
      excludedRunCount,
      groupBy,
      harness,
      harnesses: countHarnesses(scopedRuns),
      unmeasured: unionUnmeasured(allRuns),
    };
  } finally {
    db.close();
  }
}
