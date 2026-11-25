import { AntigravityError } from "@/lib/antigravity/acp";
import { activeFromRequest, antigravityErrorResponse, browserGuard, checkMaintenance, json, readBody } from "@/lib/antigravity/http";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const rejected = browserGuard(req);
  if (rejected) return rejected;
  try {
    const body = await readBody(req);
    const session = await activeFromRequest(req);
    if (body.action === "cancel") {
      session.cancel();
    } else if (body.action === "permission" && typeof body.id === "string" && typeof body.allow === "boolean") {
      if (body.allow) checkMaintenance();
      session.decide(body.id, body.allow);
    } else if (body.action === "option" && typeof body.id === "string" && typeof body.value === "string") {
      checkMaintenance();
      await session.setOption(body.id, body.value);
    } else {
      throw new AntigravityError("bad_request", "Unknown Antigravity action.");
    }
    return json({ accepted: true });
  } catch (error) { return antigravityErrorResponse(error); }
}
