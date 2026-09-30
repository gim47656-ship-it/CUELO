/**
 * A running turn that has delivered no event for this long is shown as possibly
 * stalled. The event stream's 30s heartbeat is an SSE comment the page never
 * sees, so silence here means no agent data at all - not a dropped socket.
 */
export const RUN_STALL_MS = 3 * 60 * 1000;
/** How often a running turn re-checks its silence. */
export const RUN_STALL_CHECK_MS = 10 * 1000;

export function isRunStalled(running: boolean, lastEventAt: number, now: number): boolean {
  return running && now - lastEventAt >= RUN_STALL_MS;
}
