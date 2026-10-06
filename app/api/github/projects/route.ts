import { NextResponse } from "next/server";
import { beginGithubLogin, GithubProjectError, githubProjectStatus, githubWorkspace, listGithubRepositories, openGithubRepository } from "@/lib/github-projects";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof GithubProjectError ? error.message : "GitHub workspace operation failed." }, { status: error instanceof GithubProjectError ? error.status : 500 });
}

export async function GET(request: Request) {
  try {
    githubWorkspace();
    if (new URL(request.url).searchParams.get("view") === "repositories") {
      return NextResponse.json({ repositories: await listGithubRepositories() });
    }
    return NextResponse.json(await githubProjectStatus());
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    githubWorkspace();
    let body: { action?: unknown; repository?: unknown };
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: "Expected a JSON request." }, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Expected a JSON object." }, { status: 400 });
    }
    if (body.action === "login") return NextResponse.json({ device: beginGithubLogin() }, { status: 202 });
    if (body.action === "open" && typeof body.repository === "string") {
      return NextResponse.json({ cwd: await openGithubRepository(body.repository) });
    }
    return NextResponse.json({ error: "Choose login or open with a GitHub repository." }, { status: 400 });
  } catch (error) { return failure(error); }
}
