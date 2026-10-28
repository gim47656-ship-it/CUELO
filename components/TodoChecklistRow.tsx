"use client";

import { unmetTodoDependencies, type TodoPhase, type TodoTask } from "@/lib/todo-state";
import { useI18n } from "@/hooks/useI18n";

/** One todo line, shared by the transcript's checklist card and the composer's goal strip. */
export function TodoChecklistRow({ task, phases }: { task: TodoTask; phases?: TodoPhase[] }) {
  const { t } = useI18n();
  const completed = task.status === "completed";
  const abandoned = task.status === "abandoned";
  const active = task.status === "in_progress";
  const blocked = task.status === "blocked";
  const waits = phases && !completed && !abandoned ? unmetTodoDependencies(task, phases) : [];
  const readiness = waits.length > 0
    ? t("todo.waiting", { tasks: waits.join(", ") })
    : phases && !completed && !abandoned && !blocked ? t("todo.ready") : null;
  const marker = completed ? "✓" : abandoned ? "×" : blocked ? "!" : active ? "›" : "";
  const statusClass = completed
    ? "is-completed"
    : abandoned
    ? "is-abandoned"
    : blocked
    ? "is-blocked"
    : active
    ? "is-active"
    : "is-pending";

  return (
    <div
      role="listitem"
      aria-label={`${task.status}: ${task.content}${readiness ? `; ${readiness}` : ""}`}
      className={`todo-checklist-row ${statusClass}`}
    >
      <span aria-hidden="true" className="todo-checklist-marker">
        {marker}
      </span>
      <span className="todo-checklist-content">
        {task.content}
        {blocked && task.blocker ? <span className="todo-checklist-blocker"> ({task.blocker})</span> : null}
        {readiness && <span className={`todo-checklist-readiness${waits.length > 0 ? " is-waiting" : ""}`}> · {readiness}</span>}
      </span>
    </div>
  );
}
