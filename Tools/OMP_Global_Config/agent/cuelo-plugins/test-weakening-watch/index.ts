import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { SECRET_PATTERN } from "../../extensions/lib/interpreter";
import { createQuietDelivery } from "../../extensions/lib/quiet-delivery";
import { onSessionLifecycle } from "../../extensions/lib/session-identity";
import { detectTestWeakening, TEST_PATHSPECS, type Finding } from "./detector";

const ID = "test-weakening-watch";
const EVENTS_FILE = `cuelo-${ID}-events.jsonl`;
const ADVICE = "Confirm each change is intended by the user's request before accepting; ask the Maker to justify it or restore the test.";
const GIT = promisify(execFile);

async function snapshot(cwd: string): Promise<Finding[]> {
  try {
    const { stdout } = await GIT("git", [
      "--no-optional-locks", "diff", "--no-relative", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames",
      "--src-prefix=a/", "--dst-prefix=b/", "--unified=0", "HEAD", "--", ...TEST_PATHSPECS,
    ], { cwd, timeout: 1500, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return detectTestWeakening(stdout);
  } catch {
    return [];
  }
}

function safePath(path: string): string {
  if (SECRET_PATTERN.test(path) || SECRET_PATTERN.test(path.replace(/[/_.-]/g, " "))) return "[redacted test path]";
  return path.replace(/[\p{Cc}\p{Cf}]/gu, "?");
}

function describeFinding(finding: Finding): string {
  const { assertionsRemoved, testsRemoved, skipMarkersAdded, expectedValuesChanged } = finding.counts;
  const counts = [finding.deleted && "file deleted", assertionsRemoved && `${assertionsRemoved} assertion(s) removed`, testsRemoved && `${testsRemoved} test case(s) removed`, skipMarkersAdded && `${skipMarkersAdded} skip/only/todo added`, expectedValuesChanged && `${expectedValuesChanged} expected literal(s) changed`].filter(Boolean);
  const path = safePath(finding.path);
  return `${path.length > 90 ? `…${path.slice(-89)}` : path}: ${counts.join(", ")}`;
}

function fitRows(rows: string[], budget: number): { text: string; used: number } {
  let text = "";
  for (const [index, row] of rows.entries()) {
    const remaining = rows.length - index - 1;
    const next = text ? `${text}; ${row}` : row;
    if (`${next}${remaining ? `; +${remaining} more` : ""}`.length > budget) {
      const more = `+${remaining + 1} more`;
      return { text: text ? `${text}; ${more}` : more, used: index };
    }
    text = next;
  }
  return { text, used: rows.length };
}

function render(kind: "task" | "git_finalize", findings: Finding[], fresh: Finding[]) {
  const lead = `[${ID}] ${kind}: ${findings.length} test file(s) with possible weakening. `;
  const budget = 600 - lead.length - ADVICE.length - 1;
  if (kind === "task") {
    const rows = findings.map((finding) => `${describeFinding(finding)}${finding.excerpts.length ? ` (${finding.excerpts.join(", ")})` : ""}`);
    const { text, used } = fitRows(rows, budget);
    return { text: `${lead}${text}\n${ADVICE}`, detailed: findings.slice(0, used) };
  }
  const withExcerpts = fresh.filter(({ excerpts }) => excerpts.length > 0);
  const rows = findings.map(describeFinding);
  const summary = fitRows(rows, withExcerpts.length ? budget - 175 : budget);
  const details = fitRows(withExcerpts.map((finding) => `${safePath(finding.path).slice(-45)} (${finding.excerpts.join(", ")})`), budget - summary.text.length - 1);
  return {
    text: `${lead}${summary.text}${details.text ? `\n${details.text}` : ""}\n${ADVICE}`,
    detailed: [...withExcerpts.slice(0, details.used), ...findings.slice(0, summary.used).filter(({ excerpts }) => excerpts.length === 0)],
  };
}

function hasSettledTask(details: unknown): boolean {
  const jobs = (details as { jobs?: unknown } | undefined)?.jobs;
  return Array.isArray(jobs) && jobs.some((job) => job?.type === "task"
    && (job.status === "completed" || job.status === "failed" || job.status === "cancelled"));
}

export function createTestWeakeningWatch(options: { eventsPath?: string } = {}) {
  return function testWeakeningWatch(pi: ExtensionAPI): void {
    const eventsPath = options.eventsPath ?? process.env.CUELO_TEST_WEAKENING_WATCH_EVENTS_PATH ?? join(import.meta.dir, "..", "..", EVENTS_FILE);
    const sendQuietly = createQuietDelivery(pi);
    const makeState = () => ({ shown: new Set<string>(), pending: new Map<string, Finding[]>() });
    let state = makeState();
    const reset = () => { state = makeState(); };
    onSessionLifecycle(pi, { start: reset });
    pi.on("session_shutdown", reset);
    pi.on("agent_end", (event) => { if (!event.willContinue) state.pending.clear(); });

    const advice = (kind: "task" | "git_finalize", findings: Finding[], ctx: ExtensionContext): string | undefined => {
      const fresh = findings.filter(({ key }) => !state.shown.has(key));
      const visible = kind === "task" ? fresh : findings;
      if (visible.length === 0) return;
      const { text, detailed } = render(kind, visible, fresh);
      for (const { key } of detailed) state.shown.add(key);
      const logged = kind === "task" ? detailed : visible;
      try {
        appendFileSync(eventsPath, `${JSON.stringify({ ts: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId(), main: true, kind, findings: logged.map(({ path, deleted, counts, excerpts }) => ({ path: safePath(path), deleted, counts, excerpts })) })}\n`, { mode: 0o600 });
      } catch {
        // Telemetry must not affect the underlying tool or suppress its advice.
      }
      return text;
    };

    pi.on("tool_call", async (event, ctx) => {
      if (ctx.agent?.kind === "sub" || event.toolName !== "git_finalize") return;
      const active = state;
      // git_finalize can commit the changes before tool_result. Snapshot now; attach even on a reported tool error.
      const findings = await snapshot(ctx.cwd);
      if (active === state && findings.length > 0) active.pending.set(event.toolCallId, findings);
    });

    pi.on("tool_result", async (event, ctx) => {
      if (ctx.agent?.kind === "sub") return;
      let text: string | undefined;
      if (event.toolName === "git_finalize") {
        const findings = state.pending.get(event.toolCallId);
        state.pending.delete(event.toolCallId);
        if (findings) text = advice("git_finalize", findings, ctx);
      } else if (event.toolName === "task" || event.toolName === "wait") {
        if (event.toolName === "task") {
          const results = (event.details as { results?: unknown } | undefined)?.results;
          // An async spawn receipt carries no completed SingleResults.
          if (!Array.isArray(results) || !results.some((result) => typeof result?.id === "string" && result.id)) return;
        } else if (!hasSettledTask(event.details)) {
          // A wait that consumes a completed job can suppress its async-result message.
          return;
        }
        const active = state;
        const findings = await snapshot(ctx.cwd);
        if (active === state) text = advice("task", findings, ctx);
      }
      if (text) return { additionalContext: text };
    });

    pi.on("message_start", async (event, ctx) => {
      if (ctx.agent?.kind === "sub") return;
      const message = event.message as { role?: string; customType?: string; details?: unknown };
      if (message.role !== "custom" || message.customType !== "async-result" || !hasSettledTask(message.details)) return;
      const active = state;
      const findings = await snapshot(ctx.cwd);
      if (active !== state) return;
      const text = advice("task", findings, ctx);
      if (text) sendQuietly({ customType: ID, content: text, display: false, attribution: "agent" }, ctx);
    });
  };
}

export default createTestWeakeningWatch();
