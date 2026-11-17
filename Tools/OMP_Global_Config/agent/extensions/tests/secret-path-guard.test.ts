import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { secretPathViolation } from "../secret-path-guard";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "secret-guard-")); roots.push(root);
  const home = join(root, "fixture-home"), cwd = join(root, "work"), agent = join(home, ".omp/agent");
  mkdirSync(agent, { recursive: true }); mkdirSync(cwd);
  writeFileSync(join(agent, "hive-api-key"), "fixture");
  symlinkSync(join(agent, "hive-api-key"), join(cwd, "alias"));
  return { home, cwd, agent };
}

test("direct paths, selectors, environment home, relative paths and symlinks are denied", () => {
  const { home, cwd, agent } = fixture();
  for (const path of ["~/.omp/agent/hive-api-key", "$HOME/.omp/agent/agent.db", "${HOME}/.omp/agent/agent.db-wal", join(agent, "hive-api-key") + ":1-4", "alias", "../fixture-home/.omp/agent/hive-api-key"]) expect(secretPathViolation("read", { path }, cwd, home, agent)).toBeTruthy();
  for (const name of ["edit", "write", "ast_grep", "ast_edit", "grep", "find", "glob", "lsp"]) expect(secretPathViolation(name, { path: join(agent, "agent.db") }, cwd, home, agent)).toBeTruthy();
  expect(secretPathViolation("grep", { path: agent }, cwd, home, agent)).toBeTruthy();
  expect(secretPathViolation("read", { path: "a.ts, alias:raw:1" }, cwd, home, agent)).toBeTruthy();
});

test("literal eval secret references denied; ordinary profile and workspace tools allowed", () => {
  const { home, cwd, agent } = fixture();
  for (const code of ['print(open("~/.omp/agent/hive-api-key").read())', 'await Bun.file(process.env.HOME + "/.omp/agent/agent.db").text()', 'Path.home() / ".omp" / "agent" / "hive-api-key"']) expect(secretPathViolation("eval", { language: "py", code }, cwd, home, agent)).toBeTruthy();
  for (const path of ["~/.omp/agent/config.yml", "~/.omp/agent/tools/vm-build/index.ts", "~/.omp/stats.db", "~/.omp/wsl-update", "~/.ssh/id_ed25519", "~/.config/gh/hosts.yml", "local.ts"]) expect(secretPathViolation("read", { path }, cwd, home, agent)).toBeUndefined();
  expect(secretPathViolation("write", { path: "doc.md", content: "hive-api-key" }, cwd, home, agent)).toBeUndefined();
});

test("generic writes cannot alter the live profile/runtime; managed host tools retain their own paths", () => {
  const { home, cwd, agent } = fixture();
  for (const tool of ["write", "edit", "ast_edit"]) for (const path of ["~/.omp/agent/config.yml", "~/.omp/agent/sandbox/bash", "~/cuelo-run/Tools/script.mjs"]) expect(secretPathViolation(tool, { path }, cwd, home, agent)).toBeTruthy();
  expect(secretPathViolation("lsp", { action: "rename_file", file: "~/cuelo-run/a.ts", new_name: "b.ts" }, cwd, home, agent)).toBeTruthy();
  expect(secretPathViolation("edit", "*** Begin Patch\n[~/.omp/agent/config.yml#A123]\nPUT 1.=1:\n+off\n*** End Patch", cwd, home, agent)).toBeTruthy();
  expect(secretPathViolation("edit", { patch: "[~/.omp/agent/config.yml#abcd]\r\n1#ab|x" }, cwd, home, agent)).toBeTruthy();
  expect(secretPathViolation("write", { path: "x:1/../../.omp/agent/extensions/e.ts" }, home + "/ws", home, agent)).toBeTruthy();
  expect(secretPathViolation("lsp", { action: "rename_file", file: "a.ts", new_name: "~/.omp/agent/extensions/e.ts" }, cwd, home, agent)).toBeTruthy();
  expect(secretPathViolation("ast_edit", { paths: ["~/cuelo-*/*.sh"] }, cwd, home, agent)).toBeTruthy();
  expect(secretPathViolation("glob", { path: "~/.omp/**" }, cwd, home, agent)).toBeTruthy();
  for (const tool of ["manage_skill", "learn", "read"]) expect(secretPathViolation(tool, { path: "~/.omp/agent/config.yml" }, cwd, home, agent)).toBeUndefined();
});
