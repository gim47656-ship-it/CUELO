"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { TodoChecklistRow } from "./TodoChecklistRow";
import { summarizeTodo, type TodoPhase } from "@/lib/todo-state";

/**
 * The one line above the composer that says what this session is working on. It is a view of the
 * todo the agent's own tool reported - no timer, no separate store - so a status that arrives
 * with the next tool result is already checked off here. Collapsed it costs one row: the current
 * phase, the task in hand and how many are left. Opening it shows the full list.
 */
export function TodoStrip({ phases }: { phases: TodoPhase[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const { currentPhase, activeTask, remaining, completed, total, percent } = summarizeTodo(phases);

  if (total === 0) return null;

  const done = remaining === 0;

  return (
    <div className={`todo-strip${done ? " is-done" : ""}`}>
      <button
        type="button"
        className="todo-strip-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true" className="todo-strip-marker">
          {done ? "✓" : "›"}
        </span>
        {currentPhase && <span className="todo-strip-phase">{currentPhase.name}</span>}
        <span className="todo-strip-task">
          {done ? t("todo.allDone", { count: completed }) : activeTask?.content ?? ""}
        </span>
        <span className="todo-strip-count">
          {done
            ? t("todo.progressDone", { percent: percent ?? 0, completed, total })
            : t("todo.progress", { percent: percent ?? 0, completed, total, remaining })}
        </span>
      </button>
      {open && (
        <div className="todo-strip-body">
          {phases.map((phase, phaseIndex) => {
            const visible = phase.tasks.filter((task) => showCompleted || task.status !== "completed");
            if (visible.length === 0) return null;
            return (
              <div key={`${phase.name}-${phaseIndex}`} className="todo-checklist-phase" role="list">
                {phases.length > 1 && <div className="todo-checklist-phase-name">{phase.name}</div>}
                {visible.map((task, taskIndex) => (
                  <TodoChecklistRow key={`${task.content}-${taskIndex}`} task={task} />
                ))}
              </div>
            );
          })}
          {completed > 0 && (
            <button
              type="button"
              className="todo-strip-completed-toggle"
              aria-expanded={showCompleted}
              onClick={() => setShowCompleted((value) => !value)}
            >
              {showCompleted ? t("todo.hideCompleted", { count: completed }) : t("todo.showCompleted", { count: completed })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
