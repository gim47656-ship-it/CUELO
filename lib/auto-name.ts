import type { SessionInfo } from "./types";

/**
 * Why title generation is unavailable, or null when it can run. Auto-naming
 * reads the session JSONL on the server, so a session that exists only in
 * memory, or one with no message on disk yet, has nothing to name.
 */
export type AutoNameBlock = "unsaved" | "no-messages";

export function autoNameBlockReason(
  session: SessionInfo | null | undefined,
  persistedUserMessages: number | null | undefined,
): AutoNameBlock | null {
  if (!session || session.transient) return "unsaved";
  const userMessages = typeof persistedUserMessages === "number" ? persistedUserMessages : 0;
  if (userMessages > 0 || session.messageCount > 0) return null;
  return "no-messages";
}
