<p align="center">
  <img src="./docs/hero.png" alt="CUELO — Browser workspace for omp" width="100%">
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/gim47656-ship-it/CUELO?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

# CUELO

> 작업에서 얻은 교훈이 다음 작업의 행동으로 이어지는 코딩 작업 공간.

CUELO는 [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) 코딩 에이전트를 위한 브라우저 작업 공간입니다. 별도 에이전트가 아니라 omp SDK를 서버 안에서 그대로 돌리고, `omp` CLI와 같은 `~/.omp/agent` 디렉터리를 씁니다. 그래서 터미널에서 하던 세션을 브라우저에서 이어 가고, 다시 터미널로 돌아가도 기록·계정·모델 설정이 하나로 유지됩니다.

CUELO의 목적은 작업 중 확인한 실패와 막힘을 기억·작업 규칙·실행 절차에 반영해, 사람이 같은 문제를 다시 지적하지 않아도 다음 작업에서 실수를 줄이는 것입니다. 원인을 확인하고 필요한 부분만 바꾸며, 다음 작업에서 적용과 효과를 확인하는 것까지를 지향합니다. 기록을 저장했다는 이유만으로 자동 개선이 끝났다고 보지는 않습니다.

*English: CUELO is a Korean-first browser workspace for omp. It runs omp's own SDK in-process against `~/.omp/agent`, so terminal and browser share one set of sessions, credentials and model settings.*

## 이 저장소로 되는 것과 따로 필요한 것

| 구분 | 내용 |
| --- | --- |
| 이 저장소만으로 동작 | 웹 앱 전체: 세션 탐색·실시간 대화·분기/fork, 모델 역할, provider·플러그인·스킬 관리, 파일 미리보기, worktree, 비밀번호 잠금, 캐릭터 알림, 효율 패널(`~/.omp/stats.db` 읽기) |
| omp가 따로 있어야 함 | `~/.omp/agent`의 세션·인증·모델 설정. 보통 `omp` CLI를 한 번 이상 써서 만들어진 상태를 전제로 합니다 |
| 사이드카 서비스가 필요함 | 계정 사용량 카드, 사이드 챗(`/btw`), SubAgent 아카이브 — 아래 [사이드카 서비스](#사이드카-서비스) 참고. 없으면 해당 패널만 「연결 안 됨」 |
| OMP 하네스 (공개) | CUELO가 쓰는 작업 방식 — Main/Maker 역할 분담, 발주·검수 계약, task guard, 판단 라우팅(Jev), 캐릭터 음성, 명령 가드 같은 규칙·SOP·확장과 omp core 패치 — 는 [`Tools/OMP_Global_Config/agent`](./Tools/OMP_Global_Config/agent)와 [`patches`](./Tools/OMP_Global_Config/patches)에 있습니다. `~/.omp/agent`에 복사해 쓰는 구조이고, 설명은 [docs/harness.md](./docs/harness.md)에 있습니다 |
| 포함하지 않는 것 | 로그인 정보·API 키, 어떤 provider·계정·모델을 쓰는지 정한 개인 설정(`config.yml`·`models.yml`), 개인 skill, 작업 기록, PC 설치 파이프라인. CUELO 앱은 이것들 없이 동작하고, 하네스를 쓰려면 자기 `config.yml`에 역할별 모델(`modelRoles`)을 지정해야 합니다 |

## CUELO에서 할 수 있는 것

**세션과 대화**

- 프로젝트별로 지난 omp 세션을 찾아 이어 가고, 실시간으로 스트리밍되는 대화에서 도구 호출·비용·컨텍스트 사용량을 봅니다.
- 이전 메시지에서 갈래를 나누거나(세션 안 분기), 별도 세션으로 fork합니다.
- 작업 공간(프로젝트·worktree)을 바꾸면 그곳에서 마지막으로 열어 둔 세션으로 돌아갑니다.
- goal 모드의 자동 이어 가기와 todo 진행 상황을 대화창 위에서 확인합니다.
- 작업 로그 패널에서 이번 턴의 과정 항목과 턴마다 쓴 파일을 따로 봅니다.

**계정과 자원**

- 계정별 사용량 카드: 한도 창, 이번 구간 실측, 리셋 권장을 한 화면에 보여 줍니다. 기록이 없으면 숫자를 지어내지 않고 「기록 부족」으로 표시합니다.
- 계정은 이메일 대신 캐릭터 얼굴과 별칭으로 구별합니다. 주소를 상시 노출하지 않기 위해서입니다.
- 효율 패널(Run X-Ray · Experiment Lab): `~/.omp/stats.db`와 세션 기록에 이미 쌓인 값만 읽어 실행별 병목과 구성 비교를 보여 줍니다.

**여러 에이전트와 함께 일하기**

- SubAgent 아카이브: 진행 중·완료된 자식 에이전트의 기록을 열어 봅니다.
- 자식 에이전트의 발화가 해당 턴 아래 대화 흐름에 끼어들어 누가 무슨 말을 했는지 이어서 읽힙니다.
- 공개 하네스는 완료된 Maker의 미기록 Main 판정을 후속 지시 때 안내하고, 재작업 이력과 최종 수용을 구분합니다. 모델별 허용 추론 강도와 적용 경계는 [하네스 안내](./docs/harness.md#발주와-검수-계약)를 따릅니다.
- 사이드 챗(`/btw`): 본 대화를 끊지 않고 옆 패널에서 따로 묻습니다. 답변은 본 대화와 같은 캐릭터 얼굴·스티커·마크다운으로 보이고, 세션마다 초안이 따로 보관됩니다. 사이드 챗 문답은 본 대화에 남지 않으며, 답변의 「메인에 보내기」를 누를 때만 문답과 추가 지시가 본 대화로 전달됩니다(본 대화가 실행 중이면 steer, 아니면 새 요청).
- ChatGPT 6 Pro(SHION) 상담 브리지: 6 Pro가 MCP로 omp 세션에 붙어 상담하고, 상담 기록과 실패 기록이 대화창에 표시됩니다.
- 실시간 음성: 브라우저 마이크로 Codex live 음성 세션을 엽니다. 자격 증명은 서버에만 두고 페이지에는 넘기지 않습니다.

**알림과 표현**

- 완료·실패·승인 요청·선택 요청 등 상황에 맞는 캐릭터 스티커와 음성으로 알립니다(RIN · MIO · YUKI · ISANA · NOVA · SHION).
- 브라우저 알림과 PWA 설치를 지원합니다.
- 한국어가 기본인 인터페이스입니다(영어·중국어 간체도 선택 가능).

**omp-web에서 이어받은 기반 기능**

- 모델 역할(`default`, `smol`, `slow`, `plan`, `commit`, `task` 등)별 모델 지정·전환 — TUI의 `/model`과 같은 `config.yml`을 씁니다.
- 입력창의 `/` 명령은 대기 중뿐 아니라 실행 중에도 Enter·Steer·Follow-up으로 실행할 수 있습니다. 내장 명령은 즉시 처리하고, 발견된 확장·스킬·프롬프트 템플릿 명령은 해당 명령 경로로 전달합니다. 사용할 수 없거나 실행 중 허용되지 않는 명령은 안내하며 일반 채팅으로 전송하지 않습니다.
- provider 로그인·API 키, `models.yml`, 플러그인, 스킬을 웹에서 관리합니다.
- 프로젝트 파일 탐색과 소스·문서·이미지·오디오·PDF 미리보기, Git worktree 전환.
- 프로젝트 신뢰: 신뢰하지 않은 저장소의 확장·훅·도구·MCP는 실행하지 않습니다([docs/project-trust.md](./docs/project-trust.md)).
- 비밀번호 잠금(HTTP Basic Auth, scrypt 해시 저장)과 `/recover` 복구([docs/authentication.md](./docs/authentication.md)).

## 실행하기

CUELO는 npm에 배포하지 않습니다. npm의 `omp-web` 패키지는 upstream이고 CUELO가 아닙니다. 소스에서 실행하세요.

omp SDK가 TypeScript 소스와 `bun:` 내장 모듈을 쓰기 때문에 서버는 **Bun 1.4.2 이상**에서만 돕니다.
메모리 패키지가 선언한 선택적 ONNX peer는 `onnxruntime-node:1.21.0`으로 제공합니다. Transformers가 요구하는 별도 버전은 자체 의존성으로 유지하며, 설치 오류를 피하려고 peer 검증을 끄지 않습니다.

```bash
# Bun 설치
powershell -c "irm bun.sh/install.ps1 | iex"    # Windows
curl -fsSL https://bun.sh/install | bash        # macOS / Linux

# CUELO 받기와 실행
git clone https://github.com/gim47656-ship-it/CUELO.git
cd CUELO
bun install
bun run build
node Tools/CUELO_Setup/files/native-runtime-patch.js --target .
bun bin/cuelo.js
```

서버가 준비되면 브라우저가 [http://127.0.0.1:30141](http://127.0.0.1:30141)로 열립니다. 기본은 `127.0.0.1`에만 열립니다.

실행기 옵션:

```bash
bun bin/cuelo.js --port 8080           # 포트 변경
bun bin/cuelo.js --hostname 0.0.0.0    # 신뢰하는 네트워크에만 노출
bun bin/cuelo.js --no-open             # 브라우저 자동 열기 끄기
bun bin/cuelo.js --authenticated       # 비밀번호 잠금 켜기
bun bin/cuelo.js --reset-password      # 비밀번호 재설정
```

원격에서 쓸 때는 평문 HTTP를 인터넷에 열지 말고, 신뢰할 수 있는 HTTPS 리버스 프록시나 VPN 뒤에 두세요. CUELO는 권한이 큰 에이전트를 실행합니다.

### 업데이트

새 CUELO 릴리스가 나오면 사이드바 아래에 알림이 뜹니다. CUELO는 스스로 설치하지 않습니다. 소스에서 실행 중이면 이렇게 갱신한 뒤 다시 시작하세요.

```bash
git pull && bun install && bun run build
node Tools/CUELO_Setup/files/native-runtime-patch.js --target .
```

공개 웹 소스 릴리스와 변경 내용은 [GitHub Releases](https://github.com/gim47656-ship-it/CUELO/releases)에서 확인하세요. [릴리스 절차](./docs/release.md)는 CUELO의 수동 게시 흐름을 설명합니다.

### 사이드카 서비스

사용량 카드, 사이드 챗, SubAgent 아카이브는 로컬 사이드카 서비스에서 데이터를 받습니다. 이 서비스들은 공개 미러에 포함되어 있지 않습니다.

| 기능 | 주소 |
| --- | --- |
| 계정 사용량·리셋 | `http://127.0.0.1:30142` |
| 사이드 챗 | `http://127.0.0.1:30143` |
| SubAgent 아카이브 | `http://127.0.0.1:30144` |

사이드카가 없으면 해당 패널은 「연결 안 됨」으로 표시되고, 나머지 기능은 그대로 동작합니다.

### Docker

`Dockerfile`과 `docker-compose.yml`로 컨테이너에서 실행할 수 있습니다. omp 홈 디렉터리(`~/.omp`)를 마운트해야 합니다. 자세한 내용은 [docs/docker.md](./docs/docker.md)를 보세요.

## 개발

```bash
bun install
bun run dev          # http://127.0.0.1:30141
bun run typecheck
bun run lint
bun run test         # 앱 테스트
bun run test:coverage  # 앱 테스트 + 커버리지 표
```

개발 서버를 쓰는 동안 같은 출력 경로에 `bun run build`를 돌리지 마세요. `.next/`를 덮어써서 개발 서버가 깨집니다. 검증용 production 빌드는 별도 소스 복사본이나 격리된 `CUELO_DIST_DIR`에서 실행하세요.

참고 문서: [OMP 하네스](./docs/harness.md) · [인증](./docs/authentication.md) · [프로젝트 신뢰](./docs/project-trust.md) · [worktree](./docs/worktrees.md) · [다국어](./docs/i18n.md) · [Docker](./docs/docker.md)

## 계보와 라이선스

CUELO는 [@ddallabenetta](https://github.com/ddallabenetta)의 [omp-web](https://github.com/ddallabenetta/omp-web)을 기반으로 하고, omp-web은 [@agegr](https://github.com/agegr)의 [pi-web](https://github.com/agegr/pi-web)에서 갈라져 나왔습니다. CUELO 앱은 독립적으로 개발·배포하며 upstream 앱의 릴리스를 자동으로 따르지 않습니다. 기반 소스의 출처는 [`UPSTREAM.json`](./UPSTREAM.json)에 기록되어 있습니다.

CUELO의 에이전트 엔진은 [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi)입니다. omp 소스를 이 저장소에 복사하지 않고 `@oh-my-pi/*` npm 패키지(MIT, Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük)를 의존성으로 씁니다. 각 패키지의 라이선스 전문은 설치된 패키지 안의 `LICENSE`에 들어 있습니다.

캐릭터(RIN · MIO · YUKI · ISANA · NOVA · SHION)의 그림·음성·스티커와 `docs/hero.png`는 CUELO 고유 자산입니다.

코드: [MIT License](./LICENSE)
