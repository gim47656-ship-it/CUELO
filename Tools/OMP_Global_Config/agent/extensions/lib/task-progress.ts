export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TaskProgressMetadata {
  taskTitle?: string;
  todoTasks: string[];
  taskTitleValid: boolean;
  taskTitleFieldPresent: boolean;
  todoTasksValid: boolean;
  todoTasksFieldPresent: boolean;
}

export interface TodoSnapshotItem {
  content: string;
  status: TodoStatus;
}

export interface BoundTodoSnapshotItem extends TodoSnapshotItem {
  bindingId: number;
}

export interface TodoProgressState {
  currentTodos: BoundTodoSnapshotItem[];
  acceptedTodoBindingIds: ReadonlySet<number>;
  nextBindingId: number;
}

export interface PersistedTodoProgress extends TodoProgressState {}

export interface TerminalValidationItem {
  state?: string;
  evidencePresent: boolean;
  evidenceLocators: string[];
}

export interface TodoProgressItem {
  content: string;
  currentStatus?: TodoStatus;
  bindingStatus: "current" | "stale" | "unbound";
  exactCurrentMatches: number;
  validation: "missing" | "waiting" | "met-without-evidence" | "met-with-evidence";
  mainAccepted: boolean;
  readyForMainAcceptance: boolean;
}

export interface TodoProgressAssessment {
  metadataValid: boolean;
  revisionPresent: boolean;
  expectedCount: number;
  currentExactCount: number;
  currentMissingCount: number;
  duplicateCurrentCount: number;
  staleBindingCount: number;
  unboundBindingCount: number;
  validationCoveredCount: number;
  validationMetCount: number;
  validationEvidenceMissingCount: number;
  validationWaitingCount: number;
  readyForMainAcceptanceCount: number;
  mainAcceptedCount: number;
  unattributedCompletedCount: number;
  partialCompletion: boolean;
  reworkLinked: boolean;
  items: TodoProgressItem[];
}

const GUARD_FIELD_LINE =
  /^[\t ]*(?:WORK_CLASS|PURPOSE|BLOCKS_PRIMARY|PRIMARY_DELIVERABLE|OWNED_PATHS|FINDING_ID)[\t ]*:[^\r\n]*$/i;

function withoutTaskGuardBlock(task: string): string {
  const marker = /^\s*TASK_GUARD\s*:\s*$/im.exec(task);
  if (!marker) return task;
  let cursor = marker.index + marker[0].length;
  if (task[cursor] === "\r") cursor += 1;
  if (task[cursor] === "\n") cursor += 1;
  let blockEnd = cursor;
  while (cursor < task.length) {
    const newline = task.indexOf("\n", cursor);
    const physicalEnd = newline === -1 ? task.length : newline;
    const contentEnd = physicalEnd > cursor && task[physicalEnd - 1] === "\r"
      ? physicalEnd - 1
      : physicalEnd;
    if (!GUARD_FIELD_LINE.test(task.slice(cursor, contentEnd))) break;
    blockEnd = contentEnd;
    cursor = newline === -1 ? task.length : newline + 1;
  }
  const lead = marker[0].length - marker[0].trimStart().length;
  return `${task.slice(0, marker.index + lead)}${task.slice(blockEnd)}`;
}

function oneLineFields(body: string, name: string): string[] {
  const pattern = new RegExp(`^\\s*${name}\\s*:\\s*(.*?)\\s*$`, "gim");
  return [...body.matchAll(pattern)].map((match) => match[1] ?? "");
}


/**
 * TASK_GUARD 밖의 공유 메타데이터만 읽는다. 문자열은 소비자가 exact binding에
 * 사용하므로 trim이나 유사도 정규화로 다른 TODO를 같은 항목으로 만들지 않는다.
 */
export function readTaskProgressMetadata(task: string): TaskProgressMetadata {
  const body = withoutTaskGuardBlock(task);
  const titleFields = oneLineFields(body, "TASK_TITLE");
  const todoFields = oneLineFields(body, "TODO_TASKS");
  const title = titleFields.length === 1 ? titleFields[0] : undefined;
  const taskTitleValid =
    titleFields.length === 1 &&
    Boolean(title && title === title.trim() && /[가-힣]/u.test(title));

  let todoTasks: string[] = [];
  let todoTasksValid = false;
  if (todoFields.length === 1) {
    try {
      const parsed: unknown = JSON.parse(todoFields[0]!);
      if (Array.isArray(parsed)) {
        const strings = parsed.filter((entry): entry is string => typeof entry === "string");
        const exact = strings.every((entry) => entry.length > 0 && entry === entry.trim());
        const unique = new Set(strings).size === strings.length;
        if (strings.length > 0 && strings.length === parsed.length && exact && unique) {
          todoTasks = strings;
          todoTasksValid = true;
        }
      }
    } catch {
      // 형식 오류는 빈 목록으로 추정하지 않고 validity flag로 보존한다.
    }
  }

  return {
    ...(taskTitleValid && title ? { taskTitle: title } : {}),
    todoTasks,
    taskTitleValid,
    taskTitleFieldPresent: titleFields.length > 0,
    todoTasksValid,
    todoTasksFieldPresent: todoFields.length > 0,
  };
}


const TODO_STATUSES: Record<TodoStatus, true> = {
  pending: true,
  in_progress: true,
  completed: true,
  abandoned: true,
  blocked: true,
};

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && value in TODO_STATUSES;
}

/** todo tool_result.details.phases가 현재 세션의 단일 정본 스냅샷이다. */
export function readTodoSnapshot(details: unknown): TodoSnapshotItem[] | undefined {
  if (
    !details ||
    typeof details !== "object" ||
    Array.isArray(details) ||
    !("phases" in details) ||
    !Array.isArray(details.phases)
  ) return undefined;
  const items: TodoSnapshotItem[] = [];
  for (const phase of details.phases) {
    if (!phase || typeof phase !== "object" || Array.isArray(phase) || !("tasks" in phase) || !Array.isArray(phase.tasks)) continue;
    for (const task of phase.tasks) {
      if (
        !task ||
        typeof task !== "object" ||
        Array.isArray(task) ||
        !("content" in task) ||
        !("status" in task) ||
        typeof task.content !== "string" ||
        !isTodoStatus(task.status)
      ) continue;
      items.push({ content: task.content, status: task.status });
    }
  }
  return items;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function evidenceLocators(record: object): string[] {
  const candidates = [
    "evidence" in record ? record.evidence : undefined,
    "evidenceLocator" in record ? record.evidenceLocator : undefined,
    "evidence_locator" in record ? record.evidence_locator : undefined,
    "locator" in record ? record.locator : undefined,
    "rawLog" in record ? record.rawLog : undefined,
    "raw_log" in record ? record.raw_log : undefined,
    "screenEvidence" in record ? record.screenEvidence : undefined,
    "screen_evidence" in record ? record.screen_evidence : undefined,
  ];
  const values = candidates.flatMap((candidate) =>
    Array.isArray(candidate) ? candidate : [candidate]
  );
  return [...new Set(
    values.filter(nonEmptyString).map((value) => value.trim()),
  )];
}

/** terminal data.validation에서 exact key와 구조 신호만 남긴다. */
export function readTerminalValidation(data: unknown): Record<string, TerminalValidationItem> {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !("validation" in data) ||
    !data.validation ||
    typeof data.validation !== "object" ||
    Array.isArray(data.validation)
  ) return {};
  const out: Record<string, TerminalValidationItem> = {};
  for (const [key, value] of Object.entries(data.validation)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      out[key] = { evidencePresent: false, evidenceLocators: [] };
      continue;
    }
    const locators = evidenceLocators(value);
    out[key] = {
      ...("state" in value && typeof value.state === "string" ? { state: value.state } : {}),
      evidencePresent: locators.length > 0,
      evidenceLocators: locators,
    };
  }
  return out;
}

export function readExplicitTodoDoneTasks(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const ops = "ops" in input && Array.isArray(input.ops) ? input.ops : [input];
  const done: string[] = [];
  for (const op of ops) {
    if (
      !op ||
      typeof op !== "object" ||
      Array.isArray(op) ||
      !("op" in op) ||
      !("task" in op)
    ) continue;
    if (op.op === "done" && typeof op.task === "string" && op.task.length > 0) done.push(op.task);
  }
  return done;
}

export function readTodoCompletionReceipts(details: unknown): string[] {
  if (
    !details ||
    typeof details !== "object" ||
    Array.isArray(details) ||
    !("op" in details) ||
    (details.op !== "done" && details.op !== "batch") ||
    !("completedTasks" in details) ||
    !Array.isArray(details.completedTasks)
  ) return [];
  return details.completedTasks.flatMap((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("content" in value) ||
      typeof value.content !== "string" ||
      value.content.length === 0
    ) return [];
    return [value.content];
  });
}

function readTodoOperations(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const operations = "ops" in value && Array.isArray(value.ops) ? value.ops : [value];
  return operations.flatMap((operation) => {
    if (
      !operation ||
      typeof operation !== "object" ||
      Array.isArray(operation) ||
      !("op" in operation) ||
      typeof operation.op !== "string"
    ) return [];
    return [operation.op];
  });
}

function isOpenTodoStatus(status: TodoStatus): boolean {
  return status === "pending" || status === "in_progress" || status === "blocked";
}

export function createTodoProgressState(): TodoProgressState {
  return {
    currentTodos: [],
    acceptedTodoBindingIds: new Set<number>(),
    nextBindingId: 1,
  };
}

/**
 * TodoTracker 스냅샷을 content가 아니라 incarnation identity로 잇는다.
 * init, 삭제 뒤 재추가, terminal 상태 뒤 reopen은 같은 문구여도 새 업무다.
 */
export function advanceTodoProgressState(
  state: TodoProgressState,
  snapshot: readonly TodoSnapshotItem[],
  input?: unknown,
  details?: unknown,
): TodoProgressState {
  const forceReset = [...readTodoOperations(input), ...readTodoOperations(details)].includes("init");
  const previousByContent = new Map<string, BoundTodoSnapshotItem[]>();
  for (const item of state.currentTodos) {
    const matches = previousByContent.get(item.content) ?? [];
    matches.push(item);
    previousByContent.set(item.content, matches);
  }

  let nextBindingId = state.nextBindingId;
  const previousIndexes = new Map<string, number>();
  const currentTodos = snapshot.map((item): BoundTodoSnapshotItem => {
    const matches = previousByContent.get(item.content) ?? [];
    const previousIndex = previousIndexes.get(item.content) ?? 0;
    previousIndexes.set(item.content, previousIndex + 1);
    const previous = matches[previousIndex];
    const reopened = Boolean(
      previous &&
      (previous.status === "completed" || previous.status === "abandoned") &&
      isOpenTodoStatus(item.status)
    );
    const bindingId = forceReset || !previous || reopened
      ? nextBindingId++
      : previous.bindingId;
    return { ...item, bindingId };
  });

  const completedIds = new Set(
    currentTodos.filter((item) => item.status === "completed").map((item) => item.bindingId),
  );
  const acceptedTodoBindingIds = new Set(
    [...state.acceptedTodoBindingIds].filter((bindingId) => completedIds.has(bindingId)),
  );
  const receipts = new Set([
    ...readExplicitTodoDoneTasks(input),
    ...readTodoCompletionReceipts(details),
  ]);
  for (const content of receipts) {
    const matches = currentTodos.filter(
      (item) => item.content === content && item.status === "completed",
    );
    if (matches.length === 1) acceptedTodoBindingIds.add(matches[0]!.bindingId);
  }
  return { currentTodos, acceptedTodoBindingIds, nextBindingId };
}

export function captureTodoBindings(
  metadata: TaskProgressMetadata,
  currentTodos: readonly BoundTodoSnapshotItem[],
): ReadonlyMap<string, number> {
  const bindings = new Map<string, number>();
  for (const content of metadata.todoTasks) {
    const matches = currentTodos.filter((todo) => todo.content === content);
    if (matches.length === 1) bindings.set(content, matches[0]!.bindingId);
  }
  return bindings;
}

/** 현재 branch의 durable TodoTracker 기록을 live updater와 같은 순서로 재생한다. */
export function readPersistedTodoProgress(entries: unknown): PersistedTodoProgress {
  if (!Array.isArray(entries)) return createTodoProgressState();
  let state = createTodoProgressState();
  let pendingCustomSnapshot: TodoSnapshotItem[] | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (
      "type" in entry &&
      entry.type === "custom" &&
      "customType" in entry &&
      entry.customType === "user_todo_edit"
    ) {
      const snapshot = readTodoSnapshot("data" in entry ? entry.data : undefined);
      if (!snapshot) continue;
      if (pendingCustomSnapshot) {
        state = advanceTodoProgressState(state, pendingCustomSnapshot);
      }
      pendingCustomSnapshot = snapshot;
      continue;
    }
    if (
      !("type" in entry) ||
      entry.type !== "message" ||
      !("message" in entry) ||
      !entry.message ||
      typeof entry.message !== "object" ||
      Array.isArray(entry.message)
    ) continue;
    const message = entry.message;
    if (
      !("role" in message) ||
      message.role !== "toolResult" ||
      !("toolName" in message) ||
      message.toolName !== "todo" ||
      ("isError" in message && message.isError === true)
    ) continue;
    const details = "details" in message ? message.details : undefined;
    const snapshot = readTodoSnapshot(details) ?? pendingCustomSnapshot;
    if (snapshot) {
      state = advanceTodoProgressState(
        state,
        snapshot,
        "input" in message ? message.input : undefined,
        details,
      );
    }
    pendingCustomSnapshot = undefined;
  }
  if (pendingCustomSnapshot) {
    state = advanceTodoProgressState(state, pendingCustomSnapshot);
  }
  return state;
}

export function assessTodoProgress(args: {
  metadata: TaskProgressMetadata;
  currentTodos: readonly BoundTodoSnapshotItem[];
  todoBindings: ReadonlyMap<string, number>;
  validation: Readonly<Record<string, TerminalValidationItem>>;
  acceptedTodoBindingIds: ReadonlySet<number>;
  revision?: string;
  terminalError: boolean;
  unresolvedCount?: number;
  purpose?: string;
}): TodoProgressAssessment {
  const items = args.metadata.todoTasks.map((content): TodoProgressItem => {
    const current = args.currentTodos.filter((todo) => todo.content === content);
    const boundId = args.todoBindings.get(content);
    const boundCurrent = boundId === undefined
      ? undefined
      : current.find((todo) => todo.bindingId === boundId);
    const bindingStatus: TodoProgressItem["bindingStatus"] =
      boundId === undefined ? "unbound" : boundCurrent ? "current" : "stale";
    const validation = args.validation[content];
    const validationState: TodoProgressItem["validation"] = !validation
      ? "missing"
      : validation.state !== "met"
        ? "waiting"
        : validation.evidencePresent
          ? "met-with-evidence"
          : "met-without-evidence";
    const evidenceMet = validationState === "met-with-evidence";
    const reportClear = Boolean(args.revision) && !args.terminalError && (args.unresolvedCount ?? 0) === 0;
    const accepted = Boolean(
      boundCurrent?.status === "completed" &&
      args.acceptedTodoBindingIds.has(boundCurrent.bindingId)
    );
    return {
      content,
      currentStatus: boundCurrent?.status ?? current[0]?.status,
      bindingStatus,
      exactCurrentMatches: current.length,
      validation: validationState,
      mainAccepted: accepted,
      readyForMainAcceptance:
        !accepted &&
        bindingStatus === "current" &&
        current.length === 1 &&
        (boundCurrent?.status === "pending" || boundCurrent?.status === "in_progress") &&
        evidenceMet &&
        reportClear,
    };
  });

  const validationMetCount = items.filter((item) => item.validation === "met-with-evidence").length;
  const mainAcceptedCount = items.filter((item) => item.mainAccepted).length;
  return {
    metadataValid: args.metadata.taskTitleValid && args.metadata.todoTasksValid,
    revisionPresent: Boolean(args.revision),
    expectedCount: items.length,
    currentExactCount: items.filter((item) => item.exactCurrentMatches > 0).length,
    currentMissingCount: items.filter((item) => item.exactCurrentMatches === 0).length,
    duplicateCurrentCount: items.filter((item) => item.exactCurrentMatches > 1).length,
    staleBindingCount: items.filter((item) => item.bindingStatus === "stale").length,
    unboundBindingCount: items.filter((item) => item.bindingStatus === "unbound").length,
    validationCoveredCount: items.filter((item) => item.validation !== "missing").length,
    validationMetCount,
    validationEvidenceMissingCount: items.filter((item) => item.validation === "met-without-evidence").length,
    validationWaitingCount: items.filter((item) => item.validation === "missing" || item.validation === "waiting").length,
    readyForMainAcceptanceCount: items.filter((item) => item.readyForMainAcceptance).length,
    mainAcceptedCount,
    unattributedCompletedCount: items.filter((item) => item.currentStatus === "completed" && !item.mainAccepted).length,
    partialCompletion:
      items.some((item) => item.mainAccepted || item.validation === "met-with-evidence") &&
      mainAcceptedCount < items.length,
    reworkLinked: args.purpose === "rework",
    items,
  };
}
