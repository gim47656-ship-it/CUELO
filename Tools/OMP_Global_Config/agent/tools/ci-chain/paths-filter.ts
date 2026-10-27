/**
 * GitHub Actions `on.push.paths` / `paths-ignore` filter, evaluated locally.
 *
 * ci_chain uses it to tell "the push has no run because every changed file is filtered out" apart from "the run has
 * not appeared yet". A pattern or filter this module does not fully understand is reported as `undefined` or thrown,
 * and the caller then treats the push as one that does run, so a misread never turns a missing run into a pass.
 */

export interface PushPathsFilter {
  /** Patterns of `on.push.paths` (with `!` re-exclusions), in order; absent when the workflow has none. */
  paths?: string[];
  /** Patterns of `on.push.paths-ignore`; absent when the workflow has none. */
  pathsIgnore?: string[];
}

const UNSUPPORTED_PATTERN_CHARS = /[?+[\]\\]/;

/**
 * `*` is any run of characters except `/`; a `**` segment is any run of whole segments; a pattern matches the whole path.
 * `**` is modelled only as a whole segment (`a/**`, `**\/b`, `**`): `a**`, `***` and the like are refused, because their
 * GitHub meaning is not one this module can state with certainty.
 */
export function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  if (UNSUPPORTED_PATTERN_CHARS.test(pattern) || segments.some((segment) => segment.includes("**") && segment !== "**")) {
    throw new Error(`unsupported path pattern: ${pattern}`);
  }
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      // A trailing `**` takes everything below; a leading or inner one takes zero or more whole segments.
      source += last ? ".*" : "(?:.*/)?";
      return;
    }
    source += segment
      .split("*")
      .map((part) => part.replace(/[.^${}()|]/g, "\\$&"))
      .join("[^/]*");
    if (!last) source += "/";
  });
  return new RegExp(`^${source}$`);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function yamlParser(): ((text: string) => unknown) | undefined {
  // Bun.YAML exists only under the Bun runtime this tool runs in; its types are not part of this project's globals.
  const bun: unknown = Reflect.get(globalThis, "Bun");
  if (typeof bun !== "object" || bun === null || !("YAML" in bun)) return undefined;
  const yaml: unknown = bun.YAML;
  if (typeof yaml !== "object" || yaml === null || !("parse" in yaml) || typeof yaml.parse !== "function") return undefined;
  const parse = yaml.parse.bind(yaml);
  return (text) => parse(text);
}

/**
 * Reads the push trigger's path filter from a workflow file. Returns `null` when the workflow has no push trigger,
 * an empty object when the push trigger has no path filter, and `undefined` when the file cannot be understood.
 */
export function parsePushPathsFilter(workflowText: string): PushPathsFilter | null | undefined {
  const parse = yamlParser();
  if (!parse) return undefined;
  let parsed: unknown;
  try {
    parsed = parse(workflowText);
  } catch {
    return undefined;
  }
  const doc = asRecord(parsed);
  if (!doc) return undefined;
  // YAML 1.1 parsers read the bare key `on` as boolean true.
  const trigger = "on" in doc ? doc.on : doc.true;
  if (typeof trigger === "string") return trigger === "push" ? {} : null;
  if (Array.isArray(trigger)) return trigger.includes("push") ? {} : null;
  const events = asRecord(trigger);
  if (!events) return undefined;
  if (!("push" in events)) return null;
  if (events.push === null || events.push === undefined) return {};
  const config = asRecord(events.push);
  if (!config) return undefined;
  const filter: PushPathsFilter = {};
  if ("paths" in config) {
    const paths = stringList(config.paths);
    // GitHub refuses a `paths` list that has only `!` patterns: it must hold at least one positive pattern.
    if (!paths || paths.length === 0 || paths.every((pattern) => pattern.startsWith("!"))) return undefined;
    filter.paths = paths;
  }
  if ("paths-ignore" in config) {
    const ignore = stringList(config["paths-ignore"]);
    if (!ignore || ignore.length === 0) return undefined;
    filter.pathsIgnore = ignore;
  }
  // GitHub rejects a push trigger that has both filters; a file that does is not one this module can reason about.
  if (filter.paths && filter.pathsIgnore) return undefined;
  return filter;
}

/** True when a push whose diff is exactly `changed` starts the workflow. Throws on a pattern it cannot evaluate. */
export function pushStartsWorkflow(filter: PushPathsFilter, changed: string[]): boolean {
  if (changed.length === 0) return true;
  if (filter.pathsIgnore) {
    if (filter.pathsIgnore.some((pattern) => pattern.startsWith("!"))) {
      throw new Error("paths-ignore with a ! pattern is not supported");
    }
    const ignore = filter.pathsIgnore.map(globToRegExp);
    return changed.some((path) => !ignore.some((re) => re.test(path)));
  }
  if (filter.paths) {
    // Patterns apply in order: a later `!` removes a path, a later positive pattern brings it back.
    const steps = filter.paths.map((pattern) =>
      pattern.startsWith("!") ? { negate: true, re: globToRegExp(pattern.slice(1)) } : { negate: false, re: globToRegExp(pattern) },
    );
    return changed.some((path) => {
      let included = false;
      for (const step of steps) {
        if (step.re.test(path)) included = !step.negate;
      }
      return included;
    });
  }
  return true;
}
