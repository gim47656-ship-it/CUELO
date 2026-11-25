import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getUpdateMutationBlock } from "@/lib/update-maintenance";
import { AntigravityError, object } from "./acp";
import { activeAntigravity, problem } from "./sessions";

export function json(data: object, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function browserGuard(req: Request): Response | undefined {
  // Fetch Metadata cannot be set by browser page scripts. The composer also
  // requires a trusted input event; there is no headless/tool transport.
  if (req.headers.get("sec-fetch-site") !== "same-origin" || !isApiRequestAllowed(req)
    || (req.method === "POST" && !req.headers.has("origin"))) {
    return json({ code: "bad_request", error: "Untrusted Antigravity request." }, 403);
  }
  if (req.method === "POST" && !hasJsonContentType(req)) return json({ code: "bad_request", error: "Content-Type must be application/json." }, 415);
}

export function checkMaintenance() {
  if (getUpdateMutationBlock()) throw new AntigravityError("update_draining", "CUELO is updating.");
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return object(await req.json());
  } catch {
    throw new AntigravityError("bad_request", "Malformed JSON body.");
  }
}

export async function checkedCwd(input: unknown): Promise<string> {
  if (typeof input !== "string" || !isAbsolute(input) || input.length > 4096) {
    throw new AntigravityError("bad_request", "A project directory is required.");
  }
  try {
    const cwd = await realpath(input);
    if ((await stat(cwd)).isDirectory() && isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) return cwd;
  } catch {
    // Existence and access failures are intentionally reported alike.
  }
  throw new AntigravityError("bad_request", "Project directory is unavailable.");
}

export function checkedId(id: unknown): string {
  if (typeof id !== "string" || !id || id.length > 256 || /[\r\n\u0000]/.test(id)) {
    throw new AntigravityError("bad_request", "A valid Antigravity conversation ID is required.");
  }
  return id;
}

export async function activeFromRequest(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = await checkedCwd(searchParams.get("cwd"));
  const session = activeAntigravity(cwd, checkedId(searchParams.get("sessionId")));
  if (!session) throw new AntigravityError("disconnected", "Antigravity connection closed.");
  return session;
}

export function antigravityErrorResponse(error: unknown) {
  const issue = problem(error);
  const status = issue.code === "bad_request" ? 400 : issue.code === "auth_required" ? 401
    : issue.code === "disconnected" || issue.code === "model_required" ? 409 : 503;
  return json(issue, status);
}
