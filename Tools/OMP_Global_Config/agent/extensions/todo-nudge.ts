import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createQuietDelivery } from "./lib/quiet-delivery";
import { onSessionLifecycle } from "./lib/session-identity";
import { readPersistedTodoProgress, readTodoSnapshot, type TodoSnapshotItem } from "./lib/task-progress";

// 사용자 직접 입력 하나에서 todo 없이 읽기 전용이 아닌 도구를 다섯 번 부르면 안내한다.
// 2026-10-08 사용자 결정: 요청 분류용 JEV 호출을 두지 않는다. 결정론적 횟수 규칙만 쓴다.
// 2026-10-28 표본(doc/history/2026/10/28-guard-trim/advisory): 세 번째 호출 알림 281건 중 비-todo 호출이 넷 이하로 끝난 요청이
// 93건(미추종 61)이었고, 미추종 표본 25건 중 17건이 짧은 질문·조회라 목록이 필요 없었다. 그래서 다섯 번째 호출로 늦춘다.
const TOOL_CALLS_BEFORE_NUDGE = 5;

// Registered read-only tools: file reads/searches, skim, web search and AST queries.
// LSP is mixed-mode: only the core's read-only actions are exempt. Unknown modes, bash and eval count.
const READ_ONLY_TOOLS: Record<string, true> = {
  read: true, grep: true, find: true, glob: true, skim: true, web_search: true, ast_grep: true,
};
const READ_ONLY_LSP_ACTIONS: Record<string, true> = {
  diagnostics: true, definition: true, type_definition: true, implementation: true, references: true,
  hover: true, symbols: true, status: true, capabilities: true,
};

type RequestSlot = { claimed: boolean; fifthReminder?: { content: string; atStop: boolean } };
type Request = { slot: RequestSlot; currentCoreSlot?: () => RequestSlot | undefined };

const REMINDER =
  "이번 사용자 요청에서 todo 없이 도구를 이어 부르고 있다. 여러 항목 또는 3단계 이상 작업이면 지금 todo 를 init 해서 요청 항목을 빠짐없이 나누고, 진행에 맞춰 상태를 갱신하며 이어 가라.";

// 2026-10-10 실측(Main 세션 기록 ~2주): 작업 종료·Maker 보고·DM 알림이 와도 활성 todo 가 있는 경우 같은 요청 안에
// todo 호출이 없던 비율이 task 25%·bash/eval 39%·DM 36%였고, 호출이 있어도 중앙값이 92~171초였다. 알림은 상태 전환이
// 일어난 시점이므로 그때 한 번 갱신을 일깨운다. todo 를 부르면 다음 알림에서 다시 안내한다(알림마다 반복하지 않는다).
// 2026-10-28 표본: 편집 전 체크포인트(`위치:`/`LOCATION:`)와 child 활동 advisory DM은 승인·관측 요청이라 todo 상태 전환이 아니다.
const NON_TRANSITION_DM = /(?:^|\n)\s*(?:위치|LOCATION)\s*:|\[Child activity advisory/;
const NOTICE_REMINDER =
  "작업 종료·Maker 보고·DM 알림이 도착했다. 이 알림으로 todo 항목의 상태가 바뀌었으면(착수·완료·재개·실패) 사용자에게 보고하거나 다음 도구를 부르기 전에 `todo` 로 바로 갱신하라. 외부 대기는 답변 문장에 적는다. todo 메모에 적힌 외부 job 상태는 적은 시각의 값이므로 사실처럼 옮기지 말고 현재 상태를 다시 읽는다.";
// 2026-10-30 사용자 결정(B5): 코어의 mid-run todo 알림이 2분 안에 이미 왔으면 같은 일깨움이라 도착 알림을 내지 않는다
// (1.6일 표본에서 11건 중복, doc/history/2026/10/30-harness-friction).
const CORE_NUDGE_TYPE = "mid-run-todo-nudge";
const CORE_NUDGE_WINDOW_MS = 2 * 60_000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n") : "";
}

export function createTodoNudge(now: () => number = Date.now) {
  return function todoNudge(pi: ExtensionAPI): void {
  let request: Request | undefined;
  let usedTodo = false;
  const queuedFifth = new WeakMap<object, Request>();
  let calls = 0;
  let todos: readonly TodoSnapshotItem[] = [];
  let noticeNudged = false;
  let coreNudgedAt = Number.NEGATIVE_INFINITY;
  // wait를 끊거나 끝난 턴을 다시 열지 않는다(2026-11-16, 7일 표본에서 wait 끊김 11).
  const quiet = createQuietDelivery({
    on: pi.on,
    sendMessage(message, options) {
      const owner = typeof message === "object" ? queuedFifth.get(message) : undefined;
      if (!owner) return pi.sendMessage(message, options); // Arrival reminder.
      if (request !== owner) return;
      if (!owner.currentCoreSlot) return pi.sendMessage(message, options); // Standalone OMP without the SDK patch.
      if (owner.currentCoreSlot() !== owner.slot) return;
      // Core polls the current request at injection time, even if newer input arrives after this tool result.
      owner.slot.fifthReminder = { content: REMINDER, atStop: options?.deliverAs === "aside" };
    },
  });

  onSessionLifecycle(pi, {
    start: (ctx) => {
      request = undefined;
      noticeNudged = false;
      coreNudgedAt = Number.NEGATIVE_INFINITY;
      todos = readPersistedTodoProgress(ctx.sessionManager.getBranch()).currentTodos;
    },
    // 같은 세션을 다시 읽는 reload: 요청 단위 상태는 두고 durable todo만 다시 읽는다.
    reload: (ctx) => {
      todos = readPersistedTodoProgress(ctx.sessionManager.getBranch()).currentTodos;
    },
  });
  pi.on("session_shutdown", () => {
    request = undefined;
  });
  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    const manager = ctx.sessionManager as typeof ctx.sessionManager & {
      getCueloTodoNudgeRequest?: () => RequestSlot | undefined;
    };
    const currentCoreSlot = manager.getCueloTodoNudgeRequest?.bind(manager);
    const slot = currentCoreSlot?.();
    request = slot ? { slot, currentCoreSlot } : { slot: { claimed: false } };
    usedTodo = false;
    calls = 0;
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "todo" || event.isError) return;
    const snapshot = readTodoSnapshot(event.details);
    if (snapshot) todos = snapshot;
  });
  pi.on("message_start", (event, ctx) => {
    const message = event.message as { role?: string; customType?: string; content?: unknown };
    if (message.role === "custom" && message.customType === CORE_NUDGE_TYPE) {
      coreNudgedAt = now();
      if (request && !request.currentCoreSlot) request.slot.claimed = true;
      return;
    }
    if (message.role !== "custom" || (message.customType !== "async-result" && message.customType !== "irc:incoming")) return;
    if (message.customType === "irc:incoming" && NON_TRANSITION_DM.test(textOf(message.content))) return;
    if (ctx.agent?.kind !== "main" || noticeNudged) return;
    if (!todos.some((item) => item.status === "pending" || item.status === "in_progress")) return;
    if (now() - coreNudgedAt < CORE_NUDGE_WINDOW_MS) return;
    noticeNudged = true;
    quiet({ customType: "todo-nudge", content: NOTICE_REMINDER, display: false, attribution: "agent" }, ctx);
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "todo") noticeNudged = false;
    if (!request || request.slot.claimed || usedTodo || calls >= TOOL_CALLS_BEFORE_NUDGE) return;
    if (request.currentCoreSlot && request.currentCoreSlot() !== request.slot) return;
    if (event.toolName === "todo") {
      usedTodo = true;
      return;
    }
    if (Object.hasOwn(READ_ONLY_TOOLS, event.toolName)) return;
    if (event.toolName === "lsp" && "action" in event.input &&
        typeof event.input.action === "string" && Object.hasOwn(READ_ONLY_LSP_ACTIONS, event.input.action)) return;
    if (++calls < TOOL_CALLS_BEFORE_NUDGE) return;
    // 이전 요청의 진행 중 목록이 있으면 이미 추적 중이다.
    if (todos.some((item) => item.status === "pending" || item.status === "in_progress")) return;
    request.slot.claimed = true;
    const message = { customType: "todo-nudge", content: REMINDER, display: false, attribution: "agent" as const };
    queuedFifth.set(message, request);
    quiet(message, ctx);
  });
  };
}

export default createTodoNudge();
