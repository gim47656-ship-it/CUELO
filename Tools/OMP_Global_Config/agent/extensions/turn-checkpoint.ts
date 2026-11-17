import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CheckpointError, listCheckpoints, restoreCheckpoint, snapshotTurn } from "./lib/turn-checkpoint-git";

interface Params { action: "list" | "restore"; turn?: number; phase?: "pre" | "post" }

export default function turnCheckpoint(pi: ExtensionAPI): void {
  const turns = new Map<string, number>();
  const capture = async (phase: "pre" | "post", ctx: ExtensionContext) => {
      const id = ctx.sessionManager.getSessionId();
      try {
        const saved = await snapshotTurn(ctx.cwd, id, phase, phase === "post" ? turns.get(id) : undefined);
        if (phase === "pre") turns.set(id, saved.turn);
      } catch (error) {
        pi.logger.debug("turn-checkpoint: skipped", { sessionId: id, phase, reason: error instanceof Error ? error.message : String(error) });
      } finally {
        if (phase === "post") turns.delete(id);
      }
  };
  pi.on("turn_start", async (_event, ctx) => capture("pre", ctx));
  pi.on("turn_end", async (_event, ctx) => capture("post", ctx));
  const z = pi.zod;
  pi.registerTool({
    name: "checkpoint_restore", label: "Turn Checkpoint", loadMode: "discoverable", approval: "write",
    description: "Main-only git working-tree checkpoints for this session. action=list lists saved turns (pre/post). "
      + "Only after an explicit user request to restore a specific checkpoint, use action=restore with turn and optional phase (default post). "
      + "Restore replaces tracked and non-ignored untracked files, refuses stale_diff if the checkout differs from the latest checkpoint, "
      + "and refuses ignored-file/empty-directory obstructions and nested repository changes. Unchanged nested repositories are preserved. HEAD, branches and the shared index stay unchanged. "
      + "A restore records a new post checkpoint as the baseline. This does not rewind conversation history. No web button.",
    parameters: z.object({
      action: z.enum(["list", "restore"]),
      turn: z.number().int().positive().optional(),
      phase: z.enum(["pre", "post"]).optional(),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        if (ctx.agent?.kind !== "main") throw new CheckpointError("main_only", "checkpoint_restore is Main-only.");
        const input = params as Params;
        const id = ctx.sessionManager.getSessionId();
        let details: unknown;
        if (input.action === "list") details = { checkpoints: await listCheckpoints(ctx.cwd, id) };
        else {
          if (!input.turn) throw new CheckpointError("turn_missing", "restore requires a turn from action=list.");
          details = { restored: await restoreCheckpoint(ctx.cwd, id, input.turn, input.phase) };
          // A restore during an agent turn advanced the baseline; turn_end must use the next number.
          turns.delete(id);
        }
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      } catch (error) {
        const details = error instanceof CheckpointError ? { code: error.code, changedFiles: error.changedFiles } : undefined;
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details, isError: true };
      }
    },
  });
}
