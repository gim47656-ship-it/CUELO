import { stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { canonicalProjectKey, getProjectTrustStatus, listProjectTrustDecisions } from "@/lib/project-trust";
import {
  ProjectTrustNotRequiredError,
  describeProjectTrust,
  requestProjectTrustChange,
} from "@/lib/project-trust-lifecycle";
import { hasJsonContentType } from "@/lib/request-security";
import { projectTrustHost } from "@/lib/rpc-manager";
import type { ProjectTrustAction, ProjectTrustEntry } from "@/lib/api-types";

export const dynamic = "force-dynamic";

const ACTIONS: Record<ProjectTrustAction, true> = { grant: true, revoke: true, cancel: true };

async function isAllowedDirectory(cwd: string, allowedRoots: Set<string>): Promise<boolean> {
  try {
    if (!(await stat(cwd)).isDirectory()) return false;
  } catch {
    return false;
  }
  return isExistingFilePathAllowed(cwd, allowedRoots);
}

async function validateCwd(value: unknown): Promise<
  { cwd: string } | { response: NextResponse }
> {
  if (typeof value !== "string" || !value.trim()) {
    return { response: NextResponse.json({ error: "cwd required" }, { status: 400 }) };
  }

  const cwd = resolve(value);
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return { response: NextResponse.json({ error: "cwd must be a directory" }, { status: 400 }) };
    }
  } catch {
    return { response: NextResponse.json({ error: "Directory does not exist" }, { status: 400 }) };
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

/**
 * Projects with a recorded decision, plus projects live sessions or the caller
 * (`include`, e.g. the project open in settings) have open that need one. Paths
 * that no longer exist or sit outside the allowed roots are left out rather
 * than disclosed.
 */
async function listProjects(agentDir: string, include: string[]): Promise<ProjectTrustEntry[]> {
  const candidates = new Set(Object.keys(listProjectTrustDecisions(agentDir)));
  const open = [...include.map((path) => resolve(path)), ...[...projectTrustHost.sessions()].map((session) => session.cwd)];
  for (const path of open) {
    const key = canonicalProjectKey(path);
    if (getProjectTrustStatus(key, agentDir).requiresTrust) candidates.add(key);
  }
  const allowedRoots = await getAllowedFileRoots();
  const entries: ProjectTrustEntry[] = [];
  for (const cwd of candidates) {
    if (!(await isAllowedDirectory(cwd, allowedRoots))) continue;
    entries.push({ cwd, ...describeProjectTrust(projectTrustHost, cwd, agentDir) });
  }
  return entries.sort((left, right) => left.cwd.localeCompare(right.cwd));
}

export async function GET(req: Request) {
  const agentDir = getAgentDir();
  const params = new URL(req.url).searchParams;
  const cwdParam = params.get("cwd");
  if (cwdParam === null) {
    return NextResponse.json({ projects: await listProjects(agentDir, params.getAll("include")) });
  }

  const result = await validateCwd(cwdParam);
  if ("response" in result) return result.response;
  return NextResponse.json(describeProjectTrust(projectTrustHost, result.cwd, agentDir));
}

export async function POST(req: Request) {
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { cwd?: unknown; action?: unknown };
    const action = body.action ?? "grant";
    if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) {
      return NextResponse.json({ error: "action must be grant, revoke, or cancel" }, { status: 400 });
    }
    const result = await validateCwd(body.cwd);
    if ("response" in result) return result.response;

    const state = requestProjectTrustChange(
      projectTrustHost,
      result.cwd,
      getAgentDir(),
      action as ProjectTrustAction,
    );
    // 202: accepted but not fully applied — a grant waits for the project's
    // sessions to go idle, a revoke for sessions still running project code.
    return NextResponse.json(state, { status: state.pending ? 202 : 200 });
  } catch (error) {
    if (error instanceof ProjectTrustNotRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
