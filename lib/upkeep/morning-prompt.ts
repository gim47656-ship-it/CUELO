/** 아침 보고 세션의 첫 메시지(lib/upkeep/morning.ts). 계산은 하지 않고 계획이 모은 사실을 글로만 옮긴다. */
import type { CloudCommit, MorningBase, ReleaseInfo } from "./morning";

export interface MorningPromptInput {
  /** 클라우드 커밋을 센 기준. 없으면 최근 며칠만 봤다. */
  base: MorningBase | null;
  originHead: string | null;
  cloudCommits: readonly CloudCommit[];
  skills: readonly string[];
  release: ReleaseInfo | null;
  warnings: readonly string[];
}

export const MORNING_PREAMBLE = [
  "CUELO 클라우드 변경 보고 세션",
  "",
  "이 세션은 사람 없이 이 PC의 클라우드 동기화가 열었습니다. 아래 두 가지만 하고 다른 일은 하지 않습니다. `ask`는 쓰지 않습니다(답할 사람이 없습니다).",
  "마지막 답은 보고와 설치 결과를 합쳐 세 줄 이내의 쉬운 한국어입니다. 목록·제목 없이 짧은 문장으로만 쓰고, 커밋 해시와 전문용어는 뺍니다.",
  "",
  "1. 보고: `git fetch` 뒤 아래 커밋과 작업 기록, 받아 온 스킬을 읽고 클라우드가 무엇을 바꿨는지 씁니다. 사용자에게 생기는 효과를 먼저, 그다음 받아 온 스킬, 사용자가 정해야 할 일이 있으면 그것을 씁니다.",
  "2. 설치: 아래 「릴리스」에 새 버전이 있다고 적혀 있을 때만 합니다. 그 버전의 공개 CI(`gh run list --repo gim47656-ship-it/CUELO`)가 성공했는지 먼저 확인합니다. 메인 체크아웃이 `main` 브랜치이고 고치지 않은 파일이 없을 때만 `git pull --ff-only`를 하고, 아니면(다른 브랜치, 고친 파일, 갈라진 이력, CI 실패·미확인) 설치하지 않습니다. 받은 뒤 AGENTS.md 「Live deploy」의 이 PC 배포 명령을 이 세션 자신의 id(`$PI_SESSION_ID`)로 실행하고 `deploy_verify`로 끝났는지 확인합니다. 서버가 다시 시작되는 동안 이 세션은 멈췄다가 깨어나니 깨어난 뒤 확인을 이어 갑니다.",
  "세 줄 가운데 마지막 줄은 설치 결과(설치한 버전, 설치하지 않은 이유, 또는 「설치할 새 버전 없음」)입니다.",
].join("\n");

export function buildMorningPrompt(input: MorningPromptInput): string {
  const { release } = input;
  const releaseLine = !release
    ? "- 공개 릴리스를 확인하지 못했습니다. `gh release view --repo gim47656-ship-it/CUELO`로 직접 보고, 실행 중 버전보다 높을 때만 위 2번을 따릅니다."
    : release.available && release.latest
      ? `- 새 버전 있음: 실행 중 ${release.current}, 최신 공개 릴리스 ${release.latest}.`
      : `- 새 버전 없음: 실행 중 ${release.current}, 최신 공개 릴리스 ${release.latest ?? "없음"}.`;
  const range = input.base?.kind === "reported"
    ? `지난 보고 때 본 origin/main ${input.base.sha} 뒤`
    : input.base
      ? `지난 보고 기록이 없어 이 PC에 배포한 ${input.base.sha} 뒤`
      : "비교할 기준이 없어 최근 며칠";
  const commits = input.cloudCommits.length
    ? input.cloudCommits.map((c) => `- ${c.sha.slice(0, 12)} ${c.committedAt} ${c.subject}${c.records.length ? ` (기록: ${c.records.join(", ")})` : ""}`)
    : ["- 없음"];
  return [
    MORNING_PREAMBLE,
    "",
    `## 클라우드 야간 커밋 (${range}, 지금 origin/main ${input.originHead ?? "확인 못 함"})`,
    "",
    ...commits,
    "",
    "## 이번 동기화로 받아 온 스킬 (~/.omp/agent/managed-skills)",
    "",
    ...(input.skills.length ? input.skills.map((name) => `- ${name}`) : ["- 없음"]),
    "",
    "## 릴리스",
    "",
    releaseLine,
    ...(input.warnings.length ? ["", "## 확인하지 못한 것", "", ...input.warnings.map((w) => `- ${w}`)] : []),
  ].join("\n");
}
