import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import type { LoungeMessage, LoungePace, LoungeRoomSettings } from "./types";
import { LOUNGE_SLEEP_MINUTES_MAX, LOUNGE_SLEEP_MINUTES_MIN } from "./types";

/**
 * 단톡방 전용 기록 파일. 작업 세션·기억·설정과 섞지 않도록 agentDir 아래 별도 파일 하나에만
 * 쓴다. 호출 시각과 처리한 requestId도 여기 함께 남겨, 재시작 직후 같은 요청을 다시 받아도
 * 다시 저장·호출하지 않고 시간당 상한도 이어서 센다.
 */
export interface LoungeRecord {
  version: 1;
  settings: LoungeRoomSettings;
  messages: LoungeMessage[];
  /** 처리한 requestId(오래된 것부터). */
  requests: Array<{ id: string; at: number }>;
  /** provider 호출을 시작한 시각(epoch ms, 오래된 것부터). */
  callTimestamps: number[];
  lastUserActivityAt: number | null;
  /** 최초 참여/명시 계정 선택 때 고정한 durable row. 자리 재번호로 다시 해석하지 않는다. */
  accountBindings: Record<string, number>;
}

export interface LoungeStore {
  readonly path: string;
  /** 파일이 없으면 기본 기록, 읽을 수 없거나 형식이 틀리면 {@link LoungeLoadError}. */
  load(): LoungeRecord;
  save(record: LoungeRecord): void;
}

export class LoungeLoadError extends Error {
  override name = "LoungeLoadError";
}

export const DEFAULT_SETTINGS: LoungeRoomSettings = {
  enabled: false,
  autoTalk: false,
  participants: [],
  pace: "normal",
  sleepAfterMinutes: 10,
};

export function emptyLoungeRecord(): LoungeRecord {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, participants: [] },
    messages: [],
    requests: [],
    callTimestamps: [],
    lastUserActivityAt: null,
    accountBindings: {},
  };
}

export const LOUNGE_PACES: Record<LoungePace, true> = { slow: true, normal: true, active: true };

/** lounge 패키지의 경계 파서가 함께 쓰는 단일 object guard(기록 파일·POST 본문). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isMessage(value: unknown): value is LoungeMessage {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.memberId !== "string" || typeof value.text !== "string") return false;
  if (!isFiniteNumber(value.createdAt)) return false;
  if (value.replyToId !== undefined && typeof value.replyToId !== "string") return false;
  return Array.isArray(value.reactions)
    && value.reactions.every((reaction) => isRecord(reaction) && typeof reaction.emoji === "string" && isStringArray(reaction.by));
}

function isSettings(value: unknown): value is LoungeRoomSettings {
  return isRecord(value)
    && typeof value.enabled === "boolean"
    && typeof value.autoTalk === "boolean"
    && isStringArray(value.participants)
    && typeof value.pace === "string" && LOUNGE_PACES[value.pace as LoungePace] === true
    && isFiniteNumber(value.sleepAfterMinutes)
    && value.sleepAfterMinutes >= LOUNGE_SLEEP_MINUTES_MIN
    && value.sleepAfterMinutes <= LOUNGE_SLEEP_MINUTES_MAX;
}

/** 형식이 하나라도 틀리면 전체를 거부한다 — 일부만 살려 덮어쓰면 사용자 기록이 사라진다. */
export function parseLoungeRecord(text: string): LoungeRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new LoungeLoadError(`JSON이 아닙니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || value.version !== 1) throw new LoungeLoadError("지원하지 않는 기록 형식입니다.");
  if (!isSettings(value.settings)) throw new LoungeLoadError("방 설정 형식이 올바르지 않습니다.");
  if (!Array.isArray(value.messages) || !value.messages.every(isMessage)) {
    throw new LoungeLoadError("메시지 형식이 올바르지 않습니다.");
  }
  if (!Array.isArray(value.requests)
    || !value.requests.every((entry) => isRecord(entry) && typeof entry.id === "string" && isFiniteNumber(entry.at))) {
    throw new LoungeLoadError("요청 기록 형식이 올바르지 않습니다.");
  }
  if (!Array.isArray(value.callTimestamps) || !value.callTimestamps.every(isFiniteNumber)) {
    throw new LoungeLoadError("호출 기록 형식이 올바르지 않습니다.");
  }
  if (value.lastUserActivityAt !== null && !isFiniteNumber(value.lastUserActivityAt)) {
    throw new LoungeLoadError("활동 시각 형식이 올바르지 않습니다.");
  }
  if (!isRecord(value.accountBindings) || !Object.values(value.accountBindings).every((id) =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0)) {
    throw new LoungeLoadError("계정 연결 기록 형식이 올바르지 않습니다.");
  }
  return {
    version: 1,
    settings: value.settings,
    messages: value.messages,
    requests: value.requests as LoungeRecord["requests"],
    callTimestamps: value.callTimestamps as number[],
    lastUserActivityAt: value.lastUserActivityAt as number | null,
    accountBindings: value.accountBindings as Record<string, number>,
  };
}

export function createFileLoungeStore(path: string): LoungeStore {
  return {
    path,
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLoungeRecord();
        throw new LoungeLoadError(`기록 파일을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
      return parseLoungeRecord(text);
    },
    save(record) {
      mkdirSync(dirname(path), { recursive: true });
      writePrivateFileAtomicSync(path, `${JSON.stringify(record)}\n`);
    },
  };
}
