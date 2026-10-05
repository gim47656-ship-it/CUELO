/**
 * Next calls `register` once when a server process starts (`next dev`, `next start`), never during
 * `next build` (registerInstrumentation returns early in `phase-production-build`). Node-only work is
 * imported inside a positive `NEXT_RUNTIME === "nodejs"` branch, which the bundler folds away for the
 * edge compile; an early-return guard leaves the dynamic imports in the edge graph, where `crypto`/`node:fs`
 * do not resolve.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { ensureAttachmentCleanupScheduler } = await import("./lib/attachment-cleanup");
    ensureAttachmentCleanupScheduler();
    // 직전 서버 세대가 갑자기 죽어 끊긴 부모 세션을 기존 복구 대기열에 올린다. 서버 시작을 막지 않는다.
    void import("./lib/update-interrupt")
      .then(({ recoverAbruptStop }) => recoverAbruptStop())
      .then(({ queued }) => {
        if (queued.length > 0) console.log(`[update-interrupt] abrupt-stop recovery queued ${queued.length} session(s)`);
      })
      .catch((error) => console.error("[update-interrupt] abrupt-stop recovery failed:", error));
  }
}
