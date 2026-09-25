# Docker에서 CUELO 실행하기

`Dockerfile`은 CUELO를 빌드하고 `bun bin/cuelo.js`에 해당하는 실행기를 컨테이너에서 시작합니다. 이미지에는 앱이 들어 있지만 omp의 세션·설정은 들어 있지 않습니다. 호스트의 `~/.omp`를 `/home/omp/.omp`에 마운트해야 기존 omp 환경을 공유할 수 있습니다.

## Compose로 시작하기

저장소 루트에서 실행합니다.

```bash
CUELO_PASSWORD='긴-임의-비밀번호' \
OMP_UID=$(id -u) OMP_GID=$(id -g) docker compose up --build
```

이 설정은 `CUELO_PASSWORD`를 필수로 요구하고 host의 포트를 `127.0.0.1:30141`에만 게시합니다. 준비되면 <http://127.0.0.1:30141>을 열고 사용자 이름 `omp`와 지정한 비밀번호로 로그인합니다. Compose 기본 mount는 host의 `~/.omp`와 현재 디렉터리이며, `OMP_HOME`, `CUELO_WORKSPACE`, `CUELO_PORT`로 경로와 host 포트를 바꿀 수 있습니다. 필요하면 이 변수들을 compose 파일 옆 `.env`에 둘 수 있습니다.

Linux에서는 bind mount의 파일 소유자와 컨테이너 사용자가 맞아야 쓸 수 있으므로 `OMP_UID`와 `OMP_GID`를 host 계정 ID로 전달합니다. macOS·Windows의 Docker Desktop은 소유권을 매핑하므로 기본값을 사용할 수 있습니다.

## Docker를 직접 실행하기

```bash
docker build --build-arg UID=$(id -u) --build-arg GID=$(id -g) -t cuelo .

docker run --rm \
  -p 127.0.0.1:30141:30141 \
  -v "$HOME/.omp:/home/omp/.omp" \
  -v "$HOME/code:/workspace" \
  -e CUELO_AUTHENTICATED=1 \
  -e CUELO_PASSWORD='긴-임의-비밀번호' \
  cuelo
```

위 예시는 Linux/macOS shell용입니다. Windows에서는 Docker Desktop을 사용하고 volume 경로를 해당 환경에 맞추세요. 컨테이너 기본 포트는 `30141`이며, CLI 인자는 이미지 이름 뒤에 전달됩니다.

## 컨테이너 경로와 환경

| 경로 | 용도 |
| --- | --- |
| `/home/omp/.omp` | omp CLI와 공유하는 세션·설정·인증 상태. host의 `~/.omp`를 mount합니다. |
| `/workspace` | 기본 프로젝트 위치이자 상대 경로를 해석하는 기준입니다. 필요한 프로젝트만 좁게 mount하세요. |
| `/app` | 빌드된 CUELO와 의존성입니다. 여기에 mount하지 마세요. |

이미지는 컨테이너 안에서 `CUELO_HOSTNAME=0.0.0.0`, `CUELO_NO_OPEN=1`, `PORT=30141`을 설정합니다. Compose에서 바깥쪽 게시 주소는 loopback으로 제한되지만, 직접 `docker run`할 때도 `-p 127.0.0.1:...`를 사용하세요.

주요 값은 `PORT`, `CUELO_AUTHENTICATED`, `CUELO_PASSWORD`, `CUELO_ALLOWED_HOSTS`입니다. 상세한 비밀번호·HTTPS 주의는 [인증 안내](./authentication.md)를 보세요.

## 보안 경계

에이전트는 컨테이너에 mount된 파일과 네트워크 자원에 접근할 수 있습니다. 필요한 작업공간만 mount하고, 컨테이너 포트를 신뢰하지 않는 네트워크에 공개하지 마세요. Compose 설정은 인증 필수와 loopback 게시를 기본으로 둡니다.

확인 근거: `Dockerfile`, `docker-compose.yml`, `bin/cuelo.js`.
