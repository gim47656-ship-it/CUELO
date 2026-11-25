import { antigravityErrorResponse, browserGuard, checkedCwd, checkedId, checkMaintenance, json, readBody } from "@/lib/antigravity/http";
import { listAntigravity, openAntigravity } from "@/lib/antigravity/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rejected = browserGuard(req);
  if (rejected) return rejected;
  try {
    const params = new URL(req.url).searchParams;
    const cwd = await checkedCwd(params.get("cwd"));
    const cursor = params.get("cursor") || undefined;
    checkMaintenance();
    return json(await listAntigravity(cwd, cursor));
  } catch (error) { return antigravityErrorResponse(error); }
}

export async function POST(req: Request) {
  const rejected = browserGuard(req);
  if (rejected) return rejected;
  try {
    const body = await readBody(req);
    const cwd = await checkedCwd(body.cwd);
    const id = body.sessionId === undefined ? undefined : checkedId(body.sessionId);
    checkMaintenance();
    return json({ session: (await openAntigravity(cwd, id)).state.session });
  } catch (error) { return antigravityErrorResponse(error); }
}
