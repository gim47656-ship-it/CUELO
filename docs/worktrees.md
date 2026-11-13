# CUELO의 Git worktree

CUELO는 같은 저장소의 main checkout과 linked worktree를 프로젝트 아래에 묶어 보여 줍니다. worktree 선택은 새 세션의 작업 디렉터리와 파일 탐색기에 영향을 주며, 기존 세션은 자신이 시작된 디렉터리를 계속 사용합니다.

## 전환기가 나타나는 조건

선택한 디렉터리가 Git checkout의 최상위 루트일 때 프로젝트 선택 아래에 worktree 전환기가 표시됩니다. 일반 디렉터리, 저장소 하위 디렉터리, Git worktree 목록을 읽지 못하는 경우에는 사용할 수 없습니다. 저장소 루트를 프로젝트 선택기에서 여세요.

## Worktree 전환과 생성

전환기에서 checkout을 선택하면 Explorer와 새 작업이 그 디렉터리를 기준으로 동작합니다. 이미 열었던 세션을 다시 선택하면 Explorer는 그 세션의 checkout으로 돌아갑니다. 세션 목록은 같은 프로젝트의 worktree 사이에서 함께 표시됩니다.

**New worktree...**에서 branch 이름을 입력하면 CUELO가 `<repo>-worktrees/<branch>` 경로에 checkout을 만듭니다. branch 이름의 `/`는 경로 구성에 사용되지 않도록 정리됩니다. 이미 존재하는 branch라면 해당 branch의 worktree를 연결하고, 없으면 현재 `HEAD`에서 branch를 만듭니다.

## 제거

main checkout이 아닌 항목의 제거 버튼은 linked checkout을 제거하며 Git branch와 세션 기록은 지우지 않습니다. 변경되었거나 추적되지 않는 파일이 있으면 Git이 제거를 거부하고, CUELO는 강제 제거 확인을 표시합니다. 강제 제거는 해당 checkout의 미커밋 파일을 버릴 수 있으니 필요한 변경을 먼저 보존하세요.

그 checkout 안에서 대화가 진행 중이거나, 서브에이전트·백그라운드 작업·배달 대기 결과·진행 중인 목표가 남은 세션이 있으면 강제 제거를 포함해 제거하지 않고 해당 세션을 알려 줍니다. 작업이 끝난 뒤 다시 제거하세요. 제거가 진행되는 동안에는 그 checkout에서 새 세션이 시작되지 않습니다. CUELO 밖에서 띄운 터미널·편집기 같은 프로세스는 확인하지 않습니다.

## 여러 세션이 같은 저장소를 고칠 때

새 세션은 기본적으로 main checkout에서 시작됩니다. 단, 다른 활성 CUELO 세션, Maker, 또는 백그라운드 작업이 이미 main checkout이나 그 하위 디렉터리를 사용 중이면 CUELO는 새 세션을 위한 전용 linked worktree를 자동으로 생성합니다. 자동 생성되는 branch 이름은 `wt/s-YYYYMMDD-<8자리 16진수>` 형식이며, `<repo>-worktrees/<변환된-branch>` 경로에 만들어집니다(branch 이름의 `/`는 `-`로 변환). 다른 linked worktree에서 실행 중인 세션은 main checkout을 사용 중인 것으로 간주하지 않으며, CUELO가 추적하지 않는 외부 터미널이나 편집기 프로세스도 계산에 포함되지 않습니다. 이미 linked worktree를 선택한 상태이거나 Git 저장소가 아닌 디렉터리에서 시작할 때, 또는 `autoWorktree: false`로 요청한 경우에는 기존 동작이 그대로 유지됩니다.

사이드바의 선택적 GitHub 이슈 입력란에 `#123` 또는 `origin` 원격 저장소와 일치하는 GitHub 이슈 URL을 지정하면, main checkout 사용 여부와 관계없이 항상 `wt/issue-123` branch로 전용 worktree를 준비합니다. 다른 저장소의 이슈 URL이나 잘못된 형식은 세션이 시작되기 전에 거부됩니다. 해당 이슈 worktree가 이미 존재하고 활성 세션에서 사용 중이지 않다면 재사용하며, 다른 활성 작업과 충돌할 때는 `wt/issue-123-<8자리 16진수>` 형태로 새 worktree를 만듭니다.

기존 `<repo>-worktrees/<변환된-branch>` 경로가 외부에서 삭제되었지만 Git에는 해당 이슈 checkout 등록이 남아 있는 경우, 이슈 세션을 시작할 때 사용 중이지 않은 그 누락된 등록 한 건만 복구한 뒤 동일한 기존 branch를 다시 checkout하여 아직 통합되지 않은 커밋을 보존합니다. 기존 branch를 재사용할 때는 자동 생성 소유로 편입하지 않습니다. 활성 사용이나 예약으로 인해 복구할 수 없으면 접미사가 붙은 충돌 branch를 생성해 시작합니다.

자동 worktree를 새로 만들 때는 `origin`의 기본 branch를 먼저 fetch하여 최신 기반에서 시작합니다. 네트워크 오류 등으로 fetch에 실패하면 로컬 기본 branch를 기반으로 삼고 UI에 대체 안내 메시지를 표시합니다. 이 시작 과정은 main checkout의 상태를 절대 변경하지 않습니다. 또한 `node_modules`나 `.env`를 포함해 Git이 추적하지 않거나 무시하는(untracked/ignored) 파일은 새 worktree로 복사되지 않으므로, 필요한 의존성은 각 worktree에서 별도로 설치하고 설정 파일도 안전하게 직접 구성해야 합니다.

메인 저장소의 하위 디렉터리에서 세션이 요청되어 자동 격리가 필요한 경우, 새 체크아웃에 동일한 상대 경로의 하위 디렉터리가 존재하면 이를 유지합니다. 해당 디렉터리가 추적되지 않는 파일로만 구성되어 새 체크아웃에 존재하지 않는 경우에는 새 워크트리의 루트를 열고 누락된 하위 디렉터리 이름을 알리는 공지를 표시합니다. 또한 정리 작업 시 `.env`나 `node_modules` 같은 무시된 파일이 포함된 워크트리는 임의로 삭제하지 않고 보존합니다. 빈 저장소이거나 로컬 기본 브랜치 없이 가져오기에 실패하는 등 사용할 수 있는 기본 브랜치 커밋이 없으면, 사용 중인 메인 워크트리를 공유하는 대신 사유를 표시하고 시작을 거부합니다. 원격 저장소가 없는 비표준 현재 브랜치는 로컬 기본 브랜치의 대체 수단으로 사용할 수 있습니다.

CUELO가 자동 생성 표시를 남긴 `wt/s-*` 및 `wt/issue-*` worktree는 추적되지 않는 파일과 `.env`나 `node_modules` 같은 무시된(ignored) 파일을 포함해 작업 트리가 깨끗하고 활성 사용이 없을 때 다음 두 경우 중 하나에 해당하면 자동으로 정리됩니다: (1) 자체 커밋이 1개 이상 존재하며 현재 `HEAD`가 최신 fetch된 `origin` 기본 branch에 병합(포함)되어 있는 경우, 또는 (2) 자체 커밋이나 통합할 내용이 전혀 없어 현재 `HEAD`가 기록된 시작 기반 커밋과 정확히 일치하는 경우(이 미변경 경로는 새로운 fetch나 통합 과정을 거치지 않고 기록된 기반 참조를 `git branch -d` 실행 시 임시 upstream 비교 기준으로 사용합니다). 정리는 런타임이 닫힐 때(유휴 종료 포함)와 `GET /api/worktrees` 요청 시점에 실행됩니다. 변경 사항이나 무시된 파일이 남은 경우, 활성 작업이 있는 경우, 아직 병합되지 않은 자체 커밋이 있는 경우, 표시가 없거나 사용자가 직접 만든 worktree, main checkout, 또는 `~/cuelo-run`은 건드리지 않습니다. 두 정리 경로 모두 동일한 제거 예약과 최종 `HEAD`/상태 재확인을 거친 뒤 강제 옵션 없는 `git worktree remove`와 `git branch -d`만 사용하며, Git이 `git branch -d` 삭제를 거부하면 폴더만 제거하고 branch는 유지한 채 결과와 로그로 알립니다(수동 제거 버튼은 기존과 동일하게 branch를 삭제하지 않습니다). 자동 worktree가 삭제된 뒤에도 세션 기록은 남으며, 디렉터리가 사라진 세션을 재개하면 런타임 작업 디렉터리만 main checkout(사용 중이면 새 자동 worktree)으로 대체하여 열리고 디렉터리가 남아 있는 세션은 원래 경로에서 그대로 재개됩니다.

기회적 정리(opportunistic sweep)에서는 CUELO가 자동 생성 표시를 남긴 `wt/s-*` 및 `wt/issue-*` worktree 중 경로가 누락된 등록만 정리하며, 통합 여부와 관계없이 로컬 branch와 커밋은 유지합니다. 이는 앞서 설명한 일반 깨끗한 checkout 및 branch 삭제와는 별개의 부재 경로 등록 복구로, 전역 prune 대신 런타임 사용 예약과 최종 부재 및 활성 여부 재확인을 거친 뒤 대상 한 건에만 강제 옵션 없는 `git worktree remove`를 실행합니다. 실제 디렉터리가 남아 있거나, 끊어진 심볼릭 링크이거나, 잠긴(locked) 등록이거나, 사용자가 직접 만들었거나 표시가 없는 worktree는 제거하지 않습니다.

정리된(cleaned) auto-worktree 세션을 재개할 때, `runtime cwd`는 `main`이나 새로운 auto worktree로 전환될 수 있으나 저장된 세션 헤더와 이전 기록의 `cwd`는 정리된 경로로 유지됩니다. 세션 파일은 이동되지 않습니다. 콜드 런타임 재개(cold runtime resume)를 수행할 때마다 누락된 경로를 다시 확인하고 동일한 사용 중(busy) 규칙을 재적용합니다. 기존 `cwd`가 존재하는 세션의 재개 동작은 변경되지 않습니다.

worktree에서 열린 세션은 메인 checkout과 동일한 프로젝트 기억을 사용합니다. 패치된 내장 코어가 worktree의 `.git` 파일을 읽어 메인 checkout의 동일한 폴더에 있는 기억 은행을 선택하므로, worktree마다 별도의 은행이 생기지 않아 한쪽에서 남긴 교훈을 다른 쪽에서 회상할 수 있고 다른 PC로 내보낼 때도 worktree에서 작성된 기억이 함께 포함됩니다.

작업 중 커밋은 해당 worktree에서 진행하고, `main`에 합치는 작업은 하네스의 `git_integrate` 도구를 사용합니다. 최신 `main` 위에 rebase하고 검사를 통과하면 fast-forward로 게시하며, 충돌이 나면 작업을 멈추고 세션이 직접 충돌을 해결해 이어갑니다. 자세한 동작은 [OMP 하네스](./harness.md) 문서의 Git 마감 도구 절을 참고하세요.

## 문제 해결

- **전환기가 보이지 않음:** 선택한 경로가 저장소 루트인지 확인합니다. 하위 디렉터리에서는 저장소 루트를 선택하세요.
- **branch를 추가할 수 없음:** 같은 branch는 동시에 하나의 worktree에서만 checkout할 수 있습니다. 현재 해당 branch가 연결된 worktree를 선택하거나 기존 checkout을 먼저 제거하세요.
- **Explorer와 대화가 다른 branch를 가리킴:** Explorer는 현재 선택된 worktree를 따르고, 대화는 열려 있는 세션의 작업 디렉터리를 따릅니다.
- **삭제한 worktree의 세션을 찾고 싶음:** 세션 기록은 삭제되지 않습니다. CUELO는 제거된 worktree의 세션을 프로젝트에 계속 표시할 수 있습니다.

구현 근거: `lib/worktree.ts`, `app/api/worktrees/route.ts`, 프로젝트 선택 및 Explorer UI.
