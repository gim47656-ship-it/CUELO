import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { onSessionLifecycle } from "../../extensions/lib/session-identity";
import { LiveServices, UnreapedJobs } from "../../extensions/lib/turn-jobs";
import type { TurnEndNotices } from "../../extensions/turn-end-guard";

export default function unreapedJobs(pi: ExtensionAPI): void {
  const services = new LiveServices();
  const retainedServices = new Set<string>();
  const unreaped = new UnreapedJobs();
  let jobsNotedThisInput = false;
  let shuttingDown = false;
  const reset = () => {
    services.clear();
    retainedServices.clear();
    unreaped.reset();
    jobsNotedThisInput = false;
  };
  onSessionLifecycle(pi, { start: () => { reset(); shuttingDown = false; } });
  pi.on("session_shutdown", () => { reset(); shuttingDown = true; });
  pi.on("input", (event) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    shuttingDown = false;
    jobsNotedThisInput = false;
  });
  pi.on("tool_result", (event, ctx) => {
    if (shuttingDown || ctx.agent?.kind === "sub") return;
    services.observe(event);
    const input = event.input as { action?: unknown; service?: unknown } | undefined;
    if (event.toolName === "test_session" && !event.isError && input?.action === "track" && typeof input.service === "string") {
      services.forget(input.service);
      retainedServices.add(input.service);
    }
  });
  // The guard owns timing and the single aside; this plugin owns only its optional final fragment.
  pi.events.on("cuelo:turn-end-notices", (data) => {
    const { ctx, notices } = data as TurnEndNotices;
    if (shuttingDown || ctx.agent?.kind === "sub" || jobsNotedThisInput) return;
    const notice = unreaped.note(ctx.getAsyncJobSnapshot?.()?.running ?? [], services.names().filter(name => !retainedServices.has(name)));
    if (!notice) return;
    jobsNotedThisInput = true;
    notices.push(notice);
  });
}
