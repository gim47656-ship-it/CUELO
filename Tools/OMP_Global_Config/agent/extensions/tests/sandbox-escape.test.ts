import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { approveSandboxEscape } from "../sandbox-escape";
import { standingApprovedCommand, WEEKLY_RUNNER } from "../lib/sandbox-policy";

const deploy = "systemd-run --user --unit=cuelo-update-1794895000 --collect bash ~/cuelo-run/Tools/CUELO_Setup/wsl/update.sh abcdef123456 123abc-def";
test("only complete standing deploy/weekly commands bypass the dialog", () => {
  for (const command of [deploy, deploy.replace(" --collect", " --collect --setenv=WSL_DISTRO_NAME=Ubuntu-24.04"), deploy.replace("~/", "/home/user/"), `node '/home/user/cuelo-run/${WEEKLY_RUNNER}' --weekly --budget 2`]) expect(standingApprovedCommand(command, "/home/user")).toBe(true);
  for (const command of [deploy + "; true", deploy + "\n", deploy + " && true", deploy.replace("abcdef123456", "$(id)"), deploy.replace("--collect", "--collect --property=ExecStart=/bin/true"), deploy.replace("update.sh", "other.sh"), deploy.replace("cuelo-update-1794895000", "other-1"), `node '/home/user/cuelo-run/${WEEKLY_RUNNER}' --weekly --budget 3`, `node '/repo/${WEEKLY_RUNNER}' --weekly --budget 2`, `node '/home/user/cuelo-run/${WEEKLY_RUNNER}' --weekly --budget 2; true`, `node /home/user/cuelo-run/${WEEKLY_RUNNER} --weekly --budget 2`]) expect(standingApprovedCommand(command, "/home/user")).toBe(false);
});

test("weekly path is POSIX quoted for spaces and apostrophes", () => {
  const home = "/home/user's files";
  const path = `${home}/cuelo-run/${WEEKLY_RUNNER}`.replaceAll("'", "'\\''");
  expect(standingApprovedCommand(`node '${path}' --weekly --budget 2`, home)).toBe(true);
  expect(standingApprovedCommand(`node '${path}' --weekly --budget 2 && true`, home)).toBe(false);
});

test("Main-only, headless deny, explicit one-shot approval and cancellation", async () => {
  const prompts: string[] = [];
  const ctx = { agent: { kind: "main" }, hasUI: true, ui: { confirm: async (title: string, message: string) => { prompts.push(title + message); return true; } } } as unknown as ExtensionContext;
  await expect(approveSandboxEscape("echo exact", "reason exact", ctx, "/home/user", "/repo")).resolves.toBe(true);
  expect(prompts[0]).toContain("echo exact"); expect(prompts[0]).toContain("reason exact");
  await expect(approveSandboxEscape(deploy, "deploy", { ...ctx, agent: { kind: "sub" } } as ExtensionContext, "/home/user", "/repo")).rejects.toThrow("Main-only");
  await expect(approveSandboxEscape("echo exact", "reason", { ...ctx, hasUI: false }, "/home/user", "/repo")).rejects.toThrow("interactive user approval");
  await expect(approveSandboxEscape(deploy, "deploy", { ...ctx, hasUI: false }, "/home/user", "/repo")).resolves.toBe(true);
  await expect(approveSandboxEscape(deploy, "deploy", { ...ctx, hasUI: false }, "/home/user", "/home/user/cuelo-run")).rejects.toThrow("runtime is writable");
  await expect(approveSandboxEscape("echo exact", "reason", { ...ctx, ui: { confirm: async () => false } } as unknown as ExtensionContext, "/home/user", "/repo")).resolves.toBe(false);
});

test("standing approval uses pinned common dir even when repository discovery is broken", async () => {
  const key = Symbol.for("cuelo.sandbox.git");
  const global = globalThis as unknown as Record<symbol, Map<string, { common: string }> | undefined>;
  const previous = global[key];
  global[key] = new Map([["/home/user/wt", { common: "/home/user/cuelo-run/.git" }]]);
  try {
    await expect(approveSandboxEscape(deploy, "deploy", { agent: { kind: "main" }, hasUI: false } as ExtensionContext, "/home/user", "/home/user/wt")).rejects.toThrow("runtime is writable");
  } finally { if (previous) global[key] = previous; else delete global[key]; }
});
