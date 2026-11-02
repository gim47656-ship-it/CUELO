import { CHECK_MARK_NOTE_ERROR, checkMetricIdFrom, checkNoteFrom, clearCheckMark, setCheckMark } from "@/lib/upkeep/checks";
import { changeUpkeepMark } from "@/lib/upkeep/mark-request";

export const dynamic = "force-dynamic";

const INVALID_CHECK_ID = "metricId must be a non-empty metric id";

/** POST { metricId, note? } → 점검 표시를 지금 시각으로 남기고, DELETE { metricId } → 지운 뒤 새로 만든 보고서. */
export function POST(req: Request) {
  return changeUpkeepMark(req, checkMetricIdFrom, INVALID_CHECK_ID, (agentDir, metricId, body) => {
    const note = checkNoteFrom(body);
    if (note === undefined) return CHECK_MARK_NOTE_ERROR;
    setCheckMark(agentDir, metricId, new Date(), note);
  });
}

export function DELETE(req: Request) {
  return changeUpkeepMark(req, checkMetricIdFrom, INVALID_CHECK_ID, clearCheckMark);
}
