# CUELO 설치와 실행

이 문서는 CUELO 앱, 로컬 사이드카 3개(사용량 `usage`, 사이드채팅 `btw`, Subagent 기록 `subagent`), 공개 하네스의 설치·실행 경계를 설명합니다. `setup`·`start`는 사용자가 직접 명령하거나, 사용자가 업데이트 버튼으로 승인한 갱신에서 서버가 실행합니다. **npm 설치는 패키지의 `postinstall`에서 그 패키지 안의 SDK 패치를 자동으로 준비합니다.** 예약 작업·제공자 로그인은 자동 실행하지 않습니다.

## 현재 배포 상태

- **소스 설치**: checkout 후 `node install.mjs setup`을 실행합니다(아래 절차).
- **npm 설치**: 패키지명은 [`cuelo`](https://www.npmjs.com/package/cuelo)입니다. production 빌드가 포함되며 설치 때 패키지 자체 SDK를 준비합니다. `cuelo setup`은 빌드를 건너뛰고 준비된 런타임을 검사한 뒤 공개 하네스의 없는 파일만 추가합니다.
- **개발과 검증 환경**: Linux입니다. 공개 CI는 Linux에서 앱과 하네스를 검사하고 네이티브 리더를 플랫폼별로 빌드합니다. 네이티브 Windows 서버 설치는 지원하지 않으며 Windows CI와 Windows 릴리스 바이너리를 제공하지 않습니다. Windows 브라우저에서 Linux 서버에 접속하는 사용법과는 별개입니다. macOS는 전체 앱 동작과 지원을 보장하지 않습니다. 아래 안내는 Linux 기준이며, 모든 배포판과 새 OS의 제공자 로그인까지 검증한 것은 아닙니다.

npm 패키지와 공개 릴리스에는 미리 빌드한 네이티브 리더(`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`)가 들어 있어 일반 npm 설치나 공개 릴리스 소스 설치에는 Rust 컴파일러가 필요하지 않습니다. Windows용 파일은 포함하지 않으며, `darwin` 파일이 있다고 macOS 전체 앱 지원을 보장하지는 않습니다. 아직 공개되지 않았거나 직접 수정한 네이티브 소스를 빌드할 때는 로컬 Rust와 Cargo가 필요합니다. 설치기는 컴파일러를 자동으로 내려받지 않으며, 바이너리가 없거나 손상된 경우 설치 오류로 알립니다.

## 대표 경로: `omp`만 있는 Linux PC

1. 기존 `omp --version`과 본인 `~/.omp/agent`의 `config.yml`, 계정, 세션이 있는지 확인합니다. **`omp-web`은 설치할 필요가 없습니다.** 독립 `omp`가 있다고 Node.js/npm과 Bun이 따라오는 것은 아니므로, 아래 필요 조건도 설치하고 확인합니다.
2. `npm install -g cuelo` → `cuelo setup` → `cuelo start`를 실행합니다. `setup`은 기존 `config.yml`과 동명 하네스 파일을 **덮어쓰지 않고**, 현재 `omp` 프로필에 없는 공개 파일만 더합니다. 기존 `agent.db`, `models.yml`, skills, 세션도 보존합니다. 앱 패치는 설치된 `cuelo` 패키지의 SDK에만 적용되며, 별도 독립 `omp`에는 적용되지 않습니다.
3. 브라우저에서 출력 주소를 열고 **설정 > 모델·계정**에서 기존 로그인 상태와 사용할 모델을 확인합니다. `cuelo health`는 네 서비스 응답만 검사하므로 로그인과 대화 성공을 뜻하지 않습니다.
4. 기존 `config.yml`이면 `--model`·`--role`을 다시 줘도 설치기가 무시합니다. 아래 [기존 프로필의 역할과 Jev 보완](#기존-프로필의-역할과-jev-보완)대로 **현재 모델 역할과 제공자 자격을 직접 확인**해야 Main/Maker/Jev가 동작합니다. 기존 로그인·세션을 삭제하거나 프로필을 새로 복사할 필요는 없습니다.

이 경로는 **기존 프로필을 흉내 낸 격리 HOME**에서 설정 보존과 누락 보고를 확인한 경계 검사입니다. 실제 사용자 `omp` 홈을 수정하거나 새 Linux OS를 부팅해 처음부터 끝까지 검증한 결과는 아닙니다.

## 새 Linux PC에서 먼저 준비할 것

Linux에서 다음을 사용자가 직접 설치합니다. Node/Bun/Git은 배포판 패키지나 각 공식 배포처에서 관리하며, 사용자 계정 자격은 개인 정보이므로 CUELO에 동봉하지 않습니다. 설치 후 **새 셸**에서 버전을 확인하세요.

| 항목 | 분류·마지막 사용자 행동 |
| --- | --- |
| [Node.js](https://nodejs.org/en/download) `>=22.19.0`와 동봉된 npm | 외부 필수. 공식 Linux 설치 절차나 배포판 안내에 따라 설치하고 `node --version`, `npm --version`을 확인합니다. `install.mjs`와 npm 설치에 사용합니다. |
| [Bun](https://bun.sh/docs/installation) `>=1.4.4` | 외부 필수. 공식 Linux 설치 안내를 따라 설치하고 `bun --version`을 확인합니다. 앱과 `usage`, `btw`가 사용합니다. |
| [Git](https://git-scm.com/downloads/linux) | 전체 코딩과 Git 기능 기준 외부 필수. 공식 Linux 패키지 안내에 따라 설치하고 `git --version`을 확인합니다. 소스 `git clone`, worktree, commit 등에 사용합니다. npm 설치와 기본 대화만 시험할 때는 생략할 수 있으나 Git 명령은 제공되지 않습니다. |
| 모델 제공자 계정과 자격 | 대화의 외부 필수. 본인이 지원 제공자 계정(OAuth 또는 API 키)을 준비하고 아래 4단계에서 직접 로그인합니다. 사용한 제공자의 과금·권한 조건은 본인이 확인합니다. 자격 없이 `health`만 성공해도 대화는 불가능합니다. |
| Jev 판정 자격 | 하네스의 `maker_route`·typed judgment를 쓰려면 외부 필수. 아래 Jev 절에서 판정 모델과 자격을 고릅니다. 기본은 TypeSafe API 키로 `modelRoles.judge`에 `typesafe/jev-1.14.0`을 지정하는 방법이고, 그 키가 없으면 OpenRouter의 Jev로 넘어갑니다. |
| 독립 `omp` CLI | 기본 앱 대화의 필수는 아닙니다. 터미널 `omp` 작업, usage의 CLI fallback, `stats` 집계가 필요할 때 [공식 설치 절차](https://github.com/can1357/oh-my-pi#install)를 따르고 `omp --version`을 확인합니다. 사용량 사이드카는 같은 패키지 SDK를 우선 읽고 실패 시 `OMP_EXE`를 먼저 보며, 없으면 CUELO 폴더의 `node_modules/.bin/omp`를 쓰고 없을 때만 `PATH`의 `omp`를 찾습니다. CUELO 설치기는 CLI를 설치하지 않습니다. |

배포판 패키지 관리자나 공식 설치 스크립트를 써도 됩니다. 네트워크와 설치 권한이 없는 PC에서는 먼저 설치본과 승인된 계정, 접속 방법을 준비해야 합니다. 제공자 로그인, Git/CLI와 OS 설치, 유료 모델 호출을 `setup`이 대신하지 않습니다.

## 동봉 파일과 남은 외부 경계

| 파일·서비스 | 포함/외부/선택 | 설치 뒤 할 일 |
| --- | --- | --- |
| `cuelo` 앱(`.next`, `bin/`, `install.mjs`)·고정된 `@oh-my-pi/*` SDK | 앱 파일은 npm 패키지에 포함, SDK는 npm 의존성으로 함께 설치. 소스는 `bun install`·빌드로 생성 | `setup`을 완료하고 `start` 뒤 주소를 엽니다. npm은 해당 패키지의 SDK에 `postinstall` 패치를 적용합니다. |
| `Tools/CUELO_Setup/files/{usage,btw,subagent}-server.js` | GitHub·npm 모두 포함. `start`가 네 서비스 중 세 사이드카를 함께 시작 | `health`로 네 포트의 응답을 확인합니다. 사이드챗은 모델 인증, 사용량 수치는 계정/SDK 또는 `omp` CLI 경로가 별도로 필요합니다. |
| `native-runtime-patch.js`, `apply-core-patch.mjs`, `apply-notices.mjs`·공개 notices | GitHub·npm 포함. 소스 `setup`은 빌드 뒤 적용, npm `postinstall`은 설치된 패키지 SDK에 적용 | 패치 실패 시 오류를 해결하고 재설치/준비합니다. 독립 설치한 `omp.exe`에는 CUELO의 앱 SDK 패치가 적용되지 않습니다. |
| 공개 `Tools/OMP_Global_Config/agent/`의 규칙·SOP·확장·도구 | GitHub·npm 포함. `setup`이 없는 파일만 `~/.omp/agent`에 추가 | 기존 프로필에 오래된 동명 파일이 있으면 자동 갱신되지 않습니다. [기존 프로필의 하네스 갱신](#기존-프로필의-하네스-갱신)의 `harness-diff`로 차이를 보고 `harness-update`로 반영합니다. 제공자·역할·Jev 설정은 아래에서 따로 지정합니다. |
| 개인 `config.yml`·`models.yml`·skills·`agent.db`·세션 | 공개본에 **없음**. `setup`은 빈 프로필의 운영 기본값 `config.yml`만 생성 | 본인 계정으로 로그인하고 본인 모델을 선택합니다. 타인의 프로필·인증·대화는 복사하지 않습니다. |
| Mnemopi 로컬 임베딩 `fastembed`/모델 | **기능별 외부 첫 사용 다운로드**, npm에 모델 파일을 동봉하지 않음 | 메모리 임베딩을 쓸 PC에서 첫 사용 시 네트워크·다운로드/캐시 공간을 허용합니다. `fastembed`가 없으면 SDK가 Bun으로 별도 런타임 캐시에 설치하고 모델 파일은 내려받습니다. 설치/다운로드 실패를 벡터 검색 성공으로 혼동하지 않습니다. |
| 큰 음성 처리용 FFmpeg | `ffmpeg-static` 의존성 설치 때 플랫폼 실행 파일 다운로드 | 설치 중 다운로드와 디스크 공간이 필요합니다. 별도 실행 파일로 사용하며 해당 배포물의 GPL-3.0-or-later 라이선스가 적용됩니다. 다운로드·변환 실패는 [음성 첨부 안내](./attachments.md)에서 확인합니다. |
| SHION(Web6) 상담·Codex live 음성 | **선택**. 외부 브리지/제공자 자격·브라우저 마이크 권한 등 별도 환경이 필요한 기능 | 필요한 경우에만 해당 서비스와 권한을 사용자가 준비합니다. 네 서비스 `health`로 이 연결을 검증하지 않습니다. |

Codex live 통화는 버튼으로 끝내거나, “끊어”, “알았어, 끊어봐”, “아니 통화 종료하라고”, “통화 종료해 줘”처럼 종료 요청만 말해 끝낼 수 있습니다. 사용자 발화가 최종 전사로 확정된 뒤 마이크와 연결을 닫습니다. “끊지 마”, “끊어라고 하면…”, “통화 종료가 안 먹네” 같은 말이나 AI의 발화에는 반응하지 않습니다. 이미 에이전트에 맡긴 코딩 작업은 통화 종료로 취소되지 않습니다. 통화 목소리는 설정에서 고르는 Codex 목소리이며 별도 키가 필요 없습니다. 자세한 내용은 [라이브 통화](./live-voice.md)를 확인하세요.

과거 Node 24와 Bun 1.4.2를 가진 빈 프로필과 격리 npm prefix에서 설치와 네 서비스 경로를 확인한 이력은 **당시의 경계 시험 기록**입니다. 새 Linux OS 전체 설치, 모든 배포판 호환성, 외부 로그인, 유료 Jev 호출, 최초 임베딩 다운로드를 새로 검증한 것은 아닙니다. 네이티브 Windows 서버 설치는 지원하지 않으며 macOS 지원은 보장하지 않습니다.

## npm으로 설치하기

```sh
npm install -g cuelo
cuelo setup
cuelo start
```

다른 터미널에서 `cuelo health`로 확인합니다. 기본 포트가 사용 중이면 `cuelo start --port-base 31141`과 `cuelo health --port-base 31141`을 사용하세요. 이후 제공자 로그인과 모델 선택은 아래 4단계와 같습니다. 기존 프로필·계정·설정은 덮어쓰지 않습니다.

새 릴리스가 나오면 사이드바의 업데이트 알림에서 「지금 업데이트」 버튼을 눌러 진행할 수 있습니다. 확인 후 CUELO가 스스로 새 버전을 받아 설치하고 서버를 다시 시작합니다. 이 과정에서 실행 중인 세션은 중단되고 서버가 잠시 멈춥니다. 그동안 화면에 단계별 진행이 나오고 새 버전이 응답하면 스스로 새로 고칩니다.

이때 서버는 현재 환경에 맞는 설치 방식을 고릅니다. npm 전역 설치는 `npm install -g cuelo@<버전>`으로 바꿉니다. 소스 체크아웃은 다음 다섯 조건을 모두 갖췄을 때 「지금 업데이트」 버튼으로 갱신합니다.

- 서버를 `node install.mjs start`로 시작했습니다.
- 개발 서버가 아닌 운영 빌드가 있습니다.
- 커밋하지 않은 변경이 없습니다.
- 분리된 HEAD가 아니라 브랜치 위에 있습니다.
- 알림이 안내한 릴리스 태그가 원격에 있습니다.

버튼이 작동하면 CUELO가 서버를 멈추고 브랜치를 해당 릴리스 태그로 fast-forward한 뒤 `node install.mjs setup`을 실행하고 다시 시작합니다. 시작할 때 `--home <dir>`를 지정했다면 같은 옵션을 `setup`에도 넘기고, 빌드에 실패하면 이전 릴리스로 되돌립니다.

조건을 하나라도 채우지 못하거나 설치 방식을 알아볼 수 없으면 화면에 수동 명령이 나옵니다. `setup`은 서버가 읽는 `.next/` 빌드 폴더를 새로 만들기 때문에 서버(또는 개발 서버)를 먼저 멈춥니다. 그다음 소스 체크아웃에서 `git pull --ff-only && node install.mjs setup`을 실행하고, `--home <dir>`로 시작했다면 `setup`에도 같은 옵션을 붙입니다. `setup`은 `bun install --frozen-lockfile`, SDK 소스 준비, 빌드, 패치와 고지문 적용·검사를 차례로 합니다. 끝나면 `node install.mjs start`로 다시 시작하세요. `git pull --ff-only`는 현재 브랜치 끝까지 가져오므로 아직 릴리스되지 않은 커밋이 포함될 수 있습니다. 특정 릴리스에 맞추려면 `git fetch --tags` 다음 `git merge --ff-only v<버전>`을 사용합니다.

프로필의 하네스 갱신은 앱 업데이트와 별개이며 아래 「기존 프로필의 하네스 갱신」을 따릅니다.

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

1. `bun install --frozen-lockfile --backend=copyfile`
2. `node bin/prepare-runtime.js --source`로 이 작업 사본의 SDK를 빌드 전에 준비합니다. 공유 패키지 캐시와 연결된 파일은 분리한 뒤 패치하므로 캐시 원본은 바뀌지 않습니다.
3. `bun run build`
4. SDK 런타임 패치 적용 뒤 `--check` 확인(`native-runtime-patch.js`, `apply-core-patch.mjs`, `apply-notices.mjs`)
5. 공개 하네스(`Tools/OMP_Global_Config/agent/`)를 `~/.omp/agent`에 복사. 없는 파일만 추가하고, 이미 있는 파일은 바꾸거나 지우지 않습니다. 이때 추가한 파일과 그 내용을 프로필의 `.cuelo-harness-installed.json`에 기록해, 나중에 [기존 프로필의 하네스 갱신](#기존-프로필의-하네스-갱신)이 사용자가 고치지 않은 파일을 알아볼 수 있게 합니다.
6. `~/.omp/agent/config.yml`이 없으면 새로 만듭니다. 기본 운영 설정을 넣고, 넘긴 모델 역할이 있으면 함께 적습니다(아래 참고). 파일이 이미 있으면 바꾸지 않습니다.

새 `config.yml`에 들어가는 기본값은 다음과 같습니다. 하네스의 Maker 역할이 번들 에이전트(`scout`, `sonic`, `task`, `reviewer`, `security-reviewer`)를 대신하고, task 실행은 격리 환경에서 돌도록 설정합니다. Maker가 정해진 형식의 완료 보고를 돌려주도록 `task.structured`를 켭니다(omp 기본값은 꺼짐). 60초를 넘긴 `eval` 셀은 사용자 말이 도착하면 background로 넘어가 대화가 막히지 않습니다(`eval.autoBackground`, omp 기본값은 꺼짐). 제공자 요청을 스스로 쓰는 자동 기능(`autolearn.autoContinue`, `mnemopi.autoRetain`)은 꺼 둡니다. omp 기본값과 같은 설정은 적지 않습니다.

```yaml
defaultThinkingLevel: auto
autolearn: { enabled: true, autoContinue: false }
memory: { backend: mnemopi }
mnemopi: { scoping: per-project-tagged, embeddingVariant: multilingual, autoRetain: false }
task:
  enableLsp: true
  softRequestBudget: 400
  maxConcurrency: 8
  eager: preferred
  maxEffort: xhigh
  isolation: { enabled: true }
  structured: true
  disabledAgents: [scout, sonic, task, reviewer, security-reviewer]
eval: { autoBackground: { enabled: true } }
```

1~3단계는 사용자 프로필이 아니라 CUELO 폴더 안의 `.runtime-patch-home`을 home으로 써서 실행합니다(CI와 같은 격리 방식). 그래서 빌드는 사용자의 omp 설정을 읽지 않고, Windows 보호 폴더를 건드리다 EPERM으로 실패하지도 않습니다. `--home`은 5·6단계에서 하네스를 복사하고 `config.yml`을 만들 프로필 위치만 정합니다. Bun 설치 캐시만은 평소 위치(`BUN_INSTALL_CACHE_DIR`, 없으면 `~/.bun/install/cache`)를 그대로 씁니다. 캐시가 CUELO 폴더 안에 쌓이면 빌드가 그것까지 훑어서 크게 느려지기 때문입니다. 예전 설치가 폴더 안에 남긴 `.runtime-patch-home/.bun/install/cache`는 `setup`이 지웁니다.

### 모델 역할 지정(선택)

```sh
node install.mjs setup --model <provider>/<model> --role implOpus=<provider>/<model>[:effort]
```

- `--model`은 core의 `default` 역할만 설정합니다.
- `--role <이름>=<provider/model>`은 하네스 역할을 하나씩 지정하며, 여러 번 쓸 수 있습니다. Maker 역할은 `implSol`, `implSonnet`, `implOpus`, `implDeepSeek`, `makerHardUiOpus`, `makerHardCodeOpus`, `makerHardCodeSonnet`이며, [도구·검토·판정 역할](#하네스-도구검토판정-역할)도 같은 옵션으로 지정합니다.
- 역할은 `config.yml`을 새로 만들 때만 기본값과 함께 기록됩니다. 파일이 이미 있으면 절대 고치지 않고, 무시한 역할과 아직 지정되지 않은 역할을 출력합니다.
- 지정하지 않은 역할은 나중에 CUELO 설정의 Model roles 화면에서 고릅니다. 설치 스크립트는 모델을 추측해서 채우지 않습니다.

### 기존 프로필의 역할과 Jev 보완

`omp`만 설치했던 프로필에는 `config.yml`이 이미 있을 수 있습니다. `setup` 출력의 `Model roles not set`은 **사용자에게 남은 작업**이지 자동 설정 성공이 아닙니다. 자신의 `~/.omp/agent/config.yml`을 백업하고, 현재 키를 삭제하지 말고 다음을 대조합니다. 다른 `--home`을 썼다면 그 안의 `.omp/agent/config.yml`을 봅니다.

1. 대화용 `modelRoles.default`를 **설정 > 모델·계정 > 모델 역할**에서 현재 로그인한 제공자의 모델로 정합니다. 기존 설정이 올바르면 유지합니다. 앱에서 프로젝트별 역할로 저장할 수도 있으므로, Main/Maker가 읽을 **global** 설정인지 확인하세요.
2. Maker 후보는 같은 **설정 > 모델·계정 > 모델 역할** 화면에서 고릅니다. 아래 일곱 키는 프로필에 값이 없어도 목록 끝에 `미설정`으로 표시되므로 YAML을 먼저 고칠 필요가 없습니다. 화면을 여는 것만으로는 아무것도 저장되지 않고, 모델을 고른 역할만 선택한 저장 위치(전역 또는 이 프로젝트)의 `modelRoles`에 기록됩니다. 임의 모델을 자동으로 채우지 않습니다. 새 사용자 본인이 로그인·사용 가능 여부, 모델 registry의 지원 추론 단계와 사용 비용을 확인해 `provider/model[:effort]`를 골라야 합니다. 역할을 저장해도 로그인이나 실제 호출 가능 여부를 확인하지는 않습니다. YAML에 직접 적어도 결과는 같습니다.

   | `modelRoles` 키 | 담당 후보 | 준비 기준 |
   | --- | --- | --- |
   | `implSol` | 범위가 제한된 설계 선택과 구현 실패 뒤 재작업, 모든 Anthropic 계정이 오늘 몫을 넘겼을 때의 어려운 UI 추천 | OpenAI 쪽 구현 모델(이 저장소 기본은 GPT-6.1 Sol `:auto`) |
   | `implSonnet` | 비-UI 명시 선택 후보(Main이 `ROUTING_REASON`을 기록해 선택) | Sonnet 모델 지원. 자동 기본 추천 후보가 아닙니다 |
   | `implOpus` | 시각 또는 상호작용 설계가 열린 어려운 UI 작업의 기본 추천(NORMAL) | Anthropic 쪽 Opus 모델 지원. 모든 Anthropic 계정이 주간 창의 오늘 몫을 넘기면 `implSol`을 추천 |
   | `implDeepSeek` | 방향과 수용 조건이 정해진 작업의 가장 저렴한 기본 담당 | Hive의 DeepSeek V4.1 Flash 1017 모델 지원. 실패해도 Sonnet으로 자동 대체하지 않고 Main이 다시 판단 |
   | `makerHardUiOpus` | 시각 또는 상호작용 설계가 열린 어려운 UI 작업의 기본 추천(HARD) | Anthropic 쪽 Opus 모델 지원. 모든 Anthropic 계정이 주간 창의 오늘 몫을 넘기면 `implSol`을 추천 |
   | `makerHardCodeOpus` | 어려운 코드의 명시 선택 후보(Main이 `ROUTING_REASON`을 기록해 선택) | Opus 모델 지원 |
   | `makerHardCodeSonnet` | 어려운 코드의 명시 선택 후보(Main이 `ROUTING_REASON`을 기록해 선택) | Sonnet 모델 및 `medium`/`high`/`xhigh` 지원 |

   일부만 쓰면 빠진 후보는 `maker_route`에서 사용 불가로 나타나며, 후보가 하나도 없으면 발주할 수 없습니다. `default`는 이 일곱 자리를 대신 채우지 않습니다. 하네스의 격리 task/번들 에이전트 대체/요청 예산도 기존 프로필에는 자동 주입되지 않습니다. 새 프로필 기본값이 필요하면 위의 YAML 예시의 `task`·`autolearn`·`memory`·`mnemopi` 키를 **기존 값과 비교하여 필요한 키만** 병합하세요. 특히 자동 제공자 호출 옵션은 사용자 판단 없이 켜지 마세요.
3. Jev는 판정 전용 모델이라 판정 한 번이 1초 안에 끝납니다. 기본 경로는 [TypeSafe API 키](https://console.typesafe.ai/)를 발급받아 `typesafe/jev-1.14.0`을 직접 지정하는 것이고, 그 키가 없으면 요청은 OpenRouter의 `typesafe/jev-1.14`로 넘어갑니다. OpenRouter를 쓰려면 본인의 [OpenRouter API 키](https://openrouter.ai/settings/keys)를 발급받아(키별 금액 한도 설정 권장) CUELO **설정 > 모델·계정 > OpenRouter > API Key**에 입력합니다. 어느 쪽이든 같은 프로필의 `config.yml`에서 기존 키를 보존하면서 다음을 **추가하거나 변경**합니다.

   ```yaml
   modelRoles:
     judge: typesafe/jev-1.14.0
   ```

   판정 백엔드는 `modelRoles.judge` 후보 체인입니다. 첫 native 판정 후보(여기서는 TypeSafe의 Jev) 뒤로는 chat/local 후보와 현재 세션 모델을 붙이지 않으므로, 판정이 실패하면 느린 채팅 모델로 조용히 넘어가지 않고 호출자에게 실패가 전달됩니다. `judge`에 native 판정 모델이 없으면 chat/local 후보와 조건에 따라 현재 세션 모델을 쓰며, 이는 Jev 판정이 아닙니다. OpenRouter의 `openrouter/typesafe/jev-1.14`를 지정해도 native 판정입니다.

   예전 설정의 `providers.judgmentProvider`(`auto`·`vercel`)는 이제 쓰지 않습니다. 값이 남은 프로필은 설정을 읽을 때 upstream의 이전 규칙이 키를 지우며, `modelRoles.judge`가 이미 있으면 그 값을 그대로 두고 없을 때만 `typesafe/jev-latest` 후보 체인을 채웁니다(이 경우 TypeSafe API 키가 필요합니다). Vercel AI Gateway 고정 모드는 제거되어 `vercel-ai-gateway` 자격은 판정에 쓰이지 않습니다. 판정 요청은 외부 전송·과금 대상이므로 본인 승인과 요금 확인 없이 시험 호출하지 않습니다.
4. `cuelo health` 또는 하네스 파일 복사 성공은 Jev 성공 증거가 아닙니다. 실제 로그인 상태, 모델 후보 해석, 첫 판정/응답은 사용자가 준비한 자격으로 별도 확인해야 합니다. 키가 없거나 실패하면 Jev가 무언가를 조용히 대체해 설치 성공으로 만드는 계약도 없습니다.

### 하네스 도구·검토·판정 역할

공개 설치기(`node install.mjs setup`·`cuelo setup`의 `--role <키>=<provider/model>`)와 **설정 > 모델·계정 > 모델 역할** 화면은 Maker 역할에 더해 아래 역할도 지원합니다. `--role`은 새 `config.yml`을 만들 때만 기록하며 기존 프로필은 덮어쓰지 않습니다. 기존 프로필에서는 모델 역할 화면에서 미설정 슬롯을 확인하고 실제로 쓸 슬롯만 직접 골라 저장하세요.

코어가 이미 알고 있는 `judge`는 화면에서 중복 표시하지 않습니다. 저장해도 제공자 로그인이나 시험 호출은 실행되지 않습니다. 계정 자격과 과금 조건은 사용자가 직접 확인합니다.

| `modelRoles` 키 | 기능 | 설정 기준 |
| --- | --- | --- |
| `crossReviewOpenAI` | 교차검토의 OpenAI 계열 필수 검토자(슬롭 전용 슬롯이 비면 슬롭 검사에도 사용) | `openai` 또는 `openai-codex` 제공자의 모델을 고릅니다. |
| `crossReviewAnthropic` | 교차검토의 Anthropic 계열 필수 검토자(슬롭 전용 슬롯이 비면 슬롭 검사에도 사용) | `anthropic` 제공자의 모델을 고릅니다. |
| `crossReviewAdvisory` | 교차검토의 보조 검토자(선택, 기다리지 않음). 필수 검토자가 끝난 뒤 최대 60초만 기다리며, 그 안에 온 지적은 다른 지적처럼 닫습니다. | 어느 제공자의 텍스트 모델이든 고를 수 있습니다. 작성자나 필수 검토자와 같은 모델이면 호출하지 않고, 비워 두면 보조 호출이 없습니다. |
| `slopReviewOpenAI` | 슬롭 검사 검토자(선택) | `openai` 또는 `openai-codex` 제공자의 모델을 고릅니다. OpenAI 모델이 쓴 글은 이 슬롯 대신 `crossReviewAnthropic`이 검토합니다. 비우면 교차검토 슬롯을 씁니다. |
| `skim` | 여러 소스 파일을 읽고 질문에 답변 | 사용자가 연결한 텍스트 모델을 고릅니다. |
| `draft` | 문서·표·화면 문구 초안 작성 | 사용자가 연결한 텍스트 모델을 고릅니다. |
| `ocr` | 이미지의 글자·숫자·표 전사 | 시각 입력을 지원하는 모델을 고릅니다. |
| `interpreter` | 사용자의 한국어 입력을 영어로 옮겨 Main에 덧붙이고, Main의 한국어가 아닌 답을 한국어로 번역 | 빠른 텍스트 모델을 고릅니다. 비우면 `tiny` 역할 모델을 씁니다. |
| `judge` | 라우팅 등 구조화 판정 | Jev를 쓰려면 위의 [역할과 Jev 보완](#기존-프로필의-역할과-jev-보완) 절차를 따릅니다. |

필수 검토자는 작성 모델의 반대 계열을 사용합니다. 한 제공자에 로그인했다는 사실만으로 다른 계열의 검토 모델까지 사용할 수 있는 것은 아닙니다.

### 기존 프로필의 하네스 갱신

앱 버전만 올려서는 기존 프로필의 하네스 파일과 역할 설정이 바뀌지 않습니다. `setup`은 같은 이름의 파일과 기존 `config.yml`을 덮어쓰지 않습니다. 새 버전의 하네스는 다음 두 명령으로 반영합니다(npm 설치는 `cuelo harness-diff`·`cuelo harness-update`).

```sh
node install.mjs harness-diff
node install.mjs harness-update --dry-run
node install.mjs harness-update
```

`harness-diff`는 프로필의 하네스 파일을 지금 버전의 배포본과 비교해 다섯 가지로 나눕니다. `update-available`은 설치한 뒤 아무도 고치지 않았고 새 버전이 달라진 파일, `missing`은 프로필에 없는 파일, `user-modified`는 설치 뒤 사용자가 고친 파일, `untracked`는 설치 기록이 없는 파일이고, 나머지는 배포본과 같은 파일입니다. `harness-update`는 `update-available` 파일을 `.cuelo-harness-backup/<시각>/`에 백업한 뒤 바꾸고 `missing` 파일을 더합니다. `user-modified`·`untracked` 파일과 `config.yml`·`models.yml`·별도로 설치한 개인 스킬은 바꾸지 않습니다. 배포 목록에 포함된 기본 스킬은 다른 하네스 파일과 같은 기준으로 갱신합니다. `--dry-run`은 무엇이 바뀔지만 보여 주며, `--json`은 결과를 JSON으로 냅니다.

`harness-update` 실행 중 예외가 발생하면 이번 갱신 과정에서 작성된 파일을 되돌립니다. 그사이 사용자가 고친 파일과 기존 로컬 설정, 추적되지 않는 파일은 강제로 덮어쓰지 않습니다. 되돌리지 못한 파일은 오류에 경로를 남기며, 이전 내용은 백업 위치에서 확인할 수 있습니다.

설치 기록은 이 기능이 적용된 `setup`과 컨테이너 기동에서 남습니다. 그 전에 설치한 프로필에서 배포본과 같은 파일은 `identical`, 다른 파일은 `untracked`로 나옵니다. `untracked` 파일은 배포본과 직접 대조해 사용자 수정은 보존하면서 반영하세요. 반영한 뒤 CUELO와 `omp`를 다시 시작하고 새 세션에서 역할 목록과 실제 선택 모델을 확인하세요. 설치 성공이나 기존 세션의 표시만으로 전환 완료를 판단하지 마세요.

`makerHardCodeSol`을 쓰던 설정은 `makerHardCodeSonnet`으로 바꾸고 실제 사용할 Sonnet 모델 selector와 지원 추론 단계를 지정하세요(0.6.1에서 바뀐 이름이며 옛 키를 별칭으로 읽지 않습니다). `implSol`은 범위가 제한된 설계와 실패 재작업, 모든 Anthropic 계정이 오늘 몫을 넘겼을 때의 어려운 UI 추천 자리(`NORMAL_SOL`·`HARD_CODE_TERRA`)로 쓰이므로 이름을 바꾸지 말고, Sonnet 후보는 `implSonnet`에 따로 지정합니다. 역할 설정은 `harness-update`가 바꾸지 않습니다.


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

- 앱(`bin/cuelo.js --no-open --hostname 127.0.0.1`), `usage`, `btw`, `subagent`를 포그라운드로 함께 띄웁니다. 앱 주소는 환경의 `CUELO_HOSTNAME`과 무관하게 기본 `127.0.0.1`입니다. `start --hostname <주소>`를 줄 때만 바뀝니다.
- 로그는 `[web]`·`[usage]`·`[btw]`·`[subagent]` 접두어를 붙여 출력합니다.
- 브라우저는 자동으로 열지 않습니다. 시작할 때 출력되는 주소(기본 `http://127.0.0.1:30141`)를 직접 엽니다.
- Ctrl+C를 누르면 네 프로세스를 모두 종료합니다.
- 빌드(`.next/BUILD_ID`)가 없거나 포트가 이미 사용 중이면 시작하지 않고 exit code 1로 끝납니다.

기본 포트는 다음과 같습니다. 세 사이드카는 항상 `127.0.0.1`에서만 listen합니다. 앱도 `--hostname`을 주지 않으면 `127.0.0.1`입니다.

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

네 서비스에 요청을 하나씩 보내 응답 여부만 확인합니다. 모델 제공자를 호출하지는 않습니다.

- 앱: `GET /api/update-maintenance` → 200
- usage: `OPTIONS /usage` → 204
- btw: `GET /health` → 200
- subagent: `GET /health` → 200

모두 응답하면 exit code 0, 하나라도 실패하면 1입니다.

비밀번호 잠금이 켜진 서버(**설정 → 접속 암호**에서 켰거나 `CUELO_PASSWORD`를 지정한 경우)는 앱의 상태 확인 요청에도 비밀번호를 요구합니다. 값이 없거나 틀리면 401을 돌려주어 앱 검사가 실패하고 `health`가 exit code 1로 끝납니다. 사이드카 세 서비스는 영향이 없습니다.

`health`는 앱에 저장된 비밀번호를 읽지 않고, 실행한 셸의 `CUELO_PASSWORD` 값만 사용자 이름 `omp`의 Basic 인증으로 보냅니다. 잠금이 켜진 환경에서는 같은 비밀번호를 환경 변수로 넘겨 실행하세요. 예: `CUELO_PASSWORD='<잠금 비밀번호>' node install.mjs health`(npm 설치는 `CUELO_PASSWORD='<잠금 비밀번호>' cuelo health`).

## 6. 로그인 (사람이 할 일)

제공자 계정 로그인은 브라우저 OAuth나 API 키 입력이 필요하므로 사람이 직접 합니다. `start`로 띄운 CUELO를 브라우저에서 열고 **설정 > 모델·계정**에서 쓸 제공자의 로그인 버튼을 누릅니다. 로그인 정보는 `start`가 쓰는 프로필에 저장되며, `--home`을 썼다면 그 프로필입니다.

공식 omp CLI(`@oh-my-pi/pi-coding-agent`)를 이미 설치해 두었다면 `omp login`을 써도 됩니다. 이 안내는 CLI를 따로 설치하지 않습니다. 캐릭터 확장이 쓰는 Anthropic OAuth 0번·1번 자리의 의미는 [하네스 안내](harness.md)를 참고하세요.

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| `No production build found` | 소스 체크아웃입니다. `node install.mjs setup`을 먼저 끝냅니다. npm 설치에서 `This package has no production build`가 나오면 `npm install -g cuelo`로 다시 설치합니다. |
| `Already in use: …` | 기존 CUELO를 종료하거나 `--port-base`로 다른 포트를 씁니다. |
| Bun을 찾을 수 없다는 오류 | Bun `>=1.4.4`를 설치하고 새 셸을 엽니다. |
| `[btw] omp SDK not found` | `node install.mjs start`로 실행합니다. 이 스크립트가 `CUELO_DIR`를 CUELO 폴더로 설정합니다. |
| 사용량 패널 오류 | 같은 패키지 SDK/계정 경로가 실패한 경우 CLI fallback은 `OMP_EXE`를 먼저 보고, Windows에서는 기본 위치와 PATH의 `omp.exe`를, Linux·macOS에서는 CUELO 폴더의 `node_modules/.bin/omp`와 PATH의 `omp`를 찾습니다. `omp --version`과 본인 계정 로그인을 확인합니다. `stats` 집계는 독립 CLI가 필요합니다. |
| 사이드채팅이 입력을 받지 않음 | 세션 파일이 생성될 때까지 기다립니다. `health`에서 `btw`가 OK인지 확인합니다. |
| 모델 역할이 비어 있음 | 설정 > 모델·계정 > 모델 역할에서 고릅니다. `setup`은 기존 `config.yml`을 바꾸지 않습니다. |

exit code: `0` 성공, `1` 실행 실패, `2` 잘못된 인자(사용법 출력).
