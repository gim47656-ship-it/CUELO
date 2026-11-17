import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, relative, sep } from "node:path";

export const SANDBOX_HINT = "CUELO sandbox: secrets are hidden and writes are limited to the session workspace, pinned git metadata and private /tmp (including build caches). Main can use sandbox_escape with explicit user approval; Makers must report to Main.";
export const WEEKLY_RUNNER = "Tools/OMP_Global_Config/evals/outcome/run-revision-compare.mjs";
const SECRET_NAME = /^(?:.*-api-key(?:\..*)?|agent\.db(?:[-.].*)?|cuelo-api-credits.*|mcp\.json(?:\..*)?|\.env(?:\..*)?)$/i;
const CREDENTIAL_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)$/i;

export function containsLiteralCredential(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    if (CREDENTIAL_KEY.test(key) && typeof child === "string" && child.trim() && !/^(?:!|\$|\{\{)/.test(child.trim())) return true;
    return containsLiteralCredential(child);
  });
}

export function secretPaths(home = homedir(), agentDir = join(home, ".omp/agent")): string[] {
  const result = new Set<string>();
  for (const root of new Set([join(home, ".omp/agent"), resolve(agentDir)])) {
    // Include absent well-known paths too, for the in-process tool guard.
    for (const name of ["agent.db", "agent.db-wal", "agent.db-shm", "hive-api-key", "aistudio2api-key", "anthropic-fallback-api-key", "mcp.json", ".env", "cuelo-api-credits.json"]) result.add(join(root, name));
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const file = join(root, name);
      if (SECRET_NAME.test(name)) result.add(file);
      else if (/^(?:config|models)\.ya?ml(?:\..*)?$/.test(name)) {
        try {
          if (containsLiteralCredential(Bun.YAML.parse(readFileSync(file, "utf8")))) result.add(file);
        } catch {
          // Malformed configuration cannot establish that credentials are absent.
          result.add(file);
        }
      }
    }
  }
  for (const file of [...result]) {
    try { result.add(realpathSync(file)); } catch { /* Absent credentials still match the guard. */ }
  }
  return [...result];
}

export function within(file: string, root: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

export interface SandboxPolicy {
  home: string;
  cwd: string;
  commandCwd?: string;
  uid: number;
  agentDir?: string;
  gitCommonDir?: string;
  gitDir?: string;
  gitRoots?: string[];
  gitPointers?: string[];
  gitTopology?: string[];
  /** A Python runner staged by core under host /tmp, rebound read-only after private /tmp. */
  runnerFile?: string;
  commandFile?: string;
}

export function buildSandboxArgs(policy: SandboxPolicy): string[] {
  const home = realpathSync(policy.home);
  const cwd = realpathSync(policy.cwd);
  if (within(home, cwd) || within(join(home, ".omp"), cwd) || within(cwd, join(home, ".omp"))) {
    throw new Error(`${SANDBOX_HINT} Refusing an unsafe workspace root: ${cwd}`);
  }
  const args = ["--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", `/run/user/${policy.uid}`];
  // Keep HOME read-only even for isolated test profiles under host /tmp.
  args.push("--ro-bind", home, home);
  // Bind workspace after private /tmp, so a /tmp workspace is usable.
  const writable = [cwd, ...(policy.gitCommonDir ? [realpathSync(policy.gitCommonDir)] : [])];
  if (policy.agentDir && within(resolve(policy.agentDir), cwd)) throw new Error(`${SANDBOX_HINT} Keep the trusted agent profile outside the writable workspace.`);
  const hidden = secretPaths(home, policy.agentDir);
  for (const root of writable) {
    const canonical = realpathSync(root);
    if (canonical !== cwd && (canonical === "/" || canonical === home || hidden.some(file => within(file, canonical)))) throw new Error(`${SANDBOX_HINT} Unsafe writable directory: ${root}`);
    args.push("--bind", canonical, canonical);
  }
  const gitRoots = [...new Set([policy.gitDir, policy.gitCommonDir, ...(policy.gitRoots ?? [])].filter((file): file is string => Boolean(file)).filter(existsSync).map(file => realpathSync(file)))].sort((a, b) => a.length - b.length);
  const pinned = new Set(writable);
  const pinAncestors = (directory: string) => {
    const base = writable.filter(root => within(directory, root)).sort((a, b) => b.length - a.length)[0];
    if (!base) return;
    for (let cursor = directory; within(cursor, base); cursor = dirname(cursor)) {
      if (existsSync(cursor) && lstatSync(cursor).isDirectory()) pinned.add(cursor);
      if (cursor === base) break;
    }
  };
  for (const pointer of policy.gitPointers ?? []) pinAncestors(dirname(pointer));
  for (const gitDir of gitRoots) {
    pinAncestors(gitDir);
    for (const name of ["worktrees", "modules", "objects/info"]) {
      const directory = join(gitDir, name);
      if (policy.gitTopology?.includes(directory) && !existsSync(directory)) throw new Error(`${SANDBOX_HINT} Pinned Git topology disappeared; restart the session after the host operation: ${directory}`);
      if (existsSync(directory)) pinAncestors(dirname(directory));
    }
  }
  const directories = [...pinned].sort((a, b) => a.length - b.length);
  for (const directory of directories) if (!writable.includes(directory)) args.push("--bind", directory, directory);
  // Parent-first: common topology is RO, then only known indexed git roots are rebound RW.
  for (const gitDir of gitRoots) {
    args.push(writable.some(root => within(gitDir, root)) ? "--bind" : "--ro-bind", gitDir, gitDir);
    // Rebinding this root shadows child mounts, so restore its ancestor pins before RO masks.
    for (const directory of directories) if (directory !== gitDir && within(directory, gitDir)) args.push("--bind", directory, directory);
    for (const name of ["worktrees", "modules", "objects/info"]) {
      const directory = join(gitDir, name);
      if ((policy.gitTopology?.includes(directory) || !policy.gitTopology) && existsSync(directory)) args.push("--ro-bind", directory, directory);
    }
    for (const name of ["hooks", "config", "config.worktree", "commondir", "gitdir", "objects/info/alternates"]) {
      const file = join(gitDir, name);
      if (existsSync(file)) args.push("--ro-bind", realpathSync(file), realpathSync(file));
    }
  }
  for (const pointer of new Set([join(cwd, ".git"), ...(policy.gitPointers ?? [])])) {
    if (existsSync(pointer) && !lstatSync(pointer).isDirectory()) args.push("--ro-bind", pointer, pointer);
  }
  // A filtered mount view, not file masks on the live directory: credentials created or
  // atomically replaced while a service runs must never appear in its namespace.
  const profiles = [...new Set([join(home, ".omp/agent"), policy.agentDir].filter((file): file is string => Boolean(file)).filter(existsSync).map(file => realpathSync(file)))];
  for (const profile of profiles) {
    if (writable.some(root => within(profile, root))) throw new Error(`${SANDBOX_HINT} Keep the trusted agent profile outside writable mounts: ${profile}`);
    args.push("--tmpfs", profile);
    for (const name of readdirSync(profile)) {
      const file = join(profile, name);
      try {
        if (!existsSync(file)) continue;
        const source = realpathSync(file);
        if (hidden.includes(file) || hidden.includes(source) || (lstatSync(file).isSymbolicLink() && hidden.some(secret => within(secret, source)))) continue;
        args.push("--ro-bind-try", source, file);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    args.push("--remount-ro", profile);
  }
  // Real credential targets outside the filtered profile must also be hidden.
  for (const file of hidden) if (existsSync(file) && !profiles.some(profile => dirname(file) === profile)) args.push("--ro-bind", "/dev/null", file);
  if (policy.runnerFile) {
    const file = realpathSync(policy.runnerFile);
    if (!lstatSync(file).isFile() || !within(file, "/tmp") || !/^runner-[a-z0-9]+\.py$/.test(file.split("/").pop() ?? "") || !/^omp-python-runner-/.test(dirname(file).split("/").pop() ?? "")) throw new Error("CUELO sandbox: unexpected Python runner path");
    args.push("--ro-bind", file, file);
  }
  if (policy.commandFile) {
    const file = realpathSync(policy.commandFile);
    if (!lstatSync(file).isFile() || !/^\/tmp\/(?:[^/]+\/)*cuelo-command-[^/]+\/command\.sh$/.test(file)) throw new Error("CUELO sandbox: unexpected command file");
    args.push("--ro-bind", file, file);
  }
  args.push("--setenv", "XDG_RUNTIME_DIR", `/run/user/${policy.uid}`, "--chdir", policy.commandCwd ?? cwd);
  return args;
}

/** Deliberately no shell parsing: only these complete, literal spellings bypass the approval dialog. */
export function standingApprovedCommand(command: string, home: string): boolean {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const deployPath = `(?:~/cuelo-run|${escape(join(home, "cuelo-run"))})/Tools/CUELO_Setup/wsl/update\\.sh`;
  const deploy = new RegExp(`^systemd-run --user --unit=cuelo-update-[0-9]+ --collect(?: --setenv=WSL_DISTRO_NAME=[A-Za-z0-9_.-]+)? bash ${deployPath} [a-f0-9]{7,40} [A-Za-z0-9_-]+$`);
  const weekly = join(home, "cuelo-run", WEEKLY_RUNNER).replaceAll("'", "'\\''");
  return deploy.test(command) || command === `node '${weekly}' --weekly --budget 2`;
}
