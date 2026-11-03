import { randomBytes } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * tool_trial 기록 저장소. 한 시험(trial)은 세션 폴더 아래 한 디렉터리이고, 바뀔 때마다 다음 번호의 사건 파일이 하나 생긴다
 * (`000001.json`, `000002.json`, …). 이미 쓴 파일은 고치거나 지우지 않는다.
 *
 * 동시 기록: 원자적 저장만으로는 읽고-고치고-쓰는 사이의 갱신 손실을 막지 못한다. 그래서 쓰는 쪽은
 * 1) 지금까지의 사건을 모두 읽어 상태를 만들고, 2) 그 상태에서 다음 사건을 검증·생성한 뒤, 3) 비공개 임시 파일을
 * 다음 번호 이름으로 hard link 한다. link는 이름이 이미 있으면 EEXIST로 실패하므로 같은 번호를 두 작성자가 차지할 수 없다.
 * 실패하면 처음부터 다시 읽고 다시 검증한다(미리 계산한 사건을 그대로 다시 붙이지 않는다). expectedRevision을 준 호출은
 * 다시 시도하지 않고 충돌을 돌려준다. hard link를 지원하지 않는 파일 시스템에서는 비원자적 대안을 쓰지 않고 오류를 낸다.
 */

export type Side = "baseline" | "candidate";
export type Outcome = "pass" | "fail" | "unsupported" | "not-run";
export type Environment = Record<string, string>;

export interface EvidenceRef {
  locator: string;
  /** local: 기록 시점에 로컬 경로가 있었다. unchecked: scheme 위치라 이 도구가 열어 보지 않았다. 어느 쪽도 내용이 참이라는 뜻은 아니다. */
  check: "local-exists" | "unchecked";
}

export interface CreatedEvent {
  type: "created";
  revision: 1;
  recordedAt: string;
  trialId: string;
  /** 시험을 만든 세션 id 원래 값. 읽을 때 폴더 이름과 맞는지 확인해 다른 세션 폴더와 겹친 기록을 걸러 낸다. */
  sessionId: string;
  scenario: string;
  acceptance: string;
  environment: Environment;
  baseline: { tool: string; version: string };
  candidate: { tool: string; version: string };
}

export interface ObservedEvent {
  type: "observed";
  revision: number;
  recordedAt: string;
  side: Side;
  outcome: Outcome;
  evidence: EvidenceRef[];
  /** 시험 환경과 다르게 관찰한 항목만. 비어 있으면 시험 환경 그대로다. */
  environment: Environment;
  note?: string;
}

export type TrialEvent = CreatedEvent | ObservedEvent;

export interface Trial {
  sessionKey: string;
  trialId: string;
  created: CreatedEvent;
  observations: ObservedEvent[];
  revision: number;
}

export class TrialConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`revision conflict: expected ${expected}, current ${actual}`);
  }
}

export class TrialHistoryError extends Error {}

const EVENT_FILE = /^(\d{6})\.json$/;
const TRIAL_ID = /^t-\d{14}-[0-9a-f]{8}$/;
const MAX_ATTEMPTS = 50;

export function defaultTrialRoot(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"), "tool-trials");
}

/**
 * 세션 id를 폴더 이름으로 바꾼다. 대소문자를 가리지 않는 파일 시스템(Windows·macOS)에서도 다른 id가 같은 폴더로 겹치지 않도록
 * 대문자와 `_`를 `_`+소문자로 적는다(`A`→`_a`, `_`→`__`). 이 변환은 되돌릴 수 있어 서로 다른 id가 같은 이름이 되지 않는다.
 * 허용 문자 밖이거나 상위 경로가 될 수 있는 id는 거절한다.
 */
export function sessionKeyOf(sessionId: string | undefined): string {
  const id = sessionId ?? "";
  // 끝의 `.`은 Windows가 경로에서 지워 다른 id와 같은 폴더가 될 수 있어 받지 않는다(점만으로 된 id도 여기서 걸린다).
  if (!/^[A-Za-z0-9._-]{0,99}[A-Za-z0-9_-]$/.test(id)) throw new Error("세션 id를 기록 폴더 이름으로 쓸 수 없어 기록하지 않았습니다.");
  return id.replace(/[A-Z_]/g, (char) => `_${char.toLowerCase()}`);
}

export function isTrialId(value: string): boolean {
  return TRIAL_ID.test(value);
}

/** 실제 폴더면 true, 없으면 false. 심볼릭 링크나 폴더가 아닌 것이면 다른 위치로 새는 것을 막기 위해 멈춘다. */
function realDir(path: string): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new TrialHistoryError(`${path}: 실제 폴더가 아니어서(링크 등) 읽거나 쓰지 않았습니다.`);
  return true;
}

/** 이 세션의 기존 시험 폴더. 세션 폴더와 시험 폴더가 모두 실제 폴더여야 한다. key는 sessionKeyOf를 거친 폴더 이름이다. */
function trialDir(root: string, key: string, trialId: string): string {
  if (!isTrialId(trialId)) throw new Error(`trialId 형식이 아닙니다: ${trialId}`);
  const sessionDir = join(root, key);
  const dir = join(sessionDir, trialId);
  if (!realDir(sessionDir) || !realDir(dir)) throw new Error(`이 세션에 ${trialId} 시험 기록이 없습니다.`);
  return dir;
}

function pad(revision: number): string {
  return String(revision).padStart(6, "0");
}

const isText = (value: unknown): value is string => typeof value === "string";
const isFilled = (value: unknown): value is string => isText(value) && value.trim().length > 0;
const isEnvironment = (value: unknown): value is Environment => typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isFilled);
const isToolRef = (value: unknown): boolean => typeof value === "object" && value !== null && "tool" in value && isFilled(value.tool) && "version" in value && isFilled(value.version);
/** scheme 위치는 열어 보지 않으므로 unchecked여야 하고, 로컬 경로만 local-exists일 수 있다. */
export const SCHEME_LOCATOR = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const isEvidenceRef = (ref: unknown): boolean => typeof ref === "object" && ref !== null && "locator" in ref && "check" in ref
  && isFilled(ref.locator) && ref.check === (SCHEME_LOCATOR.test(ref.locator) ? "unchecked" : "local-exists");

/** 판정에 쓰는 필드가 모두 알려진 값이고 도구가 쓸 수 있는 모양인가. 하나라도 어긋나면 그 기록 위에서 판정하거나 쓰지 않는다. */
function validEvent(event: unknown, revision: number): event is TrialEvent {
  if (typeof event !== "object" || event === null) return false;
  const value = event as Record<string, unknown>;
  if (value.revision !== revision || !isText(value.recordedAt) || Number.isNaN(Date.parse(value.recordedAt))) return false;
  if (revision === 1) {
    return value.type === "created" && isText(value.trialId) && isFilled(value.sessionId) && isFilled(value.scenario) && isFilled(value.acceptance)
      && isEnvironment(value.environment) && Object.keys(value.environment).length > 0 && isToolRef(value.baseline) && isToolRef(value.candidate);
  }
  return value.type === "observed"
    && (value.side === "baseline" || value.side === "candidate")
    && ["pass", "fail", "unsupported", "not-run"].includes(value.outcome as string)
    && Array.isArray(value.evidence)
    && value.evidence.every(isEvidenceRef)
    && (value.outcome === "not-run" || value.evidence.length > 0)
    && isEnvironment(value.environment)
    && (value.note === undefined || isFilled(value.note));
}

/** 사건을 모두 읽는다. 번호가 1부터 빈틈없이 이어지지 않거나 읽을 수 없는 파일이 있으면 기록이 손상된 것으로 보고 멈춘다. */
export function readEvents(dir: string): TrialEvent[] {
  const numbered = readdirSync(dir).flatMap((name) => {
    const match = EVENT_FILE.exec(name);
    return match ? [{ name, revision: Number(match[1]) }] : [];
  }).sort((a, b) => a.revision - b.revision);
  return numbered.map(({ name, revision }, index) => {
    if (revision !== index + 1) throw new TrialHistoryError(`${dir}: 기록 번호가 끊겼습니다(${pad(index + 1)} 자리에 ${name}).`);
    let event: unknown;
    try {
      event = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch (error) {
      throw new TrialHistoryError(`${dir}/${name}: 읽을 수 없는 기록입니다(${error instanceof Error ? error.message : String(error)}).`);
    }
    if (!validEvent(event, revision)) throw new TrialHistoryError(`${dir}/${name}: 기록 형식이 맞지 않습니다.`);
    return event;
  });
}

/** 생성 기록의 세션 id가 이 폴더의 주인인지까지 확인한다. 맞지 않으면 다른 세션 기록이 섞인 것으로 보고 멈춘다. */
function toTrial(sessionKey: string, trialId: string, events: TrialEvent[]): Trial {
  const [created, ...rest] = events;
  if (!created || created.type !== "created" || created.trialId !== trialId) throw new TrialHistoryError(`${trialId}: 생성 기록이 없습니다.`);
  let owner: string | undefined;
  try { owner = sessionKeyOf(created.sessionId); } catch { owner = undefined; }
  if (owner !== sessionKey) throw new TrialHistoryError(`${trialId}: 기록을 만든 세션이 이 세션 폴더와 맞지 않습니다.`);
  return { sessionKey, trialId, created, observations: rest as ObservedEvent[], revision: events.length };
}

/** 세션 id(원래 값)로 이 세션의 시험을 읽는다. 다른 세션의 시험은 past 조회(listAllTrials)로만 읽는다. */
export function loadTrial(root: string, sessionId: string | undefined, trialId: string): Trial {
  const key = sessionKeyOf(sessionId);
  return toTrial(key, trialId, readEvents(trialDir(root, key, trialId)));
}

/** 비공개 임시 파일을 만들어 다음 번호 이름으로 link 한다. 이름을 이미 누가 차지했으면 false. 임시 파일은 어느 경우에도 지운다. */
function publish(dir: string, revision: number, event: TrialEvent): boolean {
  const temp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temp, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    linkSync(temp, join(dir, `${pad(revision)}.json`));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function createTrial(root: string, sessionId: string | undefined, build: (trialId: string, recordedAt: string) => Omit<CreatedEvent, "sessionId">, now: () => Date = () => new Date()): Trial {
  const key = sessionKeyOf(sessionId);
  const sessionDir = join(root, key);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  realDir(sessionDir);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const at = now();
    const trialId = `t-${at.toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
    const dir = join(sessionDir, trialId);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      const event: CreatedEvent = { ...build(trialId, at.toISOString()), sessionId: sessionId ?? "" };
      if (!publish(dir, 1, event)) throw new TrialHistoryError(`${trialId}: 새 시험 폴더에 이미 기록이 있습니다.`);
      return toTrial(key, trialId, [event]);
    } catch (error) {
      // 방금 만든 빈 폴더만 지운다(비어 있지 않으면 rmdir가 실패하고 남은 기록은 그대로 둔다).
      try { rmdirSync(dir); } catch { /* 남은 폴더는 list가 손상 기록으로 알린다 */ }
      throw error;
    }
  }
  throw new Error("새 시험 id를 만들지 못했습니다.");
}

/**
 * 다음 사건을 붙인다. next는 매번 방금 읽은 상태로 다시 불리며, 거기서 검증 오류를 던지면 아무것도 쓰지 않는다.
 * expectedRevision이 있으면 현재 번호가 다를 때·경합에서 졌을 때 TrialConflictError로 멈춘다.
 */
export function appendEvent(
  root: string,
  sessionId: string | undefined,
  trialId: string,
  next: (trial: Trial, revision: number, recordedAt: string) => ObservedEvent,
  options: { expectedRevision?: number; now?: () => Date } = {},
): Trial {
  const key = sessionKeyOf(sessionId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const dir = trialDir(root, key, trialId);
    const events = readEvents(dir);
    const trial = toTrial(key, trialId, events);
    if (options.expectedRevision !== undefined && options.expectedRevision !== trial.revision) {
      throw new TrialConflictError(options.expectedRevision, trial.revision);
    }
    const revision = trial.revision + 1;
    const event = next(trial, revision, (options.now?.() ?? new Date()).toISOString());
    // 게시 직전에 폴더가 여전히 실제 폴더인지 다시 본다(같은 사용자의 다른 프로세스가 바꿔 치는 것까지 막지는 못한다).
    if (publish(trialDir(root, key, trialId), revision, event)) return { ...trial, observations: [...trial.observations, event], revision };
    if (options.expectedRevision !== undefined) throw new TrialConflictError(options.expectedRevision, revision);
  }
  throw new Error(`${trialId}: 동시 기록 경합이 ${MAX_ATTEMPTS}번 이어져 기록하지 못했습니다. 잠시 뒤 다시 시도하세요.`);
}

/** 이 세션의 시험 목록. 손상된 기록은 건너뛰지 않고 오류로 함께 돌려준다. */
export function listTrials(root: string, sessionId: string | undefined): { trials: Trial[]; broken: string[] } {
  return scanSession(root, sessionKeyOf(sessionId));
}

function scanSession(root: string, sessionKey: string): { trials: Trial[]; broken: string[] } {
  const dir = join(root, sessionKey);
  if (!realDir(dir)) return { trials: [], broken: [] };
  const trials: Trial[] = [];
  const broken: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isTrialId(entry.name)) continue;
    try {
      trials.push(toTrial(sessionKey, entry.name, readEvents(join(dir, entry.name))));
    } catch (error) {
      broken.push(error instanceof Error ? error.message : String(error));
    }
  }
  trials.sort((a, b) => a.created.recordedAt.localeCompare(b.created.recordedAt));
  return { trials, broken };
}

/** 명시적인 과거 비교 조회에서만 부른다: 모든 세션의 시험을 읽기 전용으로 훑는다. */
export function listAllTrials(root: string): { trials: Trial[]; broken: string[] } {
  if (!existsSync(root)) return { trials: [], broken: [] };
  const trials: Trial[] = [];
  const broken: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scanned = scanSession(root, entry.name);
    trials.push(...scanned.trials);
    broken.push(...scanned.broken);
  }
  return { trials, broken };
}
