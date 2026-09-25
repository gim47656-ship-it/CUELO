"use client";

import type { TodoTask } from "@/lib/todo-state";

/** One todo line, shared by the transcript's checklist card and the composer's goal strip. */
export function TodoChecklistRow({ task }: { task: TodoTask }) {
  const completed = task.status === "completed";
  const abandoned = task.status === "abandoned";
  const active = task.status === "in_progress";
  const blocked = task.status === "blocked";
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
      aria-label={`${task.status}: ${task.content}`}
      className={`todo-checklist-row ${statusClass}`}
    >
      <span aria-hidden="true" className="todo-checklist-marker">
        {marker}
      </span>
      <span className="todo-checklist-content">
        {task.content}
        {blocked && task.blocker ? <span className="todo-checklist-blocker"> ({task.blocker})</span> : null}
      </span>
    </div>
  );
}
