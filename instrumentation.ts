/**
 * Next calls `register` once when a server process starts (`next dev`, `next start`), never during
 * `next build` (registerInstrumentation returns early in `phase-production-build`). Node-only work is
 * imported inside the runtime check so the edge bundle never pulls in `node:fs`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { ensureAttachmentCleanupScheduler } = await import("./lib/attachment-cleanup");
  ensureAttachmentCleanupScheduler();
}
