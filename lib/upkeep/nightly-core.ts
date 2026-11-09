import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { compareVersions } from "../omp-updates";

const exec = promisify(execFile);
export const OMP_STABLE_URL = "https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent/latest";
const REQUEST_TIMEOUT_MS = 10_000;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type CoreUpdateLookup =
  | { status: "newer" | "current" | "ahead"; current: string; latest: string; sourceRef: string; sourceSha: string }
  | { status: "unavailable"; reason: string };

function stableVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

/** Read only the source revision that the existing nightly worktree will use, never the host's installed package. */
export async function collectNightlyCoreUpdate(
  repoCwd: string | null,
  sourceRefs: readonly string[] = ["HEAD"],
  fetcher: Fetcher = fetch,
): Promise<CoreUpdateLookup> {
  if (!repoCwd) return { status: "unavailable", reason: "source repository unavailable" };
  let sourceCwd: string;
  try {
    // Match addWorktree's main-root resolution even when the configured source is a linked worktree.
    const commonDir = (await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoCwd, timeout: REQUEST_TIMEOUT_MS, encoding: "utf8" })).stdout.trim();
    sourceCwd = dirname(commonDir);
  } catch {
    return { status: "unavailable", reason: "source repository root unavailable" };
  }
  let sourceRef: string | undefined;
  let sourceSha = "";
  // Local addWorktree reuses a same-day branch after a failed start; otherwise it starts at HEAD.
  for (const ref of sourceRefs) {
    try {
      sourceSha = (await exec("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: sourceCwd, timeout: REQUEST_TIMEOUT_MS, encoding: "utf8" })).stdout.trim();
      sourceRef = ref;
      break;
    } catch {
      // A missing candidate may fall back only to the next explicitly supplied worktree base.
    }
  }
  if (!sourceRef || !sourceSha) return { status: "unavailable", reason: "source revision unavailable" };
  let current: unknown;
  try {
    const text = (await exec("git", ["show", `${sourceSha}:package.json`], { cwd: sourceCwd, timeout: REQUEST_TIMEOUT_MS, encoding: "utf8" })).stdout;
    current = JSON.parse(text)?.cueloBuild?.coreVersion;
  } catch {
    return { status: "unavailable", reason: "source package.json unavailable or malformed" };
  }
  if (!stableVersion(current)) return { status: "unavailable", reason: "source cueloBuild.coreVersion is not a stable version" };
  try {
    const response = await fetcher(OMP_STABLE_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { status: "unavailable", reason: `npm HTTP ${response.status}` };
    const payload: unknown = await response.json();
    const latest = payload && typeof payload === "object" && "version" in payload ? payload.version : null;
    if (!stableVersion(latest)) return { status: "unavailable", reason: "npm latest is not a stable version" };
    const order = compareVersions(latest, current);
    return { status: order > 0 ? "newer" : order < 0 ? "ahead" : "current", current, latest, sourceRef, sourceSha };
  } catch (error) {
    return { status: "unavailable", reason: `npm request failed (${error instanceof Error ? error.name : "unknown error"})` };
  }
}

/** Discovery is data, not permission to install on the nightly host. */
export function nightlyCoreUpdateBlock(lookup: CoreUpdateLookup): string {
  if (lookup.status === "unavailable") {
    return `# OMP 코어 조회\n\n새 정식 버전을 확인하지 못했습니다(${lookup.reason}). 최신이라는 뜻이 아닙니다. 코어 갱신은 발주하지 않았으며, 다른 야간 작업은 계속합니다. 아침 요약에 조회 불가와 이유를 씁니다.`;
  }
  if (lookup.status !== "newer") return "";
  return [
    "# OMP 코어 갱신 작업",
    "",
    `작업 소스의 고정 코어 ${lookup.current}보다 공식 npm 정식 버전 ${lookup.latest}이 새 버전입니다. 기준 커밋은 ${lookup.sourceSha}입니다. 이 세션의 기존 worktree 안에서만 ${lookup.current} → ${lookup.latest} 통합을 검토하고 검증합니다. 별도 세션이나 갱신 큐는 만들지 않습니다.`,
    "1. 먼저 `cuelo-omp-core-bump`, `omp-core-upstream-rebase` 스킬과 `rule://omp-harness`를 읽습니다. 작업 사본의 package.json 고정값과 공식 release/changelog를 다시 확인하고, 이미 반영되었거나 다른 작업에서 진행 중이면 중복 작업하지 않습니다.",
    "2. 현재 Known-Good와 runtime 계약을 기준으로 실제 upstream source diff, breaking change, 설정 기본값과 호출부를 조사합니다. 각 독립 패치 목적마다 KEEP / ADAPT / RETIRE / BLOCK을 근거와 함께 판정합니다. 새 버전이라는 이유나 anchor 일치만으로 갱신하지 않습니다.",
    "3. 패치 시험은 실제 파일로 복사한 격리 사본과 별도 HOME에서 합니다. 새 버전과 지원 중인 기존 버전의 apply/check/revert roundtrip, 관련 회귀와 하네스 정책, Agent 생성물, FAST Eval, 실제 smoke를 검증합니다. 버전 핀, lock, runtime manifest와 관련 호출부는 기존 코어 갱신 절차로 함께 맞춥니다.",
    "4. 의미 충돌이나 검증 실패가 남으면 BLOCK 또는 HOLD로 기록하고 Known-Good를 유지합니다. 실패를 감추거나 검사를 완화하지 않습니다. 검증된 통합만 위의 기존 버전 상승, cross_review, git_integrate와 공개 CI 경로로 넘깁니다.",
    "5. 야간 호스트나 설치된 런타임에 raw OMP를 설치하지 않습니다. 전역 CLI, 프로필, 인증, 세션과 사용자 데이터는 바꾸지 않고, update.sh 실행, 배포와 서버 재시작도 하지 않습니다. 라이브 반영은 기존 승인된 릴리스 설치 경로에 맡기며, 이 야간 세션은 설치하지 않습니다.",
    "6. 아침 요약에 기존 버전과 대상, UPDATE / UPDATE_WITH_REBASE / HOLD / BLOCKED 결론, 사용자에게 달라지는 점, 패치 판정과 검증 근거, 유지한 Known-Good와 보류 이유를 씁니다.",
  ].join("\n");
}
