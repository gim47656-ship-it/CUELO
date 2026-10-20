"use client";

import { useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { WorkFlow } from "@/lib/answer-status/work-flow";
import { useAnswerStatusText } from "./answer-status/i18n";
import { stripLead, WorkFlowChain } from "./answer-status/WorkFlow";
import { TodoChecklistRow } from "./TodoChecklistRow";
import { summarizeTodo, type TodoPhase } from "@/lib/todo-state";

/**
 * The one line above the composer that says where this session is in its work. While the agent runs it leads with the
 * stage in progress, read from the turn's own tool calls (with the attempt once a failure sent it back to edit); a
 * finished turn has no lead, since nothing is in progress or up next. Then comes the task in hand from the todo the
 * agent's tool reported, with how many are left. No timer, no separate store. Opening the task shows the full list;
 * 「작업 흐름」 opens the stage chain.
 */
export function TodoStrip({ phases, flow, busy }: { phases: TodoPhase[] | null; flow: WorkFlow; busy: boolean }) {
  const { t } = useI18n();
  const { st } = useAnswerStatusText();
  const [open, setOpen] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const chainId = useId();
  const todo = phases ?? [];
  const { currentPhase, activeTask, remaining, completed, total, percent } = summarizeTodo(todo);
  const hasFlow = flow.steps.length > 0;
  const lead = stripLead(flow, busy, st);

  // A finished turn without a todo shows nothing here; its card in the transcript keeps the stages.
  if (total === 0 && lead === null) return null;

  const done = total > 0 && remaining === 0;

  return (
    <div className={`todo-strip${done ? " is-done" : ""}`}>
      <div className="todo-strip-row">
        <span aria-hidden="true" className="todo-strip-marker">
          {done ? "✓" : "›"}
        </span>
        {lead && <span className="todo-strip-lead" role={busy ? "status" : undefined}>{lead}</span>}
        {total > 0 && (
          <button
            type="button"
            className="todo-strip-summary"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {!lead && currentPhase && <span className="todo-strip-phase">{currentPhase.name}</span>}
            <span className="todo-strip-task">
              {done ? t("todo.allDone", { count: completed }) : activeTask?.content ?? ""}
            </span>
            <span className="todo-strip-count">
              {done
                ? t("todo.progressDone", { percent: percent ?? 0, completed, total })
                : t("todo.progress", { percent: percent ?? 0, completed, total, remaining })}
            </span>
          </button>
        )}
        {hasFlow && (
          <button
            type="button"
            className="todo-strip-flow-toggle"
            aria-expanded={flowOpen}
            aria-controls={chainId}
            onClick={() => setFlowOpen((value) => !value)}
          >
            {st("flow.toggle")}
            <svg className="flow-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </div>
      {flowOpen && hasFlow && <WorkFlowChain flow={flow} live={busy} st={st} id={chainId} />}
      {open && total > 0 && (
        <div className="todo-strip-body">
          {todo.map((phase, phaseIndex) => {
            const visible = phase.tasks.filter((task) => showCompleted || task.status !== "completed");
            if (visible.length === 0) return null;
            return (
              <div key={`${phase.name}-${phaseIndex}`} className="todo-checklist-phase" role="list">
                {todo.length > 1 && <div className="todo-checklist-phase-name">{phase.name}</div>}
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
