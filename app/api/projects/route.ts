import { NextResponse } from "next/server";
import {
  loadProjectRegistry,
  readProjectRegistryFile,
  saveProjectRegistry,
  updateProjectRegistry,
  type ProjectRegistryUpdate,
} from "@/lib/project-registry";
import { normalizeProjectKey } from "@/lib/project-ordering";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

const MAX_UPDATES = 500;
const MAX_KEY_LENGTH = 1024;
const MAX_ALIAS_LENGTH = 200;

function parseUpdate(value: unknown): ProjectRegistryUpdate | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as {
    key?: unknown;
    path?: unknown;
    alias?: unknown;
    hidden?: unknown;
    order?: unknown;
  };
  if (typeof candidate.key !== "string" || candidate.key.length > MAX_KEY_LENGTH) return null;
  const key = normalizeProjectKey(candidate.key);
  if (!key) return null;

  const hasPath = "path" in candidate;
  const hasAlias = "alias" in candidate;
  const hasHidden = "hidden" in candidate;
  const hasOrder = "order" in candidate;
  if (!hasPath && !hasAlias && !hasHidden && !hasOrder) return null;
  if (hasPath && typeof candidate.path !== "string") return null;
  if (hasAlias && candidate.alias !== null && typeof candidate.alias !== "string") return null;
  if (
    typeof candidate.alias === "string"
    && candidate.alias.trim().length > MAX_ALIAS_LENGTH
  ) return null;
  if (hasHidden && typeof candidate.hidden !== "boolean") return null;
  if (hasOrder && candidate.order !== null && (
    typeof candidate.order !== "number" || !Number.isFinite(candidate.order)
  )) return null;

  return {
    key,
    ...(hasPath ? { path: candidate.path as string } : {}),
    ...(hasAlias ? { alias: candidate.alias as string | null } : {}),
    ...(hasHidden ? { hidden: candidate.hidden as boolean } : {}),
    ...(hasOrder ? { order: candidate.order as number | null } : {}),
  };
}

// GET /api/projects - Return display metadata keyed by normalized project path.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(loadProjectRegistry());
}

// PATCH /api/projects - Update original path, alias, hidden state, or manual order.
export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body: unknown = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid project update" }, { status: 400 });
    }
    const candidate = body as { updates?: unknown };
    const rawUpdates = "updates" in candidate ? candidate.updates : [body];
    if (!Array.isArray(rawUpdates) || rawUpdates.length === 0 || rawUpdates.length > MAX_UPDATES) {
      return NextResponse.json({ error: "Invalid project updates" }, { status: 400 });
    }

    const updates: ProjectRegistryUpdate[] = [];
    for (const rawUpdate of rawUpdates) {
      const update = parseUpdate(rawUpdate);
      if (!update) {
        return NextResponse.json({ error: "Invalid project update" }, { status: 400 });
      }
      updates.push(update);
    }

    const fileState = readProjectRegistryFile();
    if (fileState.status === "incompatible") {
      return NextResponse.json(
        { error: "Project registry file is incompatible" },
        { status: 409 },
      );
    }
    const registry = updateProjectRegistry(fileState.registry, updates);
    saveProjectRegistry(registry);
    return NextResponse.json(registry);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
