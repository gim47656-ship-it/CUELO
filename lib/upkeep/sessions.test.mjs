import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessions } from "./sessions.ts";

const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");

test("Maker results in batched notices, previews and wait snapshots are all counted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-delivery-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const result = (id, duration, status, body = "output") =>
      `<task-result id="${id}" agent="maker" status="completed" duration="${duration}">\n${body === "preview" ? `<meta lines="55" size="5.3KB" />\n<preview full-output="agent://${id}">` : "\n<output>"}\n{\n  "status": "${status}",\n  "summary": "x"\n}\n</${body}>\n</task-result>`;
    const batched = {
      type: "custom_message", id: "n1", customType: "async-result", timestamp,
      content: `<system-notice>\n── Job Display (Display) ──\n${result("Display", "19m30s", "completed")}\n── Job Aux (Aux) ──\n${result("Aux", "19m59s", "partial", "preview")}\n</system-notice>`,
    };
    const snapshot = (id, name, text) => ({
      type: "message", id, timestamp, message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }] },
    });
    const recovered = (id, duration, status) =>
      `### ${id} [task] — completed\nLabel: ${id}\nDelivery: not auto-delivered; recovered by this snapshot.\n\`\`\`\n${result(id, duration, status)}\n\`\`\``;
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp },
      batched,
      snapshot("w1", "wait", `## Completed (1)\n\n${recovered("Audit", "10m40s", "partial")}`),
      snapshot("h1", "hub", `## Completed (1)\n\n${recovered("Quote", "45s", "completed")}`),
      // 이미 받은 결과를 다시 읽은 출력은 도착이 아니다.
      snapshot("r1", "read", result("Display", "19m30s", "partial")),
    ]));
    const { makerResults } = await scanSessions(dir, now);
    assert.deepEqual(makerResults.map((r) => [r.name, r.durationSec, r.partial]), [
      ["Display", 1170, false], ["Aux", 1199, true], ["Audit", 640, true], ["Quote", 45, false],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
