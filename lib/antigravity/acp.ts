import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import appPackage from "../../package.json";
import type { AntigravityErrorCode } from "./types";

export class AntigravityError extends Error {
  constructor(readonly code: AntigravityErrorCode, message: string) { super(message); }
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveAgyBinary(configured = process.env.CUELO_AGY_BIN, path = process.env.PATH, home = homedir()): string {
  if (configured) {
    if (isAbsolute(configured) && executable(configured)) return configured;
    throw new AntigravityError("not_installed", "CUELO_AGY_BIN must point to an executable absolute path.");
  }
  for (const directory of (path ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const binary = join(directory, "agy");
    if (executable(binary)) return binary;
  }
  const managed = join(home, ".omp", "antigravity-cli", "bin");
  let versions: string[];
  try {
    versions = readdirSync(managed);
  } catch {
    versions = [];
  }
  for (const entry of versions.filter((value) => /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }))) {
    const binary = join(managed, entry, "agy");
    if (executable(binary)) return binary;
  }
  throw new AntigravityError("not_installed", "The Antigravity CLI (agy) is not installed on this host.");
}

// Keep ordinary process context, not the credentials or harness settings of
// the CUELO server. None of these values is redirected to another store.
function childEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:HOME|PATH|USER|LOGNAME|SHELL|TERM|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z_]+)$/.test(key)));
}

type RpcId = number | string;
type Pending = { resolve: (result: Record<string, unknown>) => void; reject: (reason: Error) => void; timer?: NodeJS.Timeout };

export class AcpConnection {
  readonly #child;
  readonly #exit: Promise<void>;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #failure: AntigravityError | undefined;
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  onRequest?: (id: RpcId, method: string, params: Record<string, unknown>) => void;
  onDisconnect?: (error: AntigravityError) => void;

  constructor(cwd: string, binary = resolveAgyBinary()) {
    // Next augments ProcessEnv with a required NODE_ENV for its own server.
    // The subprocess receives only the allowlisted process context.
    this.#child = spawn(binary, ["acp"], { cwd, env: childEnvironment() as NodeJS.ProcessEnv, shell: false, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#exit = promise;
    this.#child.once("exit", (code, signal) => {
      this.#fail(new AntigravityError("disconnected", `Antigravity exited (${signal ?? code ?? "unknown"}).`));
    });
    this.#child.once("close", resolve);
    this.#child.on("error", () => this.#fail(new AntigravityError("unavailable", "Could not start Antigravity.")));
    this.#child.stdin.on("error", () => this.#fail(new AntigravityError("disconnected", "Antigravity closed its input.")));
    createInterface({ input: this.#child.stdout, crlfDelay: Infinity }).on("line", (line) => this.#receive(line));
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "CUELO", version: appPackage.version },
    });
    if (result.protocolVersion !== 1) throw new AntigravityError("unavailable", "Antigravity did not negotiate ACP version 1.");
    return object(result.agentCapabilities);
  }

  request(method: string, params: object, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = ++this.#nextId;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    const timer = timeoutMs > 0 ? setTimeout(() => {
      this.#fail(new AntigravityError("disconnected", `Antigravity did not answer ${method}.`));
    }, timeoutMs) : undefined;
    timer?.unref();
    this.#pending.set(id, { resolve, reject, timer });
    this.#send({ id, method, params });
    return promise;
  }

  notify(method: string, params: object) { this.#send({ method, params }); }
  reply(id: RpcId, result: object) { this.#send({ id, result }); }
  unsupported(id: RpcId) { this.#send({ id, error: { code: -32601, message: "Method not supported by CUELO" } }); }

  terminate(signal: NodeJS.Signals) {
    const pid = this.#child.pid;
    if (!pid || this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  async close(): Promise<void> {
    // Signal the process group while the leader's identity still belongs to
    // this child. Never signal a potentially reused group after reaping it.
    this.terminate("SIGKILL");
    this.#child.stdin.destroy();
    this.#child.stdout.destroy();
    await this.#exit;
  }

  #send(value: object) {
    if (!this.#failure) this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  }

  #fail(error: AntigravityError) {
    if (this.#failure) return;
    this.#failure = error;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
    this.onDisconnect?.(error);
  }

  #receive(line: string) {
    if (!line.trim() || this.#failure) return;
    let message: Record<string, unknown>;
    try {
      message = object(JSON.parse(line));
      if (message.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC version");
    } catch {
      this.#fail(new AntigravityError("disconnected", "Antigravity returned invalid ACP output."));
      return;
    }
    const { method, id } = message;
    if (typeof method === "string") {
      const params = object(message.params);
      if (typeof id === "string" || typeof id === "number") {
        if (this.onRequest) this.onRequest(id, method, params);
        else this.unsupported(id);
      } else {
        this.onNotification?.(method, params);
      }
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = object(message.error);
    if (error.code === -32000) pending.reject(new AntigravityError("auth_required", "Authentication required"));
    else if (message.error) pending.reject(new AntigravityError("unavailable", typeof error.message === "string" ? error.message : "Antigravity request failed."));
    else pending.resolve(object(message.result));
  }
}
