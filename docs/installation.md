# CUELO 설치와 실행

이 문서는 CUELO 앱, 로컬 사이드카 3개(사용량 `usage`, 사이드채팅 `btw`, Subagent 기록 `subagent`), 공개 하네스의 설치·실행 경계를 설명합니다. `setup`·`start`는 사용자가 직접 명령할 때 실행됩니다. 단, **npm 설치는 패키지의 `postinstall`에서 그 패키지 안의 SDK 패치를 자동으로 준비합니다.** 예약 작업·제공자 로그인은 자동 실행하지 않습니다.

## 현재 배포 상태

- **소스 설치**: checkout 후 `node install.mjs setup`을 실행합니다(아래 절차).
- **npm 설치**: 패키지명은 [`cuelo`](https://www.npmjs.com/package/cuelo)입니다. production 빌드가 포함되며 설치 때 패키지 자체 SDK를 준비합니다. `cuelo setup`은 빌드를 건너뛰고 준비된 런타임을 검사한 뒤 공개 하네스의 없는 파일만 추가합니다.
- **개발·검증 환경**: Windows입니다. macOS·Linux는 개발·테스트 환경이 아니므로 동작과 지원을 보장하지 않습니다.

## 대표 경로: `omp`만 있는 Windows PC (`omp-web` 없음)

1. 기존 `omp --version`과 본인 `~/.omp/agent`의 `config.yml`·계정·세션이 있는지 확인합니다. **`omp-web`은 설치할 필요가 없습니다.** 독립 `omp.exe`가 있다고 Node.js/npm·Bun이 따라오는 것은 아니므로, 아래 필요 조건도 설치·확인합니다.
2. `npm install -g cuelo` → `cuelo setup` → `cuelo start`를 실행합니다. `setup`은 기존 `config.yml`과 동명 하네스 파일을 **덮어쓰지 않고**, 현재 `omp` 프로필에 없는 공개 파일만 더합니다. 기존 `agent.db`, `models.yml`, skills, 세션도 보존합니다. 앱 패치는 설치된 `cuelo` 패키지의 SDK에만 적용되며, 별도 `omp.exe`에는 적용되지 않습니다.
3. 브라우저에서 출력 주소를 열고 **Settings > Models**에서 기존 로그인 상태와 사용할 모델을 확인합니다. `cuelo health`는 네 서비스 응답만 검사하므로 로그인과 대화 성공을 뜻하지 않습니다.
4. 기존 `config.yml`이면 `--model`·`--role`을 다시 줘도 설치기가 무시합니다. 아래 [기존 프로필의 역할과 Jev 보완](#기존-프로필의-역할과-jev-보완)대로 **현재 모델 역할과 제공자 자격을 직접 확인**해야 Main/Maker/Jev가 동작합니다. 기존 로그인·세션을 삭제하거나 프로필을 새로 복사할 필요는 없습니다.

이 경로는 **기존 프로필을 흉내 낸 격리 HOME**에서 설정 보존/누락 보고를 확인하는 경계 검사입니다. 실제 사용자 `omp` 홈을 수정하거나 `omp-web`이 없는 새 Windows OS를 부팅해 end-to-end로 검증한 결과는 아닙니다.

## 새 Windows PC에서 먼저 준비할 것

Windows 10 1809 이상에서 다음을 사용자가 직접 설치합니다(Bun의 Windows 최소 버전). Node/Bun/Git은 OS별 설치·업데이트를 각 공식 배포처에서 관리하며, 사용자 계정 자격은 개인 정보이므로 CUELO에 동봉하지 않습니다. 설치 후 **새 PowerShell**에서 버전을 확인하세요.

| 항목 | 분류·마지막 사용자 행동 |
| --- | --- |
| [Node.js](https://nodejs.org/en/download) `>=22.19.0`와 동봉된 npm | 외부 필수. Windows 설치본을 설치하고 `node --version`, `npm --version`을 확인합니다. `install.mjs`와 npm 설치에 사용합니다. |
| [Bun](https://bun.sh/docs/installation) `>=1.4.2` | 외부 필수. 공식 Windows 설치 안내를 따라 설치하고 `bun --version`을 확인합니다. 앱과 `usage`·`btw`가 사용합니다. |
| [Git for Windows](https://git-scm.com/install/windows) | 전체 코딩·Git 기능 기준 외부 필수. 설치하고 `git --version`을 확인합니다. 소스 `git clone`, worktree, commit 등에 사용합니다. npm 설치와 기본 대화·내장 `bash`만 시험할 때는 생략할 수 있습니다. SDK는 Windows에서 Git Bash가 없어도 `cmd.exe`로 fallback하지만, Git 명령까지 제공하지는 않습니다. |
| 모델 제공자 계정과 자격 | 대화의 외부 필수. 본인이 지원 제공자 계정(OAuth 또는 API 키)을 준비하고 아래 4단계에서 직접 로그인합니다. 사용한 제공자의 과금·권한 조건은 본인이 확인합니다. 자격 없이 `health`만 성공해도 대화는 불가능합니다. |
| Jev 판정 자격 | 하네스의 `maker_route`·typed judgment를 쓰려면 외부 필수. 아래 Jev 절에서 판정 백엔드와 자격을 고릅니다. Vercel 고정 모드는 일반 채팅 로그인과 별도의 Vercel AI Gateway API 키가 필요하며, `auto`는 지원하는 로그인 후보를 사용할 수 있습니다. |
| 독립 `omp` CLI | 기본 앱 대화의 필수는 아닙니다. 터미널 `omp` 작업·usage의 CLI fallback·`stats` 집계가 필요할 때 [공식 Windows 설치 절차](https://github.com/can1357/oh-my-pi#install)를 따르고 `omp --version`을 확인합니다. 사용량 사이드카는 같은 패키지 SDK를 우선 읽고 실패 시 `OMP_EXE` 또는 PATH의 `omp.exe`를 실행합니다. CUELO 설치기는 CLI를 설치하지 않습니다. |

Windows에 `winget`이 있으면 Node·Git 설치에 써도 됩니다. 위 공식 링크의 설치본을 직접 받아도 됩니다. 네트워크와 설치 권한이 없는 PC에서는 먼저 설치본과 승인된 계정·접속 방법을 준비해야 합니다. 제공자 로그인, Git/CLI·OS 설치, 유료 모델 호출을 `setup`이 대신하지 않습니다.

## 동봉 파일과 남은 외부 경계

| 파일·서비스 | 포함/외부/선택 | 설치 뒤 할 일 |
| --- | --- | --- |
| `cuelo` 앱(`.next`, `bin/`, `install.mjs`)·고정된 `@oh-my-pi/*` SDK | 앱 파일은 npm 패키지에 포함, SDK는 npm 의존성으로 함께 설치. 소스는 `bun install`·빌드로 생성 | `setup`을 완료하고 `start` 뒤 주소를 엽니다. npm은 해당 패키지의 SDK에 `postinstall` 패치를 적용합니다. |
| `Tools/CUELO_Setup/files/{usage,btw,subagent}-server.js` | GitHub·npm 모두 포함. `start`가 네 서비스 중 세 사이드카를 함께 시작 | `health`로 네 포트의 응답을 확인합니다. 사이드챗은 모델 인증, 사용량 수치는 계정/SDK 또는 `omp` CLI 경로가 별도로 필요합니다. |
| `native-runtime-patch.js`, `apply-core-patch.mjs`, `apply-notices.mjs`·공개 notices | GitHub·npm 포함. 소스 `setup`은 빌드 뒤 적용, npm `postinstall`은 설치된 패키지 SDK에 적용 | 패치 실패 시 오류를 해결하고 재설치/준비합니다. 독립 설치한 `omp.exe`에는 CUELO의 앱 SDK 패치가 적용되지 않습니다. |
| 공개 `Tools/OMP_Global_Config/agent/`의 규칙·SOP·확장·도구 | GitHub·npm 포함. `setup`이 없는 파일만 `~/.omp/agent`에 추가 | 기존 프로필에 오래된 동명 파일이 있으면 자동 갱신되지 않으므로 직접 대조합니다. 제공자·역할·Jev 설정은 아래에서 따로 지정합니다. |
| 개인 `config.yml`·`models.yml`·skills·`agent.db`·세션 | 공개본에 **없음**. `setup`은 빈 프로필의 운영 기본값 `config.yml`만 생성 | 본인 계정으로 로그인하고 본인 모델을 선택합니다. 타인의 프로필·인증·대화는 복사하지 않습니다. |
| Mnemopi 로컬 임베딩 `fastembed`/모델 | **기능별 외부 첫 사용 다운로드**, npm에 모델 파일을 동봉하지 않음 | 메모리 임베딩을 쓸 PC에서 첫 사용 시 네트워크·다운로드/캐시 공간을 허용합니다. `fastembed`가 없으면 SDK가 Bun으로 별도 런타임 캐시에 설치하고 모델 파일은 내려받습니다. 설치/다운로드 실패를 벡터 검색 성공으로 혼동하지 않습니다. |
| SHION(Web6) 상담·Codex live 음성 | **선택**. 외부 브리지/제공자 자격·브라우저 마이크 권한 등 별도 환경이 필요한 기능 | 필요한 경우에만 해당 서비스와 권한을 사용자가 준비합니다. 네 서비스 `health`로 이 연결을 검증하지 않습니다. |

현재 PC의 Node 24/Bun 1.4.2를 가진 빈 프로필·격리 npm prefix에서 설치와 네 서비스 경로를 시험했습니다. **운영체제 자체가 비어 있는 Windows VM/새 PC의 전체 설치, 외부 로그인, 유료 Jev 호출, 최초 임베딩 다운로드는 검증하지 않았습니다.** macOS·Linux 지원도 보장하지 않습니다.

## npm으로 설치하기

```sh
npm install -g cuelo
cuelo setup
cuelo start
```

다른 터미널에서 `cuelo health`로 확인합니다. 기본 포트가 사용 중이면 `cuelo start --port-base 31141`과 `cuelo health --port-base 31141`을 사용하세요. 이후 제공자 로그인과 모델 선택은 아래 4단계와 같습니다. 기존 프로필·계정·설정은 덮어쓰지 않습니다.

아래 1~3단계는 npm 대신 소스에서 설치할 때의 절차입니다.

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

### 기존 프로필의 역할과 Jev 보완

`omp`만 설치했던 프로필에는 `config.yml`이 이미 있을 수 있습니다. `setup` 출력의 `Model roles not set`은 **사용자에게 남은 작업**이지 자동 설정 성공이 아닙니다. 자신의 `~/.omp/agent/config.yml`을 백업하고, 현재 키를 삭제하지 말고 다음을 대조합니다. 다른 `--home`을 썼다면 그 안의 `.omp/agent/config.yml`을 봅니다.

1. 대화용 `modelRoles.default`를 **Settings > Models > Model roles**에서 현재 로그인한 제공자의 모델로 정합니다. 기존 설정이 올바르면 유지합니다. 앱에서 프로젝트별 역할로 저장할 수도 있으므로, Main/Maker가 읽을 **global** 설정인지 확인하세요.
2. Maker 후보는 아래 키를 같은 `modelRoles` 지도에 추가합니다. 임의 모델을 자동으로 채우지 않습니다. 새 사용자 본인이 로그인·사용 가능 여부, 모델 registry의 지원 추론 단계와 사용 비용을 확인해 `provider/model[:effort]`를 골라야 합니다. 기존에 없는 **사용자 정의 키는 먼저 YAML에 직접 추가**하면 Model roles 화면에 표시되어 나중에 바꿀 수 있습니다.

   | `modelRoles` 키 | 담당 후보 | 준비 기준 |
   | --- | --- | --- |
   | `implSol` | NORMAL 비-UI 우선 | 해당 Sol 모델 및 `high`/`xhigh` 지원 |
   | `implOpus` | NORMAL UI/UX | Opus 모델 및 `high`/`xhigh` 지원 |
   | `implDeepSeek` | NORMAL 대안 | DeepSeek 모델 및 `high` 지원. Sol이 실제 불가할 때만 사용 |
   | `makerHardUiOpus` | HARD UI/UX | Opus 모델 지원 |
   | `makerHardCodeOpus` | HARD 코드 | Opus 모델 지원 |
   | `makerHardCodeAstra` | HARD 코드 대안 | Astra 모델 지원 |

   일부만 쓰면 빠진 후보는 `maker_route`에서 사용 불가로 나타나며, 후보가 하나도 없으면 발주할 수 없습니다. `default`는 이 여섯 자리를 대신 채우지 않습니다. 하네스의 격리 task/번들 에이전트 대체/요청 예산도 기존 프로필에는 자동 주입되지 않습니다. 새 프로필 기본값이 필요하면 위의 YAML 예시의 `task`·`autolearn`·`memory`·`mnemopi` 키를 **기존 값과 비교하여 필요한 키만** 병합하세요. 특히 자동 제공자 호출 옵션은 사용자 판단 없이 켜지 마세요.
3. Jev를 Vercel AI Gateway 고정 판정으로 쓰려면 본인이 [Vercel AI Gateway API 키 안내](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys)에 따라 키를 발급받아 CUELO **Settings > Models > Vercel AI Gateway > API Key**에 입력합니다. 같은 프로필의 `config.yml`에서 기존 `providers` 지도의 다른 키를 보존하면서 `judgmentProvider: vercel`을 **추가하거나 변경**합니다.

   ```yaml
   providers:
     judgmentProvider: vercel
   ```

   이 고정 모드는 SDK의 `vercel-ai-gateway` 자격으로 `typesafe-ai/jev` 판정 endpoint를 호출합니다. `modelRoles.judge`를 적어도 Vercel 고정 모드가 그 역할을 대신 읽지는 않습니다. 반대로 기본 `providers.judgmentProvider: auto`는 `modelRoles.judge` 후보 체인(자격 있는 native 판정·chat/local 후보, 조건에 따라 현재 세션 모델)을 사용하며 **Vercel Jev 고정 모드가 아닙니다**. auto를 쓰겠다면 판정 가능한 모델과 그 제공자 자격을 별도로 확인하세요. TypeSafe native 판정을 고른다면 [TypeSafe API 키](https://console.typesafe.ai/)와 실제 registry에 보이는 `judge` 모델도 필요합니다. 판정 요청은 외부 전송·과금 가능성이 있으므로 본인 승인과 요금 확인 없이 시험 호출하지 않습니다.
4. `cuelo health` 또는 하네스 파일 복사 성공은 Jev 성공 증거가 아닙니다. 실제 로그인 상태, 모델 후보 해석, 첫 판정/응답은 사용자가 준비한 자격으로 별도 확인해야 합니다. 키가 없거나 실패하면 Jev가 무언가를 조용히 대체해 설치 성공으로 만드는 계약도 없습니다.

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
| 사용량 패널 오류 | 같은 패키지 SDK/계정 경로가 실패한 경우 CLI fallback은 `OMP_EXE`, 기본 위치 또는 PATH의 `omp.exe`를 찾습니다. `omp --version`과 본인 계정 로그인을 확인합니다. `stats` 집계는 독립 CLI가 필요합니다. |
| 사이드채팅이 입력을 받지 않음 | 세션 파일이 생성될 때까지 기다립니다. `health`에서 `btw`가 OK인지 확인합니다. |
| 모델 역할이 비어 있음 | 설정 > Model roles에서 고릅니다. `setup`은 기존 `config.yml`을 바꾸지 않습니다. |

exit code: `0` 성공, `1` 실행 실패, `2` 잘못된 인자(사용법 출력).
