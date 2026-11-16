import { NextResponse } from "next/server";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { SkillInstallScope, SkillScanConfirmation } from "@/lib/api-types";
import { buildSkillUpdateArgs } from "@/lib/skill-updates";
import { parseConfirmedScan, runSkillGate } from "@/lib/skill-scan";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { loadProjectTrustStatus } from "@/lib/project-trust";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      cwd?: unknown;
      package?: unknown;
      scope?: unknown;
      confirmed?: unknown;
      scanned?: unknown;
    };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const pkg = typeof body.package === "string" ? body.package.trim() : "";
    const scope = body.scope === "global" || body.scope === "project"
      ? body.scope as SkillInstallScope
      : undefined;
    if (!cwd || !pkg || !scope) {
      return NextResponse.json({ error: "cwd, package, and scope are required" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (scope === "project" && !(await loadProjectTrustStatus(cwd, getAgentDir())).trusted) {
      return NextResponse.json(
        { error: "Project resources must be trusted before updating project skills" },
        { status: 403 },
      );
    }

    const { skills } = await loadSkillsWithInstallInfo(cwd);
    const skill = skills.find(
      (item) => item.install?.package === pkg && item.install.scope === scope,
    );
    if (!skill?.install) {
      return NextResponse.json({ error: "Installed skill not found" }, { status: 404 });
    }
    if (!skill.install.canCheckForUpdates) {
      return NextResponse.json({ error: "This skill cannot be updated automatically" }, { status: 400 });
    }

    const confirmedScan = parseConfirmedScan(body.confirmed, body.scanned);
    if (confirmedScan === null) {
      return NextResponse.json({ error: "confirmed requires the scanned value from the check" }, { status: 400 });
    }
    const outcome = await runSkillGate({ args: buildSkillUpdateArgs(skill.install), scope, cwd, confirmedScan });
    if (outcome.kind === "error") return NextResponse.json({ error: outcome.message }, { status: outcome.status });
    if (outcome.kind === "confirm") {
      return NextResponse.json({
        needsConfirmation: true,
        scanned: outcome.scanned,
        scan: outcome.scan,
      } satisfies SkillScanConfirmation);
    }

    const refreshed = await loadSkillsWithInstallInfo(cwd);
    const updatedSkill = refreshed.skills.find(
      (item) => item.install?.package === pkg && item.install.scope === scope,
    );
    return NextResponse.json({ success: true, skill: updatedSkill, output: outcome.output });
  } catch (error: unknown) {
    console.error("[skills/update] failed:", error);
    return NextResponse.json({ error: "Skill update failed" }, { status: 500 });
  }
}
