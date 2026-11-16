import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.CUELO_EXTERNAL_POSTING_CHILD === "1") {
  // Load server modules only in the child after HOME and the data repository have been isolated.
  const { parseRoutineInput, readRoutine, writeRoutineFile } = await import("./store");
  const { commitRoutineChange } = await import("./git-sync");
  const { PATCH, PUT } = await import("../../app/api/routines/[id]/route");
  const { GET } = await import("../../app/api/routines/route");
  const dir = process.env.CUELO_ROUTINES_DIR!;
  const original = { id: "external-feed", name: "External feed", enabled: false,
    externalPostingEnabled: true, schedule: { kind: "hourly" as const, everyHours: 1, minute: 0 },
    timezone: "Asia/Seoul", host: "phone", prompt: "Keep collection separate", cwd: null,
    createdAt: "2026-11-16T00:00:00.000Z", updatedAt: "2026-11-16T00:00:00.000Z" };
  const call = (method: "PATCH" | "PUT", body: unknown) => (method === "PATCH" ? PATCH : PUT)(new Request("http://localhost/api/routines/external-feed", {
    method, headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: original.id }) });

  test("external reception survives saving and toggles independently of scheduled execution", async () => {
    await commitRoutineChange(dir, "fixture", () => ({ paths: [writeRoutineFile(dir, original)], result: undefined }));
    expect((await call("PATCH", { externalPostingEnabled: false })).status).toBe(200);
    expect(readRoutine(dir, original.id)).toMatchObject({ enabled: false, externalPostingEnabled: false });
    expect((await call("PATCH", { enabled: true })).status).toBe(200);
    expect(readRoutine(dir, original.id)).toMatchObject({ enabled: true, externalPostingEnabled: false });
    const legacyForm = { ...original, externalPostingEnabled: undefined };
    expect((await call("PUT", { ...legacyForm, name: "Renamed" })).status).toBe(200);
    expect(readRoutine(dir, original.id)).toMatchObject({ name: "Renamed", enabled: false, externalPostingEnabled: false });
    expect((await call("PATCH", { externalPostingEnabled: true })).status).toBe(200);
    expect(readRoutine(dir, original.id)).toMatchObject({ enabled: false, externalPostingEnabled: true });
    for (const value of [null, "false", 0, {}]) {
      expect((await call("PATCH", { externalPostingEnabled: value })).status).toBe(400);
      expect(parseRoutineInput({ ...original, externalPostingEnabled: value })).toHaveProperty("error");
    }
    expect((await call("PATCH", { enabled: true, externalPostingEnabled: false })).status).toBe(400);
    expect((await call("PATCH", null)).status).toBe(400);
    expect(readRoutine(dir, original.id)).toMatchObject({ enabled: false, externalPostingEnabled: true });
    const parsed = parseRoutineInput(legacyForm);
    expect(parsed).toHaveProperty("input");
    if ("input" in parsed) expect(Object.hasOwn(parsed.input, "externalPostingEnabled")).toBe(false);
    const response = await GET(new Request("http://localhost/api/routines", { headers: { host: "localhost", origin: "http://localhost" } }));
    expect((await response.json()).routines.find((item: { id: string }) => item.id === original.id)).toHaveProperty("externalPostingEnabled", true);
  }, 30000);
  test("invalid shared reception values remain visible and can be corrected", async () => {
    for (const value of ["true", null, []]) {
      await commitRoutineChange(dir, "invalid shared fixture", () => {
        const path = `routines/${original.id}/routine.json`;
        writeFileSync(join(dir, path), JSON.stringify({ ...original, externalPostingEnabled: value }));
        return { paths: [path], result: undefined };
      });
      expect(readRoutine(dir, original.id)).toMatchObject({ id: original.id, externalPostingEnabled: false });
      expect((await call("PATCH", { externalPostingEnabled: true })).status).toBe(200);
      expect(readRoutine(dir, original.id)).toHaveProperty("externalPostingEnabled", true);
    }
  }, 30000);
} else {
  test("external reception API contract in an isolated process and repository", () => {
    const root = mkdtempSync(join(tmpdir(), "routine-external-"));
    const dir = join(root, "repo");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", dir]);
      execFileSync("git", ["-C", dir, "config", "user.name", "fixture"]);
      execFileSync("git", ["-C", dir, "config", "user.email", "fixture@example.test"]);
      execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
      execFileSync(process.execPath, ["test", import.meta.filename], { cwd: process.cwd(), timeout: 60000, stdio: "inherit",
        env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), CUELO_ROUTINES_DIR: dir, CUELO_EXTERNAL_POSTING_CHILD: "1" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 65000);
}
