/**
 * 6 Pro MCP 호출 기록 — 서버가 **실제로 받은** 도구 호출만 `~/.omp/gpt6-mcp-calls.log`에
 * 한 줄 JSONL로 남긴다.
 *
 * 왜 필요한가. ChatGPT 쪽이 "안전 검사에서 차단했습니다"라고 보고한 호출은 터널을 건너오지
 * 않으므로 서버에 흔적이 전혀 없다. 터널 클라이언트 로그(`~/.omp/gpt6-tunnel-client.log`)에는
 * `cmd_*`·`wfr_*` 요청 id와 시각만 있고 **도구 이름이 없어서**, "무엇을 언제 받았는가"를
 * 대조할 수단이 없었다(2026-09-18 실측). 그래서 받은 호출의 도구 이름·시각·결과를 여기에 남긴다.
 *
 * 남기지 않는 것: `handleKey`, Bearer 토큰, 도구 인자 본문(지시문·대화 내용·결과 본문).
 * 차단 대조에 필요한 것은 "어느 도구가 언제 도착했고 성공/실패했는가"뿐이다.
 */
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 터널·릴레이 로그와 같은 자리(`~/.omp`)에 둔다. */
export const GPT6_CALL_LOG = join(homedir(), ".omp", "gpt6-mcp-calls.log");

export interface Gpt6CallFields {
  method?: string;
  tool?: string;
  handle?: string;
  rpcId?: number | string;
}

export interface Gpt6CallRecord extends Gpt6CallFields {
  /** `ok` · `notification` · `error:<code>` · `rejected:<사유>` */
  status: string;
  durationMs: number;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value !== "" ? value.slice(0, max) : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * JSON-RPC 봉투에서 대조에 필요한 네 값만 뽑는다. 인자 본문은 들여다보지 않고 `handle`만
 * 꺼낸다 — `handleKey`·`instruction`이 로그로 새지 않게 하는 경계가 여기다.
 */
export function gpt6CallFields(body: unknown): Gpt6CallFields {
  const envelope = recordOf(body);
  if (!envelope) return {};
  const params = recordOf(envelope.params);
  const args = recordOf(params?.arguments);
  const rpcId = envelope.id;
  const fields: Gpt6CallFields = {
    method: text(envelope.method, 40),
    tool: text(params?.name, 64),
    handle: text(args?.handle, 32),
    rpcId: typeof rpcId === "number" || typeof rpcId === "string" ? rpcId : undefined,
  };
  // 봉투에 없던 필드는 키 자체를 남기지 않는다 — 호출자는 이 객체를 그대로 기록 줄에 펼친다.
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** dispatch 결과를 한 단어로. 응답 본문은 읽지 않는다(대화 내용을 로그에 남기지 않는다). */
export function gpt6CallStatus(response: unknown): string {
  if (response === null) return "notification";
  const envelope = recordOf(response);
  if (!envelope) return "unknown";
  const error = recordOf(envelope.error);
  if (!error) return "ok";
  const code = error.code;
  return typeof code === "number" ? `error:${code}` : "error";
}

function localIso(now: Date): string {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `.${pad(now.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

export function gpt6CallLine(record: Gpt6CallRecord, now = new Date()): string {
  const line: Record<string, unknown> = {
    time: localIso(now),
    method: record.method,
    tool: record.tool,
    handle: record.handle,
    rpcId: record.rpcId ?? null,
    status: record.status,
    durationMs: Math.round(record.durationMs),
  };
  for (const key of Object.keys(line)) {
    if (line[key] === undefined) delete line[key];
  }
  return JSON.stringify(line);
}

/**
 * 기록은 요청 경로를 막지 않는다. 쓰기 실패는 삼킨다 — 진단 로그가 도구 호출을 죽이면
 * 진단 대상 자체가 사라진다. 한 줄이 300바이트 미만이라 동시 append의 줄 섞임은 다루지 않는다.
 */
export function logGpt6Call(record: Gpt6CallRecord): void {
  void appendFile(GPT6_CALL_LOG, `${gpt6CallLine(record)}\n`, "utf8").catch(() => {});
}
