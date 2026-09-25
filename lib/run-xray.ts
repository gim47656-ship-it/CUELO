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
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  EXPERIMENT_DEFAULT_SESSIONS,
  EXPERIMENT_MAX_SESSIONS,
  RUN_LIST_DEFAULT_LIMIT,
  RUN_LIST_MAX_LIMIT,
  RUN_ROLE_KINDS,
  RUN_ROLE_PURPOSES,
  RUN_UNMEASURED_REASONS,
  type ExperimentConfig,
  type ExperimentConfigRole,
  type ExperimentResponse,
  type ExperimentScope,
  type RunBottleneck,
  type RunDetail,
  type RunListResponse,
  type RunOutcome,
  type RunRoleKind,
  type RunRolePurpose,
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
 * 역할별 (kind, 대표 model, 대표 effort)를 만들고 같은 조합을 `count`로 합친다.
 * 대표값은 그 역할의 첫 관측값이고, effort가 없으면 `null`이며 서명 문자열에서는
 * `?`로 쓴다. `main`은 항상 하나이므로 개수 표기를 붙이지 않고, 나머지 역할은
 * 항상 ` xN`을 붙인다.
 */
export function buildConfigSignature(
  roles: ReadonlyArray<{ kind: RunRoleKind; models: string[]; efforts: string[] }>,
): { signature: string; roles: ExperimentConfigRole[] } {
  const grouped = new Map<string, ExperimentConfigRole>();
  for (const role of roles) {
    const model = role.models[0] ?? "?";
    const effort = role.efforts[0] ?? null;
    const key = JSON.stringify([role.kind, model, effort]);
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, { kind: role.kind, model, effort, count: 1 });
    }
  }
  const sorted = [...grouped.values()].sort((a, b) => {
    const byKind = RUN_ROLE_KINDS.indexOf(a.kind) - RUN_ROLE_KINDS.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    if (a.model !== b.model) return a.model < b.model ? -1 : 1;
    const leftEffort = a.effort ?? "?";
    const rightEffort = b.effort ?? "?";
    return leftEffort === rightEffort ? 0 : leftEffort < rightEffort ? -1 : 1;
  });
  const signature = sorted
    .map((role) => `${role.kind === "main" ? "main" : `${role.kind} x${role.count}`}=${role.model}:${role.effort ?? "?"}`)
    .join("|");
  return { signature, roles: sorted };
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
}

function emptyScan(): TranscriptScan {
  return { titles: new Map(), effortTimeline: [], roleMap: new Map() };
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

function readTranscriptFile(file: string): TranscriptScan {
  const scan = emptyScan();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return scan;
  }
  const taskLines: string[] = [];
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
      } else if (line.includes('"name":"task"')) {
        taskLines.push(line);
      }
    }
  }
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
  const rows = db
    .query<{ session_file: string }, [string, string]>(
      `SELECT session_file FROM messages WHERE session_file LIKE ? ESCAPE '\\'
       UNION
       SELECT session_file FROM user_messages WHERE session_file LIKE ? ESCAPE '\\'`,
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
  const likeBase = stem.replace(/[\\%_]/g, (char) => `\\${char}`);
  const childRows = db
    .query<{ session_file: string }, [string, string]>(
      `SELECT DISTINCT session_file FROM messages
       WHERE session_file LIKE ? ESCAPE '\\' OR session_file LIKE ? ESCAPE '\\'
       ORDER BY session_file ASC`,
    )
    // 구분자 `\`도 ESCAPE 문자이므로 두 번 써야 리터럴 백슬래시가 된다.
    // `\%`로 두면 "%를 리터럴로 매칭"이 되어 자식이 하나도 잡히지 않는다.
    .all(`${likeBase}\\\\%`, `${likeBase}/%`);
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
      `SELECT session_file, entry_id, folder, model, provider, timestamp, duration,
              stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              total_tokens, cost_total, cost_unpriced, agent_type
       FROM messages WHERE session_file IN (${placeholders}) ORDER BY timestamp ASC, id ASC`,
    )
    .all(...files);
  const toolCalls = db
    .query<ToolCallRow, string[]>(
      `SELECT session_file, tool_name, timestamp, is_error
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

function buildRoleSegment(
  id: string,
  kind: RunRoleKind,
  purpose: RunRolePurpose | null,
  rows: MessageRow[],
  toolCallCount: number,
  efforts: string[],
): RunRoleSegment {
  const models: string[] = [];
  const seenModels = new Set<string>();
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
  let errorCount = 0;
  let abortedCount = 0;
  for (const row of rows) {
    const label = `${row.provider}/${row.model}`;
    if (!seenModels.has(label)) {
      seenModels.add(label);
      models.push(label);
    }
    // `duration`이 없는 요청은 0ms로 더해지므로 busyMs가 하한이 된다. 숨기지 않고 센다.
    if (row.duration === null) untimedRequests += 1;
    busyMs += row.duration ?? 0;
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
    if (unpriced) {
      unpricedRequests += 1;
    } else {
      estimatedCostUsd += row.cost_total;
    }
    if (row.stop_reason === "error" || row.stop_reason === "length") {
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
    requestCount: rows.length,
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
    errorCount,
    abortedCount,
    toolCalls: toolCallCount,
  };
}

function buildToolTotals(rows: ToolCallRow[]): RunToolTotal[] {
  const grouped = new Map<string, { calls: number; errors: number }>();
  for (const row of rows) {
    const entry = grouped.get(row.tool_name) ?? { calls: 0, errors: 0 };
    entry.calls += 1;
    if ((row.is_error ?? 0) !== 0) entry.errors += 1;
    grouped.set(row.tool_name, entry);
  }
  return [...grouped.entries()]
    .map(([toolName, totals]) => ({ toolName, calls: totals.calls, errors: totals.errors }))
    .sort((a, b) => b.calls - a.calls || (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0))
    .slice(0, 8);
}

/**
 * 세션 전체 run을 만든다. run i의 창은 `[u[i].timestamp, u[i+1].timestamp)`이며
 * 마지막 run의 끝은 관측된 요청 종료 시각과 도구 기록 시각의 최댓값이다.
 * 다음 사용자 요청까지의 창은 사용자 유휴를 포함하며 작업 완료 시간과 다르다.
 */
function buildSessionRuns(data: SessionData): RunDetail[] {
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
    const parentRows = byFile.get(data.parentFile) ?? [];
    const hasFollowingRequest = index + 1 < data.users.length;
    const settled = parentRows.length > 0
      ? outcomeFromStopReason(parentRows[parentRows.length - 1].stop_reason)
      : "running";
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
      roles,
      bottlenecks: pickBottlenecks(
        roles.map((role) => ({ id: role.id, ms: role.busyMs })),
        unmeasuredMs,
      ),
      unmeasuredMs,
      toolTotals: buildToolTotals(bucketTools),
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
    const details = buildSessionRuns(loadSessionDataByParent(db, sessionId, parentFile));
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
    const details = buildSessionRuns(loadSessionDataByParent(db, sessionId, parentFile));
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
 */
export function listExperiments(
  folder: string | null,
  sessionLimit: number = EXPERIMENT_DEFAULT_SESSIONS,
  scope: ExperimentScope = "all",
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
    const parentRows = folder
      ? db
          .query<{ session_file: string }, [string]>(
            `SELECT u.session_file AS session_file
             FROM user_messages u LEFT JOIN messages m ON m.session_file = u.session_file
             WHERE u.folder = ? GROUP BY u.session_file ORDER BY MAX(m.timestamp) DESC`,
          )
          .all(folder)
      : db
          .query<{ session_file: string }, []>(
            `SELECT u.session_file AS session_file
             FROM user_messages u LEFT JOIN messages m ON m.session_file = u.session_file
             GROUP BY u.session_file ORDER BY MAX(m.timestamp) DESC`,
          )
          .all();
    // 자식 transcript를 먼저 버리고 나서 개수를 센다. 먼저 자르면 최근 세션이
    // 자식 행에 밀려 빠진다.
    const picked = parentRows
      .map((row) => row.session_file)
      .filter((file) => PARENT_TRANSCRIPT_RE.test(file))
      .slice(0, clamped);

    const grouped = new Map<string, { roles: ExperimentConfigRole[]; runs: RunDetail[] }>();
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
      const details = buildSessionRuns(loadSessionDataByParent(db, sessionId, parentFile));
      let contributed = false;
      for (const detail of details) {
        // 역할이 없거나 확정하지 못한 run은 비교할 역할 체계가 없다. 그룹화 전에 뺀다.
        if (scope === "attributed" && (detail.roles.length === 0 || detail.roles.some((role) => role.kind === "unattributed"))) {
          excludedRunCount += 1;
          continue;
        }
        contributed = true;
        const existing = grouped.get(detail.configSignature);
        if (existing) {
          existing.runs.push(detail);
        } else {
          const built = buildConfigSignature(
            detail.roles.map((role) => ({ kind: role.kind, models: role.models, efforts: role.efforts })),
          );
          grouped.set(detail.configSignature, { roles: built.roles, runs: [detail] });
        }
      }
      if (contributed) sessionCount += 1;
    }

    const configs: ExperimentConfig[] = [...grouped.entries()].map(([signature, group]) => {
      const runs = group.runs;
      const wallClocks = runs.map((run) => run.wallClockMs);
      const busies = runs.map((run) => run.busyMs);
      const tokens = runs.map((run) => run.totalTokens);
      const costs = runs.map((run) => run.estimatedCostUsd);
      const starts = runs.map((run) => run.startedAt);
      return {
        signature,
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
      };
    });
    configs.sort((a, b) => b.runCount - a.runCount || b.lastSeenAt - a.lastSeenAt);

    const allRuns = [...grouped.values()].flatMap((group) => group.runs);
    return {
      folder,
      folders,
      scope,
      configs,
      runCount: allRuns.length,
      sessionCount,
      excludedRunCount,
      unmeasured: unionUnmeasured(allRuns),
    };
  } finally {
    db.close();
  }
}
