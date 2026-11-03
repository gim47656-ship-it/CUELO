import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { endSession, type Env, finishScope, launchResource, listScopes, readState, type ServiceBackend, type ServiceSnapshot, startScope, trackResource, workspacePath } from "../lib/test-session-store";

// test_session의 소유·경로 안전과 프로세스 간 read-modify-write, 그리고 실제 확장 loader·SDK launch broker로 여러 턴·reload·
// 세션 종료·resume·정리를 거치는 smoke. broker를 쓰는 부분은 사용자 프로필(~/.omp/run)을 건드리지 않게 HOME을 격리한
// 자식 프로세스에서 돈다.

const EXTENSIONS = fileURLToPath(new URL("..", import.meta.url));
const STORE = join(EXTENSIONS, "lib", "test-session-store.ts");
const EXTENSION = join(EXTENSIONS, "test-session.ts");
const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "test-session-"));
  roots.push(dir);
  return dir;
}

/** 경로·격리 시험은 broker를 부르지 않아야 한다. 부르면 실패시킨다. */
const noBroker: ServiceBackend = {
  list: () => Promise.reject(new Error("broker called")),
  start: () => Promise.reject(new Error("broker called")),
  stop: () => Promise.reject(new Error("broker called")),
};

const envOf = (root: string, sessionId: string): Env => ({ root, sessionId, projectDir: root, backend: noBroker });

describe("test_session 작업 공간 소유와 세션 격리", () => {
  test("같은 세션·같은 이름은 같은 작업 공간을 다시 열고, 다른 세션은 그 범위를 보지도 끝내지도 못한다", async () => {
    const root = scratch();
    const a = envOf(root, "session-a");
    const first = await startScope(a, { name: "nexus" });
    expect(first.created).toBe(true);
    // 상태에는 명령줄이 담기므로 세션 디렉터리와 상태 파일은 소유자만 읽는다.
    const [sessionDirName] = readdirSync(root);
    expect(statSync(join(root, sessionDirName)).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, sessionDirName, "state.json")).mode & 0o777).toBe(0o600);
    writeFileSync(join(first.workspace, "engine.bin"), "downloaded once");
    const again = await startScope(a, { name: "nexus" });
    expect(again.created).toBe(false);
    expect(again.workspace).toBe(first.workspace);
    expect(readFileSync(join(again.workspace, "engine.bin"), "utf8")).toBe("downloaded once");

    const b = envOf(root, "session-b");
    const listed = await listScopes(b);
    expect(listed.scopes).toEqual([]);
    expect(listed.otherSessions).toBe(1);
    await expect(finishScope(b, { name: "nexus" })).rejects.toThrow("열린 테스트 범위 'nexus'가 없습니다");
    expect(existsSync(join(first.workspace, "engine.bin"))).toBe(true);
  });

  test("finish는 outputs와 keep만 남기고, 작업 공간 안 링크는 링크만 지운다", async () => {
    const root = scratch();
    const outside = join(scratch(), "user-data");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious.txt"), "user file");
    const env = envOf(root, "session-a");
    const { workspace } = await startScope(env, { name: "deliver" });
    writeFileSync(join(workspace, "outputs", "report.txt"), "deliverable");
    mkdirSync(join(workspace, "notes", "deep"), { recursive: true });
    writeFileSync(join(workspace, "notes", "keep.txt"), "kept by request");
    writeFileSync(join(workspace, "notes", "deep", "scratch.txt"), "scratch");
    writeFileSync(join(workspace, "cache.bin"), "scratch");
    symlinkSync(outside, join(workspace, "link-to-user-data"));
    mkdirSync(join(workspace, "build", "sub"), { recursive: true });
    symlinkSync(outside, join(workspace, "build", "sub", "nested-link"));
    mkdirSync(join(workspace, "empty-keep"));

    // keep으로 지정한 빈 디렉터리도 그대로 남는다. 지우는 디렉터리 안의 링크는 링크만 지운다.
    const result = await finishScope(env, { name: "deliver", keep: ["notes/keep.txt", "empty-keep"] });
    expect(result.issues).toEqual([]);
    expect(result.scope.status).toBe("finished");
    expect(result.kept.sort()).toEqual(["empty-keep", "notes/keep.txt", "outputs"]);
    expect(readdirSync(workspace).sort()).toEqual(["empty-keep", "notes", "outputs"]);
    expect(readdirSync(join(workspace, "notes"))).toEqual(["keep.txt"]);
    expect(readdirSync(outside)).toEqual(["precious.txt"]);
    expect(readFileSync(join(workspace, "outputs", "report.txt"), "utf8")).toBe("deliverable");
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("user file");
  });

  test("작업 공간 자리가 다른 곳을 가리키는 링크로 바뀌면 지우지 않고 정리 필요로 남기며, 없어진 뒤 다시 부르면 끝난다", async () => {
    const root = scratch();
    const outside = join(scratch(), "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious.txt"), "user file");
    const env = envOf(root, "session-a");
    const { workspace } = await startScope(env, { name: "swap" });
    rmSync(workspace, { recursive: true });
    symlinkSync(outside, workspace);

    const blocked = await finishScope(env, { name: "swap" });
    expect(blocked.scope.status).toBe("needs-cleanup");
    expect(blocked.issues.join("\n")).toContain("관리 경로의 실제 디렉터리가 아니라 지우지 않았습니다");
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("user file");
    await expect(startScope(env, { name: "swap" })).rejects.toThrow("정리가 끝나지 않았습니다");

    rmSync(workspace); // 링크만 없앤다
    const done = await finishScope(env, { name: "swap" });
    expect(done.scope.status).toBe("finished");
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("user file");
  });

  test("상태 파일의 범위 id가 경로 밖을 가리키면 작업 공간 경로를 만들지 않는다", async () => {
    const root = scratch();
    const env = envOf(root, "session-a");
    const { scope } = await startScope(env, { name: "tamper" });
    const statePath = join(root, "session-a", "state.json");
    writeFileSync(statePath, readFileSync(statePath, "utf8").replace(`"id": "${scope.id}"`, `"id": "../../escape"`));
    await expect(finishScope(env, { name: "tamper" })).rejects.toThrow("관리 범위 id가 올바르지 않습니다");
    expect(() => workspacePath(env, "../../escape")).toThrow();
  });
});

/**
 * 기록 전 경합을 재현하는 broker 대역. start는 실행을 만들고 onStart로 그 사이 다른 호출을 끼워 넣으며, stop은 실패하게
 * 할 수 있다(연결 끊김 등). 실제 broker로는 commit 직전 순간을 고정할 수 없어 이 경로만 대역으로 본다.
 */
function racingBroker() {
  const daemons = new Map<string, ServiceSnapshot>();
  const broker = {
    daemons,
    onStart: undefined as undefined | (() => Promise<void>),
    /** list가 스냅샷을 찍은 뒤 돌려주기 전에 끼울 일. 오래된 관측이 늦게 반영되는 순서를 만든다. */
    onList: undefined as undefined | (() => Promise<void>),
    stopFails: false,
    backend: {
      list: async () => {
        const snapshot = [...daemons.values()].map((item) => ({ ...item }));
        const hook = broker.onList;
        broker.onList = undefined;
        await hook?.();
        return snapshot;
      },
      start: async (_project, spec, owner) => {
        const daemon: ServiceSnapshot = { name: spec.name, id: crypto.randomUUID(), state: "running", owner, startedAt: Date.now() };
        daemons.set(spec.name, daemon);
        const hook = broker.onStart;
        broker.onStart = undefined;
        await hook?.();
        return { daemon, readyTimedOut: false };
      },
      stop: async (_project, name, id) => {
        if (broker.stopFails) throw new Error("broker connection closed");
        const daemon = daemons.get(name)!;
        if (daemon.id === id) daemon.state = "exited";
        return daemon;
      },
    } satisfies ServiceBackend,
  };
  return broker;
}

describe("test_session launch 기록 전 경합", () => {
  test("launch가 시작부터 기록까지 쥔 범위에는 finish가 끼어들지 못하고, 띄운 실행은 그대로 기록된다", async () => {
    const root = scratch();
    const broker = racingBroker();
    const env: Env = { root, sessionId: "s", projectDir: root, backend: broker.backend };
    const { workspace } = await startScope(env, { name: "race" });
    writeFileSync(join(workspace, "scratch.tmp"), "in use");
    let refused: unknown;
    broker.onStart = async () => { refused = await finishScope(env, { name: "race" }).then(() => "finished", (error: Error) => error.message); };
    const result = await launchResource(env, { name: "race", resource: "engine", command: "serve" });
    expect(refused).toContain("launch나 finish가 진행 중");
    expect(existsSync(join(workspace, "scratch.tmp"))).toBe(true);
    const scope = (await readState(env)).scopes[0];
    expect(scope.status).toBe("active");
    expect(scope.resources).toContainEqual(expect.objectContaining({ key: "engine", daemonId: result.resource.daemonId, state: "running" }));
  });

  test("기록이 실패하면 방금 띄운 실행을 id로 멈추고 종료를 확인한 뒤에만 멈췄다고 말한다", async () => {
    const root = scratch();
    const broker = racingBroker();
    const env: Env = { root, sessionId: "s", projectDir: root, backend: broker.backend };
    await startScope(env, { name: "race" });
    const [sessionDirName] = readdirSync(root);
    const state = join(root, sessionDirName, "state.json");
    // 시작과 기록 사이에 상태 파일을 읽을 수 없게 만든다(디스크 오류 대신 같은 경로의 디렉터리).
    broker.onStart = async () => { rmSync(state); mkdirSync(state); };
    const failure = await launchResource(env, { name: "race", resource: "engine", command: "serve" }).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain("멈추고 종료를 확인했습니다");
    expect([...broker.daemons.values()].map((item) => item.state)).toEqual(["exited"]);
  });

  test("같은 자원이 먼저 기록되고 자기 실행 정지가 실패하면 그 실행을 정리 필요로 기록하고, 세션 종료와 finish가 다시 다룬다", async () => {
    const root = scratch();
    const broker = racingBroker();
    const env: Env = { root, sessionId: "s", projectDir: root, backend: broker.backend };
    await startScope(env, { name: "race" });
    let winner: string | undefined;
    // 시작과 기록 사이에 이 세션이 bash로 띄운 서비스를 같은 자원 이름으로 track한다.
    broker.onStart = async () => {
      broker.daemons.set("agent-svc", { name: "agent-svc", id: crypto.randomUUID(), state: "running", owner: "s", startedAt: Date.now() });
      winner = (await trackResource(env, { name: "race", resource: "engine", service: "agent-svc" })).resource.daemonId;
    };
    const outer = launchResource(env, { name: "race", resource: "engine", command: "serve" });
    broker.stopFails = true;
    const result = await outer;
    expect(result.reused).toBe(true);
    expect(result.resource.daemonId).toBe(winner!);
    const loser = [...broker.daemons.values()].find((item) => item.id !== winner)!;
    expect(loser.state).toBe("running");
    expect(result.leftover?.daemonId).toBe(loser.id);
    const recorded = (await readState(env)).scopes[0].resources;
    expect(recorded).toContainEqual(expect.objectContaining({ key: "engine", daemonId: loser.id, state: "needs-cleanup" }));
    expect(recorded).toContainEqual(expect.objectContaining({ key: "engine", daemonId: winner, state: "running" }));

    // broker가 돌아오면 세션 종료가 정리 필요 실행까지 다시 확인해 멈추고, finish는 남은 일 없이 끝난다.
    broker.stopFails = false;
    await endSession(env);
    expect(loser.state).toBe("exited");
    const done = await finishScope(env, { name: "race" });
    expect(done.issues).toEqual([]);
    expect([...broker.daemons.values()].map((item) => item.state)).toEqual(["exited", "exited"]);
  });
});

describe("test_session 관측·정리 경합", () => {
  test("list가 본 오래된 '실행 중'이 그 사이 끝난 finish의 정지 기록을 되살리지 않는다", async () => {
    const root = scratch();
    const broker = racingBroker();
    const env: Env = { root, sessionId: "s", projectDir: root, backend: broker.backend };
    await startScope(env, { name: "race" });
    await launchResource(env, { name: "race", resource: "engine", command: "serve" });
    broker.onList = async () => { await finishScope(env, { name: "race" }); };
    await listScopes(env);
    const scope = (await readState(env)).scopes[0];
    expect(scope.status).toBe("finished");
    expect(scope.resources.map((item) => item.state)).toEqual(["stopped"]);
  });

  test("같은 범위의 finish가 겹치면 뒤 호출은 바로 거절되고, 앞 호출의 남긴 목록이 실제 남은 파일과 같다", async () => {
    const root = scratch();
    const broker = racingBroker();
    const env: Env = { root, sessionId: "s", projectDir: root, backend: broker.backend };
    const { workspace } = await startScope(env, { name: "race" });
    mkdirSync(join(workspace, "notes"));
    writeFileSync(join(workspace, "notes", "x.txt"), "wanted");
    await launchResource(env, { name: "race", resource: "engine", command: "serve" });
    let overlapping: unknown;
    broker.onList = async () => { overlapping = await finishScope(env, { name: "race", keep: ["notes/x.txt"] }).then(() => "finished", (error: Error) => error.message); };
    const first = await finishScope(env, { name: "race" });
    expect(overlapping).toContain("launch나 finish가 진행 중");
    expect(first.scope.status).toBe("finished");
    expect(first.scope.kept).toEqual(existsSync(workspace) ? readdirSync(workspace) : []);
  });
});


describe("test_session 상태의 프로세스 간 read-modify-write", () => {
  test("여러 프로세스가 같은 세션 상태에 동시에 범위를 더해도 하나도 잃지 않는다", async () => {
    const root = scratch();
    const writers = 6;
    const perWriter = 15;
    const script = `
      const { startScope } = await import(${JSON.stringify(STORE)});
      const env = { root: process.env.TS_ROOT, sessionId: "shared-session", projectDir: process.env.TS_ROOT, backend: {} };
      for (let i = 0; i < ${perWriter}; i++) await startScope(env, { name: "w" + process.env.TS_WRITER + "-" + i });
    `;
    const children = Array.from({ length: writers }, (_, index) => Bun.spawn([process.execPath, "-e", script], {
      cwd: EXTENSIONS, env: { ...process.env, TS_ROOT: root, TS_WRITER: String(index) }, stdout: "pipe", stderr: "pipe",
    }));
    const codes = await Promise.all(children.map(async (child) => ({ code: await child.exited, err: await new Response(child.stderr).text() })));
    expect(codes.filter((item) => item.code !== 0)).toEqual([]);
    const state = await readState({ root, sessionId: "shared-session" });
    const names = state.scopes.map((scope) => scope.name);
    expect(new Set(names).size).toBe(writers * perWriter);
    expect(names).toHaveLength(writers * perWriter);
    expect(readdirSync(join(root, "shared-session", "ws"))).toHaveLength(writers * perWriter);
  }, 60_000);
});

// 실제 SDK 경로: createAgentSession이 확장 loader로 test-session.ts를 읽고, fake 부모 모델이 test_session을 턴마다 부른다.
// broker 서비스는 실제로 뜨고 멈춘다. 관측값만 JSON으로 돌려받아 아래에서 판정한다.
const SMOKE = String.raw`
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { createAssistantMessageEventStream } = await import("@oh-my-pi/pi-ai");
const { AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { daemonClientForProject } = await import("@oh-my-pi/pi-coding-agent/launch/client");
const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
const extensionErrors = [];
const root = process.env.TS_ROOT;
const work = join(root, "work"), agentDir = join(root, "agent"), sessionsDir = join(root, "sessions");
mkdirSync(work, { recursive: true }); mkdirSync(agentDir, { recursive: true });
const auth = await AuthStorage.create(join(agentDir, "agent.db"));
const registry = new ModelRegistry(auth, join(agentDir, "models.yml"));
registry.registerProvider("fakeparent", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "local", api: "openai-completions",
  models: [{ id: "parent", name: "parent", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] });
const model = registry.find("fakeparent", "parent");
const obs = {};
let callNo = 0;
async function open(sessionManager) {
  const { session } = await createAgentSession({
    cwd: work, agentDir, model, modelRegistry: registry, sessionManager,
    settings: Settings.isolated({ tools: { approvalMode: "yolo" } }),
    additionalExtensionPaths: [process.env.TS_EXTENSION], disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, skipPythonPreflight: true,
    skills: [], rules: [], contextFiles: [], toolNames: ["test_session"],
  });
  // print·rpc 모드와 같은 초기화: runner 동작을 연결하고 session_start를 보낸다.
  await initializeExtensions(session, { reportSendError: (action, error) => extensionErrors.push(action + ": " + error.message), reportRuntimeError: (error) => extensionErrors.push(String(error.error ?? error)) });
  let pending;
  session.agent.streamFn = () => {
    const stream = createAssistantMessageEventStream();
    const call = pending; pending = undefined;
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: call ? [{ type: "toolCall", id: "call-" + (++callNo), name: "test_session", arguments: call }] : [{ type: "text", text: "done" }],
      stopReason: call ? "toolUse" : "stop" };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (call) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      stream.end();
    });
    return stream;
  };
  return {
    session,
    async call(args) {
      pending = args;
      const before = session.agent.state.messages.length;
      await session.prompt("turn");
      const added = session.agent.state.messages.slice(before);
      const result = added.find((item) => item.role === "toolResult");
      return { isError: result.isError === true, text: result.content.map((part) => part.text ?? "").join(""), details: result.details, context: JSON.stringify(added) };
    },
  };
}
const client = await daemonClientForProject(work);
const sh = (command) => ({ application: "/bin/sh", args: ["-c", command], env: {}, cwd: work, pty: false, restart: "no", persist: false, detached: false });
const services = async () => Object.fromEntries((await client.request({ op: "list" })).daemons.map((d) => [d.name, { state: d.state, id: d.id, owner: d.owner }]));
await client.request({ op: "start", spec: { name: "unrelated-svc", ...sh("exec sleep 300") }, owner: "someone-else", replace: true, awaitReady: true });

const ENGINE = "test -f engine.bin || { echo fetched >> fetch.log; echo bin > engine.bin; }; echo engine-ready; exec sleep 300";
const launchEngine = { action: "launch", name: "nexus", resource: "engine", command: ENGINE, ready: { log: "engine-ready", timeout: 20 } };

const sm1 = SessionManager.create(work, sessionsDir);
const s1 = await open(sm1);
const sid = sm1.getSessionId();
obs.tools = s1.session.agent.state.tools.map((tool) => tool.name);
obs.start1 = await s1.call({ action: "start", name: "nexus", purpose: "engine reuse" });
const ws = obs.start1.details.workspace;
obs.launch1 = await s1.call(launchEngine);
obs.launch2 = await s1.call(launchEngine);
obs.start2 = await s1.call({ action: "start", name: "nexus" });
await s1.session.reload();
obs.listAfterReload = await s1.call({ action: "list" });
await client.request({ op: "start", spec: { name: "agent-svc", ...sh("exec sleep 300") }, owner: sid, replace: true, awaitReady: true });
obs.track = await s1.call({ action: "track", name: "nexus", resource: "helper", service: "agent-svc" });
obs.trackForeign = await s1.call({ action: "track", name: "nexus", resource: "foreign", service: "unrelated-svc" });
obs.stopEngine = await s1.call({ action: "stop", name: "nexus", resource: "engine" });
obs.workspaceAfterStop = existsSync(join(ws, "engine.bin"));
obs.relaunch = await s1.call(launchEngine);
writeFileSync(join(ws, "outputs", "report.txt"), "deliverable");
writeFileSync(join(ws, "scratch.tmp"), "scratch");
obs.fetchLog = readFileSync(join(ws, "fetch.log"), "utf8");
obs.brokerBeforeShutdown = await services();
await s1.session.dispose();
await sm1.close();
obs.brokerAfterShutdown = await services();

const sm2 = SessionManager.create(work, sessionsDir);
const s2 = await open(sm2);
obs.otherList = await s2.call({ action: "list" });
obs.otherFinish = await s2.call({ action: "finish", name: "nexus" });
await s2.session.dispose();
await sm2.close();

const sm1b = await SessionManager.open(sm1.getSessionFile(), sessionsDir);
const s1b = await open(sm1b);
obs.resumedSameSession = sm1b.getSessionId() === sid;
obs.listAfterResume = await s1b.call({ action: "list" });
obs.brokerAfterResume = await services();
obs.launch3 = await s1b.call(launchEngine);
const engineService = obs.launch3.details.resource.service;
await client.request({ op: "start", spec: { name: engineService, ...sh("exec sleep 300") }, owner: "intruder", replace: true, awaitReady: true });
obs.finishBlocked = await s1b.call({ action: "finish", name: "nexus" });
obs.afterBlocked = { broker: await services(), scratch: existsSync(join(ws, "scratch.tmp")) };
await client.request({ op: "stop", name: engineService, timeoutMs: 2000 });
obs.finishDone = await s1b.call({ action: "finish", name: "nexus" });
obs.workspaceEnd = existsSync(ws) ? readdirSync(ws, { recursive: true }).map(String).sort() : null;
obs.brokerEnd = await services();
await s1b.session.dispose();
await sm1b.close();
await client.request({ op: "stop", name: "unrelated-svc", timeoutMs: 2000 });
auth.close();
obs.engineServices = [obs.launch1, obs.launch2, obs.relaunch, obs.launch3].map((item) => item.details.resource.service);
obs.daemonIds = [obs.launch1, obs.launch2, obs.relaunch, obs.launch3].map((item) => item.details.resource.daemonId);
obs.sid = sid;
obs.extensionErrors = extensionErrors;
obs.ws = ws;
console.log("OBS " + JSON.stringify(obs));
process.exit(0);
`;

describe("test_session 실제 확장 loader와 SDK launch broker", () => {
  test("여러 턴·reload·세션 종료·resume·정리에서 재사용·정지·보존·정리 필요가 실제 broker 상태와 맞는다", async () => {
    const root = scratch();
    const home = join(root, "home");
    mkdirSync(home);
    // 상태·실행 디렉터리를 격리 HOME 아래로 보낸다. 빈 값으로 두면 Bun이 cwd 기준 상대 경로(bun/@t@)에 캐시를 쓰므로 키를 지운다.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("XDG_") && key !== "PI_CODING_AGENT_DIR"));
    const child = Bun.spawn([process.execPath, "-e", SMOKE], {
      cwd: EXTENSIONS,
      env: { ...inherited, HOME: home, OMP_TEST_SESSION_DIR: join(root, "store"), TS_ROOT: root, TS_EXTENSION: EXTENSION },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const line = out.split("\n").find((item) => item.startsWith("OBS "));
    if (code !== 0 || !line) throw new Error(`smoke exit ${code}\n${out.slice(-4000)}\n${err.slice(-4000)}`);
    const obs = JSON.parse(line.slice(4));

    // 확장 loader가 도구를 등록했다.
    expect(obs.tools).toContain("test_session");
    expect(obs.extensionErrors).toEqual([]);
    // 같은 세션의 반복 launch·start는 같은 실행과 작업 공간을 다시 쓴다(다운로드는 한 번).
    expect(obs.launch1.isError).toBe(false);
    expect(obs.launch2.text).toContain("재사용했습니다(재시작 없음");
    expect(obs.daemonIds[1]).toBe(obs.daemonIds[0]);
    expect(obs.start2.text).toContain("다시 열었습니다(작업 공간 재사용)");
    expect(obs.start2.details.workspace).toBe(obs.ws);
    // reload 뒤에도 같은 generation이 실행 중으로 보이고 새로 띄우지 않았다.
    expect(obs.listAfterReload.details.scopes[0].resources[0]).toMatchObject({ key: "engine", state: "running", daemonId: obs.daemonIds[0] });
    // 남은 범위 안내는 열기·reload·resume 뒤 첫 prompt에 한 번만 붙는다. 범위가 없는 세션에는 붙지 않는다.
    const NOTICE = "[test_session] 이 세션에 남아 있는 테스트 범위입니다";
    expect(obs.start1.context).not.toContain("[test_session]");
    expect(obs.listAfterReload.context).toContain(NOTICE);
    expect(obs.track.context).not.toContain(NOTICE);
    expect(obs.otherList.context).not.toContain("[test_session]");
    // 이 세션 소유의 살아 있는 broker 서비스만 붙인다.
    expect(obs.track.isError).toBe(false);
    expect(obs.trackForeign.isError).toBe(true);
    expect(obs.trackForeign.text).toContain("이 세션 소유가 아니라 붙이지 않습니다");
    // stop은 자원만 멈추고 작업 공간은 남는다. 다시 launch하면 새 generation이지만 다운로드는 다시 하지 않는다.
    expect(obs.stopEngine.text).toContain("자원만 멈췄습니다");
    expect(obs.workspaceAfterStop).toBe(true);
    expect(obs.daemonIds[2]).not.toBe(obs.daemonIds[0]);
    expect(obs.fetchLog).toBe("fetched\n");
    expect(obs.brokerBeforeShutdown[obs.engineServices[0]].state).toBe("exited");
    // 세션 종료는 이 세션의 실행 중 자원만 멈추고 다른 서비스는 그대로 둔다.
    expect(obs.brokerBeforeShutdown[obs.engineServices[2]].state).toMatch(/ready|running/);
    expect(obs.brokerAfterShutdown[obs.engineServices[2]].state).toBe("exited");
    expect(obs.brokerAfterShutdown["agent-svc"].state).toBe("exited");
    expect(obs.brokerAfterShutdown["unrelated-svc"].state).toMatch(/ready|running/);
    // 다른 세션은 남은 범위의 수만 보고 끝낼 수 없다.
    expect(obs.otherList.text).toContain("다른 세션이 끝내지 않고 남긴 범위 1개");
    expect(obs.otherFinish.isError).toBe(true);
    // 같은 세션 resume: 안내가 한 번 실리고, 기록은 보이며 아무것도 다시 띄우지 않았다.
    expect(obs.resumedSameSession).toBe(true);
    expect(obs.listAfterResume.context).toContain(NOTICE);
    expect(obs.listAfterResume.details.scopes[0].sessionEndedAt).toBeString();
    expect(obs.listAfterResume.details.scopes[0].resources.map((item: { state: string }) => item.state)).toEqual(["stopped", "stopped"]);
    expect(obs.brokerAfterResume[obs.engineServices[2]]).toEqual(obs.brokerAfterShutdown[obs.engineServices[2]]);
    expect(Object.keys(obs.brokerAfterResume).sort()).toEqual(Object.keys(obs.brokerAfterShutdown).sort());
    // 같은 이름에 다른 소유자의 실행이 살아 있으면 멈추지 않고 정리 필요로 남기며 작업 공간을 지우지 않는다.
    expect(obs.finishBlocked.text).toContain("정리가 끝나지 않았습니다(정리 필요)");
    expect(obs.finishBlocked.details.scope.status).toBe("needs-cleanup");
    expect(obs.afterBlocked.broker[obs.engineServices[3]]).toMatchObject({ owner: "intruder" });
    expect(obs.afterBlocked.broker[obs.engineServices[3]].state).toMatch(/ready|running/);
    expect(obs.afterBlocked.scratch).toBe(true);
    // 그 실행이 끝난 뒤 다시 부른 finish는 남은 일만 하고 outputs만 남긴다. 관계없는 서비스는 끝까지 살아 있다.
    expect(obs.finishDone.details.scope.status).toBe("finished");
    expect(obs.finishDone.text).toContain("남긴 결과물: outputs");
    expect(obs.workspaceEnd).toEqual(["outputs", "outputs/report.txt"]);
    expect(obs.brokerEnd["unrelated-svc"].state).toMatch(/ready|running/);
  }, 120_000);
});
