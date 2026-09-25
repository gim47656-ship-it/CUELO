# 비밀번호 잠금

CUELO는 브라우저에서 omp 에이전트를 실행합니다. 에이전트는 서버 프로세스가 접근할 수 있는 프로젝트 파일과 명령을 사용할 수 있으므로, 기본 설정인 `127.0.0.1` 바인딩을 그대로 유지하세요. 다른 장치에서 접근해야 한다면 비밀번호 잠금과 신뢰할 수 있는 HTTPS 프록시 또는 VPN을 함께 사용하세요. Basic Auth는 인증이지 암호화가 아닙니다.

## 잠금 켜기

웹 UI의 **Settings → Access**에서 비밀번호를 설정할 수 있습니다. 설정한 비밀번호는 저장된 상태로 두고 잠금만 끄거나, 비밀번호 자체를 제거할 수도 있습니다.

CLI에서는 다음처럼 켭니다.

```bash
bun bin/omp-web.js --authenticated
```

잠금 비밀번호가 아직 없다면 실행 중인 터미널에서 새 비밀번호를 묻습니다. 이미 저장된 비밀번호가 있으면 그 비밀번호로 잠금을 켭니다. `--authenticated` 옵션은 다음 실행에서도 잠금이 유지되도록 설정합니다. 비대화형 실행에서는 입력을 기다리지 않고 비밀번호가 필요하다는 오류로 종료하므로, 먼저 UI에서 설정하거나 `OMP_WEB_PASSWORD`를 지정하세요.

환경 변수로도 설정할 수 있습니다.

```bash
OMP_WEB_PASSWORD='긴-임의-비밀번호' bun bin/omp-web.js
```

`OMP_WEB_PASSWORD`가 설정된 동안에는 잠금이 활성화되고, 저장된 비밀번호보다 환경 변수 값이 우선합니다. 이 상태에서는 Settings에서 저장된 잠금 정보를 바꾸거나 브라우저 복구를 사용할 수 없습니다. 환경 변수 값을 비우거나 제거하면 저장된 자격 증명으로 돌아갑니다.

## 저장 위치와 복구

기본 파일은 `~/.omp/agent/omp-web-auth.json`이며, 실제 경로는 `<agentDir>/omp-web-auth.json`입니다. `OMP_WEB_AUTH_FILE`로 경로를 바꿀 수 있습니다. 파일에는 평문 비밀번호가 아니라 `scrypt` 해시와 salt·비용 매개변수가 저장됩니다.

서버를 실행 중인 컴퓨터의 터미널에서 비밀번호를 바꾸려면:

```bash
bun bin/omp-web.js --reset-password
```

브라우저로 복구해야 할 때는 `/recover`에서 코드를 요청한 뒤, 서버를 실행 중인 터미널에 출력된 코드를 입력하고 새 비밀번호를 설정합니다. 코드는 HTTP 응답으로 전달되지 않습니다. `OMP_WEB_PASSWORD` 환경 변수가 활성화된 동안에는 이 복구 경로를 사용할 수 없습니다.

## 네트워크 노출 주의

Basic Auth 자격 증명은 HTTP에서 암호화되지 않습니다. 인터넷이나 신뢰하지 않는 네트워크에 평문 HTTP로 노출하지 마세요. 원격 접근은 신뢰할 수 있는 HTTPS reverse proxy 또는 VPN 뒤에서 제공하고, 필요할 때 `OMP_WEB_ALLOWED_HOSTS`에 프록시가 사용하는 정확한 host 이름을 설정하세요. 이 설정은 인증을 대체하지 않습니다.

관련 설정과 구현: `bin/omp-web.js`, `bin/omp-web-options.js`, `bin/web-auth-store.js`, `lib/web-auth.ts`, `proxy.ts`.
