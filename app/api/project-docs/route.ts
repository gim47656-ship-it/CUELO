import { stat } from "fs/promises";
import { resolve } from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  mapLegacyWindowsPath,
  readLegacyPathMap,
} from "@/lib/file-access";
import { resolveProjectDocs } from "@/lib/project-docs";

export const dynamic = "force-dynamic";

/** Document shortcuts (HANDOFF, doc map, recent records) for the Files empty state. Read-only. */
export async function GET(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get("cwd");
  if (!requested?.trim()) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  try {
    // Same explicit Windows → local mapping as the file route; nothing else is translated.
    const cwd = resolve(mapLegacyWindowsPath(requested, readLegacyPathMap()));
    // Same order as /api/files: the lexical root check answers before anything is stat'ed, so a path
    // outside the allowed roots gets 403 whether or not it exists; realpath is checked after stat.
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    try {
      if (!(await stat(cwd)).isDirectory()) {
        return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    return NextResponse.json(resolveProjectDocs(cwd, allowedRoots));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
