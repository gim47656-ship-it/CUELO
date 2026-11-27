import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { checkOutputHint } from "../../extensions/command-guard/check-output-hint";
import { invokedCommandLines } from "../../extensions/command-guard/matcher";
import { onSessionLifecycle } from "../../extensions/lib/session-identity";
import { didNotSucceed } from "../../extensions/lib/tool-outcome";
import type { TurnEndNotices } from "../../extensions/turn-end-guard";

// 2026-11-21 연구 근거(advisory only, 호출을 막거나 바꾸지 않는다):
// - arXiv 2611.02207 BOBA (2026-11-01): 코딩 에이전트 10종이 단일 요청은 95%, 20개 연쇄 요청은 51%만 끝낸다. 자체 테스트가 실수를 놓치고
//   자기 검토는 53%만 맞으며, 외부의 "틀렸다" 한 번과 수정 한 번이 연쇄 성공을 59%로 올린다.
// - arXiv 2610.35488 FeatureLoop (2026-10-26): 실패한 단계 중 두 번 수정 안에 복구되는 것은 15.4%뿐이고 앞 동작이 퇴행한다.
// 앞 요청에서 통과한 검사를 뒤의 파일 변경 뒤에 다시 돌리지 않은 채 완료를 말하는 일을 한 번 짚어 준다.

export const EVENTS_FILE = "cuelo-recheck-hint-events.jsonl";
export const MAX_ITEMS = 5;
export const MAX_NOTICE = 600;
const COMMAND_EXCERPT = 60;
const MAX_PATHS = 3;

// 검사 판별은 extensions/command-guard/check-output-hint.ts(RUNNERS/CHECKS/TOOLS)와 같은 목록이다. 그 파일은 분류기를 내보내지 않고
// command-guard를 고치지 않기로 했으므로 최소한만 옮겨 적었다. 그쪽 목록이 바뀌면 여기도 맞춘다.
const RUNNERS: Record<string, true> = { bun: true, npm: true, pnpm: true, yarn: true, npx: true, bunx: true };
const CHECKS = /^(?:test|tests|typecheck|lint|build|check|verify|smoke)(?::|$)/;
const TOOLS: Record<string, true> = { vitest: true, jest: true, pytest: true, tsc: true, eslint: true };

function runnerTarget(args: string[], runner: string): string | undefined {
  let position = 0;
  while (position < args.length) {
    const arg = args[position]!;
    if (arg === "--") return args[position + 1];
    if (arg.startsWith("-")) {
      const takesValue = /^(?:--require|--import|--loader|--cwd|--prefix|-C|--dir|-p|--package|--workspace|--filter|-F|--loglevel|--env-file|--userconfig|--globalconfig|--cache|--registry|--include|--exclude|--from|--jobs|-j)$/.test(arg)
        || (arg === "-r" && runner !== "pnpm")
        || (arg === "-w" && (runner === "npm" || runner === "npx"));
      position += takesValue ? 2 : 1;
      continue;
    }
    if (/^(?:run|run-script|exec|x|dlx)$/.test(arg)) {
      position++;
      continue;
    }
    if (runner === "yarn" && arg === "workspaces" && /^(?:foreach|run)$/.test(args[position + 1] ?? "")) {
      position += 2;
      continue;
    }
    if (runner === "yarn" && arg === "workspace") {
      position += 2;
      continue;
    }
    return arg;
  }
  return undefined;
}

/** 이 bash 명령이 검사를 부르는지. `--help`/`--version` 호출은 검사가 아니다. */
export function isCheckCommand(command: string): boolean {
  return invokedCommandLines(command).some(({ word, args }) => {
    const name = word.replace(/\\/g, "/").split("/").at(-1)?.replace(/\.exe$/i, "").toLowerCase() ?? "";
    if (args.includes("--help") || args.includes("--version")) return false;
    if (Object.hasOwn(TOOLS, name)) return true;
    if (name === "node" && args.includes("--test")) return true;
    if (!Object.hasOwn(RUNNERS, name)) return false;
    const target = runnerTarget(args, name);
    return target !== undefined && (CHECKS.test(target) || Object.hasOwn(TOOLS, target));
  });
}

type Log = (record: Record<string, unknown>) => void;
export type Signature = (cwd: string) => Promise<string | undefined>;

export interface RecheckHintOptions {
  /** 기록 파일 경로. 없으면 환경 변수 CUELO_RECHECK_HINT_EVENTS_PATH, 그것도 없으면 에이전트 폴더의 {@link EVENTS_FILE}. */
  eventsPath?: string;
  log?: Log;
  signature?: Signature;
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_OPTIONAL_LOCKS" && key !== "GIT_TERMINAL_PROMPT") delete env[key];
  return new Promise((done) => {
    execFile("git", ["-c", "core.fsmonitor=false", ...args], { cwd, env, timeout: 4_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => done(error ? undefined : stdout));
  });
}

/**
 * HEAD와 `git status --porcelain`, `git diff HEAD --numstat`의 해시. status만으로는 이미 수정된 파일을 다시 고친 것을 못 보므로
 * 줄 수 통계를 함께 쓴다. 한계: 줄 수가 같은 내용 교체, 추적하지 않는 파일의 내용 변경은 보지 못한다. git이 아니거나 실패하면 undefined.
 */
export const gitSignature: Signature = async (cwd) => {
  const [head, status, numstat] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["status", "--porcelain=v1", "-z"]),
    git(cwd, ["diff", "HEAD", "--numstat", "-z"]),
  ]);
  if (status === undefined) return undefined;
  return createHash("sha1").update(`${head ?? ""}\0${status}\0${numstat ?? ""}`).digest("hex");
};

interface Check { key: string; command: string; cwd: string; seq: number; request: number; sig?: string }

const squeeze = (text: string): string => text.replace(/\s+/g, " ").trim();
const excerpt = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** 안내 본문. 앞선 요청의 검사를 먼저, 같은 요청 안에서는 오래 전에 통과한 것부터 최대 {@link MAX_ITEMS}개를 보이고 나머지는 개수만 센다. 600자를 넘기지 않는다. */
export function noticeText(items: readonly Check[], changed: readonly string[]): string {
  const ordered = [...items].sort((a, b) => a.request - b.request || a.seq - b.seq);
  const shown = ordered.slice(0, MAX_ITEMS);
  const head = `[recheck-hint] 앞서 통과한 검사 ${ordered.length}개가 이후 파일 변경(${changed.length ? changed.join(", ") : "git 작업 트리 변경"}) 뒤 다시 실행되지 않았다. 변경 경로를 다루는 검사는 완료를 말하기 전에 다시 돌린다. 자동 실행·차단 아님: `;
  const tail = (omitted: number) => (omitted > 0 ? ` 외 ${omitted}개` : "");
  let rows = shown.map((item) => `\`${excerpt(squeeze(item.command), COMMAND_EXCERPT)}\`(요청 ${item.request})`);
  let text = head + rows.join(", ") + tail(ordered.length - rows.length);
  while (text.length > MAX_NOTICE && rows.length > 1) {
    rows = rows.slice(0, -1);
    text = head + rows.join(", ") + tail(ordered.length - rows.length);
  }
  return excerpt(text, MAX_NOTICE);
}

export function createRecheckHint(options: RecheckHintOptions = {}) {
  const eventsPath = options.eventsPath ?? process.env.CUELO_RECHECK_HINT_EVENTS_PATH ?? join(import.meta.dir, "..", "..", EVENTS_FILE);
  const log: Log = options.log ?? ((record) => {
    try {
      appendFileSync(eventsPath, `${JSON.stringify(record)}\n`);
    } catch {
      // 기록 실패는 안내 동작을 막지 않는다.
    }
  });
  const signature = options.signature ?? gitSignature;

  return function recheckHint(pi: ExtensionAPI): void {
    let sessionId: string | undefined;
    let clock = 0;
    let request = 0;
    let checks = new Map<string, Check>();
    let lastChange = 0;
    let changedThisInput = false;
    let recentPaths: string[] = [];
    let currentSig: string | undefined;
    let dirty = false;
    let announced = new Set<string>();
    let announcedItems = new Set<string>();
    let shuttingDown = false;

    const reset = () => {
      clock = 0;
      request = 0;
      checks = new Map();
      lastChange = 0;
      changedThisInput = false;
      recentPaths = [];
      currentSig = undefined;
      dirty = false;
      announced = new Set();
      announcedItems = new Set();
    };
    onSessionLifecycle(pi, { start: (ctx) => { reset(); shuttingDown = false; sessionId = ctx.sessionManager?.getSessionId?.(); } });
    pi.on("session_shutdown", () => { reset(); shuttingDown = true; });
    pi.on("input", (event) => {
      if (event.source !== "interactive" && event.source !== "rpc") return;
      shuttingDown = false;
      request += 1;
      changedThisInput = false;
    });

    const record = (kind: string, extra: Record<string, unknown>) =>
      log({ ts: new Date().toISOString(), sessionId, role: "main", kind, ...extra });
    const itemKey = (item: Check) => `${item.key}@${item.seq}`;
    // 낡은 검사: 통과 뒤에 edit/write가 있었거나, 통과 때 서명과 지금 서명이 다르다(Maker·셸·eval 등 경로와 무관).
    const stale = (): Check[] => [...checks.values()].filter((item) =>
      item.seq < lastChange || (item.sig !== undefined && currentSig !== undefined && item.sig !== currentSig));

    // 서명을 새로 읽는다. 검사가 하나도 없으면 읽지 않는다(비용을 검사 통과 뒤에만 낸다). 바뀌었으면 이 요청에서 파일이 바뀐 것이다.
    const refresh = async (cwd: string) => {
      dirty = false;
      if (!checks.size) return undefined;
      const next = await signature(cwd);
      if (next === undefined) return undefined;
      if (currentSig !== undefined && next !== currentSig) changedThisInput = true;
      currentSig = next;
      return next;
    };

    const noteChange = (paths: string[]) => {
      lastChange = ++clock;
      changedThisInput = true;
      for (const path of paths) recentPaths = [...recentPaths.filter((known) => known !== path), path];
      recentPaths = recentPaths.slice(-MAX_PATHS);
    };

    // 같은 (검사 집합, 변경 집합) 조합은 세션에서 한 번만 안내한다. 재실행으로 통과하면 그 검사는 기록이 새 순번으로 바뀌어 집합에서 빠진다.
    const compose = (kind: string, items: readonly Check[]): string | undefined => {
      if (!items.length) return undefined;
      const setKey = items.map(itemKey).sort().join("\n");
      if (announced.has(setKey)) return undefined;
      announced.add(setKey);
      for (const item of items) announcedItems.add(itemKey(item));
      const text = noticeText(items, recentPaths);
      record(kind, {
        changed: recentPaths,
        items: [...items].sort((a, b) => a.request - b.request || a.seq - b.seq).slice(0, MAX_ITEMS)
          .map((item) => ({ command: excerpt(squeeze(item.command), 120), cwd: item.cwd, request: item.request })),
        count: items.length,
      });
      return text;
    };

    const targets = (input: Record<string, unknown>, cwd: string): string[] => {
      const found: string[] = [];
      const add = (raw: unknown) => {
        if (typeof raw !== "string" || !raw.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim())) return;
        const path = isAbsolute(raw.trim()) ? resolve(raw.trim()) : resolve(cwd, raw.trim());
        const rel = relative(cwd, path);
        found.push(rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path);
      };
      add(input.path);
      if (Array.isArray(input.paths)) input.paths.forEach(add);
      if (!found.length) for (const match of String(input.input ?? "").matchAll(/^\[([^\]\n#]+)#[0-9A-Fa-f]{4}\]/gm)) add(match[1]);
      return found;
    };

    // git_finalize는 HEAD를 옮기므로 서명은 호출 전(tool_call)에 읽는다. 결과 글은 tool_result에서 붙인다.
    const finalizeSnapshots = new Map<string, Check[]>();
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "git_finalize" || shuttingDown || ctx.agent?.kind === "sub" || !checks.size) return;
      await refresh(ctx.cwd);
      finalizeSnapshots.set(event.toolCallId, stale());
    });

    pi.on("tool_result", async (event, ctx) => {
      if (shuttingDown || ctx.agent?.kind === "sub") return;
      const input = (event.input ?? {}) as Record<string, unknown>;
      if (event.toolName === "edit" || event.toolName === "write") {
        if (!didNotSucceed(event)) noteChange(targets(input, ctx.cwd));
        return;
      }
      // Maker(task 접수·wait 결과), 셸 명령, eval은 작업 트리를 바꿨을 수 있다. 결과 글로는 알 수 없으므로 서명 확인 대상으로만 표시한다.
      if (event.toolName === "task" || event.toolName === "wait" || event.toolName === "eval" || event.toolName === "bash") {
        if (checks.size) dirty = true;
      }
      if (event.toolName === "bash") {
        const command = typeof input.command === "string" ? input.command.trim() : "";
        const details: unknown = event.details;
        const exitCode = details && typeof details === "object" && "exitCode" in details && typeof details.exitCode === "number" ? details.exitCode : undefined;
        // 종료 코드를 보고하지 않은 실행(백그라운드·서비스)은 통과도 실패도 아니다.
        if (!command || exitCode === undefined || !isCheckCommand(command)) return;
        const cwd = typeof input.cwd === "string" && input.cwd ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
        const key = `${cwd}\0${squeeze(command)}`;
        const previous = checks.get(key);
        // 실패한 재실행은 더 이상 "통과한 검사"가 아니다: 모델이 실패를 직접 보았으므로 목록에서 뺀다.
        if (exitCode !== 0 || didNotSucceed(event)) {
          checks.delete(key);
          return;
        }
        // 검사 뒤에 출력 가공 명령이 붙어 종료 코드가 가공 명령의 것일 수 있으면 통과로 믿지 않는다(check-output-hint와 같은 판정).
        if (checkOutputHint(command)) return;
        if (previous && announcedItems.has(itemKey(previous))) {
          record("rerun-after-reminder", { command: excerpt(squeeze(command), 120), request });
        }
        const check: Check = { key, command, cwd, seq: ++clock, request };
        checks.set(key, check);
        // 이 통과 시점의 서명. 앞 검사들은 이 서명과 다르면 그 사이 작업 트리가 바뀐 것이다.
        check.sig = await refresh(ctx.cwd);
        return;
      }
      if (event.toolName === "git_finalize") {
        const snapshot = finalizeSnapshots.get(event.toolCallId);
        finalizeSnapshots.delete(event.toolCallId);
        if (didNotSucceed(event) || !snapshot) return;
        // 게시는 HEAD만 옮기고 내용을 바꾸지 않는다: 낡지 않은 검사의 기준 서명을 게시 뒤 서명으로 옮겨 둔다.
        const post = await signature(ctx.cwd);
        if (post !== undefined) {
          const staleKeys = new Set(snapshot.map(itemKey));
          for (const item of checks.values()) if (!staleKeys.has(itemKey(item))) item.sig = post;
          currentSig = post;
        }
        const text = compose("remind-finalize", snapshot);
        if (!text) return;
        const content = Array.isArray(event.content) ? event.content : [];
        const part = content.find((candidate) => candidate.type === "text");
        if (!part || part.type !== "text") return { content: [...content, { type: "text" as const, text }] };
        return { content: content.map((candidate) => (candidate === part ? { ...part, text: `${part.text}\n\n${text}` } : candidate)) };
      }
    });

    // 턴 끝 안내는 turn-end-guard가 한 번 보내는 aside에 마지막 조각으로 붙는다(턴을 따로 늘리지 않는다).
    // 그 이벤트는 동기라 서명을 읽을 수 없다. 도구 결과나 비동기 완료로 작업 트리가 바뀌었을 수 있는 턴은 turn_end(agent_end 앞에 순서대로 대기)에서 미리 읽어 둔다.
    pi.on("turn_end", async (_event, ctx) => {
      if (shuttingDown || ctx.agent?.kind === "sub" || !dirty) return;
      await refresh(ctx.cwd);
    });
    // Maker 완료는 대개 비동기다: task 결과는 접수 영수증뿐이고 파일은 나중에 바뀐다. 자동 전달되는 완료 메시지가 가장 이른 관측 경계다.
    pi.on("message_start", (event, ctx) => {
      if (shuttingDown || ctx.agent?.kind === "sub" || !checks.size) return;
      const message = event.message as { role?: string; customType?: string };
      if (message.role === "custom" && message.customType === "async-result") dirty = true;
    });
    pi.events.on("cuelo:turn-end-notices", (data) => {
      const { ctx, notices } = data as TurnEndNotices;
      if (shuttingDown || ctx.agent?.kind === "sub" || !changedThisInput) return;
      const text = compose("remind-turn-end", stale());
      if (text) notices.push(text);
    });
  };
}

export default createRecheckHint();
