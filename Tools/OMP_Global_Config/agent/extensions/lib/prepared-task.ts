interface PreparedTaskSource {
  name: string;
  task: string;
}

interface PreparedTaskRecord extends PreparedTaskSource {
  batchId: string;
  context: string;
}

interface PreparedSessionState {
  batchesBySignature: Map<string, string[]>;
  records: Map<string, PreparedTaskRecord>;
}

interface PreparedTaskGlobalState {
  version: 1;
  sessions: Map<string, PreparedSessionState>;
  nextBatchId: number;
}

const PREPARED_TASK_STATE = Symbol.for("@oh-my-pi/omp/prepared-task-state/v1");
const shared = (() => {
  const existing = Reflect.get(globalThis, PREPARED_TASK_STATE) as PreparedTaskGlobalState | undefined;
  if (existing) return existing;
  const created: PreparedTaskGlobalState = {
    version: 1,
    sessions: new Map(),
    nextBatchId: 0,
  };
  Reflect.set(globalThis, PREPARED_TASK_STATE, created);
  return created;
})();
const sessions = shared.sessions;
const CONTEXT_REFERENCE = "PREPARED_CONTEXT";
const TASK_REFERENCE = /^PREPARED_TASK:\s*([A-Za-z0-9._-]+)\s*$/;

function requireSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) throw new Error("prepared task 참조에는 현재 session id가 필요합니다.");
  return normalized;
}

function stateFor(sessionId: string): PreparedSessionState {
  const key = requireSessionId(sessionId);
  let state = sessions.get(key);
  if (!state) {
    state = { batchesBySignature: new Map(), records: new Map() };
    sessions.set(key, state);
  }
  return state;
}

/** 같은 session의 같은 context+brief batch는 한 번만 저장하고 기존 참조를 재사용한다. */
export function storePreparedTaskBatch(
  context: string,
  tasks: readonly PreparedTaskSource[],
  sessionId: string,
): string[] {
  if (tasks.length === 0) throw new Error("prepared task batch에는 task가 하나 이상 필요합니다.");
  const state = stateFor(sessionId);
  const signature = JSON.stringify([context, tasks.map((task) => [task.name, task.task])]);
  const existing = state.batchesBySignature.get(signature);
  if (existing) return [...existing];

  const batchId = `b${++shared.nextBatchId}`;
  const ids = tasks.map((task, index) => {
    if (!task.name.trim()) throw new Error("prepared task에는 비어 있지 않은 name이 필요합니다.");
    const id = `${batchId}.${index + 1}`;
    state.records.set(id, { batchId, context, name: task.name, task: task.task });
    return id;
  });
  state.batchesBySignature.set(signature, ids);
  return [...ids];
}

/** session lifecycle이 새로 시작될 때만 해당 session의 brief 참조를 해제한다. */
export function clearPreparedTaskSession(sessionId: string): void {
  const key = sessionId.trim();
  if (key) sessions.delete(key);
}

/** 거절 진단에 싣는 사용자 입력 유래 값의 상한. task 원문 본문은 싣지 않는다. */
const DIAGNOSTIC_VALUE_LIMIT = 60;
const DIAGNOSTIC_LIST_LIMIT = 12;

function clipped(value: string, limit = DIAGNOSTIC_VALUE_LIMIT): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

/**
 * 참조로 보이지만 exact 문법이 아닌 task 값이 어디서 벗어났는지 한 줄로 집는다. 본문은 에코하지 않고
 * 참조 뒤에 붙은 줄·글자 수와 preparedId 토큰만 싣는다.
 */
function describeReference(value: string): string {
  const trimmed = value.trim();
  const exact = TASK_REFERENCE.exec(trimmed);
  if (exact) return `앞뒤 공백이나 줄바꿈이 있어 exact 참조가 아닙니다(정확히 'PREPARED_TASK: ${clipped(exact[1]!)}')`;
  const notes: string[] = [];
  if (!trimmed.startsWith("PREPARED_TASK:")) notes.push("'PREPARED_TASK:' 접두 표기가 다릅니다(대문자 접두 뒤 바로 콜론)");
  const after = trimmed.replace(/^PREPARED_TASK\s*:\s*/i, "");
  if (!after) {
    notes.push("'PREPARED_TASK:' 뒤에 preparedId가 없습니다");
    return notes.join(" · ");
  }
  const [id = "", ...rest] = after.split(/\s+/);
  const lines = trimmed.split(/\r?\n/).length;
  if (lines > 1) notes.push(`참조 뒤에 본문 ${lines - 1}줄이 더 붙었습니다`);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) notes.push(`preparedId 형식이 아닙니다: '${clipped(id, 40)}' (허용 문자: A-Za-z0-9._-)`);
  else if (lines === 1 && rest.length > 0) notes.push(`참조 뒤에 다른 내용이 ${rest.join(" ").length}자 붙었습니다`);
  return notes.join(" · ") || "exact 참조 문법이 아닙니다";
}

/**
 * task의 기존 문자열 필드에 실린 prepared 참조를 canonical input으로 복원한다.
 * full input은 객체 identity까지 그대로 보존하며, 참조 입력은 얕은 복사본을 반환한다.
 */
export function resolvePreparedTaskInput(
  input: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  const items = (Array.isArray(input.tasks) ? input.tasks : [input]) as unknown[];
  const taskValues = items.map((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).task
      : undefined,
  );
  const references = taskValues.map((value) =>
    typeof value === "string" ? TASK_REFERENCE.exec(value)?.[1] : undefined,
  );
  const referenceLike = taskValues.map((value) =>
    typeof value === "string" && /^PREPARED_TASK\s*:/i.test(value.trim()),
  );
  const hasReference = references.some((id) => id !== undefined);
  const hasContextMarker = input.context === CONTEXT_REFERENCE;

  if (!hasReference && !hasContextMarker && !referenceLike.some(Boolean)) return input;
  const malformedIndex = referenceLike.findIndex((like, index) => like && references[index] === undefined);
  if (malformedIndex >= 0) {
    throw new Error(
      `task[${malformedIndex}]의 task 값이 exact prepared 참조가 아닙니다: ${describeReference(taskValues[malformedIndex] as string)}. ` +
      "참조는 task 문자열 전체를 'PREPARED_TASK: <preparedId>' 하나로 두고, 원문은 maker_route가 보관한 그대로 복원되므로 덧붙이지 않습니다.",
    );
  }
  if (hasReference && !hasContextMarker) {
    const received = input.context;
    const label = typeof received === "string" && received.length > 0 ? `'${clipped(received)}'` : "<없음>";
    throw new Error(
      `prepared 참조를 쓰려면 context를 정확히 '${CONTEXT_REFERENCE}'로 보내야 합니다: 받은 값 ${label}. ` +
      "원문 context는 참조가 복원하므로 함께 보내지 않습니다.",
    );
  }
  if (!hasReference) {
    throw new Error(
      `context='${CONTEXT_REFERENCE}'인데 exact prepared 참조가 없습니다: task는 'PREPARED_TASK: <preparedId>' 하나이거나, ` +
      "참조 대신 full 원문을 그 context와 함께 보내야 합니다.",
    );
  }
  if (references.some((id) => id === undefined)) {
    const index = references.findIndex((id) => id === undefined);
    const mixed = taskValues[index];
    throw new Error(
      `${typeof mixed === "string" ? `task[${index}]는 prepared 참조가 아니라 full 원문입니다` : `task[${index}]의 task 값이 문자열이 아닙니다`}. ` +
      "한 호출에서 참조와 원문을 섞을 수 없습니다: 모든 task를 'PREPARED_TASK: <preparedId>'로 보내거나 모두 full 원문으로 보내세요.",
    );
  }

  const state = sessions.get(requireSessionId(sessionId));
  if (!state) throw new Error("현재 session에 prepared task 참조가 없습니다. 먼저 maker_route로 이 session의 발주를 준비하세요.");
  const records = references.map((id) => state.records.get(id!));
  if (records.some((record) => !record)) {
    const missing = references.filter((id, index) => !records[index]).map((id) => `'${clipped(id!, 40)}'`);
    const available = [...state.records.keys()];
    const shown = available.slice(0, DIAGNOSTIC_LIST_LIMIT);
    throw new Error(
      `prepared task 참조가 현재 session에 없거나 이미 해제되었습니다: ${missing.join(", ")}. ` +
      `이 session에 준비된 참조: ${available.length === 0 ? "없음" : shown.join(", ")}${available.length > shown.length ? ` 외 ${available.length - shown.length}개` : ""}. ` +
      "maker_route가 돌려준 preparedId를 그대로 쓰세요.",
    );
  }
  const resolved = records as PreparedTaskRecord[];
  const batchId = resolved[0]!.batchId;
  const context = resolved[0]!.context;
  if (resolved.some((record) => record.batchId !== batchId || record.context !== context)) {
    throw new Error("서로 다른 prepared batch의 task 참조를 한 호출에 섞을 수 없습니다.");
  }

  const restoredItems = items.map((item, index) => {
    const source = item as Record<string, unknown>;
    const record = resolved[index]!;
    if (source.name !== record.name) {
      throw new Error(
        `prepared task name이 일치하지 않습니다: prepared='${clipped(record.name, 40)}' 발주='${clipped(typeof source.name === "string" ? source.name : String(source.name), 40)}'. ` +
        "참조 발주는 준비한 이름을 그대로 써야 합니다.",
      );
    }
    return { ...source, task: record.task };
  });
  if (Array.isArray(input.tasks)) {
    return { ...input, context, tasks: restoredItems };
  }
  return { ...restoredItems[0], context };
}
