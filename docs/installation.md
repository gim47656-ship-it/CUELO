# CUELO 설치와 실행

이 문서는 공개 저장소 파일만으로 CUELO 앱, 로컬 사이드카 3개(사용량 `usage`, 사이드채팅 `btw`, Subagent 기록 `subagent`), 공개 하네스를 설치하고 실행하는 방법을 설명합니다. 사람이 읽어도 되고, 에이전트에게 그대로 따라 하게 해도 됩니다. 모든 단계는 사용자가 직접 명령을 입력했을 때만 실행되며, 설치 스크립트가 npm lifecycle이나 예약 작업으로 자동 실행되는 일은 없습니다.

## 현재 배포 상태

- **지금 쓸 수 있는 방법**: 소스 checkout 후 `node install.mjs`를 실행합니다(아래 절차).
- **npm 패키지 `cuelo`**: 아직 게시되지 않았습니다. 게시된 뒤에는 설치된 패키지 폴더에서도 같은 `install.mjs`가 동작합니다. 이 경우 빌드는 건너뛰고, 준비된 런타임만 검사합니다.
- **검증 범위**: Windows에서만 검증했습니다. macOS·Linux는 코드상 같은 경로를 쓰지만 실제로 검증하지는 않았습니다.

## 필요 조건

- Node.js `>=22.19.0`
- Bun `>=1.4.2`. 앱과 `usage`·`btw` 사이드카가 Bun으로 실행됩니다.
- Git
- 사용할 모델 제공자 계정(Anthropic, OpenAI 등). 로그인은 사람이 직접 해야 합니다(아래 4단계).

## 1. 받기

```sh
git clone https://github.com/gim47656-ship-it/CUELO.git
cd CUELO
```

## 2. 설치 (`setup`)

```sh
node install.mjs setup
```

소스 checkout에서는 다음 순서로 실행되며, 어느 단계든 실패하면 그 자리에서 멈추고 exit code 1을 돌려줍니다.

1. `bun install --frozen-lockfile`
2. `bun run build`
3. SDK 런타임 패치 적용 뒤 `--check` 확인(`native-runtime-patch.js`, `apply-core-patch.mjs`, `apply-notices.mjs`)
4. 공개 하네스(`Tools/OMP_Global_Config/agent/`)를 `~/.omp/agent`에 복사. 없는 파일만 추가하고, 이미 있는 파일은 바꾸거나 지우지 않습니다.
5. `~/.omp/agent/config.yml`이 없으면 새로 만듭니다. 기본 운영 설정을 넣고, 넘긴 모델 역할이 있으면 함께 적습니다(아래 참고). 파일이 이미 있으면 바꾸지 않습니다.

새 `config.yml`에 들어가는 기본값은 다음과 같습니다. 하네스의 Maker 역할이 번들 에이전트(`scout`, `sonic`, `task`, `reviewer`, `security-reviewer`)를 대신하고, task 실행은 격리 환경에서 돌도록 설정합니다. 제공자 요청을 스스로 쓰는 자동 기능(`autolearn.autoContinue`, `mnemopi.autoRetain`)은 꺼 둡니다. omp 기본값과 같은 설정은 적지 않습니다.

```yaml
defaultThinkingLevel: auto
autolearn: { enabled: true, autoContinue: false }
memory: { backend: mnemopi }
mnemopi: { scoping: per-project-tagged, embeddingVariant: multilingual, autoRetain: false }
task:
  softRequestBudget: 400
  maxConcurrency: 8
  eager: preferred
  maxEffort: xhigh
  isolation: { enabled: true }
  disabledAgents: [scout, sonic, task, reviewer, security-reviewer]
```

1~3단계는 사용자 프로필이 아니라 CUELO 폴더 안의 `.runtime-patch-home`을 home으로 써서 실행합니다(CI와 같은 격리 방식). 그래서 빌드는 사용자의 omp 설정을 읽지 않고, Windows 보호 폴더를 건드리다 EPERM으로 실패하지도 않습니다. `--home`은 4단계에서 하네스를 복사할 위치만 정합니다.

### 모델 역할 지정(선택)

```sh
node install.mjs setup --model <provider>/<model> --role implOpus=<provider>/<model>[:effort]
```

- `--model`은 core의 `default` 역할만 설정합니다.
- `--role <이름>=<provider/model>`은 하네스 역할을 하나씩 지정하며, 여러 번 쓸 수 있습니다. 사용할 수 있는 이름은 `implSol`, `implOpus`, `implDeepSeek`, `makerHardUiOpus`, `makerHardCodeOpus`, `makerHardCodeAstra`입니다.
- 역할은 `config.yml`을 새로 만들 때만 기본값과 함께 기록됩니다. 파일이 이미 있으면 절대 고치지 않고, 무시한 역할과 아직 지정되지 않은 역할을 출력합니다.
- 지정하지 않은 역할은 나중에 CUELO 설정의 Model roles 화면에서 고릅니다. 설치 스크립트는 모델을 추측해서 채우지 않습니다.

### 다른 프로필에 설치(`--home`)

```sh
node install.mjs setup --home <dir>
```

`HOME`·`USERPROFILE`·`PI_CODING_AGENT_DIR`를 `<dir>` 기준으로 바꿔 `<dir>/.omp/agent`에 설치합니다. 실행할 때도 같은 `--home`을 넘겨야 같은 프로필을 읽습니다.

## 3. 공개 범위

하네스와 공개 범위는 [하네스 안내](harness.md)에 정리돼 있습니다. `config.yml`·`models.yml`, 개인 skills, 작업 기록은 공개 저장소에 없습니다.

## 4. 실행 (`start`)

```sh
node install.mjs start
```

- 앱(`bin/cuelo.js --no-open --hostname 127.0.0.1`), `usage`, `btw`, `subagent`를 포그라운드로 함께 띄웁니다. 앱 주소는 환경의 `CUELO_HOSTNAME`과 무관하게 항상 `127.0.0.1`입니다.
- 로그는 `[web]`·`[usage]`·`[btw]`·`[subagent]` 접두어를 붙여 출력합니다.
- 브라우저는 자동으로 열지 않습니다. 시작할 때 출력되는 주소(기본 `http://127.0.0.1:30141`)를 직접 엽니다.
- Ctrl+C를 누르면 네 프로세스를 모두 종료합니다.
- 빌드(`.next/BUILD_ID`)가 없거나 포트가 이미 사용 중이면 시작하지 않고 exit code 1로 끝납니다.

기본 포트는 다음과 같으며, 모두 `127.0.0.1`에서만 listen합니다.

| 서비스 | 포트 | 변수 |
| --- | --- | --- |
| 앱 | 30141 | `PORT` |
| usage | 30142 | `OMP_USAGE_PORT` |
| btw | 30143 | `OMP_BTW_PORT` |
| subagent | 30144 | `OMP_SUBAGENT_PORT` |

### 다른 포트 세트로 실행

이미 CUELO가 기본 포트로 실행 중일 때처럼 다른 포트가 필요하면 시작 포트를 직접 지정합니다.

```sh
node install.mjs start --port-base 31141
node install.mjs health --port-base 31141
```

`--port-base n`은 네 서비스를 `n`, `n+1`, `n+2`, `n+3`에 띄우고, 앱의 사이드카 프록시도 같은 포트를 가리키게 합니다. `n`은 1부터 65532까지의 숫자만 받습니다. `--port-base` 없이 위 변수를 직접 설정해도 되고, 둘 다 없으면 기본값을 씁니다. 빈 포트를 자동으로 찾아 주지는 않습니다.

## 5. 상태 확인 (`health`)

다른 터미널에서 실행합니다.

```sh
node install.mjs health
```

네 서비스에 요청을 하나씩 보내 응답 여부만 확인합니다. 인증을 하거나 모델 제공자를 호출하지는 않습니다.

- 앱: `GET /api/update-maintenance` → 200
- usage: `OPTIONS /usage` → 204
- btw: `GET /health` → 200
- subagent: `GET /health` → 200

모두 응답하면 exit code 0, 하나라도 실패하면 1입니다.

## 6. 로그인 (사람이 할 일)

제공자 계정 로그인은 브라우저 OAuth나 API 키 입력이 필요하므로 사람이 직접 합니다. `start`로 띄운 CUELO를 브라우저에서 열고 **Settings > Models**에서 쓸 제공자의 로그인 버튼을 누릅니다. 로그인 정보는 `start`가 쓰는 프로필에 저장되며, `--home`을 썼다면 그 프로필입니다.

공식 omp CLI(`@oh-my-pi/pi-coding-agent`)를 이미 설치해 두었다면 `omp login`을 써도 됩니다. 이 안내는 CLI를 따로 설치하지 않습니다. 캐릭터 확장이 쓰는 Anthropic OAuth 0번·1번 자리의 의미는 [하네스 안내](harness.md)를 참고하세요.

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| `No production build found` | `node install.mjs setup`을 먼저 끝냅니다. |
| `Already in use: …` | 기존 CUELO를 종료하거나 `--port-base`로 다른 포트를 씁니다. |
| Bun을 찾을 수 없다는 오류 | Bun `>=1.4.2`를 설치하고 새 셸을 엽니다. |
| `[btw] omp SDK not found` | `node install.mjs start`로 실행합니다. 이 스크립트가 `CUELO_DIR`를 CUELO 폴더로 설정합니다. |
| 사용량 패널 오류 | usage 사이드카는 기본 위치, `OMP_EXE`, PATH 순으로 `omp` 실행 파일을 찾습니다. 로그인이 끝났는지 확인합니다. |
| 사이드채팅이 입력을 받지 않음 | 세션 파일이 생성될 때까지 기다립니다. `health`에서 `btw`가 OK인지 확인합니다. |
| 모델 역할이 비어 있음 | 설정 > Model roles에서 고릅니다. `setup`은 기존 `config.yml`을 바꾸지 않습니다. |

exit code: `0` 성공, `1` 실행 실패, `2` 잘못된 인자(사용법 출력).
