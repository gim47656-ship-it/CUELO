/**
 * Linux에서 SSH로 Windows VM(PowerShell 5.1 기본 셸)에 스크립트를 보내고 결과를 받는 부분.
 *
 * 스크립트는 UTF-16LE base64(`-EncodedCommand`)로, 매개변수는 UTF-8 JSON base64로 보낸다. 한글 경로가 셸 따옴표와
 * 코드페이지를 거치지 않게 하려는 것이다. 결과도 UTF-8 JSON을 base64로 한 줄에 담아 돌려받는다. sshd 기본 셸(바깥
 * PowerShell)이 안쪽 PowerShell 출력을 OEM 코드페이지로 다시 읽어도 ASCII만 지나가므로 한글이 깨지지 않는다.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** 주면 stdout을 이 파일에 쓰고 문자열로는 모으지 않는다(pack처럼 큰 바이너리). */
  stdoutFile?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunResult { code: number; stdout: string; stderr: string; killed: boolean }
export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

const MAX_CAPTURE = 64 * 1024 * 1024;

export const runProcess: Runner = (command, args, options = {}) => {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let killed = false;
  let settled = false;
  const kill = () => {
    if (child.exitCode === null) {
      killed = true;
      child.kill("SIGTERM");
    }
  };
  const timer = options.timeoutMs ? setTimeout(kill, options.timeoutMs) : undefined;
  options.signal?.addEventListener("abort", kill, { once: true });
  let fileDone = Promise.resolve();
  if (options.stdoutFile) {
    const written = Promise.withResolvers<void>();
    const out = createWriteStream(options.stdoutFile);
    out.on("finish", written.resolve).on("error", written.reject);
    child.stdout.pipe(out);
    fileDone = written.promise;
  } else {
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk;
    });
  }
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (stderr.length < MAX_CAPTURE) stderr += chunk;
  });
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fileDone.then(() => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr, killed }), reject);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input ?? "");
  return promise;
};

/**
 * 무거운 Linux 쪽 명령(큰 저장소 status·add·pack)을 낮은 CPU·I/O 우선순위로 감싼다. 화면 끊김의 원인이 밝혀지지 않아
 * 효과를 주장하지 않는다. 다른 일을 덜 방해하게 하는 보수적 기본값일 뿐이다.
 */
export function lowPriority(command: string, args: string[]): [string, string[]] {
  if (existsSync("/usr/bin/ionice")) return ["/usr/bin/ionice", ["-c", "3", "nice", "-n", "10", command, ...args]];
  return ["nice", ["-n", "10", command, ...args]];
}

export const RESULT_MARKER = "__CUELO_VM_RESULT__";
/** Windows 명령줄 한도 32767자 안에 바깥 셸 명령까지 들어가도록 남긴 여유. */
const MAX_ENCODED = 30000;

const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [Text.Encoding]::UTF8
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}
$P = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PARAMS__')) | ConvertFrom-Json
function Emit($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.WriteLine('${RESULT_MARKER}' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
  exit 0
}
function G {
  param([string[]]$A)
  $ErrorActionPreference = 'Continue'
  $o = & git -c "safe.directory=$($P.safe)" -c core.quotepath=false -C $P.repo @A 2>&1 | ForEach-Object { "$_" }
  [pscustomobject]@{ code = $LASTEXITCODE; out = ((@($o) -join "` + "`n" + String.raw`").Trim()) }
}
trap { Emit @{ fatal = "$_" } }
`;

/** 매개변수를 끼운 전체 스크립트를 `-EncodedCommand` 값(UTF-16LE base64)으로 만든다. */
export function encodeRemoteScript(body: string, params: unknown): string {
  const payload = Buffer.from(JSON.stringify(params), "utf8").toString("base64");
  const script = `${PRELUDE.replace("__PARAMS__", payload)}\n${body}\n`;
  return Buffer.from(script, "utf16le").toString("base64");
}

/** ssh 출력에서 마지막 결과 줄을 찾아 JSON으로 푼다. 결과 줄이 없으면 ssh·PowerShell이 그 전에 끝난 것이다. */
export function parseRemoteResult<T>(result: RunResult): T {
  const line = result.stdout.split(/\r?\n/).reverse().find((item) => item.startsWith(RESULT_MARKER));
  if (!line) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-2000) || "출력 없음";
    throw new Error(`VM 명령이 결과를 돌려주지 않았다(ssh exit ${result.code}${result.killed ? ", 시간 초과 또는 취소" : ""}): ${detail}`);
  }
  return JSON.parse(Buffer.from(line.slice(RESULT_MARKER.length).trim(), "base64").toString("utf8")) as T;
}

export function sshArgs(host: string, encoded: string): string[] {
  return [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30",
    host, `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
  ];
}

export async function runRemote<T>(
  run: Runner, host: string, body: string, params: unknown, timeoutMs: number, signal?: AbortSignal,
): Promise<T> {
  const encoded = encodeRemoteScript(body, params);
  if (encoded.length > MAX_ENCODED) throw new Error(`VM 스크립트가 Windows 명령줄 한도를 넘는다(${encoded.length}자)`);
  return parseRemoteResult<T>(await run("ssh", sshArgs(host, encoded), { timeoutMs, signal }));
}
