import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UpkeepDueItem } from "./types";

const SECTIONS = new Set(["다음 행동", "관찰 대기", "남은 일과 다음 행동", "다음 행동과 남은 경계"]);
export const HANDOFF_PATHS = ["HANDOFF.md", "Tools/CUELO_Setup/HANDOFF.md", "Tools/OMP_Global_Config/HANDOFF.md"];

export function parseHandoff(text: string, path: string, now = new Date()): UpkeepDueItem[] {
  const lines = text.split(/\r?\n/);
  const items: UpkeepDueItem[] = [];
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const heading = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (heading) { section = SECTIONS.has(heading[1]) ? heading[1] : ""; continue; }
    if (!section || !/^-\s+/.test(lines[i])) continue;
    const body = [lines[i]];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || (!lines[i + 1].trim() && /^\s+\S/.test(lines[i + 2] ?? "")))) body.push(lines[++i]);
    const full = body.join("\n");
    const title = /^-\s+\*\*(.+?)(?:[:：]\*\*|\*\*[:：])/.exec(lines[i - body.length + 1])?.[1] ?? lines[i - body.length + 1].replace(/^-\s+/, "");
    const titleDate = /\((\d{1,2})-(\d{1,2})/.exec(title);
    const titleDue = /(\d{1,2})-(\d{1,2})\s*(?:후속 점검|닫기 판정|점검)/.exec(title);
    const bodyText = full.slice(full.indexOf("**", full.indexOf("**") + 2) + 2);
    // 단서는 lookahead로 둬서 한 날짜의 단서 구간이 뒤 날짜를 삼키지 않게 하고, 「…에 … 다시 센다」는 한 문장 안에서만 본다.
    const bodyDates = [...bodyText.matchAll(/(\d{1,2})-(\d{1,2})(?=\s*(?:점검|판정|쯤|까지|뒤에|(?:오전|오후)?\s*에\s*(?:다시|만료))|에(?:(?![.。!?！？]\s|\n).){0,120}?(?:다시 센다|함께 센다))/g)];
    const dateOrder = (x: RegExpExecArray) => +x[1] * 100 + +x[2] + (titleDate && +x[1] < +titleDate[1] - 6 ? 1200 : 0);
    // 제목 날짜(작성일)와 같은 날짜는 「그날 한 일」이므로 본문 날짜는 그보다 뒤일 때만 점검일로 본다.
    const titleOrder = titleDate ? +titleDate[1] * 100 + +titleDate[2] : 0;
    const dates = [titleDue, ...bodyDates]
      .filter((x): x is RegExpExecArray => x !== null)
      .filter((x) => x === titleDue || !titleDate || dateOrder(x) > titleOrder)
      .sort((x, y) => dateOrder(x) - dateOrder(y));
    // 재발·신고 조건부 항목은 본문 날짜가 있어도 기한이 없고, 제목에 점검일을 적었을 때만 그 날짜를 따른다.
    // 「때만」은 알림 조건에도 쓰이므로 어떤 날짜 단서도 없을 때만 조건부로 본다.
    const late = /다음은\s*(\d{1,2})월\s*(상순|중순|하순)/.exec(full);
    const deploy = /배포\s*(?:(?:뒤|후)\s*7일\s*(?:동안|간)|7일\s*(?:뒤|후))/.test(full) && titleDate;
    const conditional = /재발하면|신고가 오면/.test(full) || (/때만/.test(full) && !dates.length && !late && !deploy);
    const dateMatch = conditional ? titleDue : dates[0];
    let month: number | undefined, day: number | undefined;
    let dueKind: UpkeepDueItem["dueKind"] = "none";
    if (dateMatch) { month = +dateMatch[1]; day = +dateMatch[2]; dueKind = "date"; }
    else if (conditional) dueKind = "condition";
    else if (late) { month = +late[1]; day = late[2] === "상순" ? 5 : late[2] === "중순" ? 15 : 25; dueKind = "date"; }
    else if (deploy) { month = +deploy[1]; day = +deploy[2]; dueKind = "after-deploy"; }
    let dueDate: string | null = null;
    if (month && day && month <= 12 && day <= 31) {
      const local = new Date(now.getTime() + 9 * 3600_000);
      const currentMonth = local.getUTCMonth() + 1;
      const year = local.getUTCFullYear() + (month < currentMonth - 6 ? 1 : month > currentMonth + 6 ? -1 : 0);
      if (!dateMatch && late) day = Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate());
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
        if (dueKind === "after-deploy") date.setUTCDate(date.getUTCDate() + 7);
        dueDate = date.toISOString().slice(0, 10);
      } else dueKind = "none";
    }
    const today = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
    items.push({ ref: { path, title, text: full }, section, dueDate, dueKind, overdue: dueDate !== null && dueDate < today });
  }
  return items;
}

export function readHandoffs(repo: string | null, now: Date): { items: UpkeepDueItem[]; warnings: string[] } {
  if (!repo) return { items: [], warnings: ["저장소를 찾지 못해 HANDOFF를 읽을 수 없습니다."] };
  const items: UpkeepDueItem[] = [], warnings: string[] = [];
  for (const path of HANDOFF_PATHS) {
    try { items.push(...parseHandoff(readFileSync(join(repo, path), "utf8"), path, now)); }
    catch { warnings.push(`${path}을 읽을 수 없습니다.`); }
  }
  return { items, warnings };
}
