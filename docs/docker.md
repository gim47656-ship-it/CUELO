# Docker에서 CUELO 실행하기

Docker 이미지는 CUELO 웹과 사용량·사이드챗·서브에이전트 사이드카를 함께 실행합니다. Bun, Node.js, Git, GitHub CLI, PowerShell 7이 들어 있어 컨테이너 안에서 저장소를 열고 코딩할 수 있습니다. 인증 정보와 개인 설정은 이미지에 포함하지 않습니다.

## Compose로 시작하기

저장소 루트에서 실행합니다.

```bash
CUELO_PASSWORD='긴-임의-비밀번호' \
OMP_UID=$(id -u) OMP_GID=$(id -g) docker compose up --build -d
```

Compose는 비밀번호를 필수로 요구하고 웹 포트를 `127.0.0.1:30141`에만 게시합니다. 사이드카 포트는 외부에 게시하지 않습니다. <http://127.0.0.1:30141>에서 사용자 이름 `omp`와 지정한 비밀번호로 로그인합니다.

첫 실행은 공개 하네스에서 없는 파일만 프로필에 추가합니다. 기존 설정·인증 파일을 덮어쓰지 않으며 모델 역할을 임의로 지정하지 않습니다. 새 프로필이면 Settings → Models에서 로그인하고 역할을 정하세요. 기존 프로필을 이전할 때는 실행 중인 SQLite 파일을 그대로 복사하지 말고 SQLite backup API로 일관된 복사본을 만드세요. 다른 PC와 같은 OAuth 인증을 함께 쓰면 제공자의 토큰 갱신 정책에 따라 재로그인이 필요할 수 있습니다.

Linux에서는 `OMP_UID`·`OMP_GID`를 마운트 디렉터리 소유자와 맞추세요. macOS·Windows Docker Desktop은 기본값을 사용할 수 있습니다. 프로필·GitHub 설정·작업 폴더는 해당 UID가 쓸 수 있어야 합니다.

| 변수 | 용도 |
| --- | --- |
| `OMP_HOME` | 호스트의 omp 프로필 디렉터리. 기본 `${HOME}/.omp` |
| `CUELO_WORKSPACE` | 컨테이너에 공개할 저장소 디렉터리. 기본 현재 디렉터리 |
| `CUELO_GH_CONFIG` | GitHub CLI 인증 저장 위치. 기본 `./.omp/cloud-gh` |
| `CUELO_PORT` | 호스트 loopback 포트. 기본 `30141` |
| `CUELO_ALLOWED_HOSTS` | HTTPS 프록시에 사용할 정확한 호스트 이름 |
| `CUELO_INSTANCE_LABEL` | PWA 이름의 접미사. `클라우드`이면 `CUELO(클라우드)` |
| `CUELO_GITHUB_WORKSPACE` | 클라우드 GitHub 화면을 켜고 저장소를 가져올 컨테이너 내 절대 경로. 예: `/workspace/github`. 비어 있으면 기존 화면 유지 |
| `CUELO_CPU_LIMIT` / `CUELO_MEMORY_LIMIT` | 실행 자원 상한. 기본 `1.0` CPU / `4g` |

이 변수는 Compose 옆 `.env`에 둘 수 있습니다. 인증이 들어 있는 `.env`와 프로필을 Git에 올리지 마세요.

## Tailscale과 PWA

호스트에서 Tailscale에 로그인한 뒤 loopback 웹 포트를 HTTPS로 연결합니다. 기존 서비스의 포트는 바꾸지 말고 비어 있는 포트를 선택하세요.

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:30141
```

출력된 `https://<서버>.<tailnet>.ts.net:8443/`의 호스트를 `CUELO_ALLOWED_HOSTS`에 넣고 컨테이너를 다시 생성합니다. 이 주소는 tailnet 안에서만 접근하며 Funnel로 인터넷에 공개하지 않습니다. HTTPS에서 화면과 로그인 동작을 확인한 다음 모바일 브라우저의 앱 설치 메뉴를 사용하세요. origin이 다른 집·사무실·클라우드는 서로 다른 PWA로 설치됩니다.

## GitHub 저장소 열기

클라우드에서 `CUELO_GITHUB_WORKSPACE=/workspace/github`를 설정하면 사이드바에 **GitHub 저장소 열기**가 나타납니다. 연결한 계정의 저장소를 검색해 선택하거나 `OWNER/REPO`·GitHub HTTPS URL을 입력합니다. 기존에 가져온 저장소는 파일을 덮어쓰거나 자동 pull하지 않고 그대로 다시 엽니다. GitHub 연결은 화면의 기기 코드로 직접 승인하며 토큰은 서버에만 저장됩니다. 서버 폴더 열기도 같은 창에서 선택할 수 있습니다.

터미널로 직접 연결할 경우:

```bash
docker compose exec cuelo gh auth login --hostname github.com --git-protocol https --web
docker compose exec cuelo gh auth setup-git
docker compose exec cuelo git clone https://github.com/OWNER/REPO.git /workspace/REPO
```

로그인 페이지에서 요청 권한을 직접 확인합니다. 공개 저장소 clone은 인증 없이도 가능하지만 비공개 저장소와 push에는 권한이 필요합니다. CUELO에서 `/workspace/REPO`를 프로젝트로 열면 됩니다. Git 작성자 이름과 이메일도 컨테이너 사용자 설정에 지정하세요. Git finalizer는 Linux의 PowerShell 7과 Windows PowerShell에서 같은 파일 경계·원격 이력·잠금 검사를 적용합니다.

## 상태 확인과 서버 이전

```bash
docker compose ps
docker compose exec cuelo bun /app/install.mjs health
docker compose logs --since=10m cuelo
```

서버를 옮길 때는 작업을 멈추고 컨테이너를 정지한 뒤 Compose·비공개 `.env`·프로필·GitHub 설정·작업 저장소를 함께 백업합니다. SQLite의 WAL 파일을 빠뜨리지 않도록 정지 상태 전체 디렉터리를 보존하거나 SQLite backup API를 사용합니다. 새 서버에서는 소유 UID/GID와 권한을 맞추고 같은 이미지 또는 검증된 소스로 실행합니다. Tailscale의 새 주소를 호스트 허용 목록에 반영한 다음 health·모델 인증·저장소·PWA를 확인하세요. 주소가 바뀌면 기존 PWA도 자동으로 새 서버를 가리키지 않습니다.

다른 앱과 같은 서버를 쓰더라도 Compose 프로젝트·볼륨·포트를 분리합니다. CUELO에 호스트 Docker 소켓, 다른 앱의 DB 디렉터리, 호스트 전체 HOME을 마운트하지 마세요. 에이전트가 접근할 수 있는 것은 이 컨테이너에 공개한 파일과 네트워크입니다. 비밀번호·HTTPS 경계는 [인증 안내](./authentication.md)를 따릅니다.
