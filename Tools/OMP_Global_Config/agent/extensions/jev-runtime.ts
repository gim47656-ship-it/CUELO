
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { registerMakerRouting } from "./lib/maker-routing";
import { clearPreparedTaskSession } from "./lib/prepared-task";
import { createRoutingLedger, DEFAULT_LEDGER_PATH, scopedAttempts, type AttemptIdentity, type OutcomeRecord, type VerdictRecord } from "./lib/routing-ledger";
import {
  advanceTodoProgressState,
  assessTodoProgress,
  captureTodoBindings,
  createTodoProgressState,
  readPersistedTodoProgress,
  readTaskProgressMetadata,
  readTerminalValidation,
  readTodoSnapshot,
  type BoundTodoSnapshotItem,
  type TaskProgressMetadata,
  type TerminalValidationItem,
  type TodoProgressAssessment,
  type TodoProgressState,
} from "./lib/task-progress";

/**
 * Jev 실행 경계. 발주 전에는 maker_route가 사실 요약을 한 번 판정하고
 * Main이 결과를 읽은 뒤 선택한 selector를 task에 전달한다. task hook은
 * 준비된 판단의 유효성만 확인하며 모델 선택·spawn·추가 Jev 호출을 하지 않는다.
 * 재시도와 결과 수신의 기존 advisory는 의미를 관측할 수 없는 항목을 명시한다.
 * 권한·TaskBudget·최종 수용은 기존 owner와 guard가 그대로 책임진다.
 */

// ---------------------------------------------------------------------------
// 최소 타입 — runtime 값은 지연 import로 해석하고, 타입은 로컬에 둔다.
// ---------------------------------------------------------------------------

interface JudgeQuestionBool {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

interface JudgeQuestionChoice {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

type JudgeQuestion = JudgeQuestionBool | JudgeQuestionChoice;

type JudgeAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

interface JudgeLike {
  readonly label: string;
  judge(
    request: { state: unknown; questions: Record<string, JudgeQuestion> },
    options?: { signal?: AbortSignal },
  ): Promise<{ answers: Record<string, JudgeAnswer>; provider: string; model: string }>;
}

interface JudgeSettingsLike {
  getModelRoles(): Readonly<Record<string, string>>;
}

interface JudgeDepsLike {
  settings: JudgeSettingsLike;
  registry: unknown;
  backend: string;
  sessionModel?: unknown;
  sessionId?: string;
}

type ResolveJudgeFn = (deps: JudgeDepsLike) => JudgeLike;
type FindScopedSettingsFn = (cwd?: string) => JudgeSettingsLike | undefined;

/** 테스트가 실제 SDK 없이 judge를 주입할 수 있게 하는 seam. */
export interface JevRuntimeDeps {
  resolveJudge?: ResolveJudgeFn;
  findScopedSettings?: FindScopedSettingsFn;
  /** 발주 이력 JSON Lines 경로. 테스트는 임시 경로를 주입한다. 기본은 실행 프로필 agent 루트다. */
  ledgerPath?: string;
}

// ---------------------------------------------------------------------------
// 정본 설정 키 — 값은 Settings에서 읽고 상수로 복제하지 않는다.
// ---------------------------------------------------------------------------

/** resolveJudge의 backend 계약값. SDK의 ONLINE_MEMORY_MODEL_KEY("online")와 동일하다. */
const ONLINE_JUDGE_BACKEND = "online";
const ADVISORY_CUSTOM_TYPE = "jev-runtime-advisory";



// ---------------------------------------------------------------------------
// TASK_GUARD 메타데이터 추출 — 본문은 judge에 보내지 않고 필드만 읽는다.
// ---------------------------------------------------------------------------

interface TaskGuardMeta {
  workClass?: string;
  purpose?: string;
  /** Main이 적은 1줄 완료물 — duplicate/effort 판정의 최소 의미 근거. */
  primaryDeliverable?: string;
  /** 소유 경로 목록 — 종류와 개수가 중복 판정의 관측 근거다. */
  ownedPaths: string[];
  hasFindingId: boolean;
  hasExplicitCheck: boolean;
  progress: TaskProgressMetadata;
}

function readGuardField(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "im"));
  const value = match?.[1]?.trim();
  return value || undefined;
}

function extractTaskGuardMeta(task: string): TaskGuardMeta {
  const marker = /^\s*TASK_GUARD\s*:\s*$/im.exec(task);
  const progress = readTaskProgressMetadata(task);
  const meta: TaskGuardMeta = {
    ownedPaths: [],
    hasFindingId: false,
    hasExplicitCheck: false,
    progress,
  };
  if (marker) {
    const tailStart = marker.index + marker[0].length;
    const tail = task.slice(tailStart);
    const separator = /\r?\n\s*\r?\n/.exec(tail);
    const blockEnd = separator ? tailStart + separator.index : task.length;
    const block = task.slice(tailStart, blockEnd);
    const workClass = readGuardField(block, "WORK_CLASS");
    const purpose = readGuardField(block, "PURPOSE");
    if (workClass) meta.workClass = workClass.toLowerCase();
    if (purpose) meta.purpose = purpose.toLowerCase();
    const primaryDeliverable = readGuardField(block, "PRIMARY_DELIVERABLE");
    if (primaryDeliverable) meta.primaryDeliverable = primaryDeliverable;
    const ownedPaths = readGuardField(block, "OWNED_PATHS");
    if (ownedPaths) {
      meta.ownedPaths = ownedPaths
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
    meta.hasFindingId = readGuardField(block, "FINDING_ID") !== undefined;
  }
  // 명시 검증 명령 플래그: brief 본문의 검사 지시 존재 여부만 본다.
  meta.hasExplicitCheck = /^\s*(검사\s*명령|CHECK(?:\s+COMMAND)?)\s*:/im.test(task);
  return meta;
}

interface SpawnedTaskMeta {
  /** tasks[] 배열 위치 — tool_result progress row의 index와 대응한다. */
  index: number;
  name?: string;
  agent?: string;
  guard: TaskGuardMeta;
  /** Spawn 시점의 exact TodoTracker incarnation. 늦은 결과는 이 identity로 구별한다. */
  todoBindings: ReadonlyMap<string, number>;
  /** Spawn 시점에 캡처한 발주 identity. settle outcome은 name 조회가 아니라 이 값으로 잇는다. */
  identity?: AttemptIdentity;
  /** spawn progress row의 canonical child id(= agent:// target). */
  agentId?: string;
  /** 그 spawn이 등록된 async jobId. details가 단일 spawn의 jobId를 줄 때만 채운다. */
  jobId?: string;
}

function extractSpawnedTasks(
  input: Record<string, unknown>,
  currentTodos: readonly BoundTodoSnapshotItem[],
): SpawnedTaskMeta[] {
  const items: unknown[] = Array.isArray(input.tasks)
    ? input.tasks
    : typeof input.task === "string"
      ? [input]
      : [];
  const tasks: SpawnedTaskMeta[] = [];
  for (const [index, raw] of items.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const taskText = typeof item.task === "string" ? item.task : "";
    const guard = extractTaskGuardMeta(taskText);
    tasks.push({
      index,
      ...(typeof item.name === "string" && item.name.trim() ? { name: item.name.trim() } : {}),
      ...(typeof item.agent === "string" && item.agent.trim()
        ? { agent: item.agent.trim().toLowerCase() }
        : {}),
      // 현재/이전 effort는 블라인드 판정을 깨므로 state에 싣지 않는다.
      guard,
      todoBindings: captureTodoBindings(guard.progress, currentTodos),
    });
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// 재시도 입력 비교 — 내용은 judge에 보내지 않고 로컬 직렬화 동일성만 본다.
// ---------------------------------------------------------------------------

function serializeInput(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 오류 카테고리 — toolResult 원문은 보내지 않고 분류 라벨만 만든다.
// ---------------------------------------------------------------------------

const ERROR_CATEGORY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ENOENT|no such file|cannot find|not found|존재하지 않/iu, "missing-path"],
  [/EACCES|EPERM|permission denied|access is denied|권한/iu, "permission"],
  [/401|403|unauthorized|forbidden|invalid[_ ]?grant|api[_ ]?key|authentication|인증/iu, "auth"],
  [/command (?:aborted|cancelled)|작업 취소|명령 취소/iu, "cancelled"],
  [/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|socket|fetch failed|timed? ?out/iu, "network"],
  [/exit code|exit status|command failed|failed with|exit1|exit 1/iu, "exit-status"],
];

function textContent(content: unknown): string {
  return Array.isArray(content)
    ? content
        .flatMap((part) =>
          part && typeof part === "object" && "type" in part && part.type === "text" &&
          "text" in part && typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("\n")
    : typeof content === "string"
      ? content
      : "";
}

function classifyError(content: unknown): string {
  const text = textContent(content);
  for (const [pattern, category] of ERROR_CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return "other";
}

interface FailureObservation {
  deterministicExitObserved: boolean;
  executionObservationPresent: boolean;
  cancelled: boolean;
  timedOut: boolean;
}

function readFailureObservation(details: unknown, content: unknown): FailureObservation {
  const record = details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
  const text = textContent(content);
  return {
    deterministicExitObserved: typeof record.exitCode === "number",
    executionObservationPresent: typeof record.executionObservation === "string",
    cancelled: /command (?:aborted|cancelled)|작업 취소|명령 취소/iu.test(text),
    timedOut: record.timedOut === true,
  };
}

// ---------------------------------------------------------------------------
// settled task job 추출 — async-result와 `wait`·`read proc://`의 details jobs[] 공통.
// ---------------------------------------------------------------------------


interface SettledJobMeta {
  jobId: string;
  /** canonical child id(= agent:// target). settled job이 싣지 않으면 undefined이며 추측으로 채우지 않는다. */
  agentId?: string;
  label?: string;
  durationMs?: number;
  /** async job 상태(completed|failed|cancelled). */
  status?: string;
  schemaStatus?: string;
  hasData: boolean;
  /** data.validation 맵에서 state가 unverified/pending 계열인 항목 수. */
  unverifiedCount?: number;
  /** data.unresolved 배열 길이. */
  unresolvedCount?: number;
  hasError: boolean;
  terminalRevision?: string;
  validation: Record<string, TerminalValidationItem>;
}

interface TerminalReportMeta {
  revision?: string;
  validation: Record<string, TerminalValidationItem>;
}
interface ReviewStructuralReport {
  jobId: string;
  evidenceLocators: string[];
  schemaStatus: string | null;
  hasData: boolean;
  unverifiedCount: number | null;
  unresolvedCount: number | null;
  hasError: boolean;
  terminalRevisionPresent: boolean;
  todoCoverageObserved: boolean;
  todoMetadataValid: boolean | null;
  todoTaskTitleValid: boolean | null;
  todoExpectedCount: number | null;
  todoCurrentMissingCount: number | null;
  todoDuplicateCurrentCount: number | null;
  todoStaleBindingCount: number | null;
  todoUnboundBindingCount: number | null;
  todoValidationCoveredCount: number | null;
  todoValidationMetCount: number | null;
  todoValidationEvidenceMissingCount: number | null;
  todoValidationWaitingCount: number | null;
  todoReadyForMainAcceptanceCount: number | null;
  todoMainAcceptedCount: number | null;
  todoUnattributedCompletedCount: number | null;
  todoPartialCompletion: boolean | null;
  todoReworkLinked: boolean | null;
}

interface StructuralCountObservation {
  locator: string;
  value: number | null;
}


function readTerminalReport(data: unknown, resultText: string): TerminalReportMeta {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    return {
      ...(typeof record.revision === "string" && record.revision.trim()
        ? { revision: record.revision.trim() }
        : {}),
      validation: readTerminalValidation(record),
    };
  }
  const envelope =
    /<output>\s*([\s\S]*?)\s*<\/output>/i.exec(resultText)?.[1] ??
    /<preview\b[^>]*>\s*([\s\S]*?)\s*<\/preview>/i.exec(resultText)?.[1] ??
    resultText;
  const trimmed = envelope.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        ...(typeof record.revision === "string" && record.revision.trim()
          ? { revision: record.revision.trim() }
          : {}),
        validation: readTerminalValidation(record),
      };
    }
  } catch {
    // 5KB 초과 task preview는 JSON 뒷부분이 잘릴 수 있다. 완결된 revision만 복구한다.
  }
  const revisionMatch = /"revision"\s*:\s*("(?:\\.|[^"\\])*")/.exec(trimmed);
  let revision: string | undefined;
  if (revisionMatch?.[1]) {
    try {
      const parsed = JSON.parse(revisionMatch[1]);
      if (typeof parsed === "string" && parsed.trim()) revision = parsed.trim();
    } catch {
      // 잘린 JSON string은 revision 증거로 쓰지 않는다.
    }
  }
  return {
    ...(revision ? { revision } : {}),
    validation: {},
  };
}

function readSettledTaskJobs(details: unknown, content?: unknown): SettledJobMeta[] {
  const jobs = (details as { jobs?: unknown } | undefined)?.jobs;
  if (!Array.isArray(jobs)) return [];
  const resultBlocks = [...textContent(content).matchAll(/<task-result\b[\s\S]*?<\/task-result>/gi)]
    .map((match) => match[0]);
  const settled: SettledJobMeta[] = [];
  let resultBlockIndex = 0;
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const record = job as Record<string, unknown>;
    if (record.type !== undefined && record.type !== "task") continue;
    if (record.status === "running" || record.status === "pending") continue;
    const jobId =
      typeof record.jobId === "string"
        ? record.jobId
        : typeof record.id === "string"
          ? record.id
          : undefined;
    if (!jobId) continue;
    const schema = (record.schema ?? record.structured) as Record<string, unknown> | undefined;
    const data = schema?.data;
    const resultText =
      typeof record.resultText === "string"
        ? record.resultText
        : resultBlocks[resultBlockIndex] ?? (jobs.length === 1 ? textContent(content) : "");
    resultBlockIndex += 1;
    const terminal = readTerminalReport(data, resultText);
    const meta: SettledJobMeta = {
      jobId,
      ...(typeof record.agentId === "string" && record.agentId ? { agentId: record.agentId } : {}),
      ...(typeof record.label === "string" ? { label: record.label } : {}),
      ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
      ...(typeof record.status === "string" ? { status: record.status } : {}),
      ...(typeof schema?.status === "string" ? { schemaStatus: schema.status } : {}),
      hasData: data !== undefined,
      hasError: typeof schema?.error === "string" || record.status === "failed",
      ...(terminal.revision ? { terminalRevision: terminal.revision } : {}),
      validation: terminal.validation,
    };
    const validationEntries = Object.values(terminal.validation);
    if (validationEntries.length > 0) {
      meta.unverifiedCount = validationEntries.filter(
        (entry) => entry.state !== "met" || !entry.evidencePresent,
      ).length;
    }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const unresolved = (data as Record<string, unknown>).unresolved;
      if (Array.isArray(unresolved)) meta.unresolvedCount = unresolved.length;
    }
    settled.push(meta);
  }
  return settled;
}
function renderStructuralCount(
  label: string,
  observations: StructuralCountObservation[],
): string {
  if (observations.length === 0) return `${label}=해당 없음`;
  const observed = observations.filter((entry) => entry.value !== null);
  const unobserved = observations.filter((entry) => entry.value === null);
  if (observed.length === 0) {
    return `${label}=미관측(${unobserved.length}건:${unobserved.map((entry) => entry.locator).join(",")})`;
  }
  const total = observed.reduce((sum, entry) => sum + (entry.value ?? 0), 0);
  const unobservedSuffix = unobserved.length > 0
    ? `+미관측(${unobserved.length}건:${unobserved.map((entry) => entry.locator).join(",")})`
    : "";
  return `${label}=${total}${unobservedSuffix}`;
}

function summarizeStructuralReports(reports: ReviewStructuralReport[]) {
  return {
    details: reports.map((report) => {
      let normalCount = 0;
      const problem: Record<string, unknown> = {};
      const unobserved: string[] = [];
      const recordCount = (key: string, value: number | null, positiveIsProblem: boolean): void => {
        if (value === null) {
          unobserved.push(key);
        } else if (positiveIsProblem && value > 0) {
          problem[key] = value;
        } else {
          normalCount += 1;
        }
      };

      if (report.schemaStatus === null) unobserved.push("schemaStatus");
      else if (report.schemaStatus === "valid") normalCount += 1;
      else problem.schemaStatus = report.schemaStatus;
      if (report.hasData) normalCount += 1;
      else problem.hasData = false;
      if (report.hasError) problem.hasError = true;
      else normalCount += 1;
      if (report.terminalRevisionPresent) normalCount += 1;
      else problem.terminalRevisionPresent = false;
      recordCount("unverifiedCount", report.unverifiedCount, true);
      recordCount("unresolvedCount", report.unresolvedCount, true);
      normalCount += 1;

      if (report.todoCoverageObserved) {
        if (report.todoMetadataValid === null) unobserved.push("todoMetadataValid");
        else if (report.todoMetadataValid) normalCount += 1;
        else problem.todoMetadataValid = false;
        if (report.todoTaskTitleValid === null) unobserved.push("todoTaskTitleValid");
        else if (report.todoTaskTitleValid) normalCount += 1;
        else problem.todoTaskTitleValid = false;
        const todoIssueCountKeys = [
          "todoCurrentMissingCount",
          "todoDuplicateCurrentCount",
          "todoStaleBindingCount",
          "todoUnboundBindingCount",
          "todoValidationEvidenceMissingCount",
          "todoValidationWaitingCount",
          "todoUnattributedCompletedCount",
        ] as const;
        for (const key of todoIssueCountKeys) recordCount(key, report[key], true);
        const todoInformationalCountKeys = [
          "todoExpectedCount",
          "todoValidationCoveredCount",
          "todoValidationMetCount",
          "todoReadyForMainAcceptanceCount",
          "todoMainAcceptedCount",
        ] as const;
        for (const key of todoInformationalCountKeys) recordCount(key, report[key], false);
        if (report.todoPartialCompletion === null) unobserved.push("todoPartialCompletion");
        else if (report.todoPartialCompletion) problem.todoPartialCompletion = true;
        else normalCount += 1;
        if (report.todoReworkLinked === null) unobserved.push("todoReworkLinked");
        else normalCount += 1;
      }

      return {
        locator: report.jobId,
        normalCount,
        problem,
        unobserved,
        evidenceLocators: report.evidenceLocators,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// advisory 렌더링
// ---------------------------------------------------------------------------

function formatAnswer(id: string, answer: JudgeAnswer | undefined): string {
  if (!answer) return `${id}=?`;
  if (answer.type === "noul") return `${id}=${answer.noul >= 0.5 ? "true" : "false"}(${answer.noul.toFixed(2)})`;
  if (answer.type === "choice") return `${id}=${answer.choice}(${answer.confidence.toFixed(2)})`;
  return `${id}=${answer.score.toFixed(2)}`;
}

function renderAdvisory(
  placement: string,
  answers: Record<string, JudgeAnswer> | undefined,
  unobservable: readonly string[],
  note: string,
): string {
  const lines = [`[JevRuntime:${placement}] ${note}`];
  if (answers) {
    const rendered = Object.keys(answers).map((id) => formatAnswer(id, answers[id]));
    lines.push(`판정: ${rendered.join(" ") || "없음"}`);
  }
  if (unobservable.length > 0) {
    lines.push(`관측 불가(판정 생략): ${unobservable.join(", ")}`);
  }
  lines.push(
    "이 advisory는 참고용이다. 권한·TaskBudget·최종 수용·guard를 대체하지 않으며, " +
      "모델이 이 메시지를 읽는 시점은 다음 continuation이다.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 미회신 조향 체크포인트 — known maker의 편집 전 체크포인트(`wait` 결과 details.waited 또는
// `irc:incoming` 주입)를 받은 뒤 Main이 그 Maker에게 `write agent://<id>`로 답하지 않은 채 다시
// wait하면 알린다. Maker는 답이 올 때까지 트리거 편집만 보류하고 독립 작업을 계속한다.
// 18.3.0 `write agent://`는 replyTo를 싣지 못하므로 수신 뒤 같은 Maker로 가는 첫 DM을 답으로 본다.
// 2026-09-24 실측: 대규모 위임에서 미회신 체크포인트 2통이 Maker를 합계 510초 멈췄다.
// ---------------------------------------------------------------------------

const CHECKPOINT_LOCATION = /(?:^|\n)\s*(?:위치|LOCATION)\s*:/;
const CHECKPOINT_INVARIANTS = /(?:^|\n)\s*(?:불변식|INVARIANTS)\s*:/;
const AGENT_URL = /^agent:\/\/([^/?#]+)$/;
const PROC_KILL_URL = /^proc:\/\/([^/?#]+)\/kill$/;

/**
 * IRC 메시지 레코드(`wait` details.waited는 body, `irc:incoming` details는 message)가 체크포인트
 * 형식이면 {id, from}을 돌려준다. wake relay는 Maker의 DM이 아니라 제외한다.
 */
function readIncomingCheckpoint(record: unknown): { id: string; from: string } | undefined {
  if (!record || typeof record !== "object") return undefined;
  const { id, from, body, message, wakeRelay } = record as Record<string, unknown>;
  if (wakeRelay === true || typeof id !== "string" || typeof from !== "string") return undefined;
  const text = typeof body === "string" ? body : typeof message === "string" ? message : "";
  return CHECKPOINT_LOCATION.test(text) && CHECKPOINT_INVARIANTS.test(text) ? { id, from } : undefined;
}

/** 모양을 모르는 레코드의 한 필드. 값 검증은 호출부가 한다. */
function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

// ---------------------------------------------------------------------------
// pre-retry 대상 도구 — 탐색 도구의 실패는 일상적 probing이라 판정하지 않는다.
// ---------------------------------------------------------------------------

const EXPLORATION_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  glob: true,
  web_search: true,
};

interface OwnerMessageSummary {
  localIdentity: string;
  detail: {
    actionSignal: boolean;
    scopeSignal: boolean;
    acceptanceSignal: boolean;
    hasTaskGuard: boolean;
    ownerPathCount: number;
    mentionedPathCount: number;
    ownedPathOverlap: boolean;
    excludedSensitiveDetail: boolean;
  };
  shouldAdvise: boolean;
}

function summarizeOwnerMessage(message: string, answersCheckpoint: boolean, owner: SpawnedTaskMeta): OwnerMessageSummary {
  const hasCodeFence = /```[\s\S]*?```/.test(message) || /`[^`\r\n]+`/.test(message);
  const hasQuote = /^\s*>/m.test(message);
  const hasSecretCandidate = /(?:api[_-]?key|access[_-]?token|authorization|bearer|password|secret)\s*[:=]\s*\S+/i.test(message);
  const pathMatches = message.match(/(?:[A-Za-z]:[\\/]|(?:^|\s)(?:\.{0,2}[\\/]))[^\s"'`]+|(?:^|\s)[\w.-]+(?:[\\/][\w.@() -]+)+/gm) ?? [];
  const ownerPaths = owner.guard.ownedPaths.map((path) => path.replace(/\\/g, "/").toLowerCase());
  const ownedPathOverlap = pathMatches.some((candidate) => {
    const normalized = candidate.trim().replace(/\\/g, "/").toLowerCase();
    return ownerPaths.some((path) => normalized.includes(path) || path.includes(normalized));
  });
  const scrubbed = message
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\r\n]+`/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/(?:api[_-]?key|access[_-]?token|authorization|bearer|password|secret)\s*[:=]\s*\S+/gi, " ")
    .replace(/(?:[A-Za-z]:[\\/]|(?:^|\s)(?:\.{0,2}[\\/]))[^\s"'`]+|(?:^|\s)[\w.-]+(?:[\\/][\w.@() -]+)+/gm, " ");
  const normalized = scrubbed
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  // judge에는 싣지 않는 session-local dedupe 값이다. 경로·코드가 다른 업무를 합치지 않되
  // 대소문자·공백 차이만 정규화한다.
  const localIdentity = message.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const actionSignal = /(?:추가(?:해|하|해줘|하세요)|고쳐|수정(?:해|하|하세요)|구현(?:해|하|하세요)|조사(?:해|하|하세요)|검증(?:해|하|하세요)|테스트(?:해|하|하세요)|바꿔|변경(?:해|하|하세요)|확장(?:해|하|하세요)|제거(?:해|하|하세요)|재작업|다시\s*(?:해|하|고쳐)|\b(?:add|fix|change|implement|investigate|verify|test|expand|remove|rework|retarget)\b)/iu.test(normalized);
  const scopeSignal = /(?:새\s*(?:과제|작업|범위)|범위\s*(?:확대|변경|추가)|목적\s*(?:변경|추가)|다른\s*(?:파일|모듈|경로)|\b(?:new task|new work|scope change|scope expansion|additional scope)\b)/iu.test(normalized);
  const acceptanceSignal = /(?:완료\s*조건|수용\s*조건|합격\s*기준|인수\s*조건|검사\s*기준|\b(?:acceptance|done criteria|completion criteria)\b)/iu.test(normalized);
  const statusSignal = /(?:상태|진행|결과|끝났|완료됐|어디까지|문제\s*있|막혔|\b(?:status|progress|result|done|blocked)\b)/iu.test(normalized);
  const approvalSignal = /^(?:승인(?:함)?|좋아|확인|그대로\s*진행|approved?|ok(?:ay)?|lgtm)(?:\s|$)/iu.test(normalized);
  const questionSignal = /[?？]\s*$/.test(scrubbed) || /(?:인가|했어|됐어|있어|어때|알려\s*줘)\s*[.!]?\s*$/u.test(normalized);
  const hasTaskGuard = /^\s*TASK_GUARD\s*:\s*$/im.test(message);
  const clearStatusOrApproval = !actionSignal && !scopeSignal && !acceptanceSignal
    && (approvalSignal || (statusSignal && (questionSignal || answersCheckpoint)));
  const shouldAdvise = !clearStatusOrApproval
    && (actionSignal || scopeSignal || acceptanceSignal || hasTaskGuard || (!questionSignal && normalized.length > 0));
  return {
    localIdentity,
    shouldAdvise,
    detail: {
      actionSignal,
      scopeSignal,
      acceptanceSignal,
      hasTaskGuard,
      ownerPathCount: owner.guard.ownedPaths.length,
      mentionedPathCount: pathMatches.length,
      ownedPathOverlap,
      excludedSensitiveDetail: hasCodeFence || hasQuote || pathMatches.length > 0 || hasSecretCandidate,
    },
  };
}

function renderTodoProgressAdvice(assessment: TodoProgressAssessment): string {
  if (!assessment.metadataValid) {
    return "TODO 메타데이터 형식 오류(자동 변경 없음): TASK_GUARD 밖에 TASK_TITLE 한 줄과 비어 있지 않은 TODO_TASKS exact JSON 문자열 배열을 각각 하나만 둔다.";
  }
  if (assessment.expectedCount === 0) return "";
  const lines = [
    "TODO 연결(자동 변경 없음): child completed는 Main 수용이 아니다. 이 Main 세션의 성공한 exact `todo` `done` tool_result만 수용으로 관측한다.",
  ];
  if (!assessment.revisionPresent) {
    lines.push("- frozen revision이 없어 완료 후보를 만들지 않는다. owner에게 revision이 연결된 terminal validation을 요청한다.");
  }
  for (const item of assessment.items) {
    const task = JSON.stringify(item.content);
    if (item.bindingStatus !== "current") {
      const reason = item.bindingStatus === "stale"
        ? "spawn 당시 todo identity와 현재 정본이 다르다"
        : "spawn 당시 exact todo identity가 없었다";
      lines.push(`- ${task}: ${reason}. 사용자 삭제·계획 교체·재개를 되돌리거나 항목을 자동 추가하지 않고 늦은 child 결과로 둔다.`);
      continue;
    }
    if (item.exactCurrentMatches > 1) {
      lines.push(`- ${task}: 현재 todo 정본에 exact 항목이 중복됐다. Main이 한 항목으로 정리하기 전 상태를 바꾸지 않는다.`);
      continue;
    }
    if (item.mainAccepted) {
      lines.push(`- ${task}: Main의 explicit todo done 수용과 completed 정본을 모두 관측했다.`);
    } else if (item.currentStatus === "completed") {
      lines.push(`- ${task}: completed 정본은 있으나 이 Main 세션의 explicit todo done receipt가 없다. child lifecycle이나 자연어 완료로 수용하지 않는다.`);
    } else if (item.currentStatus === "blocked" || item.currentStatus === "abandoned") {
      lines.push(`- ${task}: ${item.currentStatus} 상태는 완료 후보가 아니다. 현재 TodoTracker 상태를 유지한다.`);
    } else if (item.readyForMainAcceptance) {
      lines.push(`- ${task}: terminal 검증 근거 충족. Main 검수 수용 뒤 기존 todo 도구로 exact done을 적용한다.`);
    } else if (item.validation === "met-without-evidence") {
      lines.push(`- ${task}: state=met만 있고 항목별 raw evidence locator가 없다. 근거를 연결하기 전 완료하지 않는다.`);
    } else {
      lines.push(`- ${task}: exact terminal validation이 없거나 미검증이다. focused 결과를 회수해 같은 key에 연결한다.`);
    }
  }
  if (assessment.unattributedCompletedCount > 0) {
    lines.push("- completed 스냅샷은 있으나 이 세션의 explicit todo done receipt가 없어 자연어 '끝남'이나 child lifecycle을 Main 수용으로 추정하지 않는다.");
  }
  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// extension 본체
// ---------------------------------------------------------------------------

export function createJevRuntime(deps: JevRuntimeDeps = {}) {
  return function jevRuntime(pi: ExtensionAPI): void {
    /** toolCallId → spawn된 task 메타. pre-dispatch 중복 판정의 기존 maker 목록. */
    const liveMakers = new Map<string, SpawnedTaskMeta[]>();
    /** jobId → {callId, taskIndex}. settle 시 해당 child만 liveMakers에서 닫는다. */
    const jobIndex = new Map<string, { callId: string; taskIndex: number }>();
    /** 완료/parked 뒤에도 같은 session에서 `write agent://` 대상으로 식별할 수 있었던 maker. */
    const knownMakers = new Map<string, SpawnedTaskMeta>();
    /** 이미 판정한 경계. */
    // 발주 판정은 maker_route 한 곳에서만 수행한다.
    const judgedReviews = new Set<string>();
    /** 같은 known owner에게 같은 정규화 지시를 반복할 때 local advisory를 한 번만 만든다. */
    const advisedOwnerMessages = new Set<string>();
    /** 완료된 동일 attempt의 미기록 Main 판정은 owner 후속 지시에서 한 번만 알린다. */
    const advisedMissingVerdicts = new Set<string>();
    /** 수신했지만 그 뒤 같은 Maker에게 아직 답하지 않은 체크포인트: sender → messageId. */
    const pendingCheckpoints = new Map<string, string>();
    /** 미회신 advisory를 이미 낸 체크포인트 id. */
    const advisedCheckpoints = new Set<string>();

    function knownMakerForTarget(target: string): SpawnedTaskMeta | undefined {
      for (const owner of knownMakers.values()) {
        if (owner.agentId === target) return owner;
      }
      return knownMakers.get(target);
    }

    function noteCheckpoint(record: unknown): void {
      const checkpoint = readIncomingCheckpoint(record);
      if (checkpoint && knownMakerForTarget(checkpoint.from)) {
        pendingCheckpoints.set(checkpoint.from, checkpoint.id);
      }
    }
    /**
     * 도구별 직전 실패. 같은 도구의 다음 호출이 재시도 경계다.
     * genuine 새 입력·해당 도구 성공·경계 소비만 해당 항목을 지운다.
     */
    const pendingFailures = new Map<
      string,
      { inputSerialized: string; category: string; interveningTools: string[]; observation: FailureObservation }
    >();
    /** TASK_TITLE/TODO_TASKS consumer state: TodoTracker incarnation과 explicit Main `done` receipt. */
    let todoProgressState: TodoProgressState = createTodoProgressState();
    /** 같은 owner+frozen revision의 TODO coverage는 한 번만 판정한다. */
    const reviewedTodoRevisions = new Set<string>();
    /** running job 취소 직전의 근거 공백 advisory 중복 방지. */
    const advisedRunningCancellations = new Set<string>();

    interface ResolvedJudgeEnv {
      judge: JudgeLike;
    }

    let cachedEnv: Promise<ResolvedJudgeEnv | undefined> | undefined;
    function judgeEnvFor(ctx: ExtensionContext): Promise<ResolvedJudgeEnv | undefined> {
      if (cachedEnv) return cachedEnv;
      const sessionId = ctx.sessionManager?.getSessionId?.();
      cachedEnv = (async () => {
        try {
          // 지연 import가 필수다: bun test는 node_modules 없는 미러에서 이 파일을
          // 직접 로드하고, 실제 런타임에서는 legacy-pi shim이 @oh-my-pi/* specifier를
          // host 번들로 재작성한다. 로드 시점이 아니라 첫 판정 시점에 해석한다.
          const resolveJudge: ResolveJudgeFn =
            deps.resolveJudge ??
            ((await import("@oh-my-pi/pi-coding-agent/judgment"))
              .resolveJudge as unknown as ResolveJudgeFn);
          const settings =
            deps.findScopedSettings?.(ctx.cwd) ??
            ((
              await import("@oh-my-pi/pi-coding-agent/config/settings")
            ).findScopedSettings(ctx.cwd) as JudgeSettingsLike | undefined);
          if (!settings) return undefined;
          const judge = resolveJudge({
            settings,
            registry: ctx.modelRegistry,
            backend: ONLINE_JUDGE_BACKEND,
            sessionModel: ctx.model,
            sessionId,
          });
          return { judge };
        } catch (error) {
          pi.logger.warn("jev-runtime: judge resolution failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      })();
      return cachedEnv;
    }

    const baseLedger = createRoutingLedger(deps.ledgerPath ?? DEFAULT_LEDGER_PATH, (error) => {
      pi.logger.warn("jev-runtime: routing ledger 기록 실패(발주는 계속)", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    // spawn으로 실제 관측된 attempt. routing_verdict는 여기 있는 identity만 받는다.
    // 상태를 함께 두어 실행 중 attempt를 완료로 오인하지 않게 하고, session_start에서 원장 scoped 기록으로 복원한다.
    type ObservedAttempt = AttemptIdentity & { name: string; status: "running" | OutcomeRecord["status"] };
    const observedAttempts = new Map<string, ObservedAttempt>();
    /** outcome을 이미 기록한 attempt. 같은 attempt를 두 번 소비하지 않는다. */
    const settledAttempts = new Set<string>();
    /** settle로 이미 소비한 async jobId. 채널(via)과 무관하게 중복 소비하지 않는다. */
    const consumedJobs = new Set<string>();
    /** 명시 REWORK 전송이 성공해 열린 재개 attempt. agentId → 그 전송 직후 관측한 정확한 새 jobId와 전송 시각. */
    const resumeByAgent = new Map<string, { attemptId: string; jobId: string; sentAt: number }>();
    /** 전송별 snapshot을 보존해 같은 actor로 겹친 DM도 서로의 기준선을 덮지 않는다. */
    const preWriteJobs = new Map<string, { known: Set<string>; sentAt: number }>();
    /** 성공한 REWORK receipt. 새 job이 실제 snapshot에 나타나기 전에는 attempt를 만들지 않는다. */
    const pendingResume = new Map<string, { priorJobs: ReadonlySet<string>; sourceAttemptId: string; sentAt: number }>();
    /** 재사용 jobId로 온 재개 실행 중 이미 검수한 실행(`jobId@startTime`). 같은 실행은 채널과 무관하게 한 번만 본다. */
    const judgedResumeRuns = new Set<string>();
    const VERDICTS = ["accepted", "rework", "held"] as const;
    type VerdictInput = {
      sessionId: string; assignmentId: string; attemptId: string; verdict: string;
      reason: string; revision?: string; evidenceLocators?: string[];
    };
    /**
     * Main 명시 수용 판정 기록. advisory 원장에 한 줄 append할 뿐 gate도 LLM 호출도 아니다.
     * 잘못된 identity나 근거 부족, 저장 실패는 조용히 성공으로 넘기지 않고 오류로 돌려준다.
     */
    function recordVerdict(request: VerdictInput, ctxSessionId: string):
      | { ok: true; record: VerdictRecord }
      | { ok: false; error: string; knownAttemptIds: string[] } {
      const sessionId = request.sessionId.trim();
      const assignmentId = request.assignmentId.trim();
      const attemptId = request.attemptId.trim();
      const reason = request.reason.trim();
      const revision = (request.revision ?? "").trim();
      const evidenceLocators = (request.evidenceLocators ?? []).map((value) => value.trim()).filter(Boolean);
      if (!sessionId || !assignmentId || !attemptId) {
        return { ok: false, error: "sessionId·assignmentId·attemptId가 모두 필요합니다. maker_route 결과가 아니라 spawn advisory의 실제 triple을 쓰세요.", knownAttemptIds: [] };
      }
      // 요청 값만 믿지 않고 실제 현재 session과 대조한다.
      if (sessionId !== ctxSessionId.trim()) {
        return { ok: false, error: "요청 sessionId가 현재 session과 다릅니다. 이 session에서 관측된 attempt만 판정할 수 있습니다.", knownAttemptIds: [] };
      }
      if (!(VERDICTS as readonly string[]).includes(request.verdict)) {
        return { ok: false, error: `verdict는 accepted|rework|held 중 하나여야 합니다. 받은 값: ${request.verdict || "<없음>"}`, knownAttemptIds: [] };
      }
      const observed = observedAttempts.get(attemptId);
      if (!observed || observed.sessionId !== sessionId || observed.assignmentId !== assignmentId) {
        return {
          ok: false,
          error: "이 session에서 spawn으로 관측된 attempt가 아닙니다(stale identity이거나 아직 spawn되지 않은 prepared attempt). spawn/pre-review advisory의 실제 triple을 쓰세요.",
          knownAttemptIds: [...observedAttempts.values()].map((entry) => entry.attemptId),
        };
      }
      if (!reason) return { ok: false, error: "판정 근거 reason이 필요합니다.", knownAttemptIds: [] };
      if (request.verdict !== "held" && (!revision || evidenceLocators.length === 0)) {
        return { ok: false, error: `${request.verdict} 판정에는 비어 있지 않은 revision과 evidenceLocators 최소 1개가 필요합니다.`, knownAttemptIds: [] };
      }
      // 수용은 완료를 실제로 관측한 attempt에만 유효하다.
      if (request.verdict === "accepted" && observed.status !== "completed") {
        return { ok: false, error: `accepted는 완료가 관측된 attempt에만 쓸 수 있습니다. 현재 실행 상태: ${observed.status}`, knownAttemptIds: [] };
      }
      const record: VerdictRecord = {
        type: "verdict",
        ts: new Date().toISOString(),
        sessionId: observed.sessionId,
        assignmentId: observed.assignmentId,
        attempt: observed.attempt,
        attemptId: observed.attemptId,
        agentId: observed.agentId,
        jobId: observed.jobId,
        verdict: request.verdict as VerdictRecord["verdict"],
        revision: revision || null,
        evidenceLocators,
        reason,
      };
      if (!baseLedger.append(record)) {
        return { ok: false, error: "원장 기록에 실패했습니다(저장 오류). 판정은 남지 않았습니다.", knownAttemptIds: [] };
      }
      return { ok: true, record };
    }
    const routing = registerMakerRouting(pi, {
      ledger: baseLedger,
      owners: () => {
        const activeTasks = [...liveMakers.values()].flat();
        const activeNames = new Set(
          activeTasks.flatMap((task) => task.name ? [task.name] : []),
        );
        const owners = [...knownMakers.values()].map((task) => ({
          name: task.name ?? null,
          primaryDeliverable: task.guard.primaryDeliverable ?? null,
          ownedPaths: task.guard.ownedPaths,
          active: Boolean(task.name && activeNames.has(task.name)),
        }));
        for (const task of activeTasks) {
          if (task.name) continue;
          owners.push({
            name: null,
            primaryDeliverable: task.guard.primaryDeliverable ?? null,
            ownedPaths: task.guard.ownedPaths,
            active: true,
          });
        }
        return owners;
      },
      // legacy-pi loader가 host SDK specifier를 재작성하므로 미러의 static runtime import는 불가하다.
      settings: async (ctx) => deps.findScopedSettings?.(ctx.cwd) ??
        (await import("@oh-my-pi/pi-coding-agent/config/settings")).findScopedSettings(ctx.cwd),
      judge: async (ctx, request, signal) => {
        const env = await judgeEnvFor(ctx);
        if (!env) throw new Error("Jev를 해석하지 못했습니다. 다른 모델로 대체하지 않습니다.");
        return env.judge.judge(request as Parameters<JudgeLike["judge"]>[0], { signal });
      },
    });

    // Main 전용 명시 수용 판정 입력경로. maker_route와 같은 registerTool 경계를 쓰고 Maker tools 목록에 없으므로
    // Maker child는 이 도구를 받지 않는다. 원장에 advisory 한 줄을 남길 뿐 gate도 LLM 호출도 아니다.
    if (pi.registerTool) {
      const z = pi.zod;
      pi.registerTool({
        name: "routing_verdict", label: "Routing Verdict", loadMode: "essential", approval: "read",
        description: "Main 전용 발주 수용 판정 기록(advisory). 실행 상태와 분리해 accepted·rework·held만 남기며 gate도 LLM 호출도 아니다. identity는 spawn/pre-review advisory와 maker_route 결과의 plan이 아니라 실제 spawn triple(sessionId·assignmentId·attemptId)을 쓴다. accepted·rework는 비어 있지 않은 revision과 evidenceLocators 최소 1개, reason이 필요하고 held는 revision·evidence를 생략할 수 있다. accepted는 완료가 관측된 attempt에만 쓸 수 있다. spawn으로 관측되지 않은 attempt, stale identity, 현재 session이 아닌 identity는 기록하지 않고 오류와 알려진 attemptId 목록으로 알린다.",
        parameters: z.object({
          sessionId: z.string(),
          assignmentId: z.string(),
          attemptId: z.string(),
          verdict: z.string(),
          reason: z.string(),
          revision: z.string().optional(),
          evidenceLocators: z.array(z.string()).optional(),
        }) as never,
        async execute(_id: unknown, params: unknown, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
          const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
          const result = recordVerdict(params as VerdictInput, typeof sessionId === "string" ? sessionId : "");
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      });
    }

    function sendAdvisory(placement: string, content: string): void {
      pi.sendMessage(
        {
          customType: ADVISORY_CUSTOM_TYPE,
          content,
          display: false,
          attribution: "agent",
        },
        { deliverAs: "aside" },
      );
    }


    /** settled job의 child만 live 목록에서 닫는다. 같은 call의 sibling은 유지한다. */
    function closeSettledMakers(jobIds: readonly string[]): void {
      for (const jobId of jobIds) {
        const ref = jobIndex.get(jobId);
        if (!ref) continue;
        jobIndex.delete(jobId);
        const tasks = liveMakers.get(ref.callId);
        if (!tasks) continue;
        const remaining = tasks.filter((task) => task.index !== ref.taskIndex);
        if (remaining.length > 0) liveMakers.set(ref.callId, remaining);
        else liveMakers.delete(ref.callId);
      }
    }
    /**
     * core는 task job을 `id: agentId`로 등록하고 소비된 row를 곧 evict하므로 재개(IRC wake) 실행이 같은 jobId를 다시 받는다.
     * async-result에는 agentId도 없다. 그래서 agentId는 현재 snapshot row(id 정확 일치)에서만 읽고, 열린 REWORK receipt의
     * 전송 시각 이후 시작된 row만 재개 실행(resumeKey)으로 본다. row가 없거나(evict) 전송 전 row면 재개가 아니다.
     */
    function settledRun(job: SettledJobMeta, ctx: ExtensionContext): { agentId?: string; resumeKey?: string } {
      const snapshot = ctx.getAsyncJobSnapshot?.();
      const row = [...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])].find((entry) => entry.id === job.jobId);
      const agentId = job.agentId ?? row?.agentId;
      if (!row || !agentId || row.agentId !== agentId || typeof row.startTime !== "number") return { agentId };
      const sentAt = pendingResume.get(agentId)?.sentAt ?? resumeByAgent.get(agentId)?.sentAt;
      return sentAt !== undefined && row.startTime >= sentAt
        ? { agentId, resumeKey: `${job.jobId}@${row.startTime}` }
        : { agentId };
    }
    /** 처음 보는 jobId이거나, 재사용 jobId라도 아직 검수하지 않은 재개 실행이면 검수 대상이다. */
    function takeUnjudged(jobs: SettledJobMeta[], ctx: ExtensionContext): SettledJobMeta[] {
      return jobs.filter((job) => {
        if (!judgedReviews.has(job.jobId)) {
          judgedReviews.add(job.jobId);
          const { resumeKey } = settledRun(job, ctx);
          if (resumeKey) judgedResumeRuns.add(resumeKey);
          return true;
        }
        const { resumeKey } = settledRun(job, ctx);
        if (!resumeKey || judgedResumeRuns.has(resumeKey)) return false;
        judgedResumeRuns.add(resumeKey);
        return true;
      });
    }
    async function runPreReview(
      ctx: ExtensionContext,
      via: "async-result" | "wait" | "read proc://",
      settled: SettledJobMeta[],
      note: string,
    ): Promise<void> {
      const todoAdvice: string[] = [];
      const identityNotes: string[] = [];
      const reports: ReviewStructuralReport[] = settled.map((job) => {
        const ref = jobIndex.get(job.jobId);
        const spawned = ref
          ? liveMakers.get(ref.callId)?.find((task) => task.index === ref.taskIndex)
          : undefined;
        const todoMetadata = spawned?.guard.progress;
        // 재개 바인딩은 그 전송 직후 관측한 정확한 새 jobId에만 소비된다. 다른 job(늦은 원 실행·stale)은 소비하지 않는다.
        // 이미 소비한 jobId의 재사용은 전송 뒤 시작된 snapshot row(resumeKey)일 때만 새 실행으로 본다.
        const run = settledRun(job, ctx);
        const agentId = run.agentId;
        const newRun = !consumedJobs.has(job.jobId) || run.resumeKey !== undefined;
        const binding = agentId ? resumeByAgent.get(agentId) : undefined;
        let resumeAttemptId = binding && binding.jobId === job.jobId && newRun ? binding.attemptId : undefined;
        // 늦은 이벤트 자체를 새 실행으로 간주하지 않는다. 현재 snapshot에서 확인한 유일한 새 job만 잇는다.
        if (!resumeAttemptId && agentId && !spawned?.identity && newRun) {
          const pending = pendingResume.get(agentId);
          const source = pending ? observedAttempts.get(pending.sourceAttemptId) : undefined;
          const snapshot = pending ? ctx.getAsyncJobSnapshot?.() : undefined;
          const candidates = new Set([...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])]
            .filter((entry) => entry.agentId === agentId && (
              (typeof entry.startTime === "number" && entry.startTime >= pending!.sentAt)
              || (!pending!.priorJobs.has(entry.id) && !consumedJobs.has(entry.id))))
            .map((entry) => entry.id));
          if (pending && source && candidates.size === 1 && candidates.has(job.jobId)) {
            const attempt = source.attempt + 1;
            const identity: AttemptIdentity = {
              sessionId: source.sessionId,
              assignmentId: source.assignmentId,
              attempt,
              attemptId: `${source.assignmentId}#a${attempt}`,
              agentId,
              jobId: job.jobId,
            };
            const sourceDispatch = baseLedger.read()
              .filter((record) => record.type === "dispatch" && record.attemptId === source.attemptId)
              .at(-1);
            baseLedger.append({
              type: "dispatch",
              ts: new Date().toISOString(),
              ...identity,
              name: source.name,
              workClass: sourceDispatch?.workClass ?? null,
              focus: sourceDispatch?.focus ?? null,
              recommendedProfile: sourceDispatch?.recommendedProfile ?? null,
              recommendedModel: sourceDispatch?.recommendedModel ?? null,
              recommendedEffort: sourceDispatch?.recommendedEffort ?? null,
              chosenModel: sourceDispatch?.chosenModel ?? "",
              chosenEffort: sourceDispatch?.chosenEffort ?? "",
              routingReason: sourceDispatch?.routingReason ?? false,
              purpose: sourceDispatch?.purpose ?? null,
            });
            observedAttempts.set(identity.attemptId, { ...identity, name: source.name, status: "running" });
            pendingResume.delete(agentId);
            resumeAttemptId = identity.attemptId;
          }
        }
        // session_start에서 복원한 in-flight dispatch도 실제 jobId·agentId로 정산한다.
        const identity = resumeAttemptId ? observedAttempts.get(resumeAttemptId)
          : spawned?.identity ?? [...observedAttempts.values()].find((entry) =>
            entry.status === "running" && entry.jobId === job.jobId && entry.agentId === agentId);
        // 채널과 무관하게 이미 소비한 jobId는 다시 처리하지 않고, 같은 attempt도 한 번만 소비한다.
        if (identity && (!consumedJobs.has(job.jobId) || resumeAttemptId !== undefined) && !settledAttempts.has(identity.attemptId)
          && (spawned?.agent === undefined || spawned.agent === "maker")) {
          consumedJobs.add(job.jobId);
          settledAttempts.add(identity.attemptId);
          if (resumeAttemptId && agentId) resumeByAgent.delete(agentId);
          const status: OutcomeRecord["status"] = job.status === "cancelled" ? "cancelled" : job.hasError ? "failed" : "completed";
          baseLedger.append({
            type: "outcome",
            ts: new Date().toISOString(),
            sessionId: identity.sessionId,
            assignmentId: identity.assignmentId,
            attempt: identity.attempt,
            attemptId: identity.attemptId,
            agentId: identity.agentId,
            // durable outcome에 실제 정산 jobId를 남겨 reload 뒤에도 중복 소비를 막는다.
            jobId: job.jobId,
            status,
            durationSec: job.durationMs === undefined ? null : Math.round(job.durationMs / 1000),
          });
          const observed = observedAttempts.get(identity.attemptId);
          if (observed) observed.status = status;
          identityNotes.push(`${spawned?.name ?? observed?.name ?? job.label ?? job.jobId} ${identity.sessionId}|${identity.assignmentId}|${identity.attemptId}`);
        }
        const todoRevisionKey = spawned && job.terminalRevision
          ? `${spawned.name ?? job.jobId}:${job.terminalRevision}`
          : undefined;
        const todoCoverageObserved = Boolean(
          todoMetadata &&
          (todoMetadata.taskTitleFieldPresent || todoMetadata.todoTasksFieldPresent) &&
          (!todoRevisionKey || !reviewedTodoRevisions.has(todoRevisionKey))
        );
        if (todoCoverageObserved && todoRevisionKey) reviewedTodoRevisions.add(todoRevisionKey);
        const todoAssessment = todoCoverageObserved && todoMetadata
          ? assessTodoProgress({
              metadata: todoMetadata,
              currentTodos: todoProgressState.currentTodos,
              todoBindings: spawned?.todoBindings ?? new Map<string, number>(),
              validation: job.validation,
              acceptedTodoBindingIds: todoProgressState.acceptedTodoBindingIds,
              revision: job.terminalRevision,
              terminalError: job.hasError,
              unresolvedCount: job.unresolvedCount,
              purpose: spawned?.guard.purpose,
            })
          : undefined;
        if (todoAssessment) todoAdvice.push(renderTodoProgressAdvice(todoAssessment));
        return {
          jobId: job.jobId,
          evidenceLocators: [...new Set(
            Object.values(job.validation).flatMap((item) => item.evidenceLocators),
          )],
          schemaStatus: job.schemaStatus ?? null,
          hasData: job.hasData,
          unverifiedCount: job.unverifiedCount ?? null,
          unresolvedCount: job.unresolvedCount ?? null,
          hasError: job.hasError,
          terminalRevisionPresent: Boolean(job.terminalRevision),
          todoCoverageObserved,
          todoMetadataValid: todoAssessment?.metadataValid ?? null,
          todoTaskTitleValid: todoMetadata?.taskTitleValid ?? null,
          todoExpectedCount: todoAssessment?.expectedCount ?? null,
          todoCurrentMissingCount: todoAssessment?.currentMissingCount ?? null,
          todoDuplicateCurrentCount: todoAssessment?.duplicateCurrentCount ?? null,
          todoStaleBindingCount: todoAssessment?.staleBindingCount ?? null,
          todoUnboundBindingCount: todoAssessment?.unboundBindingCount ?? null,
          todoValidationCoveredCount: todoAssessment?.validationCoveredCount ?? null,
          todoValidationMetCount: todoAssessment?.validationMetCount ?? null,
          todoValidationEvidenceMissingCount: todoAssessment?.validationEvidenceMissingCount ?? null,
          todoValidationWaitingCount: todoAssessment?.validationWaitingCount ?? null,
          todoReadyForMainAcceptanceCount: todoAssessment?.readyForMainAcceptanceCount ?? null,
          todoMainAcceptedCount: todoAssessment?.mainAcceptedCount ?? null,
          todoUnattributedCompletedCount: todoAssessment?.unattributedCompletedCount ?? null,
          todoPartialCompletion: todoAssessment?.partialCompletion ?? null,
          todoReworkLinked: todoAssessment?.reworkLinked ?? null,
        };
      });
      const todoGapObservations = reports.flatMap((report): StructuralCountObservation[] => {
        if (!report.todoCoverageObserved) return [];
        const issueCounts = [
          report.todoCurrentMissingCount,
          report.todoDuplicateCurrentCount,
          report.todoStaleBindingCount,
          report.todoUnboundBindingCount,
          report.todoValidationEvidenceMissingCount,
          report.todoValidationWaitingCount,
          report.todoUnattributedCompletedCount,
        ];
        const value = report.todoMetadataValid === null || issueCounts.some((count) => count === null)
          ? null
          : (report.todoMetadataValid ? 0 : 1) +
            issueCounts.reduce((sum, count) => sum + (count as number), 0);
        return [{ locator: report.jobId, value }];
      });
      const todoReadyObservations = reports.flatMap((report): StructuralCountObservation[] =>
        report.todoCoverageObserved
          ? [{ locator: report.jobId, value: report.todoReadyForMainAcceptanceCount }]
          : []
      );
      const unverifiedObservations = reports.map((report) => ({
        locator: report.jobId,
        value: report.unverifiedCount,
      }));
      const unresolvedObservations = reports.map((report) => ({
        locator: report.jobId,
        value: report.unresolvedCount,
      }));
      const structuralSummary = summarizeStructuralReports(reports);
      closeSettledMakers(settled.map((job) => job.jobId));
      sendAdvisory(
        "pre-review",
        renderAdvisory(
          "pre-review",
          undefined,
          ["requirementsAndEvidenceAligned", "claimsExceedEvidence", "validationWeakened"],
          `${note} 구조 관측은 로컬에서 확정했다: via=${via}, reports=${reports.length}, ${renderStructuralCount("unverified", unverifiedObservations)}, ${renderStructuralCount("unresolved", unresolvedObservations)}, ${renderStructuralCount("TODO gap", todoGapObservations)}, ${renderStructuralCount("Main 수용 후보", todoReadyObservations)}, structuralSummary=${JSON.stringify(structuralSummary)}. 구조 count만으로 요구 의미 충족을 판정하지 않는다.${identityNotes.length > 0 ? ` route identity: ${identityNotes.join("; ")}.` : ""}${todoAdvice.length > 0 ? `\n${todoAdvice.join("\n")}` : ""} 관측 가능한 JEV 질문이 없어 호출을 생략한다.`,
        ),
      );
    }


    pi.on("session_start", (_event, ctx) => {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (typeof sessionId === "string") clearPreparedTaskSession(sessionId);
      // 이 session의 durable scoped dispatch·outcome·verdict로 관측 목록을 복원한다.
      // reload 뒤에도 held→입력→명시수용과 재개 후 수용이 이어진다. name-only 기록은 identity가 없어 빠진다.
      observedAttempts.clear();
      settledAttempts.clear();
      consumedJobs.clear();
      resumeByAgent.clear();
      preWriteJobs.clear();
      pendingResume.clear();
      for (const entry of scopedAttempts(baseLedger.read(), typeof sessionId === "string" ? sessionId : "")) {
        observedAttempts.set(entry.identity.attemptId, { ...entry.identity, name: entry.name, status: entry.status });
        if (entry.status !== "running") settledAttempts.add(entry.identity.attemptId);
      }
      // durable outcome이 남긴 jobId는 reload 뒤에도 중복 소비를 막는다.
      for (const record of baseLedger.read()) {
        if (record.type === "outcome" && record.sessionId === sessionId && record.jobId) consumedJobs.add(record.jobId);
      }
      liveMakers.clear();
      jobIndex.clear();
      knownMakers.clear();
      routing.reset();
      judgedReviews.clear();
      judgedResumeRuns.clear();
      advisedOwnerMessages.clear();
      advisedMissingVerdicts.clear();
      pendingCheckpoints.clear();
      advisedCheckpoints.clear();
      pendingFailures.clear();
      todoProgressState = readPersistedTodoProgress(ctx.sessionManager.getBranch());
      reviewedTodoRevisions.clear();
      advisedRunningCancellations.clear();
      cachedEnv = undefined;
    });

    // 새 genuine 입력은 실패 문맥과 routing의 TaskGuard 상속 lock만 끊는다.
    // 성공 판단 cache·prepared ref·known owner의 local advisory dedupe는 보존한다.
    pi.on("input", (event) => {
      if (event.source === "extension") return;
      pendingFailures.clear();
      // 수용 상태는 Main 명시 routing_verdict로만 바뀐다. 중간 입력은 verdict를 종결하지 않는다.
      if (event.source === "interactive" || event.source === "rpc") {
        routing.releaseContractLock();
      }
    });

    pi.on("message_start", async (event, ctx) => {
      const message = event.message as {
        role?: string;
        customType?: string;
        content?: unknown;
        details?: unknown;
        synthetic?: boolean;
        attribution?: string;
        steering?: boolean;
      };
      if (message.synthetic === true) return;
      // 자기 advisory는 재귀하지 않는다.
      if (message.customType === ADVISORY_CUSTOM_TYPE) return;
      // 사람의 user 메시지는 재시도 문맥을 끊는다. genuine steering은 TaskGuard와 같은
      // deliverable 상속 lock만 풀고, 성공 판단 cache와 prepared ref는 유지한다.
      if (message.role === "user") {
        if (message.attribution === "agent") return;
        pendingFailures.clear();
        if (message.steering === true) routing.releaseContractLock();
        return;
      }
      // Maker가 `write agent://Main`으로 보낸 DM은 `irc:incoming` custom 메시지로 주입된다.
      if (message.role === "custom" && message.customType === "irc:incoming") {
        noteCheckpoint(message.details);
        return;
      }
      // pre-review: async-result 자동 전달이 Main에 도착하는 가장 이른 경계.
      // async-result는 attribution:"agent"로 오므로 attribution 필터보다 먼저 본다.
      if (message.role !== "custom" || message.customType !== "async-result") return;
      const settled = takeUnjudged(readSettledTaskJobs(message.details, message.content), ctx);
      if (settled.length === 0) return;
      await runPreReview(
        ctx,
        "async-result",
        settled,
        "maker 보고가 도착했다. Main 검수 전 구조 플래그와 TODO 진행 판단이다.",
      );
    });

    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName === "task") return routing.beforeTask(event.input, ctx);

      if (event.toolName === "wait") {
        const unadvised = [...pendingCheckpoints].filter(([, id]) => !advisedCheckpoints.has(id));
        if (unadvised.length > 0) {
          for (const [, id] of unadvised) advisedCheckpoints.add(id);
          sendAdvisory(
            "pre-wait-unanswered-checkpoint",
            renderAdvisory(
              "pre-wait-unanswered-checkpoint",
              undefined,
              [],
              `미회신 편집 전 체크포인트 ${unadvised.length}건: ${unadvised.map(([from, id]) => `${from}(id=${id})`).join(", ")}. 해당 Maker는 답이 올 때까지 트리거 편집을 보류한다. 다시 기다리기 전에 각 Maker에게 write agent://<Maker>로 한 줄(approved·retarget·scope)을 답한다.`,
            ),
          );
        }
      }

      if (event.toolName === "write") {
        const input = event.input as Record<string, unknown>;
        const path = typeof input.path === "string" ? input.path.trim() : "";
        const cancelId = PROC_KILL_URL.exec(path)?.[1];
        if (cancelId) {
          const running = (ctx.getAsyncJobSnapshot?.()?.running ?? []).some((job) => job.id === cancelId);
          if (running && !advisedRunningCancellations.has(cancelId)) {
            advisedRunningCancellations.add(cancelId);
            sendAdvisory(
              "pre-retry",
              renderAdvisory(
                "pre-retry",
                undefined,
                ["sameCause", "newEvidence", "stallOrHang"],
                `running job 1건의 취소 직전 구조 event에 terminal exit·실패 결과가 없다. 취소 근거 없음: 실행 결과 회수 또는 다음 한 변수 확인. 산출물·로그·프로세스 생존 중 하나를 새로 확인한 뒤 결정한다. stdout 침묵·낮은 CPU·elapsed만으로 stall을 확정하지 않는다.`,
              ),
            );
          }
        }
        const target = AGENT_URL.exec(path)?.[1] ?? "";
        if (target && /(?:^|\n)\s*REWORK\s+task_id=\S+/i.test(String(input.content ?? ""))) {
          // 전송 전에 그 actor의 running/recent jobId를 캡처한다. 재개 새 job은 이 집합과의 차집합에서만 고른다.
          const snapshot = ctx.getAsyncJobSnapshot?.();
          const known = new Set<string>();
          for (const job of [...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])]) {
            const record = job as { id?: unknown; agentId?: unknown };
            if (typeof record.id !== "string" || !record.id) continue;
            if (record.agentId === target) known.add(record.id);
          }
          for (const entry of observedAttempts.values()) {
            if (entry.agentId === target && entry.jobId) known.add(entry.jobId);
          }
          preWriteJobs.set(event.toolCallId, { known, sentAt: Date.now() });
        }
        // canonical child id가 agent:// 대상이다. 표시용 task name으로 판정 대상을 추측하지 않는다.
        const owner = target ? knownMakerForTarget(target) : undefined;
        // 체크포인트 수신 뒤 같은 Maker로 가는 첫 DM이 그 체크포인트의 답이다. agent://all은 치지 않는다.
        const answersCheckpoint = target !== "" && pendingCheckpoints.delete(target);
        const message = typeof input.content === "string" ? input.content : "";
        const currentSessionId = ctx.sessionManager?.getSessionId?.();
        let attempt: ObservedAttempt | undefined;
        if (target && typeof currentSessionId === "string") {
          for (const entry of observedAttempts.values()) {
            if (entry.agentId === target && entry.sessionId === currentSessionId) attempt = entry;
          }
        }
        // reload 후 knownMakers의 원문 guard는 복원할 수 없어 경로 중복 구조는 알리지 않는다.
        // 다만 durable dispatch/outcome으로 확인한 canonical owner의 누락 판정은 여전히 확인할 수 있다.
        const summary = message && (owner || attempt)
          ? summarizeOwnerMessage(message, answersCheckpoint, owner ?? { guard: { ownedPaths: [] } } as SpawnedTaskMeta)
          : undefined;
        const missingVerdict = summary?.shouldAdvise && attempt?.status === "completed"
          && !advisedMissingVerdicts.has(attempt.attemptId)
          && !baseLedger.read().some((record) => record.type === "verdict"
            && record.sessionId === attempt.sessionId
            && record.assignmentId === attempt.assignmentId
            && record.attemptId === attempt.attemptId);
        const reminder = missingVerdict
          ? ` 명시 판정 미기록(읽은 원장 기준): ${attempt.sessionId}|${attempt.assignmentId}|${attempt.attemptId}. 완료 보고와 해당 수용 조건·증거를 Main이 대조한 뒤 routing_verdict로 accepted/rework/held를 직접 기록한다. 증거 보충·추가 요구만으로 rework를 추정하지 않는다.`
          : "";
        if (missingVerdict) advisedMissingVerdicts.add(attempt.attemptId);
        if (owner && summary?.shouldAdvise) {
          const dedupeKey = JSON.stringify([
            target,
            owner.guard.workClass ?? null,
            owner.guard.primaryDeliverable ?? null,
            owner.guard.ownedPaths,
            summary.localIdentity,
          ]);
          if (!advisedOwnerMessages.has(dedupeKey)) {
            advisedOwnerMessages.add(dedupeKey);
            const detail = summary.detail;
            sendAdvisory(
              "pre-dispatch-existing-owner-message",
              renderAdvisory(
                "pre-dispatch-existing-owner-message",
                undefined,
                ["requestedMeaning", "exactScopeDelta", "acceptanceSemantics", "workClass", "candidateEfforts"],
                `known owner에게 보내는 지시의 로컬 구조만 관측했다: detailLocator=tool_call:${event.toolCallId}, targetOwner=${target}, actionSignal=${detail.actionSignal}, scopeSignal=${detail.scopeSignal}, acceptanceSignal=${detail.acceptanceSignal}, hasTaskGuard=${detail.hasTaskGuard}, ownerPathCount=${detail.ownerPathCount}, mentionedPathCount=${detail.mentionedPathCount}, ownedPathOverlap=${detail.ownedPathOverlap}, excludedSensitiveDetail=${detail.excludedSensitiveDetail}. 원문 의미·정확한 범위 delta·수용 의미는 unknown이며 원문·코드·경로·secret은 advisory에 싣지 않았다. Main이 실제 지시와 원 수용 조건을 대조해 실질 목적·범위·수용 조건이 변경됐으면 기존 owner를 보존하며 변경된 사실로 maker_route를 다시 판단한다. 실제 재작업이라 판단했다면 rule://subagent 「검수와 수용」의 REWORK task_id=... role=maker previous_revision=... next_revision=... finding_id=... source=... 계약을 적용한다. 구조 문자열 일치만으로 변경을 확정하거나 unknown만으로 호출하지 않으며 별도 JEV 판단을 호출하지 않는다.${reminder}`,
              ),
            );
          } else if (missingVerdict) {
            sendAdvisory("pre-dispatch-existing-owner-message", renderAdvisory(
              "pre-dispatch-existing-owner-message", undefined, [], reminder.trim(),
            ));
          }
        } else if (missingVerdict) {
          sendAdvisory("pre-dispatch-existing-owner-message", renderAdvisory(
            "pre-dispatch-existing-owner-message", undefined, [], reminder.trim(),
          ));
        }
      }

      // pre-retry: 직전 실패 뒤 같은 도구의 다음 호출이 재시도 경계다.
      // 다른 도구 호출은 문맥을 소비하지 않는다.
      const failure = pendingFailures.get(event.toolName);
      if (!failure) return;
      pendingFailures.delete(event.toolName);
      const inputChanged = serializeInput(event.input) !== failure.inputSerialized;
      const observation = failure.observation;
      const nextAction = observation.cancelled && !observation.deterministicExitObserved
        ? "취소 근거 없음: 실행 결과 회수 또는 다음 한 변수 확인. 산출물·로그·프로세스 생존 중 하나를 새로 확인한 뒤 결정한다. stdout 침묵·낮은 CPU·elapsed만으로 stall을 확정하지 않는다."
        : "sameCause/newEvidence를 inputChanged·interveningTools로 추정하지 않는다. 실제 오류·exit를 근거로 다음 한 변수를 확인한 뒤 조치를 바꾼다.";
      sendAdvisory(
        "pre-retry",
        renderAdvisory(
          "pre-retry",
          undefined,
          ["sameCause", "newEvidence", "authOrProviderCause", "environmentOrSourceCause", "weakensValidation", "skillConflict", "skillBlocked"],
          `첫 실패 뒤 재시도 경계의 구조 관측은 로컬에서 확정했다: tool=${event.toolName}, errorCategory=${failure.category}, inputChanged=${inputChanged}, interveningTools=${failure.interveningTools.join(",") || "none"}, deterministicExitObserved=${observation.deterministicExitObserved}, executionObservationPresent=${observation.executionObservationPresent}, cancelled=${observation.cancelled}, timedOut=${observation.timedOut}. ${nextAction} errorCategory만으로 원인 의미를 재판단하지 않아 judge 호출을 생략한다.`,
        ),
      );
    });


    pi.on("tool_result", async (event, ctx) => {
      // 명시 REWORK의 write 전송이 실제로 성공했고 그 agentId의 이전 attempt가 끝났을 때만 같은 assignment의 새 재개를 연다.
      // 실행 중 attempt에 대한 DM은 그 attempt의 조향이므로 새 attempt를 만들지 않는다. 두 번째 DM도 바인딩을 덮지 않는다.
      const beforeWrite = event.toolName === "write" ? preWriteJobs.get(event.toolCallId) : undefined;
      if (event.toolName === "write") preWriteJobs.delete(event.toolCallId);
      if (event.toolName === "write" && !event.isError) {
        const input = event.input as Record<string, unknown>;
        const targetAgentId = AGENT_URL.exec(typeof input.path === "string" ? input.path.trim() : "")?.[1] ?? "";
        const message = typeof input.content === "string" ? input.content : "";
        const previous = targetAgentId
          ? [...observedAttempts.values()].filter((entry) => entry.agentId === targetAgentId).at(-1)
          : undefined;
        if (targetAgentId && previous && /(?:^|\n)\s*REWORK\s+task_id=\S+/i.test(message)
          && previous.status !== "running" && !resumeByAgent.has(targetAgentId) && !pendingResume.has(targetAgentId) && beforeWrite) {
          // 성공 receipt와 전송 전 snapshot이 있는 경우에만 실제 새 job을 바인딩한다.
          const { known: prior, sentAt } = beforeWrite;
          const snapshot = ctx.getAsyncJobSnapshot?.();
          const fresh = [...new Set([...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])]
            .flatMap((job) => {
              const record = job as { id?: unknown; agentId?: unknown; startTime?: unknown };
              if (typeof record.id !== "string" || !record.id) return [];
              // 전송 전 집합의 id라도 전송 뒤 시작된 row면 같은 id를 재사용한 새 실행이다.
              if (prior.has(record.id) && !(typeof record.startTime === "number" && record.startTime >= sentAt)) return [];
              // 관측된 canonical agentId가 정확히 같은 job만 후보다. agentId 없는 낯선 job은 승격하지 않는다.
              if (record.agentId !== targetAgentId) return [];
              return [record.id];
            }))];
          if (fresh.length === 1) {
            const attempt = previous.attempt + 1;
            const identity: AttemptIdentity = {
              sessionId: previous.sessionId,
              assignmentId: previous.assignmentId,
              attempt,
              attemptId: `${previous.assignmentId}#a${attempt}`,
              agentId: targetAgentId,
              jobId: fresh[0]!,
            };
          // 원 attempt의 dispatch metadata를 정확한 identity로 복사해 재작업 attempt가 같은 모델·effort 관측을 유지한다.
          const source = baseLedger.read()
            .filter((record) => record.type === "dispatch" && record.attemptId === previous.attemptId)
            .at(-1);
          baseLedger.append({
            type: "dispatch",
            ts: new Date().toISOString(),
            ...identity,
            name: previous.name,
            workClass: source?.workClass ?? null,
            focus: source?.focus ?? null,
            recommendedProfile: source?.recommendedProfile ?? null,
            recommendedModel: source?.recommendedModel ?? null,
            recommendedEffort: source?.recommendedEffort ?? null,
            chosenModel: source?.chosenModel ?? "",
            chosenEffort: source?.chosenEffort ?? "",
            routingReason: source?.routingReason ?? false,
            purpose: source?.purpose ?? null,
          });
          observedAttempts.set(identity.attemptId, { ...identity, name: previous.name, status: "running" });
          // 바인딩에 전송 직후 관측한 정확한 새 jobId를 둔다. 다른 job이 먼저 정산돼도 이 attempt를 소비하지 않는다.
          resumeByAgent.set(targetAgentId, { attemptId: identity.attemptId, jobId: fresh[0]!, sentAt });
          sendAdvisory(
            "rework-attempt",
            renderAdvisory(
              "rework-attempt",
              undefined,
              [],
              `REWORK write 전송 성공으로 같은 assignment의 새 attempt를 열었다: agentId=${targetAgentId} jobId=${fresh[0]!} ${identity.sessionId}|${identity.assignmentId}|${identity.attemptId}. 그 실행의 settle이 이 attempt에 연결된다.`,
            ),
          );
          } else if (fresh.length === 0) {
            // 새 job이 아직 스냅샷에 없다. 성공 receipt를 보관하고 다음 기존 관측(settle)에서 실제 새 job을 묶는다.
            pendingResume.set(targetAgentId, { priorJobs: prior, sourceAttemptId: previous.attemptId, sentAt });
          }
        }
      }

      // task 호출은 pre-dispatch 경계가 따로 있으므로 재시도 문맥을 세우지 않는다.
      if (event.toolName === "task") {
        if (event.isError) return;
        // task spawn 성공: 여기서 live maker로 등록한다. tool_call 시점에 등록하면
        // 다른 guard의 block으로 spawn이 없는데도 phantom maker가 남는다.
        // 실제 attempt identity는 이 spawn의 task 호출 id·index·session으로, canonical child id는 progress row에서 캡처한다.
        const sessionId = (ctx.sessionManager?.getSessionId?.() ?? "").trim();
        const details = event.details as { progress?: unknown; async?: { jobId?: unknown } } | undefined;
        // progress row의 index가 tasks[] 위치와 대응한다(AgentProgress.index). row.id가 canonical child id(= agent:// target)다.
        const progressAgentIds = new Map<number, string>();
        if (Array.isArray(details?.progress)) {
          for (const [position, row] of details.progress.entries()) {
            if (!row || typeof row !== "object") continue;
            const record = row as { id?: unknown; index?: unknown };
            if (typeof record.id !== "string" || !record.id) continue;
            progressAgentIds.set(typeof record.index === "number" ? record.index : position, record.id);
          }
        }
        const spawned = extractSpawnedTasks(event.input, todoProgressState.currentTodos);
        // 실제 wire: 각 spawn의 jobId는 ctx snapshot의 exact agentId 대응에서만 얻는다(없으면 미관측).
        const snapshot = ctx.getAsyncJobSnapshot?.();
        const jobByAgent = new Map<string, string>();
        for (const job of [...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])]) {
          const record = job as { id?: unknown; agentId?: unknown };
          if (typeof record.id === "string" && record.id && typeof record.agentId === "string" && record.agentId) {
            jobByAgent.set(record.agentId, record.id);
          }
        }
        // details.async.jobId는 batch primary 하나뿐이며 그 actor로 snapshot에서 확인될 때만, 단일 spawn일 때만 쓴다.
        const primaryJobId = typeof details?.async?.jobId === "string" ? details.async.jobId : "";
        const ids = new Map<number, { agentId: string; jobId: string }>();
        for (const task of spawned) {
          const agentId = progressAgentIds.get(task.index) ?? "";
          const jobId = (agentId ? jobByAgent.get(agentId) : undefined) ?? (spawned.length === 1 ? primaryJobId : "");
          ids.set(task.index, { agentId, jobId });
          // 관측된 모든 spawn jobId를 settle 연결 대상으로 등록한다(첫 child만 등록하지 않는다).
          if (jobId) jobIndex.set(jobId, { callId: event.toolCallId, taskIndex: task.index });
        }
        const dispatched = routing.noteSpawned(event.input, sessionId, event.toolCallId, ids);
        const identities: string[] = [];
        for (const task of spawned) {
          const identity = dispatched.get(task.index);
          if (!identity || !identity.sessionId) continue;
          task.identity = identity;
          if (identity.agentId) task.agentId = identity.agentId;
          if (identity.jobId) task.jobId = identity.jobId;
          observedAttempts.set(identity.attemptId, { ...identity, name: task.name ?? "", status: "running" });
          identities.push(`${task.name ?? "<unnamed>"} agentId=${identity.agentId || "<unobserved>"} jobId=${identity.jobId || "<unobserved>"} ${identity.sessionId}|${identity.assignmentId}|${identity.attemptId}`);
        }
        if (identities.length > 0) {
          sendAdvisory(
            "spawn-identity",
            renderAdvisory(
              "spawn-identity",
              undefined,
              [],
              `실제 발주 identity를 spawn에서 캡처했다: ${identities.join("; ")}. routing_verdict는 이 triple과 이 session으로만 기록하며 준비 plan 값으로는 기록하지 않는다.`,
            ),
          );
        }
        liveMakers.set(event.toolCallId, spawned);
        for (const task of spawned) {
          if (task.name && (task.agent === undefined || task.agent === "maker")) knownMakers.set(task.name, task);
        }
        return;
      }

      if (event.toolName === "todo" && !event.isError) {
        const snapshot = readTodoSnapshot(event.details);
        if (snapshot) {
          todoProgressState = advanceTodoProgressState(
            todoProgressState,
            snapshot,
            event.input,
            event.details,
          );
        }
      }

      // 실패 기록 — 탐색 도구의 실패는 일상 probing이라 재시도 판정을 세우지 않는다.
      // 다른 도구의 완료는 각 pending 실패의 interveningTools에만 남는다.
      if (event.isError) {
        if (!EXPLORATION_TOOLS[event.toolName]) {
          pendingFailures.set(event.toolName, {
            inputSerialized: serializeInput(event.input),
            category: classifyError(event.content),
            interveningTools: [],
            observation: readFailureObservation(event.details, event.content),
          });
        }
      } else if (pendingFailures.has(event.toolName)) {
        // 같은 도구의 성공은 그 도구의 실패 문맥만 닫는다.
        pendingFailures.delete(event.toolName);
      }
      // 이 호출 자체를 제외한 다른 도구의 pending 실패에 intervening으로 기록한다.
      for (const [toolName, failure] of pendingFailures) {
        if (toolName === event.toolName) continue;
        if (failure.interveningTools.length < 8 && !failure.interveningTools.includes(event.toolName)) {
          failure.interveningTools.push(event.toolName);
        }
      }

      // pre-review: `wait`·`read proc://`가 auto-delivery보다 먼저 settled 결과를 보여 준 경계.
      if (event.isError) return;
      let via: "wait" | "read proc://";
      let jobDetails: unknown;
      if (event.toolName === "wait") {
        noteCheckpoint(fieldOf(event.details, "waited"));
        via = "wait";
        jobDetails = event.details;
      } else if (event.toolName === "read" && /^proc:\/\//.test(String(fieldOf(event.input, "path") ?? ""))) {
        const proc = fieldOf(event.details, "proc");
        const job = fieldOf(proc, "job");
        via = "read proc://";
        jobDetails = job ? { jobs: [job] } : proc;
      } else {
        return;
      }
      const settled = takeUnjudged(readSettledTaskJobs(jobDetails, event.content), ctx);
      if (settled.length === 0) return;
      await runPreReview(
        ctx,
        via,
        settled,
        `${via}가 settled maker 결과를 먼저 보여 줬다. Main 검수 전 구조 플래그와 TODO 진행 판단이다.`,
      );
    });
  };
}

export default createJevRuntime();
