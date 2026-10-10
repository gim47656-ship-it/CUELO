import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncCheckout } from "./sync-checkout";

const cli = fileURLToPath(new URL("./sync-checkout.ts", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "sync-checkout-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
}

let counter = 0;
/** bare origin + source(commit 2개 게시) + target(첫 커밋 상태 clone, 무시 파일 보유). */
function fixture() {
  const dir = join(base, String(counter++));
  mkdirSync(dir);
  const origin = join(dir, "origin.git");
  const source = join(dir, "source");
  const target = join(dir, "target");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, source);
  writeFileSync(join(source, ".gitignore"), ".next/\n");
  writeFileSync(join(source, "a.txt"), "one\n");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "one");
  git(source, "push", "-q", "origin", "HEAD:main");
  git(dir, "clone", "-q", origin, target);
  mkdirSync(join(target, ".next"));
  writeFileSync(join(target, ".next", "build.txt"), "runtime\n");
  writeFileSync(join(source, "a.txt"), "two\n");
  git(source, "commit", "-qam", "two");
  git(source, "push", "-q", "origin", "HEAD:main");
  return { dir, origin, source, target, rev: git(source, "rev-parse", "HEAD"), old: git(target, "rev-parse", "HEAD") };
}

const head = (cwd: string) => git(cwd, "rev-parse", "HEAD");

describe("syncCheckout", () => {
  test("clean target fast-forwards to the exact revision and keeps ignored files; second run is already-current", async () => {
    const f = fixture();
    const result = await syncCheckout({ source: f.source, target: f.target, revision: f.rev });
    expect(result).toMatchObject({ ok: true, status: "updated", previous: f.old });
    expect(head(f.target)).toBe(f.rev);
    expect(readFileSync(join(f.target, ".next", "build.txt"), "utf8")).toBe("runtime\n");
    expect(await syncCheckout({ source: f.source, target: f.target, revision: f.rev })).toMatchObject({ ok: true, status: "already-current" });
  });

  test("ignored local file colliding with a newly tracked path is not overwritten", async () => {
    const f = fixture();
    mkdirSync(join(f.source, ".next"));
    writeFileSync(join(f.source, ".next", "build.txt"), "published\n");
    git(f.source, "add", "-f", ".next/build.txt");
    git(f.source, "commit", "-qm", "track ignored path");
    git(f.source, "push", "-q", "origin", "HEAD:main");
    const result = await syncCheckout({ source: f.source, target: f.target, revision: head(f.source) });
    expect(result).toMatchObject({ ok: false, status: "blocked" });
    expect(head(f.target)).toBe(f.old);
    expect(readFileSync(join(f.target, ".next", "build.txt"), "utf8")).toBe("runtime\n");
  });

  test("uses the exact revision, not a newer origin tip", async () => {
    const f = fixture();
    writeFileSync(join(f.source, "a.txt"), "three\n");
    git(f.source, "commit", "-qam", "three");
    git(f.source, "push", "-q", "origin", "HEAD:main");
    git(f.source, "reset", "-q", "--hard", f.rev); // source HEAD back at published `two`
    const result = await syncCheckout({ source: f.source, target: f.target, revision: f.rev });
    expect(result.ok).toBe(true);
    expect(head(f.target)).toBe(f.rev);
  });

  for (const [name, dirty] of [
    ["unstaged tracked", (t: string) => writeFileSync(join(t, "a.txt"), "local\n")],
    ["staged", (t: string) => { writeFileSync(join(t, "a.txt"), "local\n"); git(t, "add", "a.txt"); }],
    ["untracked", (t: string) => writeFileSync(join(t, "new.txt"), "x\n")],
  ] as const) {
    test(`${name} target change blocks without touching anything`, async () => {
      const f = fixture();
      dirty(f.target);
      const before = git(f.target, "status", "--porcelain");
      const result = await syncCheckout({ source: f.source, target: f.target, revision: f.rev });
      expect(result).toMatchObject({ ok: false, status: "blocked" });
      expect(head(f.target)).toBe(f.old);
      expect(git(f.target, "status", "--porcelain")).toBe(before);
    });
  }

  test("target ahead of origin and divergent target are blocked and left as-is", async () => {
    const f = fixture();
    writeFileSync(join(f.target, "b.txt"), "local\n");
    git(f.target, "add", "b.txt");
    git(f.target, "commit", "-qm", "local");
    const local = head(f.target);
    const result = await syncCheckout({ source: f.source, target: f.target, revision: f.rev });
    expect(result).toMatchObject({ ok: false, status: "blocked" });
    expect(head(f.target)).toBe(local);
  });

  test("origin or branch mismatch is refused", async () => {
    const f = fixture();
    git(f.target, "remote", "set-url", "origin", join(f.dir, "other.git"));
    expect(await syncCheckout({ source: f.source, target: f.target, revision: f.rev })).toMatchObject({ ok: false });
    git(f.target, "remote", "set-url", "origin", f.origin);
    git(f.target, "checkout", "-q", "-b", "feature");
    const result = await syncCheckout({ source: f.source, target: f.target, revision: f.rev });
    expect(result).toMatchObject({ ok: false });
    expect(head(f.target)).toBe(f.old);
  });

  test("revision that is not source HEAD, or not published, is refused", async () => {
    const f = fixture();
    expect(await syncCheckout({ source: f.source, target: f.target, revision: f.old })).toMatchObject({ ok: false });
    writeFileSync(join(f.source, "a.txt"), "unpublished\n");
    git(f.source, "commit", "-qam", "unpublished");
    const result = await syncCheckout({ source: f.source, target: f.target, revision: head(f.source) });
    expect(result).toMatchObject({ ok: false, status: "blocked" });
    expect(head(f.target)).toBe(f.old);
  });

  test("identical, nested, detached and non-root paths are refused", async () => {
    const f = fixture();
    expect(await syncCheckout({ source: f.source, target: f.source, revision: f.rev })).toMatchObject({ ok: false });
    mkdirSync(join(f.target, "sub"));
    expect(await syncCheckout({ source: f.source, target: join(f.target, "sub"), revision: f.rev })).toMatchObject({ ok: false });
    git(f.target, "checkout", "-q", "--detach");
    expect(await syncCheckout({ source: f.source, target: f.target, revision: f.rev })).toMatchObject({ ok: false });
  });

  test("CLI exits 0 on success and 1 on a blocker", () => {
    const f = fixture();
    const run = (rev: string) => {
      try {
        return { code: 0, out: execFileSync("bun", [cli, "--source", f.source, "--target", f.target, "--revision", rev], { encoding: "utf8" }) };
      } catch (error) {
        const e = error as { status: number; stdout: string };
        return { code: e.status, out: e.stdout };
      }
    };
    expect(run(f.old).code).toBe(1);
    expect(head(f.target)).toBe(f.old);
    const ok = run(f.rev);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ status: "updated" });
    expect(head(f.target)).toBe(f.rev);
  });
});
