import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { parse as parseYaml } from "yaml";
import { GET, PUT } from "./route";

// The route reads and writes whatever getAgentDir() returns; keep the user's real models.yml out of reach.
const agentDir = mkdtempSync(join(tmpdir(), "cuelo-models-config-"));
const modelsPath = join(agentDir, "models.yml");
const previousAgentDir = getAgentDir();
beforeAll(() => setAgentDir(agentDir));
afterAll(() => {
  setAgentDir(previousAgentDir);
  rmSync(agentDir, { recursive: true, force: true });
});

// A real profile's shape: override-only OAuth providers next to a custom provider whose key is a command.
const PROFILE = `# written by the user
providers:
  anthropic:
    modelOverrides:
      claude-opus-5-5:
        contextWindow: 500000
  openai-codex:
    modelOverrides:
      gpt-6-astra:
        contextWindow: 500000
  hive:
    baseUrl: https://example.invalid/v1
    api: openai-completions
    apiKey: '!cat "$HOME/.omp/agent/hive-api-key"'
    models:
      - id: deepseek-x
        name: DeepSeek X
        reasoning: true
        contextWindow: 128000
`;

type ModelsBody = { providers: Record<string, { models?: { id: string; name?: string }[] } & Record<string, unknown>>; error?: string };

function request(method: string, body?: unknown): Request {
  return new Request("http://127.0.0.1:30141/api/models-config", {
    method,
    headers: { host: "127.0.0.1:30141", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function load(): Promise<{ status: number; body: ModelsBody }> {
  const response = await GET(request("GET"));
  return { status: response.status, body: await response.json() as ModelsBody };
}

async function save(config: unknown): Promise<{ status: number; body: { success?: boolean; error?: string } }> {
  const response = await PUT(request("PUT", config));
  return { status: response.status, body: await response.json() };
}

// What omp itself makes of the file on disk; a path other than the default gets a fresh, uncached loader.
function coreLoadStatus(): string {
  return ModelsConfigFile.relocate(modelsPath).tryLoad().status;
}

test("saving the loaded config unchanged keeps every provider and model definition", async () => {
  writeFileSync(modelsPath, PROFILE);
  const { status, body } = await load();
  expect(status).toBe(200);

  expect((await save(body)).status).toBe(200);
  expect(parseYaml(readFileSync(modelsPath, "utf8"))).toEqual(parseYaml(PROFILE));
  expect(coreLoadStatus()).toBe("ok");
});

test("a blank model row is dropped while a new valid row round-trips", async () => {
  writeFileSync(modelsPath, PROFILE);
  const { body } = await load();
  body.providers["openai-codex"].models = [{ id: "" }];
  body.providers.hive.models!.push({ id: "deepseek-y", name: "DeepSeek Y" });

  expect((await save(body)).status).toBe(200);
  expect(coreLoadStatus()).toBe("ok");
  const reloaded = (await load()).body;
  expect(reloaded.providers["openai-codex"].models ?? []).toEqual([]);
  expect(reloaded.providers["openai-codex"].modelOverrides).toEqual({ "gpt-6-astra": { contextWindow: 500000 } });
  expect(reloaded.providers.hive.models!.map((model) => model.id)).toEqual(["deepseek-x", "deepseek-y"]);
});

// Each draft makes omp reject the whole file, which would drop every provider and override at runtime.
for (const [label, provider, edit] of [
  ["an empty custom provider draft", "new-provider", (config: ModelsBody) => {
    config.providers["new-provider"] = { api: "openai-completions" };
  }],
  ["a model added to a provider without a baseUrl", "openai-codex", (config: ModelsBody) => {
    config.providers["openai-codex"].models = [{ id: "gpt-x" }];
  }],
] as const) {
  test(`${label} is refused and models.yml keeps its bytes`, async () => {
    writeFileSync(modelsPath, PROFILE);
    const { body } = await load();
    edit(body);

    const { status, body: result } = await save(body);
    expect(status).toBe(400);
    expect(result.error).toContain(`Provider ${provider}`);
    expect(readFileSync(modelsPath, "utf8")).toBe(PROFILE);
    expect(readdirSync(agentDir)).toEqual(["models.yml"]);
  });
}

test("an unparseable models.yml is reported instead of loading as an empty config", async () => {
  const broken = `providers:\n  hive:\n    apiKey: "sk-not-a-real-key\n    models: [\n`;
  writeFileSync(modelsPath, broken);

  const { status, body } = await load();
  expect(status).toBe(500);
  expect(body.error).toContain("models.yml");
  expect(body.providers).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("sk-not-a-real-key");
  expect(readFileSync(modelsPath, "utf8")).toBe(broken);
});

test("a models.yml that cannot be read is reported instead of loading as an empty config", async () => {
  // A regular file where the agent folder should be: the read fails with ENOTDIR, not ENOENT.
  const blocked = join(agentDir, "blocked");
  writeFileSync(blocked, "");
  setAgentDir(blocked);
  try {
    const { status, body } = await load();
    expect(status).toBe(500);
    expect(body.providers).toBeUndefined();
  } finally {
    setAgentDir(agentDir);
    rmSync(blocked);
  }
});

test("a missing or empty models.yml still loads as an empty config", async () => {
  rmSync(modelsPath, { force: true });
  expect(await load()).toEqual({ status: 200, body: { providers: {} } });

  writeFileSync(modelsPath, "");
  expect(await load()).toEqual({ status: 200, body: { providers: {} } });
});

// omp fixes its models.yml location when it loads and keeps one parsed copy per process, so this runs in a
// child with its own agent dir and HOME: a server whose runtime already read models.yml, then saves.
test("a saved provider and model reach the rebuilt runtime without a restart", () => {
  const home = mkdtempSync(join(tmpdir(), "cuelo-models-runtime-"));
  const childAgentDir = join(home, ".omp", "agent");
  mkdirSync(childAgentDir, { recursive: true });
  const hive = { baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKey: "test-not-a-real-key" };
  writeFileSync(join(childAgentDir, "models.yml"), `providers:\n  hive:\n    baseUrl: ${hive.baseUrl}\n    api: ${hive.api}\n    apiKey: ${hive.apiKey}\n    models:\n      - id: deepseek-x\n`);
  const saved = {
    providers: {
      hive: { ...hive, models: [{ id: "deepseek-x" }, { id: "deepseek-y" }] },
      "progress-fixture": { ...hive, models: [{ id: "fixture-model", name: "Progress fixture" }] },
    },
  };
  const script = `
    (async () => {
      const { getOmpRuntime } = await import(${JSON.stringify(join(import.meta.dir, "..", "..", "..", "lib", "omp-runtime.ts"))});
      const { PUT } = await import(${JSON.stringify(join(import.meta.dir, "route.ts"))});
      await getOmpRuntime();
      const response = await PUT(new Request("http://127.0.0.1:30141/api/models-config", {
        method: "PUT",
        headers: { host: "127.0.0.1:30141", "content-type": "application/json" },
        body: ${JSON.stringify(JSON.stringify(saved))},
      }));
      const { modelRegistry } = await getOmpRuntime();
      const outcome = {
        status: response.status,
        newProvider: modelRegistry.find("progress-fixture", "fixture-model")?.id ?? null,
        newModel: modelRegistry.find("hive", "deepseek-y")?.id ?? null,
      };
      process.stdout.write("\\n" + JSON.stringify(outcome) + "\\n", () => process.exit(0));
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: join(import.meta.dir, "..", "..", ".."),
      env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "test", PI_CODING_AGENT_DIR: childAgentDir, PI_TEST_RUNTIME: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect({ exit: result.status, stderr: result.status === 0 ? "" : result.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({ status: 200, newProvider: "fixture-model", newModel: "deepseek-y" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
