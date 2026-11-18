---
description: After publication; before CI, deploy, restart or Windows sync.
---

# 배포·CI 감시·Windows 사본 반영

승인 경계는 `RULES.md`를 따르고, 프로젝트 `AGENTS.md`에 확인된 상시 승인이 있으면 그 범위에서 적용한다.

- 배포 확인(사용자, 2026-09-26, 2026-09-29, 2026-09-30): 집과 사무실은 현재 네이티브 Linux Mint이며 같은 절차를 따른다.
  실제 hostname과 런타임을 확인하고 검증, 커밋과 push 뒤 해당 CI 결과를 보고해 배포 승인을 받는다.
  예약 작업의 commit/push 승인은 배포나 재시작 승인이 아니다. stage/rollback 삭제, 다른 PC 배포, CLI 갱신과 비용은 별도 승인이다.
  폰과 클라우드 런타임은 이 규칙에서 확인하지 못했으므로 unknown이다. 경로나 옛 READY를 다른 PC의 증거로 쓰지 않는다.
- Linux/WSL 배포(사용자, 2026-10-07, 2026-11-01): 재시작을 먼저 알리고
  `systemd-run --user --unit=cuelo-update-$(date +%s) --collect bash ~/cuelo-run/Tools/CUELO_Setup/wsl/update.sh <revision> "$PI_SESSION_ID"`를 쓴다.
  WSL에서만 `--setenv=WSL_DISTRO_NAME="$WSL_DISTRO_NAME"`를 추가한다. Windows에서 WSL로 호출할 때는 배포판을 명시한다.
  현재 세션 id는 반드시 두 번째 인자로 넘긴다. drain, 빌드, 프로필 반영, 재시작과 복귀는 스크립트가 소유한다.
  네이티브 Linux는 Windows helper와 NAT 다리를 건너뛰고 `linux/launch.sh`로 돌아온다.
  집과 사무실에서는 Windows 앱을 되살리는 `deploy-live.ps1`, 앱 `setup.ps1`을 쓰지 않으며 Windows 프로필 검사도 배포 증거가 아니다.
  완료는 `deploy_verify`에 revision과 세션 cwd(WSL이면 필요 시 distro)를 주어 한 번 확인한다:
  최신 갱신 로그의 `READY <revision>`, 런처 `matched: true`, `node install.mjs health` 4/4,
  `/api/models?cwd=<세션 cwd>` selector와 해당 프로필 `modelRoles` 일치다. cwd 없이 API를 부르면 403이다.
  Linux 런처 조회는 `bash ~/cuelo-run/Tools/CUELO_Setup/linux/launch.sh status`(일치 0, 불일치 3),
  WSL은 `wsl/launch.ps1 -Status`와 필요한 `-Distribution`이다. update exit 2와 3은 실패다.
  설정 파일 touch는 실행 중 Settings를 바꾸지 않으므로 프로필만 바꿨어도 지원되는 갱신과 재시작 뒤 역할을 확인한다.
  자세한 운영 절차는 `Tools/CUELO_Setup/LINUX-SETUP.md`와 `WSL-SETUP.md`를 따른다.
- CI 감시(사용자, 2026-09-28, 2026-10-03): 기다릴 워크플로를 이름으로 지정하고 그 run이 끝나면 즉시 보고한다.
  같은 SHA에 나중에 붙는 릴리스와 배포 run 전체를 기다리지 않는다. `bash`의 `gh run watch <id> --exit-status`나 직접 조회를 쓰고
  eval subprocess 폴링을 만들지 않는다. 직접 만든 폴링의 빈 출력과 0이 아닌 exit는 오류다. 공개 미러는 원본과 SHA가 다르므로 run 제목으로 찾는다.
- 경로 필터로 생략된 push(사용자 승인, 2026-10-28): private `CI`(`ci.yml`)와 `Publish public mirror`(`publish-public.yml`)는 `on.push` 경로 필터가 있어, 변경 파일이 전부 필터에 걸리는 push(작업 기록 `doc/`, HANDOFF·PC-SETUP, `Tools/*/*.md`, 기억 내보내기, 미러에 가지 않는 비공개 Tools 등)에는 run이 아예 생기지 않는다. run이 없다는 이유만으로 타임아웃까지 기다리거나 실패로 보고하지 않는다. run이 없으면 그 커밋의 변경 파일(`git show --name-only --format= <sha>`)을 그 시점 워크플로 파일의 필터와 대 보고, 모두 걸러지면 「CI 없음」으로 보고하고 통과로 센다. 필터 판정은 `.github/scripts/paths-filter.ts`의 `pushStartsWorkflow`를 쓴다. 이 상태는 코드가 바뀌지 않았다는 뜻일 뿐 배포 결정을 바꾸지 않는다. 배포는 이전처럼 바뀐 파일이 실행본·프로필에 닿을 때만 묻는다. 병합 커밋처럼 변경 파일 목록을 믿을 수 없는 push는 run이 곧 생기는지 따로 확인한다. 워크플로 파일 자체나 `.publicignore`·`.publicdeny`가 바뀌면 필터에 걸리지 않으므로 run이 생긴다.
- Linux 작업 결과의 Windows 사본 반영(사용자, 2026-10-11, 모든 세션; 2026-11-18 방향 정정):
  **Linux가 소스 정본이고 Windows가 받는 사본이다.** 대응하는 기존 사본이 확인되면 검증, 커밋과 게시를 마친 소스와 문서를 같은 커밋으로 반영한다.
  대상은 프로젝트 운영 문서의 대응 경로와 실제 origin/branch로 확인하며 새 사본이나 추정 경로는 만들지 않는다.
  Main은 게시 뒤 `bun ~/.omp/agent/tools/git-finalizer/sync-checkout.ts --source <Linux worktree> --target <Windows 사본의 /mnt 경로> --revision <게시한 전체 SHA>`를 쓴다.
  도구는 수정 없는 동일 origin/branch 사본만 fast-forward한다. 미커밋 수정, 미추적 파일, 분기, 락과 인증 실패는 보존해 보고하고
  reset, stash, 강제 덮어쓰기나 자동 rebase로 우회하지 않는다. 원본 완료와 사본 반영 완료는 구분한다.
  실시간 감시와 양방향 동기화는 만들지 않고 산출물, 설치 프로필, 인증 DB, 세션, 기억과 독립 CLI는 복사하지 않는다.
  활성 런타임은 위 배포 절차를 따르며 Windows 앱을 다시 설치하거나 Windows 전용 프로젝트의 위치와 도구를 임의 변경하지 않는다.
  WinBoat 빌드 사본의 `vm_build` 계약은 `rule://linux-runtime`의 별도 절차다.
- `git_integrate` 게시(2026-10-31): worktree 세션이 `git_integrate`로 대상 branch(기본 `main`)에 올린 SHA는 `git_finalize`로 게시한 커밋과 똑같이 다룬다. 그 SHA로 위 CI 감시와 배포 확인을 하고, Windows 사본 반영은 원본 branch(`wt/<주제>`)가 대상 branch와 다르므로 `sync-checkout.ts --source <그 worktree 폴더> --target <대응 Windows 사본의 /mnt 경로> --revision <게시한 전체 SHA> --branch <대상 branch>`로 부른다. `git_integrate`가 충돌로 멈췄거나 검사·게이트에서 실패했으면 게시된 커밋이 없으므로 CI를 기다리지 않고 그 결과를 보고한다.
