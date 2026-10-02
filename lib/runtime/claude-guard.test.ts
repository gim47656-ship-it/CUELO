import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandDecision, decideToolUse, type GuardPolicy, parseOwnedPaths } from "./claude-guard";

const cwd = path.resolve(tmpdir(), "cuelo-guard-cwd");
const policy: GuardPolicy = { cwd, ownedPaths: ["lib/runtime/", "doc/notes.md"] };
const inside = (rel: string) => path.join(cwd, rel);

describe("parseOwnedPaths", () => {
  test("reads the TASK_GUARD line and drops absolute or parent entries", () => {
    expect(parseOwnedPaths("TASK_GUARD:\nOWNED_PATHS: lib/runtime/, doc/x.md ,../up/,C:/abs,/abs\n")).toEqual(["lib/runtime/", "doc/x.md"]);
  });
  test("missing or empty OWNED_PATHS is null", () => {
    expect(parseOwnedPaths("TASK_GUARD:\nWORK_CLASS: feature\n")).toBeNull();
    expect(parseOwnedPaths("OWNED_PATHS:   \n")).toBeNull();
  });
});

describe("file writes", () => {
  test("allows owned directory prefixes and exact files", () => {
    expect(decideToolUse(policy, "Write", { file_path: inside("lib/runtime/a.ts") }).allow).toBe(true);
    expect(decideToolUse(policy, "Edit", { file_path: "lib/runtime/sub/b.ts" }).allow).toBe(true);
    expect(decideToolUse(policy, "MultiEdit", { file_path: inside("doc/notes.md") }).allow).toBe(true);
  });
  test("denies paths outside OWNED_PATHS, including look-alike prefixes and traversal", () => {
    for (const target of [inside("lib/other.ts"), inside("doc/notes.md.bak"), inside("lib/runtimex/a.ts"), inside("lib/runtime/../x.ts"), path.resolve(cwd, "..", "elsewhere.txt")]) {
      const decision = decideToolUse(policy, "Write", { file_path: target });
      expect(decision.allow).toBe(false);
    }
  });
  test("`.` owns the whole cwd but nothing above it", () => {
    const all: GuardPolicy = { cwd, ownedPaths: ["."] };
    expect(decideToolUse(all, "Write", { file_path: inside("any/file.txt") }).allow).toBe(true);
    expect(decideToolUse(all, "Write", { file_path: path.resolve(cwd, "..", "x.txt") }).allow).toBe(false);
  });
  test("a brief without OWNED_PATHS fails closed for every write", () => {
    const none: GuardPolicy = { cwd, ownedPaths: null };
    const decision = decideToolUse(none, "Write", { file_path: inside("lib/runtime/a.ts") });
    expect(decision).toEqual({ allow: false, reason: expect.stringContaining("OWNED_PATHS 없음") });
    expect(decideToolUse(none, "Bash", { command: "echo hi > lib/runtime/a.txt" }).allow).toBe(false);
    expect(decideToolUse(none, "Read", { file_path: inside("lib/runtime/a.ts") }).allow).toBe(true);
  });
});

describe("shell commands", () => {
  test("denies raw git history changes in every spelling", () => {
    for (const command of [
      "git commit -m x",
      "git push origin main",
      "git reset --hard HEAD~1",
      "git rebase main",
      "git -C ../repo push",
      "git -c user.name=x commit -am y",
      "cd lib && git commit -m x",
      'bash -c "git push"',
      "git branch -D feature",
      "git stash drop",
      "git checkout -- .",
    ]) {
      expect(commandDecision(policy, command).allow, command).toBe(false);
    }
    expect(commandDecision(policy, "git commit -m x", "powershell").allow).toBe(false);
  });
  test("allows read-only git and ordinary commands", () => {
    for (const command of ["git status", "git diff --stat", "git log --oneline -5", "git show HEAD:lib/x.ts", "bun test lib/runtime", "ls -la 2>&1 | head"]) {
      expect(commandDecision(policy, command).allow, command).toBe(true);
    }
  });
  test("denies destructive commands", () => {
    for (const command of ["rm -rf build", "rm -r lib/runtime", "Remove-Item -Recurse lib", "find . -name x -delete", 'sqlite3 a.db "DELETE FROM t"']) {
      expect(commandDecision(policy, command, command.startsWith("Remove") ? "powershell" : "bash").allow, command).toBe(false);
    }
  });
  test("checks redirect and write-command targets against OWNED_PATHS", () => {
    expect(commandDecision(policy, "echo hi > lib/runtime/out.txt").allow).toBe(true);
    expect(commandDecision(policy, "echo hi >> lib/runtime/out.txt 2>&1").allow).toBe(true);
    expect(commandDecision(policy, "echo hi > /dev/null").allow).toBe(true);
    expect(commandDecision(policy, 'echo "a > b"').allow).toBe(true);
    expect(commandDecision(policy, "echo hi > README.md").allow).toBe(false);
    expect(commandDecision(policy, "echo hi | tee lib/other.txt").allow).toBe(false);
    expect(commandDecision(policy, "cp lib/runtime/a.ts lib/b.ts").allow).toBe(false);
    expect(commandDecision(policy, "rm lib/other.ts").allow).toBe(false);
    expect(commandDecision(policy, "rm lib/runtime/tmp.txt").allow).toBe(true);
    expect(commandDecision(policy, 'echo x > "$HOME/x"').allow).toBe(false);
    expect(commandDecision(policy, "Set-Content -Path README.md -Value x", "powershell").allow).toBe(false);
    expect(commandDecision(policy, "Set-Content -Path lib/runtime/x.txt -Value x", "powershell").allow).toBe(true);
  });
});

describe("hook process", () => {
  const guard = path.join(import.meta.dir, "claude-guard.ts");
  const run = (policyFile: string, input: string) =>
    Bun.spawnSync([process.execPath, guard, policyFile], { stdin: Buffer.from(input), stdout: "pipe" }).stdout.toString();

  test("prints a PreToolUse deny decision and stays silent on allow", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cuelo-guard-"));
    const policyFile = path.join(dir, "policy.json");
    writeFileSync(policyFile, JSON.stringify(policy));
    const denied = JSON.parse(run(policyFile, JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, tool_use_id: "t1" })));
    expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(run(policyFile, JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }))).toBe("");
  });
  test("an unreadable policy or input fails closed", () => {
    const denied = JSON.parse(run(path.join(tmpdir(), "missing-cuelo-policy.json"), "{}"));
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
