import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { GET, PATCH } from "../app/api/attachment-settings/route";
import { attachmentUploadLimitBytes, normalizeAttachmentSettings, parseAttachmentSettingsPatch } from "./attachment-settings";
import { ATTACHMENT_SETTINGS_FILE_NAME, readAttachmentSettings } from "./attachment-store";

// Keep the user's real agent folder out of reach: the routes read whatever getAgentDir() returns.
const agentDir = mkdtempSync(join(tmpdir(), "cuelo-attachment-settings-"));
const previousAgentDir = getAgentDir();
beforeAll(() => setAgentDir(agentDir));
afterAll(() => {
  setAgentDir(previousAgentDir);
  rmSync(agentDir, { recursive: true, force: true });
});

function request(method: string, body?: unknown): Request {
  return new Request("http://127.0.0.1:30141/api/attachment-settings", {
    method,
    headers: { host: "127.0.0.1:30141", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("defaults to a 100 MB limit with cleanup on and a fixed seven-day grace", async () => {
  const response = await GET(request("GET"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ uploadLimitMb: 100, autoCleanupEnabled: true, orphanGraceDays: 7 });
  expect(attachmentUploadLimitBytes({ uploadLimitMb: 100 })).toBe(100 * 1024 * 1024);
});

test("PATCH saves the limit and the switch, and GET and the upload path read them back", async () => {
  const saved = await PATCH(request("PATCH", { uploadLimitMb: 250, autoCleanupEnabled: false, orphanGraceDays: 7 }));
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ uploadLimitMb: 250, autoCleanupEnabled: false, orphanGraceDays: 7 });
  expect(await (await GET(request("GET"))).json()).toEqual({ uploadLimitMb: 250, autoCleanupEnabled: false, orphanGraceDays: 7 });
  expect(await readAttachmentSettings(agentDir)).toEqual({ uploadLimitMb: 250, autoCleanupEnabled: false, orphanGraceDays: 7 });

  // A partial patch keeps the other field.
  await PATCH(request("PATCH", { autoCleanupEnabled: true }));
  expect(JSON.parse(readFileSync(join(agentDir, ATTACHMENT_SETTINGS_FILE_NAME), "utf8"))).toEqual({ uploadLimitMb: 250, autoCleanupEnabled: true });
});

test("PATCH rejects anything but a positive whole MB count, a boolean switch, and the fixed grace", async () => {
  for (const body of [{ uploadLimitMb: 0 }, { uploadLimitMb: 1.5 }, { uploadLimitMb: "100" }, { uploadLimitMb: Number.MAX_SAFE_INTEGER }, { autoCleanupEnabled: "yes" }, { orphanGraceDays: 3 }, { other: 1 }, [1]]) {
    expect((await PATCH(request("PATCH", body))).status).toBe(400);
  }
  expect(parseAttachmentSettingsPatch({ uploadLimitMb: 1 })).toEqual({ ok: true, patch: { uploadLimitMb: 1 } });
  const notJson = new Request("http://127.0.0.1:30141/api/attachment-settings", { method: "PATCH", headers: { host: "127.0.0.1:30141" }, body: "x" });
  expect((await PATCH(notJson)).status).toBe(415);
  const crossSite = new Request("http://127.0.0.1:30141/api/attachment-settings", { headers: { host: "127.0.0.1:30141", "sec-fetch-site": "cross-site" } });
  expect((await GET(crossSite)).status).toBe(403);
});

test("a damaged settings file keeps the default limit but switches cleanup off", async () => {
  writeFileSync(join(agentDir, ATTACHMENT_SETTINGS_FILE_NAME), "{ not json");
  expect(await readAttachmentSettings(agentDir)).toEqual({ uploadLimitMb: 100, autoCleanupEnabled: false, orphanGraceDays: 7 });
  expect(normalizeAttachmentSettings({ uploadLimitMb: -1, autoCleanupEnabled: 1 })).toEqual({ uploadLimitMb: 100, autoCleanupEnabled: true, orphanGraceDays: 7 });
});
