import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.env.CUELO_WORKTREE_BOUNDARY_CASE;
if (!mode) {
  for (const name of ["route", "queue", "startup"]) test(`worktree boundary ${name}`, () => {
    const result = spawnSync(process.execPath, ["run", import.meta.filename], {
      cwd: process.cwd(), env: { ...process.env, CUELO_WORKTREE_BOUNDARY_CASE: name }, encoding: "utf8", timeout: 30_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`BOUNDARY OK ${name}`);
  });
} else {
  const root = mkdtempSync(join(tmpdir(), "cuelo-worktree-boundary-"));
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = root;
  const id = "a0000000-0000-0000-0000-000000000001";
  try {
    if (mode === "route") {
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode) throw new Error(result.stderr.toString());
      };
      git("init", "-q", "--initial-branch=main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
      writeFileSync(join(root, "base"), "base"); git("add", "."); git("commit", "-qm", "base");
      mock.module("../rpc-manager", () => ({
        getLiveSessionWorktreeUses: () => [], reserveWorktreeRemoval: () => ({ busy: [], release() {} }),
        startNewRpcSession: async (_request: unknown, cwd: string) => ({ realSessionId: id, session: { cwd, isAlive: () => true, send: async () => ({}) } }),
      }));
      mock.module("../session-reader", () => ({ invalidateSessionListCache() {}, listAllSessions: async () => [] }));
      mock.module("../file-access", () => ({ allowFileRoot() {}, getAllowedFileRoots: async () => [root], isExistingFilePathAllowed: () => true }));
      mock.module("../omp-runtime", () => ({ findModelWithRecovery() {}, getOmpRuntime() {} }));
      mock.module("../update-maintenance", () => ({ getUpdateMutationBlock: () => null }));
      const { POST } = await import("../../app/api/agent/new/route");
      for (const flag of [true, undefined, false]) {
        const response = await POST(new Request("http://localhost:30141/api/agent/new", {
          method: "POST", headers: { "Content-Type": "application/json", Host: "localhost:30141", Origin: "http://localhost:30141" },
          body: JSON.stringify({ cwd: root, type: "ensure_session", ...(flag === undefined ? {} : { autoWorktree: flag }) }),
        }));
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        if (flag === true) expect(body.cwd).toMatch(/-worktrees\/wt-s-\d{8}-[a-f0-9]{8}$/);
        else expect(body.cwd).toBe(root);
        console.log(`POST autoWorktree=${flag}: ${flag === true ? "fresh wt/s" : "main"}`);
      }
    } else if (mode === "queue") {
      mock.module("../rpc-manager", () => ({
        getRunningRpcSessionIds: () => [id], getRpcSession: () => ({ send: async () => {}, stopBackgroundWorkForDrain: async () => true }), startRpcSession() {},
      }));
      mock.module("../session-reader", () => ({ buildSessionContext() {}, getSessionEntries() {}, resolveSessionPath() {} }));
      mock.module("../subagent-revive", () => ({ restoreReleasedChildren() {} }));
      mock.module("../update-wake", () => ({ notifyUpdateFailureToInitiator() {}, SERVER_FAILURE_CLIENT_ID: "test", wakeInitiatorWithoutReturningTab() {} }));
      const { handleInterruptRequest } = await import("../update-interrupt");
      mkdirSync(join(root, "interrupts"));
      writeFileSync(join(root, "interrupts", "request.json"), JSON.stringify({ id: "boundary", atUtc: new Date().toISOString() }));
      expect(await handleInterruptRequest(new Set(), new Set())).toBe(true);
      const { pendingResumeIds } = await import("./maintenance");
      expect(await pendingResumeIds()).toEqual(new Set([id]));
      console.log("real interrupt writer -> pendingResumeIds preserves queued session");
    } else if (mode === "startup") {
      const events: string[] = [];
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      const { promise: finished, resolve: swept } = Promise.withResolvers<void>();
      mock.module("../attachment-cleanup", () => ({ ensureAttachmentCleanupScheduler() {} }));
      mock.module("../routines/scheduler", () => ({ ensureRoutineScheduler() {} }));
      mock.module("../session-busy-state", () => ({ ensureSessionBusyStateWriter: async () => {} }));
      mock.module("../update-interrupt", () => ({ recoverAbruptStop: async () => { events.push("recovery-start"); await gate; events.push("recovery-done"); return { queued: [id] }; } }));
      mock.module("./runtime", () => ({ maintainRecordedSessionWorktrees: async () => { events.push("sweep"); swept(); } }));
      process.env.NEXT_RUNTIME = "nodejs";
      const { register } = await import("../../instrumentation");
      await register();
      expect(events).not.toContain("sweep"); // Readiness is not blocked by recovery or cleanup.
      release(); await finished;
      expect(events).toEqual(["recovery-start", "recovery-done", "sweep"]);
      console.log("register returned before recovery; sweep followed recovery completion");
    }
    console.log(`BOUNDARY OK ${mode}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (existsSync(`${root}-worktrees`)) rmSync(`${root}-worktrees`, { recursive: true, force: true });
  }
}
