import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { secretPaths, SANDBOX_HINT, within } from "./lib/sandbox-policy";

const FILE_TOOLS: Record<string, true> = { read: true, grep: true, find: true, glob: true, edit: true, write: true, ast_grep: true, ast_edit: true, lsp: true };
const PATH_KEYS: Record<string, true> = { path: true, paths: true, file: true, files: true, directory: true, cwd: true, new_name: true, newUri: true, oldUri: true, uri: true };

function canonical(file: string): string {
  if (existsSync(file)) return realpathSync(file);
  const parent = dirname(file);
  return parent !== file ? join(canonical(parent), basename(file)) : file;
}

export function secretPathViolation(toolName: string, input: unknown, cwd: string, home = homedir(), agentDir = process.env.PI_CODING_AGENT_DIR || join(home, ".omp/agent")): string | undefined {
  const codeTool = toolName === "eval" || toolName === "python";
  const writing = toolName === "edit" || toolName === "write" || toolName === "ast_edit" || (toolName === "lsp" && Boolean(input && typeof input === "object" && /^(?:rename|rename_file|code_actions|request)$/.test(String((input as Record<string, unknown>).action)) && (input as Record<string, unknown>).apply !== false));
  if (!FILE_TOOLS[toolName] && !codeTool) return;
  const hidden = secretPaths(home, agentDir);
  const strings: string[] = [];
  function collect(value: unknown, key = "") {
    if (typeof value === "string" && (codeTool || PATH_KEYS[key])) strings.push(value);
    else if (toolName === "edit" && typeof value === "string" && (key === "" || key === "patch")) {
      for (const match of value.matchAll(/^\[([^#\r\n]+)#[a-f0-9]{4}\]$/gim)) strings.push(match[1]!);
    }
    else if (Array.isArray(value)) value.forEach(item => collect(item, key));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => collect(child, key));
  }
  collect(input);
  for (const text of strings) {
    // Eval text matching is advisory defense, not a security boundary: computed JS/Python paths can evade it.
    if (codeTool) {
      const compact = text.replace(/["'`\s+]/g, "").replaceAll("\\", "/");
      for (const file of hidden) {
        const name = file.split("/").pop()!;
        if (text.includes(file) || compact.includes(file) || compact.includes(file.replace(home, "~")) || compact.includes(file.replace(home, "$HOME")) || (name !== ".env" && compact.includes(name))) return file;
      }
      continue;
    }
    for (let file of new Set([text, ...text.split(/[;,\n]/)])) {
      file = file.trim();
      if (toolName === "read") file = file.replace(/:(?:(?:raw:?)?[\d,+-]+(?::raw)?|raw(?::[\d,+-]+)?)$/, "");
      if (file.startsWith("file://")) file = decodeURIComponent(file.slice(7));
      file = file.replace(/^~(?=\/|$)|^\$\{?HOME\}?(?=\/|$)/, home);
      const absolute = canonical(resolve(cwd, file));
      const wildcard = file.search(/[*?[{]/);
      const globBase = wildcard >= 0 ? canonical(resolve(cwd, file.slice(0, wildcard).replace(/[^/]*$/, ""))) : undefined;
      if (writing) for (const protectedRoot of [join(home, ".omp/agent"), agentDir, join(home, "cuelo-run")]) {
        if (within(absolute, canonical(protectedRoot)) || (globBase && within(canonical(protectedRoot), globBase))) return `${absolute} (live profile/runtime writes require Main's approved maintenance path)`;
      }
      for (const secret of hidden) {
        if (within(absolute, secret) || ((toolName === "grep" || toolName === "glob" || toolName === "find" || toolName.startsWith("ast_")) && (within(secret, absolute) || (globBase && within(secret, globBase))))) return secret;
      }
      if (/\.omp[\\/]agent[\\/](?:[^/]*-api-key|agent\.db|mcp\.json|cuelo-api-credits|\.env)/.test(file)) return file;
    }
  }
}

export default function secretPathGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    const secret = secretPathViolation(event.toolName, event.input, ctx.cwd);
    if (secret) return { block: true, reason: `${SANDBOX_HINT} secret-path-guard refused access to ${secret}. Do not retry with another in-process tool.` };
  });
}
