/**
 * 보수 대시보드용 세션 기록 스캔. 최근 14일 안에 바뀐 세션 JSONL을 한 줄씩 읽어 최근 7일(index 0)과
 * 직전 7일(index 1) 두 묶음으로 센다. 라이브 서버의 요청 처리를 막지 않도록 약 8ms마다 이벤트 루프에
 * 양보한다. 읽은 값이 없으면 0이 아니라 호출자가 미측정으로 다룰 수 있게 원 건수를 그대로 넘긴다.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { join, relative, sep } from "node:path";
import { classifyToolError } from "../run-xray";
import { maskSecrets as sharedMaskSecrets } from "../session-recall";
import { COMPLAINT_EXPRESSIONS, SLOW_GAP_MS } from "./criteria";
import type { UpkeepEvidence } from "./types";

const DAY_MS = 86_400_000;
const YIELD_EVERY_MS = 8;
const EVIDENCE_LIMIT = 10;
const TOP_SESSIONS = 5;

type Usage = { input?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
type ContentBlock = { type?: string; id?: string; name?: string; text?: string; arguments?: { command?: string; path?: string } };
type Entry = {
  type?: string;
  id?: string;
  timestamp: string;
  customType?: string;
  purpose?: string;
  content?: unknown;
  usage?: Usage;
  data?: { ids?: unknown[]; dense?: number; gate?: number };
  message?: {
    role?: string;
    attribution?: string;
    timestamp?: number;
    content?: unknown;
    usage?: Usage;
    model?: string;
    provider?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
};

/** 목적·모델 하나의 사용량 합계. 비용·캐시 필드가 빠진 기록이 있었는지도 기억한다. */
export type UsageTotal = { cost: number; input: number; write: number; missingCost: boolean; missingCache: boolean };

/** 한 기간(7일)의 집계. */
export type WindowCounts = {
  turns: number;
  calls: number;
  errors: number;
  rejects: number;
  compactions: number;
  nudges: number;
  recalls: number;
  emptyRecalls: number;
  gated: number;
  nearGate: number;
  recallCalls: number;
  saves: number;
  jev: number;
  complaints: number;
  cost: number;
  missingCost: boolean;
  gaps: number[];
  purposes: Record<string, UsageTotal>;
  models: Record<string, UsageTotal>;
  errorsBySignature: Record<string, number>;
};

export type SessionCost = { sessionId: string; sessionPath: string; cost: number };

/** 부모 세션에 도착한 Maker 결과(`async-result` 알림, `wait`·`hub` 회수). 원장에 남지 않는 `partial`을 여기서 읽는다. */
export type MakerResult = { sessionId: string; name: string; timestamp: string; durationSec: number | null; partial: boolean };

export type ScanResult = {
  windows: [WindowCounts, WindowCounts];
  scannedFiles: number;
  warnings: string[];
  /** 최근 7일 지표 id별 근거 사례(최대 10개) */
  evidence: Record<string, UpkeepEvidence[]>;
  /** 최근 7일 비용 상위 세션: 전체(`total`), 목적별(`purpose:<p>`), 모델별(`model:<m>`) */
  topSessions: Record<string, SessionCost[]>;
  /** 14일 안에 도착한 Maker 결과 */
  makerResults: MakerResult[];
};

function emptyWindow(): WindowCounts {
  return {
    turns: 0, calls: 0, errors: 0, rejects: 0, compactions: 0, nudges: 0, recalls: 0, emptyRecalls: 0,
    gated: 0, nearGate: 0, recallCalls: 0, saves: 0, jev: 0, complaints: 0, cost: 0, missingCost: false,
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

/** 오류 첫 줄을 묶음 키로 만든다(경로→<p>, 긴 16진수→<h>, 숫자→N). */
export function normalizeError(tool: string, text: string): string {
  const lines = text.split("\n");
  const line = tool === "ego_browser"
    ? lines.find((x) => /Error|timed|not|failed/i.test(x)) ?? lines[0]
    : tool === "skim" ? lines.at(-1) ?? lines[0] : lines[0];
  return maskSecrets(line)
    .replace(/(?:[A-Za-z]:)?\/(?:[^\s:]+\/)*[^\s:]*/g, "<p>")
    .replace(/\b(?:0x)?[a-f\d]{8,}\b/gi, "<h>")
    .replace(/\d+/g, "N")
    .slice(0, 180);
}

/** 사용자 중단·보조 건너뜀·취소처럼 의도된 비결함 오류. */
const INTENDED_ERROR = /^실행하지 않음: 이 호출이 실행되기 전에 사용자 메시지|^Skipped due to|Operation aborted|Request was aborted|Command aborted/i;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((x: ContentBlock | null) => x?.text ?? "").join("\n");
}

function addUsage(target: Record<string, UsageTotal>, key: string, usage: Usage) {
  const row = target[key] ??= { cost: 0, input: 0, write: 0, missingCost: false, missingCache: false };
  row.missingCost ||= typeof usage.cost?.total !== "number";
  row.missingCache ||= typeof usage.input !== "number" || typeof usage.cacheRead !== "number" || typeof usage.cacheWrite !== "number";
  row.cost += Number(usage.cost?.total) || 0;
  row.input += (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0);
  row.write += Number(usage.cacheWrite) || 0;
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

  add(key: string, sessionId: string, sessionPath: string, cost: number) {
    let rows = this.byKey.get(key);
    if (!rows) this.byKey.set(key, (rows = new Map()));
    const row = rows.get(sessionPath) ?? { sessionId, sessionPath, cost: 0 };
    row.cost += cost;
    rows.set(sessionPath, row);
  }

  top(): Record<string, SessionCost[]> {
    const out: Record<string, SessionCost[]> = {};
    for (const [key, rows] of this.byKey) out[key] = [...rows.values()].sort((a, b) => b.cost - a.cost).slice(0, TOP_SESSIONS);
    return out;
  }
}

export async function scanSessions(dir: string, now: number): Promise<ScanResult> {
  const windows: [WindowCounts, WindowCounts] = [emptyWindow(), emptyWindow()];
  const evidence: Record<string, UpkeepEvidence[]> = {};
  const costs = new SessionCostTable();
  const slowGaps: { gap: number; row: UpkeepEvidence }[] = [];
  const seenCalls = new Set<string>();
  const seenEntries = new Set<string>();
  // fork 사본은 원래 호출 entry를 건너뛰므로 호출 표는 파일마다가 아니라 스캔 전체에서 하나로 둔다.
  const calls = new Map<string, { name: string; command: string | null; index: number }>();
  const makerResults: MakerResult[] = [];
  const warnings: string[] = [];

  let files: string[];
  try {
    files = await sessionFiles(dir, now - 14 * DAY_MS);
  } catch {
    return { windows, scannedFiles: 0, warnings: ["세션 디렉터리를 읽지 못했습니다."], evidence, topSessions: {}, makerResults };
  }

  for (const path of files) {
    await yieldEventLoop();
    let sessionId = "";
    let lastResultAt: number | null = null;
    const childSession = relative(dir, path).split(sep).length > 2;
    let lastYield = performance.now();

    try {
      for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
        if (performance.now() - lastYield >= YIELD_EVERY_MS) {
          await yieldEventLoop();
          lastYield = performance.now();
        }
        let entry: Entry;
        try {
          entry = JSON.parse(line);
          if (!entry || typeof entry !== "object") continue;
        } catch {
          continue;
        }
        if (entry.type === "session") {
          sessionId = String(entry.id ?? "");
          continue;
        }
        const time = Date.parse(entry.timestamp);
        if (!Number.isFinite(time) || time > now || time < now - 14 * DAY_MS) continue;
        // fork·fixture 세션은 원본 entry를 그대로 복사하므로 같은 id+시각은 한 번만 센다.
        if (entry.id) {
          const copyKey = `${entry.id}:${entry.timestamp}`;
          if (seenEntries.has(copyKey)) continue;
          seenEntries.add(copyKey);
        }

        const index = time >= now - 7 * DAY_MS ? 0 : 1;
        const w = windows[index];
        const example = (label: string): UpkeepEvidence => ({ label: maskSecrets(label), sessionId, sessionPath: path, timestamp: entry.timestamp });
        const note = (metricId: string, label: string) => {
          if (index !== 0) return;
          const rows = (evidence[metricId] ??= []);
          if (rows.length < EVIDENCE_LIMIT) rows.push(example(label));
        };

        if (entry.type === "compaction") {
          w.compactions++;
          note("compactions", "압축");
        }

        if (entry.type === "custom" || entry.type === "custom_message") {
          const kind = entry.customType ?? "";
          if (kind === "todo-nudge" || kind === "mid-run-todo-nudge") {
            w.nudges++;
            note("todo-nudges", kind);
          }
          if (kind === "mnemopi-recall" && Array.isArray(entry.data?.ids)) {
            w.recalls++;
            if (!entry.data.ids.length) {
              w.emptyRecalls++;
              note("empty-recall", "빈 회상");
            }
          }
          if (kind === "mnemopi-recall-gated" && typeof entry.data?.dense === "number" && typeof entry.data.gate === "number") {
            const dense = entry.data.dense, gate = entry.data.gate;
            w.gated++;
            note("gated-ratio", `게이트 제외 (유사도 ${dense.toFixed(2)} / 기준 ${gate.toFixed(2)})`);
            if (gate - dense >= 0 && gate - dense <= 0.05) {
              w.nearGate++;
              note("near-gate", `게이트 근처 제외 (유사도 ${dense.toFixed(2)} / 기준 ${gate.toFixed(2)})`);
            }
          }
          if (kind === "autolearn-saved") w.saves++;
          if (kind === "async-result" && typeof entry.content === "string") {
            for (const r of taskResults(entry.content)) makerResults.push({ sessionId, timestamp: entry.timestamp, ...r });
          }
        }

        if (entry.type === "model_usage" && entry.usage) {
          const purpose = String(entry.purpose ?? "unknown");
          addUsage(w.purposes, purpose, entry.usage);
          w.missingCost ||= typeof entry.usage.cost?.total !== "number";
          const cost = Number(entry.usage.cost?.total) || 0;
          w.cost += cost;
          if (index === 0) {
            costs.add("total", sessionId, path, cost);
            costs.add(`purpose:${purpose}`, sessionId, path, cost);
          }
          if (purpose === "jev_runtime_memory_application") {
            w.jev++;
            note("jev-memory", "Jev 기억 적용 판정");
          }
        }

        if (entry.type !== "message" || !entry.message) continue;
        const m = entry.message;

        if (m.role === "user" && !childSession && (m.attribution === undefined || m.attribution === "user")) {
          w.turns++;
          const text = textOf(m.content);
          if (COMPLAINT_EXPRESSIONS.some((x) => text.includes(x))) {
            w.complaints++;
            note("repeat-complaints", maskSecrets(text).slice(0, 120));
          }
        }

        if (m.role === "assistant") {
          if (lastResultAt !== null && typeof m.timestamp === "number") {
            const gap = m.timestamp - lastResultAt;
            if (gap >= 0) {
              w.gaps.push(gap);
              if (index === 0 && gap > SLOW_GAP_MS) slowGaps.push({ gap, row: example(`도구 결과 뒤 ${Math.round(gap / 1000)}초 대기`) });
            }
            lastResultAt = null;
          }
          if (m.usage) {
            // 인증 종류(usage.credentialKind)는 대부분 기록되지 않아 키로 쓰지 않는다.
            const key = `${m.provider ?? "unknown"}/${m.model ?? "unknown"}`;
            addUsage(w.models, key, m.usage);
            w.missingCost ||= typeof m.usage.cost?.total !== "number";
            const cost = Number(m.usage.cost?.total) || 0;
            w.cost += cost;
            if (index === 0) {
              costs.add("total", sessionId, path, cost);
              costs.add(`model:${key}`, sessionId, path, cost);
            }
          }
          for (const block of Array.isArray(m.content) ? (m.content as ContentBlock[]) : []) {
            if (block?.type !== "toolCall" || !block.id || seenCalls.has(block.id)) continue;
            seenCalls.add(block.id);
            w.calls++;
            calls.set(block.id, { name: block.name ?? "", command: block.arguments?.command ?? null, index });
            if (block.name === "recall" || (block.name === "write" && block.arguments?.path === "xd://recall")) w.recallCalls++;
          }
        }

        if (m.role === "toolResult") {
          lastResultAt = time;
          // 자동 알림 대신 wait·hub가 회수한 결과는 `Delivery:` 줄과 함께 온다. 이미 받은 결과를 다시 읽은 출력(read 등)은 세지 않는다.
          if (m.toolName === "wait" || m.toolName === "hub") {
            const text = textOf(m.content);
            if (/^Delivery: /m.test(text)) for (const r of taskResults(text)) makerResults.push({ sessionId, timestamp: entry.timestamp, ...r });
          }
          const call = m.toolCallId ? calls.get(m.toolCallId) : undefined;
          if (!call || !m.isError) continue;
          const text = textOf(m.content);
          if (INTENDED_ERROR.test(text) || classifyToolError(call.name, call.command, text) !== "failed") continue;
          // 호출이 일어난 기간으로 센다(결과가 경계를 넘어 와도 호출 쪽 묶음).
          const target = windows[call.index];
          target.errors++;
          const signature = `${call.name}: ${normalizeError(call.name, text)}`;
          target.errorsBySignature[signature] = (target.errorsBySignature[signature] ?? 0) + 1;
          if (call.name === "task" || call.name === "maker_route") {
            target.rejects++;
            if (call.index === 0) {
              const rows = (evidence["dispatch-rejects"] ??= []);
              if (rows.length < EVIDENCE_LIMIT) rows.push(example(signature));
            }
          }
        }
      }
    } catch {
      warnings.push("세션 파일 일부를 읽지 못했습니다.");
    }
  }

  evidence["slow-gaps"] = slowGaps.sort((a, b) => b.gap - a.gap).slice(0, EVIDENCE_LIMIT).map((x) => x.row);
  return { windows, scannedFiles: files.length, warnings: [...new Set(warnings)], evidence, topSessions: costs.top(), makerResults };
}
