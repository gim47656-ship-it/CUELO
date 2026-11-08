/**
 * 보수 대시보드용 세션 기록 스캔. 최근 14일 안에 바뀐 세션 JSONL을 한 줄씩 읽어 최근 7일(index 0)과
 * 직전 7일(index 1) 두 묶음으로 센다. 라이브 서버의 요청 처리를 막지 않도록 약 8ms마다 이벤트 루프에
 * 양보한다. 읽은 값이 없으면 0이 아니라 호출자가 미측정으로 다룰 수 있게 원 건수를 그대로 넘긴다.
 */
import { readdir, stat } from "node:fs/promises";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { join, relative, sep } from "node:path";
import { classifyToolError } from "../run-xray";
import { maskSecrets as sharedMaskSecrets } from "../session-recall";
import { CACHE_TTL_LONG_MS, CACHE_TTL_SHORT_MS, isComplaint, REWRITE_MIN_WRITE, REWRITE_READ_SHARE, SLOW_GAP_MS } from "./criteria";
import { emptySkillWindow, skillNamesFromPath, type SkillSessionUsage, type SkillWindowUsage } from "./skill-usage";
import type { UpkeepEvidence } from "./types";
import { loadUpkeepReader, readSessionEntries } from "./upkeep-reader";

const DAY_MS = 86_400_000;
const YIELD_EVERY_MS = 8;
const EVIDENCE_LIMIT = 10;
const TOP_SESSIONS = 5;
/** 실패 발췌(야간 묶음): 오류 묶음마다 최근 것 3개, 인자 요약 300자(값마다 80자), 오류 400자. */
const EXCERPTS_PER_SIGNATURE = 3;
const EXCERPT_ARGS = 300;
const EXCERPT_ARG_VALUE = 80;
const EXCERPT_ERROR = 400;
const NO_SKILLS: readonly string[] = [];

type Usage = {
  input?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number; cacheWrite?: number }; credentialKind?: string;
  cttl?: { ephemeral1h?: number };
};
type ContentBlock = { type?: string; id?: string; name?: string; text?: string; arguments?: { command?: string; path?: string; [key: string]: unknown } };
type Entry = {
  type?: string;
  id?: string;
  timestamp: string;
  customType?: string;
  purpose?: string;
  provider?: string;
  content?: unknown;
  usage?: Usage;
  data?: { ids?: unknown[]; dense?: number; gate?: number };
  cwd?: string;
  message?: {
    role?: string;
    attribution?: string;
    timestamp?: number;
    content?: unknown;
    usage?: Usage;
    model?: string;
    provider?: string;
    toolCallId?: string;
    credentialId?: unknown;
    toolName?: string;
    isError?: boolean;
  };
};

/**
 * 목적·모델 하나의 사용량 합계. 비용·캐시 필드가 빠진 기록이 있었는지도 기억한다. `subscription`은 OAuth(구독) 사용분,
 * `unknownAuth`는 인증 종류가 기록되지 않아 구독인지 모르는 Anthropic 사용분 금액이다. `providers`는 합친 제공자들이다.
 */
export type UsageTotal = {
  cost: number; input: number; write: number; calls: number; subscription: number; unknownAuth: number;
  missingCost: boolean; missingCache: boolean; providers: string[];
};

/** 본 요청 캐시를 다시 쓴 원인. `first`(세션 첫 요청)는 피할 수 없어 판정에서 뺀다. */
export const REWRITE_CAUSES = ["first", "compaction", "prompt", "model", "credential", "expired", "prefix"] as const;
export type RewriteCause = (typeof REWRITE_CAUSES)[number];
export const REWRITE_CAUSE_LABELS: Record<RewriteCause, string> = {
  first: "세션 첫 요청", compaction: "압축 직후", prompt: "시스템 프롬프트 바뀜", model: "모델 바뀜", credential: "계정 바뀜",
  expired: "캐시 만료", prefix: "앞부분 바뀜",
};

/** git_finalize가 기억 export에 실패했을 때 결과에 쓰는 문구(커밋은 진행된다). */
const EXPORT_FAILURE = "기억 export 실패";

/** OAuth 로그인으로만 쓰는 provider. 다른 provider는 기록의 `credentialKind`로 가린다(10-29부터 기록됨). */
const SUBSCRIPTION_PROVIDERS: Record<string, true> = { "openai-codex": true, "google-antigravity": true };

/** 한 기간(7일)의 집계. */
export type WindowCounts = {
  turns: number;
  calls: number;
  errors: number;
  rejects: number;
  compactions: number;
  /** 토큰이 기록된 모델 응답 수(Maker 자식 세션 포함, 토큰 없이 오류로 끝난 응답 제외). 압축 행의 분모다. */
  requests: number;
  nudges: number;
  recalls: number;
  emptyRecalls: number;
  gated: number;
  nearGate: number;
  recallCalls: number;
  exportFailures: number;
  complaints: number;
  cost: number;
  missingCost: boolean;
  /** credentialKind가 `api-key`로 기록된 호출(실제 청구) */
  apiKeyCalls: number;
  apiKeyCost: number;
  /** 본 요청(보조 호출 제외)의 캐시 쓰기 비용 전체와, 그중 다시 쓰기로 본 요청의 원인별 건수·비용 */
  cacheWriteCost: number;
  /** 피할 수 있었던 다시 쓰기(세션 첫 요청 제외) 중 캐시 쓰기 비용(`usage.cost.cacheWrite`)이 기록되지 않은 것이 있었는지 */
  missingRewriteCost: boolean;
  rewrites: Record<RewriteCause, { count: number; cost: number }>;
  gaps: number[];
  purposes: Record<string, UsageTotal>;
  models: Record<string, UsageTotal>;
  errorsBySignature: Record<string, number>;
};

/** 세션 하나의 비용 합계. `firstAt`·`lastAt`은 그 키로 처음·마지막 사용한 시각(ms)이라, 고침 표시와 견주어 고치기 전 사용이 들었는지 안다. */
export type SessionCost = { sessionId: string; sessionPath: string; cost: number; firstAt?: number; lastAt?: number };

/** 부모 세션에 도착한 Maker 결과(`async-result` 알림, `wait`·`hub` 회수). 원장에 남지 않는 `partial`을 여기서 읽는다. */
export type MakerResult = { sessionId: string; name: string; timestamp: string; durationSec: number | null; partial: boolean };

export type ScanResult = {
  windows: [WindowCounts, WindowCounts];
  scannedFiles: number;
  warnings: string[];
  /** 최근 7일 지표 id별 근거 사례(최대 10개) */
  evidence: Record<string, UpkeepEvidence[]>;
  /** 최근 7일 비용 상위 세션: 전체(`total`), 목적별(`purpose:<p>`), 모델별(`model:<모델 id>`), API 키 청구(`api-key`) */
  topSessions: Record<string, SessionCost[]>;
  /** 14일 안에 도착한 Maker 결과 */
  makerResults: MakerResult[];
  /** 고침 표시 시각(ms)별 최근 7일 집계: 표시 전(`before`)과 표시 이후(`after`, 표시 시각 포함) */
  splits: Map<number, SplitCounts>;
  /** 세션 헤더 cwd별 마지막 기록 시각(ms, 14일 안). worktree가 아직 쓰이는지 본다. */
  cwdActivity: Record<string, number>;
  /** 스킬별 두 기간 사용과, 최근 7일 스킬을 연 세션(연 뒤 오류 많은 순 10개) */
  skills: { windows: [Record<string, SkillWindowUsage>, Record<string, SkillWindowUsage>]; sessions: Record<string, SkillSessionUsage[]> };
  /** 14일 안 오류 묶음(`도구: 키`)별 최근 발췌 최대 3개 */
  failureExcerpts: Record<string, FailureExcerpt[]>;
  /** 14일 안에 실패 뒤 같은 턴에서 같은 도구가 성공한 기록 */
  recoveries: Recovery[];
};

/** 도구 실패 하나의 발췌. 모두 비밀을 가리고 자른 값이다. `recovery`는 같은 턴에서 같은 도구가 다음으로 성공한 호출의 인자 요약이다. */
export interface FailureExcerpt {
  args: string;
  error: string;
  recovery: string | null;
}

/** 실패 뒤 같은 턴에서 같은 도구가 성공한 기록. `shape`는 성공한 호출의 인자 모양(키 이름·명령 첫 단어·경로 종류)이다. */
export interface Recovery {
  signature: string;
  shape: string;
  sessionId: string;
  sessionPath: string;
  at: number;
}

export type SplitCounts = { before: WindowCounts; after: WindowCounts };

function emptyWindow(): WindowCounts {
  return {
    turns: 0, calls: 0, errors: 0, rejects: 0, compactions: 0, requests: 0, nudges: 0, recalls: 0, emptyRecalls: 0,
    gated: 0, nearGate: 0, recallCalls: 0, exportFailures: 0, complaints: 0, cost: 0, missingCost: false,
    apiKeyCalls: 0, apiKeyCost: 0, cacheWriteCost: 0, missingRewriteCost: false,
    rewrites: Object.fromEntries(REWRITE_CAUSES.map((cause) => [cause, { count: 0, cost: 0 }])) as WindowCounts["rewrites"],
    gaps: [], purposes: {}, models: {}, errorsBySignature: {},
  };
}

/**
 * 공용 비밀값 가리기에 이름 붙은 대입(`SECRET_KEY=…`, `x-api-key: …`, `auth_token: Bearer …`)을 더한다.
 * 이름은 남기고 값만 가린다. 따옴표로 감싼 값은 공백이 있어도 통째로 가린다.
 */
export function maskSecrets(text: string): string {
  return sharedMaskSecrets(text).text.replace(
    /\b([\w-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[-_]?KEY|PRIVATE[-_]?KEY|ACCESS[-_]?KEY)[\w-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|["'][^\n]*|(?:Bearer\s+)?[^\s"',;]+)/gi,
    "$1[가림]",
  );
}

/** `11m6s`·`2m19s`·`45s`·`1h2m` 꼴 경과 시간을 초로 바꾼다. */
function durationSeconds(text: string): number | null {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text);
  if (!match || !text) return null;
  return (+(match[1] ?? 0)) * 3600 + (+(match[2] ?? 0)) * 60 + (+(match[3] ?? 0));
}

/**
 * 알림이나 회수 스냅샷 하나에 든 Maker 결과 전부. 한 알림에 여러 결과가 묶이고(`── Job … ──`), 긴 결과는
 * `<output>` 대신 `<meta/>` 뒤 `<preview>`로 온다. partial은 각 결과 본문의 첫 JSON `status`로 판정한다.
 */
function taskResults(text: string): Omit<MakerResult, "sessionId" | "timestamp">[] {
  const heads = [...text.matchAll(/<task-result id="([^"]+)"[^>]*>/g)];
  return heads.map((head, i) => {
    const start = (head.index ?? 0) + head[0].length;
    const body = text.slice(start, heads[i + 1]?.index ?? text.length);
    const duration = /duration="([^"]+)"/.exec(head[0]);
    return {
      name: head[1],
      durationSec: duration ? durationSeconds(duration[1]) : null,
      partial: /^\s*(?:<meta[^>]*\/>\s*)?<(?:output|preview)\b[^>]*>\s*\{\s*"status":\s*"partial"/.test(body),
    };
  });
}

/**
 * wait·hub 스냅샷의 작업 블록. OMP(`async/job-control.ts`)는 완료 작업마다 `### <id> [<type>] — <status>`와
 * `Label:` 줄을 쓰고, 그 아래 `Delivery:` 줄과 결과 본문을 붙인다. 결과 본문 안의 마크다운 제목은 `Label:`이
 * 뒤따르지 않으므로 블록 경계가 아니다.
 */
const SNAPSHOT_JOB = /^### \S+ \[[^\]\n]+\] — [^\n]*\nLabel: /gm;

/**
 * wait·hub가 이 스냅샷에서 새로 넘긴 결과만 고른다. 작업 블록마다 자기 `Delivery:` 줄로 판정하며, 자동 알림 등으로
 * 이미 받은 결과를 다시 보여 주는 `already delivered or recovered`는 새 도착이 아니다(공개 이슈 #59).
 * `Delivery:` 줄이 없는 블록(취소된 작업)도 세지 않는다.
 */
function snapshotDeliveries(text: string): Omit<MakerResult, "sessionId" | "timestamp">[] {
  const starts = [...text.matchAll(SNAPSHOT_JOB)].map((match) => match.index ?? 0);
  return starts.flatMap((start, i) => {
    const block = text.slice(start, starts[i + 1] ?? text.length);
    const delivery = /^Delivery: (.*)$/m.exec(block)?.[1];
    return delivery && !delivery.startsWith("already delivered") ? taskResults(block) : [];
  });
}

const TRACEBACK_HEAD = /^Traceback \(most recent call last\):$/;
const TRACEBACK_FRAME = /^\s+File "[^"]*", line \d+/;
/**
 * 예외 줄. 첫 칸에서 시작하고 마지막 마디가 대문자로 시작하는 CamelCase 이름이며(파이썬 클래스 관례: `ValueError`,
 * `urllib.error.URLError`) 소문자를 하나 이상 품고, 그 뒤는 `: 메시지`이거나 줄 끝이다. pydantic 검증 오류의 필드
 * 이름(`name`)과 예외 뒤에 찍힌 로그 줄(`INFO: Shutting down`처럼 전부 대문자인 표지)은 여기에 걸리지 않는다.
 */
const EXCEPTION_LINE = /^(?:[A-Za-z_]\w*\.)*(?=[\w]*[a-z])[A-Z]\w*(?::(?:\s.*)?)?$/;
const NO_OUTPUT_LINE = /^\(no output\)$/;
const RUN_NOISE = /^(?:Wall time: [\d.]+ seconds|Command exited with code \d+)$/;
const EXIT_ONLY_LINE = /^Command exited with code (\d+)$/;
/** bash 실패에서 원인을 말하는 줄의 표지. 배너(`bun test v1.1.0`)나 통과 집계 줄보다 먼저 본다. */
const BASH_ERROR_MARK = /\b(?:error|errors|failed|failure|fatal|not found|no such|denied|cannot|can't|unable|Traceback|Exception)\b|오류|실패|없습니다|없다|차단/i;

/**
 * 실패를 대표하는 줄. Traceback 머리·프레임, 「(no output)」, 빈 줄, 실행 꼬리는 원인을 말하지 않으므로 건너뛴다.
 * Traceback이 있으면 마지막 예외 줄(terminal exception)을, bash면 오류 표지가 있는 첫 줄을, 그 밖에는 첫 뜻 있는
 * 줄을 쓴다. 뜻 있는 줄이 없으면 종료 코드 줄을 그대로 남겨 exit만 있는 실패도 근거를 잃지 않게 한다(2026-11-08:
 * 14일 111건 (no output)과 Traceback 머리가 각각 한 묶음으로 뭉쳤다).
 */
function errorLine(tool: string, lines: string[]): string {
  const usable = lines.filter((x) => {
    const t = x.trim();
    return t && !TRACEBACK_HEAD.test(t) && !TRACEBACK_FRAME.test(x) && !NO_OUTPUT_LINE.test(t) && !RUN_NOISE.test(t);
  });
  if (lines.some((x) => TRACEBACK_HEAD.test(x.trim()))) {
    const exceptions = usable.filter((x) => EXCEPTION_LINE.test(x.trim()));
    const terminal = (exceptions.at(-1) ?? usable.at(-1))?.trim();
    if (terminal) return terminal;
  }
  if (tool === "bash") {
    const marked = usable.find((x) => BASH_ERROR_MARK.test(x));
    if (marked) return marked.trim();
  }
  return (usable[0] ?? lines.find((x) => EXIT_ONLY_LINE.test(x.trim())) ?? lines[0] ?? "").trim();
}

/** 오류 대표 줄을 묶음 키로 만든다(경로→<p>, 긴 16진수→<h>, 숫자→N). exit만 있는 실패는 종료 코드를 남긴다. */
export function normalizeError(tool: string, text: string): string {
  const lines = text.split(/\r?\n/);
  const line = tool === "ego_browser"
    ? lines.find((x) => /Error|timed|not|failed/i.test(x)) ?? lines[0]
    : tool === "skim" ? lines.at(-1) ?? lines[0] : errorLine(tool, lines);
  const exitOnly = EXIT_ONLY_LINE.exec(line.trim());
  if (exitOnly) return `Command exited with code ${exitOnly[1]}`;
  return maskSecrets(line)
    .replace(/(?:[A-Za-z]:)?\/(?:[^\s:]+\/)*[^\s:]*/g, "<p>")
    .replace(/\b(?:0x)?[a-f\d]{8,}\b/gi, "<h>")
    .replace(/\d+/g, "N")
    .slice(0, 180);
}

/** 비밀을 가리고 공백을 접어 `limit`자로 자른다. 가리기 전에 넉넉히 잘라 큰 인자(파일 본문 등)를 통째로 훑지 않는다. */
export function clipMasked(text: string, limit: number): string {
  const masked = maskSecrets(text.slice(0, limit * 4)).replace(/\s+/g, " ").trim();
  return masked.length > limit ? `${masked.slice(0, limit)}…` : masked;
}

/** 도구 인자 요약: `키=값`을 이어 붙이고 값마다 80자, 전체 300자로 자른다. */
export function summarizeArgs(args: unknown): string {
  if (typeof args === "string") return clipMasked(args, EXCERPT_ARGS);
  if (!args || typeof args !== "object") return "";
  const pairs = Object.entries(args).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    return `${key}=${clipMasked(text, EXCERPT_ARG_VALUE)}`;
  });
  return clipMasked(pairs.join(" "), EXCERPT_ARGS);
}

/**
 * 성공한 호출의 인자 모양. 값은 버리고 키 이름(의도 `i` 제외), 명령의 첫 단어, 경로의 종류(`scheme://`·확장자)만 남겨
 * 세션이 달라도 같은 넘김 방법이면 같은 문자열이 되게 한다.
 */
export function argumentShape(tool: string, args: unknown): string {
  const record = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const parts = [`${tool}(${Object.keys(record).filter((key) => key !== "i").sort().join(",")})`];
  if (typeof record.command === "string") parts.push(`command=${normalizeError(tool, record.command.trim().split(/\s+/)[0] ?? "")}`);
  if (typeof record.path === "string") {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(record.path);
    const extension = /\.([A-Za-z0-9]{1,8})(?:[:?#][^/]*)?$/.exec(record.path);
    parts.push(`path=${scheme ? `${scheme[1]}://` : extension ? `*.${extension[1]}` : "<p>"}`);
  }
  return parts.join(" ");
}

/**
 * 사용자 중단·보조 건너뜀·취소처럼 의도된 비결함 오류. 대소문자 표기가 흔들려도 같은 뜻이므로 가리지 않는다.
 */
const INTENDED_ERROR = /^실행하지 않음: 이 호출이 실행되기 전에 사용자 메시지|^Skipped due to|Operation aborted|Request was aborted|Command aborted/i;

/**
 * 사전 점검 플러그인(argon-preflight)이 호출을 막고 돌려준 조언. 결과 첫 줄이 정확히 `[사전 점검] 오류가 아니다.`,
 * 도구 래퍼가 앞에 붙인 `Error: [사전 점검] 오류가 아니다.`, 옛 문구 `[아르곤 사전 점검] 오류가 아니다.` 중 하나일
 * 때만 제외한다(14일에 7건). 대소문자를 가리지 않으면 `ERROR:` 같은 다른 표기의 실제 실패까지 조언으로 삼키고,
 * 문구가 중간에 섞인 실패도 조언이 아니므로 대소문자를 그대로 본다(2026-11-08 점검판 오판정).
 */
const PREFLIGHT_ADVICE = /^(?:Error: )?\[사전 점검\] 오류가 아니다\.|^\[아르곤 사전 점검\] 오류가 아니다\./;

/**
 * 도구 결과 뒤 이것이 끼면 다음 요청은 도구 결과가 아니라 새 입력(사용자·다른 agent의 메시지, 백그라운드 결과)이나 세션 재개를
 * 기다린 것이라 느린 대기로 세지 않는다. 10-31 사무실 점검에서 20초 넘는 대기 222건 중 217건이 이런 대기였다(yield 뒤 재호출 130건 등).
 */
function isNewInput(entry: Entry): boolean {
  if (entry.type === "message") return entry.message?.role === "user";
  if (entry.type === "custom_message") return entry.customType === "irc:incoming" || entry.customType === "async-result";
  return entry.type === "custom" && entry.customType === "session_exit";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((x: ContentBlock | null) => x?.text ?? "").join("\n");
}

function addUsage(target: Record<string, UsageTotal>, key: string, usage: Usage, provider: string | undefined) {
  const row = target[key] ??= { cost: 0, input: 0, write: 0, calls: 0, subscription: 0, unknownAuth: 0, missingCost: false, missingCache: false, providers: [] };
  if (provider && !row.providers.includes(provider)) row.providers.push(provider);
  row.missingCost ||= typeof usage.cost?.total !== "number";
  row.missingCache ||= typeof usage.input !== "number" || typeof usage.cacheRead !== "number" || typeof usage.cacheWrite !== "number";
  const cost = Number(usage.cost?.total) || 0;
  row.cost += cost;
  row.calls++;
  if ((provider && Object.hasOwn(SUBSCRIPTION_PROVIDERS, provider)) || usage.credentialKind === "oauth") row.subscription += cost;
  else if (provider === "anthropic" && usage.credentialKind === undefined) row.unknownAuth += cost;
  row.input += (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0);
  row.write += Number(usage.cacheWrite) || 0;
}

/** 본 요청 하나. 다음 요청이 캐시를 다시 썼는지 견줄 때 쓴다. */
type MainRequest = { at: number; prompt: number; model: string; credentialId: unknown };

/**
 * 본 요청이 캐시를 다시 쓴 원인. 캐시 쓰기가 REWRITE_MIN_WRITE 이상이면서 캐시 읽기가 직전 요청 프롬프트의
 * REWRITE_READ_SHARE 미만일 때만 다시 쓰기로 보고, 원인은 아래 순서로 처음 맞는 것이다. 다시 쓰기가 아니면 null.
 */
function rewriteCause(usage: Usage, request: MainRequest, previous: MainRequest | null, compacted: boolean, promptChanged: boolean): RewriteCause | null {
  if ((Number(usage.cacheWrite) || 0) < REWRITE_MIN_WRITE) return null;
  if (!previous) return "first";
  if ((Number(usage.cacheRead) || 0) >= previous.prompt * REWRITE_READ_SHARE) return null;
  if (compacted) return "compaction";
  if (promptChanged) return "prompt";
  if (request.model !== previous.model) return "model";
  if (request.credentialId !== previous.credentialId) return "credential";
  if (request.at - previous.at > (Number(usage.cttl?.ephemeral1h) > 0 ? CACHE_TTL_LONG_MS : CACHE_TTL_SHORT_MS)) return "expired";
  return "prefix";
}

async function sessionFiles(dir: string, cutoff: number): Promise<string[]> {
  const files: { path: string; created: number; modified: number }[] = [];
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      try {
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".jsonl")) {
          const info = await stat(path);
          if (info.mtimeMs >= cutoff) files.push({ path, created: info.birthtimeMs, modified: info.mtimeMs });
        }
      } catch {
        continue;
      }
    }
  };
  await walk(dir);
  // 먼저 만들어진 파일부터 읽어야 fork·fixture 사본보다 원본이 중복 제거에서 이긴다.
  return files.sort((a, b) => a.created - b.created || a.modified - b.modified || a.path.localeCompare(b.path)).map((f) => f.path);
}

/** 세션별 비용을 키마다 모아 상위 세션을 고른다(최근 7일만). */
class SessionCostTable {
  private readonly byKey = new Map<string, Map<string, SessionCost>>();

  add(key: string, sessionId: string, sessionPath: string, cost: number, at: number) {
    let rows = this.byKey.get(key);
    if (!rows) this.byKey.set(key, (rows = new Map()));
    const row = rows.get(sessionPath) ?? { sessionId, sessionPath, cost: 0, firstAt: at, lastAt: at };
    row.cost += cost;
    row.firstAt = Math.min(row.firstAt ?? at, at);
    row.lastAt = Math.max(row.lastAt ?? at, at);
    rows.set(sessionPath, row);
  }

  top(): Record<string, SessionCost[]> {
    const out: Record<string, SessionCost[]> = {};
    for (const [key, rows] of this.byKey) out[key] = [...rows.values()].sort((a, b) => b.cost - a.cost).slice(0, TOP_SESSIONS);
    return out;
  }
}

/**
 * `splitAt`은 고침 표시 시각들이다. 최근 7일 사건을 표시마다 전·후 묶음에도 함께 세어, 파일은 표시 수와 관계없이
 * 한 번만 읽는다.
 */
export async function scanSessions(dir: string, now: number, splitAt: readonly number[] = []): Promise<ScanResult> {
  const windows: [WindowCounts, WindowCounts] = [emptyWindow(), emptyWindow()];
  const splits = new Map<number, SplitCounts>();
  for (const at of splitAt) if (!splits.has(at)) splits.set(at, { before: emptyWindow(), after: emptyWindow() });
  const evidence: Record<string, UpkeepEvidence[]> = {};
  const costs = new SessionCostTable();
  const slowGaps: { gap: number; row: UpkeepEvidence }[] = [];
  const rewriteRows: { first: boolean; cost: number; row: UpkeepEvidence }[] = [];
  const cwdActivity: Record<string, number> = {};
  const seenCalls = new Set<string>();
  const seenEntries = new Set<string>();
  // fork 사본은 원래 호출 entry를 건너뛰므로 호출 표는 파일마다가 아니라 스캔 전체에서 하나로 둔다.
  // `skills`는 그 호출 전에 같은 턴에서 연 스킬, `opens`는 이 호출이 여는 스킬들(`read skill://…`, `;`로 이은 경로 포함)이다. `turn`은 파일 안 턴 번호다.
  type Call = { name: string; command: string | null; index: 0 | 1; targets: WindowCounts[]; skills: readonly string[]; opens: readonly string[]; path: string; sessionId: string; turn: number };
  const calls = new Map<string, Call>();
  const makerResults: MakerResult[] = [];
  const warnings: string[] = [];
  // 스킬 계기판: 기간·스킬별 사용과 스킬을 연 세션별 기록, 기간·세션별 호출 합계(연 뒤가 아닌 나머지를 셀 때 쓴다).
  const skillAgg: [Map<string, SkillAgg>, Map<string, SkillAgg>] = [new Map(), new Map()];
  const sessionTotals: [Map<string, CallTotals>, Map<string, CallTotals>] = [new Map(), new Map()];
  const skillAt = (index: 0 | 1, name: string): SkillAgg => {
    let agg = skillAgg[index].get(name);
    if (!agg) skillAgg[index].set(name, (agg = { usage: emptySkillWindow(), lastAt: 0, sessions: new Map() }));
    return agg;
  };
  const skillSessionAt = (index: 0 | 1, name: string, call: Call): SkillSession => {
    const sessions = skillAt(index, name).sessions;
    let row = sessions.get(call.path);
    if (!row) sessions.set(call.path, (row = { sessionId: call.sessionId, opens: 0, afterCalls: 0, afterFailures: 0, lastAt: 0 }));
    return row;
  };
  // 결과가 오기 전 호출의 인자. 실패 발췌·넘김 모양에만 쓰고 결과가 오면 지운다.
  const pendingArgs = new Map<string, unknown>();
  const failureExcerpts: Record<string, FailureExcerpt[]> = {};
  const recoveries: Recovery[] = [];
  const finish = (): Pick<ScanResult, "skills" | "failureExcerpts" | "recoveries"> => ({ skills: skillResult(skillAgg, sessionTotals), failureExcerpts, recoveries });

  // 바이너리가 없으면 디렉터리·파일 오류 경고로 바꾸지 않고 스캔 전체가 그 오류로 실패한다.
  loadUpkeepReader();
  let files: string[];
  try {
    files = await sessionFiles(dir, now - 14 * DAY_MS);
  } catch {
    return { windows, scannedFiles: 0, warnings: ["세션 디렉터리를 읽지 못했습니다."], evidence, topSessions: {}, makerResults, splits, cwdActivity, ...finish() };
  }

  for (const path of files) {
    await yieldEventLoop();
    let sessionId = "";
    let cwd = "";
    let lastResultAt: number | null = null;
    // 지금 턴(사용자 요청 사이)에 연 스킬(→ 연 호출의 기간)과, 같은 도구의 다음 성공을 기다리는 실패. 지난 턴에 연 스킬은
    // 지적 표현 판정에 쓰고, 지적은 연 쪽 기간에 센다. 턴 번호는 앞 턴 호출의 늦은 결과를 이 턴 일로 보지 않게 한다.
    const openedThisTurn = new Map<string, 0 | 1>();
    let previousTurnSkills: [string, 0 | 1][] = [];
    let awaiting: { tool: string; signature: string; excerpt: FailureExcerpt | null }[] = [];
    let turn = 0;
    // 캐시 다시 쓰기 판단용 상태. 창 밖·fork 사본 entry도 직전 요청으로는 쓰므로 세기 전에 갱신한다.
    let previousRequest: MainRequest | null = null;
    let compacted = false, promptChanged = false;
    let lastDigest: unknown;
    const observeCache = (entry: Entry, time: number): { cause: RewriteCause; cost: number } | null => {
      if (entry.type === "compaction") compacted = true;
      // 다이제스트는 대개 바뀔 때 쓰이지만 같은 값이 다시 쓰이기도 해서 값이 달라졌을 때만 바뀐 것으로 본다.
      if (entry.type === "custom" && entry.customType === "system-prompt-digest") {
        if (lastDigest !== undefined && entry.data !== lastDigest) promptChanged = true;
        lastDigest = entry.data;
      }
      const m = entry.type === "message" ? entry.message : undefined;
      const usage = m?.role === "assistant" ? m.usage : undefined;
      const prompt = (Number(usage?.input) || 0) + (Number(usage?.cacheRead) || 0) + (Number(usage?.cacheWrite) || 0);
      // 오류로 끝나 토큰이 없는 응답은 요청으로 보지 않는다(다음 요청의 견줄 대상이 0이 되지 않게).
      if (!m || !usage || !prompt) return null;
      const request = { at: typeof m.timestamp === "number" ? m.timestamp : time, prompt, model: `${m.provider ?? ""}/${m.model ?? ""}`, credentialId: m.credentialId };
      const cause = rewriteCause(usage, request, previousRequest, compacted, promptChanged);
      previousRequest = request;
      compacted = promptChanged = false;
      return cause ? { cause, cost: Number(usage.cost?.cacheWrite) || 0 } : null;
    };
    const childSession = relative(dir, path).split(sep).length > 2;
    let lastYield = performance.now();

    try {
      for await (const entry of readSessionEntries<Entry>(path)) {
        if (performance.now() - lastYield >= YIELD_EVERY_MS) {
          await yieldEventLoop();
          lastYield = performance.now();
        }
        if (entry.type === "session") {
          sessionId = String(entry.id ?? "");
          cwd = typeof entry.cwd === "string" ? entry.cwd : "";
          continue;
        }
        const time = Date.parse(entry.timestamp);
        if (!Number.isFinite(time) || time > now) continue;
        // fork·fixture 세션은 원본 entry를 그대로 복사하므로 같은 id+시각은 한 번만 센다.
        let counted = time >= now - 14 * DAY_MS;
        if (counted && entry.id) {
          const copyKey = `${entry.id}:${entry.timestamp}`;
          if (seenEntries.has(copyKey)) counted = false;
          else seenEntries.add(copyKey);
        }
        const rewrite = observeCache(entry, time);
        // 새 입력을 기다린 시간과 자동 압축 시간은 하네스 지연이 아니다. 압축은 「컨텍스트 압축」 행이 따로 센다(2026-11-07 사용자 결정).
        if (isNewInput(entry) || entry.type === "compaction") lastResultAt = null;
        // 사용자 요청이 새 턴을 연다. 지난 턴에 연 스킬은 이 요청의 지적 표현 판정에 쓴다(복사된 entry도 턴 경계로는 본다).
        if (entry.type === "message" && entry.message?.role === "user") {
          previousTurnSkills = [...openedThisTurn];
          openedThisTurn.clear();
          awaiting = [];
          turn++;
        }
        if (!counted) continue;
        if (cwd) cwdActivity[cwd] = Math.max(cwdActivity[cwd] ?? 0, time);

        const index: 0 | 1 = time >= now - 7 * DAY_MS ? 0 : 1;
        // 이 사건을 세는 묶음들: 기간 묶음 하나와, 최근 7일이면 표시마다 전·후 중 하나.
        const targets = [windows[index]];
        if (index === 0) for (const [at, split] of splits) targets.push(time >= at ? split.after : split.before);
        const each = (count: (w: WindowCounts) => void) => {
          for (const w of targets) count(w);
        };
        const example = (label: string): UpkeepEvidence => ({ label: maskSecrets(label), sessionId, sessionPath: path, timestamp: entry.timestamp });
        const note = (metricId: string, label: string) => {
          if (index !== 0) return;
          const rows = (evidence[metricId] ??= []);
          if (rows.length < EVIDENCE_LIMIT) rows.push(example(label));
        };
        // credentialKind가 `api-key`인 사용만 실제 청구다(인증 종류는 Anthropic 호출만 기록됨).
        const billed = (usage: Usage, cost: number) => {
          if (usage.credentialKind !== "api-key") return;
          each((w) => {
            w.apiKeyCalls++;
            w.apiKeyCost += cost;
          });
          if (index === 0) costs.add("api-key", sessionId, path, cost, time);
        };

        if (entry.type === "compaction") {
          each((w) => w.compactions++);
          note("compactions", "압축");
        }

        if (entry.type === "custom" || entry.type === "custom_message") {
          const kind = entry.customType ?? "";
          if (kind === "todo-nudge" || kind === "mid-run-todo-nudge") {
            each((w) => w.nudges++);
            note("todo-nudges", kind);
          }
          if (kind === "mnemopi-recall" && Array.isArray(entry.data?.ids)) {
            each((w) => w.recalls++);
            if (!entry.data.ids.length) each((w) => w.emptyRecalls++);
          }
          if (kind === "mnemopi-recall-gated" && typeof entry.data?.dense === "number" && typeof entry.data.gate === "number") {
            const dense = entry.data.dense, gate = entry.data.gate;
            each((w) => w.gated++);
            note("gated-ratio", `게이트 제외 (유사도 ${dense.toFixed(2)} / 기준 ${gate.toFixed(2)})`);
            if (gate - dense >= 0 && gate - dense <= 0.05) {
              each((w) => w.nearGate++);
              note("near-gate", `게이트 근처 제외 (유사도 ${dense.toFixed(2)} / 기준 ${gate.toFixed(2)})`);
            }
          }
          if (kind === "async-result" && typeof entry.content === "string") {
            for (const r of taskResults(entry.content)) makerResults.push({ sessionId, timestamp: entry.timestamp, ...r });
          }
        }

        if (entry.type === "model_usage" && entry.usage) {
          const purpose = String(entry.purpose ?? "unknown");
          const usage = entry.usage;
          const cost = Number(usage.cost?.total) || 0;
          each((w) => {
            addUsage(w.purposes, purpose, usage, entry.provider);
            w.missingCost ||= typeof usage.cost?.total !== "number";
            w.cost += cost;
          });
          if (index === 0) {
            costs.add("total", sessionId, path, cost, time);
            costs.add(`purpose:${purpose}`, sessionId, path, cost, time);
          }
          billed(usage, cost);
        }

        if (entry.type !== "message" || !entry.message) continue;
        const m = entry.message;

        if (m.role === "user" && !childSession && (m.attribution === undefined || m.attribution === "user")) {
          each((w) => w.turns++);
          const text = textOf(m.content);
          if (isComplaint(text)) {
            each((w) => w.complaints++);
            note("repeat-complaints", maskSecrets(text).slice(0, 120));
            for (const [skill, openIndex] of previousTurnSkills) skillAt(openIndex, skill).usage.complaintTurns++;
          }
        }

        if (m.role === "assistant") {
          if (lastResultAt !== null && typeof m.timestamp === "number") {
            const gap = m.timestamp - lastResultAt;
            if (gap >= 0) {
              each((w) => w.gaps.push(gap));
              if (index === 0 && gap > SLOW_GAP_MS) slowGaps.push({ gap, row: example(`도구 결과 뒤 ${Math.round(gap / 1000)}초 대기`) });
            }
            lastResultAt = null;
          }
          if (m.usage) {
            // 같은 모델은 제공자가 달라도 한 행으로 모은다(제공자는 UsageTotal.providers에 남는다).
            const key = m.model ?? "unknown";
            const usage = m.usage;
            const cost = Number(usage.cost?.total) || 0;
            const writeCost = Number(usage.cost?.cacheWrite) || 0;
            const prompt = (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0);
            each((w) => {
              if (prompt > 0) w.requests++;
              addUsage(w.models, key, usage, m.provider);
              w.missingCost ||= typeof usage.cost?.total !== "number";
              w.cost += cost;
              w.cacheWriteCost += writeCost;
              w.missingRewriteCost ||= rewrite !== null && rewrite.cause !== "first" && typeof usage.cost?.cacheWrite !== "number";
              if (rewrite) {
                w.rewrites[rewrite.cause].count++;
                w.rewrites[rewrite.cause].cost += rewrite.cost;
              }
            });
            if (index === 0) {
              costs.add("total", sessionId, path, cost, time);
              costs.add(`model:${key}`, sessionId, path, cost, time);
              if (rewrite) rewriteRows.push({ first: rewrite.cause === "first", cost: rewrite.cost, row: example(`캐시 다시 쓰기 $${rewrite.cost.toFixed(2)} · ${REWRITE_CAUSE_LABELS[rewrite.cause]}`) });
            }
            billed(usage, cost);
          }
          for (const block of Array.isArray(m.content) ? (m.content as ContentBlock[]) : []) {
            if (block?.type !== "toolCall" || !block.id || seenCalls.has(block.id)) continue;
            seenCalls.add(block.id);
            each((w) => w.calls++);
            calls.set(block.id, {
              name: block.name ?? "", command: block.arguments?.command ?? null, index, targets,
              skills: openedThisTurn.size ? [...openedThisTurn.keys()] : NO_SKILLS,
              opens: block.name === "read" ? skillNamesFromPath(block.arguments?.path) : NO_SKILLS,
              path, sessionId, turn,
            });
            pendingArgs.set(block.id, block.arguments);
            if (block.name === "recall" || (block.name === "write" && block.arguments?.path === "xd://recall")) each((w) => w.recallCalls++);
          }
        }

        if (m.role === "toolResult") {
          lastResultAt = time;
          // 자동 알림 대신 wait·hub가 회수한 결과는 작업 블록마다 `Delivery:` 줄과 함께 온다. 이미 받은 결과를 다시 읽은
          // 출력(read, 또는 wait·hub의 `already delivered or recovered` 블록)은 세지 않는다.
          if (m.toolName === "wait" || m.toolName === "hub") {
            for (const r of snapshotDeliveries(textOf(m.content))) makerResults.push({ sessionId, timestamp: entry.timestamp, ...r });
          }
          if (m.toolName === "git_finalize") {
            const text = textOf(m.content);
            const at = text.indexOf(EXPORT_FAILURE);
            if (at >= 0) {
              each((w) => w.exportFailures++);
              note("memory-export-failures", text.slice(at).split("\n")[0].slice(0, 160));
            }
          }
          const call = m.toolCallId ? calls.get(m.toolCallId) : undefined;
          if (!call || !m.toolCallId) continue;
          const args = pendingArgs.get(m.toolCallId);
          pendingArgs.delete(m.toolCallId);
          const text = m.isError ? textOf(m.content) : "";
          const failed = m.isError === true && !INTENDED_ERROR.test(text) && !PREFLIGHT_ADVICE.test(text) && classifyToolError(call.name, call.command, text) === "failed";

          // 스킬 계기판: 세션 합계와, 같은 턴에서 먼저 연 스킬마다 연 뒤 호출로 센다. 성공한 스킬 읽기는 열람이다.
          const totals = sessionTotals[call.index].get(call.path) ?? { calls: 0, failures: 0 };
          sessionTotals[call.index].set(call.path, totals);
          totals.calls++;
          if (failed) totals.failures++;
          for (const skill of call.skills) {
            const row = skillSessionAt(call.index, skill, call);
            row.afterCalls++;
            if (failed) row.afterFailures++;
          }
          if (!m.isError) for (const skill of call.opens) {
            const agg = skillAt(call.index, skill);
            const row = skillSessionAt(call.index, skill, call);
            agg.usage.opens++;
            agg.lastAt = Math.max(agg.lastAt, time);
            row.opens++;
            row.lastAt = Math.max(row.lastAt, time);
            if (call.turn === turn && !openedThisTurn.has(skill)) {
              openedThisTurn.set(skill, call.index);
              agg.usage.openTurns++;
            }
          }

          // 같은 턴에서 실패를 기다리던 같은 도구의 성공: 넘긴 방법으로 남긴다.
          if (!m.isError && call.turn === turn && awaiting.some((a) => a.tool === call.name)) {
            const shape = argumentShape(call.name, args);
            const summary = summarizeArgs(args);
            for (const a of awaiting.filter((x) => x.tool === call.name)) {
              if (a.excerpt) a.excerpt.recovery = summary;
              recoveries.push({ signature: a.signature, shape, sessionId, sessionPath: path, at: time });
            }
            awaiting = awaiting.filter((a) => a.tool !== call.name);
          }
          if (!failed) continue;
          // 호출이 일어난 기간(고침 표시 전·후 포함)으로 센다(결과가 경계를 넘어 와도 호출 쪽 묶음).
          const signature = `${call.name}: ${normalizeError(call.name, text)}`;
          const reject = call.name === "task" || call.name === "maker_route";
          for (const target of call.targets) {
            target.errors++;
            target.errorsBySignature[signature] = (target.errorsBySignature[signature] ?? 0) + 1;
            if (reject) target.rejects++;
          }
          if (reject && call.index === 0) {
            const rows = (evidence["dispatch-rejects"] ??= []);
            if (rows.length < EVIDENCE_LIMIT) rows.push(example(signature));
          }
          // 실패 발췌는 14일 전체에서 묶음마다 최근 것만 남긴다(관찰 후보가 직전 7일 실패에서도 나오므로).
          const excerpt: FailureExcerpt = { args: summarizeArgs(args), error: clipMasked(text, EXCERPT_ERROR), recovery: null };
          const rows = (failureExcerpts[signature] ??= []);
          rows.push(excerpt);
          if (rows.length > EXCERPTS_PER_SIGNATURE) rows.shift();
          if (call.turn === turn) awaiting.push({ tool: call.name, signature, excerpt });
        }
      }
    } catch {
      warnings.push("세션 파일 일부를 읽지 못했습니다.");
    }
  }

  evidence["slow-gaps"] = slowGaps.sort((a, b) => b.gap - a.gap).slice(0, EVIDENCE_LIMIT).map((x) => x.row);
  // 피할 수 있었던 다시 쓰기를 먼저, 그 안에서 비싼 순으로 보인다(세션 첫 요청은 판정에서 빠진다).
  evidence["session-cache-rewrite"] = rewriteRows
    .sort((a, b) => Number(a.first) - Number(b.first) || b.cost - a.cost)
    .slice(0, EVIDENCE_LIMIT)
    .map((x) => x.row);
  return { windows, scannedFiles: files.length, warnings: [...new Set(warnings)], evidence, topSessions: costs.top(), makerResults, splits, cwdActivity, ...finish() };
}

type SkillSession = { sessionId: string; opens: number; afterCalls: number; afterFailures: number; lastAt: number };
type SkillAgg = { usage: SkillWindowUsage; lastAt: number; sessions: Map<string, SkillSession> };
type CallTotals = { calls: number; failures: number };

/**
 * 스킬별 두 기간 사용을 마무리한다. 세션 수·연 뒤 호출은 그 기간에 스킬을 한 번이라도 연 세션만 센다. 나머지 호출은 그
 * 세션들의 호출 합계에서 연 뒤 호출을 뺀 값이다. 최근 7일 연 세션은 연 뒤 오류가 많은 순으로 10개만 남긴다.
 */
function skillResult(aggs: [Map<string, SkillAgg>, Map<string, SkillAgg>], totals: [Map<string, CallTotals>, Map<string, CallTotals>]): ScanResult["skills"] {
  const sessions: Record<string, SkillSessionUsage[]> = {};
  const windows = aggs.map((byName, index) => {
    const out: Record<string, SkillWindowUsage> = {};
    for (const [name, agg] of byName) {
      const opened = [...agg.sessions].filter(([, row]) => row.opens > 0);
      if (!opened.length) continue;
      const usage: SkillWindowUsage = { ...agg.usage, sessions: opened.length, lastOpenedAt: new Date(agg.lastAt).toISOString() };
      for (const [path, row] of opened) {
        const total = totals[index].get(path) ?? { calls: 0, failures: 0 };
        usage.afterCalls += row.afterCalls;
        usage.afterFailures += row.afterFailures;
        usage.restCalls += Math.max(0, total.calls - row.afterCalls);
        usage.restFailures += Math.max(0, total.failures - row.afterFailures);
      }
      out[name] = usage;
      if (index === 0) {
        sessions[name] = opened
          .sort(([, a], [, b]) => b.afterFailures - a.afterFailures || b.opens - a.opens || b.lastAt - a.lastAt)
          .slice(0, EVIDENCE_LIMIT)
          .map(([path, row]) => ({
            sessionId: row.sessionId, sessionPath: path, opens: row.opens, afterCalls: row.afterCalls, afterFailures: row.afterFailures,
            lastOpenedAt: new Date(row.lastAt).toISOString(),
          }));
      }
    }
    return out;
  });
  return { windows: [windows[0], windows[1]], sessions };
}
