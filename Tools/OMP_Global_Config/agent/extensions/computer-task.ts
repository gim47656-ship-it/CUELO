import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
// The runtime package is rewritten to the host SDK path by the legacy-pi extension loader, so it is imported lazily below.
import { COMPUTER_ROLE, runComputerTask, spawnChild, type ComputerTaskDeps, type ComputerTaskInput, type ComputerTaskResult } from "./lib/computer-task";

/**
 * computer_task: runs a multi-step desktop goal on the `modelRoles.computer` model in a child omp session and returns
 * what it observed (2026-10-27 user decision; evidence doc/history/2026/10/27-terra-sol-eval/computer). Main and Makers
 * call this for multi-step goals; a single read-only observation can still use `computer` directly. The tool drives the
 * real desktop with the same boundary as `computer` (`tools.approval.computer`), and it is serialized per process.
 */

async function resolveDeps(ctx: ExtensionContext): Promise<ComputerTaskDeps> {
  const { findScopedSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  return { selector: findScopedSettings(ctx.cwd)?.getModelRole(COMPUTER_ROLE), exe: process.env.OMP_EXE, env: process.env, spawn: spawnChild };
}

export function toolResult(result: ComputerTaskResult): { content: [{ type: "text"; text: string }]; isError?: true } {
  return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true as const } : {}) };
}

export default function computerTask(pi: ExtensionAPI): void {
  const z = pi.zod;
  pi.registerTool({
    name: "computer_task", label: "Computer Task", loadMode: "essential",
    // Same boundary as `computer`: core consults `tools.approval.computer` (falling back to `computer_task`) for this tier.
    approval: { tier: "exec", policyKey: "computer" },
    description: "Hand ONE multi-step desktop (computer use) goal to a worker that runs on the modelRoles.computer model and get back what it observed. "
      + "Use it for multi-step desktop work (launch, locate, set, read back); a single read-only observation can still use `computer` directly. "
      + "`goal` is what to achieve, `target` names the only window or app it may touch (one you launched or the user named), `done` is the observable "
      + "success condition it must read back after acting. It never presses irreversible buttons and touches nothing else. The result starts with "
      + "`computer_task: DONE` or `computer_task: NOT DONE` and shows the resolved model, wall time, tool calls and tool errors; a done:false report, "
      + "a timeout, an abort or a malformed answer is always NOT DONE (isError). Calls in one process run one at a time. `timeoutSec` defaults to 600 (10-1800). "
      + "Verify independently when the outcome matters: this is the worker's report, not proof.",
    parameters: z.object({
      goal: z.string().describe("What to achieve on the desktop, step by step if needed."),
      target: z.string().describe("The only window/app the worker may touch: one you launched or the user named."),
      done: z.string().describe("The observable success condition to read back after acting."),
      timeoutSec: z.number().optional().describe("Seconds before the worker is killed. Default 600, clamped to 10-1800."),
    }) as never,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const deps = await resolveDeps(ctx);
      return toolResult(await runComputerTask(params as ComputerTaskInput, deps, signal ?? new AbortController().signal));
    },
  });
}
