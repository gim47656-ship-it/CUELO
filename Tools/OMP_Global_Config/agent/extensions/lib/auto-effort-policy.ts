export type AutoEffortFloor = "low" | "medium" | "high" | "xhigh";

export interface AutoEffortInput {
  provider: string;
  modelId: string;
  supportedEfforts: readonly string[];
  request: string;
  added?: string;
  solutionSpace?: string;
  raiseOnly: boolean;
  current?: string;
}

export interface AutoEffortConfig {
  holdMaxChars: number;
  noticePrefixes: string[];
  tiers: { floor: AutoEffortFloor; models: string[] }[];
  xhighAsMax?: string[];
  capHigh?: string[];
}

export interface AutoEffortDecision {
  floor?: AutoEffortFloor;
  ceiling?: AutoEffortFloor;
  hold?: boolean;
  xhighAsMax?: true;
}

const NOTICE_PREFIXES = ["[자동 재개]", "[하네스 통지]"];
const FLOORS: readonly string[] = ["low", "medium", "high", "xhigh"];

/** Read only the flat private autoEffort block; no YAML dependency or core setting. */
export function parseAutoEffortConfig(raw: unknown): AutoEffortConfig {
  const config: AutoEffortConfig = { holdMaxChars: 20, noticePrefixes: [...NOTICE_PREFIXES], tiers: [] };
  if (typeof raw !== "string") return config;
  const lines = raw.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const start = lines.findIndex(line => /^autoEffort:\s*(?:#.*)?$/u.test(line));
  if (start < 0) return config;
  const fields: Record<string, string> = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s/u.test(line) && line.trim() !== "" && !line.startsWith("#")) break;
    const match = /^ {2}(holdMaxChars|floorMedium|floorHigh|xhighAsMax|capHigh):\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#"'\r\n]*?))\s*(?:#.*)?$/u.exec(line);
    if (match) fields[match[1]!] = (match[2] ?? match[3] ?? match[4] ?? "").trim();
  }
  const chars = fields.holdMaxChars;
  if (chars !== undefined && /^\d+$/u.test(chars)) {
    const value = Number(chars);
    if (Number.isSafeInteger(value)) config.holdMaxChars = value;
  }
  for (const key of ["floorMedium", "floorHigh", "xhighAsMax", "capHigh"] as const) {
    const value = fields[key];
    const models = value && !/^(?:[\[{]|-?\d+(?:\.\d+)?$|true$|false$|null$|~$)/u.test(value)
      ? value.split(",").map(pattern => pattern.trim()).filter(Boolean)
      : [];
    if (models?.length) {
      if (key === "xhighAsMax") config.xhighAsMax = models;
      else if (key === "capHigh") config.capHigh = models;
      else config.tiers.push({ floor: key === "floorMedium" ? "medium" : "high", models });
    }
  }
  return config;
}

export function decideAutoEffort(input: AutoEffortInput, config: AutoEffortConfig): AutoEffortDecision {
  const selector = `${input.provider}/${input.modelId}`;
  const matches = (pattern: string) => {
    const escaped = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*");
    return new RegExp(`^${escaped}$`, "isu").test(selector);
  };
  const floor = config.tiers.find(tier => tier.models.some(matches))?.floor;
  const ceiling = config.capHigh?.some(matches) ? "high" : undefined;
  const xhighAsMax = config.xhighAsMax?.some(matches) === true;
  const promoteMax = xhighAsMax && input.supportedEfforts.includes("max") && !input.supportedEfforts.includes("xhigh");
  const fromSolution = input.added === undefined && Boolean(input.solutionSpace?.trim());
  const evidence = (input.added ?? (fromSolution ? input.solutionSpace! : input.request)).trim();
  const ceilingIndex = ceiling === undefined ? FLOORS.length : FLOORS.indexOf(ceiling);
  const floorIndex = floor === undefined ? 0 : Math.min(FLOORS.indexOf(floor), ceilingIndex);
  const onlyOneLevel = (floor !== undefined || ceiling !== undefined) && input.supportedEfforts.filter(level =>
    (FLOORS.includes(level) && FLOORS.indexOf(level) >= floorIndex && FLOORS.indexOf(level) <= ceilingIndex) ||
    (promoteMax && level === "max" && ceiling === undefined)).length === 1;
  const hold = onlyOneLevel || config.noticePrefixes.some(prefix => evidence.startsWith(prefix)) ||
    (!fromSolution && [...evidence].length <= config.holdMaxChars);
  return { ...(floor === undefined ? {} : { floor }), ...(ceiling === undefined ? {} : { ceiling }), ...(hold ? { hold: true } : {}), ...(xhighAsMax ? { xhighAsMax: true } : {}) };
}
