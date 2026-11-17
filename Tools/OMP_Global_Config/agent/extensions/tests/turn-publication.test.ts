import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnPublication } from "../lib/turn-publication";

test("empty publication ownership never adopts the following guard field", () => {
  const cwd = mkdtempSync(join(tmpdir(), "turn-publication-reader-"));
  try {
    for (const newline of ["\n", "\r\n"]) {
      const publication = createTurnPublication();
      publication.observe({ toolName: "task", input: { agent: "maker", task:
        ["TASK_GUARD:", "WORK_CLASS: maintenance", "OWNED_PATHS:   ", "FINDING_ID: F-empty", "", "Work."].join(newline) },
        details: { results: [{ index: 0, id: "maker-empty", exitCode: 0 }] },
      }, cwd);
      expect(publication.note(cwd)).toBeUndefined();
    }
    // A real owned scope is still tracked; no repository means publication stays unverified.
    const valid = createTurnPublication();
    valid.observe({ toolName: "task", input: { task: "TASK_GUARD:\nWORK_CLASS: maintenance\nOWNED_PATHS: src/\n\nWork." },
      details: { results: [{ index: 0, id: "maker-valid", exitCode: 0 }] },
    }, cwd);
    expect(valid.note(cwd)).toContain("maker-valid");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
