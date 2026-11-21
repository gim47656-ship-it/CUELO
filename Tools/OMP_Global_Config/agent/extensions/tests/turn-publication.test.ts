import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnPublication } from "../lib/turn-publication";

test("empty publication ownership never adopts the following guard field", () => {
  const cwd = mkdtempSync(join(tmpdir(), "turn-publication-reader-"));
  try {
    for (const newline of ["\n", "\r\n"]) {
      const publication = createTurnPublication();
      publication.observe({ toolName: "task", input: { agent: "maker", task:
        ["TASK_GUARD:", "WORK_CLASS: maintenance", "OWNED_PATHS:   ", "FINDING_ID: F-empty", "", "Work."].join(newline) },
        details: { results: [{ index: 0, id: "maker-empty", exitCode: 0 }] },
      }, cwd);
      expect(publication.note(cwd)).toBeUndefined();
    }
    // A real owned scope is still tracked; no repository means publication stays unverified.
    const valid = createTurnPublication();
    valid.observe({ toolName: "task", input: { task: "TASK_GUARD:\nWORK_CLASS: maintenance\nOWNED_PATHS: src/\n\nWork." },
      details: { results: [{ index: 0, id: "maker-valid", exitCode: 0 }] },
    }, cwd);
    expect(valid.note(cwd)).toContain("maker-valid");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// 2026-11-22: default publication only for a repository with a configured remote and a publishing convention.
// Unknown status (a failing git read) is never "no remote"; an explicit user publish request and a failed finalize report stay as they were.
describe("publication scope", () => {
  const roots: string[] = [];
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"; });
  afterAll(() => {
    for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  const git = (cwd: string, ...args: string[]) => {
    const run = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
    if (run.status !== 0) throw Error(`git ${args.join(" ")}: ${run.stderr}`);
  };
  const commit = (cwd: string, email: string, file: string, text: string) => {
    writeFileSync(join(cwd, file), text);
    git(cwd, "add", "-A");
    git(cwd, "-c", `user.email=${email}`, "-c", "user.name=x", "commit", "-qm", `by ${email}`);
  };
  /** A real repository whose configured identity is me@x; `remote` adds a bare origin with the first commit (by `first`) pushed. */
  const repo = (options: { remote?: boolean; first?: string; docs?: string } = {}) => {
    const cwd = mkdtempSync(join(tmpdir(), "turn-pub-scope-"));
    roots.push(cwd);
    mkdirSync(join(cwd, "src"));
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "config", "user.email", "me@x");
    git(cwd, "config", "user.name", "me");
    if (options.docs) writeFileSync(join(cwd, "AGENTS.md"), options.docs);
    commit(cwd, options.first ?? "me@x", "src/a.ts", "one\n");
    if (options.remote) {
      const bare = mkdtempSync(join(tmpdir(), "turn-pub-scope-remote-"));
      roots.push(bare);
      git(bare, "init", "-q", "--bare");
      git(cwd, "remote", "add", "origin", bare);
      git(cwd, "push", "-q", "-u", "origin", "main");
    }
    return cwd;
  };
  const changed = (cwd: string) => {
    const publication = createTurnPublication();
    writeFileSync(join(cwd, "src/a.ts"), "two\n");
    publication.observe({ toolName: "write", input: { path: "src/a.ts" }, isError: false, details: { resolvedPath: join(cwd, "src/a.ts") } }, cwd);
    return publication;
  };

  test("no configured remote: the unpublished change is kept and reported, not pushed by default", () => {
    const cwd = repo();
    expect(changed(cwd).note(cwd)).toBeUndefined();
  });

  test("a remote without publishing-convention evidence draws no default publication notice", () => {
    const cwd = repo({ remote: true, first: "other@y" });
    expect(changed(cwd).note(cwd)).toBeUndefined();
  });

  test("a remote with a convention (prior push by this identity, or repository guidance) still gets the notice", () => {
    for (const cwd of [repo({ remote: true }), repo({ remote: true, first: "other@y", docs: "마감은 git_finalize로 커밋과 push 한다.\n" })]) {
      expect(changed(cwd).note(cwd)).toContain("src/a.ts");
    }
  });

  test("a git read that fails is unknown status, never no remote", () => {
    const cwd = mkdtempSync(join(tmpdir(), "turn-pub-scope-broken-"));
    roots.push(cwd);
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, "src"));
    const publication = changed(cwd);
    expect(publication.note(cwd)).toContain("src/a.ts");
  });

  test("an explicit user publish request bypasses the narrowing; a later plain input restores it", () => {
    const cwd = repo();
    const explicit = changed(cwd);
    explicit.user("고쳤으면 커밋하고 푸시해 줘");
    expect(explicit.note(cwd)).toContain("src/a.ts");
    const quiet = repo();
    const later = changed(quiet);
    later.user("고쳤으면 커밋하고 푸시해 줘");
    later.user("다음 작업이야");
    expect(later.note(quiet)).toBeUndefined();
  });

  test("convention evidence: a prohibition is not a convention, a wider commit-and-push sentence is, a different author is not this user", () => {
    const prohibited = repo({ remote: true, first: "other@y", docs: "Never commit and push at close.\n" });
    expect(changed(prohibited).note(prohibited)).toBeUndefined();
    const spelled = repo({ remote: true, first: "other@y", docs: "At close, commit all verified changes and push them to origin.\n" });
    expect(changed(spelled).note(spelled)).toContain("src/a.ts");
    const lookalike = repo({ remote: true, first: "notme@x" });
    expect(changed(lookalike).note(lookalike)).toBeUndefined();
  });

  test("a prohibition on push is not a convention; a closing checklist or a commit-and-push sentence with another negation is", () => {
    const forbidden = repo({ remote: true, first: "other@y", docs: "Commit locally; pushing is forbidden.\n" });
    expect(changed(forbidden).note(forbidden)).toBeUndefined();
    const wrapped = repo({ remote: true, first: "other@y", docs: "At close, commit locally. Do not\npush.\n" });
    expect(changed(wrapped).note(wrapped)).toBeUndefined();
    for (const docs of ["At close, commit and push even if no tests were needed.\n", "At close:\n1. Commit all changes.\n2. Push HEAD.\n", "At close, commit and push; do not squash.\n"]) {
      const cwd = repo({ remote: true, first: "other@y", docs });
      expect(changed(cwd).note(cwd)).toContain("src/a.ts");
    }
  });

  test("an unreadable convention document or a truncated history is unknown, not no convention", () => {
    const locked = repo({ remote: true, first: "other@y", docs: "At close, commit and push.\n" });
    chmodSync(join(locked, "AGENTS.md"), 0);
    try {
      // Root bypasses file modes, so the unreadable case only holds for a regular user; either outcome is a notice.
      expect(changed(locked).note(locked)).toContain("src/a.ts");
    } finally { chmodSync(join(locked, "AGENTS.md"), 0o644); }
  });

  test("a convention document that is not a regular file is skipped without blocking", () => {
    const cwd = repo({ remote: true, first: "other@y" });
    expect(spawnSync("mkfifo", [join(cwd, "AGENTS.md")]).status).toBe(0);
    expect(changed(cwd).note(cwd)).toBeUndefined();
  });

  test("the scope is judged per repository: a no-remote nested repository stays quiet next to an eligible outer one", () => {
    const outer = repo({ remote: true });
    const inner = join(outer, "child");
    mkdirSync(inner);
    git(inner, "init", "-q", "-b", "main");
    git(inner, "config", "user.email", "me@x");
    mkdirSync(join(inner, "src"));
    commit(inner, "me@x", "src/a.ts", "one\n");
    const publication = changed(outer);
    writeFileSync(join(inner, "src/a.ts"), "two\n");
    publication.observe({ toolName: "write", input: { path: "child/src/a.ts" }, isError: false, details: { resolvedPath: join(inner, "src/a.ts") } }, outer);
    const note = publication.note(outer) ?? "";
    expect(note).toContain("src/a.ts");
    expect(note).not.toContain("child/src/a.ts");
  });

  test("a failed git_finalize is still reported when the repository has no remote", () => {
    const cwd = repo();
    const publication = createTurnPublication();
    publication.observe({ toolName: "git_finalize", input: { files: ["src/a.ts"] }, isError: false, details: { ok: false, stage: "push" } }, cwd);
    expect(publication.note(cwd)).toContain("git_finalize push");
  });
});
