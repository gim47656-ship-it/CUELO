import { formAnswers, fieldQuestions } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { prepareAskForm, validateAskFormSubmission } from "@/lib/ask-form/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { finishArchivedQuestion, updateUnansweredQuestions, type UnansweredQuestion } from "@/lib/unanswered-questions";
import { getUpdateMutationBlock, UpdateTurnAdmissionError } from "@/lib/update-maintenance";

export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const available = (q: UnansweredQuestion) => !getRpcSession(q.sessionId)?.getPendingExtensionUiIds().includes(q.id);
const submitting = new Set<string>();

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return json({ error: "forbidden" }, 403);
  try {
    const items = updateUnansweredQuestions().filter(available);
    const id = new URL(req.url).searchParams.get("id");
    if (id !== null) {
      const q = items.find(q => q.id === id);
      return q ? json((await prepareAskForm(q.html, { cwd: q.cwd, omitMedia: true })).model) : json({ error: "gone" }, 404);
    }
    return json(items.sort((a, b) => b.createdAt - a.createdAt).map(({ html, restrictTools: _policy, ...q }) => ({ ...q, title: fieldQuestions(parseHtmlForm(html)).values().next().value ?? q.toolCallId })));
  } catch { return json({ error: "unavailable" }, 503); }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return json({ error: "forbidden" }, 403);
  if (!hasJsonContentType(req)) return json({ error: "json-required" }, 415);
  if (getUpdateMutationBlock()) return json({ error: "updating" }, 503);
  const input = await req.json().catch(() => null);
  if (!input || typeof input.id !== "string" || !["reply", "delete"].includes(input.action)) return json({ error: "invalid" }, 400);
  const id: string = input.id;
  if (submitting.has(id)) return json({ error: "busy" }, 409);
  submitting.add(id);
  try {
    const q = updateUnansweredQuestions().find(q => q.id === id && available(q));
    if (!q) return json({ error: "gone" }, 404);
    if (input.action === "reply") {
      const prepared = await prepareAskForm(q.html, { cwd: q.cwd, omitMedia: true });
      const checked = validateAskFormSubmission(prepared, input.data);
      if ("error" in checked) return json({ error: "invalid" }, 400);
      const answers = formAnswers(prepared.form, checked.data).filter(a => a.answer.trim());
      if (!answers.length) return json({ error: "empty-answer" }, 400);
      let session = getRpcSession(q.sessionId);
      if (!session?.isAlive()) {
        const path = await resolveSessionPath(q.sessionId);
        if (!path || readSessionHeader(path)?.id !== q.sessionId) return json({ error: "missing-session" }, 404);
        session = (await startRpcSession(q.sessionId, path, undefined, { requireExistingSession: true, restrictTools: q.restrictTools && [...q.restrictTools] })).session;
      }
      if (session.sessionId !== q.sessionId) return json({ error: "missing-session" }, 404);
      if (q.restrictTools && (q.restrictTools.length !== session.restrictTools?.length || q.restrictTools.some(n => !session.restrictTools?.includes(n)))) return json({ error: "policy-changed" }, 409);
      const identity = `Late answer to earlier question ${q.toolCallId} [${q.id}].`;
      const delivered = session.inner.sessionManager.getEntries().some(e => {
        if (e.type !== "message" || e.message.role !== "user") return false;
        const content = e.message.content;
        return typeof content === "string" ? content.startsWith(identity) : content.some(b => b.type === "text" && b.text.startsWith(identity));
      });
      if (!delivered) await session.admitQuestionAnswer(identity + " This is not approval unless the user explicitly grants it. Circumstances may have changed; re-check current state before acting.\n" + JSON.stringify(answers.map(({ question, answer }) => ({ question, answer }))));
    }
    finishArchivedQuestion(q.id, "answered", getAgentDir(), input.action === "delete");
    return json({ ok: true });
  } catch (error) { return json({ error: error instanceof UpdateTurnAdmissionError ? "updating" : "unavailable" }, 503); }
  finally { submitting.delete(id); }
}
