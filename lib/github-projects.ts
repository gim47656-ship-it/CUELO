import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, lstat, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface GithubRepository { fullName: string; description: string | null; private: boolean; url: string }
export interface GithubLogin { state: "pending" | "complete" | "error"; code?: string; error?: string; expiresAt: number }
export interface GithubProjectStatus { connected: boolean; login: string | null; device: GithubLogin | null }
export class GithubProjectError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
type LoginJob = { view: GithubLogin; child: ChildProcess };
const state = globalThis as typeof globalThis & {
  __cueloGithubLogin?: LoginJob;
  __cueloGithubClones?: Map<string, Promise<string>>;
};

export function githubWorkspace(): string {
  const workspace = process.env.CUELO_GITHUB_WORKSPACE?.trim();
  if (!workspace) throw new GithubProjectError("GitHub projects are not enabled on this instance.", 404);
  if (!isAbsolute(workspace)) throw new GithubProjectError("CUELO_GITHUB_WORKSPACE must be an absolute directory.", 500);
  return workspace;
}

export function parseGithubRepository(value: string): string {
  let name = value.trim();
  if (name.startsWith("https://")) {
    let url: URL;
    try { url = new URL(name); }
    catch { throw new GithubProjectError("Enter a valid GitHub HTTPS repository URL.", 400); }
    if (url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
      throw new GithubProjectError("Use a GitHub repository URL without credentials or query parameters.", 400);
    }
    name = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  }
  name = name.replace(/\.git$/, "");
  const pieces = name.split("/");
  if (pieces.length !== 2 || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(pieces[0]) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(pieces[1])) {
    throw new GithubProjectError("Enter OWNER/REPO or https://github.com/OWNER/REPO.", 400);
  }
  return name;
}

async function run(command: string, args: string[], cwd?: string, timeout = 30_000): Promise<string> {
  const { stdout } = await exec(command, args, {
    cwd, timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
  });
  return stdout.trim();
}

export async function githubProjectStatus(): Promise<GithubProjectStatus> {
  githubWorkspace();
  let login: string | null = null;
  try { login = await run("gh", ["api", "user", "--jq", ".login"]); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new GithubProjectError("GitHub CLI is not installed on the server.", 503);
    // Authentication itself is checked locally, so an API outage is not presented as a logout.
    try { await run("gh", ["auth", "status", "--hostname", "github.com"]); }
    catch { return { connected: false, login: null, device: state.__cueloGithubLogin?.view ?? null }; }
    throw new GithubProjectError("GitHub could not be reached. Try again after checking the server connection.", 502);
  }
  return { connected: true, login, device: state.__cueloGithubLogin?.view ?? null };
}

export function beginGithubLogin(): GithubLogin {
  githubWorkspace();
  const current = state.__cueloGithubLogin;
  if (current?.view.state === "pending" && current.view.expiresAt > Date.now()) return current.view;
  const view: GithubLogin = { state: "pending", expiresAt: Date.now() + 15 * 60_000 };
  const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"], {
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_BROWSER: "true", BROWSER: "true", NO_COLOR: "1", LC_ALL: "C" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  state.__cueloGithubLogin = { child, view };
  let pending = "";
  const capture = (data: Buffer) => {
    pending = (pending + data.toString()).slice(-4096);
    const code = pending.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
    if (code && !view.code) { view.code = code; child.stdin?.write("\n"); }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const timer = setTimeout(() => {
    view.state = "error"; view.error = "GitHub sign-in expired. Start again.";
    child.kill();
  }, 15 * 60_000);
  timer.unref();
  child.on("error", () => { clearTimeout(timer); view.state = "error"; view.error = "Could not start GitHub CLI sign-in."; });
  child.on("close", async (code) => {
    clearTimeout(timer);
    if (view.state === "error") return;
    if (code !== 0) { view.state = "error"; view.error = "GitHub sign-in did not complete. Try again."; return; }
    try {
      await run("gh", ["auth", "setup-git", "--hostname", "github.com"]);
      view.state = "complete";
    } catch { view.state = "error"; view.error = "Signed in, but Git credential setup failed."; }
  });
  return view;
}

export async function listGithubRepositories(): Promise<GithubRepository[]> {
  githubWorkspace();
  try {
    const output = await run("gh", ["api", "--paginate", "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member", "--jq", ".[] | {fullName:.full_name,description:.description,private:.private,url:.html_url}"]);
    return output ? output.split("\n").map((line) => JSON.parse(line) as GithubRepository) : [];
  } catch { throw new GithubProjectError("Could not load repositories. Check GitHub sign-in and try again.", 502); }
}

async function importRepository(fullName: string): Promise<string> {
  const workspace = githubWorkspace();
  await mkdir(workspace, { recursive: true });
  const root = await realpath(workspace);
  const [owner, repository] = fullName.toLowerCase().split("/");
  const ownerDir = join(root, owner);
  await mkdir(ownerDir, { recursive: true });
  const canonicalOwner = await realpath(ownerDir);
  const ownerRelative = relative(root, canonicalOwner);
  if (ownerRelative.startsWith("..") || isAbsolute(ownerRelative)) throw new GithubProjectError("Repository directory escapes the cloud workspace.", 400);
  const destination = join(canonicalOwner, repository);
  let existing;
  try { existing = await lstat(destination); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new GithubProjectError("That workspace path is already used by another file.", 409);
    try {
      const remote = await run("git", ["remote", "get-url", "origin"], destination);
      if (parseGithubRepository(remote).toLowerCase() !== fullName.toLowerCase()) throw new Error("different origin");
      const top = await run("git", ["rev-parse", "--show-toplevel"], destination);
      if (await realpath(top) !== await realpath(destination)) throw new Error("not a repository root");
      return destination; // Never pull, reset, or overwrite an existing workspace.
    } catch { throw new GithubProjectError("A different repository already occupies that folder. Open it as a server folder instead.", 409); }
  }
  const temporary = await mkdtemp(join(canonicalOwner, ".cuelo-clone-"));
  try {
    await run("git", ["-c", "core.hooksPath=/dev/null", "clone", "--", `https://github.com/${fullName}.git`, temporary], undefined, 180_000);
    await rename(temporary, destination);
    return destination;
  } catch {
    throw new GithubProjectError("Could not import the repository. Check its name and your GitHub access, then try again.", 502);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function openGithubRepository(value: string): Promise<string> {
  const workspace = githubWorkspace();
  const fullName = parseGithubRepository(value);
  const key = `${workspace}\0${fullName.toLowerCase()}`;
  const clones = state.__cueloGithubClones ??= new Map();
  let job = clones.get(key);
  if (!job) {
    job = importRepository(fullName);
    clones.set(key, job);
    void job.finally(() => clones.delete(key)).catch(() => {});
  }
  return job;
}
