/**
 * 아침 보고 세션(AGENTS.md 「Live deploy」 마지막 항목, 2026-11-04 사용자 결정). 각 PC의 `cuelo-cloud-sync.sh`가 2시간마다
 * 동기화 뒤 `POST /api/upkeep/morning`을 부르면, 지난 보고 뒤 클라우드 야간 루프가 바꾼 것(게시된 `wt/nightly-*` 커밋,
 * 이번에 받아 온 스킬), 새로 공개된 릴리스, 게시까지 가지 못한 야간 실행 결과(`nightly-result.json`)가 있을 때만 이 PC의 메인
 * 체크아웃에서 새 세션을 연다. 그 세션은 바뀐 것을 세 줄 안으로 알리고 새 릴리스를 이 PC에 설치한다. 마지막 보고는 agent
 * 디렉터리의 `cuelo-morning-report.json`에 남긴다.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { buildMorningPrompt } from "./morning-prompt";
import { type NightlyResult, parseNightlyResult, REPORTABLE_OUTCOMES } from "./nightly-result";
import { nightlySourceName } from "./nightly-inbox";
import { parseMetricOutcomes, releaseVersion, type NightlyMetricOutcome } from "./nightly-outcomes";
import { CHECK_MARKS_FILE, readCheckMarks, setCheckMark, clearCheckMark } from "./checks";
import { FIX_MARKS_FILE, readFixMarks, setFixMark, fixMarkTimeFrom } from "./fixes";
import { compareVersions } from "../omp-updates";

const exec = promisify(execFile);

export const MORNING_STATE_FILE = "cuelo-morning-report.json";
/** 비교할 기준 커밋이 없을 때 이 날 수 안의 야간 브랜치만 본다. 오래전 실행을 처음 보고하지 않게 한다. */
export const FIRST_RUN_WINDOW_DAYS = 3;
/** 스킬 폴더 이름 규칙(cuelo-cloud-sync.sh의 name_re와 같다). */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const NIGHTLY_REF_RE = /^origin\/wt\/nightly-(\d{4})(\d{2})(\d{2})$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DAY_MS = 86_400_000;

/** 클라우드 커밋을 셀 기준. 지난 보고 때 본 origin/main이거나, 그것이 없을 때 이 PC에 마지막으로 배포한 리비전. */
export interface MorningBase {
  sha: string;
  kind: "reported" | "deployed";
}

export interface MorningState {
  /** 마지막 보고 세션 */
  sessionId?: string;
  /** ISO 시각 */
  startedAt?: string;
  /** 그때 본 origin/main(40자 sha). 다음 보고는 이 커밋에 이미 들어간 것을 빼고 센다. origin/main을 못 봤으면 없다. */
  reportedSha?: string;
  /** 그때 알린 최신 공개 릴리스 버전 */
  releaseVersion?: string;
  /** 그때 알린 클라우드 야간 실행 결과의 `finishedAt`(ISO). 같은 결과를 다시 알리지 않는다. */
  nightlyResultAt?: string;
  nightlyImport?: { source: string; outcomes: NightlyMetricOutcome[]; settled: string[]; resultAt?: string };
}

export interface CloudCommit {
  sha: string;
  /** 커밋 시각(ISO) */
  committedAt: string;
  subject: string;
  /** 그 커밋이 바꾼 작업 기록(`doc/history/**.md`) */
  records: string[];
}

export interface ReleaseInfo {
  /** 이 서버가 실행 중인 버전 */
  current: string;
  /** 최신 공개 릴리스 버전. 공개 릴리스는 공개 CI가 성공한 커밋에만 생긴다(release.yml). */
  latest: string | null;
  available: boolean;
}

export interface MorningInput {
  repoCwd: string | null;
  /** 지금 origin/main 커밋. 모르면 null */
  originHead: string | null;
  /** 클라우드 커밋을 센 기준. 없으면 최근 며칠만 봤다. */
  base: MorningBase | null;
  cloudCommits: readonly CloudCommit[];
  /** 이번 동기화가 받아 온 스킬 이름 */
  skills: readonly string[];
  /** 클라우드가 남긴 마지막 야간 실행 결과. 없으면 null. */
  nightlyResult?: NightlyResult | null;
  /** 릴리스를 확인하지 못했으면 null */
  release: ReleaseInfo | null;
  state: MorningState | null;
  runningSessionIds: readonly string[];
  /** 이 서버가 마지막으로 연 보고 세션. 상태 기록에 실패했어도 그 세션이 도는 동안 하나 더 열지 않게 한다. */
  acceptedSessionId?: string | null;
  now: Date;
  /** 사람이 볼 확인 실패(가져오기 실패 등). 계획을 막지 않고 프롬프트에 싣는다. */
  warnings?: readonly string[];
}

export type MorningSkipReason = "nothing-new" | "no-repo" | "previous-still-running";

export interface MorningTriggers {
  cloudCommits: number;
  skills: number;
  /** 새로 알릴 릴리스 버전 */
  release: string | null;
  /** 새로 알릴 클라우드 야간 실행 결과. 깨끗하게 끝난 실행은 알리지 않으므로 null이다. */
  nightly: NightlyResult["outcome"] | null;
}

export type MorningPlan =
  | { action: "skip"; reason: MorningSkipReason }
  | {
    action: "run";
    repoCwd: string;
    triggers: MorningTriggers;
    /** 세션이 프롬프트를 받으면 상태에 남길 origin/main(모르면 지난 값) */
    reportedSha: string | null;
    releaseVersion: string | null;
    /** 세션이 프롬프트를 받으면 상태에 남길 야간 결과의 `finishedAt`. 알릴 결과가 없으면 null(지난 값 유지). */
    nightlyResultAt: string | null;
    sessionName: string;
    prompt: string;
  };

type RunPlan = Extract<MorningPlan, { action: "run" }>;

/** 저장된 마지막 보고. 파일이 없으면 null. 해석할 수 없으면 던져서 판단 없이 세션을 열지 않게 한다. */
export function readMorningState(agentDir: string): MorningState | null {
  let text: string;
  try {
    text = readFileSync(join(agentDir, MORNING_STATE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<MorningState> | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed.sessionId !== undefined && (typeof parsed.sessionId !== "string" || !parsed.sessionId))
    || (parsed.startedAt !== undefined && (typeof parsed.startedAt !== "string" || Number.isNaN(Date.parse(parsed.startedAt))))
    || Boolean(parsed.sessionId) !== Boolean(parsed.startedAt)
    || (!parsed.sessionId && parsed.nightlyImport === undefined)
    || (parsed.reportedSha !== undefined && (typeof parsed.reportedSha !== "string" || !SHA_RE.test(parsed.reportedSha)))
    || (parsed.releaseVersion !== undefined && (typeof parsed.releaseVersion !== "string" || !parsed.releaseVersion))
    || (parsed.nightlyResultAt !== undefined && (typeof parsed.nightlyResultAt !== "string" || !Number.isFinite(Date.parse(parsed.nightlyResultAt))))) {
    throw new Error(`${MORNING_STATE_FILE} is not a morning report record`);
  }
  if (parsed.nightlyImport !== undefined && (!parsed.nightlyImport || typeof parsed.nightlyImport !== "object"
    || !parseMetricOutcomes(parsed.nightlyImport.outcomes, Number.MAX_SAFE_INTEGER)
    || typeof parsed.nightlyImport.source !== "string" || !/^[a-z0-9-]{1,63}$/.test(parsed.nightlyImport.source)
    || (parsed.nightlyImport.resultAt !== undefined && (typeof parsed.nightlyImport.resultAt !== "string"
      || !Number.isFinite(Date.parse(parsed.nightlyImport.resultAt))))
    || parsed.nightlyImport.outcomes.some((row) => row.source !== parsed.nightlyImport!.source)
    || !Array.isArray(parsed.nightlyImport.settled) || parsed.nightlyImport.settled.some((id) => typeof id !== "string"
      || !parsed.nightlyImport!.outcomes.some((row) => row.metricId === id)))) {
    throw new Error(`${MORNING_STATE_FILE} has invalid nightly import state`);
  }
  return {
    sessionId: parsed.sessionId, startedAt: parsed.startedAt,
    ...(parsed.reportedSha ? { reportedSha: parsed.reportedSha } : {}),
    ...(parsed.releaseVersion ? { releaseVersion: parsed.releaseVersion } : {}),
    ...(parsed.nightlyResultAt ? { nightlyResultAt: parsed.nightlyResultAt } : {}),
    ...(parsed.nightlyImport ? { nightlyImport: parsed.nightlyImport } : {}),
  };
}

export function writeMorningState(agentDir: string, state: MorningState) {
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(join(agentDir, MORNING_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** 세션이 프롬프트를 받은 뒤 남길 기록. 이번에 모르는 값은 지난 기록을 잇는다. */
export function morningStateAfterRun(plan: RunPlan, previous: MorningState | null, sessionId: string, startedAt: string): MorningState {
  const reportedSha = plan.reportedSha ?? previous?.reportedSha;
  const releaseVersion = plan.releaseVersion ?? previous?.releaseVersion;
  const nightlyResultAt = plan.nightlyResultAt ?? previous?.nightlyResultAt;
  return {
    sessionId, startedAt,
    ...(reportedSha ? { reportedSha } : {}),
    ...(releaseVersion ? { releaseVersion } : {}),
    ...(nightlyResultAt ? { nightlyResultAt } : {}),
    ...(previous?.nightlyImport ? { nightlyImport: previous.nightlyImport } : {}),
  };
}

/** Import before report guards; the existing morning record retains pending evidence and replay watermarks. */
export function importNightlyOutcomes(input: {
  agentDir: string; state: MorningState | null; result?: unknown; now: Date; dryRun?: boolean;
  env?: Record<string, string | undefined>; release?: ReleaseInfo | null;
}): { state: MorningState | null; changed: boolean } {
  if (input.dryRun) return { state: input.state, changed: false };
  const env = input.env ?? process.env;
  const source = nightlySourceName(env, hostname());
  const result = parseNightlyResult(input.result);
  const previous = input.state?.nightlyImport;
  const outcomes = previous?.source === source ? [...previous.outcomes] : [];
  const settled = new Set(previous?.source === source ? previous.settled : []);
  let resultAt = previous?.source === source ? previous.resultAt : undefined;
  if (result?.version === 2 && result.source === source && Date.parse(result.finishedAt) <= input.now.getTime()
    && (!resultAt || Date.parse(result.finishedAt) > Date.parse(resultAt))) {
    resultAt = result.finishedAt;
    for (const row of result.outcomes ?? []) {
      if (Date.parse(row.checkedAt) > input.now.getTime()) continue;
      const index = outcomes.findIndex((old) => old.metricId === row.metricId);
      if (index >= 0 && Date.parse(outcomes[index].checkedAt) >= Date.parse(row.checkedAt)) continue;
      const importedRow = row.disposition === "fixed" && (result.outcome !== "clean" || result.leftoverCount > 0 || result.unpushed.length > 0)
        ? { source: row.source, metricId: row.metricId, checkedAt: row.checkedAt, disposition: "checked" as const, note: row.note, evidence: row.evidence }
        : row;
      // A failed re-review cannot revoke an already published fix still awaiting this PC's install.
      if (index >= 0 && row.disposition === "fixed" && importedRow.disposition === "checked"
        && outcomes[index].disposition === "fixed" && !settled.has(row.metricId)) continue;
      if (index >= 0) outcomes[index] = importedRow;
      else outcomes.push(importedRow);
      settled.delete(row.metricId);
    }
  }
  if (!outcomes.length && !resultAt) return { state: input.state, changed: false };
  // Read both stores before any write so an unreadable store cannot destroy unrelated marks.
  const checks = readCheckMarks(input.agentDir), fixes = readFixMarks(input.agentDir);
  for (const [file, marks] of [[CHECK_MARKS_FILE, checks], [FIX_MARKS_FILE, fixes]] as const) {
    try {
      const raw = JSON.parse(readFileSync(join(input.agentDir, file), "utf8"));
      if (Object.keys(raw).length !== Object.keys(marks).length
        || (file === CHECK_MARKS_FILE && Object.values(raw).some((value) => {
          const mark = value as { note?: unknown };
          return mark.note !== null && typeof mark.note !== "string";
        }))) throw new Error(`${file} has malformed marks; left unchanged`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let installedAt: string | null = null;
  try {
    const id = env.CUELO_DEPLOY_REQUEST_ID, hash = env.CUELO_DEPLOY_STAGE_HASH;
    if (id && /^[a-f0-9]{32}$/.test(id) && hash && /^[a-f0-9]{64}$/.test(hash)) {
      const receipt = JSON.parse(readFileSync(join(env.CUELO_EXTERNAL_UPDATE_ROOT || join(homedir(), ".omp/external-update"), "results", `${id}.json`), "utf8"));
      const d = receipt.deployment, service = d?.service;
      if (receipt.success === true && receipt.status === "succeeded" && receipt.requestId === id && receipt.stageHash === hash
        && d?.completed === true && d.writeSafe === true && d.requestId === id && d.stageHash === hash
        && service?.ready === true && service.exact === true && service.requestId === id && service.stageHash === hash
        && typeof d.completedAtUtc === "string" && fixMarkTimeFrom({ at: d.completedAtUtc }, input.now)) installedAt = d.completedAtUtc;
    }
  } catch { /* Missing or failed installation is pending, never a current-time fix. */ }
  let changed = false;
  for (const row of outcomes) {
    if (settled.has(row.metricId)) continue;
    const checked = Date.parse(row.checkedAt), check = checks[row.metricId], fix = fixes[row.metricId];
    if ((check && Date.parse(check.at) > checked) || (fix && Date.parse(fix) >= checked)) {
      settled.add(row.metricId);
      continue;
    }
    const current = input.release?.current;
    const published = input.release?.latest;
    const canFix = row.disposition === "fixed" && installedAt && releaseVersion(current) && releaseVersion(published)
      && compareVersions(current, row.requiredVersion) >= 0 && compareVersions(published, row.requiredVersion) >= 0;
    if (canFix) {
      if (!fix || Date.parse(fix) < Date.parse(installedAt!)) setFixMark(input.agentDir, row.metricId, new Date(installedAt!));
      if (check && Date.parse(check.at) === checked && check.note === row.note) clearCheckMark(input.agentDir, row.metricId);
      changed = true;
      settled.add(row.metricId);
    } else {
      if (checked >= input.now.getTime() - 7 * DAY_MS && (!check || Date.parse(check.at) < checked)) {
        setCheckMark(input.agentDir, row.metricId, new Date(row.checkedAt), row.note);
        changed = true;
      }
      if (row.disposition === "checked") settled.add(row.metricId);
    }
  }
  const kept = outcomes.filter((row) => !settled.has(row.metricId) || Date.parse(row.checkedAt) >= input.now.getTime() - 7 * DAY_MS);
  const state: MorningState = { ...input.state, nightlyImport: {
    source, outcomes: kept, settled: kept.filter((row) => settled.has(row.metricId)).map((row) => row.metricId),
    ...(resultAt ? { resultAt } : {}),
  } };
  if (JSON.stringify(state) !== JSON.stringify(input.state)) writeMorningState(input.agentDir, state);
  return { state, changed };
}

/** 요청 본문의 스킬 이름. 규칙에 맞는 것만 겹치지 않게 남긴다. */
export function parseSkillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === "string" && SKILL_NAME_RE.test(name)))];
}

export function planMorningRun(input: MorningInput): MorningPlan {
  const { state, release, skills, cloudCommits } = input;
  const newRelease = release?.available && release.latest && release.latest !== state?.releaseVersion ? release.latest : null;
  // 게시까지 못 간 야간 실행은 커밋이 없으므로 이 결과가 유일한 계기다. 모양이 맞지 않는 결과와 같은 결과(finishedAt)는 알리지 않는다.
  const nightlyResult = parseNightlyResult(input.nightlyResult);
  const nightly = nightlyResult && REPORTABLE_OUTCOMES.includes(nightlyResult.outcome)
    && nightlyResult.finishedAt !== state?.nightlyResultAt ? nightlyResult : null;
  if (!cloudCommits.length && !skills.length && !newRelease && !nightly) return { action: "skip", reason: "nothing-new" };
  if (!input.repoCwd) return { action: "skip", reason: "no-repo" };
  if ([state?.sessionId, input.acceptedSessionId].some((id) => id && input.runningSessionIds.includes(id))) return { action: "skip", reason: "previous-still-running" };
  return {
    action: "run",
    repoCwd: input.repoCwd,
    triggers: { cloudCommits: cloudCommits.length, skills: skills.length, release: newRelease, nightly: nightly?.outcome ?? null },
    reportedSha: input.originHead,
    releaseVersion: release?.latest ?? null,
    nightlyResultAt: nightly?.finishedAt ?? null,
    sessionName: `클라우드 변경 보고 ${kstStamp(input.now)}`,
    prompt: buildMorningPrompt({
      base: input.base,
      originHead: input.originHead,
      cloudCommits,
      skills,
      release,
      nightlyResult: nightly,
      warnings: input.warnings ?? [],
    }),
  };
}

function kstStamp(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * 아침 세션을 열 CUELO 메인 체크아웃. `CUELO_MORNING_REPO`가 있으면 그것, 없으면 `~/src/CUELO-private`(보수 점검과 같은 자리).
 * worktree(`.git`이 파일)는 메인 체크아웃이 아니므로 받지 않는다.
 */
export function findMorningRepo(env: Record<string, string | undefined> = process.env): string | null {
  const repo = env.CUELO_MORNING_REPO || join(homedir(), "src/CUELO-private");
  try {
    return statSync(join(repo, ".git")).isDirectory() && existsSync(join(repo, "HANDOFF.md")) ? repo : null;
  } catch {
    return null;
  }
}

async function git(repo: string, args: string[], timeout = 15_000): Promise<string> {
  return (await exec("git", ["-C", repo, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout;
}

async function isCommit(repo: string, rev: string): Promise<boolean> {
  try {
    await git(repo, ["cat-file", "-e", `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * origin을 받아 온 뒤, origin/main에 들어간 `origin/wt/nightly-*` 브랜치에서 기준 커밋 뒤의 커밋을 모은다. 기준은 지난 보고 때 본
 * origin/main, 그것이 없거나 이 저장소에 없으면 이 PC에 마지막으로 배포한 리비전이다. 둘 다 없을 때만 최근
 * FIRST_RUN_WINDOW_DAYS일 안의 야간 브랜치를 본다. 야간 브랜치는 그날 KST 03:00 뒤 커밋만 클라우드 것으로 센다(야간 실행은
 * 04:00 KST에 시작하고, 브랜치가 main 위에 다시 얹혀 앞선 PC 커밋을 품기 때문). 받아 오기에 실패하면 이미 받아 둔 참조로
 * 계산하고 경고를 남긴다.
 */
export async function collectCloudChanges(repo: string, baseline: { reported: string | null; deployed: string | null }, now: Date): Promise<{ originHead: string | null; base: MorningBase | null; commits: CloudCommit[]; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    await git(repo, ["fetch", "--prune", "--quiet", "origin"], 120_000);
  } catch {
    warnings.push("git fetch origin에 실패해 이미 받아 둔 참조로 봤습니다.");
  }
  let originHead: string | null = null;
  try {
    originHead = (await git(repo, ["rev-parse", "--verify", "origin/main^{commit}"])).trim() || null;
  } catch {
    warnings.push("origin/main을 찾지 못했습니다.");
    return { originHead, base: null, commits: [], warnings };
  }
  let base: MorningBase | null = null;
  if (baseline.reported && await isCommit(repo, baseline.reported)) base = { sha: baseline.reported, kind: "reported" };
  else {
    if (baseline.reported) warnings.push(`지난 보고 커밋 ${baseline.reported.slice(0, 12)}을 이 저장소에서 찾지 못했습니다.`);
    if (baseline.deployed && await isCommit(repo, baseline.deployed)) base = { sha: baseline.deployed, kind: "deployed" };
    else warnings.push(`비교할 기준 커밋이 없어 최근 ${FIRST_RUN_WINDOW_DAYS}일의 야간 실행만 봤습니다.`);
  }
  const since = base?.sha ?? null;
  const refs = (await git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/wt/"]))
    .split("\n").map((ref) => ref.trim()).filter((ref) => NIGHTLY_REF_RE.test(ref));
  const byCommit = new Map<string, CloudCommit>();
  for (const ref of refs) {
    // 브랜치 날짜(KST) 03:00. 야간 실행은 04:00에 시작한다.
    const [, y, m, d] = NIGHTLY_REF_RE.exec(ref)!;
    const start = Date.parse(`${y}-${m}-${d}T03:00:00+09:00`);
    if (!since && now.getTime() - start > FIRST_RUN_WINDOW_DAYS * DAY_MS) continue;
    try {
      await git(repo, ["merge-base", "--is-ancestor", ref, "origin/main"]);
    } catch {
      continue; // 아직 main에 게시되지 않은 야간 브랜치
    }
    const out = await git(repo, ["log", ref, ...(since ? [`^${since}`] : []), "--name-only", "--format=%x1e%H%x1f%cI%x1f%s"]);
    for (const block of out.split("\x1e").slice(1)) {
      const [head, ...files] = block.split("\n");
      const [sha, committedAt, subject] = head.split("\x1f");
      if (!sha || byCommit.has(sha) || !(Date.parse(committedAt) >= start)) continue;
      byCommit.set(sha, { sha, committedAt, subject: subject ?? "", records: files.filter((file) => /^doc\/history\/.+\.md$/.test(file)) });
    }
  }
  const commits = [...byCommit.values()].sort((a, b) => Date.parse(a.committedAt) - Date.parse(b.committedAt));
  return { originHead, base, commits, warnings };
}
