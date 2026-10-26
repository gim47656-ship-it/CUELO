import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { onSessionLifecycle } from "./lib/session-identity";

/**
 * 보고 차트 누락 알림. 2026-10-19 사용자 결정(전역 `AGENTS.md` 「사용자 보고」): 기록 수치의 비교·추이·분해에 값이
 * 셋 이상이면 Mermaid 차트 하나를 붙인다. 같은 날 Main이 조각 세 개의 실행 시간(20.8분·34.6분·42.0분)을 `ask` 바로 앞
 * 한 문장에 적고 차트를 빠뜨렸다. 규칙은 문맥에 있었으므로 문구만 고쳐서는 재발을 막지 못한다고 보고, 본문에서 같은 종류의
 * 수치 셋 이상을 결정론적으로 찾아 한 번 일깨운다. 차트를 그릴지는 모델이 수치의 출처·비교 여부로 정한다(알림은 차단이 아니다).
 */

export const REMINDER_TYPE = "report-chart-guard";
export const MIN_VALUES = 3;
// 표 전체(열·행이 달라도)는 2×2 전후 비교가 되는 4개부터 센다. 열마다 뜻이 다른 표의 값 셋은 비교로 보지 않는다.
export const MIN_TABLE_VALUES = 4;

type Message = { role?: string; content?: unknown; synthetic?: boolean; attribution?: string };

// 단위를 같은 종류로 묶는다. 시간끼리, 크기끼리는 단위가 달라도 같은 축에 놓일 수 있다.
// 셈 단위(건·회)는 서로 다른 것을 세는 일이 많아 따로 묶는다(2026-10-19 재생: "1건, 11회, 2건" 같은 나열 오탐).
const UNIT_KIND: Readonly<Record<string, string>> = {
  ms: "time", s: "time", "초": "time", "분": "time", "시간": "time",
  "%": "percent", "배": "ratio", "건": "count-건", "회": "count-회",
  KB: "size", MB: "size", GB: "size", KiB: "size", MiB: "size", GiB: "size",
};
// 버전(0.10.38)·시각(04:48)·날짜(10-19)·경로 조각 안의 숫자는 수치로 보지 않는다(앞뒤 문자 경계). 구간 뒤쪽 끝(1~2분)도 뺀다.
// 단위 바로 뒤에 다른 낱말이 붙으면(배포·분석·회의·초기·건너…) 단위가 아니다. 회차(1회차)는 순번이다.
// 천 단위 쉼표 수(1,395건)는 한 값이다.
const QUANTITY =
  /(?<![\d.:/\-A-Za-z_~∼]|\d,|[~∼]\s+)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(ms|s|초|분|시간|%|배|건|회|KiB|MiB|GiB|KB|MB|GB)(?![A-Za-z\d])(?!차)(?!(?:포|치|열|석|류|기|화|의|수|복|너|당|위|면|산|간|리|야|장|별)[가-힣])/g;
// 비교할 기록 값이 아닌 말씨만 뺀다: 추정("약 7MB"·"7분쯤"), 구간("10분~20분"), 주기("1분마다"·"3ms 간격"), 한계 이름("5초 제한"),
// 진행 순번("25분째"), 전체 중 일부("17건 중 16건"의 앞 값). 최대·최소·이상·이하·0건은 실제 기록일 수 있어 건드리지 않는다.
const NOT_A_RECORD_BEFORE = /(?<![가-힣])(?:약|대략|거의|(?:제한|한도|상한|하한)[은는이가]?\s?[:：]?)\s?$/; // "계약 2건"·"권한도 2건"의 약·한도는 낱말 일부다.
const NOT_A_RECORD_AFTER = /^(?:\s*[~∼]|\s?(?:마다|간격|쯤|정도|가량|째|제한|한도|상한|중(?:에서?|으로)?(?![가-힣])))/;
// 한 시간 값이 "5분 15초"처럼 큰 단위 뒤에 작은 단위로 이어지면 하나로 센다.
const TIME_RANK: Readonly<Record<string, number>> = { ms: 0, s: 1, "초": 1, "분": 2, "시간": 3 };

type Quantity = { value: string; kind: string; start: number; end: number; unit: string };

/** 한 조각(문단·표 칸)에서 비교할 만한 수치를 순서대로 뽑는다. */
function quantitiesOf(segment: string): Quantity[] {
  const raw: Quantity[] = [];
  for (const match of segment.matchAll(QUANTITY)) {
    const kind = UNIT_KIND[match[2]!];
    if (kind) raw.push({ value: `${match[1]}${match[2]}`, kind, start: match.index!, end: match.index! + match[0].length, unit: match[2]! });
  }
  const merged: Quantity[] = [];
  for (const q of raw) {
    const prev = merged[merged.length - 1];
    const rank = TIME_RANK[q.unit];
    if (prev && rank !== undefined && TIME_RANK[prev.unit] !== undefined && rank < TIME_RANK[prev.unit]! && /^[ \t]?$/.test(segment.slice(prev.end, q.start))) {
      prev.value = `${prev.value} ${q.value}`;
      prev.end = q.end;
      prev.unit = q.unit;
      continue;
    }
    merged.push({ ...q });
  }
  return merged.filter((q) => !NOT_A_RECORD_BEFORE.test(segment.slice(0, q.start)) && !NOT_A_RECORD_AFTER.test(segment.slice(q.end)));
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

// 산문 블록의 경계: 제목·굵은 글씨만 있는 라벨 줄은 새 블록이다(라벨 바로 뒤 빈 줄은 넘는다). 빈 줄 뒤도 새 블록이지만
// 목록 항목 사이의 빈 줄(들여쓴 이어 줄 포함)과 ":"로 끝난 소개 문단 뒤 목록 앞의 빈 줄은 넘는다.
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const LABEL_LINE = /^\s*(?:#{1,6}\s|\*\*[^*\n]+\*\*[:：]?\s*$)/;
// 같은 블록 안에 비교 말씨가 있으면 값이 서로 견주어졌다고 본다. 이 말씨나 표·목록 구조가 없는 산문 묶음은 "모호한 후보"다.
const COMPARATIVE = /(각각|비교|대비|보다|\bvs\b|→|->|전후|변경 전|변경 후|전에는|후에는|차이|늘었|줄었|늘어|줄어|증가|감소|느려|빨라|개선|악화)/;

export type ChartCandidate = { kind: string; values: string[]; strong: boolean };

// 라벨+값이 쉼표·세미콜론·가운뎃점·와/과로 이어진 반복 측정("빌드 20.8분, 배포 34.6분, 검증 42.0분")은 서로 다른 값 셋 이상이면
// 나열된 비교로 본다. 값 사이 글이 구분자로 시작하고 짧은 라벨뿐이어야 한다(문장·괄호·종결 부호가 끼면 이어진 나열이 아니다).
const CHAIN_GAP = /^\s?(?:[,;·/、]|[와과]|및)\s?([^,;.!?()（）|\n]{0,14})$/;
function hasLabelledRun(text: string): boolean {
  const quantities = quantitiesOf(text);
  let run: string[] = [];
  for (const [i, q] of quantities.entries()) {
    const prev = quantities[i - 1];
    const label = prev ? CHAIN_GAP.exec(text.slice(prev.end, q.start))?.[1] : undefined;
    if (prev && prev.kind === q.kind && label !== undefined && label.trim() !== "") run.push(q.value);
    else run = [q.value];
    if (new Set(run).size >= MIN_VALUES) return true;
  }
  return false;
}

/**
 * 값이 셋 이상인 같은 종류의 수치 묶음. 없으면 null. Mermaid 블록이 이미 있으면 판정하지 않는다.
 * 한 묶음은 같은 비교 구조 안의 값이다: 표는 열 하나·행 하나 안의 서로 다른 값 셋, 또는 표 전체의 같은 종류 칸 넷(서로 다른 값 셋 이상,
 * 2×2 전후 비교). 표 밖은 한 문단·한 목록(제목·라벨·빈 줄로 갈라지는 블록) 안의 값이다. 서로 다른 블록의 값은 합치지 않는다.
 */
export function chartCandidate(text: string): ChartCandidate | null {
  if (/```\s*mermaid\b/i.test(text)) return null;
  // 코드 블록·인라인 코드 안의 수치(명령·로그)는 보고 수치로 세지 않는다.
  const prose = text.replace(/\n?```[\s\S]*?(?:```|$)\n?/g, "\n").replace(/`[^`\n]*`/g, " ");
  const series = new Map<string, Map<string, string[]>>();
  const add = (key: string, q: Quantity) => {
    const kinds = series.get(key) ?? new Map<string, string[]>();
    const list = kinds.get(q.kind) ?? [];
    list.push(q.value);
    kinds.set(q.kind, list);
    series.set(key, kinds);
  };
  const lines = prose.split("\n");
  let block = 0;
  let pendingBreak = false;
  let prevList = false;
  let labelOpen = false;
  let introColon = false;
  const proseLines = new Map<number, string[]>();
  const toProse = (line: string) => {
    if (line.trim() === "") { pendingBreak = true; return; }
    const isList = LIST_ITEM.test(line);
    const isLabel = LABEL_LINE.test(line);
    const listAfterIntro = pendingBreak && isList && !prevList && introColon;
    // 굵은 라벨이 목록 항목 바로 뒤에 오면 라벨별로 묶인 한 목록이다. 제목(#)과 산문 뒤 라벨은 새 블록이다.
    const groupedLabel = isLabel && prevList && !pendingBreak && !/^\s*#/.test(line);
    const continuation = prevList && !isList && /^\s{2,}\S/.test(line); // 목록 항목의 들여쓴 이어 줄은 빈 줄 뒤에도 그 항목 소속이다.
    if ((isLabel && !groupedLabel && !continuation) || (pendingBreak && !labelOpen && !listAfterIntro && !continuation && !(prevList && isList))) block += 1;
    labelOpen = isLabel;
    pendingBreak = false;
    prevList = isList || (prevList && (groupedLabel || /^\s{2,}\S/.test(line)));
    introColon = /[:：]\s*$/.test(line);
    const list = proseLines.get(block) ?? [];
    list.push(line);
    proseLines.set(block, list);
  };
  // 머리글 구분선(---|---) 바로 앞 줄부터 `|`가 있는 줄까지가 표다. 바깥 파이프가 없는 표도 포함한다.
  const isSeparator = (line: string | undefined) => line !== undefined && line.includes("|") && /^[\s|:\-]+$/.test(line) && line.includes("-");
  let table = 0;
  let row = 0;
  let inTable = false;
  const tableCells = new Map<string, number>(); // 표 번호|종류 → 그 종류 수치가 든 칸 수
  lines.forEach((line, i) => {
    const newBlock = !/^\s*\|/.test(line) && /^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(line); // 제목·인용·목록 줄은 표가 아니라 새 블록이다.
    if (!line.includes("|") || newBlock || !(inTable || isSeparator(lines[i + 1]) || isSeparator(line))) {
      inTable = false;
      toProse(line);
      return;
    }
    if (!inTable) { inTable = true; table += 1; row = 0; pendingBreak = true; prevList = false; labelOpen = false; introColon = false; }
    if (isSeparator(line)) return;
    row += 1;
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").forEach((cell, col) => {
      const quantities = quantitiesOf(cell);
      for (const q of quantities) { add(`t${table}c${col}`, q); add(`t${table}r${row}`, q); add(`t${table}`, q); }
      for (const kind of new Set(quantities.map((q) => q.kind))) tableCells.set(`${table}|${kind}`, (tableCells.get(`${table}|${kind}`) ?? 0) + 1);
    });
  });
  for (const [id, blockLines] of proseLines) for (const q of quantitiesOf(blockLines.join("\n"))) add(`p${id}`, q);
  // 강한 후보: 표 열·행·전체, 또는 목록 항목 셋 이상이 각각 같은 종류 값을 가진 블록, 또는 비교 말씨가 있는 블록.
  const isStrong = (key: string, kind: string): boolean => {
    if (key.startsWith("t")) return true;
    const blockLines = proseLines.get(Number(key.slice(1))) ?? [];
    // 목록 항목 = 목록 줄 + 들여쓴 이어 줄. 값은 항목 안 어디에 있어도 된다.
    const itemTexts: string[] = [];
    for (const line of blockLines) {
      if (LIST_ITEM.test(line)) itemTexts.push(line);
      else if (itemTexts.length > 0 && /^\s{2,}\S/.test(line)) itemTexts[itemTexts.length - 1] += `\n${line}`;
    }
    const items = itemTexts.filter((item) => quantitiesOf(item).some((q) => q.kind === kind)).length;
    const blockText = blockLines.join("\n");
    return items >= MIN_VALUES || COMPARATIVE.test(blockText) || hasLabelledRun(blockText);
  };
  let best: ChartCandidate | null = null;
  for (const [key, kinds] of series) {
    const wholeTable = /^t\d+$/.test(key);
    for (const [kind, cells] of kinds) {
      const values = [...new Set(cells)];
      if (values.length < MIN_VALUES || (wholeTable && (tableCells.get(`${key.slice(1)}|${kind}`) ?? 0) < MIN_TABLE_VALUES)) continue;
      const strong = isStrong(key, kind);
      if (!best || (strong && !best.strong) || (strong === best.strong && values.length > best.values.length)) best = { kind, values, strong };
    }
  }
  return best;
}

export function reminderText(candidate: { values: string[] }): string {
  const shown = candidate.values.slice(0, 6).join(", ");
  return `직전 사용자 표시 문장에 같은 종류의 수치가 ${candidate.values.length}개 있었다(${shown}). 그런데 Mermaid 차트가 없었다. `
    + "이 값들이 도구 출력·실행 기록·측정 산출물에서 온 비교·추이·분해라면, 바로 다음 응답에 출처와 함께 차트 하나(`xychart-beta` 막대, `gantt` 시간선 등)를 붙인다. "
    + "`ask` 질문 앞 근거 문장, 진행 중 중간 보고도 보고다. 비교가 아니거나(서로 무관한 값의 나열) 추정치라면 차트를 그리지 않는다. 그때 답이 이미 끝났다면 아무 문장도 덧붙이지 말고 끝내고, 어느 경우든 이 알림을 사용자에게 언급하지 않는다.";
}

export default function reportChartGuard(pi: ExtensionAPI): void {
  let reminded = false;
  // 같은 응답의 `ask` 호출을 막을 때 쓰는 알림. 수치를 보여 주고 바로 결정을 묻는 경우는 차트 없이 결정하게 두지 않는다.
  let askHold: string | undefined;
  const reset = () => { reminded = false; askHold = undefined; };
  onSessionLifecycle(pi, { start: reset });
  pi.on("session_shutdown", reset);
  // 사용자 직접 입력 하나에 한 번만 알린다. 알림이 만든 이어 가기 응답이 다시 차트 없이 끝나도 반복하지 않는다.
  pi.on("message_start", (event) => {
    const message = event.message as Message;
    if (message.role === "user" && message.synthetic !== true && message.attribution !== "agent") reset();
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message as Message;
    if (reminded || message.role !== "assistant" || ctx.agent.kind !== "main") return;
    const candidate = chartCandidate(textOf(message.content));
    if (!candidate) return;
    const calls = Array.isArray(message.content)
      ? message.content.filter((block): block is { type: string; name?: string } => block?.type === "toolCall")
      : [];
    // 이미 끝난 답을 다시 여는 강제 이어 가기는 표·목록·비교 말씨가 있는 후보에만 쓴다. 값만 나열된 모호한 산문은 조용히 둔다.
    if (calls.length === 0 && !candidate.strong) return;
    reminded = true;
    if (calls.some((call) => call.name === "ask")) {
      askHold = `[report-chart-guard] 질문을 보내지 않았다. ${reminderText(candidate)} 차트가 필요하면 차트를 붙인 응답에서 같은 질문을 다시 보낸다. 필요 없으면 같은 질문을 그대로 다시 보낸다.`;
      return;
    }
    // 도구를 부르는 중이면 다음 단계 경계에서, 답이 끝났으면 바로 이어 가는 내부 continuation으로 전달한다.
    pi.sendMessage(
      { customType: REMINDER_TYPE, content: reminderText(candidate), display: false, attribution: "agent" },
      calls.length > 0 ? { deliverAs: "aside" } : { deliverAs: "nextTurn", triggerTurn: true },
    );
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== "ask" || askHold === undefined) return;
    const reason = askHold;
    askHold = undefined;
    return { block: true, reason };
  });
}
