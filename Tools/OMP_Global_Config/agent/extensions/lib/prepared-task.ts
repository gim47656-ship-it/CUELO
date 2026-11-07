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
/** A reference line may be followed by Main's additions to the stored brief. */
const TASK_REFERENCE =
  /^PREPARED_TASK:[ \t]*([A-Za-z0-9._-]+)[ \t]*(?:\r?\n([\s\S]*))?$/;
/**
 * 근거를 task 참조 대신 context에 실은 형태(`PREPARED_CONTEXT` 다음 줄·같은 줄, 또는 근거 한 줄만). 2026-10-10~22에
 * 이 실수로 거절된 발주 6건 중 5건이 참조 하나, 1건이 참조 둘이었다. 호출 전체에 단 근거 한 줄이므로 자기 근거 줄이 없는
 * 참조 모두의 근거로 옮긴다. 근거 문법은 TASK_REFERENCE의 근거 줄과 같다.
 */
const CONTEXT_REASON =
  /^(?:PREPARED_CONTEXT(?:[ \t]*\r?\n[ \t]*|[ \t]+))?(ROUTING_REASON:[ \t]*\S[^\r\n\u2028\u2029]*\S)[ \t]*(?:\r?\n)?$/;

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

/** Describe malformed reference syntax without echoing the brief body. */
function describeReference(value: string): string {
  const trimmed = value.trim();
  const exact = TASK_REFERENCE.exec(trimmed);
  if (exact) return `앞뒤 공백이 있어 참조가 아닙니다('PREPARED_TASK: ${clipped(exact[1]!)}'로 시작하세요)`;
  const notes: string[] = [];
  if (!trimmed.startsWith("PREPARED_TASK:")) notes.push("'PREPARED_TASK:' 접두 표기가 다릅니다(대문자 접두 뒤 바로 콜론)");
  const after = trimmed.replace(/^PREPARED_TASK\s*:\s*/i, "");
  if (!after) {
    notes.push("'PREPARED_TASK:' 뒤에 preparedId가 없습니다");
    return notes.join(" · ");
  }
  const [id = "", ...rest] = after.split(/\s+/);
  const lines = trimmed.split(/\r?\n/).length;
  if (lines > 1) notes.push(`참조 첫 줄의 preparedId 형식을 확인하세요`);
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
  const matches = taskValues.map((value) => (typeof value === "string" ? TASK_REFERENCE.exec(value) : null));
  const references = matches.map((match) => match?.[1]);
  const referenceLike = taskValues.map((value) =>
    typeof value === "string" && /^PREPARED_TASK\s*:/i.test(value.trim()),
  );
  const hasReference = references.some((id) => id !== undefined);
  const contextText = typeof input.context === "string" ? input.context : "";
  const contextMatch = /^PREPARED_CONTEXT(?:[ \t]+|\r?\n)([\s\S]*)$/.exec(contextText);
  const contextTail = contextMatch?.[1];
  const reasonLine = contextTail?.match(/^[ \t]*(ROUTING_REASON:[ \t]*\S[^\r\n\u2028\u2029]*\S)[ \t]*\r?$/m);
  const contextReason = hasReference ? CONTEXT_REASON.exec(contextText)?.[1] ?? reasonLine?.[1] : undefined;
  const hasContextMarker = contextText === CONTEXT_REFERENCE || contextMatch !== null || contextReason !== undefined;
  const contextAddition = reasonLine
    ? contextTail!.replace(reasonLine[0], "").trim()
    : contextReason === undefined ? contextTail?.trim() : undefined;

  if (!hasReference && !hasContextMarker && !referenceLike.some(Boolean)) return input;
  const malformedIndex = referenceLike.findIndex((like, index) => like && references[index] === undefined);
  if (malformedIndex >= 0) {
    throw new Error(
      `task[${malformedIndex}]의 task 값이 exact prepared 참조가 아닙니다: ${describeReference(taskValues[malformedIndex] as string)}. ` +
      "참조 첫 줄은 'PREPARED_TASK: <preparedId>'로 쓰고, 추가 지시는 다음 줄에 적으세요.",
    );
  }
  if (hasReference && !hasContextMarker) {
    const received = input.context;
    const label = typeof received === "string" && received.length > 0 ? `'${clipped(received)}'` : "<없음>";
    throw new Error(
      `prepared 참조를 쓰려면 context를 '${CONTEXT_REFERENCE}'로 보내야 합니다: 받은 값 ${label}. ` +
      "추가 context는 PREPARED_CONTEXT 다음에 적으면 복원한 context 뒤에 붙습니다.",
    );
  }
  if (!hasReference) {
    throw new Error(
      `context='${CONTEXT_REFERENCE}'인데 exact prepared 참조가 없습니다: task는 'PREPARED_TASK: <preparedId>' 하나이거나, ` +
      "참조 대신 full 원문을 그 context와 함께 보내야 합니다.",
    );
  }

  const state = sessions.get(requireSessionId(sessionId));
  if (!state) throw new Error("현재 session에 prepared task 참조가 없습니다. 먼저 maker_route로 이 session의 발주를 준비하세요.");
  const records = references.map((id) => id === undefined ? undefined : state.records.get(id));
  if (records.some((record, index) => references[index] !== undefined && !record)) {
    const missing = references.filter((id, index) => id !== undefined && !records[index]).map((id) => `'${clipped(id!, 40)}'`);
    const available = [...state.records.keys()];
    const shown = available.slice(0, DIAGNOSTIC_LIST_LIMIT);
    throw new Error(
      `prepared task 참조가 현재 session에 없거나 이미 해제되었습니다: ${missing.join(", ")}. ` +
      `이 session에 준비된 참조: ${available.length === 0 ? "없음" : shown.join(", ")}${available.length > shown.length ? ` 외 ${available.length - shown.length}개` : ""}. ` +
      "maker_route가 돌려준 preparedId를 그대로 쓰세요.",
    );
  }
  const resolved = records.filter((record): record is PreparedTaskRecord => record !== undefined);
  const batchId = resolved[0]!.batchId;
  const context = resolved[0]!.context;
  if (resolved.some((record) => record.batchId !== batchId || record.context !== context)) {
    throw new Error("서로 다른 prepared batch의 task 참조를 한 호출에 섞을 수 없습니다.");
  }

  const restoredItems = items.map((item, index) => {
    const source = item as Record<string, unknown>;
    const record = records[index];
    if (!record) return source;
    // 참조에 이미 session·batch·ref로 묶인 name이 있으므로 생략만 그 name으로 복원한다. 명시한 값은 일치해야 한다.
    if (source.name !== undefined && source.name !== record.name) {
      throw new Error(
        `prepared task name이 일치하지 않습니다: prepared='${clipped(record.name, 40)}' 발주='${clipped(typeof source.name === "string" ? source.name : String(source.name), 40)}'. ` +
        "참조 발주는 name을 생략하거나 준비한 이름을 그대로 써야 합니다.",
      );
    }
    const addition = matches[index]![2]?.trim();
    const ownReason = addition && /^[ \t]*ROUTING_REASON:[ \t]*\S.+$/m.test(addition);
    const appended = [addition, !ownReason ? contextReason?.trim() : undefined].filter(Boolean).join("\n");
    return { ...source, name: record.name, task: appended ? `${record.task.trimEnd()}\n${appended}` : record.task };
  });
  const restoredContext = contextAddition ? `${context.trimEnd()}\n${contextAddition}` : context;
  if (Array.isArray(input.tasks)) {
    return { ...input, context: restoredContext, tasks: restoredItems };
  }
  return { ...restoredItems[0], context: restoredContext };
}
