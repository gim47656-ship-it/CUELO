import { CHECK_MARK_NOTE_ERROR, checkMetricIdFrom, checkNoteFrom, checkVerdictFrom, clearCheckMark, updateCheckMark } from "@/lib/upkeep/checks";
import { changeUpkeepMark } from "@/lib/upkeep/mark-request";

export const dynamic = "force-dynamic";

const INVALID_CHECK_ID = "metricId must be a non-empty metric id";

/** POST { metricId, note?, verdict? } saves a manual check; DELETE clears it. */
export function POST(req: Request) {
  return changeUpkeepMark(req, checkMetricIdFrom, INVALID_CHECK_ID, (agentDir, metricId, body) => {
    const note = checkNoteFrom(body);
    if (note === undefined) return CHECK_MARK_NOTE_ERROR;
    const verdict = checkVerdictFrom(body);
    if (verdict === undefined) return "verdict must be real or false-positive";
    const supplied = body as Record<string, unknown>;
    updateCheckMark(agentDir, metricId, new Date(), "note" in supplied ? note : undefined, "verdict" in supplied ? verdict : undefined);
  });
}

export function DELETE(req: Request) {
  return changeUpkeepMark(req, checkMetricIdFrom, INVALID_CHECK_ID, clearCheckMark);
}
