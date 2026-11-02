import { existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { discoverSessionExtensionPaths, type Settings } from "@oh-my-pi/pi-coding-agent";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { type ExtensionModule, extensionModuleCapability } from "@oh-my-pi/pi-coding-agent/capability/extension-module";
import { type Hook, hookCapability } from "@oh-my-pi/pi-coding-agent/capability/hook";
import { setInvocationConfiguredExtensions, withOmpExtensionRootScope } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { discoverCustomToolPaths, type ToolPathWithSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { getAllPluginExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { cfgDisabledExtensions, cfgExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { resolvePath } from "@oh-my-pi/pi-coding-agent/extensibility/utils";
import { adoptLegacyStateFile } from "../bin/web-auth-store.js";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getSettingsForCwd } from "./omp-runtime";
import type { ProjectTrustStatus } from "./api-types";

/**
 * Project trust for CUELO.
 *
 * The `omp` CLI executes a repository's `.omp/extensions`, `.omp/hooks`,
 * `.omp/tools`, `.mcp.json` and the extension roots its project settings files
 * list under `extensions:` because the user deliberately ran it inside that
 * repository. CUELO reaches the same code from a browser tab: merely opening
 * a project in the sidebar would otherwise run repository-controlled code on
 * the machine hosting the server.
 *
 * omp has no trust store of its own, so CUELO keeps one and gates the
 * *code-bearing* project resources behind it. Trust decisions live next to the
 * agent config so they survive restarts and are shared by every CUELO
 * instance pointed at the same agent directory.
 */

const TRUST_FILE = "cuelo-trusted-projects.json";
const LEGACY_TRUST_FILE = "omp-web-trusted-projects.json";

/**
 * Project-relative directories whose contents omp imports and executes.
 *
 * Skills, rules and prompts are intentionally absent: they are data folded into
 * the system prompt, not modules the loader imports.
 */
const CODE_BEARING_PROJECT_DIRS = [
  ".omp/extensions", ".omp/hooks", ".omp/tools",
  ".pi/extensions", ".pi/hooks", ".pi/tools",
  ".claude/extensions", ".claude/hooks", ".claude/tools",
  ".agents/extensions", ".agents/hooks", ".agents/tools",
] as const;

/** Project-relative files that declare MCP servers, i.e. processes omp spawns. */
const MCP_MANIFEST_FILES = [
  ".mcp.json",
  ".omp/.mcp.json", ".omp/mcp.json",
  ".claude/.mcp.json", ".claude/mcp.json",
  ".cursor/mcp.json",
] as const;

function trustFilePath(agentDir: string): string {
  return join(agentDir, TRUST_FILE);
}

/**
 * The one key both the trust store and the session registry use for a project:
 * `rpc-manager` groups live and starting sessions by it, so a decision written
 * here always names the same sessions the lifecycle checks before applying it.
 */
export function canonicalProjectKey(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function readTrustedProjects(agentDir: string): Record<string, boolean> {
  try {
    // A failed adoption lands in the catch below: no project is trusted.
    adoptLegacyStateFile(trustFilePath(agentDir), LEGACY_TRUST_FILE);
    const parsed: unknown = JSON.parse(readFileSync(trustFilePath(agentDir), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
  } catch {
    return {};
  }
}

function writeTrustedProjects(agentDir: string, trusted: Record<string, boolean>): void {
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(trustFilePath(agentDir), `${JSON.stringify(trusted, null, 2)}\n`);
}

/** Configured extension entries resolved the way omp resolves them, limited to paths that exist. */
function existingExtensionPaths(entries: readonly unknown[], cwd: string): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    let path: string;
    try {
      path = resolvePath(entry, cwd);
    } catch {
      // An internal-scheme entry makes omp's own discovery throw; nothing loads from it.
      continue;
    }
    if (existsSync(path)) paths.push(path);
  }
  return paths;
}

/**
 * Extension roots the project's own settings layer configures, resolved the way
 * omp resolves them and limited to paths that exist.
 *
 * omp merges every project settings provider (`.omp/config.yml`,
 * `.omp/settings.json`, `.claude/settings.json`, …) into one project layer and
 * reports through `extensionsSourceLevel()` whether that layer supplies the
 * effective `extensions` array; arrays replace rather than merge, so every
 * entry then comes from the project. Reading omp's own provenance keeps this in
 * step with whatever providers omp merges.
 */
function projectSettingsExtensionRoots(settings: Settings, cwd: string): string[] {
  if (settings.extensionsSourceLevel() !== "project") return [];
  return existingExtensionPaths(cfgExtensions.get(settings), cwd);
}

/**
 * Existing paths in the legacy `extensions` list of the project's
 * `.omp/settings.json`. omp's native extension-module provider loads these
 * itself, independent of the merged setting, so another project settings file
 * that empties or replaces `extensions` does not stop them. Like that provider,
 * a project opened at the home directory has no project config dir.
 */
function legacyProjectSettingsExtensionPaths(cwd: string): string[] {
  if (resolve(cwd) === resolve(homedir())) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(cwd, ".omp", "settings.json"), "utf8"));
  } catch {
    return [];
  }
  const entries = (parsed as { extensions?: unknown } | null)?.extensions;
  return Array.isArray(entries) ? existingExtensionPaths(entries, cwd) : [];
}

/**
 * The `disabledExtensions` list with the project settings layer left out: the
 * effective value when a higher or user-level layer supplies it, otherwise the
 * user-level layers' own list, which the project list replaced.
 */
function nonProjectDisabledExtensions(settings: Settings): string[] {
  if (settings.getProvenance(cfgDisabledExtensions) !== "project") return [...cfgDisabledExtensions.get(settings)];
  const raw = settings.getGlobalSettings().disabledExtensions;
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Whether the project settings layer changes which extensions, skills, rules,
 * … are disabled. omp lets that layer's array replace the user's, so a
 * repository could switch off user-level code (a guard extension, a skill) or
 * switch back on what the user disabled.
 */
function projectSettingsChangeDisabledExtensions(settings: Settings): boolean {
  if (settings.getProvenance(cfgDisabledExtensions) !== "project") return false;
  const effective = new Set(cfgDisabledExtensions.get(settings));
  const nonProject = new Set(nonProjectDisabledExtensions(settings));
  return effective.size !== nonProject.size || [...effective].some((id) => !nonProject.has(id));
}

/**
 * Whether `cwd` ships resources omp would import and execute on session start,
 * or settings that change which user-level extensions omp loads.
 * `settings` is omp's settings for `cwd` (see {@link projectSettingsExtensionRoots}).
 */
export function hasTrustRequiringProjectResources(cwd: string, settings: Settings): boolean {
  if (!cwd) return false;
  for (const dir of CODE_BEARING_PROJECT_DIRS) {
    if (existsSync(join(cwd, dir))) return true;
  }
  for (const file of MCP_MANIFEST_FILES) {
    if (existsSync(join(cwd, file))) return true;
  }
  return (
    projectSettingsExtensionRoots(settings, cwd).length > 0 ||
    legacyProjectSettingsExtensionPaths(cwd).length > 0 ||
    projectSettingsChangeDisabledExtensions(settings)
  );
}

export function getProjectTrustStatus(cwd: string, agentDir: string, settings: Settings): ProjectTrustStatus {
  const requiresTrust = Boolean(cwd) && hasTrustRequiringProjectResources(cwd, settings);
  if (!requiresTrust) return { requiresTrust: false, trusted: true };

  return {
    requiresTrust: true,
    trusted: readTrustedProjects(agentDir)[canonicalProjectKey(cwd)] === true,
  };
}

/** {@link getProjectTrustStatus} with the same settings a session for `cwd` starts with. */
export async function loadProjectTrustStatus(cwd: string, agentDir: string): Promise<ProjectTrustStatus> {
  return getProjectTrustStatus(cwd, agentDir, await getSettingsForCwd(cwd));
}

export function trustProject(cwd: string, agentDir: string, settings: Settings): ProjectTrustStatus {
  const status = getProjectTrustStatus(cwd, agentDir, settings);
  if (!status.requiresTrust) return status;
  setProjectTrust(cwd, agentDir, true);
  return { requiresTrust: true, trusted: true };
}

/**
 * Record an explicit decision. A revoke is stored as `false` rather than a
 * removed key so the project stays listed and can be trusted again from settings.
 */
export function setProjectTrust(cwd: string, agentDir: string, trusted: boolean): void {
  const decisions = readTrustedProjects(agentDir);
  decisions[canonicalProjectKey(cwd)] = trusted;
  writeTrustedProjects(agentDir, decisions);
}

/** Every recorded decision, keyed by canonical project path. */
export function listProjectTrustDecisions(agentDir: string): Record<string, boolean> {
  return readTrustedProjects(agentDir);
}

/** True when `candidate` lives inside `root` (or is `root` itself). */
export function isInsideProject(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "") return true;
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../");
}

/** Shape shared by omp's discovered custom-tool entries. */
export interface DiscoveredToolPath {
  path: string;
  source?: { level: "user" | "project" };
}

export interface UntrustedProjectSessionOptions<TTool extends DiscoveredToolPath> {
  /** Extension modules to load, with project-local ones removed. */
  preloadedExtensionPaths: string[];
  /** Custom tool modules to load, with project-local ones removed. */
  preloadedCustomToolPaths: TTool[];
  /** MCP servers are processes omp spawns from project manifests — off entirely. */
  enableMCP: false;
  /**
   * The session's own settings with the project's `disabledExtensions` left
   * out; present only when the project layer changes that list.
   */
  settings?: Settings;
}

export interface DiscoveredProjectCode<TTool extends DiscoveredToolPath> {
  extensionPaths: readonly string[];
  customToolPaths: readonly TTool[];
}

/**
 * The configured `extensions` lane with the project settings layer left out:
 * the effective value when a user-level layer supplies it, otherwise the
 * user-level layers' own array, which the project array replaced.
 */
function nonProjectConfiguredExtensions(settings: Settings): string[] {
  if (settings.extensionsSourceLevel() !== "project") return [...cfgExtensions.get(settings)];
  const raw = settings.getGlobalSettings().extensions;
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

/**
 * Extension modules only the project contributes, keyed by real path.
 *
 * omp's native extension-module provider reads `.omp/extensions` and also the
 * legacy `extensions` list of a project `settings.json` itself, wherever its
 * entries point, so the configured lane alone does not keep those out of
 * discovery. A module counts as the project's only when no other source omp
 * loads extensions from yields it too: the user-level native modules, the
 * non-project configured and explicit roots, user-level hooks, and installed
 * plugins.
 */
async function projectOnlyNativeExtensionModules(
  settings: Settings,
  cwd: string,
  configured: readonly string[],
): Promise<Set<string>> {
  const configuredRoots = { explicit: configured, mode: "explicit-only" as const, configured: [], configuredLevel: "user" as const };
  const [modules, hooks, configuredPaths, pluginPaths] = await Promise.all([
    loadCapability<ExtensionModule>(extensionModuleCapability.id, { cwd, providers: ["native"] }),
    loadCapability<Hook>(hookCapability.id, { cwd }),
    discoverSessionExtensionPaths({ extensionRoots: () => configuredRoots }, cwd, settings),
    getAllPluginExtensionPaths(cwd),
  ]);
  const fromOtherSources = new Set(
    [
      ...modules.items.filter((item) => item.level !== "project").map((item) => item.path),
      ...hooks.items.filter((item) => item.level !== "project").map((item) => item.path),
      ...configuredPaths,
      ...pluginPaths,
    ].map(canonicalProjectKey),
  );
  return new Set(
    modules.items
      .filter((item) => item.level === "project")
      .map((item) => canonicalProjectKey(item.path))
      .filter((path) => !fromOtherSources.has(path)),
  );
}

/**
 * omp's own extension and custom-tool discovery for `cwd` as if the project's
 * settings files configured no extension roots.
 *
 * Leaving those roots out of discovery, rather than dropping every path under
 * them afterwards, means a project cannot unload user-level or explicit code
 * by naming a root that also holds it (`~/.omp/agent/extensions`, `~`, `/`):
 * such code is still contributed by its own source. The invocation scope
 * carries the same configured lane into the sub-discovery of package hooks and
 * tools; modules omp's native provider reads straight from a project
 * `settings.json` are removed unless another source also yields them.
 */
export async function discoverCodeWithoutProjectSettingsExtensions(
  settings: Settings,
  cwd: string,
): Promise<DiscoveredProjectCode<ToolPathWithSource>> {
  const configured = nonProjectConfiguredExtensions(settings);
  const extensionRoots = { explicit: [], mode: "merge" as const, configured, configuredLevel: "user" as const };
  return withOmpExtensionRootScope([], "merge", async () => {
    setInvocationConfiguredExtensions(configured, "user");
    const [extensionPaths, customToolPaths, projectOnly] = await Promise.all([
      discoverSessionExtensionPaths({ extensionRoots: () => extensionRoots }, cwd, settings),
      discoverCustomToolPaths([], cwd),
      projectOnlyNativeExtensionModules(settings, cwd, configured),
    ]);
    return {
      extensionPaths: extensionPaths.filter((path) => !projectOnly.has(canonicalProjectKey(path))),
      customToolPaths,
    };
  });
}

/**
 * A private copy of `settings` whose `disabledExtensions` is the non-project
 * value, held as a runtime override on the copy so the instance other sessions
 * share is never changed. Higher layers still win the way they do in omp: the
 * project layer this replaces already shadowed later user-level edits.
 */
async function withoutProjectDisabledExtensions(settings: Settings, cwd: string): Promise<Settings> {
  const own = await settings.cloneForCwd(cwd);
  cfgDisabledExtensions.override(own, nonProjectDisabledExtensions(settings));
  return own;
}

/**
 * Session options that keep an untrusted project's code dormant.
 *
 * Returns `undefined` when the project has nothing that requires trust, or when
 * the user already trusted it — both leave omp on its normal load path so
 * CUELO sessions behave exactly like `omp` in a terminal, and `discover` is
 * never called for them.
 *
 * For a gated project `discover` supplies the paths from the settings the
 * session will use, normally via {@link discoverCodeWithoutProjectSettingsExtensions},
 * so roots the project's settings configure are already absent while
 * user-level extensions keep working; entries under the project root are
 * dropped here. When the project changes `disabledExtensions`, those settings
 * are a private copy without that change (returned as `settings`).
 */
export async function untrustedProjectSessionOptions<TTool extends DiscoveredToolPath>(
  cwd: string,
  agentDir: string,
  settings: Settings,
  discover: (settings: Settings) => Promise<DiscoveredProjectCode<TTool>>,
): Promise<UntrustedProjectSessionOptions<TTool> | undefined> {
  const status = getProjectTrustStatus(cwd, agentDir, settings);
  if (!status.requiresTrust || status.trusted) return undefined;

  const sessionSettings = projectSettingsChangeDisabledExtensions(settings)
    ? await withoutProjectDisabledExtensions(settings, cwd)
    : settings;
  const discovered = await discover(sessionSettings);
  return {
    preloadedExtensionPaths: discovered.extensionPaths.filter((path) => !isInsideProject(path, cwd)),
    preloadedCustomToolPaths: discovered.customToolPaths.filter(
      (tool) => tool.source?.level !== "project" && !isInsideProject(tool.path, cwd),
    ),
    enableMCP: false,
    ...(sessionSettings !== settings ? { settings: sessionSettings } : {}),
  };
}
