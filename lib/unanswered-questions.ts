import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { fieldContexts, fieldQuestions } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { spansText, type HtmlForm } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { maskSecrets } from "./upkeep/sessions";

export type UnansweredReason = "interrupted" | "cancelled" | "dismissed" | "session-closed" | "restart" | "timeout";
export type UnansweredQuestion = { id: string; sessionId: string; cwd: string; toolCallId: string; createdAt: number; reason: UnansweredReason; html: string; restrictTools?: readonly string[] };
const reasons: Record<UnansweredReason, true> = { interrupted: true, cancelled: true, dismissed: true, "session-closed": true, restart: true, timeout: true };
const fileName = "cuelo-unanswered-questions.json";
const lifetime = 30 * 86_400_000;
// Disk failure must not strand a dialog or make an admitted answer retryable. Flush on next access.
const pendingCleanup = new Map<string, Map<string, UnansweredReason | "answered">>();

// Rebuild from the visible form, never its source attributes, URLs, hidden fields, defaults or answers.
export function archiveFormHtml(form: HtmlForm): string {
  const text = (s: string) => Bun.escapeHTML(/\bdata:[^,\s]*,/i.test(s) ? "[media]" : maskSecrets(s));
  const questions = fieldQuestions(form);
  const contexts = fieldContexts(form);
  const rows: string[] = [];
  for (const field of form.fields) {
    if (!field.name) continue;
    const name = `q${rows.length + 1}`;
    const label = text(questions.get(field) || field.name);
    const context = text(contexts.get(field) ?? "");
    const options = field.kind === "choice" ? field.options.filter(o => !o.disabled).map(o => text(spansText(o.label))).filter(Boolean) : [];
    const choices = options.map((label, i) => `<label><input name="${name}" type="${field.kind === "choice" && field.multi ? "checkbox" : "radio"}" value="${i}">${label}</label>`).join("");
    const control = choices ? `<fieldset><legend>${label}</legend>${choices}</fieldset>` : `<label>${label}<textarea name="${name}"></textarea></label>`;
    rows.push((context ? `<p>${context}</p>` : "") + control);
  }
  return `<form>${rows.join("")}</form>`;
}

function valid(value: unknown): value is UnansweredQuestion {
  if (!value || typeof value !== "object") return false;
  const q = value as UnansweredQuestion;
  return [q.id, q.sessionId, q.toolCallId, q.cwd, q.html].every(v => typeof v === "string" && v.length > 0) && Number.isFinite(q.createdAt) && Object.hasOwn(reasons, q.reason)
    && (q.restrictTools === undefined || (Array.isArray(q.restrictTools) && q.restrictTools.every(name => typeof name === "string")));
}

// Like saved prompts, one synchronous read/modify/atomic replace in the local CUELO server.
export function updateUnansweredQuestions(change?: (items: UnansweredQuestion[]) => boolean, dir = getAgentDir(), now = Date.now()): UnansweredQuestion[] {
  const path = join(dir, fileName);
  let stored: UnansweredQuestion[] = [];
  let raw: string | undefined;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (raw !== undefined) {
    // Treat damaged rows as unavailable, not fatal to an active ask. Reads never overwrite an unreadable file.
    let data: { version?: number; questions?: unknown } | undefined;
    try { data = JSON.parse(raw); } catch { /* Next successful mutation starts a valid store. */ }
    if (data?.version === 1 && Array.isArray(data.questions)) stored = data.questions.filter(valid);
  }
  let items = stored.filter(q => q.createdAt > now - lifetime);
  const retry = pendingCleanup.get(dir);
  if (retry?.size) items = items.filter(q => {
    const reason = retry.get(q.id);
    if (reason === "answered") return false;
    if (reason) q.reason = reason;
    return true;
  });
  const changed = change?.(items);
  if (items.length > 200) items = items.sort((a, b) => a.createdAt - b.createdAt).slice(-200);
  if (changed || retry?.size || items.length !== stored.length) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, questions: items }));
    pendingCleanup.delete(dir);
  }
  return items;
}

export function finishArchivedQuestion(id: string, reason: UnansweredReason | "answered", dir: string, mustPersist = false): void {
  if (mustPersist) {
    updateUnansweredQuestions(items => {
      const index = items.findIndex(q => q.id === id);
      if (index < 0) return false;
      items.splice(index, 1);
      return true;
    }, dir);
    return;
  }
  const pending = pendingCleanup.get(dir) ?? new Map<string, UnansweredReason | "answered">();
  pending.set(id, reason);
  if (pending.size > 200) pending.delete(pending.keys().next().value!);
  pendingCleanup.set(dir, pending);
  try { updateUnansweredQuestions(undefined, dir); }
  catch { console.warn("[ask archive] Could not update storage; cleanup will retry on the next access."); }
}
