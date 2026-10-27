import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CHILD_ENV, CHILD_TOOLS } from "./computer-task";

/** Loaded explicitly by computer_task; never discovered by ordinary sessions. */
export default function computerTaskScope(pi: ExtensionAPI): void {
  if (!process.env[CHILD_ENV]) return;
  pi.on("session_start", async () => {
    try {
      // CLI --tools selects built-ins but ambient extension/custom tools may still be active.
      // The SDK setter also replaces the enabled eval bridge set and xd:// mounts.
      await pi.setActiveTools(CHILD_TOOLS.split(","));
    } catch (error) {
      // The extension runner logs rejected hooks and continues. This dedicated process must not.
      console.error(`computer_task: could not enforce tool boundary: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });
}
