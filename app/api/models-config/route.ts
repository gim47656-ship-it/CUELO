import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { YAMLParseError, parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { invalidateModelsCache } from "@/lib/models-cache";
import { invalidateOmpRuntime } from "@/lib/omp-runtime";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
export const dynamic = "force-dynamic";

/**
 * Custom provider config lives in `~/.omp/agent/models.yml`.
 *
 * omp reads `models.yml` first and falls back to `models.yaml`; a legacy
 * `models.json` is migrated to YAML on first load. Read whichever exists, but
 * always write back to `models.yml` so the CLI and CUELO agree on one file.
 */
const CANONICAL_FILE = "models.yml";
const READ_CANDIDATES = ["models.yml", "models.yaml", "models.json"] as const;

function getWritePath(): string {
  return join(getAgentDir(), CANONICAL_FILE);
}

type ModelsConfigRead = { config: Record<string, unknown> } | { error: string };

// Only a file that is not there counts as "no config yet". Anything else that stops the read (no
// permission, a non-directory in the path, a parse failure) is an error: the editor must never get an
// empty config it could save over the real file.
function readModelsConfig(): ModelsConfigRead {
  const agentDir = getAgentDir();
  for (const name of READ_CANDIDATES) {
    let text: string;
    try {
      text = readFileSync(join(agentDir, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { error: `Unable to read ${name}` };
    }
    let parsed: unknown;
    try {
      // `parse` handles JSON too — it is a subset of YAML — so a not-yet-migrated
      // `models.json` still loads.
      parsed = parseYaml(text);
    } catch (error) {
      // Report only the position; the parser's own message quotes the line, which can hold a key.
      const at = error instanceof YAMLParseError ? error.linePos?.[0] : undefined;
      return { error: `${name} is not valid YAML${at ? ` (line ${at.line}, column ${at.col})` : ""}` };
    }
    if (parsed === null || parsed === undefined) return { config: { providers: {} } };
    if (!isRecord(parsed)) return { error: `${name} is not a YAML mapping` };
    return { config: parsed };
  }
  return { config: { providers: {} } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Drop blank model rows (empty/whitespace string ids) before persisting, but
// keep non-string ids and non-object entries so schema errors elsewhere stay
// visible to the user instead of being silently rewritten.
function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));

  return { ...data, providers };
}

// omp ignores the whole of models.yml when one provider breaks its rules, so a half-filled draft (a
// provider without an endpoint, a model under a provider without a baseUrl) would drop every provider
// at runtime. Check the exact text with omp's own loader first; on rejection models.yml keeps its
// bytes and the loader's reason is returned.
function writeModelsConfig(data: Record<string, unknown>): string | null {
  const path = getWritePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const text = stringifyYaml(sanitizeModelsConfig(data), { lineWidth: 0 });
  const rejection = checkModelsYaml(dir, text);
  if (rejection === null) {
    writePrivateFileAtomicSync(path, text);
    // omp keeps one parsed models.yml per path and a new ModelRegistry reuses it; drop it so the runtime
    // rebuilt after this save loads what was just written instead of the providers from before.
    ModelsConfigFile.relocate(path).invalidate();
  }
  return rejection;
}

// The loader only reads files, and parses YAML only from a `.yml` name.
function checkModelsYaml(dir: string, text: string): string | null {
  const checkPath = join(dir, `.models-check-${randomUUID()}.yml`);
  writeFileSync(checkPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    const result = ModelsConfigFile.relocate(checkPath).tryLoad();
    if (result.status !== "error") return null;
    const { schemaErrors, other } = result.error;
    if (schemaErrors?.length) {
      return schemaErrors.map((problem) => `${problem.instancePath}: ${problem.message ?? "invalid value"}`).join("; ");
    }
    return other?.err instanceof Error ? other.err.message : result.error.message;
  } finally {
    unlinkSync(checkPath);
  }
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const read = readModelsConfig();
  if ("error" in read) return NextResponse.json({ error: read.error }, { status: 500 });
  return NextResponse.json(read.config);
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "models config must be an object" }, { status: 400 });
    }
    const config = body as Record<string, unknown>;
    if (
      "providers" in config
      && (typeof config.providers !== "object" || config.providers === null || Array.isArray(config.providers))
    ) {
      return NextResponse.json({ error: "providers must be an object" }, { status: 400 });
    }
    const rejection = writeModelsConfig(config);
    if (rejection !== null) return NextResponse.json({ error: rejection }, { status: 400 });
    invalidateModelsCache();
    // The registry caches models.yml at construction; drop it so the next
    // request rebuilds against the edited providers.
    invalidateOmpRuntime();
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Unable to save models config" }, { status: 500 });
  }
}
