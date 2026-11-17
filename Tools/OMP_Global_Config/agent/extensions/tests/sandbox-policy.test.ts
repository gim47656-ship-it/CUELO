import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { buildSandboxArgs, containsLiteralCredential, secretPaths } from "../lib/sandbox-policy";
import { sandboxConfig } from "../../../../CUELO_Setup/linux/install-sandbox.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sandbox-policy-")); roots.push(root);
  const home = join(root, "home"), cwd = join(root, "work"), agent = join(home, ".omp/agent");
  for (const dir of [agent, cwd, join(root, "git")]) mkdirSync(dir, { recursive: true });
  return { root, home, cwd, agent };
}

test("profile symlink aliases, external credential targets, dangling entries and relative profiles stay safe", () => {
  const { home, cwd, agent } = fixture();
  const target = join(home, "real-mcp.json");
  writeFileSync(target, "fixture");
  symlinkSync(target, join(agent, "mcp.json"));
  symlinkSync(target, join(agent, "alias.txt"));
  symlinkSync("/nonexistent-cuelo-fixture", join(agent, "dangling"));
  writeFileSync(join(agent, "config.yml"), "ordinary: true\n");
  const args = buildSandboxArgs({ home, cwd, uid: 1, agentDir: relative(process.cwd(), agent) });
  expect(args).not.toContain(join(agent, "alias.txt"));
  expect(args).not.toContain(join(agent, "dangling"));
  expect(args.join(" ")).toContain(`--ro-bind /dev/null ${target}`);
  expect(args.join(" ")).toContain(`--ro-bind-try ${agent}/config.yml ${agent}/config.yml`);
});

test("network stays open; root read-only, cwd/common-dir writable; user manager hidden", () => {
  const { root, home, cwd, agent } = fixture();
  writeFileSync(join(agent, "hive-api-key"), "fixture-secret");
  const args = buildSandboxArgs({ home, cwd, uid: 1234, gitCommonDir: join(root, "git") });
  expect(args.slice(0, 9)).toEqual(["--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc"]);
  expect(args).not.toContain("--unshare-net");
  expect(args.join(" ")).toContain(`--tmpfs /run/user/1234`);
  expect(args.join(" ")).toContain(`--bind ${cwd} ${cwd}`);
  expect(args.join(" ")).toContain(`--bind ${root}/git ${root}/git`);
  expect(args).not.toContain(join(agent, "hive-api-key"));
  expect(args.join(" ")).toContain(`--tmpfs ${agent}`);
  expect(args.join(" ")).toContain(`--remount-ro ${agent}`);
});

test("credentials and backups are hidden, ordinary profile data remains readable", () => {
  const { home, agent } = fixture();
  for (const name of ["mcp.json.bak-1", "agent.db-wal", "agent.db.bak-1", "cuelo-api-credits-google-days.json", "new-api-key"]) writeFileSync(join(agent, name), "fixture");
  writeFileSync(join(agent, "config.yml"), "ordinary: true\n");
  writeFileSync(join(agent, "models.yml.bak-1"), "apiKey: fixture-secret\n");
  writeFileSync(join(agent, "models.yml"), 'apiKey: "!read-key"\n');
  const paths = secretPaths(home);
  for (const name of ["mcp.json.bak-1", "agent.db-wal", "agent.db.bak-1", "new-api-key", "models.yml.bak-1"]) expect(paths).toContain(join(agent, name));
  expect(paths).not.toContain(join(agent, "config.yml")); expect(paths).not.toContain(join(agent, "models.yml"));
  expect(containsLiteralCredential({ nested: { password: "fixture" } })).toBe(true);
  writeFileSync(join(agent, "models.yml.bak"), "apiKey: fixture\n\t: [");
  writeFileSync(join(agent, "cuelo-api-credits.json.bak-1"), "fixture");
  expect(secretPaths(home)).toContain(join(agent, "models.yml.bak"));
  expect(secretPaths(home)).toContain(join(agent, "cuelo-api-credits.json.bak-1"));
});

test("unsafe home workspace fails closed", () => {
  const { home } = fixture();
  expect(() => buildSandboxArgs({ home, cwd: home, uid: 1 })).toThrow("unsafe workspace");
});

test("metadata ancestors stay pinned and missing pinned topology fails closed", () => {
  const { home, cwd, root } = fixture();
  const common = join(root, "git"), sub = join(cwd, "a/b"), info = join(common, "objects/info");
  mkdirSync(sub, { recursive: true }); mkdirSync(info, { recursive: true });
  const policy = { home, cwd, uid: 1, gitCommonDir: common, gitPointers: [join(sub, ".git"), join(cwd, ".git")], gitTopology: [info] };
  const args = buildSandboxArgs(policy).join(" ");
  expect(args).toContain(`--bind ${cwd}/a ${cwd}/a`);
  expect(args).toContain(`--bind ${common}/objects ${common}/objects`);
  expect(args).toContain(`--ro-bind ${info} ${info}`);
  rmSync(info, { recursive: true });
  expect(() => buildSandboxArgs(policy)).toThrow("topology disappeared");
  mkdirSync(join(cwd, "profile"));
  expect(() => buildSandboxArgs({ home, cwd, uid: 1, agentDir: join(cwd, "profile") })).toThrow("profile outside");
});

test("profile installation preserves comments, custom Python and disable switch", () => {
  const text = "shellPath: /bin/bash\n# keep\nsandbox:\n  enabled: true\npython:\n  interpreter: /custom/python\nother: yes\n";
  const out = sandboxConfig(text, "/repo");
  expect(out).toContain("# keep");
  const parsed = Bun.YAML.parse(out) as { shellPath: string; python: { interpreter: string }; sandbox: { pythonInterpreter: string } };
  expect(parsed.shellPath).toBe("/repo/Tools/CUELO_Setup/linux/sandbox/bash");
  expect(parsed.python.interpreter).toBe("/repo/Tools/CUELO_Setup/linux/sandbox/python");
  expect(parsed.sandbox.pythonInterpreter).toBe("/custom/python");
  expect(sandboxConfig(out, "/repo")).toBe(out);
  expect(Bun.YAML.parse(sandboxConfig("shellPath: /x\nsandbox:\n  enabled: false\n", "/repo"))).toEqual({ shellPath: "/bin/bash", sandbox: { enabled: false } });
  const crlf = sandboxConfig("shellPath: /bin/bash\r\n# untouched\r\n", "/repo");
  expect(crlf).not.toContain("\r\r");
  expect(crlf.replaceAll("\r\n", "")).not.toContain("\n");
  const absent = Bun.YAML.parse(sandboxConfig("theme: dark\n", "/repo")) as { shellPath: string };
  expect(absent.shellPath).toEndWith("/sandbox/bash");
  const disabled = Bun.YAML.parse(sandboxConfig("shellPath: /bin/bash\nsandbox:\n  enabled: false\npython:\n  interpreter: /custom/python\n", "/repo")) as { python: { interpreter: string } };
  expect(disabled.python.interpreter).toBe("/custom/python");
});
