import { NextResponse } from "next/server";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { SkillScanConfirmation } from "@/lib/api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { loadProjectTrustStatus } from "@/lib/project-trust";
import { parseConfirmedScan, runSkillGate } from "@/lib/skill-scan";

export const dynamic = "force-dynamic";

const SKILL_PACKAGE_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+@[A-Za-z0-9_.-]+$/;
const MAX_SKILL_PACKAGE_LENGTH = 256;

// POST /api/skills/install  body: { package: string; scope: "global" | "project"; cwd?: string; confirmed?: true; scanned?: string }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      package?: unknown; scope?: unknown; cwd?: unknown; confirmed?: unknown; scanned?: unknown;
    };
    const pkg = typeof body.package === "string" ? body.package.trim() : "";
    const scope = body.scope;
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!pkg) return NextResponse.json({ error: "package required" }, { status: 400 });
    if (pkg.length > MAX_SKILL_PACKAGE_LENGTH || !SKILL_PACKAGE_RE.test(pkg)) {
      return NextResponse.json({ error: "package must be a GitHub skill reference" }, { status: 400 });
    }
    if (scope !== "global" && scope !== "project") {
      return NextResponse.json({ error: "scope must be global or project" }, { status: 400 });
    }

    const isGlobal = scope === "global";
    if (!isGlobal) {
      if (!cwd) return NextResponse.json({ error: "cwd required for project install" }, { status: 400 });
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      if (!(await loadProjectTrustStatus(cwd, getAgentDir())).trusted) {
        return NextResponse.json(
          { error: "Project resources must be trusted before installing project skills" },
          { status: 403 },
        );
      }
    }
    const confirmedScan = parseConfirmedScan(body.confirmed, body.scanned);
    if (confirmedScan === null) {
      return NextResponse.json({ error: "confirmed requires the scanned value from the check" }, { status: 400 });
    }
    const args = ["skills", "add", pkg, "-y", "--agent", "claude-code"];
    if (isGlobal) args.push("-g");

    console.log(`[skills/install] running: npx ${args.join(" ")}`);
    const outcome = await runSkillGate({ args, scope: isGlobal ? "global" : "project", cwd, confirmedScan });
    if (outcome.kind === "error") return NextResponse.json({ error: outcome.message }, { status: outcome.status });
    if (outcome.kind === "confirm") {
      return NextResponse.json({
        needsConfirmation: true,
        scanned: outcome.scanned,
        scan: outcome.scan,
      } satisfies SkillScanConfirmation);
    }
    return NextResponse.json({ success: true, output: outcome.output });
  } catch (e: unknown) {
    console.error("[skills/install] failed:", e);
    return NextResponse.json({ error: "Install failed" }, { status: 500 });
  }
}
