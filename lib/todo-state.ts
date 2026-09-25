import type { AgentMessage, AssistantMessage, ToolCallContent, ToolResultMessage } from "./types";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TodoTask {
  content: string;
  status: TodoStatus;
  blocker?: string;
}

export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned" || value === "blocked";
}

function readTasks(value: unknown): TodoTask[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TodoTask[] => {
    if (!item || typeof item !== "object" || !("content" in item) || !("status" in item)) return [];
    const { content, status } = item;
    if (typeof content !== "string" || !isTodoStatus(status)) return [];
    const blocker = "blocker" in item && typeof item.blocker === "string" ? item.blocker : undefined;
    return [{ content, status, blocker }];
  });
}

/**
 * The phases a result reported, and whether any entry was unusable. A phase whose task list is
 * empty is a real state - `todo.removeTasks` empties a phase without deleting it - so it counts
 * as reported and simply shows nothing. Only a shape we cannot read at all is malformed.
 */
function readReportedPhases(reported: unknown[]): { phases: TodoPhase[]; malformed: boolean } {
  const phases: TodoPhase[] = [];
  for (const entry of reported) {
    if (!entry || typeof entry !== "object" || !("name" in entry) || !("tasks" in entry)) {
      return { phases, malformed: true };
    }
    const { name, tasks } = entry;
    if (typeof name !== "string" || !Array.isArray(tasks)) return { phases, malformed: true };
    const read = readTasks(tasks);
    if (read.length !== tasks.length) return { phases, malformed: true };
    if (read.length > 0) phases.push({ name, tasks: read });
  }
  return { phases, malformed: false };
}

function readRequestedPhases(input: unknown): TodoPhase[] {
  const list = input && typeof input === "object" && "list" in input ? input.list : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): TodoPhase[] => {
    if (!entry || typeof entry !== "object" || !("phase" in entry) || !("items" in entry)) return [];
    const { phase, items } = entry;
    if (typeof phase !== "string" || !Array.isArray(items)) return [];
    const tasks = items
      .filter((item): item is string => typeof item === "string")
      .map((content) => ({ content, status: "pending" as const }));
    return tasks.length > 0 ? [{ name: phase, tasks }] : [];
  });
}

export type TodoSnapshot =
  /** The list the tool itself reported. An empty `phases` is the tool clearing the todo. */
  | { kind: "authoritative"; phases: TodoPhase[] }
  /** A call still in flight, shown from the whole list it carries until its result answers. */
  | { kind: "preview"; phases: TodoPhase[] }
  /** This call says nothing about the list: an update-only call, a refusal or an error. */
  | { kind: "unknown" };

/**
 * What one todo tool call tells us about the list, and nothing more. Only `details.phases` is
 * authoritative, and an emptied list - no phases, or phases the tool emptied of tasks - is an
 * answer like any other: it clears the strip. A result we cannot read (refused, errored,
 * malformed) tells us nothing: the call's own arguments describe a request that was never
 * granted, so they are never read as state. Before the result arrives the call may stand in for
 * the list only when it carries a whole one; a `start`/`done`/`block`/`add` style update carries
 * no list and stays `unknown` so the list already on screen keeps showing.
 */
export function resolveTodoSnapshot(block: ToolCallContent, result?: ToolResultMessage): TodoSnapshot {
  if (result) {
    const details: unknown = result.details;
    const reported = details && typeof details === "object" && "phases" in details ? details.phases : undefined;
    if (!Array.isArray(reported)) return { kind: "unknown" };
    const { phases, malformed } = readReportedPhases(reported);
    return malformed ? { kind: "unknown" } : { kind: "authoritative", phases };
  }

  const phases = readRequestedPhases(block.input);
  return phases.length > 0 ? { kind: "preview", phases } : { kind: "unknown" };
}

/** The phases this one call shows in the transcript, or nothing when it reports no list. */
export function getTodoPhases(block: ToolCallContent, result?: ToolResultMessage): TodoPhase[] | null {
  const snapshot = resolveTodoSnapshot(block, result);
  return snapshot.kind === "unknown" || snapshot.phases.length === 0 ? null : snapshot.phases;
}

/** Whether a tool name is the todo tool, including an extension-namespaced one. */
function isTodoToolName(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase();
  return normalized === "todo" || normalized.endsWith(".todo") || normalized.endsWith("_todo");
}

/**
 * The newest todo this transcript holds. Later calls replace earlier ones, so the last todo tool
 * call that actually reports a list - with the result that answered it - is the current list, and
 * calls that report none are skipped over rather than allowed to erase what is on screen. An
 * explicitly emptied list is itself an answer and clears the strip.
 * Reading only this session's messages is what keeps a switched-away session's todo off screen.
 *
 * `reportedPhases` is the harness tracker's own list (`get_state.todoPhases`, and the
 * `todo_changed` event the hook applies as it arrives). The tracker is the state every tool record
 * is written from, and it also takes changes no record carries - a `/todo` edit, a `set_todos`
 * call, the completion a finished subagent triggers - so any reported list is the answer and the
 * transcript is only what is left when nothing has reported one. That includes an empty list: the
 * tracker saying there is no todo must not be undone by replaying an older record.
 */
export function selectCurrentTodo(
  messages: AgentMessage[],
  toolResults: Map<string, ToolResultMessage>,
  reportedPhases: TodoPhase[] | null = null,
): TodoPhase[] | null {
  if (reportedPhases) return reportedPhases;
  return selectTodoFromTranscript(messages, toolResults);
}

/** The todo this session's own transcript reports, or nothing when it reports none. */
function selectTodoFromTranscript(
  messages: AgentMessage[],
  toolResults: Map<string, ToolResultMessage>,
): TodoPhase[] | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const blocks = (message as AssistantMessage).content;
    if (!Array.isArray(blocks)) continue;
    for (let b = blocks.length - 1; b >= 0; b -= 1) {
      const block = blocks[b];
      if (block.type !== "toolCall") continue;
      const call = block as ToolCallContent;
      if (!isTodoToolName(call.toolName)) continue;
      const snapshot = resolveTodoSnapshot(call, toolResults.get(call.toolCallId));
      if (snapshot.kind === "unknown") continue;
      return snapshot.phases;
    }
  }
  return null;
}

export interface TodoProgress {
  /** The phase the shown task belongs to, so the strip never names a phase from another task. */
  currentPhase: TodoPhase | null;
  /** The task in progress; with none in progress the next pending one, then a blocked one. */
  activeTask: TodoTask | null;
  remaining: number;
  completed: number;
  /** Tasks that still count: an abandoned one is dropped from the denominator entirely. */
  total: number;
  /** completed/total as a whole percent, or null when there is nothing left to measure. */
  percent: number | null;
}

export function summarizeTodo(phases: TodoPhase[]): TodoProgress {
  let completed = 0;
  let remaining = 0;
  let running: { phase: TodoPhase; task: TodoTask } | null = null;
  let pending: { phase: TodoPhase; task: TodoTask } | null = null;
  let blocked: { phase: TodoPhase; task: TodoTask } | null = null;

  // One pass over the tasks themselves: counting phases as well would double-count the same todo.
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status === "completed") {
        completed += 1;
        continue;
      }
      // An abandoned task is settled but not achieved: it leaves the denominator.
      if (task.status === "abandoned") continue;
      // A blocked task is still owed work, so it stays in the denominator and in what is left.
      remaining += 1;
      if (task.status === "in_progress") {
        if (!running) running = { phase, task };
      } else if (task.status === "blocked") {
        if (!blocked) blocked = { phase, task };
      } else if (!pending) {
        pending = { phase, task };
      }
    }
  }

  // Work in hand first, then the next task actually startable, and a blocked one only when
  // nothing else is left. The phase shown is the one that task lives in, never an earlier phase
  // that happens to hold a blocked leftover.
  const current = running ?? pending ?? blocked;
  const total = completed + remaining;
  return {
    currentPhase: current?.phase ?? null,
    activeTask: current?.task ?? null,
    remaining,
    completed,
    total,
    percent: total > 0 ? Math.round((completed / total) * 100) : null,
  };
}
