// Claude Code `PreToolUse` command hook. 어댑터가 `--settings`로 등록하고 실행별 policy 파일 경로를 인자로 준다.
//   bun claude-guard.ts <policy.json>   (stdin: Claude Code hook input JSON)
// 브리프 `OWNED_PATHS` 밖 쓰기, raw git 기록 변경, 파괴 명령을 거절한다. 판정 중 오류가 나도 거절한다(fail closed).
// 허용이면 아무것도 출력하지 않아 Claude Code의 권한 모드가 나머지를 정한다.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

export interface GuardPolicy {
  /** OWNED_PATHS의 기준 디렉터리(발주 cwd). */
  cwd: string;
  /** `null`이면 브리프에 OWNED_PATHS가 없다 — 모든 쓰기를 거절한다. */
  ownedPaths: string[] | null;
  /** 판정 기록(JSONL). 어댑터가 hook이 실제로 돌았는지 확인하는 데 쓴다. */
  decisionLog?: string;
}

export type GuardDecision = { allow: true } | { allow: false; reason: string };

const ALLOW: GuardDecision = { allow: true };
const deny = (reason: string): GuardDecision => ({ allow: false, reason });

/** TASK_GUARD `OWNED_PATHS:` 한 줄(콤마 구분). 절대경로·`..` 항목은 무효로 버린다. 유효 항목이 없으면 `null`. */
export function parseOwnedPaths(brief: string): string[] | null {
  const match = /^[ \t]*OWNED_PATHS:[ \t]*(.*)$/mu.exec(brief);
  if (!match) return null;
  const entries = match[1]
    .split(",")
    .map(entry => entry.trim().replace(/\\/g, "/"))
    .filter(entry => entry.length > 0 && !path.isAbsolute(entry) && !/^[A-Za-z]:/.test(entry))
    .filter(entry => !entry.split("/").includes(".."));
  return entries.length > 0 ? entries : null;
}

const isWindows = process.platform === "win32";

/** Git Bash `/f/x` 형식을 `F:/x`로 바꾼다. */
function nativePath(value: string): string {
  if (isWindows) {
    const drive = /^\/([A-Za-z])(\/|$)/.exec(value);
    if (drive) return `${drive[1].toUpperCase()}:/${value.slice(3)}`;
  }
  return value;
}

/** `target`이 OWNED_PATHS 안이면 true. 규칙: 후행 `/`는 디렉터리 prefix, 없으면 정확한 파일, `.`은 cwd 전체. */
export function isOwnedPath(policy: GuardPolicy, target: string): boolean {
  if (!policy.ownedPaths) return false;
  const absolute = path.resolve(policy.cwd, nativePath(target));
  const relative = path.relative(policy.cwd, absolute).replace(/\\/g, "/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return false;
  const rel = isWindows ? relative.toLowerCase() : relative;
  for (const raw of policy.ownedPaths) {
    const stripped = raw.replace(/^(\.\/)+/, "");
    const entry = isWindows ? stripped.toLowerCase() : stripped;
    if (entry === "." || entry === "") return true;
    if (entry.endsWith("/")) {
      if (rel === entry.slice(0, -1) || rel.startsWith(entry)) return true;
    } else if (rel === entry) {
      return true;
    }
  }
  return false;
}

function writeDecision(policy: GuardPolicy, target: string): GuardDecision {
  if (!policy.ownedPaths) return deny("OWNED_PATHS 없음: 브리프에 소유 경로가 없어 모든 쓰기를 거절한다");
  if (isOwnedPath(policy, target)) return ALLOW;
  return deny(`OWNED_PATHS 밖 쓰기 거절: ${target} (허용: ${policy.ownedPaths.join(", ")})`);
}

type Token = { word: string } | { op: string };

/** 따옴표·이스케이프·연산자를 아는 최소 셸 토크나이저. bash와 PowerShell 공통 근사. */
function tokenize(command: string, shell: "bash" | "powershell"): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let hasWord = false;
  const flush = () => {
    if (hasWord) tokens.push({ word: current });
    current = "";
    hasWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      current += command.slice(i + 1, stop);
      hasWord = true;
      i = stop;
    } else if (ch === '"') {
      let j = i + 1;
      let text = "";
      while (j < command.length && command[j] !== '"') {
        if (shell === "bash" && command[j] === "\\" && j + 1 < command.length && '"\\$`'.includes(command[j + 1])) j++;
        else if (shell === "powershell" && command[j] === "`" && j + 1 < command.length) j++;
        text += command[j];
        j++;
      }
      current += text;
      hasWord = true;
      i = j;
    } else if (shell === "bash" && ch === "\\" && i + 1 < command.length) {
      i++;
      if (command[i] !== "\n") {
        current += command[i];
        hasWord = true;
      }
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      flush();
    } else if (ch === "\n" || ch === ";" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      flush();
      tokens.push({ op: ";" });
    } else if (ch === "&" || ch === "|") {
      flush();
      if (ch === "&" && command[i + 1] === ">") {
        i += command[i + 2] === ">" ? 2 : 1;
        tokens.push({ op: ">" });
      } else {
        if (command[i + 1] === ch) i++;
        tokens.push({ op: ";" });
      }
    } else if (ch === ">" || ch === "<") {
      // `2>`·`1>>`의 fd 숫자는 대상이 아니다.
      if (hasWord && /^\d+$/.test(current)) {
        current = "";
        hasWord = false;
      }
      flush();
      if (ch === "<") {
        tokens.push({ op: "<" });
        continue;
      }
      if (command[i + 1] === ">") i++;
      if (command[i + 1] === "&") {
        // `>&2` 같은 fd 복제
        i++;
        tokens.push({ op: ">&" });
      } else {
        tokens.push({ op: ">" });
      }
    } else {
      current += ch;
      hasWord = true;
    }
  }
  flush();
  return tokens;
}

const NULL_TARGETS: Record<string, true> = { "/dev/null": true, nul: true, $null: true, "nul:": true };
const NESTED_SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, cmd: true, powershell: true, pwsh: true };
const GIT_WRITE_SUBCOMMANDS: Record<string, true> = {
  commit: true,
  push: true,
  reset: true,
  rebase: true,
  merge: true,
  "cherry-pick": true,
  revert: true,
  am: true,
  clean: true,
  "filter-branch": true,
  "filter-repo": true,
  "update-ref": true,
  restore: true,
};
const SQL_CLIENTS: Record<string, true> = { sqlcmd: true, osql: true, sqlite3: true, psql: true, mysql: true, "invoke-sqlcmd": true };
const SQL_WRITE =
  /\b(?:drop\s+(?:table|database|schema|view|procedure)|truncate\s+table|delete\s+from|insert\s+into|update\s+\S+\s+set|alter\s+(?:table|database))\b/i;

function gitDecision(args: string[]): GuardDecision {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    // `-C <dir>`·`-c <k=v>`·`--git-dir <dir>`처럼 값을 따로 받는 전역 옵션
    if (/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(args[i])) i++;
    i++;
  }
  const sub = args[i]?.toLowerCase();
  const rest = args.slice(i + 1);
  if (!sub) return ALLOW;
  const rawGit = (detail: string) => deny(`raw git 거절: git ${detail} — 커밋·푸시·이력 변경은 Main의 git_finalize 몫이다`);
  if (GIT_WRITE_SUBCOMMANDS[sub] === true) return rawGit(sub);
  if ((sub === "branch" || sub === "tag") && rest.some(arg => /^(-d|-D|--delete)$/.test(arg) || /^-[a-zA-Z]*[dD]/.test(arg)))
    return rawGit(`${sub} 삭제`);
  if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) return rawGit(`stash ${rest[0]}`);
  if (sub === "checkout" && rest.some(arg => arg === "--" || arg === "-f" || arg === "--force" || arg === "."))
    return rawGit("checkout(작업 트리 폐기)");
  if (sub === "switch" && rest.some(arg => arg === "-f" || arg === "--force" || arg === "--discard-changes"))
    return rawGit("switch --discard-changes");
  if (sub === "worktree" && rest[0] === "remove") return rawGit("worktree remove");
  return ALLOW;
}

function nonFlagArgs(args: string[]): string[] {
  return args.filter(arg => !arg.startsWith("-"));
}

/** PowerShell `-Name value` 또는 첫 위치 인자. */
function psTarget(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i].toLowerCase())) return args[i + 1];
  }
  return args.find(arg => !arg.startsWith("-"));
}

function segmentDecision(policy: GuardPolicy, words: string[], shell: "bash" | "powershell", depth: number): GuardDecision {
  let start = 0;
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start++;
  if (start >= words.length) return ALLOW;
  const name = (words[start].replace(/\\/g, "/").split("/").pop() ?? words[start]).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  const args = words.slice(start + 1);
  const lowerArgs = args.map(arg => arg.toLowerCase());
  const joined = args.join(" ");

  if (["sudo", "env", "command", "exec", "nohup", "time", "xargs", "nice"].includes(name)) {
    const rest = name === "xargs" || name === "env" ? args.filter(arg => !arg.startsWith("-") || arg === "--") : args;
    return segmentDecision(policy, rest.filter(arg => arg !== "--"), shell, depth);
  }
  if (NESTED_SHELLS[name] === true) {
    const flagIndex = lowerArgs.findIndex(arg => arg === "-c" || arg === "/c" || arg === "/k" || arg === "-command" || arg === "-lc");
    if (flagIndex >= 0) {
      const nested = args.slice(flagIndex + 1).join(" ");
      return commandDecision(policy, nested, name === "powershell" || name === "pwsh" ? "powershell" : "bash", depth + 1);
    }
    if (lowerArgs.some(arg => arg === "-encodedcommand" || arg === "-enc" || arg === "-e"))
      return deny("인코딩된 PowerShell 명령은 검사할 수 없어 거절한다");
    return ALLOW;
  }
  if (name === "git") return gitDecision(args);

  if (name === "rm" || name === "remove-item" || name === "ri" || name === "del" || name === "erase" || name === "rmdir" || name === "rd") {
    const recursive =
      args.some(arg => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg) || arg === "--recursive") ||
      lowerArgs.some(arg => arg === "-recurse" || arg === "/s");
    if (recursive) return deny(`파괴 명령 거절: ${name} 재귀 삭제`);
    const targets =
      name === "remove-item" || name === "ri" ? [psTarget(args, ["-path", "-literalpath"])].filter(Boolean) as string[] : nonFlagArgs(args).filter(arg => !arg.startsWith("/"));
    for (const target of targets) {
      const decision = writeDecision(policy, target);
      if (!decision.allow) return decision;
    }
    return ALLOW;
  }
  if (name === "find" && lowerArgs.includes("-delete")) return deny("파괴 명령 거절: find -delete");
  if (/^mkfs(\.|$)/.test(name) || name === "diskpart" || name === "shred" || name === "format" || name === "format-volume" || name === "clear-disk")
    return deny(`파괴 명령 거절: ${name}`);
  if (name === "dd" && args.some(arg => arg.startsWith("of="))) return deny("파괴 명령 거절: dd of=");
  if (SQL_CLIENTS[name] === true && SQL_WRITE.test(joined)) return deny(`DB 쓰기 거절: ${name}`);

  const writeTargets: string[] = [];
  if (name === "tee" || name === "touch" || name === "mkdir" || name === "md") writeTargets.push(...nonFlagArgs(args));
  else if (name === "cp" || name === "mv" || name === "copy" || name === "move") {
    const plain = nonFlagArgs(args);
    if (plain.length > 1) writeTargets.push(plain[plain.length - 1]);
    if (name === "mv" || name === "move") writeTargets.push(...plain.slice(0, -1));
  } else if (name === "copy-item" || name === "move-item" || name === "cpi" || name === "mi") {
    const destination = psTarget(args, ["-destination"]);
    if (destination) writeTargets.push(destination);
    if (name === "move-item" || name === "mi") {
      const source = psTarget(args, ["-path", "-literalpath"]);
      if (source) writeTargets.push(source);
    }
  } else if (["out-file", "set-content", "add-content", "new-item", "ni", "sc", "ac"].includes(name)) {
    const target = psTarget(args, ["-filepath", "-path", "-literalpath"]);
    if (target) writeTargets.push(target);
  } else if (name === "sed" && args.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"))) {
    writeTargets.push(...nonFlagArgs(args).slice(1));
  }
  for (const target of writeTargets) {
    const decision = writeDecision(policy, target);
    if (!decision.allow) return decision;
  }
  return ALLOW;
}

/** Bash·PowerShell 명령 문자열 판정. 리다이렉트 대상과 알려진 쓰기·파괴 명령만 본다. */
export function commandDecision(policy: GuardPolicy, command: string, shell: "bash" | "powershell" = "bash", depth = 0): GuardDecision {
  if (depth > 4) return deny("중첩 셸이 너무 깊어 검사할 수 없다");
  const tokens = tokenize(command, shell);
  let words: string[] = [];
  const finish = (): GuardDecision => {
    const decision = segmentDecision(policy, words, shell, depth);
    words = [];
    return decision;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if ("word" in token) {
      words.push(token.word);
      continue;
    }
    if (token.op === ">") {
      const next = tokens[i + 1];
      if (next && "word" in next) {
        i++;
        if (NULL_TARGETS[next.word.toLowerCase()] !== true) {
          if (/[$%`]/.test(next.word)) return deny(`변수가 든 리다이렉트 대상은 소유 경로를 확인할 수 없어 거절한다: ${next.word}`);
          const decision = writeDecision(policy, next.word);
          if (!decision.allow) return decision;
        }
      }
      continue;
    }
    if (token.op === ">&" || token.op === "<") {
      const next = tokens[i + 1];
      if (next && "word" in next) i++;
      continue;
    }
    const decision = finish();
    if (!decision.allow) return decision;
  }
  return finish();
}

/** Claude Code 도구 호출 하나에 대한 판정. */
export function decideToolUse(policy: GuardPolicy, toolName: string, toolInput: Record<string, unknown>): GuardDecision {
  switch (toolName) {
    case "Write":
    case "Edit":
    case "MultiEdit": {
      const target = toolInput.file_path;
      return typeof target === "string" ? writeDecision(policy, target) : deny(`${toolName}: file_path 없음`);
    }
    case "NotebookEdit": {
      const target = toolInput.notebook_path;
      return typeof target === "string" ? writeDecision(policy, target) : deny("NotebookEdit: notebook_path 없음");
    }
    case "Bash":
    case "PowerShell": {
      const command = toolInput.command;
      if (typeof command !== "string") return deny(`${toolName}: command 없음`);
      return commandDecision(policy, command, toolName === "PowerShell" ? "powershell" : "bash");
    }
    default:
      return ALLOW;
  }
}

async function main(): Promise<void> {
  let policy: GuardPolicy | undefined;
  let decision: GuardDecision;
  let input: Record<string, unknown> = {};
  try {
    policy = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as GuardPolicy;
    input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as Record<string, unknown>;
    const toolInput = input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
    decision = decideToolUse(policy, String(input.tool_name ?? ""), toolInput);
  } catch (error) {
    decision = deny(`CUELO guard 오류로 거절: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (policy?.decisionLog) {
    try {
      appendFileSync(
        policy.decisionLog,
        `${JSON.stringify({
          toolUseId: input.tool_use_id,
          toolName: input.tool_name,
          transcriptPath: input.transcript_path,
          allow: decision.allow,
          reason: decision.allow ? undefined : decision.reason,
        })}\n`,
      );
    } catch {}
  }
  if (!decision.allow) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason },
      }),
    );
  }
}

if (import.meta.main) await main();
