import { NextResponse } from "next/server";
import { homedir } from "os";

export async function GET() {
  return NextResponse.json({ home: homedir(), cloudProjects: Boolean(process.env.CUELO_GITHUB_WORKSPACE?.trim()) });
}
