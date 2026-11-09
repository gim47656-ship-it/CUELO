import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgComputerBackgroundFallback } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { ComputerTakeoverError } from "./computer-takeover";
import { AgentSessionWrapper } from "./rpc-manager";

/**
 * `runtime` stands for the server's shared Settings (cwd = server cwd). Like lib/omp-runtime.ts
 * `getSettingsForCwd`, a session in another cwd gets its own `cloneForCwd` copy and a session in the
 * runtime cwd gets the shared instance itself. The persisted global config says `refuse`, as the live
 * profile does.
 */
let root = "";
let agentDir = "";
let configPath = "";
let serverCwd = "";
let runtime: Settings;

const sessionSettings = (cwd: string) => (cwd === serverCwd ? runtime : runtime.cloneForCwd(cwd));

function wrapperFor(settings: Settings, shared = false) {
  const inner = { sessionId: "s", settings, isBashRunning: false, dispose() {} };
  const wrapper = new AgentSessionWrapper(inner as never, { on: () => () => {} } as never);
  wrapper.sharesRuntimeSettings = shared;
  return wrapper;
}

const fallback = (settings: Settings) => cfgComputerBackgroundFallback.get(settings);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cuelo-takeover-"));
  agentDir = join(root, "agent");
  serverCwd = join(root, "server");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(serverCwd, { recursive: true });
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "b"));
  configPath = join(agentDir, "config.yml");
  writeFileSync(configPath, "computer:\n  backgroundFallback: refuse\n");
  runtime = await Settings.loadReadOnly({ cwd: serverCwd, agentDir });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the configured refuse is what every session starts from", async () => {
  expect(fallback(runtime)).toBe("refuse");
  expect(fallback(await sessionSettings(join(root, "a")))).toBe("refuse");
});

test("allowing one session switches only that session to takeover, and off restores refuse", async () => {
  const mine = await sessionSettings(join(root, "a"));
  const sameCwd = await sessionSettings(join(root, "a"));
  const otherCwd = await sessionSettings(join(root, "b"));
  const wrapper = wrapperFor(mine);

  expect(wrapper.computerTakeover()).toEqual({ enabled: false, configured: "refuse", available: true });
  expect(wrapper.setComputerTakeover(true)).toEqual({ enabled: true, configured: "refuse", available: false });

  expect(fallback(mine)).toBe("takeover");
  expect(fallback(sameCwd)).toBe("refuse");
  expect(fallback(otherCwd)).toBe("refuse");
  expect(fallback(runtime)).toBe("refuse");
  // A session created while this one is on also starts from refuse.
  expect(fallback(await sessionSettings(join(root, "a")))).toBe("refuse");

  expect(wrapper.setComputerTakeover(false)).toEqual({ enabled: false, configured: "refuse", available: true });
  expect(fallback(mine)).toBe("refuse");
});

test("on and off are idempotent and never touch config.yml", () => {
  const before = readFileSync(configPath);
  const wrapper = wrapperFor(runtime.overlay({}));
  wrapper.setComputerTakeover(false);
  wrapper.setComputerTakeover(true);
  expect(wrapper.setComputerTakeover(true).enabled).toBe(true);
  wrapper.setComputerTakeover(false);
  expect(wrapper.setComputerTakeover(false).enabled).toBe(false);
  expect(readFileSync(configPath).equals(before)).toBe(true);
});

test("a session that shares the runtime Settings is refused and the shared instance stays on refuse", () => {
  const wrapper = wrapperFor(runtime, true);
  expect(wrapper.computerTakeover()).toEqual({ enabled: false, configured: "refuse", available: false });
  expect(() => wrapper.setComputerTakeover(true)).toThrow(ComputerTakeoverError);
  expect(fallback(runtime)).toBe("refuse");
  expect(wrapper.setComputerTakeover(false).enabled).toBe(false);
});

test("when the configuration already allows takeover there is nothing to switch and the control is not offered", async () => {
  writeFileSync(configPath, "computer:\n  backgroundFallback: takeover\n");
  const settings = await Settings.loadReadOnly({ cwd: join(root, "a"), agentDir });
  const wrapper = wrapperFor(settings);
  expect(wrapper.computerTakeover()).toEqual({ enabled: false, configured: "takeover", available: false });
  expect(() => wrapper.setComputerTakeover(true)).toThrow("already allowed");
  expect(fallback(settings)).toBe("takeover");
});

test("destroying the wrapper returns its settings to refuse and a new wrapper for the same project starts from refuse", async () => {
  const cwd = join(root, "a");
  const first = await sessionSettings(cwd);
  const wrapper = wrapperFor(first);
  wrapper.setComputerTakeover(true);
  wrapper.destroy();
  expect(fallback(first)).toBe("refuse");

  const restarted = await sessionSettings(cwd);
  const second = wrapperFor(restarted);
  expect(second.computerTakeover()?.enabled).toBe(false);
  expect(fallback(restarted)).toBe("refuse");
  expect(() => wrapper.setComputerTakeover(true)).toThrow("not running");
});

test("get_state reports the takeover state so a refreshed page shows it", async () => {
  const settings = await sessionSettings(join(root, "a"));
  const inner = {
    sessionId: "s",
    sessionFile: "/tmp/x.jsonl",
    settings,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    isFastModeEnabled: () => false,
    isFastModeActive: () => false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    agent: { state: {} },
    configuredThinkingLevel: () => "off",
    queuedMessageCount: 0,
    getContextUsage: () => undefined,
    getQueuedMessages: () => ({ steering: [], followUp: [] }),
    getTodoPhases: () => [],
  };
  const wrapper = new AgentSessionWrapper(inner as never, { on: () => () => {} } as never);
  const read = async () => {
    const state: { computerTakeover: unknown } = await wrapper.send({ type: "get_state" }) as { computerTakeover: unknown };
    return state.computerTakeover;
  };
  expect(await read()).toEqual({ enabled: false, configured: "refuse", available: true });
  wrapper.setComputerTakeover(true);
  expect(await read()).toEqual({ enabled: true, configured: "refuse", available: false });
});
