import { describe, expect, test } from "bun:test";

import {
  advanceTodoProgressState,
  assessTodoProgress,
  captureTodoBindings,
  createTodoProgressState,
  readExplicitTodoDoneTasks,
  readPersistedTodoProgress,
  readTaskProgressMetadata,
  readTodoCompletionReceipts,
  readTerminalValidation,
  readTodoSnapshot,
} from "../lib/task-progress";

const BRIEF = `TASK_GUARD:
WORK_CLASS: feature
PRIMARY_DELIVERABLE: TASK_TITLE: guard 안 가짜 제목
OWNED_PATHS: a.ts
TASK_TITLE: 서브카드 실제 담당업무 표시
TODO_TASKS: ["카드 제목과 현재 단계를 분리한다","terminal 검증 근거를 TODO에 연결한다"]
초기 formatter/lint/build/tests 모두 건너뛴다.`;

describe("task progress 공유 메타데이터", () => {
  test("TASK_GUARD 밖의 한 줄 제목과 exact TODO 배열만 소비한다", () => {
    const metadata = readTaskProgressMetadata(BRIEF);
    expect(metadata).toMatchObject({
      taskTitle: "서브카드 실제 담당업무 표시",
      todoTasks: ["카드 제목과 현재 단계를 분리한다", "terminal 검증 근거를 TODO에 연결한다"],
      taskTitleValid: true,
      todoTasksValid: true,
      taskTitleFieldPresent: true,
      todoTasksFieldPresent: true,
    });
  });

  test("중복·공백·비JSON TODO는 exact binding으로 채택하지 않는다", () => {
    for (const value of [
      '["같은 항목","같은 항목"]',
      '[" 앞 공백"]',
      "카드 수정",
      "[]",
    ]) {
      const metadata = readTaskProgressMetadata(`TASK_TITLE: 제목\nTODO_TASKS: ${value}`);
      expect(metadata.todoTasksValid).toBe(false);
      expect(metadata.todoTasks).toEqual([]);
    }
  });

  test("TASK_TITLE은 실제 한국어 한 줄만 stable title로 채택한다", () => {
    expect(readTaskProgressMetadata('TASK_TITLE: English title\nTODO_TASKS: ["검증"]').taskTitleValid)
      .toBe(false);
  });
});

describe("terminal validation과 todo 정본 연결", () => {
  const metadata = readTaskProgressMetadata(BRIEF);
  const initialTodoState = advanceTodoProgressState(
    createTodoProgressState(),
    readTodoSnapshot({
      phases: [{
        name: "구현",
        tasks: [
          { content: "카드 제목과 현재 단계를 분리한다", status: "in_progress" },
          { content: "terminal 검증 근거를 TODO에 연결한다", status: "pending" },
        ],
      }],
    })!,
    { op: "init" },
  );
  const currentTodos = initialTodoState.currentTodos;
  const todoBindings = captureTodoBindings(metadata, currentTodos);

  test("승인 단어·approved marker는 권한 상태를 만들지 않고 evidence locator만 보존한다", () => {
    const validation = readTerminalValidation({
      validation: {
        waiting: {
          state: "unverified",
          blocker: "focused 검증은 승인 대기",
          approved: true,
        },
        observed: {
          state: "met",
          evidence_locator: "artifact://focused-observed",
        },
      },
    });
    expect(validation.waiting).toEqual({
      state: "unverified",
      evidencePresent: false,
      evidenceLocators: [],
    });
    expect(validation.waiting).not.toHaveProperty("permissionHold");
    expect(validation.observed?.evidenceLocators).toEqual(["artifact://focused-observed"]);
  });

  test("state met만으로 완료 후보가 되지 않고 항목별 evidence locator까지 요구한다", () => {
    const validation = readTerminalValidation({
      validation: {
        "카드 제목과 현재 단계를 분리한다": { state: "met" },
        "terminal 검증 근거를 TODO에 연결한다": {
          state: "met",
          observation: "focused test 통과",
          evidence: "artifact://focused-test",
        },
      },
    });
    const result = assessTodoProgress({
      metadata,
      currentTodos,
      validation,
      todoBindings,
      acceptedTodoBindingIds: new Set(),
      revision: "rev-1",
      terminalError: false,
      unresolvedCount: 0,
    });

    expect(result.validationEvidenceMissingCount).toBe(1);
    expect(result.readyForMainAcceptanceCount).toBe(1);
    expect(result.mainAcceptedCount).toBe(0);
    expect(result.partialCompletion).toBe(true);
    expect(result.items[0]!.validation).toBe("met-without-evidence");
    expect(result.items[1]!.readyForMainAcceptance).toBe(true);
  });

  test("durable todo 기록은 최신 정본과 explicit completion transition만 복원한다", () => {
    const details = {
      op: "done",
      phases: [{
        name: "구현",
        tasks: [{ content: "terminal 검증 근거를 TODO에 연결한다", status: "completed" }],
      }],
      completedTasks: [{ phase: "구현", content: "terminal 검증 근거를 TODO에 연결한다" }],
    };
    expect(readTodoCompletionReceipts(details))
      .toEqual(["terminal 검증 근거를 TODO에 연결한다"]);
    const restored = readPersistedTodoProgress([
      {
        type: "custom",
        customType: "user_todo_edit",
        data: {
          phases: [{
            name: "구현",
            tasks: [{ content: "child lifecycle 완료", status: "completed" }],
          }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          input: { op: "done", task: "terminal 검증 근거를 TODO에 연결한다" },
          details,
        },
      },
    ]);
    expect(restored.currentTodos).toHaveLength(1);
    expect(restored.currentTodos[0]).toMatchObject({
      content: "terminal 검증 근거를 TODO에 연결한다",
      status: "completed",
    });
    expect(restored.acceptedTodoBindingIds.has(restored.currentTodos[0]!.bindingId)).toBe(true);
  });

  test("자연어 완료나 child completed가 아니라 성공한 exact todo done만 Main 수용으로 센다", () => {
    expect(readExplicitTodoDoneTasks({ op: "done", task: "terminal 검증 근거를 TODO에 연결한다" }))
      .toEqual(["terminal 검증 근거를 TODO에 연결한다"]);
    expect(readExplicitTodoDoneTasks({ op: "done", task: "검증 근거" })).toEqual(["검증 근거"]);

    const completedState = advanceTodoProgressState(
      initialTodoState,
      currentTodos.map((todo) => ({
        content: todo.content,
        status: todo.content === "terminal 검증 근거를 TODO에 연결한다"
          ? "completed" as const
          : todo.status,
      })),
      { op: "done", task: "terminal 검증 근거를 TODO에 연결한다" },
      {
        op: "done",
        completedTasks: [{ content: "terminal 검증 근거를 TODO에 연결한다" }],
      },
    );
    const result = assessTodoProgress({
      metadata,
      currentTodos: completedState.currentTodos,
      todoBindings,
      validation: readTerminalValidation({
        validation: {
          "terminal 검증 근거를 TODO에 연결한다": { state: "met", evidence: "artifact://focused-test" },
        },
      }),
      acceptedTodoBindingIds: completedState.acceptedTodoBindingIds,
      revision: "rev-1",
      terminalError: false,
      unresolvedCount: 0,
    });
    expect(result.mainAcceptedCount).toBe(1);
    expect(result.unattributedCompletedCount).toBe(0);
    expect(result.items[1]!.mainAccepted).toBe(true);
  });

  test("유사 문구는 exact todo identity로 연결하지 않는다", () => {
    const mismatchedState = advanceTodoProgressState(
      createTodoProgressState(),
      [{ content: "카드 제목과 단계를 분리", status: "completed" }],
      { op: "init" },
    );
    const result = assessTodoProgress({
      metadata,
      currentTodos: mismatchedState.currentTodos,
      todoBindings: captureTodoBindings(metadata, mismatchedState.currentTodos),
      validation: readTerminalValidation({
        validation: {
          "카드 제목과 현재 단계를 분리한다": {
            state: "unverified",
            blocker: "초기 검증 금지 때문에 focused test 실행 승인 대기",
          },
          "terminal 검증 근거를 TODO에 연결한다": {
            state: "met",
            evidence_locator: "artifact://focused-test",
          },
        },
      }),
      acceptedTodoBindingIds: mismatchedState.acceptedTodoBindingIds,
      revision: "rev-2",
      terminalError: false,
      unresolvedCount: 0,
      purpose: "rework",
    });
    expect(result.currentExactCount).toBe(0);
    expect(result.currentMissingCount).toBe(2);
    expect(result.unboundBindingCount).toBe(2);
    expect(result.readyForMainAcceptanceCount).toBe(0);
    expect(result.reworkLinked).toBe(true);
  });

  test("init·삭제 후 재추가·terminal 뒤 reopen은 새 identity이고 block/unblock은 유지한다", () => {
    let state = advanceTodoProgressState(
      createTodoProgressState(),
      [{ content: "같은 문구", status: "pending" }],
      { op: "init" },
    );
    const firstId = state.currentTodos[0]!.bindingId;
    state = advanceTodoProgressState(
      state,
      [{ content: "같은 문구", status: "completed" }],
      { op: "done", task: "같은 문구" },
      { op: "done", completedTasks: [{ content: "같은 문구" }] },
    );
    expect(state.acceptedTodoBindingIds.has(firstId)).toBe(true);

    const reset = advanceTodoProgressState(
      state,
      [{ content: "같은 문구", status: "completed" }],
      { op: "init" },
    );
    expect(reset.currentTodos[0]!.bindingId).not.toBe(firstId);
    expect(reset.acceptedTodoBindingIds.size).toBe(0);

    const removed = advanceTodoProgressState(reset, [], { op: "remove", task: "같은 문구" });
    const readded = advanceTodoProgressState(
      removed,
      [{ content: "같은 문구", status: "pending" }],
      { op: "add", task: "같은 문구" },
    );
    expect(readded.currentTodos[0]!.bindingId).not.toBe(reset.currentTodos[0]!.bindingId);

    const abandoned = advanceTodoProgressState(
      readded,
      [{ content: "같은 문구", status: "abandoned" }],
      { op: "abandon", task: "같은 문구" },
    );
    const reopened = advanceTodoProgressState(
      abandoned,
      [{ content: "같은 문구", status: "pending" }],
      { op: "reopen", task: "같은 문구" },
    );
    expect(reopened.currentTodos[0]!.bindingId).not.toBe(abandoned.currentTodos[0]!.bindingId);

    const blocked = advanceTodoProgressState(
      createTodoProgressState(),
      [{ content: "막힌 문구", status: "blocked" }],
      { op: "init" },
    );
    const unblocked = advanceTodoProgressState(
      blocked,
      [{ content: "막힌 문구", status: "in_progress" }],
      { op: "unblock", task: "막힌 문구" },
    );
    expect(unblocked.currentTodos[0]!.bindingId).toBe(blocked.currentTodos[0]!.bindingId);
  });

  test("persisted replay에서 같은 문구 init은 옛 done receipt를 승계하지 않는다", () => {
    const completed = {
      op: "done",
      phases: [{ name: "구현", tasks: [{ content: "같은 문구", status: "completed" }] }],
      completedTasks: [{ content: "같은 문구" }],
    };
    const replacement = {
      op: "init",
      phases: [{ name: "교체", tasks: [{ content: "같은 문구", status: "completed" }] }],
    };
    const state = readPersistedTodoProgress([
      {
        type: "custom",
        customType: "user_todo_edit",
        data: completed,
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          input: { op: "done", task: "같은 문구" },
          details: completed,
        },
      },
      {
        type: "custom",
        customType: "user_todo_edit",
        data: replacement,
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          input: { op: "init" },
          details: replacement,
        },
      },
    ]);
    expect(state.currentTodos).toHaveLength(1);
    expect(state.acceptedTodoBindingIds.size).toBe(0);
  });

  test("blocked와 abandoned는 근거가 있어도 완료 후보가 아니다", () => {
    for (const status of ["blocked", "abandoned"] as const) {
      const state = advanceTodoProgressState(
        createTodoProgressState(),
        [{ content: "카드 제목과 현재 단계를 분리한다", status }],
        { op: "init" },
      );
      const assessment = assessTodoProgress({
        metadata,
        currentTodos: state.currentTodos,
        todoBindings: captureTodoBindings(metadata, state.currentTodos),
        validation: readTerminalValidation({
          validation: {
            "카드 제목과 현재 단계를 분리한다": {
              state: "met",
              evidence: "artifact://focused-test",
            },
          },
        }),
        acceptedTodoBindingIds: state.acceptedTodoBindingIds,
        revision: "rev-status",
        terminalError: false,
        unresolvedCount: 0,
      });
      expect(assessment.readyForMainAcceptanceCount).toBe(0);
    }
  });
});
