import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { busyState, decide, discover, getState, originName, readState, resolveBusy, runSync, syncClone, withLock } from "./service";
import { GET, POST } from "../../app/api/repo-sync/route";
import { rejectUnauthorizedRequest } from "../api-request-guard";

const roots: string[] = [];
const servers: Bun.Server<undefined>[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.stop(true)); roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })); });
function git(path: string, ...args: string[]) {
  const run = spawnSync("git", ["-c", "user.name=Sync Test", "-c", "user.email=sync@example.invalid", ...args], { cwd: path, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}
function fixture(locked = false) {
  const home = mkdtempSync(join(tmpdir(), "cuelo-repo-sync-")); roots.push(home);
  const seed = join(home, "seed"), path = join(home, "src/Example");
  mkdirSync(seed); mkdirSync(join(home, "src"));
  git(seed, "init", "-b", "main"); writeFileSync(join(seed, "a"), "first\n"); git(seed, "add", "a"); git(seed, "commit", "-m", "first");
  git(home, "clone", seed, path);
  const running = { runningSessionIds: [] as string[], sessions: [] as { id: string; cwd: string }[] };
  const server = Bun.serve({ port: 0, fetch: (req) => {
    if (locked) {
      const rejected = rejectUnauthorizedRequest(req, new URL(req.url).pathname, { env: { NODE_ENV: "test", CUELO_PASSWORD: "isolated-repo-sync-test" }, file: join(home, "missing-auth.json") });
      if (rejected) return rejected;
    }
    return Response.json(req.url.includes("/running") ? { runningSessionIds: running.runningSessionIds } : { sessions: running.sessions });
  } });
  servers.push(server);
  return { home, seed, path, running, server: server.url.origin };
}
function advance(seed: string) { writeFileSync(join(seed, "a"), "second\n"); git(seed, "add", "a"); git(seed, "commit", "-m", "second"); }

test("clean behind clone fast-forwards, then stays current", async () => {
  const f = fixture(), before = git(f.path, "rev-parse", "HEAD"); advance(f.seed);
  const result = await syncClone({ name: "Example", path: f.path }, "main", f);
  assert.equal(result.outcome, "updated"); assert.equal(result.before, before);
  assert.equal(result.after, git(f.seed, "rev-parse", "HEAD"));
  assert.equal((await syncClone({ name: "Example", path: f.path }, "main", f)).outcome, "current");
});
for (const reason of ["dirty", "detached", "other-branch", "untracked", "git-lock", "busy", "unknown-idle", "ahead", "diverged", "fetch-error", "ff-error"] as const) {
  test(`skips ${reason} without changing HEAD`, async () => {
    const f = fixture();
    if (reason === "dirty") writeFileSync(join(f.path, "untracked"), "keep");
    if (reason === "detached") git(f.path, "checkout", "--detach");
    if (reason === "other-branch") git(f.path, "checkout", "-b", "work");
    if (reason === "untracked") git(f.path, "branch", "--unset-upstream");
    if (reason === "git-lock") writeFileSync(join(f.path, ".git/index.lock"), "owner");
    if (reason === "busy") { f.running.runningSessionIds = ["root.child"]; f.running.sessions = [{ id: "root", cwd: f.path }]; }
    if (reason === "unknown-idle") f.running.runningSessionIds = ["unknown"];
    if (reason === "ahead" || reason === "diverged") { writeFileSync(join(f.path, "local"), "local"); git(f.path, "add", "local"); git(f.path, "commit", "-m", "local"); }
    if (reason === "diverged" || reason === "ff-error") advance(f.seed);
    if (reason === "fetch-error") git(f.path, "remote", "set-url", "origin", join(f.home, "missing"));
    if (reason === "ff-error") {
      // A valid Git configuration can reject a merge even after the safety checks.
      git(f.path, "config", "merge.verifySignatures", "true");
    }
    const before = git(f.path, "rev-parse", "HEAD");
    const result = await syncClone({ name: "Example", path: f.path }, "main", f);
    assert.equal(result.reason, reason); assert.equal(git(f.path, "rev-parse", "HEAD"), before);
  });
}
test("discovery accepts owned origins, excludes runtime symlinks and linked worktrees", async () => {
  const f = fixture();
  git(f.path, "remote", "set-url", "origin", "git@github.com:gim47656-ship-it/Example.git");
  git(f.path, "worktree", "add", "-b", "wt/test", join(f.home, "src/linked"));
  git(f.home, "clone", f.seed, join(f.home, "cuelo-run"));
  git(join(f.home, "cuelo-run"), "remote", "set-url", "origin", "https://github.com/gim47656-ship-it/CUELO-private.git");
  symlinkSync(join(f.home, "cuelo-run"), join(f.home, "src/runtime"));
  writeFileSync(join(f.home, "src/notes.txt"), "not a directory");
  assert.deepEqual(await discover(f), [{ name: "Example", path: f.path }]);
  assert.equal(originName("https://github.com/other/Example.git"), null);
  assert.equal(originName("https://github.com/gim47656-ship-it/Example.git"), "Example");
});
test("cross-process lock rejects overlap and releases for next action", async () => {
  const f = fixture();
  await withLock(f, async () => { await assert.rejects(withLock(f, async () => undefined), /already running/); });
  await withLock(f, async () => undefined);
});
test("decisions survive calls and invalid names or existing paths are refused", async () => {
  const f = fixture(); mkdirSync(join(f.home, ".omp/agent"), { recursive: true });
  writeFileSync(join(f.home, ".omp/agent/repo-sync.json"), JSON.stringify({ version: 1, accountStatus: "ok", repos: [{ name: "Example" }], decisions: {}, clones: {}, results: [], unresolvedRunningIds: 0 }));
  await decide("Example", "decline", f); assert.equal(readState(f).decisions.Example, "decline");
  await decide("Example", "undecline", f); assert.deepEqual(readState(f).decisions, {});
  await assert.rejects(decide("../outside", "clone", f), /not in account/);
  await assert.rejects(decide("Unknown", "clone", f), /not in account/);
  await assert.rejects(decide("Example", "clone", f), /already exists/);
  assert.equal((await getState(f)).uncloned.length, 1); // fixture origin is local, not account-owned
});
test("busy ID mapping uses root cwd and unknown IDs fail closed", async () => {
  const f = fixture();
  assert.deepEqual(resolveBusy(["root.child.nested"], [{ id: "root", cwd: f.path }]), { cwds: [f.path], unresolved: 0 });
  f.running.runningSessionIds = ["missing"];
  assert.equal((await busyState(f)).known, false);
});
test("cached account list survives gh failure; repeated skips retain success time", async () => {
  const f = fixture();
  git(f.path, "remote", "set-url", "origin", "https://github.com/gim47656-ship-it/Example.git");
  writeFileSync(join(f.path, "dirty"), "keep");
  mkdirSync(join(f.home, ".omp/agent"), { recursive: true });
  const saved = { version: 1, accountStatus: "ok", repos: [{ name: "Example", defaultBranchRef: { name: "main" } }], decisions: {}, clones: {}, results: [{ name: "Example", path: f.path, outcome: "current", skipCount: 0, lastSuccess: "2026-11-01T00:00:00.000Z" }], unresolvedRunningIds: 0 };
  writeFileSync(join(f.home, ".omp/agent/repo-sync.json"), JSON.stringify(saved));
  const bin = join(f.home, "bin"); mkdirSync(bin); writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const old = process.env.PATH; process.env.PATH = bin + ":" + old;
  try {
    const state = await runSync(f); assert.equal(state.accountStatus, "auth"); assert.equal(state.repos[0].name, "Example");
    assert.equal(JSON.parse(readFileSync(join(f.home, ".omp/agent/repo-sync.json"), "utf8")).accountStatus, "auth");
    assert.equal(state.results[0].reason, "dirty"); assert.equal(state.results[0].skipCount, 1);
    const again = await runSync(f);
    assert.equal(again.results[0].skipCount, 2); assert.equal(again.results[0].lastSuccess, saved.results[0].lastSuccess);
  } finally { process.env.PATH = old; }
});
test("API rejects untrusted, non-JSON, malformed and unlisted actions", async () => {
  assert.equal((await GET(new Request("http://evil.example/api/repo-sync"))).status, 403);
  assert.equal((await POST(new Request("http://evil.example/api/repo-sync", { method: "POST" }))).status, 403);
  const req = (body: string, type = "application/json") => new Request("http://127.0.0.1/api/repo-sync", { method: "POST", headers: { Host: "127.0.0.1", "Content-Type": type }, body });
  assert.equal((await POST(req("{}", "text/plain"))).status, 415);
  assert.equal((await POST(req("{"))).status, 400);
  assert.equal((await POST(req('{"name":"x","action":"reset"}'))).status, 400);
  assert.equal((await POST(req('{"name":"../outside","action":"clone"}'))).status, 400);
});
test("failed gh clone releases empty reservation and can retry", async () => {
  const f = fixture(), bin = join(f.home, "bin"); mkdirSync(bin);
  mkdirSync(join(f.home, ".omp/agent"), { recursive: true });
  writeFileSync(join(f.home, ".omp/agent/repo-sync.json"), JSON.stringify({ version: 1, accountStatus: "ok", repos: [{ name: "Missing" }], decisions: {}, clones: {}, results: [], unresolvedRunningIds: 0 }));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const old = process.env.PATH; process.env.PATH = bin + ":" + old;
  try {
    await decide("Missing", "clone", f);
    assert.equal(readState(f).clones.Missing.error, "auth");
    await runSync(f);
    await decide("Missing", "clone", f);
    assert.equal(readState(f).clones.Missing.status, "failed");
  } finally { process.env.PATH = old; }
});
test("locked server uses fresh process snapshot to fast-forward behind clone", async () => {
  const f = fixture(true); advance(f.seed);
  const port = Number(new URL(f.server).port), dir = join(f.home, ".omp/agent/cuelo-busy-cwds");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${port}-${process.pid}.json`), JSON.stringify({ writtenAt: Date.now(), pid: process.pid, port, cwds: [], unresolved: 0, appDir: f.seed }), { mode: 0o600 });
  assert.equal((await fetch(f.server + "/api/agent/running")).status, 401);
  const result = await syncClone({ name: "Example", path: f.path }, "main", f);
  assert.equal(result.outcome, "updated", JSON.stringify(result));
});
for (const mode of ["busy", "sibling-busy", "stale", "missing", "unresolved"] as const) {
  test(`locked snapshot boundary: ${mode}`, async () => {
    const f = fixture(true); advance(f.seed);
    const port = Number(new URL(f.server).port), dir = join(f.home, ".omp/agent/cuelo-busy-cwds");
    mkdirSync(dir, { recursive: true });
    const snapshot = { writtenAt: mode === "stale" ? Date.now() - 120_001 : Date.now(), pid: process.pid, port, cwds: mode === "busy" ? [f.path] : [], unresolved: mode === "unresolved" ? 1 : 0, appDir: f.seed };
    if (mode !== "missing") writeFileSync(join(dir, `${port}-${process.pid}.json`), JSON.stringify(snapshot), { mode: 0o600 });
    if (mode === "sibling-busy") writeFileSync(join(dir, `30163-${process.pid}.json`), JSON.stringify({ ...snapshot, port: 30163, cwds: [f.path] }), { mode: 0o600 });
    const before = git(f.path, "rev-parse", "HEAD");
    const result = await syncClone({ name: "Example", path: f.path }, "main", f);
    assert.equal(result.reason, mode.includes("busy") ? "busy" : mode === "unresolved" ? "unknown-idle" : "server-auth");
    assert.equal(git(f.path, "rev-parse", "HEAD"), before);
  });
}
test("running install clone is excluded before any fetch", async () => {
  const f = fixture();
  git(f.path, "remote", "set-url", "origin", "https://github.com/gim47656-ship-it/CUELO.git");
  const old = process.env.CUELO_APP_DIR; process.env.CUELO_APP_DIR = f.path;
  try { assert.deepEqual(await discover(f), []); }
  finally { if (old === undefined) delete process.env.CUELO_APP_DIR; else process.env.CUELO_APP_DIR = old; }
});
test("live running IDs cannot be replaced by idle snapshot after session API 503", async () => {
  const f = fixture();
  const server = Bun.serve({ port: 0, fetch: req => req.url.includes("/running") ? Response.json({ runningSessionIds: ["active"] }) : new Response("unavailable", { status: 503 }) });
  servers.push(server);
  const port = server.port, dir = join(f.home, ".omp/agent/cuelo-busy-cwds"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${port}-${process.pid}.json`), JSON.stringify({ writtenAt: Date.now(), pid: process.pid, port, cwds: [], unresolved: 0, appDir: f.seed }), { mode: 0o600 });
  assert.equal((await busyState({ home: f.home, server: server.url.origin })).known, false);
});
