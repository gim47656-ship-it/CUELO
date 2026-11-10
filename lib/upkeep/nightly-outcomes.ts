import { checkMetricIdFrom, MAX_CHECK_NOTE_LENGTH } from "./checks";
import { isFixableMetricId } from "./fixes";

export const NIGHTLY_OUTCOME_LIMIT = 100;
export const NIGHTLY_ARTIFACT_BYTES = 128 * 1024;
export interface NightlyMetricOutcome {
  source: string;
  metricId: string;
  checkedAt: string;
  disposition: "checked" | "fixed";
  note: string;
  evidence: string;
  requiredVersion?: string;
}
export const releaseVersion = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
export function parseMetricOutcomes(value: unknown, maxRows = NIGHTLY_OUTCOME_LIMIT): NightlyMetricOutcome[] | null {
  if (!Array.isArray(value) || value.length > maxRows) return null;
  const outcomes: NightlyMetricOutcome[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const { source, metricId, checkedAt, disposition, note, evidence, requiredVersion } = row;
    if (typeof source !== "string" || !/^[a-z0-9-]{1,63}$/.test(source)
      || !checkMetricIdFrom(row) || /^(bottleneck|memory|cost|complaints|skills|ops)\//.test(metricId)
      || typeof checkedAt !== "string" || checkedAt.length > 40 || !Number.isFinite(Date.parse(checkedAt))
      || (disposition !== "checked" && disposition !== "fixed")
      || typeof note !== "string" || !note.trim() || note.length > MAX_CHECK_NOTE_LENGTH
      || typeof evidence !== "string" || !evidence.trim() || evidence.length > 500
      || (disposition === "fixed" && (!isFixableMetricId(metricId) || !releaseVersion(requiredVersion)))
      || (disposition === "checked" && requiredVersion !== undefined)) return null;
    const key = `${source}/${metricId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    outcomes.push({ source, metricId, checkedAt, disposition, note, evidence, ...(requiredVersion ? { requiredVersion } : {}) });
  }
  return outcomes;
}
