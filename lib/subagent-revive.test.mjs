import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createRootDispatchFactory, registerRootReviver } = await jiti.import("./subagent-revive.ts");

const dir = path.resolve("sessions", "proj");
const rootA = path.join(dir, "2026-09-30_s1.jsonl");
const rootB = path.join(dir, "2026-09-30_s10.jsonl");
const childOf = (root, ...rest) => path.join(root.slice(0, -".jsonl".length), ...rest);

function recorder(label, calls) {
  return async (ref) => {
    calls.push([label, ref.id]);
    return async () => label;
  };
}

test("a parked child revives through the root session whose artifact directory holds its transcript", async () => {
  const calls = [];
  const roots = new Map([[rootA, recorder("A", calls)], [rootB, recorder("B", calls)]]);
  const dispatch = createRootDispatchFactory(roots);
  // s1 and s10 share a name prefix; only the directory boundary decides ownership.
  assert.ok(await dispatch({ id: "0-Fix", sessionFile: childOf(rootB, "0-Fix.jsonl") }));
  assert.ok(await dispatch({ id: "1-Nested", sessionFile: childOf(rootA, "0-Fix", "1-Nested.jsonl") }));
  assert.deepEqual(calls, [["B", "0-Fix"], ["A", "1-Nested"]]);
});

test("a child of a root that is not open, the root transcript itself, or a ref without a file stays transcript-only", async () => {
  const calls = [];
  const dispatch = createRootDispatchFactory(new Map([[rootA, recorder("A", calls)]]));
  assert.equal(await dispatch({ id: "0-Fix", sessionFile: childOf(rootB, "0-Fix.jsonl") }), undefined);
  assert.equal(await dispatch({ id: "self", sessionFile: rootA }), undefined);
  assert.equal(await dispatch({ id: "none", sessionFile: null }), undefined);
  assert.deepEqual(calls, []);
});

test("unregistering a torn-down session leaves a newer registration for the same root in place", async () => {
  const calls = [];
  const first = recorder("old", calls);
  const second = recorder("new", calls);
  const registry = new AgentRegistry();
  const scope = { registry, lifecycle: new AgentLifecycleManager(registry) };
  const dropFirst = registerRootReviver(rootA, "Main", first, () => 0, scope);
  registerRootReviver(rootA, "Main", second, () => 0, scope);
  dropFirst();
  const dispatch = createRootDispatchFactory(globalThis.__cueloRootRevivers);
  await dispatch({ id: "0-Fix", sessionFile: childOf(rootA, "0-Fix.jsonl") });
  assert.deepEqual(calls, [["new", "0-Fix"]]);
});

// --- 재시작 뒤 복원된 child의 소유 root ---------------------------------------------------
// core는 복원한 parked child의 parentId를 항상 "Main"으로 박는다. 한 프로세스에 top-level이 둘 이상이면
// 두 번째 이후 root(`Main#3` 등)의 child가 다른 root 소유로 보여 자기 Main의 write가 거절됐다.
const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
const { AgentLifecycleManager } = await import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle");
const { ensurePersistedRoster } = await import("@oh-my-pi/pi-coding-agent/registry/persisted-agents");
const { IrcBus } = await import("@oh-my-pi/pi-coding-agent/irc/bus");
const fs = await import("node:fs");
const os = await import("node:os");

function writeTranscript(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = "2026-10-05T00:00:00.000Z";
  fs.writeFileSync(file, [
    { type: "session", timestamp: at, id: "s" },
    { type: "session_init", timestamp: at, task: "t" },
    { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: "hi" } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
}

function twoRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "revive-owner-"));
  const A = path.join(base, "A.jsonl");
  const B = path.join(base, "B.jsonl");
  for (const file of [A, B, childOf(A, "ChildA.jsonl"), childOf(B, "Maker.jsonl"), childOf(B, "Maker", "Nested.jsonl")]) writeTranscript(file);
  const registry = new AgentRegistry();
  const lifecycle = new AgentLifecycleManager(registry);
  const delivered = [];
  const stub = (id) => ({ deliverIrcMessage: async (m) => { delivered.push([id, m.from]); return "injected"; }, dispose: async () => {} });
  const factory = async (ref) => async () => stub(ref.id);
  registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, sessionFile: A, status: "idle" });
  registry.register({ id: "Main#3", displayName: "Main", kind: "main", session: null, sessionFile: B, status: "idle" });
  const scope = { registry, lifecycle };
  registerRootReviver(A, "Main", factory, () => 0, scope);
  registerRootReviver(B, "Main#3", factory, () => 0, scope);
  return { A, B, registry, lifecycle, delivered, bus: new IrcBus(registry, lifecycle) };
}

test("a restored child is owned by the root whose artifact directory holds it, so its own Main can write and another Main cannot", async () => {
  const { A, B, registry, bus, delivered } = twoRoots();
  await ensurePersistedRoster(registry, A);
  await ensurePersistedRoster(registry, B);
  assert.equal(registry.rootOf("Maker"), "Main#3");
  assert.equal(registry.rootOf("Nested"), "Main#3");
  assert.equal(registry.rootOf("ChildA"), "Main");

  const own = await bus.send({ from: "Main#3", to: "Maker", body: "이어서" });
  assert.equal(own.outcome, "revived");
  const nested = await bus.send({ from: "Main#3", to: "Nested", body: "이어서" });
  assert.equal(nested.outcome, "revived");
  const cross = await bus.send({ from: "Main", to: "Maker", body: "침범" });
  assert.equal(cross.outcome, "failed");
  assert.match(cross.error, /different top-level session/);
  const crossBack = await bus.send({ from: "Main#3", to: "ChildA", body: "침범" });
  assert.equal(crossBack.outcome, "failed");
  assert.deepEqual(delivered, [["Maker", "Main#3"], ["Nested", "Main#3"]]);
});

test("children restored before the owning root registers are re-parented, and a repeated send revives only once", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "revive-owner-"));
  const B = path.join(base, "B.jsonl");
  for (const file of [B, childOf(B, "Maker.jsonl")]) writeTranscript(file);
  const registry = new AgentRegistry();
  const lifecycle = new AgentLifecycleManager(registry);
  registry.register({ id: "Main#3", displayName: "Main", kind: "main", session: null, sessionFile: B, status: "idle" });
  await ensurePersistedRoster(registry, B);
  assert.equal(registry.rootOf("Maker"), "Main");
  let revives = 0;
  registerRootReviver(B, "Main#3", async () => async () => { revives++; return { deliverIrcMessage: async () => "injected", dispose: async () => {} }; }, () => 0, { registry, lifecycle });
  assert.equal(registry.rootOf("Maker"), "Main#3");
  const bus = new IrcBus(registry, lifecycle);
  const [first, second] = await Promise.all([
    bus.send({ from: "Main#3", to: "Maker", body: "a" }),
    bus.send({ from: "Main#3", to: "Maker", body: "b" }),
  ]);
  assert.equal(first.outcome, "revived");
  assert.notEqual(second.outcome, "failed");
  assert.equal(revives, 1);
});

test("a completed idle child is re-parented without being woken", async () => {
  const { B, registry, delivered } = twoRoots();
  await ensurePersistedRoster(registry, B);
  assert.equal(registry.get("Maker").status, "parked");
  assert.equal(registry.get("Maker").session, null);
  assert.deepEqual(delivered, []);
});

test("only direct children are re-parented, nested parents stay, and a sibling root with a shared name prefix is never claimed", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "revive-owner-"));
  const s1 = path.join(base, "s1.jsonl");
  const s10 = path.join(base, "s10.jsonl");
  for (const file of [s1, s10, childOf(s1, "Maker.jsonl"), childOf(s1, "Maker", "Nested.jsonl"), childOf(s10, "Other.jsonl")]) writeTranscript(file);
  const registry = new AgentRegistry();
  const lifecycle = new AgentLifecycleManager(registry);
  registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, sessionFile: s10, status: "idle" });
  registry.register({ id: "Main#2", displayName: "Main", kind: "main", session: null, sessionFile: s1, status: "idle" });
  const seen = [];
  const factory = async (ref) => { seen.push([ref.id, ref.parentId]); return undefined; };
  // 등록 순서가 파일 이름 순서와 달라도 경계는 디렉터리 단위다.
  registerRootReviver(s1, "Main#2", factory, () => 0, { registry, lifecycle });
  registerRootReviver(s10, "Main", factory, () => 0, { registry, lifecycle });
  await ensurePersistedRoster(registry, s10);
  await ensurePersistedRoster(registry, s1);
  assert.equal(registry.get("Maker").parentId, "Main#2");
  assert.equal(registry.get("Nested").parentId, "Maker");
  assert.equal(registry.get("Other").parentId, "Main");
  // 부활 factory도 registry의 실제 parent를 본다(depth는 core patch의 revivedTaskDepth가 top-level에서 멈춘다).
  await lifecycle.ensureLive("Maker").catch(() => {});
  await lifecycle.ensureLive("Nested").catch(() => {});
  assert.deepEqual(seen, [["Maker", "Main#2"], ["Nested", "Maker"]]);
  assert.equal(registry.get("Maker").parentId, "Main#2");
});

test("after the owning root is unregistered its restored children are no longer revivable by another root", async () => {
  const { B, registry, lifecycle } = twoRoots();
  await ensurePersistedRoster(registry, B);
  const lateFactory = async () => async () => ({ dispose: async () => {} });
  const drop = registerRootReviver(B, "Main#3", lateFactory, () => 0, { registry, lifecycle });
  drop();
  await assert.rejects(() => lifecycle.ensureLive("Maker"), /no reviver registered/);
});

test("a revived child's reply to Main reaches its own root, and the factory copy never changes the registry parent", async () => {
  const { A, B, registry, bus, delivered } = twoRoots();
  const inbox = { Main: [], "Main#3": [] };
  for (const [id, file] of [["Main", A], ["Main#3", B]]) {
    registry.attachSession(id, { deliverIrcMessage: async (m) => { inbox[id].push(m.from); return "injected"; }, dispose: async () => {} }, file);
  }
  await ensurePersistedRoster(registry, A);
  await ensurePersistedRoster(registry, B);
  assert.equal((await bus.send({ from: "Main#3", to: "Maker", body: "이어서" })).outcome, "revived");
  assert.equal(registry.get("Maker").parentId, "Main#3");
  assert.equal(registry.get("Maker").status, "idle");
  // 부활한 Maker가 약속된 이름 `Main`으로 결과를 보내면 자기 root의 Main#3이 받는다.
  assert.equal((await bus.send({ from: "Maker", to: "Main", body: "결과" })).outcome, "injected");
  assert.deepEqual(inbox, { Main: [], "Main#3": ["Maker"] });
  // 다른 root의 child는 같은 이름으로 보내도 자기 Main으로만 간다.
  assert.equal((await bus.send({ from: "Main", to: "ChildA", body: "이어서" })).outcome, "revived");
  assert.equal((await bus.send({ from: "ChildA", to: "Main", body: "결과" })).outcome, "injected");
  assert.deepEqual(inbox, { Main: ["ChildA"], "Main#3": ["Maker"] });
  assert.deepEqual(delivered.map(([id]) => id), ["Maker", "ChildA"]);
});
