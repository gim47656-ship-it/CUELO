<p align="center">
  <img src="./docs/hero.webp" alt="CUELO — AI coding agent workspace and harness for omp" width="100%">
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/gim47656-ship-it/CUELO?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

# CUELO — AI Coding Agent Workspace & Harness for omp (oh-my-pi)

**CUELO** is an open-source AI coding agent workspace and harness for **[omp (oh-my-pi)](https://github.com/can1357/oh-my-pi)**.

Use the same `~/.omp/agent` sessions, credentials and model configuration from the terminal and browser. The web workspace provides session management, model configuration, skills, worktrees, usage views and PWA access. The public harness provides multi-agent orchestration and model-routing rules; some integrations require separately configured services, as detailed below.

**한국어:** CUELO는 omp(oh-my-pi)를 위한 오픈소스 AI 코딩 에이전트 작업 공간이자 하네스입니다. 웹 앱은 omp SDK를 서버 안에서 실행하고, `omp` CLI와 같은 `~/.omp/agent` 디렉터리를 씁니다. 터미널에서 하던 세션을 브라우저에서 이어 가고, 다시 터미널로 돌아가도 기록·계정·모델 설정을 공유합니다.

내장 OMP 코어는 **18.4.10**입니다. 추론 강도를 바꾸거나 서브에이전트를 다시 이어도 예비 모델 설정을 유지하며, 별도로 설치한 `omp` CLI의 버전은 웹 업데이트와 독립적입니다.

CUELO의 목적은 작업 중 확인한 실패와 막힘을 기억·작업 규칙·실행 절차에 반영해, 사람이 같은 문제를 다시 지적하지 않아도 다음 작업에서 실수를 줄이는 것입니다. 원인을 확인하고 필요한 부분만 바꾸며, 다음 작업에서 적용과 효과를 확인하는 것까지를 지향합니다. 기록을 저장했다는 이유만으로 자동 개선이 끝났다고 보지는 않습니다.

**Keywords:** AI coding agent · agent harness · multi-agent orchestration · omp · oh-my-pi · model routing · developer tools

## 이 저장소로 되는 것과 따로 필요한 것

| 구분 | 내용 |
| --- | --- |
| 앱·런타임 설치 뒤 동작 | 세션 탐색·실시간 대화·분기/fork, 모델 역할, provider·플러그인·스킬 관리, 파일 미리보기, 비밀번호 잠금, 캐릭터 알림 등. 대화에는 별도 제공자 인증이 필요합니다 |
| 사용자가 준비할 것 | Node.js·Bun과 자신의 모델 제공자 계정·모델 선택. 소스 checkout/전체 Git 기능에는 Git for Windows도 필요합니다. 인증정보·세션·설정은 사용자의 로컬 `~/.omp/agent`에 저장합니다 |
| 로컬 사이드카 (공개) | 계정 사용량 카드, 사이드 챗(`/btw`), SubAgent 아카이브의 실행 소스도 포함합니다. `start`가 앱과 함께 실행합니다. usage의 CLI fallback·`stats`에는 별도 `omp` CLI가 필요합니다 |
| OMP 하네스 (공개) | Main/Maker 역할 분담, 발주·검수 계약, task guard, 판단 라우팅(Jev), 캐릭터 음성, 명령 가드의 규칙·SOP·확장과 앱 SDK core 패치입니다. `setup`으로 설치합니다. [하네스 안내](./docs/harness.md)에 Jev의 외부 자격 경계가 있습니다 |
| 포함하지 않는 것 | 개발자의 로그인 정보·API 키·개인 계정 및 모델 설정·개인 skill·대화와 작업 기록·PC별 운영 자료. 공개 설치는 필요한 비개인 운영 기본값만 제공하고 모델은 사용자가 고릅니다 |

## CUELO에서 할 수 있는 것

**세션과 대화**

- 프로젝트별로 지난 omp 세션을 찾아 이어 가고, 실시간으로 스트리밍되는 대화에서 도구 호출·비용·컨텍스트 사용량을 봅니다.
- 이전 메시지에서 갈래를 나누거나(세션 안 분기), 별도 세션으로 fork합니다.
- 작업 공간(프로젝트·worktree)을 바꾸면 그곳에서 마지막으로 열어 둔 세션으로 돌아갑니다.
- goal 모드의 자동 이어 가기와 todo 진행 상황을 대화창 위에서 확인합니다. 실행을 취소하면 자동 이어 가기가 멈추며, 일시정지된 목표는 `/goal resume`으로 재개합니다.
- 실행 중에 Steer로 지시를 바꾸면, 도구 호출이 없는 모델 요청은 서버의 전환 신호를 기다리지 않고 새 지시로 다시 요청합니다. 이미 보인 답변은 유지하며, 재요청에 따라 사용량이 늘 수 있습니다.
- 작업 로그 패널에서 이번 턴의 과정 항목과 턴마다 쓴 파일을 따로 봅니다.
- 입력창에 이미지·문서 외에 음성(받아쓰기), 코드·설정 파일(본문 첨부), 그 밖의 파일(저장 후 경로 첨부)을 붙여넣기·드롭·선택으로 넣습니다. 음성 받아쓰기에는 Google Antigravity 계정이 필요합니다.
- 에이전트가 생성하거나 확인한 이미지가 그 턴의 대화 흐름에 썸네일로 보이고, 누르면 크게 열립니다.
- Ctrl+K 팔레트로 대화 내용을 검색해 해당 메시지로 이동합니다. 압축으로 사라진 과거 메시지는 제외하고, 현재 볼 수 있는 메시지를 세션당 최대 3건 보여 줍니다. 긴 대화 안에서는 Ctrl+F로 찾고, 오른쪽 질문 레일로 내가 한 질문 사이를 오갑니다.
- 서버나 PC가 꺼져 실행이 끊긴 대화를 열면 중단 알림을 보여 줍니다. 컨텍스트 압축 중에는 경과 시간을 표시합니다.
- 모델 선택기 맨 위에 자주 고른 모델이 나오고, 팔레트에서 넓은 대화 폭을 켤 수 있습니다.
- 입력창 아래 줄은 Main 프리셋 → 그 제공자의 모델 → 추론 강도 순서입니다. "자동, 최대 high"처럼 상한을 고를 수 있고, Auto가 실제로 적용한 값은 「현재 추론 강도」로 따로 표시합니다. 새 대화는 선택한 상한 적용을 마친 뒤 첫 메시지를 보내며, 적용에 실패하면 재전송 때 다시 시도합니다.
- 도구 옆 시간에는 모델 응답 생성 시간을 포함하지 않습니다. 실행 전에 취소된 도구나 완료 시각을 확인할 수 없는 옛 기록에는 시간을 추정해 붙이지 않습니다.

**계정과 자원**

- 계정별 사용량 카드: 한도 창, 이번 구간 실측, 리셋 권장을 한 화면에 보여 줍니다. 기록이 없으면 숫자를 지어내지 않고 「기록 부족」으로 표시합니다.
- 계정은 이메일 대신 캐릭터 얼굴과 별칭으로 구별합니다. 주소를 상시 노출하지 않기 위해서입니다.
- 효율 패널(Run X-Ray · Experiment Lab): `~/.omp/stats.db`와 세션 기록에 이미 쌓인 값만 읽어 실행별 병목과 구성 비교를 보여 줍니다.

**여러 에이전트와 함께 일하기**

- SubAgent 아카이브: 진행 중·완료된 자식 에이전트의 기록을 열어 봅니다.
- 서브에이전트를 발주한 답변 안에 접힌 카드가 붙어, 맡긴 일마다 실행 상태와 Main의 검수 판정을 한 줄로 보여 줍니다. 펼치면 현재 단계·모델·판정 사유와 상세 패널 링크가 나옵니다. 실행이 끝났어도 Main이 판정을 남기지 않았으면 「검수 미기록」으로 표시하며, 끝난 것을 통과로 치지 않습니다.
- 끝난 턴의 마지막 답변 아래에 변경 파일·검사·실패·미확인 개수를 한 줄로 요약하고, 펼치면 파일과 검사 명령·결과를 봅니다.
- 실행 중에 보낸 입력은 「지금 지시」와 「완료 후 요청」으로 나뉘어, 접수·전달 대기·대화에 들어감 단계를 따로 보여 줍니다. 전달을 확인하지 못하면 그렇다고 표시합니다.
- 오피스 보기: 대화 보기와 전환하는 선택형 화면입니다. 왼쪽 자리에서 Main과 실제 참여한 에이전트의 상태를 보고, 고른 대상의 대화·작업 기록·파일을 오른쪽에서 확인합니다. 고르기만 해서는 모델·계정이 바뀌거나 메시지가 다른 대상으로 가지 않으며, 대화 보기로 돌아가도 작성 중인 초안이 그대로 남습니다.
- 자식 에이전트의 발화가 해당 턴 아래 대화 흐름에 끼어들어 누가 무슨 말을 했는지 이어서 읽힙니다.
- 공개 하네스는 시작을 기다리거나 재작업 중인 에이전트에게 같은 파일을 중복 배정하지 않도록 확인합니다. 완료 결과와 Main이 검수한 결과의 출처를 구분하고, 재작업 이력과 최종 수용을 따로 남깁니다. 적용 경계는 [하네스 안내](./docs/harness.md#발주와-검수-계약)를 따릅니다.
- 필요한 MCP 서버만 요청별로 연결하는 선택 모드를 지원합니다. 설치·인증·권한 변경은 먼저 승인을 받고 에이전트가 지원합니다. 설정과 적용 범위는 [요청별 MCP 선택 연결](./docs/harness.md#요청별-mcp-선택-연결)을 확인하세요.
- 사이드 챗(`/btw`): 본 대화를 끊지 않고 옆 패널에서 따로 묻습니다. 답변은 본 대화와 같은 캐릭터 얼굴·스티커·마크다운으로 보이고, 세션마다 초안이 따로 보관됩니다. 사이드 챗 문답은 본 대화에 남지 않으며, 답변의 「메인에 보내기」를 누를 때만 문답과 추가 지시가 본 대화로 전달됩니다(본 대화가 실행 중이면 steer, 아니면 새 요청).
- ChatGPT 상담(SHION): 로컬 shim이 전용 ChatGPT 탭에서 받은 답을 현재 omp 세션에 투영하고, 상담 기록과 실패 기록이 대화창에 표시됩니다.
- 실시간 음성: 브라우저 마이크로 Codex live 음성 세션을 엽니다. “끊어”, “아… 일단 끊어”, “통화 종료해 줘”처럼 단독 종료 요청을 말하면 최종 전사를 받은 뒤 마이크와 통화를 종료합니다. 선택 기능인 캐릭터 음성은 **설정 → 통화 음성**에서 Cartesia API 키를 입력하고 음성 준비에 동의하면 현재 Main 캐릭터에 맞춰 적용됩니다. 통화 답변은 실제로 말한 캐릭터의 얼굴과 이름으로 표시되고, 캐릭터 음성 대신 기본 음성으로 말했으면 「기본 음성」이라고 함께 보입니다. 입력창에는 통화 시작·종료 버튼만 남으며, 좁은 화면에서는 모델 선택 등 다른 조작부와 겹치지 않게 줄바꿈합니다. 별도 음성 ID 입력은 필요하지 않으며, 키는 서버에만 보관합니다. 지원 플랜·크레딧 사용·전송 범위는 [캐릭터 통화 설정](./docs/live-voice.md)을 확인하세요.

**단톡방**

- 사이드바의 「단톡방」에서 멤버별 참여와 주간 사용량을 보고, 가운데 대화창에서 멘션·답장·반응을 주고받습니다. 방 전체와 멤버별 참여를 따로 켜고 끌 수 있습니다.
- 작업 화면으로 돌아가도 선택한 세션·작성 중인 초안·진행 중인 작업은 유지됩니다. 단톡방 기록은 작업 대화와 별도로 보관하며, 멤버에게 작업 문맥이나 실행 도구를 전달하지 않습니다.
- 단톡방의 계정 연결은 작업 세션의 계정을 바꾸지 않습니다. 연결한 계정을 사용할 수 없으면 다른 계정으로 넘어가지 않고 다시 선택하도록 안내합니다.
- 단톡방에는 낮은 추론 강도(`low`)를 사용하며 작업 세션의 추론 설정은 바꾸지 않습니다. 시간당 호출은 최대 120회, 사용자 메시지 한 건에 대한 응답은 멤버끼리 이어 말하는 발언을 합쳐 최대 6회입니다. 실제 계정 한도 보호도 계속 적용합니다.
- 사용자 메시지에 답한 뒤에도 멤버끼리 앞 사람 말을 받아 이어 갑니다. 답에서 부른 멤버가 먼저 받고, 부른 멤버가 없으면 가장 오래 말하지 않은 멤버가 받습니다. 답하지 못한 멤버가 있으면 건너뛰고 다음 멤버가 잇습니다.
- 자동 수다는 직접 켜야 합니다. 켜 두면 조용할 때 멤버끼리 짧게 주고받습니다(속도에 따라 2·4·6회). 작업 중에는 자동 수다를 쉬고, 호출 상한과 사용량 보호를 적용합니다. 「중단」이나 방 끄기로 진행 중 응답을 멈출 수 있습니다.
- 한국어로 대화하되 짧은 일본어 표현을 쓸 때는 이어지는 말에서 뜻을 보완하도록 안내합니다. 실제 표현은 참여 모델에 따라 달라집니다. SHION은 상담 전용으로 남습니다.

**알림과 표현**

- 완료·실패·승인 요청·선택 요청 등 상황에 맞는 캐릭터 스티커와 음성으로 알립니다(RIN · MIO · YUKI · ISANA · NOVA · SHION · HIKARI).
- 브라우저 알림과 PWA 설치를 지원합니다.
- 직접 저장한 교훈·스킬은 저장한 답변이나 과정 바로 뒤의 카드에서 확인합니다. 교훈 자동 기록을 켠 경우 자동 저장 알림도 작업 과정을 접어도 대화에 남습니다. 요청에 이름이 없고 필요성도 확인되지 않은 MCP 후보는 보류 안내로 나열하지 않습니다.
- 한국어가 기본인 인터페이스입니다(영어·중국어 간체도 선택 가능).

**omp-web에서 이어받은 기반 기능**

- 모델 역할(`default`, `smol`, `slow`, `plan`, `commit`, `task` 등)별 모델 지정·전환 — TUI의 `/model`과 같은 `config.yml`을 씁니다.
- 입력창의 `/` 명령은 대기 중뿐 아니라 실행 중에도 Enter·Steer·Follow-up으로 실행할 수 있습니다. 내장 명령은 즉시 처리하고, 발견된 확장·스킬·프롬프트 템플릿 명령은 해당 명령 경로로 전달합니다. 사용할 수 없거나 실행 중 허용되지 않는 명령은 안내하며 일반 채팅으로 전송하지 않습니다.
- 응답을 기다리며 보낸 Steer를 실시간으로 반영할 수 없을 때, 아직 답변이나 도구 호출이 나오지 않았다면 현재 추론 요청만 끊고 새 지시로 이어갑니다. 이미 보인 답변이나 도구 호출은 보존하며, 대화 전체를 중단하지 않습니다.
- 에이전트가 일반 구현 방식을 고르는 질문에 추천안을 붙여 물으면, 2분 동안 답이 없을 때 추천안으로 진행합니다. 질문 창에 그 안내가 표시되고, 옵션을 고르거나 답을 입력하면 대기 시간이 다시 시작됩니다. 자동 선택은 사용자 승인으로 치지 않으며, 배포·삭제·비용·계정·권한 확인 질문은 답할 때까지 기다립니다.
- Main이 OpenAI 모델에서 Fast를 켜면 새로 만드는 OpenAI 계열 SubAgent도 Fast로 요청합니다. Anthropic·Google SubAgent에는 Fast를 자동으로 넘기지 않고, Fast가 꺼져 있으면 SubAgent도 표준 처리로 요청합니다.
- 네이티브 창을 다루는 `computer.run`에서 버튼을 한 번 누른 뒤, 원하는 행·문구·값이 나타날 때까지 로컬 읽기로만 다시 확인하고 결과만 돌려줍니다. 기다리는 동안 다시 누르지 않으며, 제한 시간 초과·취소·읽기 오류를 서로 구분해 알립니다. 저장·전송처럼 결과가 남는 클릭의 승인 절차는 바뀌지 않습니다([사용법](./docs/harness.md#typed-judgment-routing-jev)).
- provider 로그인·API 키, `models.yml`, 플러그인, 스킬을 웹에서 관리합니다. 플러그인 비활성화 설정을 저장해도 이미 불러온 플러그인은 CUELO 런타임을 재시작해야 멈춥니다. 「세션 다시 불러오기」는 플러그인을 해제하지 않습니다.
- 프로젝트 파일 탐색과 소스·문서·이미지·오디오·PDF 미리보기, Git worktree 전환.
- 프로젝트 신뢰: 설정에서 프로젝트별 승인을 관리·해제하고, 실행 중에는 작업을 끊지 않고 신뢰 승인을 예약합니다. 신뢰하지 않은 저장소의 확장·훅·도구·MCP는 실행하지 않습니다([docs/project-trust.md](./docs/project-trust.md)).
- 비밀번호 잠금(HTTP Basic Auth, scrypt 해시 저장)과 `/recover` 복구([docs/authentication.md](./docs/authentication.md)).

## 실행하기

CUELO는 GitHub 소스와 npm 패키지 [`cuelo`](https://www.npmjs.com/package/cuelo)로 설치합니다. npm의 `omp-web`은 upstream 프로젝트이며 CUELO와 별개입니다. **기존 `omp` CLI만 설치한 PC에도 `omp-web` 없이 CUELO를 추가할 수 있습니다.** 기존 `config.yml`·계정·세션을 보존하는 순서는 [대표 설치 경로](./docs/installation.md#대표-경로-omp만-있는-windows-pc-omp-web-없음)에 있습니다.

> **개발·검증 환경은 Windows입니다.** macOS·Linux는 개발·테스트 환경이 아니므로 동작과 지원을 보장하지 않습니다.

서버는 **Bun 1.4.2 이상**에서만 실행됩니다(omp SDK가 TypeScript 소스와 `bun:` 내장 모듈을 사용). Node.js 22.19.0 이상도 `install.mjs`와 npm에 필요합니다. Git은 소스 checkout과 Git 작업(worktree·commit 등)에 필요하지만 npm 설치와 기본 대화에는 필요하지 않습니다.
메모리 패키지가 선언한 선택적 ONNX peer는 `onnxruntime-node:1.21.0`으로 제공합니다. Transformers가 요구하는 별도 버전은 자체 의존성으로 유지하며, 설치 오류를 피하려고 peer 검증을 끄지 않습니다. Mnemopi의 로컬 임베딩은 별도 `fastembed`와 모델을 첫 사용 때 내려받을 수 있습니다.

```bash
# Bun 설치
powershell -c "irm bun.sh/install.ps1 | iex"    # Windows

# CUELO 받기와 실행
git clone https://github.com/gim47656-ship-it/CUELO.git
cd CUELO
node install.mjs setup
node install.mjs start
```

소스 빌드 없이 npm으로 설치하려면 Node.js 22.19.0 이상과 Bun 1.4.2 이상을 준비한 뒤 실행합니다.

```bash
npm install -g cuelo
cuelo setup
cuelo start
# 다른 터미널에서 서비스 확인
cuelo health
```

`setup`은 공개 하네스의 없는 파일만 추가합니다. npm 설치본에는 production 빌드가 포함되어 있어 다시 빌드하지 않습니다. 실행 중인 CUELO가 있다면 종료하거나 `cuelo start --port-base 31141`로 별도 포트를 사용하세요.

앱과 세 사이드카가 같은 터미널에서 실행됩니다. 브라우저에서 [http://127.0.0.1:30141](http://127.0.0.1:30141)을 열고 본인 계정으로 로그인한 뒤 모델을 선택하세요. 기본은 `127.0.0.1` 전용이며, Ctrl+C로 실행한 서비스를 종료합니다.

다른 터미널에서 `node install.mjs health`(npm 설치는 `cuelo health`)로 네 서비스의 응답을 확인합니다. 기존 설치와 다른 포트가 필요하면 `start`와 `health` 양쪽에 `--port-base 31141`처럼 지정합니다. 이 검사는 제공자 인증·Jev 판정·사용량 응답을 검증하지 않습니다.

처음 설치하거나 Claude·Codex에 설치를 맡길 때는 **[새 Windows 설치와 실행 안내](./docs/installation.md)**를 기준으로 하세요. 포함 파일과 외부 필수 항목, Jev 제공자 키·역할 설정, 기능별 CLI/Git 요구사항이 따로 적혀 있습니다. 기존 프로필 파일은 자동으로 덮어쓰지 않으며, 제공자 로그인·권한 승인·모델 선택은 사용자 단계입니다. 빈 Windows PC 전체를 실제 검증한 것은 아닙니다.

앱만 따로 실행하는 기존 실행기 옵션:

```bash
bun bin/cuelo.js --port 8080           # 포트 변경
bun bin/cuelo.js --hostname 0.0.0.0    # 신뢰하는 네트워크에만 노출
bun bin/cuelo.js --no-open             # 브라우저 자동 열기 끄기
bun bin/cuelo.js --authenticated       # 비밀번호 잠금 켜기
bun bin/cuelo.js --reset-password      # 비밀번호 재설정
```

원격에서 쓸 때는 평문 HTTP를 인터넷에 열지 말고, 신뢰할 수 있는 HTTPS 리버스 프록시나 VPN 뒤에 두세요. CUELO는 권한이 큰 에이전트를 실행합니다.

### 업데이트

새 CUELO 릴리스가 나오면 사이드바 아래에 알림이 뜹니다. CUELO는 스스로 설치하지 않습니다. 소스에서 실행 중이면 서비스를 종료한 뒤 소스를 갱신하고 다시 설치·시작하세요. 실행 중인 개발 서버의 `.next/`에 빌드를 겹쳐 쓰지 마세요.

기존 프로필의 하네스·역할 설정은 앱 업데이트만으로 자동 덮어쓰지 않습니다. `0.6.1`의 설정 전환은 [기존 하네스 갱신](./docs/installation.md#061로-기존-하네스-갱신)을 확인하고, 반영 후 CUELO와 `omp`를 다시 시작하세요.

```bash
git pull --ff-only
node install.mjs setup
node install.mjs start
```

공개 웹 소스 릴리스와 변경 내용은 [GitHub Releases](https://github.com/gim47656-ship-it/CUELO/releases)에서 확인하세요. 새 `package.json` 버전이 공개 `main`에 올라가 CI가 성공하면 GitHub 릴리스와 npm `cuelo` 게시가 자동으로 실행됩니다([릴리스 절차](./docs/release.md)).

### 사이드카 서비스

사용량 카드, 사이드 챗, SubAgent 아카이브는 로컬 사이드카 서비스에서 데이터를 받습니다. 실행 소스는 공개 저장소의 `Tools/CUELO_Setup/files/`에 있고, `node install.mjs start`가 함께 실행합니다. 개발자의 인증정보나 대화 기록을 제공하는 서비스가 아니라, 각 사용자 PC의 데이터를 읽는 서비스입니다.

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
bun install --backend=copyfile
bun run prepare:source  # SDK 호환 패치를 이 작업 사본에 적용
bun run dev          # http://127.0.0.1:30141
bun run typecheck
bun run lint
bun run test         # 앱·설치기 테스트
bun run test:coverage  # 앱·설치기 테스트 + 커버리지 표
```

개발 서버를 쓰는 동안 같은 출력 경로에 `bun run build`를 돌리지 마세요. `.next/`를 덮어써서 개발 서버가 깨집니다. 검증용 production 빌드는 별도 소스 복사본이나 격리된 `CUELO_DIST_DIR`에서 실행하세요.

의존성을 다시 설치하거나 갱신한 뒤에는 `bun run prepare:source`를 다시 실행하세요. 이 준비 단계는 작업 사본의 SDK만 다루며 사용자 프로필이나 실행 중인 설치본을 변경하지 않습니다.

참고 문서: [OMP 하네스](./docs/harness.md) · [인증](./docs/authentication.md) · [프로젝트 신뢰](./docs/project-trust.md) · [worktree](./docs/worktrees.md) · [다국어](./docs/i18n.md) · [Docker](./docs/docker.md)

## 계보와 라이선스

CUELO는 [@ddallabenetta](https://github.com/ddallabenetta)의 [omp-web](https://github.com/ddallabenetta/omp-web)을 기반으로 하고, omp-web은 [@agegr](https://github.com/agegr)의 [pi-web](https://github.com/agegr/pi-web)에서 갈라져 나왔습니다. CUELO 앱은 독립적으로 개발·배포하며 upstream 앱의 릴리스를 자동으로 따르지 않습니다. 기반 소스의 출처는 [`UPSTREAM.json`](./UPSTREAM.json)에 기록되어 있습니다.

CUELO의 에이전트 엔진은 [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi)입니다. omp 소스를 이 저장소에 복사하지 않고 `@oh-my-pi/*` npm 패키지(MIT, Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük)를 의존성으로 씁니다. 각 패키지의 라이선스 전문은 설치된 패키지 안의 `LICENSE`에 들어 있습니다.

캐릭터(RIN · MIO · YUKI · ISANA · NOVA · SHION · HIKARI)의 그림·음성·스티커와 `docs/hero.webp`는 CUELO 고유 자산입니다.

코드: [MIT License](./LICENSE)
