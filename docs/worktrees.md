# CUELO의 Git worktree

CUELO는 같은 저장소의 main checkout과 linked worktree를 프로젝트 아래에 묶어 보여 줍니다. worktree 선택은 새 세션의 작업 디렉터리와 파일 탐색기에 영향을 주며, 기존 세션은 자신이 시작된 디렉터리를 계속 사용합니다.

## 전환기가 나타나는 조건

선택한 디렉터리가 Git checkout의 최상위 루트일 때 프로젝트 선택 아래에 worktree 전환기가 표시됩니다. 일반 디렉터리, 저장소 하위 디렉터리, Git worktree 목록을 읽지 못하는 경우에는 사용할 수 없습니다. 저장소 루트를 프로젝트 선택기에서 여세요.

## Worktree 전환과 생성

전환기에서 checkout을 선택하면 Explorer와 새 작업이 그 디렉터리를 기준으로 동작합니다. 이미 열었던 세션을 다시 선택하면 Explorer는 그 세션의 checkout으로 돌아갑니다. 세션 목록은 같은 프로젝트의 worktree 사이에서 함께 표시됩니다.

**New worktree...**에서 branch 이름을 입력하면 CUELO가 `<repo>-worktrees/<branch>` 경로에 checkout을 만듭니다. branch 이름의 `/`는 경로 구성에 사용되지 않도록 정리됩니다. 이미 존재하는 branch라면 해당 branch의 worktree를 연결하고, 없으면 현재 `HEAD`에서 branch를 만듭니다.

## 제거

main checkout이 아닌 항목의 제거 버튼은 linked checkout을 제거하며 Git branch와 세션 기록은 지우지 않습니다. 변경되었거나 추적되지 않는 파일이 있으면 Git이 제거를 거부하고, CUELO는 강제 제거 확인을 표시합니다. 강제 제거는 해당 checkout의 미커밋 파일을 버릴 수 있으니 필요한 변경을 먼저 보존하세요.

## 문제 해결

- **전환기가 보이지 않음:** 선택한 경로가 저장소 루트인지 확인합니다. 하위 디렉터리에서는 저장소 루트를 선택하세요.
- **branch를 추가할 수 없음:** 같은 branch는 동시에 하나의 worktree에서만 checkout할 수 있습니다. 현재 해당 branch가 연결된 worktree를 선택하거나 기존 checkout을 먼저 제거하세요.
- **Explorer와 대화가 다른 branch를 가리킴:** Explorer는 현재 선택된 worktree를 따르고, 대화는 열려 있는 세션의 작업 디렉터리를 따릅니다.
- **삭제한 worktree의 세션을 찾고 싶음:** 세션 기록은 삭제되지 않습니다. CUELO는 제거된 worktree의 세션을 프로젝트에 계속 표시할 수 있습니다.

구현 근거: `lib/worktree.ts`, `app/api/worktrees/route.ts`, 프로젝트 선택 및 Explorer UI.
