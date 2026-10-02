// Claude Code CLI를 CUELO Maker 실행 코어로 쓰는 어댑터.
// - 모델: core가 넘긴 auth-gateway router(OMP AuthStorage·해석된 발주 모델 고정)를 실행별 loopback 서버로 감싸
//   `ANTHROPIC_BASE_URL`·`ANTHROPIC_AUTH_TOKEN`으로 준다. Claude Code 자체 로그인은 쓰지 않는다.
// - 권한: `bypassPermissions`를 쓰지 않는다. `dontAsk` + 허용 목록 위에 `PreToolUse` hook(claude-guard.ts)이
//   OWNED_PATHS 밖 쓰기·raw git·파괴 명령을 거절한다. 사용자 ~/.claude 설정은 읽지 않는다(`--setting-sources ""`).
// - 종료: dispose()는 Claude 프로세스 트리가 끝난 것을 관측한 뒤에만 resolve한다.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { type GuardPolicy, parseOwnedPaths } from "./claude-guard";
import type {
  ExternalMakerEvent,
  ExternalMakerRuntime,
  ExternalMakerSession,
  ExternalMakerSessionOptions,
  GatewayRouter,
} from "./types";
import { attachProcessTreeJob } from "./win-job";

// Claude stream-json은 중첩 필드를 옵셔널 체인으로 읽는다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

const GUARD_SCRIPT = path.join(import.meta.dir, "claude-guard.ts");
/** hook이 판정하는 도구. 이 도구가 끝났는데 판정 기록이 없으면 hook이 돌지 않은 것이다. */
const GUARDED_TOOLS: Record<string, true> = { Write: true, Edit: true, MultiEdit: true, NotebookEdit: true, Bash: true, PowerShell: true };
const ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "LS",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Bash",
  "PowerShell",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
];
/** OMP thinking level → Claude Code `--effort`. `off`는 넘기지 않는다(Claude Code 기본 adaptive). */
const EFFORT_BY_THINKING: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};
const GRACEFUL_EXIT_MS = 3_000;

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Claude Code stream-json 한 줄을 core 이벤트로 바꾼다. */
export function convertClaudeMessage(message: JsonObject): ExternalMakerEvent[] {
  const events: ExternalMakerEvent[] = [];
  if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
    events.push({ type: "session_started", sessionId: message.session_id, engine: "claude" });
  }
  if (message.type === "stream_event") {
    const delta = message.event?.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string") events.push({ type: "text_delta", text: delta.text });
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") events.push({ type: "reasoning_delta", text: delta.thinking });
  }
  if (message.type === "assistant" && message.parent_tool_use_id == null && Array.isArray(message.message?.content)) {
    for (const block of message.message.content) {
      if (block?.type === "tool_use") {
        events.push({ type: "tool_started", id: String(block.id ?? randomUUID()), name: String(block.name ?? "tool"), input: block.input });
      }
    }
  }
  if (message.type === "user" && message.parent_tool_use_id == null && Array.isArray(message.message?.content)) {
    for (const block of message.message.content) {
      if (block?.type === "tool_result") {
        events.push({
          type: "tool_completed",
          id: String(block.tool_use_id ?? ""),
          output: stringifyOutput(block.content),
          isError: block.is_error === true,
        });
      }
    }
  }
  if (message.type === "result") {
    const usage = message.usage;
    if (usage) {
      events.push({
        type: "usage",
        input: Number(usage.input_tokens ?? 0),
        cachedInput: Number(usage.cache_read_input_tokens ?? 0),
        cacheWrite: Number(usage.cache_creation_input_tokens ?? 0),
        output: Number(usage.output_tokens ?? 0),
      });
    }
    const failed = message.is_error === true || String(message.subtype ?? "").startsWith("error");
    events.push({ type: "turn_completed", stopReason: failed ? "error" : "stop", text: typeof message.result === "string" ? message.result : "" });
  }
  return events;
}

/** 설치된 Claude Code 실행 파일. npm `.cmd` shim이면 cmd.exe 층 없이 옆의 claude.exe를 쓴다. `CUELO_CLAUDE_BIN`이 우선. */
function resolveClaudeCommand(env: Record<string, string>): string[] {
  const override = env.CUELO_CLAUDE_BIN?.trim();
  if (override) return override.endsWith(".ts") ? [process.execPath, override] : [override];
  const found = Bun.which("claude", { PATH: env.PATH ?? env.Path ?? process.env.PATH ?? "" });
  if (!found) throw new Error("Claude Code CLI(`claude`)를 PATH에서 찾지 못했다");
  if (process.platform === "win32" && /\.cmd$/i.test(found)) {
    const exe = path.join(path.dirname(found), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(exe)) return [exe];
  }
  return [found];
}

/** hook을 돌릴 bun. 컴파일된 omp 바이너리 안이면 PATH의 bun을 쓴다. */
function resolveBun(env: Record<string, string>): string {
  if (/^bun(\.exe)?$/i.test(path.basename(process.execPath))) return process.execPath;
  const found = Bun.which("bun", { PATH: env.PATH ?? env.Path ?? process.env.PATH ?? "" });
  if (!found) throw new Error("PreToolUse hook을 실행할 bun을 찾지 못했다");
  return found;
}

/** Claude 프로세스와 그 자손 전체. Windows는 Job Object, 그 외는 detached spawn으로 만든 프로세스 그룹. */
interface ProcessTree {
  terminate(signal?: NodeJS.Signals): void;
  alive(): boolean;
  close(): void;
}

function trackProcessTree(pid: number): ProcessTree {
  if (process.platform === "win32") {
    // taskkill /T 는 MSYS(Git Bash) 손자에 닿지 못한다 — win-job.ts 머리말.
    const job = attachProcessTreeJob(pid);
    return { terminate: () => job.terminate(), alive: () => job.activeProcesses() > 0, close: () => job.close() };
  }
  return {
    terminate: (signal = "SIGTERM") => {
      try {
        process.kill(-pid, signal);
      } catch {}
    },
    alive: () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    close: () => {},
  };
}

/** 강제 종료는 비동기라 잠시 남을 수 있다. `ms` 안에 트리가 비면 true. */
async function treeEnded(tree: ProcessTree, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (tree.alive()) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
  return true;
}

/** 브리프 cwd부터 위로 올라가며 AGENTS.md를 모은다(가까운 것 먼저). */
function projectAgentsFiles(cwd: string): string[] {
  const files: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, "AGENTS.md");
    if (existsSync(candidate)) files.push(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return files;
    dir = parent;
  }
}

/** `---\ndescription: ...\n---` frontmatter의 description. */
function frontmatterDescription(file: string): string {
  try {
    const text = readFileSync(file, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    return match ? (/^description:\s*(.*)$/m.exec(match[1])?.[1] ?? "").trim() : "";
  } catch {
    return "";
  }
}

function listDocs(dir: string, pick: (entry: string) => string | undefined): string[] {
  if (!existsSync(dir)) return [];
  const lines: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const file = pick(entry);
    if (file && existsSync(file)) lines.push(`- ${file.replace(/\\/g, "/")} — ${frontmatterDescription(file)}`);
  }
  return lines;
}

/** maker SOP·브리프 위에 덧붙이는 CUELO 규칙·엔진 차이 안내. */
export function buildEngineSystemPrompt(options: ExternalMakerSessionOptions, ownedPaths: string[] | null): string {
  const sections: string[] = [options.systemPrompt.trim()];
  const rules = path.join(options.agentDir, "RULES.md");
  if (existsSync(rules)) sections.push(`§ CUELO 전역 규칙 (${rules.replace(/\\/g, "/")})\n\n${readFileSync(rules, "utf8").trim()}`);
  for (const file of projectAgentsFiles(options.cwd)) {
    sections.push(`§ 프로젝트 규칙 (${file.replace(/\\/g, "/")})\n\n${readFileSync(file, "utf8").trim()}`);
  }
  const ruleDocs = listDocs(path.join(options.agentDir, "rules"), entry => (entry.endsWith(".md") ? path.join(options.agentDir, "rules", entry) : undefined));
  const skillDocs = [
    ...listDocs(path.join(options.agentDir, "skills"), entry => path.join(options.agentDir, "skills", entry, "SKILL.md")),
    ...listDocs(path.join(options.agentDir, "managed-skills"), entry => path.join(options.agentDir, "managed-skills", entry, "SKILL.md")),
  ];
  if (ruleDocs.length > 0) {
    sections.push(`§ 영역 규칙 (\`rule://<name>\` 대신 해당 파일을 Read로 연다)\n\n${ruleDocs.join("\n")}`);
  }
  if (skillDocs.length > 0) {
    sections.push(`§ Skill (\`skill://<name>\` 대신 해당 SKILL.md를 Read로 연다. 맞는 Skill이 있으면 먼저 읽는다)\n\n${skillDocs.join("\n")}`);
  }
  const owned = ownedPaths
    ? `이번 발주의 OWNED_PATHS(cwd \`${options.cwd.replace(/\\/g, "/")}\` 기준): ${ownedPaths.join(", ")}`
    : "이번 브리프에는 OWNED_PATHS가 없다. 모든 쓰기가 거절된다. 조사만 하고 최종 보고의 `## Blocker`에 `OWNED_PATHS 없음`을 적는다.";
  sections.push(
    [
      "§ 실행 엔진: Claude Code (OMP 아님)",
      "",
      "- 이 Maker 세션은 CUELO가 Claude Code CLI로 실행한다. OMP 도구 대응: read→Read, edit→Edit/Write, grep→Grep, glob→Glob, bash→Bash(또는 PowerShell).",
      "- 쓸 수 없는 OMP 도구·URL: `write agent://…`(Main DM·편집 전 체크포인트), `git_finalize`, `yield`, `task`, `maker_route`, `routing_verdict`, `checkpoint`/`rewind`, `recall`/`retain`/`learn`, `ask`, `eval`, `browser`, `computer`, `skim`, `ast_grep`/`ast_edit`, `lsp`, `debug`, `generate_image`, `rule://`·`skill://`·`artifact://`·`agent://`·`local://`·`proc://` URL.",
      "- 편집 전 체크포인트 DM은 보낼 수 없다. 대신 최종 보고에 `## 편집 계약` 절(위치·불변식·동작 변화·검사 명령·틀릴 것 같은 지점)을 적는다.",
      "- Main의 결정이나 승인이 필요하거나 막히면 그 자리에서 멈추고 최종 보고의 `## Blocker` 절에 원인 근거·시도한 것·필요한 결정을 적은 뒤 턴을 끝낸다.",
      `- ${owned}`,
      "- PreToolUse hook이 OWNED_PATHS 밖 쓰기, raw `git commit`/`push`/`reset`/`rebase` 같은 이력 변경, 재귀 삭제·DB 쓰기 같은 파괴 명령을 거절한다. 거절되면 다른 명령으로 우회하지 말고 Blocker로 보고한다.",
      "- 이 턴의 마지막 assistant 텍스트가 그대로 Main이 받는 task 결과다. yield 대신 최종 보고를 일반 텍스트로 쓴다.",
      "- 진행 발화와 최종 보고는 한국어로 쓴다. 코드·명령·경로·API 이름·원문 오류는 그대로 둔다.",
    ].join("\n"),
  );
  return `${sections.join("\n\n")}\n`;
}

/** Claude Code가 transcript를 두는 곳: `<config>/projects/<cwd의 영숫자 외 문자를 '-'로>/<session>.jsonl`. */
function transcriptPathFor(env: Record<string, string>, cwd: string, sessionId: string): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude");
  return path.join(configDir, "projects", path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

interface GuardLogEntry {
  toolUseId?: string;
  toolName?: string;
  allow: boolean;
  reason?: string;
  transcriptPath?: string;
}

class ClaudeMakerSession implements ExternalMakerSession {
  readonly engine = "claude" as const;
  readonly id = randomUUID();
  private readonly listeners = new Set<(event: ExternalMakerEvent) => void>();
  private readonly runDir: string;
  private readonly policy: GuardPolicy;
  private readonly guardedToolIds = new Set<string>();
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private server?: { port?: number; stop(closeActiveConnections?: boolean): void };
  private router?: GatewayRouter;
  private pendingTurn?: { resolve: () => void; reject: (error: Error) => void; text: string; aborted: boolean };
  private guardFailure?: string;
  private disposed = false;

  constructor(private readonly options: ExternalMakerSessionOptions) {
    this.runDir = mkdtempSync(path.join(tmpdir(), "cuelo-claude-maker-"));
    this.policy = {
      cwd: path.resolve(options.cwd),
      ownedPaths: parseOwnedPaths(options.assignment),
      decisionLog: path.join(this.runDir, "decisions.jsonl"),
    };
  }

  onEvent(handler: (event: ExternalMakerEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private emit(event: ExternalMakerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private guardLog(): GuardLogEntry[] {
    if (!this.policy.decisionLog || !existsSync(this.policy.decisionLog)) return [];
    return readFileSync(this.policy.decisionLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as GuardLogEntry);
  }

  /** hook과 같은 명령으로 guard를 한 번 돌려 거절 판정이 나오는지 본다. hook 실행 실패는 Claude Code에서 fail-open이다. */
  private preflightGuard(bun: string, policyFile: string): void {
    const probe = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" } });
    const result = spawnSync(bun, [GUARD_SCRIPT, policyFile], { input: probe, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (!`${result.stdout ?? ""}`.includes('"permissionDecision":"deny"')) {
      throw new Error(`PreToolUse guard 사전 확인 실패(exit ${result.status}): ${`${result.stderr ?? ""}`.trim().slice(0, 400)}`);
    }
    rmSync(this.policy.decisionLog!, { force: true });
  }

  /** 실행별 loopback gateway. 이 실행의 Claude 프로세스만 아는 bearer로 막는다. */
  private startGateway(): { baseUrl: string; token: string } {
    const token = randomUUID();
    const router = this.options.createGatewayRouter();
    this.router = router;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 255,
      fetch: async req => {
        const bearer = req.headers.get("authorization");
        if (bearer !== `Bearer ${token}` && req.headers.get("x-api-key") !== token) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/messages") return router.route(req, "127.0.0.1");
        // Claude Code는 system[0]에 자기 `x-anthropic-billing-header:` 블록을 넣는다. gateway는 system 블록을 하나로
        // 합치므로 합친 전체가 그 접두로 시작하고, Anthropic은 그 블록을 청구 헤더로 읽어 Claude Code 본 프롬프트와
        // CUELO 주입 절을 모델에 주지 않았다(실측). 그 블록만 빼면 pi-ai가 자기 헤더를 별도 블록으로 붙인다.
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }, { status: 400 });
        }
        if (body && typeof body === "object" && "system" in body && Array.isArray(body.system)) {
          body.system = body.system.filter(
            (block: unknown) => !(block && typeof block === "object" && "text" in block && typeof block.text === "string" && block.text.startsWith("x-anthropic-billing-header:")),
          );
        }
        const headers = new Headers(req.headers);
        headers.delete("content-length");
        return router.route(new Request(req.url, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal }), "127.0.0.1");
      },
    });
    return { baseUrl: `http://127.0.0.1:${this.server.port}`, token };
  }

  private start(): void {
    if (this.child) return;
    const env: Record<string, string> = { ...this.options.env };
    const bun = resolveBun(env);
    const policyFile = path.join(this.runDir, "policy.json");
    writeFileSync(policyFile, JSON.stringify(this.policy));
    this.preflightGuard(bun, policyFile);
    const forward = (value: string) => value.replace(/\\/g, "/");
    const settingsFile = path.join(this.runDir, "settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "*", hooks: [{ type: "command", command: `"${forward(bun)}" "${forward(GUARD_SCRIPT)}" "${forward(policyFile)}"`, timeout: 60 }] },
          ],
        },
      }),
    );
    const promptFile = path.join(this.runDir, "system-prompt.md");
    writeFileSync(promptFile, buildEngineSystemPrompt(this.options, this.policy.ownedPaths));
    const gateway = this.startGateway();

    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_BASE_URL"]) delete env[key];
    env.ANTHROPIC_BASE_URL = gateway.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = gateway.token;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.DISABLE_AUTOUPDATER = "1";

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      this.options.model,
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      ALLOWED_TOOLS.join(","),
      "--setting-sources",
      "",
      "--settings",
      settingsFile,
      "--strict-mcp-config",
      "--append-system-prompt-file",
      promptFile,
      "--session-id",
      this.id,
    ];
    const effort = this.options.thinking ? EFFORT_BY_THINKING[this.options.thinking] : undefined;
    if (effort) args.push("--effort", effort);
    const [command, ...prefix] = resolveClaudeCommand(env);
    // 앱 타입(Next)은 ProcessEnv에 NODE_ENV를 필수로 둔다. 자식에게는 core가 거른 env를 그대로 넘기므로
    // 그 값이 없을 수 있고, 타입만 맞춘다.
    const spawnEnv = env as NodeJS.ProcessEnv;
    const child = spawn(command, [...prefix, ...args], {
      cwd: this.options.cwd,
      env: spawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.child = child;
    try {
      this.tree = trackProcessTree(child.pid!);
    } catch (error) {
      child.kill();
      throw new Error(`Claude 프로세스 트리를 묶지 못해 실행하지 않는다(취소 시 종료를 보장할 수 없음): ${error instanceof Error ? error.message : String(error)}`);
    }
    const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
    this.exited = exited;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    createInterface({ input: child.stdout! }).on("line", line => this.acceptLine(line));
    child.on("error", error => {
      this.emit({ type: "error", message: error.message });
      const turn = this.pendingTurn;
      this.pendingTurn = undefined;
      turn?.reject(error);
    });
    child.on("close", (code, signal) => {
      markExited();
      const turn = this.pendingTurn;
      if (!turn) return;
      this.pendingTurn = undefined;
      if (turn.aborted) {
        this.emit({ type: "turn_completed", stopReason: "aborted", text: turn.text });
        turn.resolve();
        return;
      }
      const message = this.guardFailure ?? `Claude Code exited (${signal ?? code}): ${stderr.trim()}`;
      this.emit({ type: "error", message });
      this.emit({ type: "turn_completed", stopReason: "error", text: turn.text });
      turn.reject(new Error(message));
    });
  }

  private acceptLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    for (const event of convertClaudeMessage(message)) {
      if (event.type === "tool_started" && GUARDED_TOOLS[event.name] === true) this.guardedToolIds.add(event.id);
      if (event.type === "tool_completed" && this.guardedToolIds.delete(event.id)) {
        if (!this.guardLog().some(entry => entry.toolUseId === event.id)) {
          // hook이 돌지 않았다(Claude Code는 hook 실행 실패를 막지 않는다). 더 진행하지 않는다.
          this.guardFailure = `PreToolUse guard가 도구 호출 ${event.id}를 판정하지 않았다 — 소유 경로 강제를 보장할 수 없어 세션을 끝낸다`;
          this.emit(event);
          this.emit({ type: "error", message: this.guardFailure });
          this.terminate();
          return;
        }
      }
      if (event.type === "text_delta" && this.pendingTurn) this.pendingTurn.text += event.text;
      if (event.type === "turn_completed" && this.pendingTurn) {
        const turn = this.pendingTurn;
        this.pendingTurn = undefined;
        const text = `${event.text.trim() ? event.text : turn.text}\n\n${this.sessionTrailer()}`;
        this.emit({ ...event, stopReason: turn.aborted ? "aborted" : event.stopReason, text });
        turn.resolve();
        continue;
      }
      this.emit(event);
    }
  }

  /** Main이 읽거나 이어 갈 수 있도록 결과 끝에 남기는 세션 정보. */
  private sessionTrailer(): string {
    const log = this.guardLog();
    const transcript = log.find(entry => entry.transcriptPath)?.transcriptPath ?? transcriptPathFor(this.options.env, this.options.cwd, this.id);
    const denied = log.filter(entry => !entry.allow);
    const lines = [
      "## Claude Code 세션",
      `- session_id: ${this.id}`,
      `- transcript: ${transcript.replace(/\\/g, "/")}${existsSync(transcript) ? "" : " (파일 미확인)"}`,
      `- 재개: cwd \`${this.options.cwd.replace(/\\/g, "/")}\`에서 \`claude --resume ${this.id}\` (gateway env 없이 열면 사용자 자신의 Claude 로그인·기본 모델로 이어진다)`,
      `- 모델: ${this.options.model} (OMP auth-gateway 경유), effort: ${this.options.thinking ?? "기본"}`,
      `- guard: 판정 ${log.length}건, 거절 ${denied.length}건${denied.length > 0 ? ` — ${denied.map(entry => `${entry.toolName}: ${entry.reason}`).join(" / ")}` : ""}`,
    ];
    if (!this.policy.ownedPaths) lines.push("- blocker: OWNED_PATHS 없음 — 브리프에 소유 경로가 없어 모든 쓰기를 거절했다");
    return lines.join("\n");
  }

  async prompt(message: string): Promise<void> {
    if (this.disposed) throw new Error("Claude maker session is disposed");
    if (this.pendingTurn) throw new Error("Claude maker session already has an active turn");
    this.start();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.pendingTurn = { resolve, reject, text: "", aborted: false };
    const line = `${JSON.stringify({ type: "user", message: { role: "user", content: message }, parent_tool_use_id: null })}\n`;
    this.child!.stdin!.write(line, error => {
      if (!error) return;
      this.pendingTurn = undefined;
      reject(error);
    });
    return promise;
  }

  /** 살아 있는 트리를 지금 끝낸다. */
  private terminate(): void {
    this.tree?.terminate();
  }

  private tree?: ProcessTree;

  async abort(): Promise<void> {
    const turn = this.pendingTurn;
    if (!turn) return;
    turn.aborted = true;
    this.terminate();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    const tree = this.tree;
    try {
      if (child && tree && this.exited) {
        if (this.pendingTurn) {
          // 끝나지 않은 턴(취소·배포 drain·오류): 기다리지 않고 트리를 끊는다.
          this.pendingTurn.aborted = true;
          tree.terminate();
        } else {
          child.stdin?.end();
          const graceful = await Promise.race([this.exited.then(() => true), Bun.sleep(GRACEFUL_EXIT_MS).then(() => false)]);
          if (!graceful) tree.terminate();
        }
        await this.exited;
        // 정상 종료 뒤에도 남은 자손(배경 셸 등)이 있으면 끝낸다.
        if (tree.alive()) tree.terminate();
        let ended = await treeEnded(tree, 2_000);
        if (!ended) {
          tree.terminate("SIGKILL");
          ended = await treeEnded(tree, 2_000);
        }
        if (!ended) throw new Error("Claude 프로세스 트리가 종료되지 않았다");
      }
    } finally {
      tree?.close();
      this.server?.stop(true);
      this.router?.close();
      rmSync(this.runDir, { recursive: true, force: true });
    }
  }
}

export function createClaudeRuntime(): ExternalMakerRuntime {
  return {
    engine: "claude",
    async createSession(options) {
      mkdirSync(options.cwd, { recursive: true });
      return new ClaudeMakerSession(options);
    },
  };
}
