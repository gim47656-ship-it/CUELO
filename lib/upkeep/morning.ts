/**
 * 아침 보고 세션(AGENTS.md 「Live deploy」 마지막 항목, 2026-11-04 사용자 결정). 각 PC의 `cuelo-cloud-sync.sh`가 2시간마다
 * 동기화 뒤 `POST /api/upkeep/morning`을 부르면, 지난 보고 뒤 클라우드 야간 루프가 바꾼 것(게시된 `wt/nightly-*` 커밋,
 * 이번에 받아 온 스킬)이나 새로 공개된 릴리스가 있을 때만 이 PC의 메인 체크아웃에서 새 세션을 연다. 그 세션은 바뀐 것을
 * 세 줄 안으로 알리고 새 릴리스를 이 PC에 설치한다. 마지막 보고는 agent 디렉터리의 `cuelo-morning-report.json`에 남긴다.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { buildMorningPrompt } from "./morning-prompt";

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
  sessionId: string;
  /** ISO 시각 */
  startedAt: string;
  /** 그때 본 origin/main(40자 sha). 다음 보고는 이 커밋에 이미 들어간 것을 빼고 센다. origin/main을 못 봤으면 없다. */
  reportedSha?: string;
  /** 그때 알린 최신 공개 릴리스 버전 */
  releaseVersion?: string;
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
    || typeof parsed.sessionId !== "string" || !parsed.sessionId
    || typeof parsed.startedAt !== "string" || Number.isNaN(Date.parse(parsed.startedAt))
    || (parsed.reportedSha !== undefined && (typeof parsed.reportedSha !== "string" || !SHA_RE.test(parsed.reportedSha)))
    || (parsed.releaseVersion !== undefined && (typeof parsed.releaseVersion !== "string" || !parsed.releaseVersion))) {
    throw new Error(`${MORNING_STATE_FILE} is not a morning report record`);
  }
  return {
    sessionId: parsed.sessionId, startedAt: parsed.startedAt,
    ...(parsed.reportedSha ? { reportedSha: parsed.reportedSha } : {}),
    ...(parsed.releaseVersion ? { releaseVersion: parsed.releaseVersion } : {}),
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
  return { sessionId, startedAt, ...(reportedSha ? { reportedSha } : {}), ...(releaseVersion ? { releaseVersion } : {}) };
}

/** 요청 본문의 스킬 이름. 규칙에 맞는 것만 겹치지 않게 남긴다. */
export function parseSkillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === "string" && SKILL_NAME_RE.test(name)))];
}

export function planMorningRun(input: MorningInput): MorningPlan {
  const { state, release, skills, cloudCommits } = input;
  const newRelease = release?.available && release.latest && release.latest !== state?.releaseVersion ? release.latest : null;
  if (!cloudCommits.length && !skills.length && !newRelease) return { action: "skip", reason: "nothing-new" };
  if (!input.repoCwd) return { action: "skip", reason: "no-repo" };
  if ([state?.sessionId, input.acceptedSessionId].some((id) => id && input.runningSessionIds.includes(id))) return { action: "skip", reason: "previous-still-running" };
  return {
    action: "run",
    repoCwd: input.repoCwd,
    triggers: { cloudCommits: cloudCommits.length, skills: skills.length, release: newRelease },
    reportedSha: input.originHead,
    releaseVersion: release?.latest ?? null,
    sessionName: `클라우드 변경 보고 ${kstStamp(input.now)}`,
    prompt: buildMorningPrompt({
      base: input.base,
      originHead: input.originHead,
      cloudCommits,
      skills,
      release,
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
