import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Only explicit filesystem tool contracts are observed; never inspect shell/eval code or result prose.
type Result = { toolName: string; input?: unknown; details?: unknown; isError?: boolean };
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|css|scss|sass|less|jsonc?|ya?ml|toml|ini|cfg|conf|config|xml|resx|vb|frm|bas|cs|fs|csproj|vbproj|slnx?|props|targets|c|cc|cpp|cxx|h|hpp|rs|go|py|rb|php|java|kt|kts|swift|sh|bash|ps1|bat|cmd|sql|gradle|cmake|proto)$/i;
const SOURCE_NAME = /^(?:Dockerfile|Makefile|CMakeLists\.txt|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.env(?:\..+)?)$/i;
const EXCLUDED: Record<string, true> = { ".git": true, node_modules: true, dist: true, build: true, coverage: true, ".next": true, doc: true, docs: true, evidence: true };
const URI = /^[A-Za-z][A-Za-z0-9+.-]+:\//;
const PREFIXED_URI = /[\\/][A-Za-z][A-Za-z0-9+.-]+:\/\//;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const strings = (values: unknown[]) => values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
const unwrap = (path: string) => /^\[(.+)#[0-9a-f]{4}\]$/i.exec(path.trim())?.[1] ?? path.trim();
const internal = (path: string) => !/^file:\/\//i.test(unwrap(path)) && (URI.test(unwrap(path)) || PREFIXED_URI.test(unwrap(path)));

function localPath(path: string, cwd: string, read: boolean): string | undefined {
  let value = unwrap(path);
  if (internal(value)) return undefined;
  try {
    if (/^file:\/\//i.test(value)) value = fileURLToPath(value);
    if (read && !existsSync(resolve(cwd, value))) value = value.replace(/:(?:raw|\d|-[\d]|img|conflicts)[\s\S]*$/, "");
    if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
    const absolute = resolve(cwd, value);
    // Deleted targets still count; resolve the nearest existing parent to reject symlink escapes.
    let parent = absolute;
    const missing: string[] = [];
    while (!existsSync(parent)) {
      const above = dirname(parent);
      if (above === parent) return undefined;
      missing.unshift(basename(parent)); parent = above;
    }
    return join(realpathSync(parent), ...missing);
  } catch { return undefined; }
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
function isDir(path: string): boolean { try { return statSync(path).isDirectory(); } catch { return false; } }

function targets(event: Result): string[] {
  const input = record(event.input), details = record(event.details);
  const authored = strings([...(Array.isArray(input.paths) ? input.paths : []), input.path]);
  if (event.toolName === "edit" && typeof input.input === "string") {
    for (const match of input.input.matchAll(/^\[(.+?)#[0-9A-F]{4}\]/gmi)) authored.push(match[1]!);
  }
  // A URI's backing path is not evidence of permission or of a project-local mutation.
  if (authored.some(internal)) return [];
  if (event.toolName === "read") {
    // Delimited reads list failures too; only non-null backing links prove a successful local read.
    if (Array.isArray(details.displayReadTargetLinks)) return strings(details.displayReadTargetLinks);
    const source = record(record(details.meta).source);
    return strings([details.resolvedPath ?? (source.type === "path" ? source.value : undefined) ?? input.path]);
  }
  if (event.toolName === "write") return strings([details.resolvedPath ?? input.path]);
  if (event.toolName !== "edit") return [];
  if (Array.isArray(details.perFileResults)) {
    return details.perFileResults.flatMap((file) => { const f = record(file); return strings([f.path, f.sourcePath, f.move]); });
  }
  const resolved = strings([details.path, details.sourcePath, details.move]);
  return resolved.length ? resolved : authored;
}

type Boundary = { git?: string; handoff?: string };
function boundary(dir: string, memo: Map<string, Boundary>): Boundary {
  const cached = memo.get(dir);
  if (cached) return cached;
  const handoff = isFile(join(dir, "HANDOFF.md")) ? dir : undefined;
  const above = dirname(dir);
  const found = existsSync(join(dir, ".git")) ? { git: dir, handoff }
    : above === dir ? { handoff } : { ...boundary(above, memo), ...(handoff ? { handoff } : {}) };
  memo.set(dir, found);
  return found;
}

export function createTurnDocuments() {
  const sources = new Set<string>();
  const reviewed = new Set<string>();
  const written = new Set<string>();
  return {
    reset() { sources.clear(); reviewed.clear(); written.clear(); },
    observe(event: Result, cwd: string | undefined) {
      if (event.toolName === "draft") {
        const savedPath = record(event.details).savedPath;
        if (event.isError || !cwd || typeof savedPath !== "string" || !isAbsolute(savedPath)) return;
        let base: string;
        try { base = realpathSync(cwd); } catch { return; }
        const path = localPath(savedPath, base, false);
        if (path && within(base, path) && isFile(path)
          && /(?:^|\/)(?:HANDOFF\.md|doc\/README\.md|doc\/history\/\d{4}\/\d{2}\/\d{2}-[^/]+\/(?:main|maker-[^/]+)\.md)$/.test(path.split(sep).join("/"))) written.add(path);
        return;
      }
      if (!cwd || event.isError || !["read", "write", "edit"].includes(event.toolName)) return;
      let base: string;
      try { base = realpathSync(cwd); } catch { return; }
      for (const target of targets(event)) {
        const path = localPath(target, base, event.toolName === "read");
        if (!path) continue;
        if (event.toolName === "read") {
          if (isFile(path)) reviewed.add(path);
          continue;
        }
        written.add(path);
        if (!within(base, path)) continue;
        const parts = relative(base, path).split(sep);
        if (parts.some((part) => EXCLUDED[part])) continue;
        if (SOURCE.test(path) || SOURCE_NAME.test(basename(path))) sources.add(path);
      }
    },
    note(cwd: string | undefined): string | undefined {
      if (!cwd || sources.size === 0) return undefined;
      let base: string;
      try { base = realpathSync(cwd); } catch { return undefined; }
      const memo = new Map<string, Boundary>();
      const current = boundary(base, memo);
      const projects = new Map<string, boolean>();
      for (const path of sources) {
        if (!within(base, path)) continue;
        const found = boundary(dirname(path), memo);
        if (found.git !== current.git) continue; // A nested/separate checkout is not the session's project.
        const project = found.handoff ?? base;
        projects.set(project, projects.get(project) === true || (found.handoff === undefined && dirname(path) !== base));
      }
      const notices: string[] = [];
      for (const [project, uncertain] of projects) {
        const handoff = join(project, "HANDOFF.md"), map = join(project, "doc/README.md"), history = join(project, "doc/history");
        const absent: string[] = [], unseen: string[] = [];
        for (const [path, name] of [[handoff, "HANDOFF.md"], [map, "doc/README.md"]] as const) {
          if (!isFile(path)) absent.push(name);
          else if (!reviewed.has(path) && !written.has(path)) unseen.push(`${name} 읽기/쓰기`);
        }
        if (!isDir(history)) absent.push("doc/history 작업 기록");
        else if (![...written].some((path) => within(history, path) && /^\d{4}\/\d{2}\/\d{2}-[^/]+\/(?:main|maker-[^/]+)\.md$/.test(relative(history, path).split(sep).join("/")) && isFile(path))) unseen.push("작업 기록 쓰기");
        if (!absent.length && !unseen.length) continue;
        const label = relative(base, project).split(sep).join("/") || ".";
        notices.push(`\`${label}\`: ${[uncertain ? "프로젝트 경계 미확인(cwd 기준)" : "", absent.length ? `없거나 확인 불가: ${absent.join("·")}` : "", unseen.length ? `이번 작업 미관측: ${unseen.join("·")}` : ""].filter(Boolean).join("; ")}`);
      }
      if (!notices.length) return undefined;
      return `문서 확인 — ${notices.slice(0, 3).join(" | ")}${notices.length > 3 ? ` 외 ${notices.length - 3}곳` : ""}. 파일 존재나 도구 관측은 내용의 최신성을 증명하지 않는다. rule://docs-handoff에 따라 마감하라. Maker는 자기 작업 기록을 쓰고 공유 HANDOFF·지도 반영 사항은 Main에게 보고하라. 이 안내는 승인·파일 자동 생성·커밋 지시가 아니며 기존 소유권과 승인 경계를 바꾸지 않는다.`;
    },
  };
}
