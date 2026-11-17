import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SANDBOX_HINT, standingApprovedCommand, within, WEEKLY_RUNNER } from "./lib/sandbox-policy";

export async function approveSandboxEscape(command: string, reason: string, ctx: Pick<ExtensionContext, "agent" | "hasUI" | "ui">, home: string, workspace: string): Promise<boolean> {
  if (ctx.agent?.kind !== "main") throw new Error("CUELO sandbox: sandbox_escape is Main-only. Makers must report the exact command and reason to Main.");
  if (standingApprovedCommand(command, home)) {
    const canonical = (file: string) => existsSync(file) ? realpathSync(file) : resolve(file);
    const writable = [canonical(workspace)];
    const registry = (globalThis as unknown as Record<symbol, Map<string, { common: string }> | undefined>)[Symbol.for("cuelo.sandbox.git")];
    const pinned = registry?.get(workspace) ?? registry?.get(canonical(workspace));
    if (pinned) {
      if (pinned.common) writable.push(canonical(pinned.common));
    } else {
      const git = spawnSync("/usr/bin/git", ["-C", workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      if (git.status === 0 && git.stdout.trim()) writable.push(canonical(git.stdout.trim()));
      else for (let dir = canonical(workspace); ; dir = resolve(dir, "..")) {
        if (existsSync(join(dir, ".git"))) throw new Error("CUELO sandbox: cannot validate Git metadata; standing approval refused. Use interactive approval or repair the repository.");
        if (dir === resolve(dir, "..")) break;
      }
    }
    const runtime = join(home, "cuelo-run");
    // The whole deployed tree and its executable dependency roots must remain outside all writable binds.
    const trusted = [runtime, join(runtime, "Tools/CUELO_Setup"), join(runtime, "node_modules"), join(runtime, "Tools/CUELO_Setup/wsl/update.sh"), join(runtime, "Tools/CUELO_Setup/linux/host.sh"), join(runtime, WEEKLY_RUNNER)].map(canonical);
    if (trusted.some(file => writable.some(root => within(file, root) || within(root, file)))) throw new Error("CUELO sandbox: standing-approved runtime is writable from this session. Start from a separate clone or obtain interactive approval for a different explicit command.");
    return true;
  }
  if (!ctx.hasUI) throw new Error(`${SANDBOX_HINT} Escape requires an interactive user approval; this headless session cannot grant it.`);
  return await ctx.ui.confirm("Run outside the CUELO sandbox?", `Command (exact):\n${command}\n\nReason:\n${reason}\n\nThis command can read secrets and write outside the workspace. Approve this one execution?`);
}

export default function sandboxEscape(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "sandbox_escape", label: "Sandbox escape", loadMode: "essential", approval: "exec",
    description: "Main-only: run one exact command outside the CUELO bash sandbox after interactive user approval showing command and reason. Makers must report to Main. Only the exact standing-approved CUELO deploy and weekly $2 regression runner bypass the dialog. No automatic approval, and no ordinary escape in headless mode.",
    parameters: pi.zod.object({ command: pi.zod.string().min(1), reason: pi.zod.string().min(1) }) as never,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { command, reason } = params as { command: string; reason: string };
      if (!await approveSandboxEscape(command, reason, ctx, homedir(), ctx.cwd)) return { content: [{ type: "text", text: "CUELO sandbox: user denied or cancelled escape. Nothing ran." }], isError: true };
      // Do not use pi.exec: it follows shellPath and would re-enter the sandbox.
      const child = Bun.spawn(["/bin/bash", "-c", command], { cwd: ctx.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { content: [{ type: "text", text: `${stdout}${stderr}\nExit code: ${exitCode}` }], isError: exitCode !== 0 };
    },
  });
}
