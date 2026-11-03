import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { daemonClientForProject } from "@oh-my-pi/pi-coding-agent/launch/client";
import { cfgLaunchEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { procmgr, tryAcquireFileLock, withFileLock } from "@oh-my-pi/pi-utils";

/**
 * test_session의 상태와 수명주기. 한 세션이 이름 붙인 테스트 범위(작업 공간 + SDK launch broker가 감독하는 프로세스)를
 * 턴을 넘어 다시 쓰고, 명시한 finish에서만 정리한다.
 *
 * - 상태는 세션마다 `<root>/<sessionKey>/state.json` 하나다. 여러 프로세스가 같은 파일을 고칠 수 있으므로 모든
 *   read-modify-write는 pi-utils의 OS 잠금(withFileLock) 안에서 다시 읽고 바꾼 뒤 임시 파일 rename으로 쓴다.
 *   rename만으로는 동시 갱신의 유실을 막지 못한다. broker 호출처럼 느린 일은 잠금 밖에서 하고, 결과는 잠금 안에서
 *   다시 읽은 상태의 같은 generation(daemonId)에만 반영한다.
 * - 작업 공간은 `<root>/<sessionKey>/ws/<scopeId>`에 새로 만든 디렉터리뿐이다. 기존 디렉터리를 맡지 않고, 지울 때는
 *   저장된 경로가 아니라 다시 계산한 경로의 실제 위치(realpath)를 확인한다.
 * - 프로세스는 broker generation(name·id·owner)으로만 식별한다. PID로 죽이지 않고, stop 요청에도 id를 실어 같은
 *   이름의 다른 실행을 건드리지 않는다. 확인할 수 없는 자원은 needs-cleanup으로 남긴다.
 */

export type ScopeStatus = "active" | "needs-cleanup" | "finished";
export type ResourceState = "running" | "stopped" | "exited" | "needs-cleanup";

export interface Resource {
  key: string;
  origin: "launched" | "tracked";
  service: string;
  daemonId: string;
  startedAt: number;
  projectDir: string;
  command?: string;
  state: ResourceState;
  note?: string;
  exitCode?: number;
  updatedAt: string;
}

export interface Scope {
  id: string;
  name: string;
  purpose?: string;
  status: ScopeStatus;
  createdAt: string;
  updatedAt: string;
  /** 세션이 끝나(session_shutdown·다른 세션으로 전환) 프로세스를 멈춘 시각. 다시 start하면 지운다. */
  sessionEndedAt?: string;
  resources: Resource[];
  /** finish에서 남길 상대 경로(outputs는 항상 남는다). 재시도에도 유지하려고 저장한다. */
  keep?: string[];
  /** 정리하지 못한 이유. finish가 다시 돌면 끝나지 않은 일만 다시 한다. */
  cleanupIssues?: string[];
  workspaceCleaned?: boolean;
  kept?: string[];
  finishedAt?: string;
}

export interface StoreState {
  version: 1;
  sessionId: string;
  scopes: Scope[];
}

/** broker 스냅샷에서 이 도구가 읽는 부분. */
export interface ServiceSnapshot {
  name: string;
  id: string;
  state: string;
  owner?: string;
  startedAt: number;
  pid?: number;
  exitCode?: number;
  exitReason?: string;
}

export interface LaunchSpec {
  name: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  ready?: { log?: string; port?: number; host?: string; timeoutMs: number };
}

export interface ServiceBackend {
  list(projectDir: string): Promise<ServiceSnapshot[]>;
  start(projectDir: string, spec: LaunchSpec, owner: string): Promise<{ daemon: ServiceSnapshot; readyTimedOut: boolean }>;
  stop(projectDir: string, name: string, id: string, timeoutMs: number): Promise<ServiceSnapshot>;
}

export interface Env {
  root: string;
  sessionId: string;
  /** broker 범위(세션 cwd). launch가 새 자원에 기록하고 이후 조작은 자원에 기록된 값을 쓴다. */
  projectDir: string;
  backend: ServiceBackend;
}

export class TestSessionError extends Error {}

export const OUTPUTS_DIR = "outputs";
const TERMINAL: Record<string, true> = { exited: true, failed: true };
const SCOPE_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;
const NAME = /^[\p{L}\p{N}._-]{1,40}$/u;
const KEY = /^[A-Za-z0-9._-]{1,24}$/;
const STOP_TIMEOUT_MS = 5_000;

export const DEFAULT_ROOT = join(dirname(dirname(import.meta.dir)), "test-sessions");
/** OMP_TEST_SESSION_DIR는 테스트·검증용 재지정이며 운영에서는 쓰지 않는다. */
export function storeRoot(): string {
  return process.env.OMP_TEST_SESSION_DIR || DEFAULT_ROOT;
}

export function sessionKey(sessionId: string): string {
  const key = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  if (!key || key === "." || key === "..") throw new TestSessionError("세션 id를 상태 경로로 쓸 수 없습니다.");
  return key;
}

function sessionDir(env: Pick<Env, "root" | "sessionId">): string {
  return join(env.root, sessionKey(env.sessionId));
}
function statePath(env: Pick<Env, "root" | "sessionId">): string {
  return join(sessionDir(env), "state.json");
}
/**
 * 같은 범위의 launch와 finish가 서로를 막는 OS 잠금 경로. 상태 파일 잠금과 따로 둬, 오래 걸리는 시작·정리 동안 다른
 * 상태 갱신(list, stop, 다른 범위)을 막지 않는다.
 */
function scopeLockPath(env: Pick<Env, "root" | "sessionId">, scopeId: string): string {
  return join(sessionDir(env), `scope-${scopeId}`);
}
/**
 * 이 프로세스 안에서 범위 잠금을 쥔 launch 수와 finish. Windows 이름 있는 mutex는 같은 스레드에서 다시 잡히므로 같은
 * 프로세스 안의 launch·finish 충돌은 이것으로 막는다.
 */
const launching = new Map<string, number>();
const finishing = new Set<string>();
/** 앞선 launch가 준비를 기다리는 동안 같은 범위의 launch가 기다리는 한도(100 ms × 1,200 = 2분). */
const LAUNCH_LOCK_RETRIES = 1_200;
/** 저장된 경로를 믿지 않고 scope id로 다시 계산한 작업 공간 경로. */
export function workspacePath(env: Pick<Env, "root" | "sessionId">, scopeId: string): string {
  if (!SCOPE_ID.test(scopeId)) throw new TestSessionError(`관리 범위 id가 올바르지 않습니다: ${scopeId}`);
  return join(sessionDir(env), "ws", scopeId);
}

function now(): string {
  return new Date().toISOString();
}

function parseState(text: string, sessionId: string, path: string): StoreState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TestSessionError(`상태 파일을 읽지 못했습니다(${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const state = value as Partial<StoreState>;
  if (state?.version !== 1 || !Array.isArray(state.scopes) || typeof state.sessionId !== "string") {
    throw new TestSessionError(`상태 파일 형식이 다릅니다: ${path}`);
  }
  if (state.sessionId !== sessionId) throw new TestSessionError(`상태 파일의 세션이 다릅니다: ${path}`);
  return state as StoreState;
}

async function readStateFile(env: Pick<Env, "root" | "sessionId">): Promise<StoreState> {
  const path = statePath(env);
  try {
    return parseState(await readFile(path, "utf8"), env.sessionId, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessionId: env.sessionId, scopes: [] };
    throw error;
  }
}

/**
 * 세션 상태의 read-modify-write. 잠금 안에서 최신 파일을 다시 읽고 mutate가 바꾼 결과만 쓴다. mutate가 undefined를
 * 돌려주면 쓰지 않는다(읽기 전용 확인). 잠금은 프로세스가 죽으면 OS가 풀어 준다.
 */
export async function updateState<T>(
  env: Pick<Env, "root" | "sessionId">,
  mutate: (state: StoreState) => { value: T; write: boolean },
): Promise<T> {
  const path = statePath(env);
  // 상태에는 명령줄이 담기므로 세션 디렉터리는 소유자만 읽게 만든다. 이미 있던 디렉터리도 좁힌다.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  return withFileLock(path, async () => {
    const state = await readStateFile(env);
    const { value, write } = mutate(state);
    if (write) {
      const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temp, path);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    }
    return value;
  }, { retries: 200, retryDelayMs: 25 });
}

export function readState(env: Pick<Env, "root" | "sessionId">): Promise<StoreState> {
  return updateState(env, (state) => ({ value: structuredClone(state), write: false }));
}

function findOpen(state: StoreState, name: string): Scope | undefined {
  return state.scopes.find((scope) => scope.name === name && scope.status !== "finished");
}

function requireOpen(state: StoreState, name: string): Scope {
  const scope = findOpen(state, name);
  if (!scope) throw new TestSessionError(`이 세션에 열린 테스트 범위 '${name}'가 없습니다. test_session list로 확인하세요.`);
  return scope;
}

function slug(text: string, max: number): string {
  const value = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
  return value || "scope";
}

export function validateName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new TestSessionError("name은 1~40자의 글자·숫자·._-만 씁니다.");
  return name;
}

export function validateKey(key: unknown): string {
  if (typeof key !== "string" || !KEY.test(key)) throw new TestSessionError("resource는 1~24자의 영문·숫자·._-만 씁니다.");
  return key;
}

// ---------------------------------------------------------------------------------------------------------------
// start

export interface StartResult { scope: Scope; created: boolean; workspace: string }

/**
 * 같은 세션의 같은 이름이면 기존 작업 공간을 그대로 다시 연다. 처음이면 새 디렉터리를 만든다(이미 있으면 실패:
 * 기존 디렉터리를 맡지 않는다). 정리 중(needs-cleanup) 범위는 다시 열지 않는다.
 */
export async function startScope(env: Env, input: { name: string; purpose?: string }): Promise<StartResult> {
  const name = validateName(input.name);
  const existing = await updateState(env, (state) => {
    const scope = findOpen(state, name);
    if (!scope) return { value: undefined, write: false };
    if (scope.status !== "active") {
      throw new TestSessionError(`'${name}'는 정리가 끝나지 않았습니다(needs-cleanup). test_session finish로 남은 정리를 다시 실행하세요.`);
    }
    scope.updatedAt = now();
    if (input.purpose) scope.purpose = input.purpose;
    delete scope.sessionEndedAt;
    return { value: structuredClone(scope), write: true };
  });
  if (existing) return { scope: existing, created: false, workspace: workspacePath(env, existing.id) };

  const id = `${slug(name, 24)}-${randomBytes(3).toString("hex")}`;
  const workspace = workspacePath(env, id);
  await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
  await mkdir(workspace); // recursive 없이: 이미 있으면 EEXIST로 멈춘다.
  await mkdir(join(workspace, OUTPUTS_DIR));
  const created: Scope = { id, name, purpose: input.purpose, status: "active", createdAt: now(), updatedAt: now(), resources: [] };
  const winner = await updateState(env, (state) => {
    const other = findOpen(state, name);
    if (other) return { value: structuredClone(other), write: false };
    state.scopes.push(created);
    return { value: created, write: true };
  });
  if (winner.id !== id) {
    // 같은 이름을 동시에 연 다른 호출이 먼저 기록했다. 방금 만든 빈 디렉터리만 거둔다(비어 있지 않으면 rmdir이 멈춘다).
    await rmdir(join(workspace, OUTPUTS_DIR));
    await rmdir(workspace);
    return { scope: winner, created: false, workspace: workspacePath(env, winner.id) };
  }
  return { scope: created, created: true, workspace };
}

// ---------------------------------------------------------------------------------------------------------------
// broker 관측과 분류

/** 한 자원을 broker에서 본 결과. */
export type Observation =
  | { kind: "live"; snapshot: ServiceSnapshot }
  | { kind: "ended"; state: "stopped" | "exited"; note: string; exitCode?: number }
  | { kind: "ambiguous"; note: string };

function classify(resource: Resource, sessionId: string, snapshot: ServiceSnapshot | undefined): Observation {
  if (!snapshot) return { kind: "ended", state: "exited", note: "broker에 기록이 없음(이미 끝남)" };
  const terminal = TERMINAL[snapshot.state] === true;
  if (snapshot.id !== resource.daemonId) {
    // broker는 이름당 기록 하나다. 다른 generation이 있으면 이 자원의 실행은 이미 대체돼 끝났다.
    return terminal
      ? { kind: "ended", state: "exited", note: "같은 이름의 다른 실행으로 대체된 뒤 끝남" }
      : { kind: "ambiguous", note: `같은 이름 '${snapshot.name}'에 다른 실행(id ${snapshot.id}, owner ${snapshot.owner ?? "없음"})이 살아 있어 건드리지 않음` };
  }
  if (snapshot.owner !== sessionId) {
    return { kind: "ambiguous", note: `실행 소유자(${snapshot.owner ?? "없음"})가 이 세션과 달라 건드리지 않음` };
  }
  if (terminal) return { kind: "ended", state: "exited", note: snapshot.exitReason ?? "스스로 끝남", exitCode: snapshot.exitCode };
  return { kind: "live", snapshot };
}

async function observe(env: Env, resources: Resource[]): Promise<Map<Resource, Observation>> {
  const byProject = new Map<string, Resource[]>();
  for (const resource of resources) byProject.set(resource.projectDir, [...(byProject.get(resource.projectDir) ?? []), resource]);
  const result = new Map<Resource, Observation>();
  for (const [projectDir, group] of byProject) {
    let snapshots: ServiceSnapshot[];
    try {
      snapshots = await env.backend.list(projectDir);
    } catch (error) {
      for (const resource of group) result.set(resource, { kind: "ambiguous", note: `broker 상태를 확인하지 못함: ${message(error)}` });
      continue;
    }
    for (const resource of group) result.set(resource, classify(resource, env.sessionId, snapshots.find((item) => item.name === resource.service)));
  }
  return result;
}

/** 살아 있는 이 세션의 generation만 id를 실어 멈춘다. 결과를 다시 확인해 끝난 것만 stopped로 본다. */
async function stopOne(env: Env, resource: Resource, observation: Observation, timeoutMs: number): Promise<Observation> {
  if (observation.kind !== "live") return observation;
  let after: ServiceSnapshot;
  try {
    after = await env.backend.stop(resource.projectDir, resource.service, resource.daemonId, timeoutMs);
  } catch (error) {
    return { kind: "ambiguous", note: `정지 요청이 실패함: ${message(error)}` };
  }
  const settled = classify(resource, env.sessionId, after);
  if (settled.kind === "live") return { kind: "ambiguous", note: `정지 요청 뒤에도 ${after.state} 상태` };
  if (settled.kind === "ended" && after.id === resource.daemonId) return { kind: "ended", state: "stopped", note: "정지함", exitCode: after.exitCode };
  return settled;
}

/**
 * 관측 결과를 잠금 안의 최신 상태에 반영한다. 관측한 뒤 그 자원 기록이 바뀌었으면(generation 교체, 다른 호출의 정지·정리)
 * 오래된 관측이므로 버린다. 그래야 늦게 도착한 '실행 중'이 이미 끝난 정리를 되살리지 않는다.
 */
async function applyObservations(env: Env, scopeId: string, outcomes: Array<[Resource, Observation]>, extra?: (scope: Scope) => void): Promise<Scope | undefined> {
  return updateState(env, (state) => {
    const scope = state.scopes.find((item) => item.id === scopeId);
    if (!scope) return { value: undefined, write: false };
    const stamp = now();
    for (const [acted, observation] of outcomes) {
      const current = scope.resources.find((item) => item.key === acted.key && item.daemonId === acted.daemonId);
      if (!current || current.state !== acted.state || current.updatedAt !== acted.updatedAt) continue;
      if (observation.kind === "live") {
        if (current.state !== "running") Object.assign(current, { state: "running", note: undefined, updatedAt: stamp });
        continue;
      }
      if (observation.kind === "ambiguous") Object.assign(current, { state: "needs-cleanup", note: observation.note, updatedAt: stamp });
      else Object.assign(current, { state: observation.state, note: observation.note, exitCode: observation.exitCode, updatedAt: stamp });
    }
    extra?.(scope);
    scope.updatedAt = stamp;
    return { value: structuredClone(scope), write: true };
  });
}

const unresolved = (resource: Resource): boolean => resource.state === "running" || resource.state === "needs-cleanup";

// ---------------------------------------------------------------------------------------------------------------
// list

export interface ListResult { scopes: Scope[]; workspaces: Record<string, string>; otherSessions: number }

/** 열린 범위의 실행 중·미정 자원을 broker와 대조해 기록을 맞춘다. 아무것도 다시 시작하지 않는다. */
export async function listScopes(env: Env, name?: string): Promise<ListResult> {
  const state = await readState(env);
  const scopes = state.scopes.filter((scope) => (name ? scope.name === name : scope.status !== "finished"));
  const refreshed: Scope[] = [];
  for (const scope of scopes) {
    const pending = scope.status === "finished" ? [] : scope.resources.filter(unresolved);
    if (pending.length === 0) {
      refreshed.push(scope);
      continue;
    }
    const observed = await observe(env, pending);
    refreshed.push((await applyObservations(env, scope.id, [...observed])) ?? scope);
  }
  const workspaces = Object.fromEntries(refreshed.map((scope) => [scope.id, workspacePath(env, scope.id)]));
  return { scopes: refreshed, workspaces, otherSessions: await countOtherSessions(env) };
}

/** 다른 세션이 끝내지 않고 남긴 범위 수. 내용은 읽기만 하고 조작하지 않는다(세션 격리). */
async function countOtherSessions(env: Env): Promise<number> {
  const own = sessionKey(env.sessionId);
  let names: string[];
  try {
    names = await readdir(env.root);
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of names) {
    if (entry === own) continue;
    try {
      const value = JSON.parse(await readFile(join(env.root, entry, "state.json"), "utf8")) as Partial<StoreState>;
      count += (value.scopes ?? []).filter((scope) => scope.status !== "finished").length;
    } catch {
      // 상태 파일이 없거나 쓰는 중인 디렉터리는 세지 않는다.
    }
  }
  return count;
}

// ---------------------------------------------------------------------------------------------------------------
// launch · track

export interface LaunchInput {
  name: string;
  resource: string;
  command: string;
  cwd?: string;
  ready?: { log?: string; port?: number; host?: string; timeout?: number };
}

export interface LaunchResult {
  scope: Scope;
  resource: Resource;
  reused: boolean;
  readyTimedOut: boolean;
  /** 실행 중인 자원을 재사용했지만 요청한 명령이 기록과 다를 때. */
  commandDiffers?: boolean;
  /** 경합에 진 이 호출의 실행을 멈췄다고 확인하지 못해 정리 필요로 기록한 것. */
  leftover?: Resource;
}

async function loadOpenActive(env: Env, name: string): Promise<Scope> {
  const state = await readState(env);
  const scope = requireOpen(state, validateName(name));
  if (scope.status !== "active") throw new TestSessionError(`'${name}'는 정리 중(needs-cleanup)이라 새 자원을 붙일 수 없습니다.`);
  return scope;
}

/**
 * 같은 자원이 이 세션 소유로 살아 있으면 그대로 재사용하고(재시작 없음), 끝났으면 새 generation을 띄운다. 이름은
 * 실행마다 새로 만들어 broker의 replace가 다른 실행을 멈추는 일이 없다. 기록하기 직전에 다른 호출이 같은 자원을 먼저
 * 기록했거나 범위가 정리 단계로 넘어갔으면 자기 실행을 id로 멈추고, 끝난 것이 확인되지 않으면 그 실행을 정리 필요로
 * 기록해 finish가 다시 다루게 한다.
 */
export async function launchResource(env: Env, input: LaunchInput): Promise<LaunchResult> {
  const key = validateKey(input.resource);
  if (typeof input.command !== "string" || !input.command.trim()) throw new TestSessionError("launch에는 command가 필요합니다.");
  const scopeId = (await loadOpenActive(env, input.name)).id;
  const lockPath = scopeLockPath(env, scopeId);
  if (finishing.has(lockPath)) throw new TestSessionError(`'${input.name}'의 finish가 진행 중이라 새로 띄우지 않았습니다.`);
  launching.set(lockPath, (launching.get(lockPath) ?? 0) + 1);
  try {
    // 시작부터 기록까지 범위 잠금을 쥔다. 그래야 finish가 기록되지 않은 실행을 모른 채 작업 공간을 지우지 않는다.
    return await withFileLock(lockPath, () => launchLocked(env, input, key, scopeId), { retries: LAUNCH_LOCK_RETRIES, retryDelayMs: 100 });
  } finally {
    const left = (launching.get(lockPath) ?? 1) - 1;
    if (left > 0) launching.set(lockPath, left);
    else launching.delete(lockPath);
  }
}

async function launchLocked(env: Env, input: LaunchInput, key: string, scopeId: string): Promise<LaunchResult> {
  const scope = await loadOpenActive(env, input.name);
  if (scope.id !== scopeId) throw new TestSessionError(`'${input.name}' 범위가 그 사이 새로 만들어졌습니다. 다시 부르세요.`);
  const existing = scope.resources.find((item) => item.key === key && item.state === "running")
    ?? scope.resources.find((item) => item.key === key && unresolved(item));
  if (existing) {
    const observation = (await observe(env, [existing])).get(existing)!;
    const updated = await applyObservations(env, scope.id, [[existing, observation]]);
    if (observation.kind === "live") {
      const resource = updated?.resources.find((item) => item.daemonId === existing.daemonId) ?? existing;
      return { scope: updated ?? scope, resource, reused: true, readyTimedOut: false, commandDiffers: existing.command !== undefined && existing.command !== input.command };
    }
    if (observation.kind === "ambiguous") throw new TestSessionError(`'${key}'를 확인할 수 없어 새로 띄우지 않았습니다: ${observation.note}`);
  }

  const workspace = workspacePath(env, scope.id);
  const cwd = input.cwd ? resolve(workspace, input.cwd) : workspace;
  const ready = normalizeReady(input.ready);
  const service = `ts-${scope.id}-${key}`.slice(0, 43).replace(/[-.]+$/, "") + `-${randomBytes(2).toString("hex")}`;
  const started = await env.backend.start(env.projectDir, {
    name: service,
    command: input.command,
    cwd,
    env: { TEST_SESSION_WORKSPACE: workspace, TEST_SESSION_OUTPUTS: join(workspace, OUTPUTS_DIR) },
    ready,
  }, env.sessionId);
  const daemon = started.daemon;
  const stamp = now();
  const record: Resource = {
    key, origin: "launched", service, daemonId: daemon.id, startedAt: daemon.startedAt, projectDir: env.projectDir,
    command: input.command, state: TERMINAL[daemon.state] ? "exited" : "running", updatedAt: stamp,
    ...(TERMINAL[daemon.state] ? { note: daemon.exitReason ?? "준비 전에 끝남", exitCode: daemon.exitCode } : {}),
  };
  type Commit = { recorded: true; scope: Scope } | { recorded: false; winner?: Resource; scope?: Scope };
  let outcome: Commit;
  try {
    outcome = await updateState<Commit>(env, (state) => {
      const current = state.scopes.find((item) => item.id === scope.id);
      if (!current || current.status !== "active") return { value: { recorded: false }, write: false };
      const winner = current.resources.find((item) => item.key === key && item.state === "running");
      if (winner) return { value: { recorded: false, winner: structuredClone(winner), scope: structuredClone(current) }, write: false };
      current.resources = current.resources.filter((item) => item.key !== key || unresolved(item));
      current.resources.push(record);
      current.updatedAt = stamp;
      return { value: { recorded: true, scope: structuredClone(current) }, write: true };
    });
  } catch (error) {
    // 상태에 남기지 못한 실행은 이 호출만 안다. id로 멈추고, 끝난 것이 확인될 때만 멈췄다고 말한다.
    const settled = await stopOne(env, record, classify(record, env.sessionId, daemon), STOP_TIMEOUT_MS);
    throw new TestSessionError(settled.kind === "ended"
      ? `상태를 기록하지 못해 방금 띄운 서비스 ${service}를 멈추고 종료를 확인했습니다: ${message(error)}`
      : `상태를 기록하지 못했고 방금 띄운 서비스 ${service}의 종료도 확인하지 못했습니다. read proc://${service}로 확인하세요: ${message(error)}`);
  }
  if (!outcome.recorded) {
    const settled = await stopOne(env, record, classify(record, env.sessionId, daemon), STOP_TIMEOUT_MS);
    let leftover: Resource | undefined;
    if (settled.kind !== "ended") {
      const why = settled.kind === "ambiguous" ? settled.note : "정지 요청 뒤에도 실행 중";
      leftover = { ...record, state: "needs-cleanup", note: `기록 직전 경합으로 남은 실행, ${why}`, updatedAt: now() };
      const pending = leftover;
      await updateState(env, (state) => {
        const current = state.scopes.find((item) => item.id === scope.id)!;
        current.resources.push(pending);
        if (current.status === "finished") {
          current.status = "needs-cleanup";
          delete current.finishedAt;
        }
        current.updatedAt = pending.updatedAt;
        return { value: undefined, write: true };
      });
    }
    if (outcome.winner && outcome.scope) return { scope: outcome.scope, resource: outcome.winner, reused: true, readyTimedOut: false, leftover };
    throw new TestSessionError(leftover
      ? `'${input.name}'가 그 사이 정리 단계로 넘어갔고, 방금 띄운 서비스 ${service}가 끝났는지 확인하지 못해 정리 필요로 기록했습니다. finish를 다시 부르세요.`
      : `'${input.name}'가 그 사이 정리 단계로 넘어가 방금 띄운 서비스 ${service}를 멈추고 종료를 확인했습니다.`);
  }
  return { scope: outcome.scope, resource: record, reused: false, readyTimedOut: started.readyTimedOut };
}

function normalizeReady(ready: LaunchInput["ready"]): LaunchSpec["ready"] {
  if (!ready) return undefined;
  if (!ready.log && ready.port === undefined) throw new TestSessionError("ready에는 log나 port가 필요합니다.");
  if (ready.port !== undefined && (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65_535)) {
    throw new TestSessionError("ready.port는 1~65535 정수입니다.");
  }
  const seconds = Math.max(0.05, Math.min(3_600, ready.timeout ?? 30));
  return { log: ready.log, port: ready.port, host: ready.host, timeoutMs: Math.round(seconds * 1_000) };
}

/**
 * 이 세션이 bash `name` 등으로 이미 띄운 broker 서비스를 범위에 붙인다. 살아 있고 owner가 이 세션인 서비스만
 * 받는다. 다른 세션·소유자 없는 서비스, 끝난 서비스, PID나 경로는 받지 않는다.
 */
export async function trackResource(env: Env, input: { name: string; resource: string; service: string }): Promise<{ scope: Scope; resource: Resource }> {
  const key = validateKey(input.resource);
  if (typeof input.service !== "string" || !input.service) throw new TestSessionError("track에는 service 이름이 필요합니다.");
  const scope = await loadOpenActive(env, input.name);
  const snapshot = (await env.backend.list(env.projectDir)).find((item) => item.name === input.service);
  if (!snapshot) throw new TestSessionError(`broker에 '${input.service}' 서비스가 없습니다.`);
  if (snapshot.owner !== env.sessionId) throw new TestSessionError(`'${input.service}'는 이 세션 소유가 아니라 붙이지 않습니다(owner ${snapshot.owner ?? "없음"}).`);
  if (TERMINAL[snapshot.state]) throw new TestSessionError(`'${input.service}'는 이미 ${snapshot.state} 상태입니다.`);
  const stamp = now();
  const record: Resource = {
    key, origin: "tracked", service: snapshot.name, daemonId: snapshot.id, startedAt: snapshot.startedAt,
    projectDir: env.projectDir, state: "running", updatedAt: stamp,
  };
  const updated = await updateState(env, (state) => {
    const current = state.scopes.find((item) => item.id === scope.id);
    if (!current || current.status !== "active") throw new TestSessionError(`'${input.name}'가 그 사이 정리 단계로 넘어갔습니다.`);
    for (const other of state.scopes) {
      if (other.resources.some((item) => item.daemonId === snapshot.id && unresolved(item))) {
        throw new TestSessionError(`'${input.service}'는 이미 범위 '${other.name}'에 붙어 있습니다.`);
      }
    }
    if (current.resources.some((item) => item.key === key && unresolved(item))) {
      throw new TestSessionError(`'${key}' 자원이 이미 실행 중이거나 정리 대기입니다.`);
    }
    current.resources = current.resources.filter((item) => item.key !== key);
    current.resources.push(record);
    current.updatedAt = stamp;
    return { value: structuredClone(current), write: true };
  });
  return { scope: updated, resource: record };
}

// ---------------------------------------------------------------------------------------------------------------
// stop · finish · 세션 종료

export interface StopResult { scope: Scope; acted: Array<{ key: string; state: ResourceState; note?: string }> }

async function stopResources(env: Env, scope: Scope, keys: Resource[], timeoutMs: number, extra?: (scope: Scope) => void): Promise<StopResult> {
  const observed = await observe(env, keys);
  // 세션 종료 처리 시간이 짧아(core 2초) 자원별 정지를 동시에 요청한다. broker는 이름별로 따로 멈춘다.
  const outcomes = await Promise.all(keys.map(async (resource): Promise<[Resource, Observation]> => [resource, await stopOne(env, resource, observed.get(resource)!, timeoutMs)]));
  const updated = (await applyObservations(env, scope.id, outcomes, extra)) ?? scope;
  const acted = keys.map((resource) => {
    const current = updated.resources.find((item) => item.key === resource.key && item.daemonId === resource.daemonId);
    return { key: resource.key, state: current?.state ?? resource.state, note: current?.note };
  });
  return { scope: updated, acted };
}

/** 자원만 멈춘다. 범위와 작업 공간은 그대로 남아 다시 launch할 수 있다. */
export async function stopScopeResources(env: Env, input: { name: string; resource?: string }): Promise<StopResult> {
  const state = await readState(env);
  const scope = requireOpen(state, validateName(input.name));
  const key = input.resource === undefined ? undefined : validateKey(input.resource);
  const targets = scope.resources.filter((item) => unresolved(item) && (key === undefined || item.key === key));
  if (key !== undefined && targets.length === 0 && !scope.resources.some((item) => item.key === key)) {
    throw new TestSessionError(`'${input.name}'에 '${key}' 자원이 없습니다.`);
  }
  return stopResources(env, scope, targets, STOP_TIMEOUT_MS);
}

export interface FinishResult {
  scope: Scope;
  acted: StopResult["acted"];
  workspace: string;
  kept: string[];
  issues: string[];
}

/**
 * 명시한 정리. 끝나지 않은 자원을 확인해 멈추고, 모든 자원이 끝난 것이 확인되면 작업 공간에서 outputs와 keep만 남기고
 * 지운다. 하나라도 확인되지 않으면 작업 공간을 건드리지 않고 needs-cleanup으로 남긴다. 다시 부르면 끝나지 않은
 * 일(남은 자원 확인, 작업 공간 정리)만 다시 한다. 같은 범위의 launch나 finish가 진행 중이면 바로 거절한다. 그래야
 * 기록되기 전의 실행을 모른 채 작업 공간을 지우거나, 겹친 호출이 더한 keep을 모른 채 지우거나 남긴 목록을 덮어쓰지 않는다.
 */
export async function finishScope(env: Env, input: { name: string; keep?: string[] }): Promise<FinishResult> {
  const name = validateName(input.name);
  const keep = (input.keep ?? []).map(normalizeKeep);
  const target = requireOpen(await readState(env), name);
  const lockPath = scopeLockPath(env, target.id);
  const lock = finishing.has(lockPath) || launching.has(lockPath) ? null : tryAcquireFileLock(lockPath);
  if (!lock) throw new TestSessionError(`'${name}'에서 launch나 finish가 진행 중입니다. 끝난 뒤 test_session list로 확인하세요.`);
  finishing.add(lockPath);
  try {
    return await finishLocked(env, target.id, name, keep);
  } finally {
    finishing.delete(lockPath);
    lock.release();
  }
}

async function finishLocked(env: Env, scopeId: string, name: string, keep: string[]): Promise<FinishResult> {
  const scope = await updateState(env, (state) => {
    const current = state.scopes.find((item) => item.id === scopeId && item.status !== "finished");
    if (!current) throw new TestSessionError(`'${name}'는 이미 정리가 끝났습니다.`);
    current.status = "needs-cleanup";
    current.keep = [...new Set([...(current.keep ?? []), ...keep])];
    current.updatedAt = now();
    return { value: structuredClone(current), write: true };
  });
  const workspace = workspacePath(env, scope.id);
  const stopped = await stopResources(env, scope, scope.resources.filter(unresolved), STOP_TIMEOUT_MS);
  const issues = stopped.scope.resources.filter(unresolved).map((item) => `자원 ${item.key}: ${item.note ?? item.state}`);
  let kept: string[] = scope.kept ?? [];
  if (issues.length > 0) {
    issues.push("확인되지 않은 자원이 있어 작업 공간을 지우지 않았습니다.");
  } else if (!stopped.scope.workspaceCleaned) {
    try {
      kept = await pruneWorkspace(env, scope.id, scope.keep ?? []);
    } catch (error) {
      issues.push(`작업 공간 정리 실패: ${message(error)}`);
    }
  }
  const final = await updateState(env, (state) => {
    const current = state.scopes.find((item) => item.id === scope.id)!;
    const stamp = now();
    // 정리하는 사이 launch 경합이 남긴 실행이 기록됐으면 끝냈다고 하지 않는다.
    if (issues.length === 0) issues.push(...current.resources.filter(unresolved).map((item) => `자원 ${item.key}: ${item.note ?? item.state}`));
    if (issues.length === 0) {
      Object.assign(current, { status: "finished", workspaceCleaned: true, kept, finishedAt: stamp });
      delete current.cleanupIssues;
    } else {
      current.status = "needs-cleanup";
      current.cleanupIssues = issues;
    }
    current.updatedAt = stamp;
    return { value: structuredClone(current), write: true };
  });
  return { scope: final, acted: stopped.acted, workspace, kept, issues };
}

/**
 * 세션 전체가 끝날 때(session_shutdown, 다른 세션으로 전환) 이 세션이 띄운 살아 있는 자원을 멈춘다. 작업 공간과
 * 기록은 남겨 같은 세션을 다시 열면 보이게 한다. 턴 종료에는 부르지 않는다.
 */
export async function endSession(env: Env, timeoutMs = 1_500): Promise<StopResult[]> {
  const state = await readState(env);
  const stamp = now();
  // core가 종료 처리를 2초에서 끊으므로 범위끼리도 동시에 멈춘다. 정리 필요 자원도 다시 관측해 이 세션 소유로 살아 있으면 멈춘다.
  return Promise.all(state.scopes.filter((scope) => scope.status !== "finished").map((scope) =>
    stopResources(env, scope, scope.resources.filter(unresolved), timeoutMs, (current) => {
      if (current.status === "active") current.sessionEndedAt = stamp;
    })));
}

// ---------------------------------------------------------------------------------------------------------------
// 작업 공간 정리

function normalizeKeep(path: unknown): string {
  if (typeof path !== "string" || !path.trim()) throw new TestSessionError("keep에는 비어 있지 않은 상대 경로만 씁니다.");
  const value = posix.normalize(path.replaceAll("\\", "/")).replace(/\/+$/, "");
  if (isAbsolute(path) || value === "." || value === ".." || value.startsWith("../") || value.startsWith("/")) {
    throw new TestSessionError(`keep 경로는 작업 공간 안의 상대 경로여야 합니다: ${path}`);
  }
  return value;
}

/**
 * 다시 계산한 관리 경로가 실제로 그 자리의 디렉터리(심볼릭 링크 아님)인지 확인한 뒤 남길 경로만 빼고 지운다.
 * 지우는 디렉터리도 직접 하나씩 내려가며 매번 다시 확인하고, 디렉터리가 아닌 것(파일, 링크)은 unlink만 한다. keep으로
 * 지정한 경로는 링크든 디렉터리든 그대로 두고 들여다보지 않는다. outputs는 비어 있으면 지우고 아니면 통째로 남긴다.
 * 이미 없으면 정리된 것으로 본다. 반환값은 실제로 남은 상대 경로다.
 */
async function pruneWorkspace(env: Env, scopeId: string, keep: string[]): Promise<string[]> {
  const workspace = workspacePath(env, scopeId);
  try {
    await lstat(workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const expected = join(await realpath(env.root), sessionKey(env.sessionId), "ws", scopeId);
  const kept: string[] = [];
  await pruneDir(workspace, expected, "", new Set(keep), kept);
  if (kept.length === 0) await rmdir(workspace);
  return kept;
}

async function pruneDir(dir: string, expected: string, prefix: string, keep: Set<string>, kept: string[]): Promise<void> {
  // 내려가기 직전마다 그 자리가 아직 관리 경로 안의 실제 디렉터리인지 본다. 그 사이 링크로 바뀌었으면 따라가지 않고 멈춘다.
  const info = await lstat(dir);
  if (!info.isDirectory() || (await realpath(dir)) !== (prefix ? join(expected, prefix) : expected)) {
    throw new TestSessionError(`작업 공간 ${dir}가 관리 경로의 실제 디렉터리가 아니라 지우지 않았습니다.`);
  }
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(dir, entry.name);
    if (keep.has(rel)) {
      kept.push(rel);
    } else if (rel === OUTPUTS_DIR) {
      // 결과물 폴더는 빈 실제 디렉터리일 때만 지운다. rmdir은 내용이 있거나 링크면 실패하므로 그때는 들여다보지 않고 통째로 남긴다.
      try {
        await rmdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") kept.push(rel);
      }
    } else if (entry.isDirectory()) {
      const before = kept.length;
      await pruneDir(path, expected, rel, keep, kept);
      if (kept.length === before) await rmdir(path);
    } else {
      await unlink(path);
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------------------------
// SDK launch broker backend

/**
 * 실제 backend: 이 프로세스가 이미 쓰는 프로젝트 broker 연결을 공유한다. 명령은 세션 설정의 셸로 감싸고
 * (bash `name` 서비스와 같은 방식), launch.enabled가 꺼진 세션에서는 띄우지 않는다. 서비스는 persist·detached가 아니어서
 * broker가 끝나면 함께 끝난다.
 */
export function brokerBackend(): ServiceBackend {
  return {
    async list(projectDir) {
      const result = await (await daemonClientForProject(projectDir)).request({ op: "list" });
      if (result.op !== "list") throw new Error("broker list 응답이 아닙니다.");
      return result.daemons;
    },
    async start(projectDir, spec, owner) {
      const settings = findScopedSettings(projectDir);
      if (settings && !cfgLaunchEnabled.get(settings)) throw new TestSessionError("이 세션은 서비스 실행(launch.enabled)이 꺼져 있습니다.");
      const shell = settings ? settings.getShellConfig() : procmgr.getShellConfig();
      const result = await (await daemonClientForProject(projectDir)).request({
        op: "start",
        spec: {
          name: spec.name,
          application: shell.shell,
          args: [...shell.args, `${shell.prefix ? `${shell.prefix} ` : ""}${spec.command}`],
          env: { ...shell.env, ...spec.env },
          cwd: spec.cwd,
          pty: false,
          ready: spec.ready,
          restart: "no",
          persist: false,
          detached: false,
        },
        owner,
        replace: false,
        awaitReady: true,
      });
      if (result.op !== "start") throw new Error("broker start 응답이 아닙니다.");
      return { daemon: result.daemon, readyTimedOut: result.readyTimedOut };
    },
    async stop(projectDir, name, id, timeoutMs) {
      const result = await (await daemonClientForProject(projectDir)).request({ op: "stop", name, id, timeoutMs });
      if (result.op !== "stop") throw new Error("broker stop 응답이 아닙니다.");
      return result.daemon;
    },
  };
}
