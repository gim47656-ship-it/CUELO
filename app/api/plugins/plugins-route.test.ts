import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { getPluginsDir } from "@oh-my-pi/pi-utils";
import { POST } from "./route";

// Every PluginManager method that could write the shared plugin tree or read
// the real profile is stubbed; no package is resolved, installed, or run.
const project = realpathSync(mkdtempSync(join(tmpdir(), "cuelo-plugins-route-")));
const plugin = {
  name: "cuelo-route-fixture-plugin",
  version: "1.0.0",
  enabled: true,
  enabledFeatures: null,
  path: join(getPluginsDir(), "node_modules", "cuelo-route-fixture-plugin"),
  manifest: { name: "cuelo-route-fixture-plugin", version: "1.0.0" },
};
const install = spyOn(PluginManager.prototype, "install").mockResolvedValue(plugin as never);
const list = spyOn(PluginManager.prototype, "list").mockResolvedValue([plugin] as never);
const doctor = spyOn(PluginManager.prototype, "doctor").mockResolvedValue([]);

const previousRootsCache = globalThis.__ompAllowedRootsCache;
globalThis.__ompAllowedRootsCache = {
  roots: new Set([project.replace(/\\/g, "/")]),
  expiresAt: Number.MAX_SAFE_INTEGER,
};

beforeEach(() => {
  install.mockClear();
  install.mockResolvedValue(plugin as never);
  list.mockClear();
});

afterAll(() => {
  install.mockRestore();
  list.mockRestore();
  doctor.mockRestore();
  globalThis.__ompAllowedRootsCache = previousRootsCache;
  rmSync(project, { recursive: true, force: true });
});

async function postInstall(extra: Record<string, unknown>) {
  const response = await POST(new Request("http://localhost/api/plugins", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ action: "install", source: plugin.name, cwd: project, ...extra }),
  }));
  return { status: response.status, body: await response.json() };
}

for (const [label, extra] of [["omitted scope", {}], ["global scope", { scope: "global" }]] as const) {
  test(`${label} installs into the SDK's global plugin tree and reports it`, async () => {
    const { status, body } = await postInstall(extra);
    expect(status).toBe(200);
    expect(install.mock.calls).toEqual([[plugin.name]]);
    expect(body.packages.map((pkg: { scope: string }) => pkg.scope)).toEqual(["global"]);
    expect(body.installDir).toBe(getPluginsDir());
  });
}

for (const scope of ["project", "unknown-scope", null, 1]) {
  test(`rejects install scope ${JSON.stringify(scope)} before the manager is touched`, async () => {
    const { status, body } = await postInstall({ scope });
    expect(status).toBe(400);
    expect(body.error).toContain("Unsupported plugin install scope");
    expect(body.error).toContain(getPluginsDir());
    expect(body.packages).toBeUndefined();
    expect(install).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
}

test("a failed global install is reported as an error, not a refreshed list", async () => {
  install.mockRejectedValue(new Error("bun install exited with code 1"));
  const { status, body } = await postInstall({ scope: "global" });
  expect(status).toBe(500);
  expect(body).toEqual({ error: "bun install exited with code 1" });
  expect(list).not.toHaveBeenCalled();
});
