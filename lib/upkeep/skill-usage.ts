/**
 * 스킬 사용 계기판(2026-11-04 사용자 결정). 세션 스캔(`./sessions`)이 성공한 `read skill://<이름>` 호출을 세고, 연 턴에서
 * 그 뒤 도구 오류가 같은 세션의 나머지보다 많았는지를 함께 센다. 이 값은 함께 나타난 정도일 뿐 스킬이 원인이라는 판정이
 * 아니다. 설치된 스킬 목록은 관리 스킬(`managed-skills`)과 사용자 스킬(`skills`) 폴더에서 읽는다.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { compare } from "./criteria";
import type { UpkeepStatus } from "./types";

/** 만든(SKILL.md를 마지막으로 고친) 지 이보다 덜 된 스킬은 안 쓰인다고 판정하지 않는다(삭제 제안에서 뺀다). */
export const YOUNG_SKILL_MS = 30 * 86_400_000;

export type SkillScope = "managed" | "user" | "other";

/** 한 기간(7일)의 스킬 하나 사용. 오류 수는 `errors`와 같은 기준(사용자 중단·검색 무일치 제외)이다. */
export interface SkillWindowUsage {
  opens: number;
  sessions: number;
  /** ISO 시각. 그 기간에 열지 않았으면 null */
  lastOpenedAt: string | null;
  /** 스킬을 연 턴에서 연 뒤 낸 도구 호출과 그중 오류 */
  afterCalls: number;
  afterFailures: number;
  /** 스킬을 연 세션들의 나머지 호출과 오류 */
  restCalls: number;
  restFailures: number;
  /** 스킬을 연 턴 수와, 그 턴 다음 사용자 요청에 지적 표현이 있었던 턴 수 */
  openTurns: number;
  complaintTurns: number;
}

/** 스킬을 연 세션 하나. 근거 사례로 보인다. */
export interface SkillSessionUsage {
  sessionId: string;
  sessionPath: string;
  opens: number;
  afterCalls: number;
  afterFailures: number;
  lastOpenedAt: string;
}

export interface SkillUsageRow {
  name: string;
  scope: SkillScope;
  current: SkillWindowUsage;
  previous: SkillWindowUsage;
  /** 최근 7일 연관 판정(`skillAssociationStatus`) */
  status: UpkeepStatus;
  /** 최근 7일 연 세션, 연 뒤 오류가 많은 순 최대 10개(묶음에는 싣지 않는다) */
  sessions?: SkillSessionUsage[];
}

export interface UnusedSkill {
  name: string;
  scope: Exclude<SkillScope, "other">;
  /** SKILL.md를 고친 지 30일이 안 됨. 아직 판정하지 않는다. */
  young: boolean;
}

export interface SkillUsageReport {
  rows: SkillUsageRow[];
  /** 스캔한 14일 동안 한 번도 열지 않은 설치 스킬 */
  unused: UnusedSkill[];
}

export function emptySkillWindow(): SkillWindowUsage {
  return { opens: 0, sessions: 0, lastOpenedAt: null, afterCalls: 0, afterFailures: 0, restCalls: 0, restFailures: 0, openTurns: 0, complaintTurns: 0 };
}

/** `skill://name`, `skill://name/sub/file.md`, `skill://name:10-20` → `name`. 스킬 주소가 아니면 null. */
export function skillNameFromPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const match = /^skill:\/\/([^/:?#\s]+)/.exec(path.trim());
  return match ? match[1] : null;
}

/**
 * 연 뒤 오류율이 같은 세션의 나머지보다 나쁜지. 기간 비교와 같은 기준(50% 넘게 높으면 주의, 2배면 문제)과 같은 표본 규칙
 * (양쪽 호출 MIN_SAMPLE 이상)을 쓴다. 표본이 모자라면 `unknown`이다.
 */
export function skillAssociationStatus(w: SkillWindowUsage): UpkeepStatus {
  const rate = (failures: number, calls: number) => (calls ? failures / calls : null);
  return compare(rate(w.afterFailures, w.afterCalls), rate(w.restFailures, w.restCalls), w.afterCalls, w.restCalls);
}

export interface InstalledSkill {
  name: string;
  scope: Exclude<SkillScope, "other">;
  /** SKILL.md 수정 시각(ms) */
  modifiedAt: number;
}

/** 관리 스킬과 사용자 스킬 폴더에서 `SKILL.md`가 있는 하위 폴더. 이름이 겹치면 관리 스킬로 본다. 읽지 못한 폴더는 경고로 남긴다. */
export async function installedSkills(agentDir: string): Promise<{ skills: InstalledSkill[]; warnings: string[] }> {
  const skills = new Map<string, InstalledSkill>();
  const warnings: string[] = [];
  for (const [folder, scope] of [["managed-skills", "managed"], ["skills", "user"]] as const) {
    let entries;
    try {
      entries = await readdir(join(agentDir, folder), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${scope === "managed" ? "관리" : "사용자"} 스킬 폴더를 읽지 못했습니다.`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skills.has(entry.name)) continue;
      try {
        const info = await stat(join(agentDir, folder, entry.name, "SKILL.md"));
        skills.set(entry.name, { name: entry.name, scope, modifiedAt: info.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/**
 * 스캔 결과(스킬별 두 기간 사용)와 설치 목록을 합친다. 행은 최근 7일 열람이 많은 순이다. 세션 기록을 다 읽지 못했으면
 * (`historyComplete` false) 열지 않았다고 말할 수 없으므로 `unused`를 비운다.
 */
export function buildSkillUsage(
  windows: readonly [Record<string, SkillWindowUsage>, Record<string, SkillWindowUsage>],
  sessions: Record<string, SkillSessionUsage[]>,
  installed: readonly InstalledSkill[],
  now: number,
  historyComplete = true,
): SkillUsageReport {
  const scopeOf = new Map(installed.map((s) => [s.name, s.scope]));
  const names = new Set([...Object.keys(windows[0]), ...Object.keys(windows[1])]);
  const rows = [...names].map((name): SkillUsageRow => {
    const current = windows[0][name] ?? emptySkillWindow();
    return {
      name,
      scope: scopeOf.get(name) ?? "other",
      current,
      previous: windows[1][name] ?? emptySkillWindow(),
      status: skillAssociationStatus(current),
      sessions: sessions[name] ?? [],
    };
  }).sort((a, b) => b.current.opens - a.current.opens || b.previous.opens - a.previous.opens || a.name.localeCompare(b.name));
  const unused = historyComplete
    ? installed.filter((s) => !names.has(s.name)).map((s): UnusedSkill => ({ name: s.name, scope: s.scope, young: now - s.modifiedAt < YOUNG_SKILL_MS }))
    : [];
  return { rows, unused };
}
