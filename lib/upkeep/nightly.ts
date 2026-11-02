/**
 * 야간 자율 개선 루프(AGENTS.md 「Nightly self-improvement loop」, 2026-11-02 사용자 결정). 매일 04:00(KST) 사용자
 * 타이머가 `POST /api/upkeep/nightly`를 부르면 새로 만든 보수 보고서에 점검 표시 없는 `problem` 행이 있을 때만
 * 새 worktree에서 CUELO 세션을 연다. 하루 한 번만 돌고, 지난 세션이 아직 돌면 새로 열지 않는다. 마지막 실행은
 * agent 디렉터리의 `cuelo-nightly-improve.json`에 남긴다.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { buildFullPrompt, kstDate } from "./prompt";
import type { UpkeepReport } from "./types";

export const NIGHTLY_STATE_FILE = "cuelo-nightly-improve.json";

export interface NightlyState {
  /** 실행한 날(KST, YYYY-MM-DD) */
  date: string;
  sessionId: string;
  worktree: string;
  /** ISO 시각 */
  startedAt: string;
}

export type NightlySkipReason = "no-problem" | "no-repo" | "already-ran-today" | "previous-still-running";

export type NightlyPlan =
  | { action: "skip"; reason: NightlySkipReason }
  | {
    action: "run";
    /** KST 날짜(YYYY-MM-DD) */
    date: string;
    repoCwd: string;
    /** `wt/nightly-YYYYMMDD` */
    branch: string;
    /** 계기가 된 `섹션/지표` id */
    problems: string[];
    prompt: string;
  };

/** 저장된 마지막 실행. 파일이 없으면 null. 읽거나 해석할 수 없으면 던져서 판단 없이 세션을 열지 않게 한다. */
export function readNightlyState(agentDir: string): NightlyState | null {
  let text: string;
  try {
    text = readFileSync(join(agentDir, NIGHTLY_STATE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<NightlyState> | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || typeof parsed.date !== "string" || typeof parsed.sessionId !== "string"
    || typeof parsed.worktree !== "string" || typeof parsed.startedAt !== "string") {
    throw new Error(`${NIGHTLY_STATE_FILE} is not a nightly run record`);
  }
  return { date: parsed.date, sessionId: parsed.sessionId, worktree: parsed.worktree, startedAt: parsed.startedAt };
}

export function writeNightlyState(agentDir: string, state: NightlyState) {
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(join(agentDir, NIGHTLY_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** 루프 규칙. 세션이 사람 없이 시작됐다는 것과 AGENTS.md의 경계를 첫 메시지에 싣는다. */
export const NIGHTLY_PREAMBLE = [
  "CUELO 야간 자율 개선 세션",
  "",
  "이 세션은 사람 없이 시작됐습니다. AGENTS.md 「Nightly self-improvement loop (user decision, 2026-11-02)」를 따릅니다.",
  "",
  "1. 아래 보수 점검 보고서의 `문제` 행을 먼저 처리하고, 근거가 뒷받침하는 것만 고칩니다. 원인이 확인되지 않으면 고치지 말고 조사 결과만 남깁니다.",
  "2. 이 worktree에서만 작업합니다. 메인 체크아웃이나 다른 저장소는 건드리지 않습니다.",
  "3. 바꾼 범위에 맞는 집중 검사(테스트·typecheck·lint)를 돌리고 결과를 남깁니다.",
  "4. 변경이 런타임이나 공개 문서에 닿으면 다음 patch 버전을 붙입니다. `cuelo-release-deploy` 스킬을 따라 CHANGELOG에 사용자가 알아볼 말로 `## [x.y.z]` 절을 쓰고, `Tools/CUELO_Setup`에서 `node files/set-release-version.js x.y.z`를 실행한 뒤, gate가 요구하는 대로 버전을 올린 다음에 `cross_review`를 돌립니다. 기록·HANDOFF만 바뀌면 버전은 그대로 둡니다.",
  "5. `git_integrate`(대상 main)로 게시하고, 그 커밋의 공개 CI 결과를 끝까지 확인합니다.",
  "6. 배포하지 않습니다. update.sh를 실행하지 않고, 서버를 재시작하지 않고, ~/cuelo-run을 건드리지 않습니다. 라이브 배포는 사용자 승인을 기다립니다.",
  "7. `ask`를 쓰지 않습니다(답할 사람이 없습니다). 승인이 필요한 일(삭제, 유료 fallback API를 포함한 비용, 다른 PC, CLI 업데이트, gate 면제, 호스트 시스템·네트워크 변경)은 하지 말고 보류 목록에 남깁니다.",
  "8. 끝에 한국어로 짧게 요약합니다: 고친 항목, 버전, push한 SHA, CI 결과, 배포 대기, 보류한 항목.",
].join("\n");

/** 점검 표시 없는 `problem` 행의 `섹션/지표` id */
export function openProblems(report: UpkeepReport): string[] {
  return report.sections.flatMap((section) => section.metrics
    .filter((metric) => metric.status === "problem" && !metric.check)
    .map((metric) => `${section.id}/${metric.id}`));
}

export function planNightlyRun(
  report: UpkeepReport,
  state: NightlyState | null,
  now: Date,
  runningSessionIds: readonly string[],
): NightlyPlan {
  const problems = openProblems(report);
  if (!problems.length) return { action: "skip", reason: "no-problem" };
  if (!report.repoCwd) return { action: "skip", reason: "no-repo" };
  const date = kstDate(now.toISOString());
  if (state?.date === date) return { action: "skip", reason: "already-ran-today" };
  if (state && runningSessionIds.includes(state.sessionId)) return { action: "skip", reason: "previous-still-running" };
  return {
    action: "run",
    date,
    repoCwd: report.repoCwd,
    branch: `wt/nightly-${date.replaceAll("-", "")}`,
    problems,
    prompt: `${NIGHTLY_PREAMBLE}\n\n---\n\n${buildFullPrompt(report)}`,
  };
}
