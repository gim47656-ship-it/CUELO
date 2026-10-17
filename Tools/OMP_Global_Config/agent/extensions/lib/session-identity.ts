import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * 세션별 상태를 가진 확장의 공통 수명주기. core는 `session_start`를 런타임 초기화 때 한 번만 보내고,
 * `/new`·resume·fork·reload는 `session_switch`로 알린다. reload는 같은 세션 파일을 다시 읽는 switch라 session id가 그대로다.
 *
 * - `start`: `session_start`, 그리고 다른 session id로 옮겨 간 `session_switch`. 이전 세션의 상태를 비우고 새 세션의 durable 상태를 읽는다.
 * - `reload`: session id가 그대로인 `session_switch`. 진행 중인 작업은 같은 세션의 것이므로 비우지 않는다. 필요하면 durable 상태만 다시 읽는다.
 *
 * 이전 id를 알 수 없거나 새 id를 읽지 못하면 같은 세션이라는 증거가 없으므로 `start`로 본다.
 */
export function onSessionLifecycle(
  pi: Pick<ExtensionAPI, "on">,
  handlers: { start(ctx: ExtensionContext): void; reload?(ctx: ExtensionContext): void },
): void {
  let current: string | undefined;
  const idOf = (ctx: ExtensionContext): string | undefined => {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" ? id : undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    current = idOf(ctx);
    handlers.start(ctx);
  });
  pi.on("session_switch", (_event, ctx) => {
    const next = idOf(ctx);
    if (next !== undefined && next === current) {
      handlers.reload?.(ctx);
      return;
    }
    current = next;
    handlers.start(ctx);
  });
}
