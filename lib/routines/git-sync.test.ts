import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncRoutineRepo } from "./git-sync";

// A phone install pins the routines deploy key in the repository (`core.sshCommand`). The server's own
// non-interactive default must not replace it, or every fetch fails with `Permission denied (publickey)`.
test("sync uses the repository's core.sshCommand, adding BatchMode, when GIT_SSH_COMMAND is unset", async () => {
  const root = mkdtempSync(join(tmpdir(), "routine-ssh-"));
  const saved = process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH_COMMAND;
  try {
    const repo = join(root, "repo");
    const marker = join(root, "ssh-args");
    const fakeSsh = join(root, "fake-ssh");
    writeFileSync(fakeSsh, `#!/bin/sh\necho "$@" > '${marker}'\nexit 1\n`);
    chmodSync(fakeSsh, 0o755);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
    git("remote", "add", "origin", "git@github.invalid:owner/routines.git");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("branch", "--set-upstream-to=origin/main", "main");
    git("config", "core.sshCommand", `${fakeSsh} -i /keys/routine_key`);

    await syncRoutineRepo(repo);

    expect(existsSync(marker)).toBe(true);
    const args = readFileSync(marker, "utf8");
    expect(args).toContain("-i /keys/routine_key");
    expect(args).toContain("BatchMode=yes");
  } finally {
    if (saved === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = saved;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
